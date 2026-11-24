import { useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Columns3,
  FileCode2,
  FolderGit2,
  GitFork,
  GitPullRequest,
  Layers,
  Lock,
  Pause,
  Search,
  Sparkles,
  Swords,
  X,
} from "lucide-react";
import { DagCanvas } from "../components/DagCanvas.tsx";
import { formatStage, formatTicketStatus, type TranslationKey, useI18n } from "../i18n.tsx";
import type { RepoConfig, Ticket, TicketStatus } from "../types.ts";

interface BoardViewProps {
  tickets: Ticket[];
  allTickets?: Ticket[];
  repos?: RepoConfig[];
  selectedRepoId?: string;
  availableEngines?: string[];
  onSelectTicket: (ticketId: string) => void;
  onRefresh?: () => void;
}

interface Swimlane {
  id: string;
  titleKey: TranslationKey;
  statuses: TicketStatus[];
  accent: string;
}

const SWIMLANES: Swimlane[] = [
  {
    id: "triage",
    titleKey: "board.lane.triage",
    statuses: ["triaging", "proposed"],
    accent: "border-t-indigo-500",
  },
  {
    id: "queued",
    titleKey: "board.lane.queued",
    statuses: ["queued", "waiting_deps", "planning", "spec_testing", "awaiting_plan_approval"],
    accent: "border-t-sky-500",
  },
  {
    id: "implementing",
    titleKey: "board.lane.implementing",
    statuses: ["implementing", "watchdog_intervention"],
    accent: "border-t-amber-500",
  },
  {
    id: "review",
    titleKey: "board.lane.review",
    statuses: ["reviewing", "rebasing", "outbox_pending"],
    accent: "border-t-purple-500",
  },
  {
    id: "done",
    titleKey: "board.lane.done",
    statuses: ["needs_human", "delivered", "failed", "cancelled"],
    accent: "border-t-emerald-500",
  },
];

function statusBadgeStyle(status: TicketStatus): string {
  switch (status) {
    case "delivered":
      return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
    case "needs_human":
    case "failed":
      return "bg-rose-500/15 text-rose-300 border-rose-500/30";
    case "implementing":
    case "planning":
    case "spec_testing":
    case "reviewing":
    case "rebasing":
      return "bg-amber-500/15 text-amber-300 border-amber-500/30";
    case "waiting_deps":
    case "proposed":
    case "awaiting_plan_approval":
      return "bg-indigo-500/15 text-indigo-300 border-indigo-500/30";
    default:
      return "bg-zinc-800 text-zinc-300 border-zinc-700";
  }
}

