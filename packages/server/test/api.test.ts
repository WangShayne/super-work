import { readFile } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { SuperWorkKernel, nowIso, type OutboxExecutor } from "@super-work/core";
import {
  FsArtifactStore,
  GhOutboxExecutor,
  GitWorktreeProvider,
  HeuristicControlLLM,
  MockWorkerDriver,
  NotificationDispatcher,
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

  it("supports Epic preview/dispatch and on-demand local_merge delivery with Spill diff retention", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v03-api-"));
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
      outboxExecutor: new GhOutboxExecutor(workspace),
    });
    const app = createServerApp({ kernel, stateStore, artifactStore, llmProviderName: llm.providerName });

    await app.request("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "repo_v03",
        name: "v03-demo",
        rootPath: repoDir,
        baseBranch: "main",
        mode: "auto",
        defaultTemplate: "fast",
        preferredImplementEngine: "mock",
        preferredReviewEngine: "mock",
        verificationCommands: ["git status --short"],
      }),
    });

    // 1. Preview Epic DAG decomposition
    const previewRes = await app.request("/api/epics/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoId: "repo_v03",
        title: "Add plugin architecture",
        description: "1. packages/core define types\n2. packages/drivers add loader\n3. packages/web add panel",
      }),
    });
    expect(previewRes.status).toBe(200);
    const { plan } = (await previewRes.json()) as {
      plan: { subtasks: Array<{ key: string; allowedPaths: string[] }> };
    };
    expect(plan.subtasks.length).toBeGreaterThanOrEqual(3);

    // 2. Dispatch Epic DAG (opt-in per_subtask delivery for individual subtask delivery test)
    const createEpicRes = await app.request("/api/epics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoId: "repo_v03",
        title: "Add plugin architecture",
        description: "1. packages/core define types\n2. packages/drivers add loader\n3. packages/web add panel",
        epicDeliveryMode: "per_subtask",
        preferredEngine: "mock",
        subtasks: plan.subtasks,
      }),
    });
    expect(createEpicRes.status).toBe(201);
    const { epic, subtasks } = (await createEpicRes.json()) as {
      epic: { id: string; isEpic?: boolean };
      subtasks: Array<{ id: string; parentTicketId?: string }>;
    };
    expect(epic.isEpic).toBe(true);
    expect(subtasks.every((s) => s.parentTicketId === epic.id)).toBe(true);

    await kernel.runUntilIdle();
    const epicAfter = await stateStore.getTicket(epic.id);
    expect(epicAfter?.status).toBe("delivered");

    // 3. Deliver one completed subtask locally and verify Spill diff fallback keeps Diff intact
    const targetSub = subtasks[0]!;
    const deliverRes = await app.request(`/api/tickets/${targetSub.id}/deliver`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "local_merge" }),
    });
    expect(deliverRes.status).toBe(200);
    const deliveredJson = (await deliverRes.json()) as {
      entry: { action: string; status: string; resultPayload?: { mode?: string } };
    };
    expect(deliveredJson.entry.action).toBe("local_merge");
    expect(deliveredJson.entry.status).toBe("sent");
    expect(deliveredJson.entry.resultPayload?.mode).toBe("local_merged");

    const detailRes = await app.request(`/api/tickets/${targetSub.id}`);
    const detail = (await detailRes.json()) as { diff: string };
    expect(detail.diff.length).toBeGreaterThan(0);

    await kernel.stop();
    stateStore.close();
  });

  it("supports unified Epic staging delivery, repo quotas, /api/metrics, and expandMandate resolve", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v04-api-"));
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
      outboxExecutor: new GhOutboxExecutor(workspace),
    });
    const app = createServerApp({
      kernel,
      stateStore,
      artifactStore,
      llmProviderName: llm.providerName,
    });

    await app.request("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "repo_v04",
        name: "v04-demo",
        rootPath: repoDir,
        baseBranch: "main",
        mode: "auto",
        defaultTemplate: "fast",
        preferredImplementEngine: "mock",
        preferredReviewEngine: "mock",
        defaultDeliveryChannel: "local_merge",
        maxConcurrentWorkers: 2,
        dailyBudgetUsd: 10,
      }),
    });

    const createUnifiedRes = await app.request("/api/epics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoId: "repo_v04",
        title: "Unified Epic Feature",
        description: "1. packages/a build core\n2. packages/b build ui",
        preferredEngine: "mock",
      }),
    });
    expect(createUnifiedRes.status).toBe(201);
    const unifiedData = (await createUnifiedRes.json()) as {
      epic: { id: string; epicDeliveryMode?: string; branchName?: string };
      subtasks: Array<{ id: string }>;
    };
    expect(unifiedData.epic.epicDeliveryMode).toBe("unified");
    expect(unifiedData.epic.branchName).toBe(`super-work/epic/${unifiedData.epic.id}`);

    await kernel.runUntilIdle();

    const epicAfter = await stateStore.getTicket(unifiedData.epic.id);
    expect(epicAfter?.status).toBe("delivered");

    // Parent Epic outbox delivered the whole Epic via local_merge into repoDir main
    const epicOutbox = await stateStore.listOutboxEntries({ ticketId: unifiedData.epic.id });
    expect(epicOutbox).toHaveLength(1);
    expect(epicOutbox[0]!.action).toBe("local_merge");
    expect(epicOutbox[0]!.status).toBe("sent");

    // Metrics endpoint returns accurate summary
    const metricsRes = await app.request("/api/metrics?repoId=repo_v04");
    expect(metricsRes.status).toBe(200);
    const { metrics } = (await metricsRes.json()) as {
      metrics: { ticketCounts: { delivered: number }; deliveryRate: number; byEngine: unknown[] };
    };
    expect(metrics.ticketCounts.delivered).toBeGreaterThanOrEqual(2);
    expect(metrics.deliveryRate).toBe(1);
    expect(metrics.byEngine.length).toBeGreaterThanOrEqual(1);

    // PATCH repo quotas can update and clear values cleanly
    const patchRes = await app.request("/api/repos/repo_v04", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxConcurrentWorkers: null, dailyBudgetUsd: 25 }),
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as {
      repo: { maxConcurrentWorkers?: number; dailyBudgetUsd?: number };
    };
    expect(patched.repo.maxConcurrentWorkers).toBeUndefined();
    expect(patched.repo.dailyBudgetUsd).toBe(25);

    await kernel.stop();
    stateStore.close();
  });

  it("supports Playbook CRUD, super-work.json contract sync/export, ticket revert, notification test, filtered SSE, and SUPER_WORK_TOKEN auth", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v050-api-"));
    tempDirs.push(dir);
    const repoDir = await createTempGitRepo(dir);
    await writeFile(
      join(repoDir, "super-work.json"),
      JSON.stringify({
        version: 1,
        defaultTemplate: "fast",
        setupCommands: ["git status --short"],
        verificationCommands: ["git status --short"],
        conventions: "Keep modules clean.",
        playbook: [{ rule: "Shared contract rule for API", scopePaths: ["src/**"], pinned: true }],
      }),
      "utf8",
    );

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
      outboxExecutor: new GhOutboxExecutor(workspace),
    });

    const macosCalls: string[] = [];
    const dispatcher = new NotificationDispatcher(stateStore, {
      macosSender: async (title) => {
        macosCalls.push(title);
      },
    });
    const app = createServerApp({
      kernel,
      stateStore,
      artifactStore,
      llmProviderName: llm.providerName,
      notificationDispatcher: dispatcher,
      authToken: "secret-v050-token",
    });

    // 1. Auth gating: unauthenticated -> 401, Bearer -> 200
    const unauth = await app.request("/api/health");
    expect(unauth.status).toBe(401);
    const authHdr = { Authorization: "Bearer secret-v050-token" };
    const healthOk = await app.request("/api/health", { headers: authHdr });
    expect(healthOk.status).toBe(200);

    // 2. Register repo -> auto-syncs super-work.json
    const regRes = await app.request("/api/repos", {
      method: "POST",
      headers: { ...authHdr, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "repo_v050",
        name: "v050-api",
        rootPath: repoDir,
        baseBranch: "main",
        mode: "auto",
        defaultDeliveryChannel: "local_merge",
        preferredImplementEngine: "mock",
        preferredReviewEngine: "mock",
      }),
    });
    expect(regRes.status).toBe(201);
    const regJson = (await regRes.json()) as {
      repo: { defaultTemplate: string; setupCommands?: string[]; conventions?: string };
    };
    expect(regJson.repo.defaultTemplate).toBe("fast");
    expect(regJson.repo.setupCommands).toEqual(["git status --short"]);
    expect(regJson.repo.conventions).toBe("Keep modules clean.");

    // 3. Playbook CRUD & Contract Export
    const pbAdd = await app.request("/api/repos/repo_v050/playbook", {
      method: "POST",
      headers: { ...authHdr, "Content-Type": "application/json" },
      body: JSON.stringify({ rule: "Custom API human rule", scopePaths: ["src/**"], pinned: false }),
    });
    expect(pbAdd.status).toBe(201);
    const { entry: addedPb } = (await pbAdd.json()) as { entry: { id: string; enabled: boolean } };

    const pbPatch = await app.request(`/api/playbook/${addedPb.id}`, {
      method: "PATCH",
      headers: { ...authHdr, "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });
    expect(pbPatch.status).toBe(200);

    const pbList = await app.request("/api/repos/repo_v050/playbook", { headers: authHdr });
    const pbListJson = (await pbList.json()) as { entries: Array<{ id: string }> };
    expect(pbListJson.entries.length).toBeGreaterThanOrEqual(2);

    const exportRes = await app.request("/api/repos/repo_v050/contract/export", {
      method: "POST",
      headers: authHdr,
    });
    expect(exportRes.status).toBe(200);
    const contractFile = await readFile(join(repoDir, "super-work.json"), "utf8");
    expect(contractFile).toContain("Custom API human rule");

    const pbDel = await app.request(`/api/playbook/${addedPb.id}`, {
      method: "DELETE",
      headers: authHdr,
    });
    expect(pbDel.status).toBe(200);

    // 4. Test Notification endpoint
    const notifTest = await app.request("/api/notifications/test", {
      method: "POST",
      headers: { ...authHdr, "Content-Type": "application/json" },
      body: JSON.stringify({ notifications: { macosEnabled: true, webhookEnabled: false } }),
    });
    expect(notifTest.status).toBe(200);
    expect(macosCalls).toHaveLength(1);

    // 5. Filtered SSE & 1-Click Revert via HTTP
    const epicCreate = await app.request("/api/epics", {
      method: "POST",
      headers: { ...authHdr, "Content-Type": "application/json" },
      body: JSON.stringify({
        repoId: "repo_v050",
        title: "SSE Filter Epic",
        description: "1. packages/a part 1\n2. packages/b part 2",
        preferredEngine: "mock",
      }),
    });
    expect(epicCreate.status).toBe(201);
    const { epic, subtasks } = (await epicCreate.json()) as {
      epic: { id: string };
      subtasks: Array<{ id: string }>;
    };

    const unrelated = await kernel.createDirectTicket({
      repoId: "repo_v050",
      title: "Unrelated single task",
      description: "Scope docs/u.md",
      allowedPaths: ["docs/**"],
      preferredEngine: "mock",
    });

    // Open SSE filtered strictly to `epic.id` via ?token=...
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    try {
      const ac = new AbortController();
      const sseRes = await fetch(
        `http://127.0.0.1:${server.port}/api/events?ticketId=${epic.id}&token=secret-v050-token`,
        { signal: ac.signal },
      );
      expect(sseRes.status).toBe(200);
      const reader = sseRes.body!.getReader();
      let sseChunks = "";
      const pumpPromise = (async () => {
        const dec = new TextDecoder();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          sseChunks += dec.decode(value, { stream: true });
        }
      })().catch(() => {});

      await new Promise((r) => setTimeout(r, 40));
      await kernel.runUntilIdle();
      await new Promise((r) => setTimeout(r, 80));
      ac.abort("done");
      await pumpPromise;

      // Child subtask events streamed through parent Epic filter, while unrelated ticket was excluded
      expect(sseChunks).toContain(subtasks[0]!.id);
      expect(sseChunks).not.toContain(unrelated.id);
    } finally {
      server.stop(true);
    }

    // Revert the delivered Epic merge via REST
    const epicDone = await stateStore.getTicket(epic.id);
    expect(epicDone?.status).toBe("delivered");
    expect(epicDone?.mergedCommitSha).toBeTruthy();

    const revertRes = await app.request(`/api/tickets/${epic.id}/revert`, {
      method: "POST",
      headers: authHdr,
    });
    expect(revertRes.status).toBe(200);
    const revJson = (await revertRes.json()) as {
      ticket: { revertedAt?: string; revertCommitSha?: string };
      revertCommitSha: string;
    };
    expect(revJson.revertCommitSha).toBeTruthy();
    expect(revJson.ticket.revertedAt).toBeTruthy();

    await kernel.stop();
    stateStore.close();
  });
});
