import { useMemo, useState } from "react";
import { Check, CheckCircle2, X } from "lucide-react";
import { api } from "../api.ts";
import { HeroComposer } from "../components/HeroComposer.tsx";
import { NeedsYouCard, type ResolveHandler } from "../components/NeedsYouCard.tsx";
import { MissionRow } from "../components/MissionRow.tsx";
import { useI18n, type TranslationKey } from "../i18n.tsx";
import type {
  AutonomyPreset,
  InboxHumanAction,
  InboxItem,
  LiveEventLogEntry,
  RepoConfig,
  RequirementRouteKind,
  Ticket,
  WorkerEngineId,
} from "../types.ts";
import {
  HUMAN_ACTIONS,
  classifyInboxHumanAction,
  headlineState,
  humanTicketPhase,
  inferAutonomyPreset,
  selectMissions,
  type MissionFilter,
} from "../utils/superAgent.ts";

interface HomeViewProps {
  repo: RepoConfig | undefined;
  repos: RepoConfig[];
  selectedRepoId: string;
  onSelectRepo: (id: string) => void;
  onChangeAutonomyPreset: (repoId: string, preset: AutonomyPreset) => void;
  tickets: Ticket[];
  ticketsById: Map<string, Ticket>;
  inboxItems: InboxItem[];
  liveEvents: LiveEventLogEntry[];
  availableEngines: WorkerEngineId[];
  onResolve: ResolveHandler;
  onRefresh: () => void;
  onInspectTicket: (ticketId: string) => void;
  onOpenAddRepo: () => void;
  onComposerSubmitted: (route: RequirementRouteKind | "milestone") => Promise<void> | void;
}

