import { useCallback, useEffect, useState } from "react";
import { Activity, CheckCircle2, Clipboard, DollarSign, RefreshCw, Rocket, ShieldAlert, Timer } from "lucide-react";
import { api } from "../api.ts";
import { formatEngineDisplayName, useI18n } from "../i18n.tsx";
import type { TranslationKey } from "../i18n.tsx";
import type { FlightEventKind, RunDigestReport } from "../types.ts";

interface FlightRecorderPanelProps {
  repoId?: string;
}

type WindowChoice = "24h" | "7d" | "all";

const WINDOW_HOURS: Record<WindowChoice, number> = { "24h": 24, "7d": 168, all: 0 };
const WINDOW_LABEL_KEYS: Record<WindowChoice, TranslationKey> = {
  "24h": "flight.window24h",
  "7d": "flight.window7d",
  all: "flight.windowAll",
};

const KIND_STYLES: Record<FlightEventKind, string> = {
  canary_passed: "bg-emerald-500/15 text-emerald-300",
  reload_completed: "bg-sky-500/15 text-sky-300",
  canary_rolled_back: "bg-rose-500/15 text-rose-300",
  scoped_gate_run: "bg-indigo-500/15 text-indigo-300",
  gate_reused: "bg-cyan-500/15 text-cyan-300",
  watchdog_switch: "bg-amber-500/15 text-amber-300",
  milestone_ready: "bg-zinc-500/15 text-zinc-300",
  milestone_released: "bg-zinc-500/15 text-zinc-300",
  engine_tripped: "bg-amber-500/15 text-amber-300",
  spillover_quarantined: "bg-rose-500/15 text-rose-300",
};

