import type { OutboxExecutor, StateStore } from "./ports.ts";
import type { KernelEvent, OutboxEntry } from "./types.ts";
import { newId, nowIso } from "./utils.ts";

export class OutboxProcessor {
  constructor(
    private readonly stateStore: StateStore,
    private readonly executor: OutboxExecutor,
    private readonly emit: (event: KernelEvent) => void,
    private readonly maxAttempts = 5,
  ) {}

  async processDueEntries(limit = 5): Promise<number> {
    const claimed = await this.stateStore.claimNextOutboxEntries(limit, nowIso());
    let processed = 0;

    for (const entry of claimed) {
      processed += 1;
      await this.processSingle(entry);
    }

    return processed;
  }

  private async processSingle(entry: OutboxEntry): Promise<void> {
    const repo = await this.stateStore.getRepo(entry.repoId);
    const ticket = await this.stateStore.getTicket(entry.ticketId);
    if (!repo || !ticket) {
      const failed: OutboxEntry = {
        ...entry,
        status: "failed",
        lastError: "Missing repo or ticket record",
        updatedAt: nowIso(),
      };
      await this.stateStore.updateOutboxEntry(failed);
      this.emit({ type: "outbox_failed", entry: failed, timestamp: nowIso() });
      return;
    }

    try {
      const resultPayload = await this.executor.execute(entry, repo, ticket);
      const sent: OutboxEntry = {
        ...entry,
        status: "sent",
        resultPayload,
        lastError: undefined,
        updatedAt: nowIso(),
      };
      await this.stateStore.updateOutboxEntry(sent);
      this.emit({ type: "outbox_sent", entry: sent, timestamp: sent.updatedAt });

      if (ticket.status === "outbox_pending") {
        const updatedTicket = {
          ...ticket,
          status: "delivered" as const,
          updatedAt: nowIso(),
        };
        await this.stateStore.saveTicket(updatedTicket);
        this.emit({ type: "ticket_updated", ticket: updatedTicket, timestamp: updatedTicket.updatedAt });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const nextAttempts = entry.attempts + 1;
      const exhausted = nextAttempts >= this.maxAttempts;
      const backoffMs = Math.min(60_000, 1_000 * 2 ** nextAttempts);
      const nextAttemptAt = new Date(Date.now() + backoffMs).toISOString();

      const updated: OutboxEntry = {
        ...entry,
        status: exhausted ? "failed" : "pending",
        attempts: nextAttempts,
        nextAttemptAt,
        lastError: message,
        updatedAt: nowIso(),
      };
      await this.stateStore.updateOutboxEntry(updated);
      this.emit({ type: "outbox_failed", entry: updated, timestamp: updated.updatedAt });

      if (exhausted) {
        const updatedTicket = {
          ...ticket,
          status: "needs_human" as const,
          errorMessage: `Outbox delivery failed after ${nextAttempts} attempts: ${message}`,
          updatedAt: nowIso(),
        };
        await this.stateStore.saveTicket(updatedTicket);
        this.emit({ type: "ticket_updated", ticket: updatedTicket, timestamp: updatedTicket.updatedAt });

        const inboxItem = {
          id: newId("inb"),
          repoId: repo.id,
          ticketId: ticket.id,
          kind: "watchdog_escalation" as const,
          status: "pending" as const,
          title: `Outbox delivery failed: ${ticket.title}`,
          summary: `Transactional Outbox failed (${entry.action}): ${message}`,
          contextPayload: { outboxId: entry.id, action: entry.action, lastError: message },
          createdAt: nowIso(),
        };
        await this.stateStore.saveInboxItem(inboxItem);
        this.emit({ type: "inbox_created", item: inboxItem, timestamp: inboxItem.createdAt });
      }
    }
  }
}
