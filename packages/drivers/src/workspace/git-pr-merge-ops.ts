import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ConflictFileHunk, RevertResult } from "@super-work/core";
import { runGit } from "./git-command-runner.ts";
import type { GitWorkspaceContext } from "./git-workspace-context.ts";

export async function prepareThreeWayConflictWorkspaceImpl(ctx: GitWorkspaceContext, input: {
  worktreePath: string;
  rootRepoPath: string;
  baseBranch: string;
}): Promise<{
  mergeBaseSha: string;
  upstreamCommitSummaries: string[];
  conflictFiles: string[];
  fileHunks: ConflictFileHunk[];
}> {
  const { worktreePath, baseBranch } = input;
  const theirsHead = await ctx.getHeadCommitSha(worktreePath, "HEAD");
  const mbRes = await runGit(["merge-base", theirsHead, baseBranch], worktreePath);
  const mergeBaseSha = mbRes.stdout.trim() || theirsHead;

  const logRes = await runGit(
    ["log", "--oneline", "-n", "8", `${mergeBaseSha}..${baseBranch}`],
    worktreePath,
  );
  const upstreamCommitSummaries = logRes.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  // Move worktree HEAD onto updated baseBranch so worker sees latest upstream code
  await runGit(["reset", "--hard", baseBranch], worktreePath);
  await runGit(["update-ref", ctx.worktreeBaseRef(worktreePath), "HEAD"], worktreePath);

  // Perform 3-way merge without committing to populate conflict markers + auto-merge clean files
  await runGit(["merge", "--no-commit", "--no-ff", theirsHead], worktreePath);
  const conflictListRes = await runGit(
    ["diff", "--name-only", "--diff-filter=U"],
    worktreePath,
  );
  const conflictFiles = conflictListRes.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  // Clear MERGE_HEAD & unmerged index stages while preserving working tree files & conflict markers
  await runGit(["merge", "--quit"], worktreePath);
  await runGit(["reset", "HEAD"], worktreePath);

  const fileHunks: ConflictFileHunk[] = [];
  for (const filePath of conflictFiles.slice(0, 8)) {
    const oursRes = await runGit(
      ["diff", mergeBaseSha, baseBranch, "--", filePath],
      worktreePath,
    );
    const theirsRes = await runGit(
      ["diff", mergeBaseSha, theirsHead, "--", filePath],
      worktreePath,
    );
    fileHunks.push({
      filePath,
      oursSummary: oursRes.stdout.trim().slice(0, 1200),
      theirsSummary: theirsRes.stdout.trim().slice(0, 1200),
    });
  }

  return {
    mergeBaseSha,
    upstreamCommitSummaries,
    conflictFiles,
    fileHunks,
  };
}

