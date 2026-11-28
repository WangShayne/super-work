import type { InboxItemKind, InboxItemStatus, OutboxStatus } from "@super-work/core";
import type { ServerRouteContext } from "./context.ts";

export function registerInboxOutboxRoutes(ctx: ServerRouteContext): void {
  const { app, kernel, stateStore } = ctx;

  // --- Attention Inbox ---
  app.get("/api/inbox", async (c) => {
    const repoId = c.req.query("repoId") || undefined;
    const status = (c.req.query("status") as InboxItemStatus | undefined) || undefined;
    const items = await stateStore.listInboxItems({ repoId, status });
    return c.json({ items });
  });

  app.post("/api/inbox/:id/resolve", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json()) as {
      decision?: "approved" | "rejected";
      note?: string;
      deliveryAction?: "local_merge" | "push_and_create_pr";
      expandMandate?: boolean;
      budgetIncreaseUsd?: number;
      saveToPlaybook?: boolean;
      arenaWinnerId?: string;
      selectedOption?: string;
      milestoneRelease?: {
        bumpVersion?: boolean;
        createTag?: boolean;
        pushRemote?: boolean;
        squashReleaseCommit?: boolean;
        releaseCommitMessage?: string;
        createGithubRelease?: boolean;
      };
    };
    if (body.decision !== "approved" && body.decision !== "rejected") {
      return c.json({ error: "decision must be 'approved' or 'rejected'" }, 400);
    }
    const result = await kernel.resolveInboxItem(id, body.decision, body.note, {
      milestoneRelease: body.milestoneRelease,
      deliveryAction: body.deliveryAction,
      expandMandate: body.expandMandate,
      budgetIncreaseUsd: body.budgetIncreaseUsd,
      saveToPlaybook: body.saveToPlaybook,
      arenaWinnerId: body.arenaWinnerId,
      selectedOption: body.selectedOption,
    });
    void kernel.tick();
    void kernel.flushOutbox();
    return c.json(result);
  });

  app.post("/api/inbox/batch-resolve", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      inboxIds?: string[];
      repoId?: string;
      kinds?: InboxItemKind[];
      onlyLowRisk?: boolean;
      decision?: "approved" | "rejected";
      note?: string;
      deliveryAction?: "local_merge" | "push_and_create_pr";
    };
    if (body.decision !== "approved" && body.decision !== "rejected") {
      return c.json({ error: "decision must be 'approved' or 'rejected'" }, 400);
    }
    const result = await kernel.batchResolveInbox({
      inboxIds: Array.isArray(body.inboxIds) ? body.inboxIds.map(String) : undefined,
      repoId: body.repoId?.trim() || undefined,
      kinds: Array.isArray(body.kinds) ? body.kinds : undefined,
      onlyLowRisk: Boolean(body.onlyLowRisk),
      decision: body.decision,
      note: body.note?.trim() || undefined,
      deliveryAction: body.deliveryAction,
    });
    void kernel.tick();
    void kernel.flushOutbox();
    return c.json(result);
  });

  // --- Transactional Outbox & Speculative Merge Train (v1.2.0 Pillar B) ---
  app.get("/api/outbox", async (c) => {
    const repoId = c.req.query("repoId") || undefined;
    const ticketId = c.req.query("ticketId") || undefined;
    const status = (c.req.query("status") as OutboxStatus | undefined) || undefined;
    const entries = await stateStore.listOutboxEntries({ repoId, ticketId, status });
    return c.json({ entries });
  });

  app.get("/api/merge-train", async (c) => {
    const repoId = c.req.query("repoId") || undefined;
    const entries = await kernel.listMergeTrain(repoId);
    return c.json({ entries });
  });

  app.post("/api/merge-train/flush", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { repoId?: string };
    try {
      const mergedCount = await kernel.flushMergeTrain(body.repoId?.trim() || undefined);
      return c.json({ mergedCount });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/merge-train/:id/eject", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    try {
      const entry = await kernel.ejectMergeTrainEntry(id, body.reason?.trim() || undefined);
      return c.json({ entry });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.includes("not found") ? 404 : 400);
    }
  });
}
