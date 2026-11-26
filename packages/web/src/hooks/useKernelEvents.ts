import { useEffect, useState } from "react";
import { getAuthToken } from "../api.ts";
import type { LiveEventLogEntry } from "../types.ts";

const REFRESH_EVENTS = [
  "repo_updated",
  "playbook_updated",
  "routine_updated",
  "routine_run_updated",
  "casebook_updated",
  "epic_replanned",
  "preview_updated",
  "checkpoint_created",
  "ticket_created",
  "ticket_updated",
  "stage_started",
  "stage_completed",
  "thread_routed",
  "watchdog_signal",
  "watchdog_decision",
  "inbox_created",
  "inbox_resolved",
  "outbox_queued",
  "outbox_sent",
  "outbox_failed",
  "worktrees_gc",
  "verification_completed",
  "review_comment_updated",
  "eval_run_updated",
  "campaign_updated",
  "milestone_updated",
  "merge_train_updated",
  "lifecycle_hook_executed",
  "self_reload_updated",
];

type Nested = { id?: string; ticketId?: string } | undefined;

/** Subscribes to the Kernel SSE bus; triggers `onRefresh` on every domain event. */
export function useKernelEvents(onRefresh: () => void): {
  sseConnected: boolean;
  liveEvents: LiveEventLogEntry[];
} {
  const [sseConnected, setSseConnected] = useState(false);
  const [liveEvents, setLiveEvents] = useState<LiveEventLogEntry[]>([]);

  useEffect(() => {
    const token = getAuthToken();
    const es = new EventSource(token ? `/api/events?token=${encodeURIComponent(token)}` : "/api/events");
    es.onopen = () => setSseConnected(true);
    es.onerror = () => setSseConnected(false);

    const pushLog = (ticketId: string, kind: string, summary: string, raw: unknown) => {
      setLiveEvents((prev) => [
        ...prev.slice(-199),
        {
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          ticketId,
          kind,
          summary,
          timestamp: new Date().toISOString(),
          raw,
        },
      ]);
    };

    for (const name of REFRESH_EVENTS) {
      es.addEventListener(name, (e: MessageEvent) => {
        try {
          const parsed = JSON.parse(e.data) as Record<string, unknown>;
          const tId =
            (parsed.ticketId as string | undefined) ||
            (parsed.ticket as Nested)?.id ||
            (parsed.checkpoint as Nested)?.ticketId ||
            (parsed.item as Nested)?.ticketId ||
            (parsed.entry as Nested)?.ticketId ||
            (parsed.signal as Nested)?.ticketId;
          if (tId) pushLog(tId, name, JSON.stringify(parsed).slice(0, 180), parsed);
        } catch {
          // Ignore parse errors
        }
        onRefresh();
      });
    }

    es.addEventListener("worker_event", (e: MessageEvent) => {
      try {
        const parsed = JSON.parse(e.data) as {
          ticketId: string;
          engine: string;
          event: { type: string; text?: string; toolName?: string; inputSummary?: string; summary?: string; message?: string };
        };
        const ev = parsed.event;
        const msg =
          ev.text || ev.summary || ev.message || (ev.toolName ? `${ev.toolName}: ${ev.inputSummary ?? ""}` : ev.type);
        pushLog(parsed.ticketId, `${parsed.engine}:${ev.type}`, msg, parsed);
      } catch {
        // Ignore
      }
    });

    return () => es.close();
  }, [onRefresh]);

  return { sseConnected, liveEvents };
}