export function BoardView({
  tickets,
  allTickets,
  repos = [],
  selectedRepoId,
  availableEngines = [],
  onSelectTicket,
  onRefresh,
}: BoardViewProps) {
  const { locale, t } = useI18n();
  const [searchQuery, setSearchQuery] = useState("");
  const [hideSubtasks, setHideSubtasks] = useState(false);
  const [onlyCrossOrHandover, setOnlyCrossOrHandover] = useState(false);
  const [viewMode, setViewMode] = useState<"swimlane" | "dag">("swimlane");

  const childSource = allTickets ?? tickets;
  const reposById = useMemo(() => new Map(repos.map((r) => [r.id, r])), [repos]);
  const allTicketsById = useMemo(
    () => new Map(childSource.map((item) => [item.id, item])),
    [childSource],
  );

  const filteredTickets = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return tickets.filter((tkt) => {
      if (hideSubtasks && Boolean(tkt.parentTicketId)) return false;
      if (onlyCrossOrHandover) {
        const isCrossCard = Boolean(selectedRepoId && tkt.repoId !== selectedRepoId);
        const hasCrossDep = tkt.dependsOn.some((depId) => {
          const dep = allTicketsById.get(depId);
          return dep && dep.repoId !== tkt.repoId;
        });
        if (!tkt.handoverDigest && !isCrossCard && !hasCrossDep) return false;
      }
      if (!q) return true;
      const rName = reposById.get(tkt.repoId)?.name ?? "";
      return (
        tkt.title.toLowerCase().includes(q) ||
        tkt.id.toLowerCase().includes(q) ||
        rName.toLowerCase().includes(q) ||
        tkt.mandate.allowedPaths.some((p) => p.toLowerCase().includes(q))
      );
    });
  }, [tickets, searchQuery, hideSubtasks, onlyCrossOrHandover, selectedRepoId, allTicketsById, reposById]);

  return (
    <div className="p-5 space-y-4 overflow-x-auto">
      {/* Board Search & Filter Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-800/80 bg-zinc-900/40 px-3.5 py-2.5 text-xs">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("board.searchPlaceholder")}
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg pl-8 pr-7 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="absolute right-2 top-2 text-zinc-500 hover:text-zinc-200"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => {
              setHideSubtasks(false);
              setOnlyCrossOrHandover(false);
            }}
            className={`px-2.5 py-1 rounded-md border text-[11px] transition ${
              !hideSubtasks && !onlyCrossOrHandover
                ? "border-indigo-500/40 bg-indigo-500/15 text-indigo-200"
                : "border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {t("board.filterAll")} ({tickets.length})
          </button>
          <button
            type="button"
            onClick={() => setHideSubtasks((prev) => !prev)}
            className={`px-2.5 py-1 rounded-md border text-[11px] transition ${
              hideSubtasks
                ? "border-purple-500/40 bg-purple-500/15 text-purple-200"
                : "border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {t("board.filterHideSubtasks")}
          </button>
          <button
            type="button"
            onClick={() => setOnlyCrossOrHandover((prev) => !prev)}
            className={`px-2.5 py-1 rounded-md border text-[11px] transition ${
              onlyCrossOrHandover
                ? "border-teal-500/40 bg-teal-500/15 text-teal-200"
                : "border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {t("board.filterCrossRepo")}
          </button>

          <div className="inline-flex items-center rounded-md border border-zinc-800 bg-zinc-950 p-0.5 ml-1">
            <button
              type="button"
              onClick={() => setViewMode("swimlane")}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] transition ${
                viewMode === "swimlane"
                  ? "bg-indigo-500/20 text-indigo-200 border border-indigo-500/30"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <Columns3 className="w-3 h-3" />
              {t("board.viewSwimlane")}
            </button>
            <button
              type="button"
              onClick={() => setViewMode("dag")}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] transition ${
                viewMode === "dag"
                  ? "bg-indigo-500/20 text-indigo-200 border border-indigo-500/30"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <GitFork className="w-3 h-3" />
              {t("board.viewDag")}
            </button>
          </div>
        </div>
      </div>

      {viewMode === "dag" ? (
        <DagCanvas
          tickets={filteredTickets}
          repos={repos}
          availableEngines={availableEngines}
          onInspectTicket={onSelectTicket}
          onMutated={onRefresh}
        />
      ) : (
      <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-5 gap-4 min-w-[980px]">
        {SWIMLANES.map((lane) => {
          const laneTickets = filteredTickets.filter((tkt) => lane.statuses.includes(tkt.status));
          return (
            <div
              key={lane.id}
              className={`rounded-xl border border-zinc-800/80 border-t-2 ${lane.accent} bg-zinc-900/40 flex flex-col min-h-[70vh]`}
            >
              <div className="px-3.5 py-3 border-b border-zinc-800/60 flex items-center justify-between">
                <span className="text-xs font-semibold text-zinc-200">{t(lane.titleKey)}</span>
                <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                  {laneTickets.length}
                </span>
              </div>

              <div className="p-2.5 space-y-2.5 flex-1">
                {laneTickets.length === 0 ? (
                  <div className="text-[11px] text-zinc-600 text-center py-8">{t("board.empty")}</div>
                ) : (
                  laneTickets.map((tkt) => {
                    const budgetPct = Math.min(
                      100,
                      Math.round((tkt.costUsd / Math.max(0.01, tkt.mandate.maxCostUsd)) * 100),
                    );
                    const isRunning = [
                      "planning",
                      "spec_testing",
                      "implementing",
                      "reviewing",
                      "rebasing",
                    ].includes(tkt.status);
                    const childTickets = tkt.isEpic
                      ? childSource.filter((c) => c.parentTicketId === tkt.id)
                      : [];
                    const targetRepoName = reposById.get(tkt.repoId)?.name;
                    const isCrossRepoCard = Boolean(selectedRepoId && tkt.repoId !== selectedRepoId);
                    const hasCrossRepoDep = tkt.dependsOn.some((depId) => {
                      const dep = allTicketsById.get(depId);
                      return dep && dep.repoId !== tkt.repoId;
                    });
                    const childDeliveredCount = childTickets.filter(
                      (c) => c.status === "delivered",
                    ).length;
                    const cardBorderClass =
                      tkt.status === "outbox_pending"
                        ? "border-emerald-500/40"
                        : "border-zinc-800";
                    return (
                      <div
                        key={tkt.id}
                        onClick={() => onSelectTicket(tkt.id)}
                        className={`rounded-lg border ${cardBorderClass} bg-zinc-950/80 p-3 space-y-2.5 hover:border-indigo-500/50 cursor-pointer transition group`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono border ${statusBadgeStyle(
                              tkt.status,
                            )}`}
                          >
                            {isRunning && (
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                            )}
                            {tkt.status === "delivered" && <CheckCircle2 className="w-2.5 h-2.5" />}
                            {tkt.status === "needs_human" && <AlertCircle className="w-2.5 h-2.5" />}
                            {tkt.status === "waiting_deps" && <Lock className="w-2.5 h-2.5" />}
                            {formatTicketStatus(tkt.status, locale)}
                          </span>
                          <span className="text-[10px] font-mono text-zinc-500">{tkt.template}</span>
                        </div>

                        {(tkt.isEpic || tkt.parentTicketId) && (
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {tkt.isEpic ? (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-purple-500/15 border border-purple-500/30 text-purple-300 text-[10px] font-mono">
                                <Layers className="w-2.5 h-2.5" />
                                {t("board.epicBadge")} · {childDeliveredCount}/{childTickets.length}{" "}
                                {t("board.deliveredSuffix")}
                              </span>
                            ) : (
                              <span className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-700/80 text-zinc-300 text-[10px] font-mono">
                                ↳ {t("board.subtaskBadge")}: {tkt.subtaskKey ?? tkt.parentTicketId}
                              </span>
                            )}
                          </div>
                        )}

                        <div>
                          <h4 className="text-xs font-medium text-zinc-100 group-hover:text-indigo-300 transition line-clamp-2">
                            {tkt.title}
                          </h4>
                          <p className="text-[11px] text-zinc-500 mt-0.5 font-mono truncate">
                            {tkt.id}
                          </p>
                        </div>

                        <div className="flex flex-wrap gap-1">
                          {isCrossRepoCard && targetRepoName && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-sky-500/15 border border-sky-500/30 text-sky-300 text-[10px] font-mono">
                              <FolderGit2 className="w-2.5 h-2.5" />
                              {targetRepoName}
                            </span>
                          )}
                          {tkt.handoverDigest && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-teal-500/10 border border-teal-500/30 text-teal-300 text-[10px] font-mono">
                              <FileCode2 className="w-2.5 h-2.5" />
                              Handover v{tkt.handoverDigest.version}
                            </span>
                          )}
                          {tkt.prNumber && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 text-[10px] font-mono">
                              <GitPullRequest className="w-2.5 h-2.5" />
                              PR #{tkt.prNumber}
                            </span>
                          )}
                          {tkt.activeEngine && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 text-[10px] font-mono">
                              <Sparkles className="w-2.5 h-2.5" />
                              {tkt.activeEngine}
                            </span>
                          )}
                          {tkt.tddMode && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-rose-500/10 border border-rose-500/30 text-rose-300 text-[10px] font-mono">
                              <Lock className="w-2.5 h-2.5" />
                              {t("board.badgeTdd")}
                            </span>
                          )}
                          {tkt.pauseBeforeRun && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-300 text-[10px] font-mono">
                              <Pause className="w-2.5 h-2.5" />
                              {t("board.badgeBreakpoint")}
                            </span>
                          )}
                          {tkt.autoArenaEscalated && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-fuchsia-500/10 border border-fuchsia-500/30 text-fuchsia-300 text-[10px] font-mono">
                              <Swords className="w-2.5 h-2.5" />
                              {t("board.badgeAutoArena")}
                            </span>
                          )}
                          {tkt.impactSummary && tkt.impactSummary.directDependents.length > 0 && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 text-[10px] font-mono">
                              {t("board.badgeImpact")} ({tkt.impactSummary.directDependents.length})
                            </span>
                          )}
                          {tkt.riskAssessment && (
                            <span
                              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-mono ${
                                tkt.riskAssessment.level === "high"
                                  ? "bg-rose-500/10 border-rose-500/30 text-rose-300"
                                  : tkt.riskAssessment.level === "medium"
                                    ? "bg-amber-500/10 border-amber-500/30 text-amber-300"
                                    : "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                              }`}
                            >
                              {t("board.badgeRisk")}:{tkt.riskAssessment.score}
                            </span>
                          )}
                          {tkt.mandate.allowedPaths.slice(0, 2).map((p) => (
                            <span
                              key={p}
                              className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-400 text-[10px] font-mono truncate max-w-[140px]"
                            >
                              {p}
                            </span>
                          ))}
                        </div>

                        {tkt.dependsOn.length > 0 && tkt.status === "waiting_deps" && (
                          <div className="flex items-center gap-1 text-[10px] text-amber-400/90 font-mono">
                            <Clock className="w-3 h-3 shrink-0" />
                            <span>
                              {t("board.waitingDepsPrefix")} {tkt.dependsOn.length}{" "}
                              {hasCrossRepoDep
                                ? t("board.waitingCrossRepoSuffix")
                                : t("board.waitingDepsSuffix")}
                            </span>
                          </div>
                        )}

                        <div className="pt-1 space-y-1">
                          <div className="flex justify-between text-[10px] font-mono text-zinc-500">
                            <span>
                              {t("board.stagePrefix")}: {formatStage(tkt.currentStage, locale)}
                            </span>
                            <span>
                              ${tkt.costUsd.toFixed(2)} / ${tkt.mandate.maxCostUsd.toFixed(2)}
                            </span>
                          </div>
                          <div className="h-1 w-full bg-zinc-900 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${
                                budgetPct > 80 ? "bg-rose-500" : "bg-indigo-500"
                              }`}
                              style={{ width: `${budgetPct}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
}
