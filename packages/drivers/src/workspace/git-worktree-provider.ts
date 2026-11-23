import { existsSync } from "node:fs";
import { access, lstat, mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type {
  RepoConfig,
  RepoContractFile,
  RevertResult,
  Ticket,
  VerificationCommandOutput,
  VerificationRunResult,
  WorkspaceProvider,
} from "@super-work/core";
import { scanRepoStructureSummary } from "./repo-structure-scanner.ts";

export interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runGit(args: string[], cwd: string): Promise<GitCommandResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export class GitWorktreeProvider implements WorkspaceProvider {
  private readonly worktreesDir: string;

  constructor(worktreesDir: string) {
    this.worktreesDir = resolve(worktreesDir);
  }

  async ensureBranch(rootRepoPath: string, branchName: string, startPoint: string): Promise<void> {
    const check = await runGit(
      ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
      rootRepoPath,
    );
    if (check.exitCode === 0) return;

    const createRes = await runGit(["branch", branchName, startPoint], rootRepoPath);
    if (createRes.exitCode !== 0) {
      const recheck = await runGit(
        ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
        rootRepoPath,
      );
      if (recheck.exitCode !== 0) {
        throw new Error(
          `git branch ${branchName} from ${startPoint} failed: ${createRes.stderr.trim() || createRes.stdout.trim()}`,
        );
      }
    }
  }

  async getRepoStructureSummary(rootRepoPath: string): Promise<string> {
    return scanRepoStructureSummary(rootRepoPath);
  }

  async loadRepoContract(
    rootRepoPath: string,
  ): Promise<{ contract: RepoContractFile; rawHash: string; filePath: string } | null> {
    const filePath = join(resolve(rootRepoPath), "super-work.json");
    if (!existsSync(filePath)) {
      return null;
    }
    const rawText = await readFile(filePath, "utf8");
    const parsed = JSON.parse(rawText) as RepoContractFile;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Invalid super-work.json contract in ${filePath}: expected JSON object`);
    }
    const rawHash = new Bun.CryptoHasher("sha256").update(rawText).digest("hex");
    return { contract: parsed, rawHash, filePath };
  }

  async writeRepoContract(
    rootRepoPath: string,
    contract: RepoContractFile,
  ): Promise<{ filePath: string; rawHash: string }> {
    const filePath = join(resolve(rootRepoPath), "super-work.json");
    const serialized = `${JSON.stringify(contract, null, 2)}\n`;
    await writeFile(filePath, serialized, "utf8");
    const rawHash = new Bun.CryptoHasher("sha256").update(serialized).digest("hex");
    return { filePath, rawHash };
  }

  async prepareWorkspace(
    ticket: Ticket,
    repo: RepoConfig,
    options?: { startPoint?: string },
  ): Promise<{ worktreePath: string; branchName: string }> {
    const branchName = ticket.branchName ?? `super-work/${ticket.id}`;
    const worktreePath = ticket.worktreePath ?? join(this.worktreesDir, ticket.id);

    const headCheck = await runGit(["rev-parse", "--verify", "HEAD"], repo.rootPath);
    if (headCheck.exitCode !== 0) {
      throw new Error(
        `Repository '${repo.name}' (${repo.rootPath}) has no commits (unborn HEAD). Create an initial commit before dispatching worktrees.`,
      );
    }

    // Reuse existing worktree cleanly across stages
    try {
      await access(join(worktreePath, ".git"));
      await this.linkRepoNodeModules(repo.rootPath, worktreePath);
      return { worktreePath, branchName };
    } catch {
      // Proceed to create worktree
    }

    await mkdir(this.worktreesDir, { recursive: true });
    await runGit(["worktree", "prune"], repo.rootPath);

    const localBranchRef = await runGit(
      ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
      repo.rootPath,
    );
    let addRes: GitCommandResult;
    if (localBranchRef.exitCode === 0) {
      addRes = await runGit(["worktree", "add", worktreePath, branchName], repo.rootPath);
    } else {
      const remoteBranchRef = await runGit(
        ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branchName}`],
        repo.rootPath,
      );
      if (remoteBranchRef.exitCode === 0) {
        addRes = await runGit(
          ["worktree", "add", "-b", branchName, worktreePath, `origin/${branchName}`],
          repo.rootPath,
        );
      } else {
        const startPoint = options?.startPoint ?? repo.baseBranch;
        addRes = await runGit(
          ["worktree", "add", "-b", branchName, worktreePath, startPoint],
          repo.rootPath,
        );
      }
    }

    if (addRes.exitCode !== 0) {
      throw new Error(`git worktree add failed: ${addRes.stderr.trim() || addRes.stdout.trim()}`);
    }

    if (options?.startPoint && options.startPoint !== repo.baseBranch) {
      await runGit(["update-ref", this.worktreeBaseRef(worktreePath), "HEAD"], worktreePath);
    }

    await this.linkRepoNodeModules(repo.rootPath, worktreePath);

    const setupCommands = (repo.setupCommands ?? []).map((c) => c.trim()).filter(Boolean);
    if (setupCommands.length > 0) {
      const setupRes = await this.runVerificationCommands(worktreePath, setupCommands, 120);
      if (!setupRes.ok) {
        await this.cleanupWorkspace(worktreePath, repo.rootPath);
        throw new Error(
          `Worktree setup failed (${setupRes.failedCommand ?? "setup"}): ${setupRes.summary}`,
        );
      }
    }

    return { worktreePath, branchName };
  }

  private async linkRepoNodeModules(repoRoot: string, worktreePath: string): Promise<void> {
    const repoAbs = resolve(repoRoot);
    const worktreeAbs = resolve(worktreePath);
    if (repoAbs === worktreeAbs) return;

    const candidates: string[] = ["node_modules"];
    for (const container of ["packages", "apps"]) {
      const containerDir = join(repoAbs, container);
      if (!existsSync(containerDir)) continue;
      let entries: string[] = [];
      try {
        entries = await readdir(containerDir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const relNm = join(container, entry, "node_modules");
        if (existsSync(join(repoAbs, relNm)) && existsSync(join(worktreeAbs, container, entry))) {
          candidates.push(relNm);
        }
      }
    }

    const rootNmPrefix = `${join(repoAbs, "node_modules")}/`;
    const linkEntry = async (srcEntry: string, dstEntry: string): Promise<void> => {
      try {
        await lstat(dstEntry);
        return; // Already present in worktree
      } catch {
        // Proceed to create symlink
      }

      const st = await lstat(srcEntry);
      if (st.isSymbolicLink()) {
        const rawTarget = await readlink(srcEntry);
        const absTarget = resolve(dirname(srcEntry), rawTarget);
        const isWorkspaceLink =
          (absTarget === repoAbs || absTarget.startsWith(`${repoAbs}/`)) &&
          !absTarget.startsWith(rootNmPrefix);
        await symlink(isWorkspaceLink ? rawTarget : absTarget, dstEntry);
        return;
      }

      await symlink(srcEntry, dstEntry, st.isDirectory() ? "dir" : "file");
    };

    for (const relNm of candidates) {
      const srcNm = join(repoAbs, relNm);
      if (!existsSync(srcNm)) continue;

      const ignoredRes = await runGit(["check-ignore", "--no-index", "-q", `${relNm}/`], worktreeAbs);
      if (ignoredRes.exitCode !== 0) {
        // Never inject untracked node_modules if not gitignored in target repository
        continue;
      }

      const dstNm = join(worktreeAbs, relNm);
      await mkdir(dstNm, { recursive: true });

      let items: string[] = [];
      try {
        items = await readdir(srcNm);
      } catch {
        continue;
      }

      for (const name of items) {
        const srcEntry = join(srcNm, name);
        const dstEntry = join(dstNm, name);
        const st = await lstat(srcEntry);
        if (name.startsWith("@") && !st.isSymbolicLink() && st.isDirectory()) {
          await mkdir(dstEntry, { recursive: true });
          const scopedItems = await readdir(srcEntry);
          for (const scopedName of scopedItems) {
            await linkEntry(join(srcEntry, scopedName), join(dstEntry, scopedName));
          }
        } else {
          await linkEntry(srcEntry, dstEntry);
        }
      }
    }
  }

  async integrateDependencyBranches(worktreePath: string, branchNames: string[]): Promise<void> {
    const userCheck = await runGit(["config", "user.name"], worktreePath);
    const identityArgs = userCheck.stdout.trim()
      ? []
      : ["-c", "user.name=super-work", "-c", "user.email=super-work@local"];

    for (const branch of Array.from(new Set(branchNames.filter(Boolean)))) {
      const exists = await runGit(["rev-parse", "--verify", branch], worktreePath);
      if (exists.exitCode !== 0) {
        // Already merged into baseBranch and cleaned up
        continue;
      }
      const mergeRes = await runGit([...identityArgs, "merge", "--no-edit", branch], worktreePath);
      if (mergeRes.exitCode !== 0) {
        await runGit(["merge", "--abort"], worktreePath);
        throw new Error(
          `Failed to integrate dependency branch ${branch}: ${mergeRes.stderr.trim() || mergeRes.stdout.trim()}`,
        );
      }
    }

    const baseRef = this.worktreeBaseRef(worktreePath);
    await runGit(["update-ref", baseRef, "HEAD"], worktreePath);
  }

  private worktreeBaseRef(worktreePath: string): string {
    return `refs/super-work-base/${basename(resolve(worktreePath))}`;
  }

  private async resolveDiffBase(worktreePath: string, baseBranch: string): Promise<string> {
    const baseRef = this.worktreeBaseRef(worktreePath);
    const check = await runGit(["rev-parse", "--verify", baseRef], worktreePath);
    return check.exitCode === 0 ? baseRef : baseBranch;
  }

  async getChangedFiles(worktreePath: string, baseBranch: string): Promise<string[]> {
    const diffBase = await this.resolveDiffBase(worktreePath, baseBranch);
    const [diffTracked, diffCached, untracked] = await Promise.all([
      runGit(["diff", "--name-only", diffBase], worktreePath),
      runGit(["diff", "--name-only", "--cached"], worktreePath),
      runGit(["ls-files", "--others", "--exclude-standard"], worktreePath),
    ]);

    const files = new Set<string>();
    for (const out of [diffTracked.stdout, diffCached.stdout, untracked.stdout]) {
      for (const line of out.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) files.add(trimmed);
      }
    }
    return Array.from(files).sort();
  }

  async getDiff(worktreePath: string, baseBranch: string): Promise<string> {
    const diffBase = await this.resolveDiffBase(worktreePath, baseBranch);
    const diffRes = await runGit(["diff", diffBase], worktreePath);
    const untrackedRes = await runGit(["ls-files", "--others", "--exclude-standard"], worktreePath);
    const untrackedList = untrackedRes.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    let result = diffRes.stdout;
    if (untrackedList.length > 0) {
      const chunks: string[] = [];
      for (const rel of untrackedList) {
        try {
          const content = await Bun.file(join(worktreePath, rel)).text();
          chunks.push(`--- /dev/null\n+++ b/${rel}\n${content}`);
        } catch {
          chunks.push(`--- /dev/null\n+++ b/${rel}\n<binary or unreadable>`);
        }
      }
      result = [result.trimEnd(), ...chunks].filter(Boolean).join("\n\n") + "\n";
    }
    return result;
  }

  async getBranchDiff(
    rootRepoPath: string,
    baseBranch: string,
    branchName: string,
  ): Promise<string> {
    const res = await runGit(["diff", `${baseBranch}...${branchName}`], rootRepoPath);
    return res.exitCode === 0 ? res.stdout : "";
  }

  async runVerificationCommands(
    worktreePath: string,
    commands: string[],
    timeoutSec = 120,
  ): Promise<VerificationRunResult> {
    const cleanCmds = commands.map((c) => c.trim()).filter(Boolean);
    if (cleanCmds.length === 0) {
      return {
        ok: true,
        results: [],
        summary: "No verification commands configured",
      };
    }

    const timeoutMs = Math.max(5, Math.min(timeoutSec, 300)) * 1_000;
    const results: VerificationCommandOutput[] = [];

    for (const command of cleanCmds) {
      const started = Date.now();
      const proc = Bun.spawn(["sh", "-lc", command], {
        cwd: worktreePath,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill();
        } catch {
          // Ignore already exited
        }
      }, timeoutMs);

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      clearTimeout(timer);

      const durationMs = Date.now() - started;
      const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      const finalExit = timedOut ? 124 : exitCode;
      results.push({
        command,
        exitCode: finalExit,
        durationMs,
        output: timedOut ? `${combined}\n[timed out after ${timeoutMs}ms]`.trim() : combined,
      });

      if (finalExit !== 0) {
        return {
          ok: false,
          results,
          failedCommand: command,
          summary: `Verification failed on command: ${command} (exit ${finalExit})\n${combined.slice(-1500)}`,
        };
      }
    }

    return {
      ok: true,
      results,
      summary: `All ${results.length} verification command(s) passed (${cleanCmds.join(", ")})`,
    };
  }

  async commitAll(worktreePath: string, message: string): Promise<boolean> {
    const status = await runGit(["status", "--porcelain"], worktreePath);
    if (!status.stdout.trim()) {
      return false;
    }

    const addRes = await runGit(["add", "-A"], worktreePath);
    if (addRes.exitCode !== 0) {
      throw new Error(`git add failed: ${addRes.stderr.trim()}`);
    }

    const userCheck = await runGit(["config", "user.name"], worktreePath);
    const commitArgs = userCheck.stdout.trim()
      ? ["commit", "-m", message]
      : ["-c", "user.name=super-work", "-c", "user.email=super-work@local", "commit", "-m", message];

    const commitRes = await runGit(commitArgs, worktreePath);
    if (commitRes.exitCode !== 0) {
      throw new Error(`git commit failed: ${commitRes.stderr.trim() || commitRes.stdout.trim()}`);
    }
    return true;
  }

  async rebaseOntoBase(
    worktreePath: string,
    baseBranch: string,
  ): Promise<{ ok: boolean; conflictSummary?: string }> {
    const baseRef = this.worktreeBaseRef(worktreePath);
    const hasBaseRef = (await runGit(["rev-parse", "--verify", baseRef], worktreePath)).exitCode === 0;
    let ownCommitCount = 0;
    if (hasBaseRef) {
      const cntRes = await runGit(["rev-list", "--count", `${baseRef}..HEAD`], worktreePath);
      ownCommitCount = Number.parseInt(cntRes.stdout.trim(), 10) || 0;
    }

    const res = await runGit(["rebase", baseBranch], worktreePath);
    if (res.exitCode === 0) {
      if (hasBaseRef) {
        await runGit(["update-ref", baseRef, `HEAD~${ownCommitCount}`], worktreePath);
      }
      return { ok: true };
    }

    const conflictsRes = await runGit(["diff", "--name-only", "--diff-filter=U"], worktreePath);
    const conflictFiles = conflictsRes.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    await runGit(["rebase", "--abort"], worktreePath);

    return {
      ok: false,
      conflictSummary:
        conflictFiles.length > 0
          ? `Merge conflicts in: ${conflictFiles.join(", ")}`
          : res.stderr.trim() || res.stdout.trim() || "Rebase conflict",
    };
  }

  async mergeBranchToBase(input: {
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
      await this.cleanupWorkspace(input.worktreePath, input.rootRepoPath);
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
            await this.cleanupWorkspace(currentWt, input.rootRepoPath);
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
        await mkdir(this.worktreesDir, { recursive: true });
        const mergeWt = join(
          this.worktreesDir,
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
          await this.cleanupWorkspace(mergeWt, input.rootRepoPath);
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

  async revertMergedCommit(input: {
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

    await mkdir(this.worktreesDir, { recursive: true });
    const revertWt = join(
      this.worktreesDir,
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
      await this.cleanupWorkspace(revertWt, input.rootRepoPath);
    }
  }

  async revertPaths(worktreePath: string, paths: string[]): Promise<void> {
    for (const rel of paths) {
      const tracked = await runGit(["ls-files", "--error-unmatch", rel], worktreePath);
      if (tracked.exitCode === 0) {
        await runGit(["reset", "HEAD", "--", rel], worktreePath);
        await runGit(["checkout", "HEAD", "--", rel], worktreePath);
      } else {
        await rm(join(worktreePath, rel), { recursive: true, force: true });
      }
    }
  }

  async listWorktreeDirs(): Promise<string[]> {
    try {
      const entries = await readdir(this.worktreesDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => join(this.worktreesDir, e.name))
        .sort();
    } catch {
      return [];
    }
  }

  async cleanupWorkspace(worktreePath: string, rootRepoPath?: string): Promise<void> {
    const baseRef = this.worktreeBaseRef(worktreePath);
    if (rootRepoPath) {
      await runGit(["update-ref", "-d", baseRef], rootRepoPath);
      await runGit(["worktree", "remove", "--force", worktreePath], rootRepoPath);
    }
    await rm(worktreePath, { recursive: true, force: true });
    if (rootRepoPath) {
      await runGit(["worktree", "prune"], rootRepoPath);
    }
  }
}
