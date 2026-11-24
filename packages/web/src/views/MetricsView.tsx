import { Activity, AlertTriangle, CheckCircle2, Cpu, DollarSign } from "lucide-react";
import { formatEngineDisplayName, useI18n } from "../i18n.tsx";
import type { RepoConfig, RepoMetricsSummary } from "../types.ts";

interface MetricsViewProps {
  metrics: RepoMetricsSummary | null;
  repo?: RepoConfig;
}

function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  const sec = ms / 1_000;
  if (sec < 60) return `${sec.toFixed(1)} s`;
  const mins = Math.floor(sec / 60);
  const rem = Math.round(sec % 60);
  return `${mins}m ${rem}s`;
}

export function MetricsView({ metrics, repo }: MetricsViewProps) {
  const { locale, t } = useI18n();

  if (!metrics) {
    return (
      <div className="max-w-5xl mx-auto p-6 text-xs text-zinc-500">
        {t("drawer.loading")}
      </div>
    );
  }

  const effectiveCap = metrics.effectiveDailyBudgetUsd;
  const budgetPct =
    effectiveCap && effectiveCap > 0
      ? Math.min(100, Math.round((metrics.todayCostUsd / effectiveCap) * 100))
      : 0;
  const finishedCount =
    metrics.ticketCounts.delivered +
    metrics.ticketCounts.failed +
    metrics.ticketCounts.cancelled;
  const deliveryPct = Math.round(metrics.deliveryRate * 100);
  const totalEngineCost = metrics.byEngine.reduce((sum, row) => sum + row.totalCostUsd, 0);

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">{t("metrics.title")}</h2>
          <p className="text-xs text-zinc-400 mt-0.5">{t("metrics.subtitle")}</p>
        </div>
        {repo && (
          <div className="flex items-center gap-2 text-xs font-mono text-zinc-400">
            <span className="px-2.5 py-1 rounded-md border border-zinc-800 bg-zinc-900/70 text-zinc-200">
              {repo.name}
            </span>
            {repo.maxConcurrentWorkers && (
              <span className="px-2 py-1 rounded-md border border-zinc-800 bg-zinc-900/70">
                maxConcurrency={repo.maxConcurrentWorkers}
              </span>
            )}
          </div>
        )}
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-2.5">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>{t("metrics.todaySpend")}</span>
            <DollarSign className="w-4 h-4 text-amber-400" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold font-mono text-zinc-100">
              ${metrics.todayCostUsd.toFixed(3)}
            </span>
            {effectiveCap && effectiveCap > 0 && (
              <span className="text-xs font-mono text-zinc-500">
                / ${effectiveCap.toFixed(2)}
              </span>
            )}
          </div>
          {effectiveCap && effectiveCap > 0 ? (
            <div className="space-y-1.5">
              <div className="h-1.5 w-full bg-zinc-950 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    metrics.budgetExceeded
                      ? "bg-rose-500"
                      : budgetPct > 80
                        ? "bg-amber-500"
                        : "bg-emerald-500"
                  }`}
                  style={{ width: `${budgetPct}%` }}
                />
              </div>
              {metrics.budgetExceeded && (
                <div className="inline-flex items-center gap-1 text-[10px] font-mono text-rose-300">
                  <AlertTriangle className="w-3 h-3" />
                  {t("metrics.capReached")}
                </div>
              )}
            </div>
          ) : (
            <div className="text-[11px] text-zinc-500">{t("metrics.dailyCapUnlimited")}</div>
          )}
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-2">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>{t("metrics.totalCost")}</span>
            <Activity className="w-4 h-4 text-indigo-400" />
          </div>
          <div className="text-2xl font-semibold font-mono text-zinc-100">
            ${metrics.totalCostUsd.toFixed(3)}
          </div>
          <div className="text-[11px] font-mono text-zinc-500">
            {metrics.ticketCounts.total} tickets · {metrics.todayDate}
          </div>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-2">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>{t("metrics.deliveryRate")}</span>
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-semibold font-mono text-zinc-100">
            {deliveryPct}%
          </div>
          <div className="text-[11px] font-mono text-zinc-500">
            {metrics.ticketCounts.delivered} / {finishedCount} {t("metrics.finishedSuffix")}
          </div>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-2">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>{t("metrics.activeQueue")}</span>
            <Cpu className="w-4 h-4 text-sky-400" />
          </div>
          <div className="text-2xl font-semibold font-mono text-zinc-100">
            {metrics.ticketCounts.active}
          </div>
          <div className="text-[11px] font-mono text-zinc-500">
            {metrics.ticketCounts.needsHuman} {t("metrics.needsHumanSuffix")} ·{" "}
            {metrics.ticketCounts.failed} failed
          </div>
        </div>
      </div>

      {/* Per-Engine Breakdown */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
        <div className="px-5 py-3.5 border-b border-zinc-800 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-100">{t("metrics.byEngineTitle")}</h3>
          <span className="text-[11px] font-mono text-zinc-500">
            {metrics.byEngine.length} engines
          </span>
        </div>

        {metrics.byEngine.length === 0 ? (
          <div className="p-8 text-center text-xs text-zinc-500">{t("metrics.noRuns")}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-zinc-950/60 text-zinc-400 font-mono text-[11px] border-b border-zinc-800">
                <tr>
                  <th className="px-5 py-3 font-medium">{t("metrics.col.engine")}</th>
                  <th className="px-4 py-3 font-medium">{t("metrics.col.runs")}</th>
                  <th className="px-4 py-3 font-medium">{t("metrics.col.successRate")}</th>
                  <th className="px-4 py-3 font-medium">{t("metrics.col.avgDuration")}</th>
                  <th className="px-5 py-3 font-medium text-right">{t("metrics.col.cost")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {metrics.byEngine.map((row) => {
                  const finishedRuns = row.completedRuns + row.failedRuns;
                  const passPct =
                    finishedRuns > 0 ? Math.round((row.completedRuns / finishedRuns) * 100) : 0;
                  const sharePct =
                    totalEngineCost > 0
                      ? Math.round((row.totalCostUsd / totalEngineCost) * 100)
                      : 0;
                  return (
                    <tr key={row.engine} className="hover:bg-zinc-900/60">
                      <td className="px-5 py-3 font-medium text-zinc-100">
                        <div className="flex items-center gap-2">
                          <span className="px-2 py-0.5 rounded bg-indigo-500/15 border border-indigo-500/30 font-mono text-[11px] text-indigo-300">
                            {formatEngineDisplayName(row.engine, locale)}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono text-zinc-300">
                        {row.runs}{" "}
                        <span className="text-[10px] text-zinc-500">
                          ({row.completedRuns}✓ / {row.failedRuns}✕)
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-emerald-300">{passPct}%</td>
                      <td className="px-4 py-3 font-mono text-zinc-300">
                        {formatDurationMs(row.avgDurationMs)}
                      </td>
                      <td className="px-5 py-3 text-right font-mono text-zinc-100">
                        <div>${row.totalCostUsd.toFixed(4)}</div>
                        <div className="text-[10px] text-zinc-500">{sharePct}%</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Engine x Category Bandit Matrix (v0.9.0 B.2) */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
        <div className="px-5 py-3.5 border-b border-zinc-800 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-100">{t("metrics.matrixTitle")}</h3>
          <span className="text-[11px] font-mono text-zinc-500">
            {metrics.engineMatrix?.length ?? 0} rows
          </span>
        </div>

        {(metrics.engineMatrix?.length ?? 0) === 0 ? (
          <div className="p-8 text-center text-xs text-zinc-500">{t("metrics.matrixEmpty")}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-zinc-950/60 text-zinc-400 font-mono text-[11px] border-b border-zinc-800">
                <tr>
                  <th className="px-5 py-3 font-medium">{t("metrics.col.engine")}</th>
                  <th className="px-4 py-3 font-medium">{t("metrics.col.category")}</th>
                  <th className="px-4 py-3 font-medium">{t("metrics.col.tickets")}</th>
                  <th className="px-4 py-3 font-medium">{t("metrics.col.firstPass")}</th>
                  <th className="px-4 py-3 font-medium">{t("metrics.col.delivery")}</th>
                  <th className="px-4 py-3 font-medium">{t("metrics.col.revert")}</th>
                  <th className="px-4 py-3 font-medium">{t("metrics.col.cost")}</th>
                  <th className="px-5 py-3 font-medium text-right">{t("metrics.col.score")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {metrics.engineMatrix!.map((row) => (
                  <tr
                    key={`${row.engine}:${row.category}`}
                    className="hover:bg-zinc-900/60"
                  >
                    <td className="px-5 py-3 font-medium text-zinc-100">
                      <span className="px-2 py-0.5 rounded bg-indigo-500/15 border border-indigo-500/30 font-mono text-[11px] text-indigo-300">
                        {formatEngineDisplayName(row.engine, locale)}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-zinc-300">{row.category}</td>
                    <td className="px-4 py-3 font-mono text-zinc-300">{row.tickets}</td>
                    <td className="px-4 py-3 font-mono text-emerald-300">
                      {Math.round(row.firstPassRate * 100)}%
                    </td>
                    <td className="px-4 py-3 font-mono text-sky-300">
                      {Math.round(row.deliveryRate * 100)}%
                    </td>
                    <td className="px-4 py-3 font-mono text-rose-300">
                      {Math.round(row.revertRate * 100)}%
                    </td>
                    <td className="px-4 py-3 font-mono text-zinc-300">
                      ${row.avgCostUsd.toFixed(4)}
                    </td>
                    <td className="px-5 py-3 text-right font-mono font-semibold text-amber-300">
                      {row.compositeScore.toFixed(3)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
