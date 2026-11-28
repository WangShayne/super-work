import type { LiveEventCategory, LiveEventLogEntry, StageRun } from "../types.ts";

type Entry = Omit<LiveEventLogEntry, "id">;
type Rec = Record<string, unknown>;

const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const clip = (s: string, max: number): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Pull the most meaningful argument (command/path/pattern) out of a tool `inputSummary`. */
export function summarizeToolInput(inputSummary: string | undefined): string {
  const raw = (inputSummary ?? "").trim();
  if (!raw) return "";
  if (raw.startsWith("{")) {
    try {
      const obj = rec(JSON.parse(raw));
      const keys = ["command", "file_path", "path", "pattern", "url", "query", "description"];
      const v = keys.map((k) => str(obj[k])).find(Boolean) ?? Object.values(obj).find((x) => typeof x === "string" && x);
      if (v) return clip(String(v), 140);
    } catch { /* fall through to raw text */ }
  }
  return clip(raw, 140);
}

function make(
  ticketId: string,
  kind: string,
  timestamp: string,
  category: LiveEventCategory,
  headline: string,
  raw: unknown,
  extra: Partial<Entry> = {},
): Entry {
  const summary = extra.detail ? `${headline} — ${extra.detail}` : headline;
  return { ticketId, kind, timestamp, category, headline, summary, raw, ...extra };
}

function parseWorkerEvent(p: Rec, ticketId: string, ts: string, payload: unknown): Entry | null {
  const ev = rec(p.event);
  const type = str(ev.type);
  const engine = str(p.engine) || undefined;
  const kind = `${engine ?? "worker"}:${type}`;
  const at = str(ev.timestamp) || ts;
  const base = { engine };
  switch (type) {
    case "thought":
      return make(ticketId, kind, at, "thought", clip(str(ev.text), 200), payload, { ...base, badge: "thought" });
    case "tool_use": {
      const toolName = str(ev.toolName) || "tool";
      const arg = summarizeToolInput(str(ev.inputSummary));
      return make(ticketId, kind, at, "tool", arg ? `${toolName} · ${arg}` : toolName, payload, {
        ...base,
        toolName,
        badge: toolName,
      });
    }
    case "tool_result": {
      const toolName = str(ev.toolName) || "tool";
      const isError = ev.isError === true;
      const out = clip(str(ev.outputSummary), 160);
      return make(ticketId, kind, at, "tool", `${toolName} ${isError ? "failed" : "done"}`, payload, {
        ...base,
        toolName,
        isError,
        badge: toolName,
        detail: out || undefined,
      });
    }
    case "text":
      return make(ticketId, kind, at, "output", clip(str(ev.text), 200), payload, base);
    case "completed":
      return make(ticketId, kind, at, "output", clip(str(ev.summary) || "completed", 200), payload, base);
    case "error":
      return make(ticketId, kind, at, "alert", clip(str(ev.message) || "error", 200), payload, {
        ...base,
        isError: true,
      });
    default:
      return null; // session_started / usage / unknown: not human-meaningful
  }
}

/**
 * Convert a raw kernel SSE event into a readable live-log entry.
 * Returns null for state-sync-only events that should only trigger a refresh.
 */
