import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  Clock,
  Pause,
  Play,
  Plus,
  RefreshCw,
  SkipForward,
  Sparkles,
  Trash2,
  XCircle,
} from "lucide-react";
import { api } from "../api.ts";
import { formatTemplate, useI18n } from "../i18n.tsx";
import type {
  PipelineTemplateId,
  RepoConfig,
  RoutinePresetTemplate,
  RoutineRun,
  RoutineRunStatus,
  RoutineScheduleKind,
  RoutineSpec,
  WorkerEngineId,
} from "../types.ts";

interface RoutinesViewProps {
  repo?: RepoConfig;
  availableEngines: WorkerEngineId[];
  onInspectTicket: (ticketId: string) => void;
  onRefreshParent: () => void;
}

const RUN_STATUS_STYLE: Record<RoutineRunStatus, string> = {
  probing: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  clean: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  promoted: "bg-indigo-500/15 text-indigo-300 border-indigo-500/30",
  skipped_overlap: "bg-zinc-800 text-zinc-400 border-zinc-700",
  skipped_budget: "bg-yellow-500/15 text-yellow-300 border-yellow-500/30",
  failed: "bg-rose-500/15 text-rose-300 border-rose-500/30",
};

export function RoutinesView({
  repo,
  availableEngines,
  onInspectTicket,
  onRefreshParent,
}: RoutinesViewProps) {
  const { locale, t } = useI18n();
  const [routines, setRoutines] = useState<RoutineSpec[]>([]);
  const [presets, setPresets] = useState<RoutinePresetTemplate[]>([]);
  const [runs, setRuns] = useState<RoutineRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [addingPresetId, setAddingPresetId] = useState<string | null>(null);

  // Create form state
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [scheduleKind, setScheduleKind] = useState<RoutineScheduleKind>("interval");
  const [intervalMinutes, setIntervalMinutes] = useState("360");
  const [cronExpr, setCronExpr] = useState("0 2 * * *");
  const [windowStart, setWindowStart] = useState("");
  const [windowEnd, setWindowEnd] = useState("");
  const [allowedPaths, setAllowedPaths] = useState("**");
  const [template, setTemplate] = useState<PipelineTemplateId>("standard");
  const [preferredEngine, setPreferredEngine] = useState<string>("");
  const [maxBudgetUsd, setMaxBudgetUsd] = useState("1.5");
  const [saving, setSaving] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [rtRes, runRes] = await Promise.all([
        api.listRoutines(repo?.id),
        api.listRoutineRuns({ repoId: repo?.id, limit: 30 }),
      ]);
      setRoutines(rtRes.routines);
      setPresets(rtRes.presets);
      setRuns(runRes.runs);
    } finally {
      setLoading(false);
    }
  }, [repo?.id]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleAddPreset = async (preset: RoutinePresetTemplate) => {
    if (!repo) return;
    setAddingPresetId(preset.id);
    try {
      await api.createRoutine({
        repoId: repo.id,
        name: locale === "zh" ? preset.nameZh : preset.nameEn,
        prompt: preset.prompt,
        scheduleKind: preset.scheduleKind,
        cronExpr: preset.cronExpr,
        intervalMinutes: preset.intervalMinutes,
        activeHoursStart: preset.activeHoursStart,
        activeHoursEnd: preset.activeHoursEnd,
        allowedPaths: preset.allowedPaths,
        template: preset.template,
        maxBudgetUsd: preset.maxBudgetUsd,
        enabled: true,
      });
      await loadData();
      onRefreshParent();
    } finally {
      setAddingPresetId(null);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!repo || !name.trim() || !prompt.trim()) return;
    setSaving(true);
    try {
      await api.createRoutine({
        repoId: repo.id,
        name: name.trim(),
        prompt: prompt.trim(),
        scheduleKind,
        intervalMinutes: scheduleKind === "interval" ? Number(intervalMinutes) || 360 : undefined,
        cronExpr: scheduleKind === "cron" ? cronExpr.trim() || "0 2 * * *" : undefined,
        activeHoursStart: windowStart.trim() || undefined,
        activeHoursEnd: windowEnd.trim() || undefined,
        allowedPaths: allowedPaths
          .split(/[\n,]+/)
          .map((s) => s.trim())
          .filter(Boolean),
        template,
        preferredEngine: preferredEngine ? (preferredEngine as WorkerEngineId) : undefined,
        maxBudgetUsd: Number(maxBudgetUsd) || 1.5,
        enabled: true,
      });
      setName("");
      setPrompt("");
      setShowCreate(false);
      await loadData();
      onRefreshParent();
    } finally {
      setSaving(false);
    }
  };

  const handleRunNow = async (id: string) => {
    setRunningId(id);
    try {
      await api.runRoutineNow(id);
      await loadData();
      onRefreshParent();
    } finally {
      setRunningId(null);
    }
  };

  const handleToggle = async (r: RoutineSpec) => {
    await api.patchRoutine(r.id, { enabled: !r.enabled });
    await loadData();
    onRefreshParent();
  };

  const handleDelete = async (id: string) => {
    await api.deleteRoutine(id);
    await loadData();
    onRefreshParent();
  };

  const statusLabel = (s: RoutineRunStatus) => {
    return t(`routines.status.${s}` as const);
  };

  const routineNameById = new Map(routines.map((r) => [r.id, r.name]));

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">{t("routines.title")}</h2>
          <p className="text-xs text-zinc-400 mt-0.5 max-w-2xl">{t("routines.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void loadData()}
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
            {showCreate ? t("routines.hideFormBtn") : t("routines.createBtn")}
          </button>
        </div>
      </div>

      {/* Quick Presets */}
      {presets.length > 0 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-teal-400" />
            {t("routines.presetsTitle")}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
            {presets.map((preset) => (
              <div
                key={preset.id}
                className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3 flex flex-col justify-between gap-2.5"
              >
                <div className="space-y-1">
                  <div className="text-xs font-medium text-zinc-100">
                    {locale === "zh" ? preset.nameZh : preset.nameEn}
                  </div>
                  <p className="text-[11px] text-zinc-400 leading-relaxed">
                    {locale === "zh" ? preset.descZh : preset.descEn}
                  </p>
                </div>
                <div className="flex items-center justify-between gap-2 pt-1">
                  <span className="font-mono text-[10px] text-zinc-500">
                    {preset.scheduleKind === "cron"
                      ? `cron: ${preset.cronExpr}`
                      : `every ${preset.intervalMinutes}m`}
                  </span>
                  <button
                    type="button"
                    disabled={!repo || addingPresetId === preset.id}
                    onClick={() => void handleAddPreset(preset)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-teal-500/40 bg-teal-500/15 hover:bg-teal-500/25 text-teal-200 text-[11px] font-medium disabled:opacity-40"
                  >
                    <Plus className="w-3 h-3" />
                    {addingPresetId === preset.id ? "..." : t("routines.addPresetBtn")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Create Routine Form */}
      {showCreate && (
        <form
          onSubmit={(e) => void handleCreate(e)}
          className="rounded-xl border border-indigo-500/30 bg-zinc-900/60 p-4 space-y-3 text-xs"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-zinc-400 mb-1">{t("routines.nameLabel")}</label>
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("routines.namePlaceholder")}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-zinc-100 focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-zinc-400 mb-1">{t("modal.dispatch.pipeline")}</label>
                <select
                  value={template}
                  onChange={(e) => setTemplate(e.target.value as PipelineTemplateId)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-100"
                >
                  <option value="fast">{formatTemplate("fast", locale)}</option>
                  <option value="standard">{formatTemplate("standard", locale)}</option>
                  <option value="strict">{formatTemplate("strict", locale)}</option>
                </select>
              </div>
              <div>
                <label className="block text-zinc-400 mb-1">{t("modal.dispatch.engine")}</label>
                <select
                  value={preferredEngine}
                  onChange={(e) => setPreferredEngine(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-100"
                >
                  <option value="">auto</option>
                  {availableEngines.map((eng) => (
                    <option key={eng} value={eng}>
                      {eng}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div>
            <label className="block text-zinc-400 mb-1">{t("routines.promptLabel")}</label>
            <textarea
              required
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100 focus:outline-none focus:border-indigo-500"
            />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
            <div>
              <label className="block text-zinc-400 mb-1">{t("routines.scheduleKind")}</label>
              <select
                value={scheduleKind}
                onChange={(e) => setScheduleKind(e.target.value as RoutineScheduleKind)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-zinc-100"
              >
                <option value="interval">{t("routines.kindInterval")}</option>
                <option value="cron">{t("routines.kindCron")}</option>
              </select>
            </div>
            <div>
              <label className="block text-zinc-400 mb-1">
                {scheduleKind === "cron" ? t("routines.cronLabel") : t("routines.intervalLabel")}
              </label>
              {scheduleKind === "cron" ? (
                <input
                  value={cronExpr}
                  onChange={(e) => setCronExpr(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 font-mono text-zinc-100"
                />
              ) : (
                <input
                  type="number"
                  min="1"
                  value={intervalMinutes}
                  onChange={(e) => setIntervalMinutes(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 font-mono text-zinc-100"
                />
              )}
            </div>
            <div>
              <label className="block text-zinc-400 mb-1">{t("routines.windowStart")}</label>
              <input
                value={windowStart}
                onChange={(e) => setWindowStart(e.target.value)}
                placeholder="23:00"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 font-mono text-zinc-100"
              />
            </div>
            <div>
              <label className="block text-zinc-400 mb-1">{t("routines.windowEnd")}</label>
              <input
                value={windowEnd}
                onChange={(e) => setWindowEnd(e.target.value)}
                placeholder="06:00"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 font-mono text-zinc-100"
              />
            </div>
            <div>
              <label className="block text-zinc-400 mb-1">{t("routines.budgetLabel")}</label>
              <input
                type="number"
                step="0.25"
                min="0.1"
                value={maxBudgetUsd}
                onChange={(e) => setMaxBudgetUsd(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 font-mono text-zinc-100"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-end justify-between gap-2 pt-1">
            <div className="flex-1 min-w-48">
              <label className="block text-zinc-400 mb-1">{t("routines.pathsLabel")}</label>
              <input
                value={allowedPaths}
                onChange={(e) => setAllowedPaths(e.target.value)}
                placeholder="**"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 font-mono text-emerald-300"
              />
            </div>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium disabled:opacity-50"
            >
              {t("routines.saveRoutineBtn")}
            </button>
          </div>
        </form>
      )}

      {/* Active Routines List */}
      {routines.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 p-8 text-center text-xs text-zinc-500">
          {t("routines.empty")}
        </div>
      ) : (
        <div className="space-y-3">
          {routines.map((r) => (
            <div
              key={r.id}
              className={`rounded-xl border p-4 space-y-2.5 transition ${
                r.enabled
                  ? "border-zinc-800 bg-zinc-900/60"
                  : "border-zinc-800/50 bg-zinc-900/20 opacity-70"
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-mono border ${
                        r.enabled
                          ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                          : "bg-zinc-800 text-zinc-400 border-zinc-700"
                      }`}
                    >
                      {r.enabled ? t("routines.enabled") : t("routines.paused")}
                    </span>
                    <span className="font-mono text-[10px] px-2 py-0.5 rounded bg-zinc-950 border border-zinc-800 text-zinc-300 flex items-center gap-1">
                      <Clock className="w-3 h-3 text-indigo-400" />
                      {r.scheduleKind === "cron" ? r.cronExpr : `${r.intervalMinutes}m`}
                      {r.activeHoursStart && r.activeHoursEnd
                        ? ` (${r.activeHoursStart}-${r.activeHoursEnd})`
                        : ""}
                    </span>
                    {r.lastRunStatus && (
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-mono border ${
                          RUN_STATUS_STYLE[r.lastRunStatus]
                        }`}
                      >
                        {t("routines.lastRunPrefix")} {statusLabel(r.lastRunStatus)}
                      </span>
                    )}
                    <span className="font-mono text-[10px] text-zinc-500">
                      ${r.maxBudgetUsd.toFixed(2)} · {r.template}
                    </span>
                  </div>
                  <h3 className="text-sm font-semibold text-zinc-100">{r.name}</h3>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  {r.activeTicketId && (
                    <button
                      type="button"
                      onClick={() => onInspectTicket(r.activeTicketId!)}
                      className="px-2.5 py-1 rounded border border-indigo-500/30 bg-indigo-500/15 text-indigo-200 text-[11px] hover:bg-indigo-500/25"
                    >
                      {t("routines.openTicket")}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={runningId === r.id}
                    onClick={() => void handleRunNow(r.id)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-emerald-500/40 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 text-[11px] font-medium disabled:opacity-50"
                  >
                    <Play className="w-3 h-3" />
                    {runningId === r.id ? t("routines.running") : t("routines.runNow")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleToggle(r)}
                    className="p-1.5 rounded border border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-zinc-200"
                    title={r.enabled ? t("routines.paused") : t("routines.enabled")}
                  >
                    {r.enabled ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(r.id)}
                    className="p-1.5 rounded border border-zinc-800 bg-zinc-950 text-zinc-500 hover:text-rose-400"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <p className="text-xs text-zinc-400 line-clamp-2">{r.prompt}</p>
              <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500">
                <span>[{r.allowedPaths.join(", ")}]</span>
                {r.nextRunAt && (
                  <span>
                    {t("routines.nextRunPrefix")} {new Date(r.nextRunAt).toLocaleString()}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Routine Runs Health Timeline */}
      <div className="space-y-2.5 pt-2 border-t border-zinc-900">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
          {t("routines.timelineTitle")} ({runs.length})
        </h3>
        {runs.length === 0 ? (
          <p className="text-xs text-zinc-500">{t("routines.timelineEmpty")}</p>
        ) : (
          <div className="space-y-1.5">
            {runs.map((run) => (
              <div
                key={run.id}
                className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3.5 py-2.5 text-xs flex flex-wrap items-center justify-between gap-3"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  {run.status === "clean" ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  ) : run.status === "failed" ? (
                    <XCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                  ) : run.status === "promoted" ? (
                    <Sparkles className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                  ) : (
                    <SkipForward className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                  )}
                  <span
                    className={`px-1.5 py-0.5 rounded font-mono text-[10px] border shrink-0 ${
                      RUN_STATUS_STYLE[run.status]
                    }`}
                  >
                    {statusLabel(run.status)}
                  </span>
                  <span className="font-medium text-zinc-200 shrink-0">
                    {routineNameById.get(run.routineId) ?? run.routineId}
                  </span>
                  <span className="text-zinc-400 truncate max-w-md">{run.summary}</span>
                </div>
                <div className="flex items-center gap-3 shrink-0 font-mono text-[10px] text-zinc-500">
                  {run.promotedTicketId && (
                    <button
                      type="button"
                      onClick={() => onInspectTicket(run.promotedTicketId!)}
                      className="text-indigo-400 hover:text-indigo-300"
                    >
                      {run.promotedTicketId} →
                    </button>
                  )}
                  <span>${run.costUsd.toFixed(3)}</span>
                  <span>{run.startedAt.slice(11, 19)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
