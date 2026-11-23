import { useEffect, useState } from "react";
import { FolderGit2, GitBranch, Layers, Plus, RefreshCw, Sparkles, Trash2, X } from "lucide-react";
import { api } from "../api.ts";
import { formatTemplate, formatTicketStatus, useI18n } from "../i18n.tsx";
import type {
  DeliveryChannel,
  EpicDecompositionPlan,
  EpicSubtaskSpec,
  ManagedWorktreeItem,
  OperatingMode,
  PipelineTemplateId,
  ReasoningEffort,
  RepoConfig,
  WorkerEngineId,
  WorktreeGcResult,
} from "../types.ts";

interface DispatchModalProps {
  open: boolean;
  repoId: string;
  availableEngines: WorkerEngineId[];
  defaultTemplate: PipelineTemplateId;
  defaultEngine: WorkerEngineId;
  onClose: () => void;
  onSubmit: (data: {
    title: string;
    description: string;
    template: PipelineTemplateId;
    allowedPaths: string[];
    preferredEngine: WorkerEngineId;
    modelOverride?: string;
    effortOverride?: ReasoningEffort;
    maxCostUsd: number;
  }) => Promise<void>;
  onCreateEpic: (data: {
    repoId: string;
    title: string;
    description: string;
    template: PipelineTemplateId;
    preferredEngine: WorkerEngineId;
    modelOverride?: string;
    effortOverride?: ReasoningEffort;
    maxCostUsdPerSubtask: number;
    subtasks?: EpicSubtaskSpec[];
  }) => Promise<void>;
}

