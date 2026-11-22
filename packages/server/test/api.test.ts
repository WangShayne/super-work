import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { SuperWorkKernel, type OutboxExecutor } from "@super-work/core";
import {
  FsArtifactStore,
  GitWorktreeProvider,
  HeuristicControlLLM,
  MockWorkerDriver,
  SqliteStateStore,
  runGit,
} from "@super-work/drivers";
import { createServerApp } from "../src/app.ts";

async function createTempGitRepo(baseDir: string): Promise<string> {
  const repoDir = join(baseDir, "repo");
  await runGit(["init", "-b", "main", repoDir], baseDir);
  await runGit(["config", "user.name", "Test User"], repoDir);
  await runGit(["config", "user.email", "test@example.com"], repoDir);
  await writeFile(join(repoDir, "README.md"), "# API Demo\n", "utf8");
  await runGit(["add", "."], repoDir);
  await runGit(["commit", "-m", "init"], repoDir);
  return repoDir;
}

describe("@super-work/server REST + SSE API", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const d of tempDirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("handles repo registration, observe trigger -> inbox approval -> execution -> recall & outbox", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-api-"));
    tempDirs.push(dir);
    const repoDir = await createTempGitRepo(dir);

    const stateStore = new SqliteStateStore(join(dir, "state.db"));
    const artifactStore = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));
    const llm = new HeuristicControlLLM();
    const outboxExecutor: OutboxExecutor = {
      async execute(_entry, _repo, ticket) {
        return { mode: "local_branch_ready", branchName: ticket.branchName };
      },
    };

    const kernel = new SuperWorkKernel({
      stateStore,
      artifactStore,
      workspace,
      llm,
      drivers: [new MockWorkerDriver({ engine: "mock", stepDelayMs: 1 })],
      outboxExecutor,
    });

    const app = createServerApp({
      kernel,
      stateStore,
      artifactStore,
      llmProviderName: llm.providerName,
    });

    // 1. Health check
    const healthRes = await app.request("/api/health");
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as { ok: boolean; availableEngines: string[] };
    expect(health.ok).toBe(true);
    expect(health.availableEngines).toContain("mock");

    // 2. Register repo in observe mode
    const createRepoRes = await app.request("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "repo_api",
        name: "api-demo",
        rootPath: repoDir,
        baseBranch: "main",
        mode: "observe",
        defaultTemplate: "fast",
        preferredImplementEngine: "mock",
        preferredReviewEngine: "mock",
      }),
    });
    expect(createRepoRes.status).toBe(201);

    // 3. Simulate external trigger -> enters Inbox as observe_proposal
    const trgRes = await app.request("/api/triggers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoId: "repo_api",
        source: "github_issue",
        threadKey: "gh:issue:99",
        title: "Add metrics helper",
        rawText: "Create metrics helper inside scope:src/metrics/**",
      }),
    });
    expect(trgRes.status).toBe(201);

    const inboxRes = await app.request("/api/inbox?status=pending");
    const inboxData = (await inboxRes.json()) as { items: Array<{ id: string; ticketId: string; kind: string }> };
    expect(inboxData.items).toHaveLength(1);
    expect(inboxData.items[0]!.kind).toBe("observe_proposal");

    // 4. Approve Inbox item and drain kernel
    const resolveRes = await app.request(`/api/inbox/${inboxData.items[0]!.id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approved", note: "Approved via API test" }),
    });
    expect(resolveRes.status).toBe(200);

    await kernel.runUntilIdle();

    // 5. Inspect Ticket details, Chain of Recall, Memory Search, and Outbox
    const ticketId = inboxData.items[0]!.ticketId;
    const detailRes = await app.request(`/api/tickets/${ticketId}`);
    const detail = (await detailRes.json()) as {
      ticket: { status: string; worktreePath?: string; worktreeCleanedAt?: string };
      stageRuns: unknown[];
      artifacts: Array<{ id: string }>;
      diff: string;
    };
    expect(detail.ticket.status).toBe("delivered");
    expect(detail.ticket.worktreePath).toBeUndefined();
    expect(detail.ticket.worktreeCleanedAt).toBeDefined();
    expect(detail.stageRuns.length).toBeGreaterThanOrEqual(2);
    expect(detail.artifacts.length).toBeGreaterThanOrEqual(1);
    expect(detail.diff).toContain("src/metrics");

    const recallRes = await app.request(`/api/tickets/${ticketId}/recall`);
    expect(recallRes.status).toBe(200);

    const searchRes = await app.request("/api/memory/search?q=metrics");
    const search = (await searchRes.json()) as { hits: Array<{ ticketId: string }> };
    expect(search.hits.some((h) => h.ticketId === ticketId)).toBe(true);

    const outboxRes = await app.request(`/api/outbox?ticketId=${ticketId}`);
    const outbox = (await outboxRes.json()) as { entries: Array<{ status: string }> };
    expect(outbox.entries[0]?.status).toBe("sent");

    stateStore.close();
  });

  it("supports per-repo preferences update and manual Worktree GC when autoCleanupWorktree is disabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-gc-api-"));
    tempDirs.push(dir);
    const repoDir = await createTempGitRepo(dir);

    const stateStore = new SqliteStateStore(join(dir, "state.db"));
    const artifactStore = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));
    const llm = new HeuristicControlLLM();
    const kernel = new SuperWorkKernel({
      stateStore,
      artifactStore,
      workspace,
      llm,
      drivers: [new MockWorkerDriver({ engine: "mock", stepDelayMs: 1 })],
      outboxExecutor: {
        async execute(_entry, _repo, ticket) {
          return { mode: "local_branch_ready", branchName: ticket.branchName };
        },
      },
    });
    const app = createServerApp({ kernel, stateStore, artifactStore, llmProviderName: llm.providerName });

    const createRepoRes = await app.request("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "repo_gc",
        name: "gc-demo",
        rootPath: repoDir,
        baseBranch: "main",
        mode: "auto",
        defaultTemplate: "fast",
        preferredImplementEngine: "mock",
        preferredReviewEngine: "mock",
        autoCleanupWorktree: false,
      }),
    });
    expect(createRepoRes.status).toBe(201);

    const patchRes = await app.request("/api/repos/repo_gc", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        defaultTemplate: "fast",
        autoCleanupWorktree: false,
        githubRepo: "  ",
      }),
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as {
      repo: { autoCleanupWorktree?: boolean; githubRepo?: string };
    };
    expect(patched.repo.autoCleanupWorktree).toBe(false);
    expect(patched.repo.githubRepo).toBeUndefined();

    const createTicketRes = await app.request("/api/tickets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoId: "repo_gc",
        title: "Keep worktree until GC",
        description: "Test manual GC",
        template: "fast",
        allowedPaths: ["src/**"],
        preferredEngine: "mock",
      }),
    });
    expect(createTicketRes.status).toBe(201);
    const { ticket } = (await createTicketRes.json()) as { ticket: { id: string } };

    await kernel.runUntilIdle();
    const deliveredTicket = await stateStore.getTicket(ticket.id);
    expect(deliveredTicket?.status).toBe("delivered");
    expect(deliveredTicket?.worktreePath).toBeDefined();

    const listRes = await app.request("/api/worktrees?repoId=repo_gc");
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as {
      items: Array<{ ticketId?: string; reclaimable: boolean; isOrphan: boolean }>;
    };
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      ticketId: ticket.id,
      reclaimable: true,
      isOrphan: false,
    });

    const healthRes = await app.request("/api/health");
    const health = (await healthRes.json()) as {
      counts: { reclaimableWorktrees?: number; activeWorktrees?: number };
    };
    expect(health.counts.reclaimableWorktrees).toBe(1);
    expect(health.counts.activeWorktrees).toBe(0);

    const gcRes = await app.request("/api/worktrees/gc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoId: "repo_gc" }),
    });
    expect(gcRes.status).toBe(200);
    const gcJson = (await gcRes.json()) as {
      result: { removedPaths: string[]; cleanedTicketIds: string[] };
      items: unknown[];
    };
    expect(gcJson.result.removedPaths).toHaveLength(1);
    expect(gcJson.result.cleanedTicketIds).toEqual([ticket.id]);
    expect(gcJson.items).toHaveLength(0);

    await kernel.stop();
    stateStore.close();
  });
});
