import { Suspense, lazy, useMemo, useState, type ReactNode } from "react";
import { Search } from "lucide-react";
import { formatTicketStatus, useI18n } from "../i18n.tsx";
import type { RepoConfig, RepoMetricsSummary, Ticket, WorkerEngineId } from "../types.ts";
import { FINISHED_STATUSES, formatUsd } from "../utils/superAgent.ts";

const BoardView = lazy(() => import("./BoardView.tsx").then((m) => ({ default: m.BoardView })));
const MilestonePanel = lazy(() => import("../components/MilestonePanel.tsx"));

interface HistoryViewProps {
  tickets: Ticket[];
  allTickets: Ticket[];
  repos: RepoConfig[];
  selectedRepoId: string;
  metrics: RepoMetricsSummary | null;
  availableEngines: WorkerEngineId[];
  onInspectTicket: (ticketId: string) => void;
  onRefresh: () => void;
}

type Section = "timeline" | "board";
type StatusFilter = "all" | "delivered" | "failed" | "cancelled";

const STATUS_STYLE: Record<string, string> = {
  delivered: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  failed: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  cancelled: "bg-zinc-800 text-zinc-400 border-zinc-700",
};

function SummaryStat({ label, value, children }: { label: string; value: string; children?: ReactNode }) {
  return (
    <div className="flex-1 min-w-[160px] rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="text-lg font-semibold text-zinc-100 font-mono">{value}</div>
      {children}
    </div>
  );
}

export function HistoryView({
  tickets,
  allTickets,
  repos,
  selectedRepoId,
  metrics,
  availableEngines,
  onInspectTicket,
  onRefresh,
}: HistoryViewProps) {
  const { locale, t } = useI18n();
  const [section, setSection] = useState<Section>("timeline");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");

  const finished = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tickets
      .filter((tk) => FINISHED_STATUSES.includes(tk.status))
      .filter((tk) => filter === "all" || tk.status === filter)
      .filter((tk) => !q || tk.title.toLowerCase().includes(q) || tk.id.toLowerCase().includes(q))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }, [tickets, query, filter]);

  const completed = metrics?.ticketCounts.delivered ?? tickets.filter((tk) => tk.status === "delivered").length;
  const budget = metrics?.effectiveDailyBudgetUsd ?? metrics?.dailyBudgetUsd;
  const spend = metrics?.todayCostUsd ?? 0;
  const pct = budget && budget > 0 ? Math.min(100, (spend / budget) * 100) : 0;
  const deliveryRate = Math.round((metrics?.deliveryRate ?? 0) * (metrics && metrics.deliveryRate <= 1 ? 100 : 1));

  const tabCls = (active: boolean) =>
    `px-3 py-1.5 text-xs font-medium rounded-md transition ${
      active ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
    }`;

  return (
    <div className="max-w-6xl mx-auto px-6 py-6 space-y-5">
      <div className="flex flex-wrap gap-3">
        <SummaryStat
          label={t("history.todaySpend")}
          value={budget ? `${formatUsd(spend)} / ${formatUsd(budget)}` : formatUsd(spend)}
        >
          {budget ? (
            <div className="mt-1.5 h-1 rounded-full bg-zinc-800 overflow-hidden">
              <div
                className={`h-full ${metrics?.budgetExceeded ? "bg-rose-500" : "bg-indigo-500"}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          ) : null}
        </SummaryStat>
        <SummaryStat label={t("history.deliveryRate")} value={`${deliveryRate}%`} />
        <SummaryStat label={t("history.completed")} value={String(completed)} />
      </div>

      <div className="inline-flex p-0.5 rounded-lg border border-zinc-800 bg-zinc-900" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={section === "timeline"}
          onClick={() => setSection("timeline")}
          className={tabCls(section === "timeline")}
        >
          {t("history.timeline")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={section === "board"}
          onClick={() => setSection("board")}
          className={tabCls(section === "board")}
        >
          {t("history.board")}
        </button>
      </div>

      {section === "board" ? (
        <Suspense fallback={null}>
          <BoardView
            tickets={tickets}
            allTickets={allTickets}
            repos={repos}
            selectedRepoId={selectedRepoId}
            availableEngines={availableEngines}
            onSelectTicket={onInspectTicket}
            onRefresh={onRefresh}
          />
        </Suspense>
      ) : (
        <div className="space-y-5">
          <Suspense fallback={null}>
            <MilestonePanel
              repoId={selectedRepoId || undefined}
              onInspectTicket={onInspectTicket}
              onRefreshParent={onRefresh}
            />
          </Suspense>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("history.search")}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500"
                />
              </div>
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value as StatusFilter)}
                aria-label={t("history.filter")}
                className="bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500"
              >
                <option value="all">{t("history.filterAll")}</option>
                <option value="delivered">{formatTicketStatus("delivered", locale)}</option>
                <option value="failed">{formatTicketStatus("failed", locale)}</option>
                <option value="cancelled">{formatTicketStatus("cancelled", locale)}</option>
              </select>
            </div>

            {finished.length === 0 ? (
              <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-xs text-zinc-500">
                {t("history.empty")}
              </div>
            ) : (
              <ul className="space-y-1.5">
                {finished.slice(0, 200).map((tk) => (
                  <li key={tk.id}>
                    <button
                      type="button"
                      onClick={() => onInspectTicket(tk.id)}
                      className="w-full flex items-center justify-between gap-3 px-4 py-2.5 rounded-lg border border-zinc-800/70 bg-zinc-900/40 hover:bg-zinc-900 text-left text-xs transition"
                    >
                      <span className="flex items-center gap-3 min-w-0">
                        <span
                          className={`shrink-0 px-2 py-0.5 rounded font-mono text-[10px] border ${STATUS_STYLE[tk.status] ?? ""}`}
                        >
                          {formatTicketStatus(tk.status, locale)}
                        </span>
                        <span className="text-zinc-200 truncate">{tk.title}</span>
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-zinc-500">
                        {formatUsd(tk.costUsd)} · {new Date(tk.updatedAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-US")}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
