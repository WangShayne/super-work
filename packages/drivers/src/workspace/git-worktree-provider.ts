import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { ControlProbeRequest, CodeHotspotItem, ControlProbeStep, RepoConfig, RepoContractFile, RepoProbeContextPack, SandboxMode, SymbolImpactReport, Ticket, VerificationCommandOutput, VerificationRunResult, WorkspaceProvider } from "@super-work/core";
import { runCdpBrowserCheck } from "../browser/cdp-browser-check.ts";
import { buildSanitizedWorkerEnv } from "../sandbox/os-sandbox.ts";
import { resolveImpactScopedVerification, type ImpactScopedVerificationInput, type ImpactScopedVerificationPlan } from "./impact-verification-planner.ts";
import { executeReadOnlyProbeTool, runDeterministicRepoPreProbe } from "./readonly-repo-prober.ts";
import { scanRepoStructureSummary } from "./repo-structure-scanner.ts";
import { analyzeRepoSymbolImpact, verifyHotspotParityImpl } from "./symbol-graph-scanner.ts";
import { buildSurgicalContextPackImpl, scanCodeHotspotsImpl } from "./surgical-context-builder.ts";
import { runGit, readPorcelainEntries, type GitCommandResult } from "./git-command-runner.ts";
import type { GitWorkspaceContext, ImplArgs, BrowserCheckRunner } from "./git-workspace-context.ts";
import { linkRepoNodeModulesImpl } from "./git-node-modules-links.ts";
import { runVerificationCommandsImpl, runSmokeCheckImpl } from "./git-verification-runner.ts";
import { prepareThreeWayConflictWorkspaceImpl, mergeBranchToBaseImpl, revertMergedCommitImpl } from "./git-pr-merge-ops.ts";
import { getChangedFilesSinceImpl, revertPathsToCommitImpl, captureWorktreeCheckpointImpl, restoreWorktreeCheckpointImpl, cleanupTicketCheckpointsImpl, listCheckpointRefsImpl, deleteGitRefImpl } from "./git-conflict-checkpoints.ts";
import { executeMilestoneReleaseImpl } from "./git-milestone-release.ts";

export { allocateFreeLocalPort, runGit, type GitCommandResult } from "./git-command-runner.ts";
export type { BrowserCheckRunner } from "./git-workspace-context.ts";

export class GitWorktreeProvider implements WorkspaceProvider {
  private readonly worktreesDir: string;
  private readonly browserRunner: BrowserCheckRunner;

  constructor(
    worktreesDir: string,
    options?: {
      browserRunner?: BrowserCheckRunner;
    },
  ) {
    this.worktreesDir = resolve(worktreesDir);
    this.browserRunner = options?.browserRunner ?? ((url, cfg) => runCdpBrowserCheck(url, cfg));
  }

