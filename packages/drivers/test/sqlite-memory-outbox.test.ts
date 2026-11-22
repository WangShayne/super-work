import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { createDefaultMandate, getFirstStage, newId, nowIso, type Ticket } from "@super-work/core";
import { FsArtifactStore, SqliteStateStore, tokenizeFtsQuery } from "../src/index.ts";

describe("SqliteStateStore & FsArtifactStore", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sanitizes FTS5 queries with punctuation and CJK characters", () => {
    expect(tokenizeFtsQuery("fix: auth/login-bug (URGENT!)")).toBe('"fix" OR "auth" OR "login" OR "bug" OR "URGENT"');
    expect(tokenizeFtsQuery("修复登录超时问题")).toBe('"修复登录超时问题"');
    expect(tokenizeFtsQuery("--- /// !!")).toBeNull();
  });

  it("persists Chain of Recall, FTS5 search, Spill artifacts, and transactional Outbox claims", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-store-"));
    tempDirs.push(dir);

    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const ts = nowIso();

    const repo = {
      id: "repo_1",
      name: "demo",
      rootPath: dir,
      baseBranch: "main",
      mode: "auto" as const,
      defaultTemplate: "standard" as const,
      preferredImplementEngine: "mock" as const,
      preferredReviewEngine: "mock" as const,
      createdAt: ts,
      updatedAt: ts,
    };
    await store.upsertRepo(repo);

    const trigger = {
      id: newId("trg"),
      repoId: repo.id,
      source: "github_issue" as const,
      externalRef: "gh:issue:42",
      threadKey: "github:issue:42",
      title: "Fix OAuth token refresh race condition",
      payload: { number: 42 },
      rawText: "Refresh token races when concurrent requests hit /api/auth",
      createdAt: ts,
    };
    await store.saveTrigger(trigger);

    const thread = {
      id: newId("thr"),
      repoId: repo.id,
      threadKey: trigger.threadKey,
      metadata: {},
      createdAt: ts,
      updatedAt: ts,
    };
    await store.upsertThread(thread);

    const ticket: Ticket = {
      id: newId("tkt"),
      repoId: repo.id,
      threadId: thread.id,
      sourceTriggerId: trigger.id,
      title: trigger.title,
      description: trigger.rawText,
      status: "queued",
      template: "standard",
      currentStage: getFirstStage("standard"),
      stageRetries: 0,
      mandate: createDefaultMandate({ allowedPaths: ["src/auth/**"] }),
      dependsOn: [],
      nativeSessions: {},
      inlineMemory: {
        goal: trigger.rawText,
        acceptanceCriteria: ["Add mutex around token refresh"],
        stageNotes: [],
        threadUpdates: [],
      },
      costUsd: 0,
      priority: 1,
      createdAt: ts,
      updatedAt: ts,
    };
    await store.saveTicket(ticket);
    await store.upsertThread({ ...thread, subscribedTicketId: ticket.id, updatedAt: ts });

    const spill = await artifacts.writeSpill(
      { ticketId: ticket.id, kind: "transcript", summary: "OAuth trace", ext: "jsonl" },
      '{"type":"thought","text":"Inspecting refresh mutex"}\n',
    );
    await store.saveArtifact(spill, "OAuth token refresh mutex trace");

    await store.indexMemoryDocument({
      entityType: "ticket",
      entityId: ticket.id,
      ticketId: ticket.id,
      repoId: repo.id,
      title: ticket.title,
      body: ticket.description,
    });

    // FTS5 query with tricky punctuation should succeed without throwing
    const hits = await store.searchMemory("OAuth: token-refresh /api/auth!", 5, repo.id);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.ticketId).toBe(ticket.id);

    const chain = await store.recallChain(ticket.id);
    expect(chain).not.toBeNull();
    expect(chain!.trigger?.id).toBe(trigger.id);
    expect(chain!.artifacts.length).toBe(1);
    expect(await artifacts.readSpill(chain!.artifacts[0]!.storageUri)).toContain("Inspecting refresh mutex");

    // Transactional Outbox idempotency & atomic claim
    const obx1 = {
      id: newId("obx"),
      repoId: repo.id,
      ticketId: ticket.id,
      action: "push_and_create_pr" as const,
      idempotencyKey: `deliver:${ticket.id}`,
      payload: { branchName: "super-work/tkt" },
      status: "pending" as const,
      attempts: 0,
      nextAttemptAt: ts,
      createdAt: ts,
      updatedAt: ts,
    };
    await store.enqueueOutbox(obx1);
    await store.enqueueOutbox({ ...obx1, id: newId("obx") }); // Duplicate idempotencyKey ignored

    const allOutbox = await store.listOutboxEntries({ ticketId: ticket.id });
    expect(allOutbox.length).toBe(1);

    const claimed1 = await store.claimNextOutboxEntries(5, new Date(Date.now() + 1000).toISOString());
    expect(claimed1.length).toBe(1);
    expect(claimed1[0]!.status).toBe("processing");

    // Second concurrent claim sees zero pending rows
    const claimed2 = await store.claimNextOutboxEntries(5, new Date(Date.now() + 1000).toISOString());
    expect(claimed2.length).toBe(0);

    store.close();
  });
});