function formatSaved(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${Math.round(sec % 60)}s`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

function formatAvg(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  return formatSaved(ms);
}

export default function FlightRecorderPanel({ repoId }: FlightRecorderPanelProps) {
  const { locale, t } = useI18n();
  const [windowChoice, setWindowChoice] = useState<WindowChoice>("24h");
  const [digest, setDigest] = useState<RunDigestReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getRunDigest({ repoId, hours: WINDOW_HOURS[windowChoice] });
      setDigest(res.digest);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [repoId, windowChoice]);

  useEffect(() => {
    void load();
  }, [load]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice({ kind: "ok", text: t("flight.copied") });
    } catch {
      setNotice({ kind: "error", text: t("flight.copyFailed") });
    }
  };

  const kindLabel = (kind: FlightEventKind) => t(`flight.kind.${kind}` as TranslationKey);

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="inline-flex items-center rounded-lg border border-zinc-800 bg-zinc-950 p-0.5">
          {(Object.keys(WINDOW_HOURS) as WindowChoice[]).map((choice) => (
            <button
              key={choice}
              type="button"
              onClick={() => setWindowChoice(choice)}
              className={`px-3 py-1 rounded-md transition ${
                windowChoice === choice
                  ? "bg-indigo-600 text-white font-medium"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {t(WINDOW_LABEL_KEYS[choice])}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={loading}
            onClick={() => void load()}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 text-[11px] disabled:opacity-50"
          >
            <RefreshCw className="w-3 h-3" />
            {t("flight.refresh")}
          </button>
          <button
            type="button"
            disabled={!digest}
            onClick={() => digest && void copy(digest.markdownEn)}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 text-[11px] disabled:opacity-50"
          >
            <Clipboard className="w-3 h-3" />
            {t("flight.copyEn")}
          </button>
          <button
            type="button"
            disabled={!digest}
            onClick={() => digest && void copy(digest.markdownZh)}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 text-[11px] disabled:opacity-50"
          >
            <Clipboard className="w-3 h-3" />
            {t("flight.copyZh")}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-lg border border-rose-500/40 bg-rose-500/10 text-rose-200 text-xs">
          {error}
        </div>
      )}
      {notice && (
        <div
          className={`p-3 rounded-lg border text-xs ${
            notice.kind === "ok"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
              : "border-rose-500/40 bg-rose-500/10 text-rose-200"
          }`}
        >
          {notice.text}
        </div>
      )}

      {!digest ? (
        <div className="p-8 text-center text-xs text-zinc-500">{t("flight.loading")}</div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-2">
              <div className="flex items-center justify-between text-xs text-zinc-400">
                <span>{t("flight.kpi.delivered")}</span>
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              </div>
              <div className="text-2xl font-semibold font-mono text-zinc-100">
                {digest.ticketSummary.delivered}
              </div>
              <div className="text-[11px] font-mono text-zinc-500">
                {digest.ticketSummary.total} {t("flight.kpi.ticketsSuffix")}
              </div>
            </div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-2">
              <div className="flex items-center justify-between text-xs text-zinc-400">
                <span>{t("flight.kpi.cost")}</span>
                <DollarSign className="w-4 h-4 text-amber-400" />
              </div>
              <div className="text-2xl font-semibold font-mono text-zinc-100">
                ${digest.ticketSummary.totalCostUsd.toFixed(2)}
              </div>
            </div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-2">
              <div className="flex items-center justify-between text-xs text-zinc-400">
                <span>{t("flight.kpi.gateSaved")}</span>
                <Timer className="w-4 h-4 text-indigo-400" />
              </div>
              <div className="text-2xl font-semibold font-mono text-zinc-100">
                {formatSaved(digest.gateSavings.totalSavedMs + (digest.gateReuse?.totalSavedMs ?? 0))}
              </div>
              <div className="text-[11px] font-mono text-zinc-500">
                {digest.gateSavings.scopedRuns} {t("flight.kpi.scopedRunsSuffix")} (
                {formatSaved(digest.gateSavings.totalSavedMs)}) · {digest.gateReuse?.reusedRuns ?? 0}{" "}
                {t("flight.kpi.reusedRunsSuffix")} ({formatSaved(digest.gateReuse?.totalSavedMs ?? 0)})
              </div>
            </div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-2">
              <div className="flex items-center justify-between text-xs text-zinc-400">
                <span>{t("flight.kpi.resilience")}</span>
                <ShieldAlert className="w-4 h-4 text-rose-400" />
              </div>
              <div className="text-2xl font-semibold font-mono text-zinc-100">
                {digest.resilience?.engineTrips ?? 0} / {digest.resilience?.spilloverQuarantines ?? 0}
              </div>
              <div className="text-[11px] font-mono text-zinc-500">{t("flight.kpi.resilienceHint")}</div>
            </div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-2">
              <div className="flex items-center justify-between text-xs text-zinc-400">
                <span>{t("flight.kpi.canary")}</span>
                <Rocket className="w-4 h-4 text-sky-400" />
              </div>
              <div className="text-2xl font-semibold font-mono text-zinc-100">
                {digest.selfHost.reloadsCompleted} /{" "}
                <span className={digest.selfHost.canaryRolledBack > 0 ? "text-rose-300" : ""}>
                  {digest.selfHost.canaryRolledBack}
                </span>
              </div>
            </div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-2">
              <div className="flex items-center justify-between text-xs text-zinc-400">
                <span>{t("flight.kpi.watchdog")}</span>
                <ShieldAlert className="w-4 h-4 text-amber-400" />
              </div>
              <div className="text-2xl font-semibold font-mono text-zinc-100">
                {digest.selfHost.watchdogSwitches}
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-zinc-800">
              <h3 className="text-sm font-semibold text-zinc-100">{t("flight.enginesTitle")}</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-zinc-950/60 text-zinc-400 font-mono text-[11px] border-b border-zinc-800">
                  <tr>
                    <th className="px-5 py-3 font-medium">{t("flight.col.engine")}</th>
                    <th className="px-4 py-3 font-medium">{t("flight.col.tickets")}</th>
                    <th className="px-4 py-3 font-medium">{t("flight.col.delivered")}</th>
                    <th className="px-4 py-3 font-medium">{t("flight.col.failed")}</th>
                    <th className="px-4 py-3 font-medium">{t("flight.col.passRate")}</th>
                    <th className="px-4 py-3 font-medium">{t("flight.col.avgDuration")}</th>
                    <th className="px-5 py-3 font-medium text-right">{t("flight.col.cost")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/70 font-mono">
                  {digest.engines.map((row) => (
                    <tr key={row.engine} className="hover:bg-zinc-900/60">
                      <td className="px-5 py-3 text-zinc-100">
                        {formatEngineDisplayName(row.engine, locale)}
                      </td>
                      <td className="px-4 py-3 text-zinc-300">{row.tickets}</td>
                      <td className="px-4 py-3 text-emerald-300">{row.delivered}</td>
                      <td className="px-4 py-3 text-rose-300">{row.failedOrReverted}</td>
                      <td className="px-4 py-3 text-zinc-300">{Math.round(row.passRate * 100)}%</td>
                      <td className="px-4 py-3 text-zinc-300">{formatAvg(row.avgDurationMs)}</td>
                      <td className="px-5 py-3 text-right text-zinc-100">
                        ${row.totalCostUsd.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-zinc-800 flex items-center gap-2">
              <Activity className="w-4 h-4 text-indigo-400" />
              <h3 className="text-sm font-semibold text-zinc-100">{t("flight.eventsTitle")}</h3>
            </div>
            {digest.events.length === 0 ? (
              <div className="p-8 text-center text-xs text-zinc-500">{t("flight.noEvents")}</div>
            ) : (
              <ol className="divide-y divide-zinc-800/80">
                {digest.events.map((ev) => (
                  <li key={ev.id} className="px-5 py-3 flex flex-wrap items-start gap-3 text-xs">
                    <span className="font-mono text-[11px] text-zinc-500 w-44 shrink-0">
                      {new Date(ev.createdAt).toLocaleString()}
                    </span>
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${KIND_STYLES[ev.kind] ?? ""}`}
                    >
                      {kindLabel(ev.kind)}
                    </span>
                    <span className="min-w-0 flex-1 text-zinc-300 break-words">{ev.summary}</span>
                    {ev.savedMs ? (
                      <span className="font-mono text-[11px] text-indigo-300">
                        −{formatSaved(ev.savedMs)}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </>
      )}
    </div>
  );
}
