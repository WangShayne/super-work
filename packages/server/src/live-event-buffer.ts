import type { KernelEvent } from "@super-work/core";

/** Human-meaningful execution events replayed to freshly connected SSE clients. */
const BUFFERED_TYPES: ReadonlySet<string> = new Set([
  "stage_started",
  "worker_event",
  "stage_completed",
  "verification_completed",
  "checkpoint_created",
  "watchdog_signal",
  "watchdog_decision",
  "inbox_created",
  "outbox_queued",
  "outbox_sent",
  "outbox_failed",
]);

const NOISY_WORKER_EVENTS: ReadonlySet<string> = new Set(["usage", "session_started"]);

export const LIVE_BUFFER_PER_TICKET = 60;
export const LIVE_BUFFER_MAX_TICKETS = 40;

interface BufferedEvent {
  seq: number;
  event: KernelEvent;
}

function bufferTicketId(event: KernelEvent): string | undefined {
  switch (event.type) {
    case "stage_started":
    case "worker_event":
    case "stage_completed":
    case "verification_completed":
    case "watchdog_decision":
      return event.ticketId;
    case "watchdog_signal":
      return event.signal.ticketId;
    case "checkpoint_created":
      return event.checkpoint.ticketId;
    case "inbox_created":
      return event.item.ticketId;
    case "outbox_queued":
    case "outbox_sent":
    case "outbox_failed":
      return event.entry.ticketId;
    default:
      return undefined;
  }
}

export interface LiveEventBuffer {
  push(event: KernelEvent): void;
  /** Buffered events across tickets in original emission order. */
  replay(): KernelEvent[];
}

/** Per-ticket ring buffer with LRU eviction across tickets. */
export function createLiveEventBuffer(
  perTicket = LIVE_BUFFER_PER_TICKET,
  maxTickets = LIVE_BUFFER_MAX_TICKETS,
): LiveEventBuffer {
  const byTicket = new Map<string, BufferedEvent[]>();
  let seq = 0;

  return {
    push(event) {
      if (!BUFFERED_TYPES.has(event.type)) return;
      if (event.type === "worker_event" && NOISY_WORKER_EVENTS.has(event.event.type)) return;
      const ticketId = bufferTicketId(event);
      if (!ticketId) return;

      const list = byTicket.get(ticketId) ?? [];
      list.push({ seq: seq++, event });
      if (list.length > perTicket) list.splice(0, list.length - perTicket);
      // Re-insert so the most recently active ticket is last (LRU).
      byTicket.delete(ticketId);
      byTicket.set(ticketId, list);
      while (byTicket.size > maxTickets) {
        const oldest = byTicket.keys().next().value;
        if (oldest === undefined) break;
        byTicket.delete(oldest);
      }
    },
    replay() {
      const all: BufferedEvent[] = [];
      for (const list of byTicket.values()) all.push(...list);
      all.sort((a, b) => a.seq - b.seq);
      return all.map((b) => b.event);
    },
  };
}
