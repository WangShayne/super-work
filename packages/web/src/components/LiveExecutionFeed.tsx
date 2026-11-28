import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Brain,
  ChevronRight,
  Layers,
  ShieldCheck,
  Terminal,
  Timer,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useNowTick } from "../hooks/useNowTick.ts";
import { useI18n, type TranslationKey } from "../i18n.tsx";
import type { LiveEventCategory, LiveEventLogEntry, StageRun, Ticket } from "../types.ts";
import { formatElapsedClock, synthesizeStageRunActivities } from "../utils/liveStream.ts";
import { humanTicketPhase } from "../utils/superAgent.ts";

const CATEGORY_UI: Record<LiveEventCategory, { icon: LucideIcon; badge: string; text: string }> = {
  thought: { icon: Brain, badge: "bg-violet-500/15 text-violet-300 border-violet-500/30", text: "text-zinc-300" },
  tool: { icon: Wrench, badge: "bg-sky-500/15 text-sky-300 border-sky-500/30", text: "text-zinc-100" },
  gate: { icon: ShieldCheck, badge: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30", text: "text-zinc-100" },
  stage: { icon: Layers, badge: "bg-indigo-500/15 text-indigo-300 border-indigo-500/30", text: "text-zinc-100" },
  output: { icon: Terminal, badge: "bg-zinc-700/40 text-zinc-300 border-zinc-600/50", text: "text-zinc-300" },
  alert: { icon: AlertTriangle, badge: "bg-amber-500/15 text-amber-300 border-amber-500/30", text: "text-amber-100" },
};

type FeedFilter = "all" | "tool" | "thought" | "stage";

const FILTERS: { id: FeedFilter; key: TranslationKey; match: (c: LiveEventCategory) => boolean }[] = [
  { id: "all", key: "live.feed.filterAll", match: () => true },
  { id: "tool", key: "live.feed.filterTool", match: (c) => c === "tool" },
  { id: "thought", key: "live.feed.filterThought", match: (c) => c === "thought" },
  { id: "stage", key: "live.feed.filterGate", match: (c) => c === "stage" || c === "gate" || c === "alert" },
];

export function FeedRow({ ev, showTime }: { ev: LiveEventLogEntry; showTime?: boolean }) {
  const { t } = useI18n();
  const cat = ev.category ?? "output";
  const ui = CATEGORY_UI[cat];
  const Icon = ui.icon;
  return (
    <li className="flex items-start gap-2 min-w-0">
      {showTime && (
        <span className="shrink-0 font-mono text-[10px] text-zinc-600 tabular-nums pt-0.5">
          {ev.timestamp.slice(11, 19)}
        </span>
      )}
      <span
        className={`shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium ${ui.badge}`}
      >
        <Icon className="w-3 h-3" aria-hidden="true" />
        {t(`live.cat.${cat}` as TranslationKey)}
      </span>
      <span className="min-w-0 flex-1 text-[11px] leading-relaxed">
        <span className={`break-words ${ev.isError ? "text-rose-300" : ui.text}`}>{ev.headline ?? ev.summary}</span>
        {ev.detail && <span className="block text-zinc-500 break-words">{ev.detail}</span>}
      </span>
    </li>
  );
}

interface LiveExecutionFeedProps {
  mode: "compact" | "full";
  events: LiveEventLogEntry[];
  ticket?: Ticket;
  stageRuns?: readonly StageRun[];
  sseConnected: boolean;
  onOpenDrawer?: () => void;
}

export function LiveExecutionFeed({
  mode,
  events,
  ticket,
  stageRuns,
  sseConnected,
  onOpenDrawer,
}: LiveExecutionFeedProps) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<FeedFilter>("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const full = mode === "full";
  const phase = ticket ? humanTicketPhase(ticket.status) : undefined;
  const working = phase === "working";
  // Offline only when SSE is down; otherwise phase decides. Pulsing dot only while working.
  const statusBadge: { key: TranslationKey; text: string; dot: string } = !sseConnected
    ? { key: "live.feed.sseOffline", text: "text-amber-400", dot: "bg-amber-400" }
    : phase === "attention"
      ? { key: "live.feed.awaitingHuman", text: "text-amber-400", dot: "bg-amber-400" }
      : phase === "done" || phase === "failed"
        ? { key: "live.feed.finished", text: "text-zinc-500", dot: "bg-zinc-500" }
        : {
            key: "live.feed.sseLive",
            text: "text-emerald-400",
            dot: working ? "bg-emerald-400 motion-safe:animate-pulse" : "bg-emerald-400",
          };
  const now = useNowTick(full && working);

  const synthesized = events.length === 0 && (stageRuns?.length ?? 0) > 0;
  const source = useMemo(
    () => (synthesized && ticket ? synthesizeStageRunActivities(ticket.id, stageRuns ?? []) : events),
    [synthesized, ticket, stageRuns, events],
  );
  const items = useMemo(() => {
    if (!full) return source.slice(-6);
    const active = FILTERS.find((f) => f.id === filter) ?? FILTERS[0]!;
    return source.filter((e) => active.match(e.category ?? "output"));
  }, [source, filter, full]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && (autoScroll || !full)) el.scrollTop = el.scrollHeight;
  }, [items.length, autoScroll, full]);

  const since =
    stageRuns?.find((r) => r.status === "running")?.startedAt ?? source[0]?.timestamp ?? ticket?.updatedAt;

  return (
    <section
      aria-label={t("live.feed.title")}
      className="rounded-lg border border-zinc-800 bg-zinc-950/60 min-w-0"
    >
      {full && (
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 border-b border-zinc-800/80">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
            {t("live.feed.title")}
          </h3>
          <span className={`inline-flex items-center gap-1.5 text-[10px] ${statusBadge.text}`}>
            <span
              aria-hidden="true"
              className={`w-1.5 h-1.5 rounded-full ${statusBadge.dot}`}
            />
            {t(statusBadge.key)}
          </span>
          {working && (
            <span className="inline-flex items-center gap-1 font-mono tabular-nums text-[10px] text-indigo-300">
              <Timer className="w-3 h-3" aria-hidden="true" />
              {formatElapsedClock(since, now)}
            </span>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <div role="group" aria-label={t("live.feed.title")} className="inline-flex gap-1">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={filter === f.id}
                  onClick={() => setFilter(f.id)}
                  className={`px-2 py-0.5 rounded-full text-[10px] border transition ${
                    filter === f.id
                      ? "border-indigo-500/40 bg-indigo-500/15 text-indigo-200"
                      : "border-zinc-800 text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  {t(f.key)}
                </button>
              ))}
            </div>
            <label className="inline-flex items-center gap-1 text-[10px] text-zinc-400 cursor-pointer">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
                className="rounded border-zinc-700 bg-zinc-950 text-indigo-500"
              />
              {t("live.feed.autoScroll")}
            </label>
          </div>
        </header>
      )}
      <div
        ref={scrollRef}
        className={`px-3 py-2 overflow-y-auto overflow-x-hidden ${full ? "max-h-96" : "max-h-48"}`}
      >
        {items.length === 0 ? (
          <p className="text-[11px] text-zinc-600">{t("live.feed.empty")}</p>
        ) : (
          <ul className="space-y-1.5">
            {items.map((ev) => (
              <FeedRow key={ev.id} ev={ev} showTime={full} />
            ))}
          </ul>
        )}
      </div>
      {full && synthesized && (
        <p className="px-3 pb-2 text-[10px] text-zinc-600">{t("live.feed.history")}</p>
      )}
      {!full && onOpenDrawer && (
        <footer className="border-t border-zinc-800/80 px-3 py-1.5">
          <button
            type="button"
            onClick={onOpenDrawer}
            className="inline-flex items-center gap-1 text-[11px] text-indigo-300 hover:text-indigo-200 transition"
          >
            {t("live.feed.openDrawer")}
            <ChevronRight className="w-3 h-3" aria-hidden="true" />
          </button>
        </footer>
      )}
    </section>
  );
}