export function DispatchTaskModal({
  open,
  repoId,
  availableEngines,
  defaultTemplate,
  defaultEngine,
  onClose,
  onSubmit,
  onCreateEpic,
}: DispatchModalProps) {
  const { locale, t } = useI18n();
  const [dispatchMode, setDispatchMode] = useState<"single" | "epic">("single");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [template, setTemplate] = useState<PipelineTemplateId>(defaultTemplate);
  const [paths, setPaths] = useState("**");
  const [engine, setEngine] = useState<WorkerEngineId>(defaultEngine);
  const [modelOverride, setModelOverride] = useState("");
  const [effortOverride, setEffortOverride] = useState<ReasoningEffort | "">("");
  const [budget, setBudget] = useState("2.0");
  const [epicPlan, setEpicPlan] = useState<EpicDecompositionPlan | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setDispatchMode("single");
      setTemplate(defaultTemplate);
      setEngine(defaultEngine);
      setModelOverride("");
      setEffortOverride("");
      setEpicPlan(null);
    }
  }, [open, defaultTemplate, defaultEngine]);

  if (!open) return null;

  const isCliEngine = engine === "claude" || engine === "codex" || engine === "opencode";

  const handlePreviewEpic = async () => {
    if (!title.trim() || !description.trim()) return;
    setPreviewing(true);
    try {
      const res = await api.previewEpic({
        repoId,
        title: title.trim(),
        description: description.trim(),
        template,
      });
      setEpicPlan(res.plan);
    } finally {
      setPreviewing(false);
    }
  };

  const updateSubtask = (idx: number, patch: Partial<EpicSubtaskSpec>) => {
    setEpicPlan((prev) => {
      if (!prev) return prev;
      const next = [...prev.subtasks];
      next[idx] = { ...next[idx]!, ...patch };
      return { ...prev, subtasks: next };
    });
  };

  const removeSubtask = (idx: number) => {
    setEpicPlan((prev) => {
      if (!prev) return prev;
      const removedKey = prev.subtasks[idx]?.key;
      const remaining = prev.subtasks
        .filter((_, i) => i !== idx)
        .map((s) => ({
          ...s,
          dependsOnKeys: s.dependsOnKeys.filter((k) => k !== removedKey),
        }));
      return { ...prev, subtasks: remaining };
    });
  };

  const addEmptySubtask = () => {
    setEpicPlan((prev) => {
      const idx = (prev?.subtasks.length ?? 0) + 1;
      const newSub: EpicSubtaskSpec = {
        key: `step_${idx}`,
        title: `Subtask ${idx}`,
        description: description.trim() || `Subtask ${idx}`,
        template,
        allowedPaths: ["**"],
        dependsOnKeys: [],
        acceptanceCriteria: ["Passes verification"],
      };
      return prev
        ? { ...prev, subtasks: [...prev.subtasks, newSub] }
        : { epicTitle: title.trim() || "Epic", summary: "", subtasks: [newSub] };
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !description.trim()) return;
    setSubmitting(true);
    try {
      if (dispatchMode === "epic") {
        await onCreateEpic({
          repoId,
          title: title.trim(),
          description: description.trim(),
          template,
          preferredEngine: engine,
          modelOverride: isCliEngine ? modelOverride.trim() || undefined : undefined,
          effortOverride: isCliEngine ? effortOverride || undefined : undefined,
          maxCostUsdPerSubtask: Number(budget) || 2.0,
          subtasks: epicPlan?.subtasks,
        });
      } else {
        await onSubmit({
          title: title.trim(),
          description: description.trim(),
          template,
          allowedPaths: paths
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          preferredEngine: engine,
          modelOverride: isCliEngine ? modelOverride.trim() || undefined : undefined,
          effortOverride: isCliEngine ? effortOverride || undefined : undefined,
          maxCostUsd: Number(budget) || 2.0,
        });
      }
      setTitle("");
      setDescription("");
      setEpicPlan(null);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 overflow-y-auto">
      <div
        className={`w-full ${dispatchMode === "epic" ? "max-w-2xl" : "max-w-lg"} rounded-xl border border-zinc-800 bg-zinc-950 p-5 space-y-4 shadow-2xl my-4 transition-all`}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-100">{t("modal.dispatch.title")}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Mode Switcher */}
        <div className="grid grid-cols-2 gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/70 p-1 text-xs">
          <button
            type="button"
            onClick={() => setDispatchMode("single")}
            className={`py-1.5 rounded-md font-medium transition ${
              dispatchMode === "single"
                ? "bg-indigo-600 text-white"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {t("modal.dispatch.modeSingle")}
          </button>
          <button
            type="button"
            onClick={() => setDispatchMode("epic")}
            className={`inline-flex items-center justify-center gap-1.5 py-1.5 rounded-md font-medium transition ${
              dispatchMode === "epic"
                ? "bg-indigo-600 text-white"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            {t("modal.dispatch.modeEpic")}
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3 text-xs">
          <div>
            <label className="block text-zinc-400 mb-1">{t("modal.dispatch.taskTitle")}</label>
            <input
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("modal.dispatch.taskPlaceholder")}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100 focus:outline-none focus:border-indigo-500"
            />
          </div>
          <div>
            <label className="block text-zinc-400 mb-1">{t("modal.dispatch.goalLabel")}</label>
            <textarea
              required
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("modal.dispatch.goalPlaceholder")}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100 focus:outline-none focus:border-indigo-500"
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-zinc-400 mb-1">{t("modal.dispatch.pipeline")}</label>
              <select
                value={template}
                onChange={(e) => setTemplate(e.target.value as PipelineTemplateId)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 text-zinc-100"
              >
                <option value="fast">{formatTemplate("fast", locale)}</option>
                <option value="standard">{formatTemplate("standard", locale)}</option>
                <option value="strict">{formatTemplate("strict", locale)}</option>
              </select>
            </div>
            <div>
              <label className="block text-zinc-400 mb-1">{t("modal.dispatch.engine")}</label>
              <select
                value={engine}
                onChange={(e) => setEngine(e.target.value as WorkerEngineId)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 text-zinc-100"
              >
                {availableEngines.map((eng) => (
                  <option key={eng} value={eng}>
                    {eng}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-zinc-400 mb-1">
                {dispatchMode === "epic"
                  ? t("modal.dispatch.epicBudget")
                  : t("modal.dispatch.budget")}
              </label>
              <input
                type="number"
                step="0.25"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 text-zinc-100"
              />
            </div>
          </div>
          {isCliEngine && (
            <div className="grid grid-cols-2 gap-3 rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-3">
              <div>
                <label className="block text-zinc-400 mb-1">
                  {t("modal.dispatch.modelOverride")}
                </label>
                <input
                  list={engine === "claude" ? "dispatch-claude-models" : undefined}
                  value={modelOverride}
                  onChange={(e) => setModelOverride(e.target.value)}
                  placeholder={
                    engine === "opencode" ? "provider/model" : t("modal.dispatch.inheritGlobal")
                  }
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 font-mono text-zinc-100 focus:outline-none focus:border-indigo-500"
                />
                {engine === "claude" && (
                  <datalist id="dispatch-claude-models">
                    <option value="sonnet" />
                    <option value="opus" />
                    <option value="fable" />
                  </datalist>
                )}
              </div>
              <div>
                <label className="block text-zinc-400 mb-1">
                  {t("modal.dispatch.effortOverride")}
                </label>
                <select
                  value={effortOverride}
                  onChange={(e) => setEffortOverride(e.target.value as ReasoningEffort | "")}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-100"
                >
                  <option value="">{t("modal.dispatch.inheritGlobal")}</option>
                  <option value="low">{t("setup.effort.low")}</option>
                  <option value="medium">{t("setup.effort.medium")}</option>
                  <option value="high">{t("setup.effort.high")}</option>
                  <option value="xhigh">{t("setup.effort.xhigh")}</option>
                  {(engine === "claude" || engine === "opencode") && (
                    <option value="max">{t("setup.effort.max")}</option>
                  )}
                </select>
              </div>
            </div>
          )}

          {dispatchMode === "single" ? (
            <div>
              <label className="block text-zinc-400 mb-1">{t("modal.dispatch.paths")}</label>
              <input
                value={paths}
                onChange={(e) => setPaths(e.target.value)}
                placeholder={t("modal.dispatch.pathsPlaceholder")}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
              />
            </div>
          ) : (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3.5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-zinc-200 flex items-center gap-1.5">
                  <GitBranch className="w-3.5 h-3.5 text-indigo-400" />
                  {t("modal.dispatch.epicPreviewTitle")}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={addEmptySubtask}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 text-[11px]"
                  >
                    <Plus className="w-3 h-3" />
                    {t("modal.dispatch.epicAddSubtask").replace("+ ", "")}
                  </button>
                  <button
                    type="button"
                    disabled={previewing || !title.trim() || !description.trim()}
                    onClick={() => void handlePreviewEpic()}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-indigo-500/40 bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-200 text-[11px] disabled:opacity-40"
                  >
                    <Sparkles className={`w-3 h-3 ${previewing ? "animate-spin" : ""}`} />
                    {previewing
                      ? t("modal.dispatch.epicPreviewing")
                      : t("modal.dispatch.epicPreviewBtn")}
                  </button>
                </div>
              </div>

              {!epicPlan ? (
                <p className="text-[11px] text-zinc-400 leading-relaxed">
                  {t("modal.dispatch.epicEmptyHint")}
                </p>
              ) : (
                <div className="max-h-56 overflow-y-auto space-y-2 pr-1">
                  {epicPlan.subtasks.map((sub, idx) => (
                    <div
                      key={`${sub.key}_${idx}`}
                      className="rounded-lg border border-zinc-800 bg-zinc-950/90 p-2.5 space-y-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <span className="px-1.5 py-0.5 rounded bg-indigo-500/15 border border-indigo-500/30 font-mono text-[10px] text-indigo-300 shrink-0">
                            {sub.key}
                          </span>
                          <input
                            value={sub.title}
                            onChange={(e) => updateSubtask(idx, { title: e.target.value })}
                            className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-zinc-100 text-[11px]"
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => removeSubtask(idx)}
                          className="p-1 text-zinc-500 hover:text-rose-400"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 items-center">
                        <input
                          value={sub.allowedPaths.join(", ")}
                          onChange={(e) =>
                            updateSubtask(idx, {
                              allowedPaths: e.target.value
                                .split(",")
                                .map((s) => s.trim())
                                .filter(Boolean),
                            })
                          }
                          placeholder="packages/core/**"
                          className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1 font-mono text-[10px] text-emerald-300"
                        />
                        <div className="text-[10px] font-mono text-zinc-400 flex items-center gap-1 flex-wrap">
                          <span>{t("modal.dispatch.epicDependsOn")}</span>
                          {sub.dependsOnKeys.length === 0 ? (
                            <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">
                              {t("modal.dispatch.epicParallel")}
                            </span>
                          ) : (
                            sub.dependsOnKeys.map((dep) => (
                              <span
                                key={dep}
                                className="px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-300 border border-amber-500/20"
                              >
                                {dep}
                              </span>
                            ))
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg border border-zinc-800 text-zinc-400 hover:text-zinc-200"
            >
              {t("modal.dispatch.cancel")}
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium disabled:opacity-50"
            >
              {submitting
                ? t("modal.dispatch.submitting")
                : dispatchMode === "epic"
                  ? t("modal.dispatch.epicDispatchBtn")
                  : t("modal.dispatch.submit")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface SimulateModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: {
    source: "github_issue" | "github_pr" | "github_ci" | "cli";
    threadKey: string;
    title: string;
    rawText: string;
  }) => Promise<void>;
}

export function SimulateEventModal({ open, onClose, onSubmit }: SimulateModalProps) {
  const { t } = useI18n();
  const [source, setSource] = useState<"github_issue" | "github_pr" | "github_ci" | "cli">(
    "github_issue",
  );
  const [threadKey, setThreadKey] = useState(`gh:issue:${Math.floor(100 + Math.random() * 899)}`);
  const [title, setTitle] = useState("");
  const [rawText, setRawText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !rawText.trim()) return;
    setSubmitting(true);
    try {
      await onSubmit({
        source,
        threadKey: threadKey.trim(),
        title: title.trim(),
        rawText: rawText.trim(),
      });
      setTitle("");
      setRawText("");
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
      <div className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-950 p-5 space-y-4 shadow-2xl">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-100">{t("modal.simulate.title")}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-[11px] text-zinc-400">
          {t("modal.simulate.descPrefix")}{" "}
          <code className="text-amber-300">observe</code> {t("modal.simulate.descMiddle")}{" "}
          <code className="text-emerald-300">auto</code> {t("modal.simulate.descSuffix")}
        </p>

        <form onSubmit={handleSubmit} className="space-y-3 text-xs">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-zinc-400 mb-1">{t("modal.simulate.source")}</label>
              <select
                value={source}
                onChange={(e) => setSource(e.target.value as typeof source)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 text-zinc-100"
              >
                <option value="github_issue">github_issue</option>
                <option value="github_pr">github_pr</option>
                <option value="github_ci">github_ci</option>
                <option value="cli">cli</option>
              </select>
            </div>
            <div>
              <label className="block text-zinc-400 mb-1">{t("modal.simulate.threadKey")}</label>
              <input
                required
                value={threadKey}
                onChange={(e) => setThreadKey(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
              />
            </div>
          </div>
          <div>
            <label className="block text-zinc-400 mb-1">{t("modal.simulate.eventTitle")}</label>
            <input
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("modal.simulate.eventPlaceholder")}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100"
            />
          </div>
          <div>
            <label className="block text-zinc-400 mb-1">{t("modal.simulate.eventBody")}</label>
            <textarea
              required
              rows={3}
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              placeholder={t("modal.simulate.bodyPlaceholder")}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg border border-zinc-800 text-zinc-400 hover:text-zinc-200"
            >
              {t("modal.simulate.cancel")}
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-medium disabled:opacity-50"
            >
              {submitting ? t("modal.simulate.submitting") : t("modal.simulate.submit")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface AddRepoModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: {
    name: string;
    rootPath: string;
    baseBranch: string;
    githubRepo?: string;
    mode: OperatingMode;
  }) => Promise<void>;
}

export function AddRepoModal({ open, onClose, onSubmit }: AddRepoModalProps) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [githubRepo, setGithubRepo] = useState("");
  const [mode, setMode] = useState<OperatingMode>("observe");
  const [submitting, setSubmitting] = useState(false);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !rootPath.trim()) return;
    setSubmitting(true);
    try {
      await onSubmit({
        name: name.trim(),
        rootPath: rootPath.trim(),
        baseBranch: baseBranch.trim() || "main",
        githubRepo: githubRepo.trim() || undefined,
        mode,
      });
      setName("");
      setRootPath("");
      setGithubRepo("");
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
      <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 p-5 space-y-4 shadow-2xl">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-100">{t("modal.repo.title")}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3 text-xs">
          <div>
            <label className="block text-zinc-400 mb-1">{t("modal.repo.name")}</label>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("modal.repo.namePlaceholder")}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100"
            />
          </div>
          <div>
            <label className="block text-zinc-400 mb-1">{t("modal.repo.path")}</label>
            <input
              required
              value={rootPath}
              onChange={(e) => setRootPath(e.target.value)}
              placeholder={t("modal.repo.pathPlaceholder")}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-zinc-400 mb-1">{t("modal.repo.baseBranch")}</label>
              <input
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
              />
            </div>
            <div>
              <label className="block text-zinc-400 mb-1">{t("modal.repo.initialMode")}</label>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as OperatingMode)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 text-zinc-100"
              >
                <option value="observe">{t("header.mode.observe")} (observe)</option>
                <option value="auto">{t("header.mode.auto")} (auto)</option>
                <option value="off">{t("header.mode.off")} (off)</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-zinc-400 mb-1">{t("modal.repo.githubRepo")}</label>
            <input
              value={githubRepo}
              onChange={(e) => setGithubRepo(e.target.value)}
              placeholder={t("modal.repo.githubPlaceholder")}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg border border-zinc-800 text-zinc-400 hover:text-zinc-200"
            >
              {t("modal.repo.cancel")}
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium disabled:opacity-50"
            >
              {t("modal.repo.submit")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface RepoSettingsModalProps {
  open: boolean;
  repo: RepoConfig | null;
  availableEngines: WorkerEngineId[];
  onClose: () => void;
  onSubmit: (repoId: string, patch: Partial<RepoConfig>) => Promise<void>;
}

export function RepoSettingsModal({
  open,
  repo,
  availableEngines,
  onClose,
  onSubmit,
}: RepoSettingsModalProps) {
  const { locale, t } = useI18n();
  const [name, setName] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [githubRepo, setGithubRepo] = useState("");
  const [mode, setMode] = useState<OperatingMode>("observe");
  const [defaultTemplate, setDefaultTemplate] = useState<PipelineTemplateId>("standard");
  const [implEngine, setImplEngine] = useState<WorkerEngineId>("claude");
  const [reviewEngine, setReviewEngine] = useState<WorkerEngineId>("codex");
  const [deliveryChannel, setDeliveryChannel] = useState<DeliveryChannel>("auto_pr_or_branch");
  const [verificationInput, setVerificationInput] = useState("");
  const [autoCleanupWorktree, setAutoCleanupWorktree] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open || !repo) return;
    setName(repo.name);
    setBaseBranch(repo.baseBranch);
    setGithubRepo(repo.githubRepo ?? "");
    setMode(repo.mode);
    setDefaultTemplate(repo.defaultTemplate);
    setImplEngine(repo.preferredImplementEngine);
    setReviewEngine(repo.preferredReviewEngine);
    setDeliveryChannel(repo.defaultDeliveryChannel ?? "auto_pr_or_branch");
    setVerificationInput((repo.verificationCommands ?? []).join(", "));
    setAutoCleanupWorktree(repo.autoCleanupWorktree !== false);
  }, [open, repo]);

  if (!open || !repo) return null;

  const engineOptions = Array.from(
    new Set<WorkerEngineId>([
      ...availableEngines,
      repo.preferredImplementEngine,
      repo.preferredReviewEngine,
      "mock",
    ]),
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      const verificationCommands = verificationInput
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      await onSubmit(repo.id, {
        name: name.trim(),
        baseBranch: baseBranch.trim() || "main",
        githubRepo: githubRepo.trim(),
        mode,
        defaultTemplate,
        preferredImplementEngine: implEngine,
        preferredReviewEngine: reviewEngine,
        defaultDeliveryChannel: deliveryChannel,
        verificationCommands,
        autoCleanupWorktree,
      });
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
      <div className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-950 p-5 space-y-4 shadow-2xl">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-100">{t("modal.repoSettings.title")}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3 text-xs">
          <div>
            <label className="block text-zinc-400 mb-1">{t("modal.repoSettings.rootPath")}</label>
            <div className="w-full bg-zinc-900/60 border border-zinc-800/80 rounded-lg px-3 py-2 font-mono text-zinc-400 truncate">
              {repo.rootPath}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-zinc-400 mb-1">{t("modal.repo.name")}</label>
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100"
              />
            </div>
            <div>
              <label className="block text-zinc-400 mb-1">{t("modal.repo.baseBranch")}</label>
              <input
                required
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-zinc-400 mb-1">
                {t("modal.repoSettings.defaultTemplate")}
              </label>
              <select
                value={defaultTemplate}
                onChange={(e) => setDefaultTemplate(e.target.value as PipelineTemplateId)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 text-zinc-100"
              >
                <option value="fast">{formatTemplate("fast", locale)}</option>
                <option value="standard">{formatTemplate("standard", locale)}</option>
                <option value="strict">{formatTemplate("strict", locale)}</option>
              </select>
            </div>
            <div>
              <label className="block text-zinc-400 mb-1">{t("modal.repo.initialMode")}</label>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as OperatingMode)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 text-zinc-100"
              >
                <option value="observe">{t("header.mode.observe")} (observe)</option>
                <option value="auto">{t("header.mode.auto")} (auto)</option>
                <option value="off">{t("header.mode.off")} (off)</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-zinc-400 mb-1">
                {t("modal.repoSettings.implEngine")}
              </label>
              <select
                value={implEngine}
                onChange={(e) => setImplEngine(e.target.value as WorkerEngineId)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 font-mono text-zinc-100"
              >
                {engineOptions.map((eng) => (
                  <option key={eng} value={eng}>
                    {eng}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-zinc-400 mb-1">
                {t("modal.repoSettings.reviewEngine")}
              </label>
              <select
                value={reviewEngine}
                onChange={(e) => setReviewEngine(e.target.value as WorkerEngineId)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 font-mono text-zinc-100"
              >
                {engineOptions.map((eng) => (
                  <option key={eng} value={eng}>
                    {eng}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-zinc-400 mb-1">{t("modal.repo.githubRepo")}</label>
            <input
              value={githubRepo}
              onChange={(e) => setGithubRepo(e.target.value)}
              placeholder={t("modal.repo.githubPlaceholder")}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
            />
          </div>

          <div>
            <label className="block text-zinc-400 mb-1">
              {t("modal.repoSettings.deliveryChannel")}
            </label>
            <select
              value={deliveryChannel}
              onChange={(e) => setDeliveryChannel(e.target.value as DeliveryChannel)}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 text-zinc-100"
            >
              <option value="auto_pr_or_branch">{t("modal.repoSettings.channel.auto")}</option>
              <option value="local_merge">{t("modal.repoSettings.channel.localMerge")}</option>
              <option value="github_pr">{t("modal.repoSettings.channel.githubPr")}</option>
            </select>
          </div>

          <div>
            <label className="block text-zinc-400 mb-1">
              {t("modal.repoSettings.verificationCommands")}
            </label>
            <input
              value={verificationInput}
              onChange={(e) => setVerificationInput(e.target.value)}
              placeholder={t("modal.repoSettings.verificationPlaceholder")}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
            />
            <p className="text-[11px] text-zinc-500 mt-1">
              {t("modal.repoSettings.verificationHint")}
            </p>
          </div>

          <label className="flex items-start gap-2.5 rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-3 cursor-pointer">
            <input
              type="checkbox"
              checked={autoCleanupWorktree}
              onChange={(e) => setAutoCleanupWorktree(e.target.checked)}
              className="mt-0.5 rounded border-zinc-700 bg-zinc-950 text-indigo-500 focus:ring-indigo-500"
            />
            <div>
              <div className="font-medium text-zinc-200">
                {t("modal.repoSettings.autoCleanupLabel")}
              </div>
              <p className="text-[11px] text-zinc-400 mt-0.5">
                {t("modal.repoSettings.autoCleanupDesc")}
              </p>
            </div>
          </label>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg border border-zinc-800 text-zinc-400 hover:text-zinc-200"
            >
              {t("modal.repo.cancel")}
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium disabled:opacity-50"
            >
              {submitting ? t("modal.repoSettings.saving") : t("modal.repoSettings.save")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface WorktreeManagerModalProps {
  open: boolean;
  repoId?: string;
  onClose: () => void;
  onChanged: () => void;
}

export function WorktreeManagerModal({
  open,
  repoId,
  onClose,
  onChanged,
}: WorktreeManagerModalProps) {
  const { locale, t } = useI18n();
  const [items, setItems] = useState<ManagedWorktreeItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [gcing, setGcing] = useState(false);
  const [gcResult, setGcResult] = useState<WorktreeGcResult | null>(null);

  const loadWorktrees = async () => {
    setLoading(true);
    try {
      const res = await api.listWorktrees(repoId);
      setItems(res.items);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setGcResult(null);
    void loadWorktrees();
  }, [open, repoId]);

  if (!open) return null;

  const reclaimableCount = items.filter((item) => item.reclaimable).length;

  const handleGcAll = async () => {
    setGcing(true);
    try {
      const res = await api.gcWorktrees(repoId);
      setItems(res.items);
      setGcResult(res.result);
      onChanged();
    } finally {
      setGcing(false);
    }
  };

  const handleReclaimOne = async (ticketId: string) => {
    await api.cleanupTicketWorktree(ticketId);
    await loadWorktrees();
    onChanged();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
      <div className="w-full max-w-2xl rounded-xl border border-zinc-800 bg-zinc-950 p-5 space-y-4 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-sky-500/15 border border-sky-500/30 flex items-center justify-center text-sky-400">
              <FolderGit2 className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-zinc-100">{t("modal.worktrees.title")}</h3>
              <p className="text-[11px] text-zinc-400">{t("modal.worktrees.subtitle")}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200">
            <X className="w-4 h-4" />
          </button>
        </div>

        {gcResult && (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
            {t("modal.worktrees.gcResultBanner")
              .replace("{removed}", String(gcResult.removedPaths.length))
              .replace("{skipped}", String(gcResult.skippedActiveCount))}
          </div>
        )}

        <div className="max-h-72 overflow-y-auto space-y-2 text-xs">
          {loading && items.length === 0 ? (
            <div className="py-8 text-center text-zinc-500">{t("drawer.loading")}</div>
          ) : items.length === 0 ? (
            <div className="py-8 text-center rounded-lg border border-dashed border-zinc-800 text-zinc-500">
              {t("modal.worktrees.empty")}
            </div>
          ) : (
            items.map((item) => (
              <div
                key={item.path}
                className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2.5"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-mono border ${
                        !item.reclaimable
                          ? "border-indigo-500/30 bg-indigo-500/15 text-indigo-300"
                          : item.isOrphan
                            ? "border-amber-500/30 bg-amber-500/15 text-amber-300"
                            : "border-emerald-500/30 bg-emerald-500/15 text-emerald-300"
                      }`}
                    >
                      {!item.reclaimable
                        ? t("modal.worktrees.activeBadge")
                        : item.isOrphan
                          ? t("modal.worktrees.orphanBadge")
                          : t("modal.worktrees.reclaimableBadge")}
                    </span>
                    {item.ticketId && (
                      <span className="font-mono text-[11px] text-indigo-300">
                        {item.ticketId}
                      </span>
                    )}
                    {item.ticketStatus && (
                      <span className="text-[11px] text-zinc-400">
                        ({formatTicketStatus(item.ticketStatus, locale)})
                      </span>
                    )}
                    {item.ticketTitle && (
                      <span className="text-zinc-200 font-medium truncate max-w-xs">
                        {item.ticketTitle}
                      </span>
                    )}
                  </div>
                  <div className="font-mono text-[10px] text-zinc-500 truncate">{item.path}</div>
                </div>

                {item.reclaimable && item.ticketId && (
                  <button
                    type="button"
                    onClick={() => void handleReclaimOne(item.ticketId!)}
                    className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 text-[11px]"
                  >
                    <Trash2 className="w-3 h-3 text-amber-400" />
                    {t("modal.worktrees.reclaimOne")}
                  </button>
                )}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-zinc-800/80 text-xs">
          <button
            type="button"
            onClick={() => void loadWorktrees()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-800 text-zinc-300 hover:bg-zinc-900 disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
            {t("modal.worktrees.refresh")}
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg border border-zinc-800 text-zinc-400 hover:text-zinc-200"
            >
              {t("modal.worktrees.close")}
            </button>
            <button
              type="button"
              onClick={() => void handleGcAll()}
              disabled={gcing || reclaimableCount === 0}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-medium disabled:opacity-40"
            >
              <Trash2 className="w-3.5 h-3.5" />
              {gcing ? t("modal.worktrees.gcing") : `${t("modal.worktrees.gcButton")} (${reclaimableCount})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
