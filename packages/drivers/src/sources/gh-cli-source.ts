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

function isGhAvailable(ghBin: string): boolean {
  if (ghBin.includes("/")) {
    return existsSync(ghBin);
  }
  return Boolean(Bun.which(ghBin));
}

async function runGh(args: string[], cwd?: string, ghBin = "gh"): Promise<GhCommandResult> {
  const proc = Bun.spawn([ghBin, ...args], {
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
    if (this.isPolling || !isGhAvailable(this.ghBin)) return 0;
    this.isPolling = true;
    let ingestedCount = 0;

    try {
      const repos = await this.kernel.stateStore.listRepos();
      const configured = repos.filter((r) => Boolean(r.githubRepo) && r.mode !== "off");
      if (configured.length === 0) return 0;

      const auth = await runGh(["auth", "status"], undefined, this.ghBin);
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
    const issuesRes = await runGh(
      [
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
      ],
      undefined,
      this.ghBin,
    );

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
          if (comment.body.includes("[super-work]")) continue;
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
    const prsRes = await runGh(
      [
        "pr",
        "list",
        "--repo",
        ghRepo,
        "--state",
        "open",
        "--limit",
        "20",
        "--json",
        "number,title,headRefName,reviewDecision,statusCheckRollup,comments,reviews",
      ],
      undefined,
      this.ghBin,
    );

    if (prsRes.exitCode === 0 && prsRes.stdout.trim()) {
      const prs = JSON.parse(prsRes.stdout) as Array<{
        number: number;
        title: string;
        headRefName: string;
        reviewDecision?: string;
        statusCheckRollup?: Array<{ name?: string; conclusion?: string; state?: string }>;
        comments?: Array<{ id?: string; body: string; createdAt: string }>;
        reviews?: Array<{ id?: string; body?: string; state?: string; submittedAt?: string }>;
      }>;

      for (const pr of prs) {
        const failedChecks = (pr.statusCheckRollup ?? []).filter(
          (c) => c.conclusion === "FAILURE" || c.state === "FAILURE",
        );
        if (failedChecks.length > 0) {
          const checkNames = failedChecks.map((c) => c.name ?? "check").join(",");
          let runDatabaseId: string | number | undefined;
          let failedLogTail = "";

          const runsRes = await runGh(
            [
              "run",
              "list",
              "--repo",
              ghRepo,
              "--branch",
              pr.headRefName,
              "--status",
              "failure",
              "--limit",
              "1",
              "--json",
              "databaseId",
            ],
            undefined,
            this.ghBin,
          );
          if (runsRes.exitCode === 0 && runsRes.stdout.trim()) {
            try {
              const parsedRuns = JSON.parse(runsRes.stdout) as Array<{
                databaseId?: number | string;
              }>;
              runDatabaseId = parsedRuns[0]?.databaseId;
            } catch {
              // Ignore non-JSON run list output
            }
          }

          if (runDatabaseId !== undefined) {
            const logRes = await runGh(
              ["run", "view", String(runDatabaseId), "--repo", ghRepo, "--log-failed"],
              undefined,
              this.ghBin,
            );
            if (logRes.exitCode === 0 && logRes.stdout.trim()) {
              failedLogTail = logRes.stdout.trim().slice(-1500);
            }
          }

          const externalRef =
            runDatabaseId !== undefined
              ? `gh:${ghRepo}:pr:${pr.number}:ci_fail:${runDatabaseId}:${checkNames}`
              : `gh:${ghRepo}:pr:${pr.number}:ci_fail:${checkNames}`;

          const rawText = [
            `Failing checks on branch ${pr.headRefName}: ${checkNames}`,
            failedLogTail ? `\nFailed CI Log (tail):\n${failedLogTail}` : "",
          ]
            .filter(Boolean)
            .join("\n");

          const ciRes = await this.kernel.ingestTrigger({
            repoId: repo.id,
            source: "github_ci",
            externalRef,
            threadKey: `gh:${ghRepo}:pr:${pr.number}`,
            title: `CI failed on PR #${pr.number}: ${pr.title}`,
            rawText,
            payload: {
              prNumber: pr.number,
              branch: pr.headRefName,
              failedChecks,
              runDatabaseId,
            },
          });
          if (ciRes.action !== "duplicate") count += 1;
        }

        for (const comment of pr.comments ?? []) {
          if (comment.body.includes("[super-work]")) continue;
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

        for (const review of pr.reviews ?? []) {
          const body = (review.body ?? "").trim();
          if (body.includes("[super-work]")) continue;
          const state = review.state ?? "";
          if (!body && state !== "CHANGES_REQUESTED") continue;
          const rid = review.id ?? review.submittedAt ?? state;
          const rRes = await this.kernel.ingestTrigger({
            repoId: repo.id,
            source: "github_pr",
            externalRef: `gh:${ghRepo}:pr:${pr.number}:review:${rid}`,
            threadKey: `gh:${ghRepo}:pr:${pr.number}`,
            title: `PR #${pr.number} review (${state || "comment"})`,
            rawText: body || `Review requested changes on PR #${pr.number}`,
            payload: { prNumber: pr.number, branch: pr.headRefName, state },
          });
          if (rRes.action !== "duplicate") count += 1;
        }
      }
    }

    return count;
  }
}

export class GhOutboxExecutor implements OutboxExecutor {
  constructor(
    private readonly workspace?: WorkspaceProvider,
    private readonly ghBin = "gh",
  ) {}

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
      if (repo.githubRepo && isGhAvailable(this.ghBin) && branchName) {
        const remoteRes = await runGit(["remote", "get-url", "origin"], repo.rootPath);
        if (remoteRes.exitCode === 0 && remoteRes.stdout.trim()) {
          const pushRes = await runGit(["push", "-u", "origin", branchName], gitCwd);
          if (pushRes.exitCode !== 0) {
            throw new Error(`git push failed: ${pushRes.stderr.trim() || pushRes.stdout.trim()}`);
          }

          let existingPrNumber = ticket.prNumber;
          let existingPrUrl = ticket.prUrl;
          if (!existingPrNumber) {
            const listRes = await runGh(
              [
                "pr",
                "list",
                "--repo",
                repo.githubRepo,
                "--head",
                branchName,
                "--state",
                "open",
                "--json",
                "number,url",
              ],
              gitCwd,
              this.ghBin,
            );
            if (listRes.exitCode === 0 && listRes.stdout.trim()) {
              try {
                const openPrs = JSON.parse(listRes.stdout) as Array<{
                  number?: number;
                  url?: string;
                }>;
                if (openPrs[0]?.number) {
                  existingPrNumber = openPrs[0].number;
                  existingPrUrl = openPrs[0].url;
                }
              } catch {
                // Fall through to gh pr create
              }
            }
          }

          if (existingPrNumber) {
            const updateBody = `[super-work] Updated branch \`${branchName}\`:\n\n${String(entry.payload.summary ?? ticket.description)}`;
            await runGh(
              [
                "pr",
                "comment",
                String(existingPrNumber),
                "--repo",
                repo.githubRepo,
                "--body",
                updateBody,
              ],
              gitCwd,
              this.ghBin,
            );
            return {
              mode: "github_pr_updated",
              branchName,
              prNumber: existingPrNumber,
              prUrl: existingPrUrl,
            };
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
            this.ghBin,
          );
          if (prRes.exitCode !== 0) {
            throw new Error(`gh pr create failed: ${prRes.stderr.trim() || prRes.stdout.trim()}`);
          }
          const prUrl = prRes.stdout.trim();
          const prNumber = Number(prUrl.match(/\/pull\/(\d+)/)?.[1]) || undefined;
          return {
            mode: "github_pr",
            branchName,
            prUrl,
            prNumber,
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
      if (repo.githubRepo && isGhAvailable(this.ghBin) && entry.payload.number) {
        const cmd = entry.action === "comment_issue" ? "issue" : "pr";
        const res = await runGh(
          [
            cmd,
            "comment",
            String(entry.payload.number),
            "--repo",
            repo.githubRepo,
            "--body",
            String(entry.payload.body ?? ""),
          ],
          undefined,
          this.ghBin,
        );
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
