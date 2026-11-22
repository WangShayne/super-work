import { access, mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RepoConfig, Ticket, WorkspaceProvider } from "@super-work/core";

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

  async prepareWorkspace(
    ticket: Ticket,
    repo: RepoConfig,
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
      return { worktreePath, branchName };
    } catch {
      // Proceed to create worktree
    }

    await mkdir(this.worktreesDir, { recursive: true });
    await runGit(["worktree", "prune"], repo.rootPath);

    const addRes = await runGit(
      ["worktree", "add", "-B", branchName, worktreePath, repo.baseBranch],
      repo.rootPath,
    );
    if (addRes.exitCode !== 0) {
      throw new Error(`git worktree add failed: ${addRes.stderr.trim() || addRes.stdout.trim()}`);
    }

    return { worktreePath, branchName };
  }

  async getChangedFiles(worktreePath: string, baseBranch: string): Promise<string[]> {
    const [diffTracked, diffCached, untracked] = await Promise.all([
      runGit(["diff", "--name-only", baseBranch], worktreePath),
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
    const diffRes = await runGit(["diff", baseBranch], worktreePath);
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
    const res = await runGit(["rebase", baseBranch], worktreePath);
    if (res.exitCode === 0) {
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
    if (rootRepoPath) {
      await runGit(["worktree", "remove", "--force", worktreePath], rootRepoPath);
    }
    await rm(worktreePath, { recursive: true, force: true });
    if (rootRepoPath) {
      await runGit(["worktree", "prune"], rootRepoPath);
    }
  }
}
