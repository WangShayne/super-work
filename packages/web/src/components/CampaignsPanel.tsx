import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  CheckCircle2,
  Flame,
  GitMerge,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { api } from "../api.ts";
import { formatTemplate, useI18n } from "../i18n.tsx";
import type {
  CampaignDeliveryMode,
  CampaignDirection,
  CampaignStatus,
  GoalCampaign,
  GoalCampaignWave,
  PipelineTemplateId,
  RepoConfig,
  WorkerEngineId,
} from "../types.ts";

interface CampaignsPanelProps {
  repo?: RepoConfig;
  availableEngines: WorkerEngineId[];
  onInspectTicket: (ticketId: string) => void;
  onRefreshParent: () => void;
}

const STATUS_BADGE: Record<CampaignStatus, string> = {
  idle: "bg-zinc-800 text-zinc-300 border-zinc-700",
  running: "bg-indigo-500/15 text-indigo-300 border-indigo-500/30",
  paused: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  completed: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  delivered: "bg-teal-500/15 text-teal-300 border-teal-500/30",
  failed: "bg-rose-500/15 text-rose-300 border-rose-500/30",
};

function MetricSparkline({
  baselineValue,
  targetValue,
  waves,
}: {
  baselineValue?: number;
  targetValue: number;
  waves: GoalCampaignWave[];
}) {
  const points: Array<{ label: string; value: number }> = [];
  if (typeof baselineValue === "number" && Number.isFinite(baselineValue)) {
    points.push({ label: "base", value: baselineValue });
  }
  for (const w of waves) {
    if (typeof w.measuredValue === "number" && Number.isFinite(w.measuredValue)) {
      points.push({ label: `W${w.waveNumber}`, value: w.measuredValue });
    }
  }
  if (points.length === 0) return null;

  const width = 280;
  const height = 56;
  const padX = 8;
  const padY = 8;
  const values = [...points.map((p) => p.value), targetValue];
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const span = maxVal - minVal || 1;

  const toY = (v: number) => height - padY - ((v - minVal) / span) * (height - padY * 2);
  const coords = points.map((p, idx) => {
    const x =
      points.length === 1
        ? width / 2
        : padX + (idx / (points.length - 1)) * (width - padX * 2);
    return { x, y: toY(p.value), ...p };
  });
  const polylinePoints = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const targetY = toY(targetValue);
  const latest = coords[coords.length - 1]!;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full h-14 rounded-lg bg-zinc-950/70 border border-zinc-800/80"
    >
      <line
        x1={padX}
        y1={targetY}
        x2={width - padX}
        y2={targetY}
        stroke="#10b981"
        strokeOpacity={0.5}
        strokeDasharray="4 3"
        strokeWidth={1}
      />
      {coords.length > 1 && (
        <polyline
          fill="none"
          stroke="#818cf8"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          points={polylinePoints}
        />
      )}
      {coords.map((c, idx) => (
        <circle
          key={`${c.label}-${idx}`}
          cx={c.x}
          cy={c.y}
          r={idx === coords.length - 1 ? 3.5 : 2.5}
          fill={idx === coords.length - 1 ? "#34d399" : "#a5b4fc"}
        >
          <title>{`${c.label}: ${c.value}`}</title>
        </circle>
      ))}
      <text x={width - padX} y={12} textAnchor="end" fill="#a1a1aa" fontSize={9}>
        {`${latest.label}: ${latest.value} / target ${targetValue}`}
      </text>
    </svg>
  );
}

