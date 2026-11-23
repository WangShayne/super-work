import { existsSync } from "node:fs";
import type {
  OutboxEntry,
  OutboxExecutor,
  RepoConfig,
  SuperWorkKernel,
  Ticket,
  WorkspaceProvider,
} from "@super-work/core";
import { GitWorktreeProvider, runGit } from "../workspace/git-worktree-provider.ts";

interface GhCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runGh(args: string[], cwd?: string): Promise<GhCommandResult> {
  const proc = Bun.spawn(["gh", ...args], {
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

export class GhCliPollingSource {
  private timer: ReturnType<typeof setInterval> | null = null;
  private isPolling = false;

  constructor(
    private readonly kernel: SuperWorkKernel,
    private readonly intervalMs = 30_000,
    private readonly ghBin = "gh",
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async pollOnce(): Promise<number> {
    if (this.isPolling || !Bun.which(this.ghBin)) return 0;
    this.isPolling = true;
    let ingestedCount = 0;

    try {
      const repos = await this.kernel.stateStore.listRepos();
      const configured = repos.filter((r) => Boolean(r.githubRepo) && r.mode !== "off");
      if (configured.length === 0) return 0;

      const auth = await runGh(["auth", "status"]);
      if (auth.exitCode !== 0) {
        return 0;
      }

      for (const repo of configured) {
        ingestedCount += await this.pollRepo(repo);
      }
    } catch {
      // Never crash daemon loop on transient gh polling failure
    } finally {
      this.isPolling = false;
    }
    return ingestedCount;
  }

  private async pollRepo(repo: RepoConfig): Promise<number> {
    const ghRepo = repo.githubRepo!;
    let count = 0;

    // 1. Poll open issues + comments
    const issuesRes = await runGh([
      "issue",
      "list",
      "--repo",
      ghRepo,
      "--state",
      "open",
      "--limit",
      "20",
      "--json",
      "number,title,body,updatedAt,comments",
    ]);

    if (issuesRes.exitCode === 0 && issuesRes.stdout.trim()) {
      const issues = JSON.parse(issuesRes.stdout) as Array<{
        number: number;
        title: string;
        body: string;
        updatedAt: string;
        comments?: Array<{ id?: string; body: string; author?: { login?: string }; createdAt: string }>;
      }>;

      for (const issue of issues) {
        const res = await this.kernel.ingestTrigger({
          repoId: repo.id,
          source: "github_issue",
          externalRef: `gh:${ghRepo}:issue:${issue.number}:root`,
          threadKey: `gh:${ghRepo}:issue:${issue.number}`,
          title: `#${issue.number} ${issue.title}`,
          rawText: issue.body || issue.title,
          payload: { issueNumber: issue.number, githubRepo: ghRepo },
        });
        if (res.action !== "duplicate") count += 1;

        for (const comment of issue.comments ?? []) {
          const cid = comment.id ?? comment.createdAt;
          const cRes = await this.kernel.ingestTrigger({
            repoId: repo.id,
            source: "github_issue",
            externalRef: `gh:${ghRepo}:issue:${issue.number}:comment:${cid}`,
            threadKey: `gh:${ghRepo}:issue:${issue.number}`,
            title: `Comment on #${issue.number}`,
            rawText: comment.body,
            payload: {
              issueNumber: issue.number,
              author: comment.author?.login,
              githubRepo: ghRepo,
            },
          });
          if (cRes.action !== "duplicate") count += 1;
        }
      }
    }

    // 2. Poll open PRs for review feedback / failing CI checks
    const prsRes = await runGh([
      "pr",
      "list",
      "--repo",
      ghRepo,
      "--state",
      "open",
      "--limit",
      "20",
      "--json",
      "number,title,headRefName,reviewDecision,statusCheckRollup,comments",
    ]);

    if (prsRes.exitCode === 0 && prsRes.stdout.trim()) {
      const prs = JSON.parse(prsRes.stdout) as Array<{
        number: number;
        title: string;
        headRefName: string;
        reviewDecision?: string;
        statusCheckRollup?: Array<{ name?: string; conclusion?: string; state?: string }>;
        comments?: Array<{ id?: string; body: string; createdAt: string }>;
      }>;

      for (const pr of prs) {
        const failedChecks = (pr.statusCheckRollup ?? []).filter(
          (c) => c.conclusion === "FAILURE" || c.state === "FAILURE",
        );
        if (failedChecks.length > 0) {
          const checkNames = failedChecks.map((c) => c.name ?? "check").join(",");
          const ciRes = await this.kernel.ingestTrigger({
            repoId: repo.id,
            source: "github_ci",
            externalRef: `gh:${ghRepo}:pr:${pr.number}:ci_fail:${checkNames}`,
            threadKey: `gh:${ghRepo}:pr:${pr.number}`,
            title: `CI failed on PR #${pr.number}: ${pr.title}`,
            rawText: `Failing checks on branch ${pr.headRefName}: ${checkNames}`,
            payload: { prNumber: pr.number, branch: pr.headRefName, failedChecks },
          });
          if (ciRes.action !== "duplicate") count += 1;
        }

        for (const comment of pr.comments ?? []) {
          const cid = comment.id ?? comment.createdAt;
          const pRes = await this.kernel.ingestTrigger({
            repoId: repo.id,
            source: "github_pr",
            externalRef: `gh:${ghRepo}:pr:${pr.number}:comment:${cid}`,
            threadKey: `gh:${ghRepo}:pr:${pr.number}`,
            title: `PR #${pr.number} comment`,
            rawText: comment.body,
            payload: { prNumber: pr.number, branch: pr.headRefName },
          });
          if (pRes.action !== "duplicate") count += 1;
        }
      }
    }

    return count;
  }
}

export class GhOutboxExecutor implements OutboxExecutor {
  constructor(private readonly workspace?: WorkspaceProvider) {}

  async execute(
    entry: OutboxEntry,
    repo: RepoConfig,
    ticket: Ticket,
  ): Promise<Record<string, unknown>> {
    const worktreePath = ticket.worktreePath ?? (entry.payload.worktreePath as string | undefined);
    const branchName = ticket.branchName ?? (entry.payload.branchName as string | undefined);

    if (entry.action === "local_merge") {
      if (!branchName) {
        throw new Error(`Ticket ${ticket.id} has no branchName to merge into ${repo.baseBranch}`);
      }
      const provider =
        this.workspace ?? new GitWorktreeProvider(`${repo.rootPath}/.super-work/worktrees`);
      const { commitSha, branchCleaned } = await provider.mergeBranchToBase({
        rootRepoPath: repo.rootPath,
        baseBranch: repo.baseBranch,
        branchName,
        worktreePath,
        commitMessage: `Merge ${branchName}: ${ticket.title}`,
        deleteBranch: true,
      });
      return {
        mode: "local_merged",
        baseBranch: repo.baseBranch,
        branchName,
        commitSha,
        branchCleaned,
      };
    }

    if (entry.action === "push_and_create_pr") {
      const gitCwd = worktreePath && existsSync(worktreePath) ? worktreePath : repo.rootPath;
      const forceGithubPr = Boolean(entry.payload.forceGithubPr);
      if (repo.githubRepo && Bun.which("gh") && branchName) {
        const remoteRes = await runGit(["remote", "get-url", "origin"], repo.rootPath);
        if (remoteRes.exitCode === 0 && remoteRes.stdout.trim()) {
          const pushRes = await runGit(["push", "-u", "origin", branchName], gitCwd);
          if (pushRes.exitCode !== 0) {
            throw new Error(`git push failed: ${pushRes.stderr.trim() || pushRes.stdout.trim()}`);
          }

          const prRes = await runGh(
            [
              "pr",
              "create",
              "--repo",
              repo.githubRepo,
              "--head",
              branchName,
              "--base",
              repo.baseBranch,
              "--title",
              ticket.title,
              "--body",
              String(entry.payload.summary ?? ticket.description),
            ],
            gitCwd,
          );
          if (prRes.exitCode !== 0) {
            throw new Error(`gh pr create failed: ${prRes.stderr.trim() || prRes.stdout.trim()}`);
          }
          return {
            mode: "github_pr",
            branchName,
            prUrl: prRes.stdout.trim(),
          };
        }
      }

      if (forceGithubPr) {
        throw new Error(
          "githubRepo, git remote origin, and authenticated gh CLI are required for GitHub PR delivery",
        );
      }

      // Pure local git repository delivery (ready on isolated branch for local merge/review)
      let diffStat = "";
      if (worktreePath && existsSync(worktreePath)) {
        const statRes = await runGit(["diff", "--stat", repo.baseBranch], worktreePath);
        diffStat = statRes.stdout.trim();
      } else if (branchName) {
        const statRes = await runGit(
          ["diff", "--stat", `${repo.baseBranch}...${branchName}`],
          repo.rootPath,
        );
        diffStat = statRes.stdout.trim();
      }
      return {
        mode: "local_branch_ready",
        branchName: branchName ?? `super-work/${ticket.id}`,
        worktreePath,
        diffStat,
      };
    }

    if (entry.action === "comment_issue" || entry.action === "comment_pr") {
      if (repo.githubRepo && Bun.which("gh") && entry.payload.number) {
        const cmd = entry.action === "comment_issue" ? "issue" : "pr";
        const res = await runGh([
          cmd,
          "comment",
          String(entry.payload.number),
          "--repo",
          repo.githubRepo,
          "--body",
          String(entry.payload.body ?? ""),
        ]);
        if (res.exitCode !== 0) {
          throw new Error(`gh ${cmd} comment failed: ${res.stderr.trim()}`);
        }
        return { mode: "github_comment", number: entry.payload.number };
      }
      return { mode: "local_recorded", body: entry.payload.body };
    }

    return { mode: "noop" };
  }
}