export async function mergeBranchToBaseImpl(ctx: GitWorkspaceContext, input: {
  rootRepoPath: string;
  baseBranch: string;
  branchName: string;
  worktreePath?: string;
  commitMessage: string;
  deleteBranch?: boolean;
  noFf?: boolean;
}): Promise<{ commitSha: string; beforeSha?: string; isMergeCommit?: boolean; branchCleaned: boolean }> {
  const branchVerify = await runGit(["rev-parse", "--verify", input.branchName], input.rootRepoPath);
  if (branchVerify.exitCode !== 0) {
    throw new Error(`Branch not found: ${input.branchName}`);
  }

  const beforeRes = await runGit(["rev-parse", "--short", input.baseBranch], input.rootRepoPath);
  const beforeSha = beforeRes.exitCode === 0 ? beforeRes.stdout.trim() : undefined;

  if (input.worktreePath) {
    await ctx.cleanupWorkspace(input.worktreePath, input.rootRepoPath);
  }

  // Ensure no leftover linked worktree still checks out input.branchName before branch deletion
  const wtList = await runGit(["worktree", "list", "--porcelain"], input.rootRepoPath);
  if (wtList.exitCode === 0) {
    let currentWt: string | undefined;
    for (const rawLine of wtList.stdout.split("\n")) {
      const line = rawLine.trim();
      if (line.startsWith("worktree ")) {
        currentWt = line.slice("worktree ".length);
      } else if (line.startsWith("branch ") && currentWt) {
        const ref = line.slice("branch ".length);
        if (
          ref === `refs/heads/${input.branchName}` &&
          resolve(currentWt) !== resolve(input.rootRepoPath)
        ) {
          await ctx.cleanupWorkspace(currentWt, input.rootRepoPath);
        }
      }
    }
  }

  const headRes = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], input.rootRepoPath);
  const currentBranch = headRes.stdout.trim();
  const forceNoFf = Boolean(input.noFf);

  if (currentBranch === input.baseBranch) {
    const dirty = await runGit(
      ["status", "--porcelain", "--untracked-files=no"],
      input.rootRepoPath,
    );
    if (dirty.stdout.trim()) {
      throw new Error(
        `Base repository (${input.baseBranch}) has uncommitted tracked changes; commit or stash them before local merge.`,
      );
    }

    let mergeRes = forceNoFf
      ? { exitCode: 1, stdout: "", stderr: "" }
      : await runGit(["merge", "--ff-only", input.branchName], input.rootRepoPath);
    if (mergeRes.exitCode !== 0) {
      const userCheck = await runGit(["config", "user.name"], input.rootRepoPath);
      const mergeArgs = userCheck.stdout.trim()
        ? ["merge", "--no-ff", "-m", input.commitMessage, input.branchName]
        : [
            "-c",
            "user.name=super-work",
            "-c",
            "user.email=super-work@local",
            "merge",
            "--no-ff",
            "-m",
            input.commitMessage,
            input.branchName,
          ];
      mergeRes = await runGit(mergeArgs, input.rootRepoPath);
      if (mergeRes.exitCode !== 0) {
        await runGit(["merge", "--abort"], input.rootRepoPath);
        throw new Error(
          `git merge failed: ${mergeRes.stderr.trim() || mergeRes.stdout.trim()}`,
        );
      }
    }
  } else {
    const ffRes = forceNoFf
      ? { exitCode: 1, stdout: "", stderr: "" }
      : await runGit(["fetch", ".", `${input.branchName}:${input.baseBranch}`], input.rootRepoPath);
    if (ffRes.exitCode !== 0) {
      // Merge into an un-checked-out target branch (e.g. Epic staging branch or force --no-ff atomic commit)
      await mkdir(ctx.worktreesDir, { recursive: true });
      const mergeWt = join(
        ctx.worktreesDir,
        `_merge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      );
      const wtAdd = await runGit(
        ["worktree", "add", mergeWt, input.baseBranch],
        input.rootRepoPath,
      );
      if (wtAdd.exitCode !== 0) {
        throw new Error(
          `Repository HEAD is on '${currentBranch}' and temporary merge worktree for '${input.baseBranch}' failed: ${wtAdd.stderr.trim() || wtAdd.stdout.trim()}`,
        );
      }
      try {
        const userCheck = await runGit(["config", "user.name"], mergeWt);
        const mergeArgs = userCheck.stdout.trim()
          ? ["merge", "--no-ff", "-m", input.commitMessage, input.branchName]
          : [
              "-c",
              "user.name=super-work",
              "-c",
              "user.email=super-work@local",
              "merge",
              "--no-ff",
              "-m",
              input.commitMessage,
              input.branchName,
            ];
        const wtMerge = await runGit(mergeArgs, mergeWt);
        if (wtMerge.exitCode !== 0) {
          await runGit(["merge", "--abort"], mergeWt);
          throw new Error(
            `git merge into '${input.baseBranch}' failed: ${wtMerge.stderr.trim() || wtMerge.stdout.trim()}`,
          );
        }
      } finally {
        await ctx.cleanupWorkspace(mergeWt, input.rootRepoPath);
      }
    }
  }

  const shaRes = await runGit(["rev-parse", "--short", input.baseBranch], input.rootRepoPath);
  const commitSha = shaRes.stdout.trim();

  let branchCleaned = false;
  if (input.deleteBranch !== false) {
    const delRes = await runGit(["branch", "-D", input.branchName], input.rootRepoPath);
    branchCleaned = delRes.exitCode === 0;
  }

  return { commitSha, beforeSha, isMergeCommit: forceNoFf, branchCleaned };
}

export async function revertMergedCommitImpl(ctx: GitWorkspaceContext, input: {
  rootRepoPath: string;
  baseBranch: string;
  commitSha: string;
}): Promise<RevertResult> {
  const parentsRes = await runGit(
    ["rev-list", "--parents", "-n", "1", input.commitSha],
    input.rootRepoPath,
  );
  if (parentsRes.exitCode !== 0 || !parentsRes.stdout.trim()) {
    return {
      ok: false,
      error: `Commit '${input.commitSha}' not found in repository.`,
    };
  }

  const parentTokens = parentsRes.stdout.trim().split(/\s+/);
  const isMergeCommit = parentTokens.length >= 3;

  const executeRevertInDir = async (cwd: string): Promise<RevertResult> => {
    const userCheck = await runGit(["config", "user.name"], cwd);
    const baseArgs = isMergeCommit
      ? ["revert", "--no-edit", "-m", "1", input.commitSha]
      : ["revert", "--no-edit", input.commitSha];
    const args = userCheck.stdout.trim()
      ? baseArgs
      : ["-c", "user.name=super-work", "-c", "user.email=super-work@local", ...baseArgs];

    const revRes = await runGit(args, cwd);
    if (revRes.exitCode !== 0) {
      const conflictsRes = await runGit(["diff", "--name-only", "--diff-filter=U"], cwd);
      const conflictFiles = conflictsRes.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      await runGit(["revert", "--abort"], cwd);
      return {
        ok: false,
        conflictFiles: conflictFiles.length > 0 ? conflictFiles : undefined,
        error: revRes.stderr.trim() || revRes.stdout.trim() || "git revert failed",
      };
    }

    const newShaRes = await runGit(["rev-parse", "--short", "HEAD"], cwd);
    return {
      ok: true,
      revertCommitSha: newShaRes.stdout.trim() || undefined,
    };
  };

  const headRes = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], input.rootRepoPath);
  const currentBranch = headRes.stdout.trim();

  if (currentBranch === input.baseBranch) {
    const dirty = await runGit(
      ["status", "--porcelain", "--untracked-files=no"],
      input.rootRepoPath,
    );
    if (dirty.stdout.trim()) {
      return {
        ok: false,
        error: `Base repository (${input.baseBranch}) has uncommitted tracked changes; commit or stash before reverting.`,
      };
    }
    return executeRevertInDir(input.rootRepoPath);
  }

  await mkdir(ctx.worktreesDir, { recursive: true });
  const revertWt = join(
    ctx.worktreesDir,
    `_revert_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  );
  const wtAdd = await runGit(["worktree", "add", revertWt, input.baseBranch], input.rootRepoPath);
  if (wtAdd.exitCode !== 0) {
    return {
      ok: false,
      error: `Failed to checkout '${input.baseBranch}' in temporary worktree for revert: ${wtAdd.stderr.trim() || wtAdd.stdout.trim()}`,
    };
  }
  try {
    return await executeRevertInDir(revertWt);
  } finally {
    await ctx.cleanupWorkspace(revertWt, input.rootRepoPath);
  }
}
