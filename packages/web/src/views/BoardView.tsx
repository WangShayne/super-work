import { AlertCircle, CheckCircle2, Clock, Lock, Sparkles } from "lucide-react";
import { formatStage, formatTicketStatus, type TranslationKey, useI18n } from "../i18n.tsx";
import type { Ticket, TicketStatus } from "../types.ts";

interface BoardViewProps {
  tickets: Ticket[];
  onSelectTicket: (ticketId: string) => void;
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
    statuses: ["queued", "waiting_deps", "planning", "awaiting_plan_approval"],
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

export function BoardView({ tickets, onSelectTicket }: BoardViewProps) {
  const { locale, t } = useI18n();

  return (
    <div className="p-5 overflow-x-auto">
      <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-5 gap-4 min-w-[980px]">
        {SWIMLANES.map((lane) => {
          const laneTickets = tickets.filter((tkt) => lane.statuses.includes(tkt.status));
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
                    const isRunning = ["planning", "implementing", "reviewing", "rebasing"].includes(
                      tkt.status,
                    );
                    return (
                      <div
                        key={tkt.id}
                        onClick={() => onSelectTicket(tkt.id)}
                        className="rounded-lg border border-zinc-800 bg-zinc-950/80 p-3 space-y-2.5 hover:border-indigo-500/50 cursor-pointer transition group"
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

                        <div>
                          <h4 className="text-xs font-medium text-zinc-100 group-hover:text-indigo-300 transition line-clamp-2">
                            {tkt.title}
                          </h4>
                          <p className="text-[11px] text-zinc-500 mt-0.5 font-mono truncate">
                            {tkt.id}
                          </p>
                        </div>

                        <div className="flex flex-wrap gap-1">
                          {tkt.activeEngine && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 text-[10px] font-mono">
                              <Sparkles className="w-2.5 h-2.5" />
                              {tkt.activeEngine}
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
                            <Clock className="w-3 h-3" />
                            {t("board.waitingDepsPrefix")} {tkt.dependsOn.length} {t("board.waitingDepsSuffix")}
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
    </div>
  );
}