  private ctx(): GitWorkspaceContext {
    return {
      worktreesDir: this.worktreesDir,
      browserRunner: this.browserRunner,
      cleanupWorkspace: (worktreePath, rootRepoPath) => this.cleanupWorkspace(worktreePath, rootRepoPath),
      getHeadCommitSha: (repoOrWorktreePath, rev) => this.getHeadCommitSha(repoOrWorktreePath, rev),
      linkRepoNodeModules: (repoRoot, worktreePath) => this.linkRepoNodeModules(repoRoot, worktreePath),
      runVerificationCommands: (...args) => this.runVerificationCommands(...args),
      worktreeBaseRef: (worktreePath) => this.worktreeBaseRef(worktreePath),
    };
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

  async ensureBranchExists(input: {
    rootRepoPath: string;
    branchName: string;
    baseBranch: string;
  }): Promise<void> {
    const check = await runGit(
      ["rev-parse", "--verify", "--quiet", `refs/heads/${input.branchName}`],
      input.rootRepoPath,
    );
    if (check.exitCode === 0) return;
    await this.ensureBranch(input.rootRepoPath, input.branchName, input.baseBranch);
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

  private async linkRepoNodeModules(...args: Parameters<typeof linkRepoNodeModulesImpl>): ReturnType<typeof linkRepoNodeModulesImpl> {
    return linkRepoNodeModulesImpl(...args);
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

  /** Dirty (modified/staged/untracked) paths of the root repo, repo-relative. */
  async snapshotRepoDirtyPaths(rootRepoPath: string): Promise<string[]> {
    const entries = await readPorcelainEntries(rootRepoPath);
    return Array.from(new Set(entries.map((e) => e.path))).sort();
  }

  /**
   * Isolates writes a worker leaked into the root repo during a turn: tracked paths that were not
   * dirty beforehand are restored to HEAD, new untracked files are deleted. Pre-existing dirty paths
   * are never touched. The reverted diff + untracked list is returned for audit.
   */
  async quarantineRepoSpillover(input: {
    rootRepoPath: string;
    preTurnDirtyPaths: string[];
  }): Promise<{ quarantinedPaths: string[]; diffSummary: string }> {
    const root = resolve(input.rootRepoPath);
    const pre = new Set(input.preTurnDirtyPaths);
    const isSafe = (p: string): boolean =>
      !!p &&
      !p.startsWith("/") &&
      !p.split("/").includes("..") &&
      p !== ".git" &&
      !p.startsWith(".git/") &&
      !p.startsWith(".super-work/");
    const fresh = (await readPorcelainEntries(root)).filter((e) => !pre.has(e.path) && isSafe(e.path));
    if (fresh.length === 0) return { quarantinedPaths: [], diffSummary: "" };

    const untracked = fresh.filter((e) => e.xy === "??").map((e) => e.path);
    const added = fresh.filter((e) => e.xy !== "??" && e.xy.includes("A")).map((e) => e.path);
    const modified = fresh.filter((e) => e.xy !== "??" && !e.xy.includes("A")).map((e) => e.path);

    const parts: string[] = [];
    const trackedPaths = [...modified, ...added];
    if (trackedPaths.length > 0) {
      const diff = await runGit(["diff", "HEAD", "--", ...trackedPaths], root);
      parts.push(`## Tracked changes reverted\n${diff.stdout.trim() || trackedPaths.join("\n")}`);
    }
    if (untracked.length > 0) {
      parts.push(`## Untracked files removed\n${untracked.join("\n")}`);
    }
    const quarantined: string[] = [];
    if (modified.length > 0) {
      const res = await runGit(["checkout", "HEAD", "--", ...modified], root);
      if (res.exitCode === 0) quarantined.push(...modified);
    }
    if (added.length > 0) {
      const res = await runGit(["rm", "-f", "-q", "--", ...added], root);
      if (res.exitCode === 0) quarantined.push(...added);
    }
    for (const rel of untracked) {
      const abs = resolve(root, rel);
      if (!abs.startsWith(`${root}/`)) continue;
      try {
        await rm(abs, { force: true });
        quarantined.push(rel);
      } catch {
        // leave in place; reported as not quarantined
      }
    }
    return { quarantinedPaths: quarantined.sort(), diffSummary: parts.join("\n\n") };
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

  async runVerificationCommands(...args: Parameters<typeof runVerificationCommandsImpl>): ReturnType<typeof runVerificationCommandsImpl> {
    return runVerificationCommandsImpl(...args);
  }

  async runSmokeCheck(...args: ImplArgs<typeof runSmokeCheckImpl>): ReturnType<typeof runSmokeCheckImpl> {
    return runSmokeCheckImpl(this.ctx(), ...args);
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

  async prepareThreeWayConflictWorkspace(...args: ImplArgs<typeof prepareThreeWayConflictWorkspaceImpl>): ReturnType<typeof prepareThreeWayConflictWorkspaceImpl> {
    return prepareThreeWayConflictWorkspaceImpl(this.ctx(), ...args);
  }

  async mergeBranchToBase(...args: ImplArgs<typeof mergeBranchToBaseImpl>): ReturnType<typeof mergeBranchToBaseImpl> {
    return mergeBranchToBaseImpl(this.ctx(), ...args);
  }

  async revertMergedCommit(...args: ImplArgs<typeof revertMergedCommitImpl>): ReturnType<typeof revertMergedCommitImpl> {
    return revertMergedCommitImpl(this.ctx(), ...args);
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

  async deleteBranch(rootRepoPath: string, branchName: string): Promise<void> {
    if (!branchName.trim()) return;
    await runGit(["branch", "-D", branchName], rootRepoPath);
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

  async analyzeSymbolImpact(
    rootRepoPath: string,
    scopePatterns: string[],
  ): Promise<SymbolImpactReport> {
    return analyzeRepoSymbolImpact(rootRepoPath, scopePatterns);
  }

  async getDiffStat(worktreePath: string, baseBranch: string): Promise<string> {
    const res = await runGit(["diff", "--stat", `${baseBranch}...HEAD`], worktreePath);
    if (res.exitCode === 0) return res.stdout.trim();
    const fallback = await runGit(
      ["diff", "--stat", await this.resolveDiffBase(worktreePath, baseBranch)],
      worktreePath,
    );
    return fallback.exitCode === 0 ? fallback.stdout.trim() : "";
  }

  async verifyHotspotRefactorParity(input: {
    worktreePath: string;
    baseBranch: string;
    targetHotspotPath: string;
    maxLinesAfter: number;
    enforceExportParity: boolean;
  }) {
    const readBase = async (rel: string): Promise<string | null> => {
      const res = await runGit(["show", `${input.baseBranch}:${rel}`], input.worktreePath);
      return res.exitCode === 0 ? res.stdout : null;
    };
    const listChangedFiles = async (): Promise<string[]> => {
      const [diff, untracked] = await Promise.all([
        runGit(["diff", "--name-only", `${input.baseBranch}...HEAD`], input.worktreePath),
        runGit(["ls-files", "--others", "--exclude-standard"], input.worktreePath),
      ]);
      return [diff.stdout, untracked.stdout]
        .flatMap((o) => o.split("\n"))
        .map((l) => l.trim())
        .filter(Boolean);
    };
    return verifyHotspotParityImpl({ ...input, readBase, listChangedFiles });
  }

  async buildSurgicalContextPack(input: {
    worktreePath: string;
    allowedPaths: string[];
    maxFiles?: number;
    maxChars?: number;
  }): Promise<string | undefined> {
    return buildSurgicalContextPackImpl(input);
  }

  async scanCodeHotspots(rootRepoPath: string, thresholdLines = 1500): Promise<CodeHotspotItem[]> {
    return scanCodeHotspotsImpl(rootRepoPath, thresholdLines);
  }

  async resolveScopedVerification(
    input: ImpactScopedVerificationInput,
  ): Promise<ImpactScopedVerificationPlan> {
    return resolveImpactScopedVerification(input, { runGit });
  }

  async getHeadCommitSha(repoOrWorktreePath: string, rev = "HEAD"): Promise<string> {
    const res = await runGit(["rev-parse", "--verify", rev], repoOrWorktreePath);
    if (res.exitCode !== 0 || !res.stdout.trim()) {
      throw new Error(`Unable to resolve git revision '${rev}': ${res.stderr.trim() || res.stdout.trim()}`);
    }
    return res.stdout.trim();
  }

  async getTreeSha(worktreePath: string, rev = "HEAD^{tree}"): Promise<string> {
    const res = await runGit(["rev-parse", "--verify", rev], worktreePath);
    if (res.exitCode !== 0 || !res.stdout.trim()) {
      throw new Error(`Unable to resolve git tree '${rev}': ${res.stderr.trim() || res.stdout.trim()}`);
    }
    return res.stdout.trim();
  }

  async getChangedFilesSince(...args: ImplArgs<typeof getChangedFilesSinceImpl>): ReturnType<typeof getChangedFilesSinceImpl> {
    return getChangedFilesSinceImpl(this.ctx(), ...args);
  }

  async revertPathsToCommit(...args: ImplArgs<typeof revertPathsToCommitImpl>): ReturnType<typeof revertPathsToCommitImpl> {
    return revertPathsToCommitImpl(this.ctx(), ...args);
  }

  async captureWorktreeCheckpoint(...args: ImplArgs<typeof captureWorktreeCheckpointImpl>): ReturnType<typeof captureWorktreeCheckpointImpl> {
    return captureWorktreeCheckpointImpl(this.ctx(), ...args);
  }

  async restoreWorktreeCheckpoint(...args: ImplArgs<typeof restoreWorktreeCheckpointImpl>): ReturnType<typeof restoreWorktreeCheckpointImpl> {
    return restoreWorktreeCheckpointImpl(this.ctx(), ...args);
  }

  async getCommitDiff(repoOrWorktreePath: string, fromSha: string, toSha: string): Promise<string> {
    const res = await runGit(["diff", fromSha, toSha], repoOrWorktreePath);
    return res.exitCode === 0 ? res.stdout : "";
  }

  async cleanupTicketCheckpoints(...args: ImplArgs<typeof cleanupTicketCheckpointsImpl>): ReturnType<typeof cleanupTicketCheckpointsImpl> {
    return cleanupTicketCheckpointsImpl(this.ctx(), ...args);
  }

  async listCheckpointRefs(...args: ImplArgs<typeof listCheckpointRefsImpl>): ReturnType<typeof listCheckpointRefsImpl> {
    return listCheckpointRefsImpl(this.ctx(), ...args);
  }

  async deleteGitRef(...args: ImplArgs<typeof deleteGitRefImpl>): ReturnType<typeof deleteGitRefImpl> {
    return deleteGitRefImpl(this.ctx(), ...args);
  }

  async runRepoPreProbe(
    rootRepoPath: string,
    queryText: string,
    forbiddenPaths?: string[],
  ): Promise<RepoProbeContextPack> {
    return runDeterministicRepoPreProbe(rootRepoPath, queryText, forbiddenPaths);
  }

  async executeRepoProbeTool(
    rootRepoPath: string,
    req: ControlProbeRequest,
    forbiddenPaths?: string[],
    stepIndex?: number,
  ): Promise<ControlProbeStep> {
    return executeReadOnlyProbeTool(rootRepoPath, req, forbiddenPaths, stepIndex);
  }

  async prepareDetachedWorktree(
    rootRepoPath: string,
    commitSha: string,
    label: string,
  ): Promise<{ worktreePath: string }> {
    const evalRoot = join(dirname(this.worktreesDir), "eval-worktrees");
    await mkdir(evalRoot, { recursive: true });
    const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "eval";
    const wtPath = join(evalRoot, `${safeLabel}-${Date.now().toString(36)}`);
    const addRes = await runGit(["worktree", "add", "--detach", wtPath, commitSha], rootRepoPath);
    if (addRes.exitCode !== 0) {
      throw new Error(
        `git worktree add --detach failed for ${commitSha}: ${addRes.stderr.trim() || addRes.stdout.trim()}`,
      );
    }
    await this.linkRepoNodeModules(rootRepoPath, wtPath);
    return { worktreePath: wtPath };
  }

  async getWorktreeNumstat(
    worktreePath: string,
    baseRef: string,
  ): Promise<{ addedLines: number; deletedLines: number; changedFiles: string[] }> {
    await runGit(["add", "-N", "."], worktreePath).catch(() => {});
    const [numRes, changedFiles] = await Promise.all([
      runGit(["diff", "--numstat", baseRef], worktreePath),
      this.getChangedFilesSince(worktreePath, baseRef),
    ]);
    let addedLines = 0;
    let deletedLines = 0;
    for (const line of numRes.stdout.split("\n")) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t/);
      if (!m) continue;
      if (m[1] !== "-") addedLines += Number(m[1]);
      if (m[2] !== "-") deletedLines += Number(m[2]);
    }
    return { addedLines, deletedLines, changedFiles };
  }

  async runLifecycleHooks(input: {
    cwd: string;
    commands: string[];
    timeoutSec?: number;
    hookEnv: Record<string, string>;
  }): Promise<VerificationRunResult> {
    const cleanCmds = input.commands.map((c) => c.trim()).filter(Boolean);
    if (cleanCmds.length === 0) {
      return { ok: true, results: [], summary: "No lifecycle hooks configured" };
    }
    const sanitizedEnv = buildSanitizedWorkerEnv({
      engine: "verification",
      baseEnv: process.env,
      extraEnv: input.hookEnv,
    });
    const timeoutMs = Math.max(5, Math.min(120, input.timeoutSec ?? 30)) * 1_000;
    const results: VerificationCommandOutput[] = [];

    for (const command of cleanCmds) {
      const started = Date.now();
      const proc = Bun.spawn(["sh", "-lc", command], {
        cwd: input.cwd,
        env: sanitizedEnv,
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
          // ignore
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
          summary: `Lifecycle hook failed (${command}, exit ${finalExit}): ${combined.slice(-800)}`,
        };
      }
    }

    return {
      ok: true,
      results,
      summary: `Executed ${results.length} lifecycle hook(s) cleanly`,
    };
  }

  async measureMetricAtRef(input: {
    rootRepoPath: string;
    gitRef: string;
    metricCommand: string;
    timeoutSec?: number;
    sandboxMode?: SandboxMode;
    forbiddenPaths?: string[];
  }): Promise<{ ok: boolean; rawOutput: string; exitCode: number; durationMs: number }> {
    const metricRoot = join(dirname(this.worktreesDir), "metric-worktrees");
    await mkdir(metricRoot, { recursive: true });
    const wtPath = join(metricRoot, `metric-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
    const addRes = await runGit(["worktree", "add", "--detach", wtPath, input.gitRef], input.rootRepoPath);
    if (addRes.exitCode !== 0) {
      throw new Error(
        `Failed to checkout metric ref '${input.gitRef}': ${addRes.stderr.trim() || addRes.stdout.trim()}`,
      );
    }
    try {
      await this.linkRepoNodeModules(input.rootRepoPath, wtPath);
      const res = await this.runVerificationCommands(
        wtPath,
        [input.metricCommand],
        input.timeoutSec ?? 60,
        {
          sandboxMode: input.sandboxMode ?? "balanced",
          forbiddenPaths: input.forbiddenPaths,
          allowNetwork: false,
          rootRepoPath: input.rootRepoPath,
        },
      );
      const first = res.results[0];
      return {
        ok: res.ok,
        rawOutput: first?.output ?? res.summary,
        exitCode: first?.exitCode ?? (res.ok ? 0 : 1),
        durationMs: first?.durationMs ?? 0,
      };
    } finally {
      await this.cleanupWorkspace(wtPath, input.rootRepoPath).catch(() => {});
    }
  }

  async executeMilestoneRelease(...args: Parameters<typeof executeMilestoneReleaseImpl>): ReturnType<typeof executeMilestoneReleaseImpl> {
    return executeMilestoneReleaseImpl(...args);
  }

  async resetBranchRef(
    rootRepoPath: string,
    branchName: string,
    targetCommitSha: string,
  ): Promise<void> {
    const headRes = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], rootRepoPath);
    if (headRes.stdout.trim() === branchName) {
      const resetRes = await runGit(["reset", "--hard", targetCommitSha], rootRepoPath);
      if (resetRes.exitCode !== 0) {
        throw new Error(
          `Failed to reset checked-out branch '${branchName}' to ${targetCommitSha}: ${resetRes.stderr.trim()}`,
        );
      }
      return;
    }
    const updRes = await runGit(["branch", "-f", branchName, targetCommitSha], rootRepoPath);
    if (updRes.exitCode !== 0) {
      throw new Error(
        `Failed to move branch '${branchName}' to ${targetCommitSha}: ${updRes.stderr.trim() || updRes.stdout.trim()}`,
      );
    }
  }

  async prepareSpeculativeMergeSlot(input: {
    rootRepoPath: string;
    baseCommitSha: string;
    branchName: string;
    commitMessage: string;
    slotLabel: string;
  }): Promise<{ ok: boolean; worktreePath: string; mergedCommitSha?: string; conflictSummary?: string }> {
    const trainRoot = join(dirname(this.worktreesDir), "train-worktrees");
    await mkdir(trainRoot, { recursive: true });
    const safeLabel = input.slotLabel.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "slot";
    const wtPath = join(
      trainRoot,
      `${safeLabel}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    );
    const addRes = await runGit(["worktree", "add", "--detach", wtPath, input.baseCommitSha], input.rootRepoPath);
    if (addRes.exitCode !== 0) {
      return {
        ok: false,
        worktreePath: "",
        conflictSummary: `Failed to prepare train slot at ${input.baseCommitSha}: ${addRes.stderr.trim() || addRes.stdout.trim()}`,
      };
    }

    const userCheck = await runGit(["config", "user.name"], wtPath);
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
    const mergeRes = await runGit(mergeArgs, wtPath);
    if (mergeRes.exitCode !== 0) {
      const conflictsRes = await runGit(["diff", "--name-only", "--diff-filter=U"], wtPath);
      const conflictFiles = conflictsRes.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      await runGit(["merge", "--abort"], wtPath).catch(() => {});
      await this.cleanupWorkspace(wtPath, input.rootRepoPath).catch(() => {});
      return {
        ok: false,
        worktreePath: "",
        conflictSummary:
          conflictFiles.length > 0
            ? `Speculative merge conflict in: ${conflictFiles.join(", ")}`
            : mergeRes.stderr.trim() || mergeRes.stdout.trim() || "Speculative merge failed",
      };
    }

    await this.linkRepoNodeModules(input.rootRepoPath, wtPath);
    const headSha = await this.getHeadCommitSha(wtPath, "HEAD");
    return { ok: true, worktreePath: wtPath, mergedCommitSha: headSha };
  }

  async fastForwardBranchToCommit(input: {
    rootRepoPath: string;
    baseBranch: string;
    targetCommitSha: string;
    cleanupWorktrees?: string[];
    deleteBranches?: string[];
  }): Promise<string> {
    for (const wt of input.cleanupWorktrees ?? []) {
      if (wt) {
        await this.cleanupWorkspace(wt, input.rootRepoPath).catch(() => {});
      }
    }

    // Ensure target is fast-forward descendant of baseBranch before advancing ref
    const ancCheck = await runGit(
      ["merge-base", "--is-ancestor", input.baseBranch, input.targetCommitSha],
      input.rootRepoPath,
    );
    if (ancCheck.exitCode !== 0) {
      throw new Error(
        `Cannot fast-forward '${input.baseBranch}' to non-descendant commit ${input.targetCommitSha}`,
      );
    }

    const headRes = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], input.rootRepoPath);
    if (headRes.stdout.trim() === input.baseBranch) {
      const dirty = await runGit(
        ["status", "--porcelain", "--untracked-files=no"],
        input.rootRepoPath,
      );
      if (dirty.stdout.trim()) {
        throw new Error(
          `Base repository (${input.baseBranch}) has uncommitted tracked changes; commit or stash before advancing merge train.`,
        );
      }
      const ffRes = await runGit(["merge", "--ff-only", input.targetCommitSha], input.rootRepoPath);
      if (ffRes.exitCode !== 0) {
        throw new Error(
          `git merge --ff-only ${input.targetCommitSha} failed: ${ffRes.stderr.trim() || ffRes.stdout.trim()}`,
        );
      }
    } else {
      const updRes = await runGit(
        ["branch", "-f", input.baseBranch, input.targetCommitSha],
        input.rootRepoPath,
      );
      if (updRes.exitCode !== 0) {
        throw new Error(
          `Failed to advance '${input.baseBranch}' to ${input.targetCommitSha}: ${updRes.stderr.trim() || updRes.stdout.trim()}`,
        );
      }
    }

    for (const br of input.deleteBranches ?? []) {
      if (br) {
        await runGit(["branch", "-D", br], input.rootRepoPath).catch(() => {});
      }
    }

    return this.getHeadCommitSha(input.rootRepoPath, input.baseBranch);
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
