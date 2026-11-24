import { useCallback, useEffect, useState } from "react";
import { Activity, AlertTriangle, Award, CheckCircle2, Cpu, DollarSign, Play, Trash2 } from "lucide-react";
import { api } from "../api.ts";
import { formatEngineDisplayName, useI18n } from "../i18n.tsx";
import type {
  EvalCase,
  EvalRunRecord,
  RepoConfig,
  RepoMetricsSummary,
  WorkerEngineId,
} from "../types.ts";

interface MetricsViewProps {
  metrics: RepoMetricsSummary | null;
  repo?: RepoConfig;
  availableEngines?: WorkerEngineId[];
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

export function MetricsView({ metrics, repo, availableEngines = ["mock"] }: MetricsViewProps) {
  const { locale, t } = useI18n();
  const [subTab, setSubTab] = useState<"telemetry" | "evals">("telemetry");
  const [evalCases, setEvalCases] = useState<EvalCase[]>([]);
  const [evalRuns, setEvalRuns] = useState<EvalRunRecord[]>([]);
  const [selectedEngines, setSelectedEngines] = useState<WorkerEngineId[]>(() =>
    availableEngines.length > 0 ? availableEngines.slice(0, 2) : ["mock"],
  );
  const [evalLoading, setEvalLoading] = useState(false);
  const [runningCaseId, setRunningCaseId] = useState<string | null>(null);
  const [evalNotice, setEvalNotice] = useState<string | null>(null);
  const [evalError, setEvalError] = useState<string | null>(null);

  const loadEvals = useCallback(async () => {
    setEvalLoading(true);
    setEvalError(null);
    try {
      const [cRes, rRes] = await Promise.all([
        api.listEvalCases(repo?.id),
        api.listEvalRuns(repo?.id),
      ]);
      setEvalCases(cRes.cases);
      setEvalRuns(rRes.runs);
    } catch (err) {
      setEvalError(err instanceof Error ? err.message : String(err));
    } finally {
      setEvalLoading(false);
    }
  }, [repo?.id]);

  useEffect(() => {
    if (subTab === "evals") {
      void loadEvals();
    }
  }, [subTab, loadEvals]);

  useEffect(() => {
    setSelectedEngines((prev) => {
      const filtered = prev.filter((e) => availableEngines.includes(e));
      return filtered.length > 0 ? filtered : availableEngines.slice(0, 2);
    });
  }, [availableEngines]);

  const toggleEvalEngine = (eng: WorkerEngineId) => {
    setSelectedEngines((prev) => {
      if (prev.includes(eng)) {
        return prev.length > 1 ? prev.filter((item) => item !== eng) : prev;
      }
      return [...prev, eng];
    });
  };

  const handleRunEval = async (evalCaseId: string) => {
    setRunningCaseId(evalCaseId);
    setEvalError(null);
    setEvalNotice(null);
    try {
      const { evalRun } = await api.runEval({
        evalCaseId,
        engines: selectedEngines.length > 0 ? selectedEngines : ["mock"],
      });
      setEvalRuns((prev) => [evalRun, ...prev.filter((r) => r.id !== evalRun.id)]);
      setEvalNotice(
        `Eval ${evalRun.id} completed (${evalRun.results.filter((r) => r.passed).length}/${evalRun.results.length} passed, $${evalRun.totalCostUsd.toFixed(4)})`,
      );
    } catch (err) {
      setEvalError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunningCaseId(null);
    }
  };

  const handleDeleteEval = async (evalCaseId: string) => {
    setEvalError(null);
    try {
      await api.deleteEvalCase(evalCaseId);
      setEvalCases((prev) => prev.filter((c) => c.id !== evalCaseId));
    } catch (err) {
      setEvalError(err instanceof Error ? err.message : String(err));
    }
  };

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
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center rounded-lg border border-zinc-800 bg-zinc-900 p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setSubTab("telemetry")}
              className={`px-3 py-1 rounded-md transition ${
                subTab === "telemetry"
                  ? "bg-indigo-600 text-white font-medium"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {t("metrics.tabTelemetry")}
            </button>
            <button
              type="button"
              onClick={() => setSubTab("evals")}
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md transition ${
                subTab === "evals"
                  ? "bg-indigo-600 text-white font-medium"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <Award className="w-3.5 h-3.5" />
              {t("metrics.tabEvalSuite")}
            </button>
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
      </div>

      {subTab === "evals" ? (
        <div className="space-y-5">
          {evalError && (
            <div className="p-3 rounded-lg border border-rose-500/40 bg-rose-500/10 text-rose-200 text-xs">
              {evalError}
            </div>
          )}
          {evalNotice && (
            <div className="p-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-emerald-200 text-xs">
              {evalNotice}
            </div>
          )}

          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-zinc-400 font-medium">Replay Engines:</span>
              {availableEngines.map((eng) => {
                const active = selectedEngines.includes(eng);
                return (
                  <button
                    key={eng}
                    type="button"
                    onClick={() => toggleEvalEngine(eng)}
                    className={`px-2.5 py-1 rounded-md border font-mono text-[11px] transition ${
                      active
                        ? "border-indigo-500 bg-indigo-500/20 text-indigo-200"
                        : "border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    {formatEngineDisplayName(eng, locale)}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              disabled={evalLoading}
              onClick={() => void loadEvals()}
              className="px-2.5 py-1 rounded-md border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 text-[11px] disabled:opacity-50"
            >
              {evalLoading ? t("drawer.loading") : "Refresh"}
            </button>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-zinc-800 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-100">
                {t("metrics.tabEvalSuite")} ({evalCases.length})
              </h3>
            </div>
            {evalCases.length === 0 ? (
              <div className="p-8 text-center text-xs text-zinc-500">
                No Golden Eval cases saved yet. Open any delivered ticket in Deep Dive Drawer and click “{t("drawer.saveEvalBtn")}”.
              </div>
            ) : (
              <div className="divide-y divide-zinc-800/80">
                {evalCases.map((ec) => (
                  <div
                    key={ec.id}
                    className="p-4 flex flex-wrap items-center justify-between gap-3 text-xs"
                  >
                    <div className="space-y-1 min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-[10px] text-indigo-300">{ec.id}</span>
                        <span className="font-medium text-zinc-100">{ec.title}</span>
                        <span className="font-mono text-[10px] px-1.5 py-0.2 rounded bg-zinc-950 border border-zinc-800 text-zinc-400">
                          {ec.baseCommitSha.slice(0, 8)}
                        </span>
                      </div>
                      <div className="text-[11px] text-zinc-400 truncate">
                        scope: {ec.allowedPaths.join(", ") || "**"} · checks:{" "}
                        {ec.verificationCommands.join(" && ") || "none"}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        disabled={runningCaseId === ec.id}
                        onClick={() => void handleRunEval(ec.id)}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-medium disabled:opacity-50"
                      >
                        <Play className="w-3 h-3" />
                        {runningCaseId === ec.id ? "Running..." : "Run Eval"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDeleteEval(ec.id)}
                        className="p-1.5 rounded border border-zinc-800 text-zinc-400 hover:text-rose-400"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {evalRuns.length > 0 && (
            <div className="space-y-3">
              {evalRuns.slice(0, 8).map((run) => (
                <div
                  key={run.id}
                  className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden"
                >
                  <div className="px-4 py-2.5 border-b border-zinc-800 flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-indigo-300">{run.id}</span>
                      <span className="font-mono text-[11px] text-zinc-400">
                        case={run.evalCaseId}
                      </span>
                    </div>
                    <span className="font-mono text-[11px] text-zinc-400">
                      ${run.totalCostUsd.toFixed(4)} · {new Date(run.startedAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-zinc-950/60 text-zinc-400 font-mono text-[11px] border-b border-zinc-800">
                        <tr>
                          <th className="px-4 py-2 font-medium">{t("metrics.col.engine")}</th>
                          <th className="px-4 py-2 font-medium">Result</th>
                          <th className="px-4 py-2 font-medium">Duration</th>
                          <th className="px-4 py-2 font-medium">Cost</th>
                          <th className="px-4 py-2 font-medium">Diff</th>
                          <th className="px-4 py-2 font-medium">Risk</th>
                          <th className="px-4 py-2 font-medium">Summary</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-800/70 font-mono text-[11px]">
                        {run.results.map((cand) => (
                          <tr key={cand.engine} className="hover:bg-zinc-900/60">
                            <td className="px-4 py-2 text-zinc-100">
                              {formatEngineDisplayName(cand.engine, locale)}
                            </td>
                            <td className="px-4 py-2">
                              <span
                                className={`px-1.5 py-0.5 rounded text-[10px] ${
                                  cand.passed
                                    ? "bg-emerald-500/15 text-emerald-300"
                                    : "bg-rose-500/15 text-rose-300"
                                }`}
                              >
                                {cand.passed ? "PASS" : "FAIL"}
                              </span>
                            </td>
                            <td className="px-4 py-2 text-zinc-300">
                              {formatDurationMs(cand.durationMs)}
                            </td>
                            <td className="px-4 py-2 text-zinc-300">
                              ${cand.costUsd.toFixed(4)}
                            </td>
                            <td className="px-4 py-2 text-zinc-300">
                              +{cand.addedLines}/-{cand.deletedLines}
                            </td>
                            <td className="px-4 py-2 text-zinc-300">{cand.riskScore}</td>
                            <td className="px-4 py-2 text-zinc-400 max-w-xs truncate">
                              {cand.error ?? cand.verificationSummary}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <>

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
        </>
      )}
    </div>
  );
}