export function HomeView({
  repo,
  repos,
  selectedRepoId,
  onSelectRepo,
  onChangeAutonomyPreset,
  tickets,
  ticketsById,
  inboxItems,
  liveEvents,
  availableEngines,
  onResolve,
  onRefresh,
  onInspectTicket,
  onOpenAddRepo,
  onComposerSubmitted,
}: HomeViewProps) {
  const { t } = useI18n();
  const [missionFilter, setMissionFilter] = useState<MissionFilter>("active");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchNotice, setBatchNotice] = useState("");

  const pending = useMemo(() => inboxItems.filter((i) => i.status === "pending"), [inboxItems]);
  const grouped = useMemo(() => {
    const map: Record<InboxHumanAction, InboxItem[]> = { approve: [], answer: [], unblock: [] };
    for (const item of pending) map[classifyInboxHumanAction(item.kind)].push(item);
    return map;
  }, [pending]);
  const pendingIds = new Set(pending.map((i) => i.id));
  const activeSelected = selectedIds.filter((id) => pendingIds.has(id));

  const liveWork = useMemo(() => selectMissions(tickets, missionFilter, Date.now()), [tickets, missionFilter]);
  const visibleCount = useMemo(() => selectMissions(tickets, "all", Date.now()).length, [tickets]);
  const workingCount = useMemo(
    () => tickets.filter((tk) => humanTicketPhase(tk.status) === "working").length,
    [tickets],
  );
  const headline = headlineState(pending.length, workingCount);
  const headlineText =
    headline === "decision"
      ? t("home.headline.decisions").replace("{n}", String(pending.length))
      : headline === "executing"
        ? t("home.headline.executing").replace("{n}", String(workingCount))
        : t("home.headline.idle");

  const lastEventByTicket = useMemo(() => {
    const map = new Map<string, LiveEventLogEntry>();
    for (const ev of liveEvents) map.set(ev.ticketId, ev);
    return map;
  }, [liveEvents]);

  const batchResolve = async (decision: "approved" | "rejected") => {
    if (activeSelected.length === 0) return;
    setBatchBusy(true);
    setBatchNotice("");
    try {
      const res = await api.batchResolveInbox({
        inboxIds: activeSelected,
        repoId: repo?.id,
        onlyLowRisk: false,
        decision,
      });
      setSelectedIds([]);
      setBatchNotice(`${res.resolvedCount} ok, ${res.skippedCount} skipped`);
      onRefresh();
    } catch (err) {
      setBatchNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBatchBusy(false);
    }
  };

  const toggle = (id: string) =>
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <div className="relative">
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(ellipse_at_top,rgba(99,102,241,0.14),rgba(139,92,246,0.05)_45%,transparent_70%)]"
    />
    <div className="relative max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12 space-y-8">
      <div className="text-center space-y-2">
        <h1
          className={`text-2xl sm:text-3xl font-semibold tracking-tight ${
            headline === "decision" ? "text-amber-200" : "text-zinc-100"
          }`}
        >
          {headlineText}
        </h1>
        {headline === "idle" && repo && (
          <p className="text-xs font-mono text-zinc-500">
            {repo.name} · {repo.baseBranch} · {t(`preset.${inferAutonomyPreset(repo)}` as TranslationKey)}
          </p>
        )}
      </div>

      <HeroComposer
        repo={repo}
        repos={repos}
        selectedRepoId={selectedRepoId}
        onSelectRepo={onSelectRepo}
        onChangeAutonomyPreset={onChangeAutonomyPreset}
        availableEngines={availableEngines}
        onSubmitted={onComposerSubmitted}
        onOpenAddRepo={onOpenAddRepo}
      />

      {pending.length > 0 && (
        <section className="space-y-4" aria-label={t("needs.title")}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-zinc-100">
              {t("needs.title")}{" "}
              <span className="ml-1 text-[11px] font-mono px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30">
                {pending.length}
              </span>
            </h2>
            <div className="flex items-center gap-2 text-[11px]">
              {batchNotice && <span className="font-mono text-emerald-300">{batchNotice}</span>}
              <button
                type="button"
                onClick={() => setSelectedIds(activeSelected.length === pending.length ? [] : pending.map((i) => i.id))}
                className="px-2.5 py-1 rounded-md border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 transition"
              >
                {t("inbox.batchSelectAll")}
              </button>
              <button
                type="button"
                disabled={batchBusy || activeSelected.length === 0}
                onClick={() => void batchResolve("rejected")}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-rose-500/30 bg-rose-500/10 text-rose-300 disabled:opacity-40 transition"
              >
                <X className="w-3 h-3" />
                {t("inbox.batchReject")}
              </button>
              <button
                type="button"
                disabled={batchBusy || activeSelected.length === 0}
                onClick={() => void batchResolve("approved")}
                className="inline-flex items-center gap-1 px-3 py-1 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40 transition"
              >
                <Check className="w-3 h-3" />
                {t("inbox.batchApprove")}
              </button>
            </div>
          </div>

          {HUMAN_ACTIONS.filter((verb) => grouped[verb].length > 0).map((verb) => (
            <div key={verb} className="space-y-2.5">
              <div className="flex items-center gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  {t(`needs.${verb}` as TranslationKey)}
                </h3>
                <span className="text-[10px] font-mono text-zinc-500">{grouped[verb].length}</span>
                <span className="text-[11px] text-zinc-600 truncate">{t(`needs.${verb}Hint` as TranslationKey)}</span>
              </div>
              {grouped[verb].map((item) => (
                <NeedsYouCard
                  key={item.id}
                  item={item}
                  ticket={ticketsById.get(item.ticketId)}
                  selected={activeSelected.includes(item.id)}
                  onToggleSelect={() => toggle(item.id)}
                  onResolve={onResolve}
                  onInspectTicket={onInspectTicket}
                />
              ))}
            </div>
          ))}
        </section>
      )}

      <section className="space-y-3" aria-label={t("live.title")}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-zinc-100">{t("live.title")}</h2>
          <div className="inline-flex rounded-full border border-zinc-800/80 bg-zinc-900/80 p-0.5 text-[11px]">
            {(["active", "all"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={missionFilter === mode}
                onClick={() => setMissionFilter(mode)}
                className={`px-3 py-1 rounded-full font-medium transition ${
                  missionFilter === mode ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {mode === "active"
                  ? t("live.filter.active")
                  : t("live.filter.all").replace("{n}", String(visibleCount))}
              </button>
            ))}
          </div>
        </div>
        {liveWork.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 p-8 text-center">
            <CheckCircle2 className="w-8 h-8 text-emerald-400/70 mx-auto mb-2" aria-hidden="true" />
            <p className="text-sm text-zinc-300">{t("live.emptyTitle")}</p>
            <p className="text-xs text-zinc-500 mt-1">{t("live.emptyDesc")}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {liveWork.map((tk) => (
              <MissionRow key={tk.id} ticket={tk} lastEvent={lastEventByTicket.get(tk.id)} onInspect={onInspectTicket} />
            ))}
          </div>
        )}
      </section>
    </div>
    </div>
  );
}