export function parseKernelLiveEvent(eventName: string, payload: unknown): Entry | null {
  const p = rec(payload);
  const ts = str(p.timestamp) || new Date().toISOString();
  const tid = (o: unknown) => str(rec(o).ticketId);
  switch (eventName) {
    case "worker_event":
      return str(p.ticketId) ? parseWorkerEvent(p, str(p.ticketId), ts, payload) : null;
    case "stage_started": {
      const run = rec(p.stageRun);
      const stage = str(run.stage) || "stage";
      return make(str(p.ticketId), eventName, ts, "stage", `${stage} started`, payload, {
        badge: stage,
        engine: str(run.engine) || undefined,
        detail: str(run.engine) || undefined,
      });
    }
    case "stage_completed": {
      const run = rec(p.stageRun);
      const stage = str(run.stage) || "stage";
      const status = str(run.status) || "completed";
      return make(str(p.ticketId), eventName, ts, "stage", `${stage} ${status}`, payload, {
        badge: stage,
        isError: status === "failed" || status === "aborted",
        engine: str(run.engine) || undefined,
        detail: clip(str(run.summary), 160) || undefined,
      });
    }
    case "verification_completed": {
      const result = rec(p.result);
      const ok = result.ok === true;
      return make(str(p.ticketId), eventName, ts, "gate", ok ? "Verification passed" : "Verification failed", payload, {
        badge: "gate",
        isError: !ok,
        detail: clip(str(result.summary) || str(result.failedCommand), 160) || undefined,
      });
    }
    case "checkpoint_created": {
      const cp = rec(p.checkpoint);
      return make(str(cp.ticketId), eventName, ts, "gate", `Checkpoint · ${str(cp.label) || str(cp.stage)}`, payload, {
        badge: "checkpoint",
        detail: str(cp.commitSha).slice(0, 8) || undefined,
      });
    }
    case "watchdog_signal": {
      const s = rec(p.signal);
      return make(str(s.ticketId), eventName, ts, "alert", `Watchdog · ${str(s.kind)}`, payload, {
        badge: "watchdog",
        isError: true,
        engine: str(s.engine) || undefined,
        detail: clip(str(s.details), 160) || undefined,
      });
    }
    case "watchdog_decision": {
      const d = rec(p.decision);
      return make(str(p.ticketId), eventName, ts, "alert", `Watchdog decision · ${str(d.action)}`, payload, {
        badge: "watchdog",
        detail: clip(str(d.reason), 160) || undefined,
      });
    }
    case "inbox_created": {
      const item = rec(p.item);
      return make(tid(item), eventName, ts, "alert", `Needs attention · ${clip(str(item.title), 100)}`, payload, {
        badge: "inbox",
        detail: clip(str(item.summary), 160) || undefined,
      });
    }
    case "outbox_queued":
    case "outbox_sent":
    case "outbox_failed": {
      const entry = rec(p.entry);
      const failed = eventName === "outbox_failed";
      const state = eventName.replace("outbox_", "");
      return make(tid(entry), eventName, ts, failed ? "alert" : "gate", `Delivery ${state} · ${str(entry.action)}`, payload, {
        badge: "outbox",
        isError: failed,
        detail: failed ? clip(str(entry.lastError), 160) || undefined : undefined,
      });
    }
    default:
      return null;
  }
}

const dedupKey = (e: Pick<LiveEventLogEntry, "ticketId" | "kind" | "timestamp" | "summary">) =>
  `${e.ticketId}|${e.kind}|${e.timestamp}|${e.summary}`;

/** Append with replay de-duplication plus per-ticket and global bounds. */
export function appendBoundedTicketEvent(
  prev: readonly LiveEventLogEntry[],
  entry: LiveEventLogEntry,
  perTicketMax = 80,
  totalMax = 600,
): LiveEventLogEntry[] {
  const key = dedupKey(entry);
  if (prev.some((e) => dedupKey(e) === key)) return prev as LiveEventLogEntry[];
  const next = [...prev, entry];
  let excess = next.filter((e) => e.ticketId === entry.ticketId).length - perTicketMax;
  const trimmed = excess > 0 ? next.filter((e) => e.ticketId !== entry.ticketId || excess-- <= 0) : next;
  return trimmed.slice(-totalMax);
}

/** Build a readable timeline from persisted stage runs (history / after daemon restart). */
export function synthesizeStageRunActivities(
  ticketId: string,
  stageRuns: readonly StageRun[],
): LiveEventLogEntry[] {
  const out: LiveEventLogEntry[] = [];
  const sorted = [...stageRuns].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  for (const run of sorted) {
    const mk = (suffix: string, e: Entry): LiveEventLogEntry => ({ id: `synth_${run.id}_${suffix}`, ...e });
    out.push(
      mk("start", make(ticketId, "stage_started", run.startedAt, "stage", `${run.stage} started`, run, {
        badge: run.stage,
        engine: run.engine,
        detail: run.engine,
      })),
    );
    (run.spans ?? []).forEach((span, i) => {
      const gate = ["static_verify", "smoke_cdp", "visual_diff"].includes(span.kind);
      out.push(
        mk(`span${i}`, make(ticketId, `span:${span.kind}`, span.startedAt, gate ? "gate" : "tool", span.label, span, {
          badge: span.kind,
          isError: span.status === "failed",
          detail: span.detail ? clip(span.detail, 160) : undefined,
        })),
      );
    });
    if (run.completedAt) {
      out.push(
        mk("end", make(ticketId, "stage_completed", run.completedAt, "stage", `${run.stage} ${run.status}`, run, {
          badge: run.stage,
          engine: run.engine,
          isError: run.status === "failed" || run.status === "aborted",
          detail: run.summary ? clip(run.summary, 160) : undefined,
        })),
      );
    }
  }
  return out;
}

/** `00:42`, `12:05`, `1:02:03`; invalid / future input yields `00:00`. */
export function formatElapsedClock(sinceIso: string | undefined, nowMs: number): string {
  const start = sinceIso ? Date.parse(sinceIso) : Number.NaN;
  const sec = Number.isFinite(start) ? Math.max(0, Math.floor((nowMs - start) / 1000)) : 0;
  const [h, m, s] = [Math.floor(sec / 3600), Math.floor((sec % 3600) / 60), sec % 60];
  const p = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}
