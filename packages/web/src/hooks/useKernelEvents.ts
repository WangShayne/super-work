import { useEffect, useRef, useState } from "react";
import { getAuthToken } from "../api.ts";
import type { LiveEventLogEntry } from "../types.ts";
import { appendBoundedTicketEvent, parseKernelLiveEvent } from "../utils/liveStream.ts";

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

const REFRESH_DEBOUNCE_MS = 100;

/** Subscribes to the Kernel SSE bus; coalesces domain events into one debounced `onRefresh`. */
export function useKernelEvents(onRefresh: () => void): {
  sseConnected: boolean;
  liveEvents: LiveEventLogEntry[];
} {
  const [sseConnected, setSseConnected] = useState(false);
  const [liveEvents, setLiveEvents] = useState<LiveEventLogEntry[]>([]);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  useEffect(() => {
    const token = getAuthToken();
    const es = new EventSource(token ? `/api/events?token=${encodeURIComponent(token)}` : "/api/events");
    es.onopen = () => setSseConnected(true);
    es.onerror = () => setSseConnected(false);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRefresh = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        refreshRef.current();
      }, REFRESH_DEBOUNCE_MS);
    };

    const handle = (name: string, e: MessageEvent, refresh: boolean) => {
      try {
        const parsed: unknown = JSON.parse(e.data);
        const entry = parseKernelLiveEvent(name, parsed);
        if (entry?.ticketId) {
          const full: LiveEventLogEntry = {
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            ...entry,
          };
          setLiveEvents((prev) => appendBoundedTicketEvent(prev, full));
        }
      } catch {
        // Ignore malformed frames
      }
      if (refresh) scheduleRefresh();
    };

    for (const name of REFRESH_EVENTS) {
      es.addEventListener(name, (e: MessageEvent) => handle(name, e, true));
    }
    es.addEventListener("worker_event", (e: MessageEvent) => handle("worker_event", e, false));

    return () => {
      if (timer !== undefined) clearTimeout(timer);
      es.close();
    };
  }, []);

  return { sseConnected, liveEvents };
}
