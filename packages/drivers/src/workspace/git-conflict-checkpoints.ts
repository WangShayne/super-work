import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "./git-command-runner.ts";
import type { GitWorkspaceContext } from "./git-workspace-context.ts";

export async function getChangedFilesSinceImpl(ctx: GitWorkspaceContext, worktreePath: string, refOrSha: string): Promise<string[]> {
  const [trackedRes, untrackedRes] = await Promise.all([
    runGit(["diff", "--name-only", refOrSha], worktreePath),
    runGit(["ls-files", "--others", "--exclude-standard"], worktreePath),
  ]);
  const files = new Set<string>();
  for (const out of [trackedRes.stdout, untrackedRes.stdout]) {
    for (const line of out.split("\n")) {
      const clean = line.trim();
      if (clean) files.add(clean);
    }
  }
  return Array.from(files).sort();
}

export async function revertPathsToCommitImpl(ctx: GitWorkspaceContext, 
  worktreePath: string,
  commitSha: string,
  paths: string[],
): Promise<void> {
  for (const rel of paths) {
    const check = await runGit(["ls-tree", "-r", "--name-only", commitSha, "--", rel], worktreePath);
    if (check.exitCode === 0 && check.stdout.trim()) {
      await runGit(["checkout", commitSha, "--", rel], worktreePath);
    } else {
      await rm(join(worktreePath, rel), { recursive: true, force: true });
    }
  }
}

export async function captureWorktreeCheckpointImpl(ctx: GitWorkspaceContext, input: {
  worktreePath: string;
  ticketId: string;
  checkpointId: string;
  label: string;
}): Promise<{ gitRef: string; commitSha: string }> {
  const headSha = await ctx.getHeadCommitSha(input.worktreePath, "HEAD");
  const tmpIdx = join(
    tmpdir(),
    `sw-cp-${input.checkpointId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}.idx`,
  );
  const idxEnv: NodeJS.ProcessEnv = {
    GIT_INDEX_FILE: tmpIdx,
    GIT_AUTHOR_NAME: "super-work",
    GIT_AUTHOR_EMAIL: "super-work@local",
    GIT_COMMITTER_NAME: "super-work",
    GIT_COMMITTER_EMAIL: "super-work@local",
  };

  try {
    const readRes = await runGit(["read-tree", headSha], input.worktreePath, idxEnv);
    if (readRes.exitCode !== 0) {
      throw new Error(`git read-tree failed: ${readRes.stderr.trim()}`);
    }
    const addRes = await runGit(["add", "-A"], input.worktreePath, idxEnv);
    if (addRes.exitCode !== 0) {
      throw new Error(`git add checkpoint failed: ${addRes.stderr.trim()}`);
    }
    const treeRes = await runGit(["write-tree"], input.worktreePath, idxEnv);
    const treeSha = treeRes.stdout.trim();
    if (treeRes.exitCode !== 0 || !treeSha) {
      throw new Error(`git write-tree failed: ${treeRes.stderr.trim()}`);
    }

    const commitRes = await runGit(
      ["commit-tree", treeSha, "-p", headSha, "-m", input.label],
      input.worktreePath,
      idxEnv,
    );
    const commitSha = commitRes.stdout.trim();
    if (commitRes.exitCode !== 0 || !commitSha) {
      throw new Error(`git commit-tree failed: ${commitRes.stderr.trim()}`);
    }

    const gitRef = `refs/super-work/checkpoints/${input.ticketId}/${input.checkpointId}`;
    const updRes = await runGit(["update-ref", gitRef, commitSha], input.worktreePath);
    if (updRes.exitCode !== 0) {
      throw new Error(`git update-ref checkpoint failed: ${updRes.stderr.trim()}`);
    }
    return { gitRef, commitSha };
  } finally {
    await rm(tmpIdx, { force: true }).catch(() => {});
  }
}

export async function restoreWorktreeCheckpointImpl(ctx: GitWorkspaceContext, input: {
  worktreePath: string;
  rootRepoPath: string;
  commitSha: string;
}): Promise<void> {
  const resetRes = await runGit(["reset", "--hard", input.commitSha], input.worktreePath);
  if (resetRes.exitCode !== 0) {
    throw new Error(`git reset checkpoint failed: ${resetRes.stderr.trim() || resetRes.stdout.trim()}`);
  }
  await runGit(
    ["clean", "-fd", "-e", "node_modules", "-e", "**/node_modules"],
    input.worktreePath,
  );
  await ctx.linkRepoNodeModules(input.rootRepoPath, input.worktreePath);
}

export async function cleanupTicketCheckpointsImpl(ctx: GitWorkspaceContext, rootRepoPath: string, ticketId: string): Promise<number> {
  const prefix = `refs/super-work/checkpoints/${ticketId}/`;
  const listRes = await runGit(["for-each-ref", "--format=%(refname)", prefix], rootRepoPath);
  if (listRes.exitCode !== 0 || !listRes.stdout.trim()) {
    return 0;
  }
  let count = 0;
  for (const rawRef of listRes.stdout.split("\n")) {
    const ref = rawRef.trim();
    if (!ref) continue;
    const del = await runGit(["update-ref", "-d", ref], rootRepoPath);
    if (del.exitCode === 0) count += 1;
  }
  return count;
}

export async function listCheckpointRefsImpl(ctx: GitWorkspaceContext, rootRepoPath: string): Promise<Array<{ ref: string; ticketId: string }>> {
  const prefix = "refs/super-work/checkpoints/";
  const listRes = await runGit(["for-each-ref", "--format=%(refname)", prefix], rootRepoPath);
  if (listRes.exitCode !== 0 || !listRes.stdout.trim()) {
    return [];
  }
  const items: Array<{ ref: string; ticketId: string }> = [];
  for (const raw of listRes.stdout.split("\n")) {
    const ref = raw.trim();
    if (!ref || !ref.startsWith(prefix)) continue;
    const rest = ref.slice(prefix.length);
    const ticketId = rest.split("/")[0]?.trim() ?? "";
    if (ticketId) {
      items.push({ ref, ticketId });
    }
  }
  return items;
}

export async function deleteGitRefImpl(ctx: GitWorkspaceContext, rootRepoPath: string, ref: string): Promise<boolean> {
  const res = await runGit(["update-ref", "-d", ref], rootRepoPath);
  return res.exitCode === 0;
}