export function CampaignsPanel({
  repo,
  availableEngines,
  onInspectTicket,
  onRefreshParent,
}: CampaignsPanelProps) {
  const { locale, t } = useI18n();
  const [campaigns, setCampaigns] = useState<GoalCampaign[]>([]);
  const [wavesById, setWavesById] = useState<Record<string, GoalCampaignWave[]>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Create form state
  const [name, setName] = useState("");
  const [goalPrompt, setGoalPrompt] = useState("");
  const [metricCommand, setMetricCommand] = useState("");
  const [metricRegex, setMetricRegex] = useState("");
  const [metricUnit, setMetricUnit] = useState("");
  const [direction, setDirection] = useState<CampaignDirection>("decrease");
  const [targetValue, setTargetValue] = useState("0");
  const [deliveryMode, setDeliveryMode] = useState<CampaignDeliveryMode>("staging_branch");
  const [allowedPaths, setAllowedPaths] = useState("**");
  const [template, setTemplate] = useState<PipelineTemplateId>("fast");
  const [preferredEngine, setPreferredEngine] = useState("");
  const [maxIterations, setMaxIterations] = useState("5");
  const [maxTotalBudgetUsd, setMaxTotalBudgetUsd] = useState("5.0");
  const [autoStart, setAutoStart] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadCampaigns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listCampaigns(repo?.id);
      setCampaigns(res.campaigns);
      if (expandedId && res.campaigns.some((c) => c.id === expandedId)) {
        const detail = await api.getCampaign(expandedId).catch(() => null);
        if (detail) {
          setWavesById((prev) => ({ ...prev, [expandedId]: detail.waves }));
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [repo?.id, expandedId]);

  useEffect(() => {
    void loadCampaigns();
  }, [loadCampaigns]);

  const handleToggleExpand = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (!wavesById[id]) {
      const detail = await api.getCampaign(id).catch(() => null);
      if (detail) {
        setWavesById((prev) => ({ ...prev, [id]: detail.waves }));
      }
    }
  };

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!repo || !name.trim() || !goalPrompt.trim() || !metricCommand.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.createCampaign({
        repoId: repo.id,
        name: name.trim(),
        goalPrompt: goalPrompt.trim(),
        metricCommand: metricCommand.trim(),
        metricRegex: metricRegex.trim() || undefined,
        metricUnit: metricUnit.trim() || undefined,
        direction,
        targetValue: Number(targetValue) || 0,
        deliveryMode,
        allowedPaths: allowedPaths.split(",").map((s) => s.trim()).filter(Boolean),
        template,
        preferredEngine: preferredEngine ? (preferredEngine as WorkerEngineId) : undefined,
        maxIterations: Math.max(1, Math.min(30, Number(maxIterations) || 5)),
        maxTotalBudgetUsd: Math.max(0.5, Number(maxTotalBudgetUsd) || 5),
        autoStart,
      });
      setName("");
      setGoalPrompt("");
      setMetricCommand("");
      setShowCreate(false);
      setExpandedId(res.campaign.id);
      await loadCampaigns();
      onRefreshParent();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const runAction = async (id: string, fn: () => Promise<unknown>) => {
    setBusyId(id);
    setError(null);
    try {
      await fn();
      await loadCampaigns();
      onRefreshParent();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
            <Flame className="w-4 h-4 text-amber-400" />
            {t("campaigns.title")}
          </h2>
          <p className="text-xs text-zinc-400 mt-0.5 max-w-2xl">{t("campaigns.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void loadCampaigns()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-xs text-zinc-300 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
          <button
            type="button"
            disabled={!repo}
            onClick={() => setShowCreate((prev) => !prev)}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium disabled:opacity-40 transition"
          >
            <Plus className="w-3.5 h-3.5" />
            {t("campaigns.newBtn")}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          {error}
        </div>
      )}

      {showCreate && (
        <form
          onSubmit={(e) => void handleCreate(e)}
          className="rounded-xl border border-indigo-500/30 bg-zinc-900/60 p-4 space-y-3 text-xs"
        >
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-zinc-400 mb-1">Campaign Name</label>
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Reduce test runtime / Increase coverage"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-zinc-100"
              />
            </div>
            <div>
              <label className="block text-zinc-400 mb-1">Direction</label>
              <select
                value={direction}
                onChange={(e) => setDirection(e.target.value as CampaignDirection)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-100"
              >
                <option value="decrease">Decrease (lower is better)</option>
                <option value="increase">Increase (higher is better)</option>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-zinc-400 mb-1">Target</label>
                <input
                  required
                  type="number"
                  step="any"
                  value={targetValue}
                  onChange={(e) => setTargetValue(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 font-mono text-zinc-100"
                />
              </div>
              <div>
                <label className="block text-zinc-400 mb-1">Unit</label>
                <input
                  value={metricUnit}
                  onChange={(e) => setMetricUnit(e.target.value)}
                  placeholder="ms / %"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 font-mono text-zinc-100"
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-zinc-400 mb-1">Metric Command</label>
              <input
                required
                value={metricCommand}
                onChange={(e) => setMetricCommand(e.target.value)}
                placeholder="bun run bench | node -e '...'"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 font-mono text-zinc-100"
              />
            </div>
            <div>
              <label className="block text-zinc-400 mb-1">Metric Regex (optional)</label>
              <input
                value={metricRegex}
                onChange={(e) => setMetricRegex(e.target.value)}
                placeholder="score=([0-9.]+)"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 font-mono text-zinc-100"
              />
            </div>
          </div>

          <div>
            <label className="block text-zinc-400 mb-1">Optimization Goal Prompt</label>
            <textarea
              required
              rows={2}
              value={goalPrompt}
              onChange={(e) => setGoalPrompt(e.target.value)}
              placeholder="Describe the quantitative optimization objective..."
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100"
            />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
            <div>
              <label className="block text-zinc-400 mb-1">Delivery Mode</label>
              <select
                value={deliveryMode}
                onChange={(e) => setDeliveryMode(e.target.value as CampaignDeliveryMode)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-zinc-100"
              >
                <option value="staging_branch">staging_branch</option>
                <option value="per_wave_merge">per_wave_merge</option>
              </select>
            </div>
            <div>
              <label className="block text-zinc-400 mb-1">Pipeline</label>
              <select
                value={template}
                onChange={(e) => setTemplate(e.target.value as PipelineTemplateId)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-zinc-100"
              >
                <option value="fast">{formatTemplate("fast", locale)}</option>
                <option value="standard">{formatTemplate("standard", locale)}</option>
                <option value="strict">{formatTemplate("strict", locale)}</option>
              </select>
            </div>
            <div>
              <label className="block text-zinc-400 mb-1">Engine</label>
              <select
                value={preferredEngine}
                onChange={(e) => setPreferredEngine(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-zinc-100"
              >
                <option value="">auto</option>
                {availableEngines.map((eng) => (
                  <option key={eng} value={eng}>
                    {eng}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-zinc-400 mb-1">Max Waves</label>
              <input
                type="number"
                min={1}
                max={30}
                value={maxIterations}
                onChange={(e) => setMaxIterations(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 font-mono text-zinc-100"
              />
            </div>
            <div>
              <label className="block text-zinc-400 mb-1">Budget (USD)</label>
              <input
                type="number"
                step="0.5"
                min={0.5}
                value={maxTotalBudgetUsd}
                onChange={(e) => setMaxTotalBudgetUsd(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 font-mono text-zinc-100"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3 flex-1 min-w-[220px]">
              <input
                value={allowedPaths}
                onChange={(e) => setAllowedPaths(e.target.value)}
                placeholder="src/**, packages/**"
                className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 font-mono text-zinc-100"
              />
              <label className="inline-flex items-center gap-1.5 text-zinc-300 cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  checked={autoStart}
                  onChange={(e) => setAutoStart(e.target.checked)}
                  className="rounded border-zinc-700 bg-zinc-950 text-indigo-500"
                />
                Auto Start
              </label>
            </div>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium disabled:opacity-50"
            >
              {saving ? "..." : t("campaigns.createBtn")}
            </button>
          </div>
        </form>
      )}

      {campaigns.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-xs text-zinc-500">
          {t("campaigns.empty")}
        </div>
      ) : (
        <div className="space-y-3">
          {campaigns.map((cmp) => {
            const waves = wavesById[cmp.id] ?? [];
            const isExpanded = expandedId === cmp.id;
            const isBusy = busyId === cmp.id;
            return (
              <div
                key={cmp.id}
                className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 space-y-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => void handleToggleExpand(cmp.id)}
                    className="flex items-center gap-2.5 flex-wrap text-left"
                  >
                    {cmp.direction === "increase" ? (
                      <TrendingUp className="w-4 h-4 text-emerald-400 shrink-0" />
                    ) : (
                      <TrendingDown className="w-4 h-4 text-sky-400 shrink-0" />
                    )}
                    <span className="text-sm font-medium text-zinc-100">{cmp.name}</span>
                    <span
                      className={`px-2 py-0.5 rounded font-mono text-[10px] border ${STATUS_BADGE[cmp.status]}`}
                    >
                      {cmp.status}
                    </span>
                    <span className="text-[11px] font-mono text-zinc-400">
                      {cmp.baselineValue ?? "?"} →{" "}
                      <strong className="text-emerald-300">{cmp.currentValue ?? "?"}</strong> /{" "}
                      {cmp.targetValue}
                      {cmp.metricUnit ? ` ${cmp.metricUnit}` : ""}
                    </span>
                    <span className="text-[11px] font-mono text-zinc-500">
                      waves {cmp.completedWaves}/{cmp.maxIterations} · ${cmp.totalCostUsd.toFixed(2)}/
                      ${cmp.maxTotalBudgetUsd.toFixed(2)}
                    </span>
                  </button>

                  <div className="flex items-center gap-1.5">
                    {cmp.activeTicketId && (
                      <button
                        type="button"
                        onClick={() => onInspectTicket(cmp.activeTicketId!)}
                        className="px-2 py-1 rounded border border-indigo-500/30 bg-indigo-500/10 text-indigo-300 text-[11px] font-mono"
                      >
                        {cmp.activeTicketId} →
                      </button>
                    )}
                    {(cmp.status === "idle" || cmp.status === "paused" || cmp.status === "failed") && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void runAction(cmp.id, () => api.startCampaign(cmp.id))}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-emerald-500/40 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 text-[11px] font-medium disabled:opacity-50"
                      >
                        <Play className="w-3 h-3" />
                        {t("campaigns.startBtn")}
                      </button>
                    )}
                    {cmp.status === "running" && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void runAction(cmp.id, () => api.pauseCampaign(cmp.id))}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-amber-500/40 bg-amber-500/15 hover:bg-amber-500/25 text-amber-200 text-[11px] font-medium disabled:opacity-50"
                      >
                        <Pause className="w-3 h-3" />
                        {t("campaigns.pauseBtn")}
                      </button>
                    )}
                    {cmp.status !== "delivered" &&
                      (cmp.completedWaves > 0 || cmp.status === "completed") && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() =>
                            void runAction(cmp.id, () => api.deliverCampaign(cmp.id, "local_merge"))
                          }
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-sky-500/40 bg-sky-500/15 hover:bg-sky-500/25 text-sky-200 text-[11px] font-medium disabled:opacity-50"
                        >
                          <GitMerge className="w-3 h-3" />
                          {t("campaigns.deliverBtn")}
                        </button>
                      )}
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void runAction(cmp.id, () => api.deleteCampaign(cmp.id))}
                      className="p-1.5 rounded border border-zinc-800 bg-zinc-950 text-zinc-500 hover:text-rose-400"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {cmp.pauseReason && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-200">
                    {cmp.pauseReason}
                  </div>
                )}

                <MetricSparkline
                  baselineValue={cmp.baselineValue}
                  targetValue={cmp.targetValue}
                  waves={waves}
                />

                {isExpanded && waves.length > 0 && (
                  <div className="space-y-1.5 pt-2 border-t border-zinc-800/80 text-xs">
                    {waves.map((w) => (
                      <div
                        key={w.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-zinc-950/60 border border-zinc-800/70 px-3 py-1.5"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          {w.status === "improved" ? (
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                          ) : w.rolledBack ? (
                            <RotateCcw className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                          ) : (
                            <span className="w-2 h-2 rounded-full bg-zinc-500 shrink-0" />
                          )}
                          <span className="font-mono text-[11px] text-zinc-300">W{w.waveNumber}</span>
                          <span className="font-mono text-[10px] text-zinc-400">[{w.status}]</span>
                          <span className="text-zinc-300 truncate max-w-md">{w.summary}</span>
                        </div>
                        <div className="flex items-center gap-2.5 font-mono text-[10px] text-zinc-500 shrink-0">
                          {w.ticketId && (
                            <button
                              type="button"
                              onClick={() => onInspectTicket(w.ticketId!)}
                              className="text-indigo-400 hover:text-indigo-300"
                            >
                              {w.ticketId} →
                            </button>
                          )}
                          <span>${w.costUsd.toFixed(3)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
