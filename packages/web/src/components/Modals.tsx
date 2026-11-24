import { useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BookOpen,
  ChevronDown,
  ChevronUp,
  Database,
  Download,
  ExternalLink,
  Eye,
  FileJson2,
  FolderGit2,
  GitBranch,
  Layers,
  Pin,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Upload,
  X,
} from "lucide-react";

function useEscapeKey(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);
}

function computeSubtaskWaves(subtasks: EpicSubtaskSpec[]): {
  waves: EpicSubtaskSpec[][];
  waveByKey: Map<string, number>;
} {
  const waves: EpicSubtaskSpec[][] = [];
  const waveByKey = new Map<string, number>();
  const remaining = [...subtasks];
  const validKeys = new Set(subtasks.map((s) => s.key));

  while (remaining.length > 0) {
    const ready = remaining.filter((s) =>
      s.dependsOnKeys.filter((d) => validKeys.has(d)).every((d) => waveByKey.has(d)),
    );
    const waveIndex = waves.length + 1;
    const batch = ready.length > 0 ? ready : [remaining[0]!];
    waves.push(batch);
    for (const item of batch) {
      waveByKey.set(item.key, waveIndex);
      const pos = remaining.findIndex((r) => r.key === item.key);
      if (pos >= 0) remaining.splice(pos, 1);
    }
  }

  return { waves, waveByKey };
}
import { api } from "../api.ts";
import { formatTemplate, formatTicketStatus, useI18n } from "../i18n.tsx";
import type {
  BrowserInteractionStep,
  CasebookEntry,
  DeliveryChannel,
  EnginePreference,
  EpicDecompositionPlan,
  EpicDeliveryMode,
  EpicSubtaskSpec,
  ManagedWorktreeItem,
  OperatingMode,
  PipelineTemplateId,
  PlaybookEntry,
  PreviewSession,
  ReasoningEffort,
  RepoConfig,
  SandboxMode,
  SmokeCheckConfig,
  SmokeTriggerMode,
  SpecClarificationResult,
  Ticket,
  VisualDiffMode,
  WorkerEngineId,
  WorktreeGcResult,
} from "../types.ts";

interface DispatchModalProps {
  open: boolean;
  repoId: string;
  repos?: RepoConfig[];
  allTickets?: Ticket[];
  availableEngines: WorkerEngineId[];
  defaultTemplate: PipelineTemplateId;
  defaultEngine: EnginePreference;
  defaultTddMode?: boolean;
  onClose: () => void;
  onSubmit: (data: {
    title: string;
    description: string;
    template: PipelineTemplateId;
    allowedPaths: string[];
    dependsOn?: string[];
    preferredEngine: EnginePreference;
    tddMode?: boolean;
    pauseBeforeRun?: boolean;
    arenaMode?: boolean;
    arenaCompetitorEngine?: WorkerEngineId;
    modelOverride?: string;
    effortOverride?: ReasoningEffort;
    acceptanceCriteria?: string[];
    maxCostUsd: number;
  }) => Promise<void>;
  onCreateEpic: (data: {
    repoId: string;
    title: string;
    description: string;
    template: PipelineTemplateId;
    epicDeliveryMode: EpicDeliveryMode;
    preferredEngine: EnginePreference;
    tddMode?: boolean;
    modelOverride?: string;
    effortOverride?: ReasoningEffort;
    maxCostUsdPerSubtask: number;
    subtasks?: EpicSubtaskSpec[];
  }) => Promise<void>;
}

export function DispatchTaskModal({
  open,
  repoId,
  repos = [],
  allTickets = [],
  availableEngines,
  defaultTemplate,
  defaultEngine,
  defaultTddMode = false,
  onClose,
  onSubmit,
  onCreateEpic,
}: DispatchModalProps) {
  const { locale, t } = useI18n();
  const [dispatchMode, setDispatchMode] = useState<"single" | "epic">("single");
  const [epicDeliveryMode, setEpicDeliveryMode] = useState<EpicDeliveryMode>("unified");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [template, setTemplate] = useState<PipelineTemplateId>(defaultTemplate);
  const [paths, setPaths] = useState("**");
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [depsExpanded, setDepsExpanded] = useState(false);
  const [depsQuery, setDepsQuery] = useState("");
  const [engine, setEngine] = useState<EnginePreference>(defaultEngine);
  const [tddMode, setTddMode] = useState(Boolean(defaultTddMode));
  const [pauseBeforeRun, setPauseBeforeRun] = useState(false);
  const [arenaMode, setArenaMode] = useState(false);
  const [arenaCompetitorEngine, setArenaCompetitorEngine] = useState<string>("");
  const [modelOverride, setModelOverride] = useState("");
  const [effortOverride, setEffortOverride] = useState<ReasoningEffort | "">("");
  const [budget, setBudget] = useState("2.0");
  const [epicPlan, setEpicPlan] = useState<EpicDecompositionPlan | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [clarifying, setClarifying] = useState(false);
  const [clarification, setClarification] = useState<SpecClarificationResult | null>(null);
  const [clarifyAnswers, setClarifyAnswers] = useState<Record<string, string>>({});
  const [acceptanceCriteria, setAcceptanceCriteria] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const reposById = new Map(repos.map((r) => [r.id, r]));
  const distinctEpicRepos = new Set(
    (epicPlan?.subtasks ?? []).map((s) => s.repoId || repoId),
  );
  const hasCrossRepoSubtasks =
    distinctEpicRepos.size > 1 || (distinctEpicRepos.size === 1 && !distinctEpicRepos.has(repoId));

  useEffect(() => {
    if (open) {
      setDispatchMode("single");
      setEpicDeliveryMode("unified");
      setTemplate(defaultTemplate);
      setEngine(defaultEngine);
      setTddMode(Boolean(defaultTddMode));
      setPauseBeforeRun(false);
      setArenaMode(false);
      setArenaCompetitorEngine("");
      setModelOverride("");
      setEffortOverride("");
      setDependsOn([]);
      setDepsExpanded(false);
      setDepsQuery("");
      setEpicPlan(null);
      setClarification(null);
      setClarifyAnswers({});
      setAcceptanceCriteria([]);
    }
  }, [open, defaultTemplate, defaultEngine, defaultTddMode]);

  useEscapeKey(open, onClose);

  useEffect(() => {
    if (hasCrossRepoSubtasks) {
      setEpicDeliveryMode("per_subtask");
    }
  }, [hasCrossRepoSubtasks]);

  if (!open) return null;

  const isCliEngine = engine === "claude" || engine === "codex" || engine === "opencode";
  const allCandidates = [...allTickets]
    .filter((tkt) => !tkt.isEpic && tkt.status !== "cancelled")
    .reverse();
  const normalizedDepsQuery = depsQuery.trim().toLowerCase();
  const filteredDepCandidates = allCandidates
    .filter((cand) => {
      if (!normalizedDepsQuery) return true;
      const repoLabel = reposById.get(cand.repoId)?.name ?? cand.repoId;
      return (
        cand.title.toLowerCase().includes(normalizedDepsQuery) ||
        cand.id.toLowerCase().includes(normalizedDepsQuery) ||
        repoLabel.toLowerCase().includes(normalizedDepsQuery)
      );
    })
    .slice(0, 18);

  const epicTopology = epicPlan ? computeSubtaskWaves(epicPlan.subtasks) : null;

  const toggleDependsOnId = (id: string) => {
    setDependsOn((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  };

  const handleClarifySpec = async () => {
    if (!title.trim() || !description.trim()) return;
    setClarifying(true);
    try {
      const res = await api.clarifySpec({
        repoId,
        title: title.trim(),
        description: description.trim(),
        template,
      });
      setClarification(res.clarification);
      const defaults: Record<string, string> = {};
      for (const q of res.clarification.questions) {
        const rec = q.options[q.recommendedIndex] ?? q.options[0];
        if (rec) defaults[q.id] = rec;
      }
      setClarifyAnswers(defaults);
    } finally {
      setClarifying(false);
    }
  };

  const handleApplyClarification = async () => {
    if (!clarification) return;
    setClarifying(true);
    try {
      const res = await api.clarifySpec({
        repoId,
        title: title.trim(),
        description: description.trim(),
        template,
        answers: clarifyAnswers,
      });
      const refined = res.clarification;
      setTitle(refined.refinedTitle);
      setDescription(refined.refinedDescription);
      setTemplate(refined.recommendedTemplate);
      setPaths(refined.suggestedAllowedPaths.join(", "));
      setAcceptanceCriteria(refined.acceptanceCriteria);
      if (refined.recommendedTddMode !== undefined) {
        setTddMode(refined.recommendedTddMode);
      }
      if (refined.recommendedDispatchMode === "epic") {
        setDispatchMode("epic");
      }
      setClarification(refined);
    } finally {
      setClarifying(false);
    }
  };

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

  const toggleSubtaskDependency = (idx: number, depKey: string) => {
    setEpicPlan((prev) => {
      if (!prev) return prev;
      const target = prev.subtasks[idx];
      if (!target) return prev;
      const exists = target.dependsOnKeys.includes(depKey);
      const nextDeps = exists
        ? target.dependsOnKeys.filter((k) => k !== depKey)
        : [...target.dependsOnKeys, depKey];
      const next = [...prev.subtasks];
      next[idx] = { ...target, dependsOnKeys: nextDeps };
      return { ...prev, subtasks: next };
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
          epicDeliveryMode,
          preferredEngine: engine,
          tddMode: tddMode || undefined,
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
          dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
          preferredEngine: engine,
          tddMode: tddMode || undefined,
          pauseBeforeRun: pauseBeforeRun || undefined,
          arenaMode: arenaMode || undefined,
          arenaCompetitorEngine:
            arenaMode && arenaCompetitorEngine
              ? (arenaCompetitorEngine as WorkerEngineId)
              : undefined,
          modelOverride: isCliEngine ? modelOverride.trim() || undefined : undefined,
          effortOverride: isCliEngine ? effortOverride || undefined : undefined,
          acceptanceCriteria: acceptanceCriteria.length > 0 ? acceptanceCriteria : undefined,
          maxCostUsd: Number(budget) || 2.0,
        });
      }
      setTitle("");
      setDescription("");
      setDependsOn([]);
      setEpicPlan(null);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 overflow-y-auto"
    >
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
            <div className="flex items-center justify-between gap-2 mb-1">
              <label className="block text-zinc-400">{t("modal.dispatch.goalLabel")}</label>
              <button
                type="button"
                disabled={clarifying || !title.trim() || !description.trim()}
                onClick={() => void handleClarifySpec()}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-teal-500/40 bg-teal-500/10 hover:bg-teal-500/20 text-teal-200 text-[11px] disabled:opacity-40 transition"
              >
                <Sparkles className={`w-3 h-3 ${clarifying ? "animate-spin" : ""}`} />
                {clarifying ? t("modal.dispatch.clarifying") : t("modal.dispatch.clarifyBtn")}
              </button>
            </div>
            <textarea
              required
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("modal.dispatch.goalPlaceholder")}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100 focus:outline-none focus:border-indigo-500"
            />
          </div>

          {clarification && (
            <div className="rounded-xl border border-teal-500/35 bg-teal-500/5 p-3 space-y-2.5">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-1.5 font-semibold text-teal-200">
                  <Sparkles className="w-3.5 h-3.5 text-teal-400" />
                  <span>{t("modal.dispatch.clarifyTitle")}</span>
                  <span className="px-1.5 py-0.2 rounded bg-zinc-900 border border-zinc-700 font-mono text-[10px] text-indigo-300">
                    {clarification.recommendedDispatchMode} · {clarification.recommendedTemplate}
                  </span>
                </div>
                <button
                  type="button"
                  disabled={clarifying}
                  onClick={() => void handleApplyClarification()}
                  className="px-2.5 py-1 rounded bg-teal-600 hover:bg-teal-500 text-white text-[11px] font-medium disabled:opacity-50"
                >
                  {t("modal.dispatch.clarifyApplyBtn")}
                </button>
              </div>
              <p className="text-[11px] text-zinc-400">{clarification.rationale}</p>
              {clarification.matchedFiles.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {clarification.matchedFiles.slice(0, 6).map((f) => (
                    <code
                      key={f}
                      className="px-1.5 py-0.5 rounded bg-zinc-950 border border-zinc-800 font-mono text-[10px] text-emerald-300"
                    >
                      {f}
                    </code>
                  ))}
                </div>
              )}
              {clarification.directDependents && clarification.directDependents.length > 0 && (
                <div className="rounded border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1.5 text-[11px] text-cyan-200 flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{t("modal.dispatch.impactWarningPrefix")}:</span>
                  {clarification.directDependents.slice(0, 5).map((dep) => (
                    <code
                      key={dep}
                      className="px-1 py-0.5 rounded bg-zinc-950/70 border border-cyan-500/30 font-mono text-[10px]"
                    >
                      {dep}
                    </code>
                  ))}
                </div>
              )}
              {clarification.questions.map((q) => (
                <div key={q.id} className="space-y-1">
                  <div className="text-[11px] text-zinc-200 font-medium">{q.question}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {q.options.map((opt, idx) => {
                      const active = clarifyAnswers[q.id] === opt;
                      return (
                        <button
                          key={opt}
                          type="button"
                          onClick={() =>
                            setClarifyAnswers((prev) => ({ ...prev, [q.id]: opt }))
                          }
                          className={`px-2 py-1 rounded border text-[10px] text-left transition ${
                            active
                              ? "border-teal-400 bg-teal-500/20 text-teal-100"
                              : "border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-zinc-200"
                          }`}
                        >
                          {idx === q.recommendedIndex ? "★ " : ""}
                          {opt}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
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
                onChange={(e) => setEngine(e.target.value as EnginePreference)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 text-zinc-100"
              >
                <option value="auto">{t("modal.dispatch.engineAuto")}</option>
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
            <div className="space-y-3">
              <div>
                <label className="block text-zinc-400 mb-1">{t("modal.dispatch.paths")}</label>
                <input
                  value={paths}
                  onChange={(e) => setPaths(e.target.value)}
                  placeholder={t("modal.dispatch.pathsPlaceholder")}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
                />
              </div>

              <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-2.5 space-y-2">
                <label className="flex items-center gap-2 cursor-pointer text-zinc-200">
                  <input
                    type="checkbox"
                    checked={tddMode}
                    onChange={(e) => setTddMode(e.target.checked)}
                    className="rounded border-zinc-700 bg-zinc-950 text-rose-500"
                  />
                  <span className="text-[11px] font-medium">{t("modal.dispatch.tddEnable")}</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer text-zinc-200">
                  <input
                    type="checkbox"
                    checked={pauseBeforeRun}
                    onChange={(e) => setPauseBeforeRun(e.target.checked)}
                    className="rounded border-zinc-700 bg-zinc-950 text-amber-500"
                  />
                  <span className="text-[11px] font-medium">
                    {t("modal.dispatch.breakpointEnable")}
                  </span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer text-zinc-200">
                  <input
                    type="checkbox"
                    checked={arenaMode}
                    onChange={(e) => setArenaMode(e.target.checked)}
                    className="rounded border-zinc-700 bg-zinc-950 text-indigo-500"
                  />
                  <span className="text-[11px] font-medium">{t("modal.dispatch.arenaEnable")}</span>
                </label>
                {arenaMode && (
                  <div className="flex items-center gap-2 pl-5">
                    <span className="text-[11px] text-zinc-400 shrink-0">
                      {t("modal.dispatch.arenaOpponent")}:
                    </span>
                    <select
                      value={arenaCompetitorEngine}
                      onChange={(e) => setArenaCompetitorEngine(e.target.value)}
                      className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 font-mono text-[11px] text-zinc-100"
                    >
                      <option value="">{t("modal.dispatch.arenaAutoOpponent")}</option>
                      {availableEngines
                        .filter((eng) => eng !== engine)
                        .map((eng) => (
                          <option key={eng} value={eng}>
                            {eng}
                          </option>
                        ))}
                    </select>
                  </div>
                )}
              </div>
              <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/35 p-2.5 space-y-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <label className="text-zinc-300 font-medium">{t("modal.dispatch.dependsOnLabel")}</label>
                    {dependsOn.length > 0 && (
                      <span className="px-1.5 py-0.2 rounded bg-teal-500/15 border border-teal-500/30 font-mono text-[10px] text-teal-300">
                        {dependsOn.length} {t("modal.dispatch.dependsOnSelected")}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {dependsOn.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setDependsOn([])}
                        className="text-[11px] text-zinc-400 hover:text-zinc-200"
                      >
                        {t("modal.dispatch.dependsOnClear")}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={allCandidates.length === 0}
                      onClick={() => setDepsExpanded((prev) => !prev)}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-[11px] text-zinc-200 disabled:opacity-40"
                    >
                      {depsExpanded ? (
                        <>
                          <ChevronUp className="w-3 h-3" />
                          {t("modal.dispatch.dependsOnToggleHide")}
                        </>
                      ) : (
                        <>
                          <ChevronDown className="w-3 h-3" />
                          {t("modal.dispatch.dependsOnToggleShow")}
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {allCandidates.length === 0 ? (
                  <p className="text-[11px] text-zinc-500">{t("modal.dispatch.dependsOnEmpty")}</p>
                ) : (
                  <>
                    {dependsOn.length > 0 && !depsExpanded && (
                      <div className="flex flex-wrap gap-1.5">
                        {dependsOn.map((depId) => {
                          const matched = allCandidates.find((c) => c.id === depId);
                          const repoLabel = matched
                            ? (reposById.get(matched.repoId)?.name ?? matched.repoId)
                            : "";
                          return (
                            <button
                              key={depId}
                              type="button"
                              onClick={() => toggleDependsOnId(depId)}
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-teal-500/40 bg-teal-500/15 text-teal-200 text-[10px] font-mono"
                            >
                              <span>✓</span>
                              {repoLabel && <span className="text-sky-300">[{repoLabel}]</span>}
                              <span className="font-sans truncate max-w-44">
                                {matched?.title ?? depId}
                              </span>
                              <X className="w-2.5 h-2.5 opacity-70" />
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {depsExpanded && (
                      <div className="space-y-2 pt-1">
                        <div className="relative">
                          <Search className="w-3 h-3 text-zinc-500 absolute left-2.5 top-2" />
                          <input
                            type="text"
                            value={depsQuery}
                            onChange={(e) => setDepsQuery(e.target.value)}
                            placeholder={t("modal.dispatch.dependsOnSearch")}
                            className="w-full bg-zinc-950 border border-zinc-800 rounded-md pl-7 pr-2.5 py-1 text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500"
                          />
                        </div>
                        <div className="max-h-32 overflow-y-auto flex flex-wrap gap-1.5">
                          {filteredDepCandidates.map((cand) => {
                            const active = dependsOn.includes(cand.id);
                            const repoLabel = reposById.get(cand.repoId)?.name ?? cand.repoId;
                            return (
                              <button
                                key={cand.id}
                                type="button"
                                onClick={() => toggleDependsOnId(cand.id)}
                                className={`inline-flex items-center gap-1 px-2 py-1 rounded border text-[10px] font-mono transition ${
                                  active
                                    ? "bg-teal-500/20 text-teal-200 border-teal-500/40"
                                    : "bg-zinc-950 text-zinc-400 border-zinc-800 hover:text-zinc-200"
                                }`}
                              >
                                <span>{active ? "✓" : "+"}</span>
                                <span className="text-sky-300">[{repoLabel}]</span>
                                <span className="truncate max-w-36 font-sans">{cand.title}</span>
                                <span className="text-zinc-500">
                                  ({formatTicketStatus(cand.status, locale)})
                                </span>
                                {cand.handoverDigest && (
                                  <span className="px-1 rounded bg-indigo-500/20 text-indigo-300">
                                    v{cand.handoverDigest.version}
                                  </span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3.5 space-y-3">
              <div>
                <label className="block text-zinc-400 mb-1">
                  {t("modal.dispatch.epicDeliveryMode")}
                </label>
                <select
                  value={epicDeliveryMode}
                  disabled={hasCrossRepoSubtasks}
                  onChange={(e) => setEpicDeliveryMode(e.target.value as EpicDeliveryMode)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-100 disabled:opacity-70"
                >
                  <option value="unified">{t("modal.dispatch.epicDeliveryUnified")}</option>
                  <option value="per_subtask">{t("modal.dispatch.epicDeliveryPerSubtask")}</option>
                </select>
                {hasCrossRepoSubtasks && (
                  <p className="text-[11px] text-sky-300 mt-1.5">{t("modal.dispatch.crossRepoNotice")}</p>
                )}
              </div>

              <label className="flex items-center gap-2 cursor-pointer text-zinc-200">
                <input
                  type="checkbox"
                  checked={tddMode}
                  onChange={(e) => setTddMode(e.target.checked)}
                  className="rounded border-zinc-700 bg-zinc-950 text-rose-500"
                />
                <span className="text-[11px] font-medium">{t("modal.dispatch.tddEnable")}</span>
              </label>

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
                <div className="space-y-2.5">
                  {epicTopology && epicTopology.waves.length > 0 && (
                    <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-2.5 space-y-1.5">
                      <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400">
                        <span>{t("modal.dispatch.epicWaveLabel")}</span>
                        {epicTopology.waves.length > 1 && (
                          <span className="text-teal-300">
                            {t("modal.dispatch.epicHandoverEdge")}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 overflow-x-auto pb-0.5">
                        {epicTopology.waves.map((waveItems, waveIdx) => (
                          <div key={waveIdx} className="flex items-center gap-2 shrink-0">
                            {waveIdx > 0 && <ArrowRight className="w-3.5 h-3.5 text-teal-400 shrink-0" />}
                            <div className="rounded-md border border-zinc-800 bg-zinc-900/80 px-2 py-1 space-y-1">
                              <div className="text-[9px] font-mono uppercase tracking-wider text-zinc-500">
                                {t("modal.dispatch.epicWavePrefix")} {waveIdx + 1}
                                {t("modal.dispatch.epicWaveSuffix")}
                              </div>
                              <div className="flex items-center gap-1 flex-wrap">
                                {waveItems.map((item) => {
                                  const rName = reposById.get(item.repoId ?? repoId)?.name;
                                  return (
                                    <span
                                      key={item.key}
                                      className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded bg-indigo-500/15 border border-indigo-500/30 font-mono text-[10px] text-indigo-200"
                                    >
                                      <span>{item.key}</span>
                                      {repos.length > 1 && rName && (
                                        <span className="text-sky-300">· {rName}</span>
                                      )}
                                    </span>
                                  );
                                })}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="max-h-72 overflow-y-auto space-y-2.5 pr-1">
                    {epicPlan.subtasks.map((sub, idx) => {
                      const peerKeys = epicPlan.subtasks
                        .filter((_, pIdx) => pIdx !== idx)
                        .map((p) => p.key);
                      const waveNum = epicTopology?.waveByKey.get(sub.key) ?? 1;
                      return (
                        <div
                          key={`${sub.key}_${idx}`}
                          className="rounded-lg border border-zinc-800 bg-zinc-950/90 p-2.5 space-y-2"
                        >
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-700 font-mono text-[10px] text-zinc-400">
                                W{waveNum}
                              </span>
                              <span className="px-1.5 py-0.5 rounded bg-indigo-500/15 border border-indigo-500/30 font-mono text-[10px] text-indigo-300">
                                {sub.key}
                              </span>
                              {repos.length > 0 && (
                                <select
                                  aria-label={t("modal.dispatch.targetRepo")}
                                  value={sub.repoId ?? repoId}
                                  onChange={(e) =>
                                    updateSubtask(idx, {
                                      repoId: e.target.value === repoId ? undefined : e.target.value,
                                    })
                                  }
                                  className="bg-zinc-900 border border-sky-500/30 rounded px-1.5 py-0.5 font-mono text-[10px] text-sky-300 max-w-36"
                                >
                                  {repos.map((r) => (
                                    <option key={r.id} value={r.id}>
                                      {r.name}
                                    </option>
                                  ))}
                                </select>
                              )}
                              <select
                                value={sub.template}
                                onChange={(e) =>
                                  updateSubtask(idx, {
                                    template: e.target.value as PipelineTemplateId,
                                  })
                                }
                                className="bg-zinc-900 border border-zinc-800 rounded px-1.5 py-0.5 font-mono text-[10px] text-zinc-200"
                              >
                                <option value="fast">fast</option>
                                <option value="standard">standard</option>
                                <option value="strict">strict</option>
                              </select>
                            </div>
                            <button
                              type="button"
                              onClick={() => removeSubtask(idx)}
                              className="p-1 text-zinc-500 hover:text-rose-400"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>

                          <input
                            value={sub.title}
                            onChange={(e) => updateSubtask(idx, { title: e.target.value })}
                            className="w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1 text-zinc-100 text-[11px] font-medium focus:outline-none focus:border-indigo-500"
                          />

                          <textarea
                            rows={2}
                            value={sub.description}
                            onChange={(e) => updateSubtask(idx, { description: e.target.value })}
                            placeholder={t("modal.dispatch.epicSubtaskDescPlaceholder")}
                            className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-zinc-300 text-[10px] focus:outline-none focus:border-indigo-500"
                          />

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
                              <span>{t("modal.dispatch.epicToggleDepHint")}</span>
                              {peerKeys.length === 0 ? (
                                <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">
                                  {t("modal.dispatch.epicParallel")}
                                </span>
                              ) : (
                                peerKeys.map((peer) => {
                                  const active = sub.dependsOnKeys.includes(peer);
                                  return (
                                    <button
                                      key={peer}
                                      type="button"
                                      onClick={() => toggleSubtaskDependency(idx, peer)}
                                      className={`px-1.5 py-0.5 rounded border transition ${
                                        active
                                          ? "bg-amber-500/20 text-amber-200 border-amber-500/40"
                                          : "bg-zinc-900 text-zinc-500 border-zinc-800 hover:text-zinc-300"
                                      }`}
                                    >
                                      {active ? `✓ ${peer}` : peer}
                                    </button>
                                  );
                                })
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
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

  useEscapeKey(open, onClose);

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
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4"
    >
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

  useEscapeKey(open, onClose);

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
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4"
    >
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
  initialTab?: SettingsTab;
  availableEngines: WorkerEngineId[];
  onClose: () => void;
  onRefresh?: () => void;
  onSubmit: (
    repoId: string,
    patch: Omit<
      Partial<RepoConfig>,
      | "maxConcurrentWorkers"
      | "dailyBudgetUsd"
      | "conventions"
      | "smokeCheck"
      | "fallbackEngines"
      | "previewCommand"
      | "sandboxMode"
    > & {
      maxConcurrentWorkers?: number | null;
      dailyBudgetUsd?: number | null;
      conventions?: string | null;
      smokeCheck?: SmokeCheckConfig | null;
      fallbackEngines?: WorkerEngineId[] | null;
      previewCommand?: string | null;
      sandboxMode?: SandboxMode | null;
    },
  ) => Promise<void>;
}

type SettingsTab = "runtime" | "contract" | "playbook" | "casebook";

export function RepoSettingsModal({
  open,
  repo,
  initialTab = "runtime",
  availableEngines,
  onClose,
  onRefresh,
  onSubmit,
}: RepoSettingsModalProps) {
  const { locale, t } = useI18n();
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(initialTab);
  const [name, setName] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [githubRepo, setGithubRepo] = useState("");
  const [mode, setMode] = useState<OperatingMode>("observe");
  const [defaultTemplate, setDefaultTemplate] = useState<PipelineTemplateId>("standard");
  const [defaultTddMode, setDefaultTddMode] = useState(false);
  const [implEngine, setImplEngine] = useState<EnginePreference>("claude");
  const [reviewEngine, setReviewEngine] = useState<WorkerEngineId>("codex");
  const [fallbackEngines, setFallbackEngines] = useState<WorkerEngineId[]>([]);
  const [sandboxMode, setSandboxMode] = useState<SandboxMode>("balanced");
  const [deliveryChannel, setDeliveryChannel] = useState<DeliveryChannel>("auto_pr_or_branch");
  const [verificationInput, setVerificationInput] = useState("");
  const [setupInput, setSetupInput] = useState("");
  const [forbiddenInput, setForbiddenInput] = useState("");
  const [conventions, setConventions] = useState("");
  const [previewCommand, setPreviewCommand] = useState("");
  const [smokeEnabled, setSmokeEnabled] = useState(false);
  const [smokeStartCmd, setSmokeStartCmd] = useState("");
  const [smokeReadyUrl, setSmokeReadyUrl] = useState("");
  const [smokeTimeoutSec, setSmokeTimeoutSec] = useState("20");
  const [smokeTriggerMode, setSmokeTriggerMode] = useState<SmokeTriggerMode>("every_gate");
  const [smokeCheckCmds, setSmokeCheckCmds] = useState("");
  const [browserEnabled, setBrowserEnabled] = useState(false);
  const [browserPaths, setBrowserPaths] = useState("/");
  const [browserSelector, setBrowserSelector] = useState("");
  const [browserFailConsole, setBrowserFailConsole] = useState(false);
  const [visualDiffMode, setVisualDiffMode] = useState<VisualDiffMode>("auto");
  const [maxVisualDiffRatio, setMaxVisualDiffRatio] = useState("0.02");
  const [browserStepsText, setBrowserStepsText] = useState("");
  const [maxConcurrentInput, setMaxConcurrentInput] = useState("");
  const [dailyBudgetInput, setDailyBudgetInput] = useState("");
  const [autoCleanupWorktree, setAutoCleanupWorktree] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [contractNotice, setContractNotice] = useState<string | null>(null);
  const [syncingContract, setSyncingContract] = useState(false);

  const [playbook, setPlaybook] = useState<PlaybookEntry[]>([]);
  const [playbookLoading, setPlaybookLoading] = useState(false);
  const [pruningPlaybook, setPruningPlaybook] = useState(false);
  const [pruneNotice, setPruneNotice] = useState<string | null>(null);
  const [newRule, setNewRule] = useState("");
  const [newRuleScope, setNewRuleScope] = useState("");
  const [newRulePinned, setNewRulePinned] = useState(false);

  const [casebook, setCasebook] = useState<CasebookEntry[]>([]);
  const [casebookLoading, setCasebookLoading] = useState(false);
  const [casebookQuery, setCasebookQuery] = useState("");

  const loadPlaybook = async (repoId: string) => {
    setPlaybookLoading(true);
    try {
      const res = await api.listPlaybook(repoId);
      setPlaybook(res.entries);
    } finally {
      setPlaybookLoading(false);
    }
  };

  const loadCasebook = async (repoId: string, q?: string) => {
    setCasebookLoading(true);
    try {
      const res = await api.listCasebook(repoId, q);
      setCasebook(res.entries);
    } finally {
      setCasebookLoading(false);
    }
  };

  useEffect(() => {
    if (!open || !repo) return;
    setSettingsTab(initialTab);
    setContractNotice(null);
    setPruneNotice(null);
    setCasebookQuery("");
    setName(repo.name);
    setBaseBranch(repo.baseBranch);
    setGithubRepo(repo.githubRepo ?? "");
    setMode(repo.mode);
    setDefaultTemplate(repo.defaultTemplate);
    setDefaultTddMode(Boolean(repo.defaultTddMode));
    setImplEngine(repo.preferredImplementEngine);
    setReviewEngine(repo.preferredReviewEngine);
    setFallbackEngines(repo.fallbackEngines ?? []);
    setSandboxMode(repo.sandboxMode ?? "balanced");
    setDeliveryChannel(repo.defaultDeliveryChannel ?? "auto_pr_or_branch");
    setVerificationInput((repo.verificationCommands ?? []).join("\n"));
    setSetupInput((repo.setupCommands ?? []).join("\n"));
    setForbiddenInput((repo.forbiddenPaths ?? []).join(", "));
    setConventions(repo.conventions ?? "");
    setPreviewCommand(repo.previewCommand ?? "");
    setSmokeEnabled(Boolean(repo.smokeCheck?.enabled));
    setSmokeStartCmd(repo.smokeCheck?.startCommand ?? "");
    setSmokeReadyUrl(repo.smokeCheck?.readyUrl ?? "");
    setSmokeTimeoutSec(String(repo.smokeCheck?.startupTimeoutSec ?? 20));
    setSmokeTriggerMode(repo.smokeCheck?.triggerMode ?? "every_gate");
    setSmokeCheckCmds((repo.smokeCheck?.checkCommands ?? []).join("\n"));
    setBrowserEnabled(Boolean(repo.smokeCheck?.browserCheck?.enabled));
    setBrowserPaths((repo.smokeCheck?.browserCheck?.paths ?? ["/"]).join(", "));
    setBrowserSelector(repo.smokeCheck?.browserCheck?.waitForSelector ?? "");
    setBrowserFailConsole(Boolean(repo.smokeCheck?.browserCheck?.failOnConsoleError));
    setVisualDiffMode(repo.smokeCheck?.browserCheck?.visualDiffMode ?? "auto");
    setMaxVisualDiffRatio(
      repo.smokeCheck?.browserCheck?.maxVisualDiffRatio !== undefined
        ? String(repo.smokeCheck.browserCheck.maxVisualDiffRatio)
        : "0.02",
    );
    setBrowserStepsText(
      repo.smokeCheck?.browserCheck?.steps?.length
        ? JSON.stringify(repo.smokeCheck.browserCheck.steps)
        : "",
    );
    setMaxConcurrentInput(
      repo.maxConcurrentWorkers ? String(repo.maxConcurrentWorkers) : "",
    );
    setDailyBudgetInput(repo.dailyBudgetUsd ? String(repo.dailyBudgetUsd) : "");
    setAutoCleanupWorktree(repo.autoCleanupWorktree !== false);
    void loadPlaybook(repo.id);
    void loadCasebook(repo.id);
  }, [open, repo, initialTab]);

  useEscapeKey(open, onClose);

  if (!open || !repo) return null;

  const engineOptions = Array.from(
    new Set<WorkerEngineId>([
      ...availableEngines,
      ...(repo.preferredImplementEngine !== "auto" ? [repo.preferredImplementEngine] : []),
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
      const setupCommands = setupInput
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const forbiddenPaths = forbiddenInput
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const parsedMaxConcurrent = Number(maxConcurrentInput.trim());
      const parsedDailyBudget = Number(dailyBudgetInput.trim());
      const parsedCheckCmds = smokeCheckCmds
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const parsedTimeout = Number(smokeTimeoutSec.trim());
      const parsedBrowserPaths = browserPaths
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const parsedVisualRatio = Number(maxVisualDiffRatio.trim());
      let parsedSteps: BrowserInteractionStep[] | undefined;
      if (browserStepsText.trim()) {
        try {
          const rawParsed = JSON.parse(browserStepsText.trim());
          if (Array.isArray(rawParsed)) {
            parsedSteps = rawParsed.filter(
              (item): item is BrowserInteractionStep =>
                Boolean(item) && typeof item === "object" && typeof item.action === "string",
            );
          }
        } catch {
          // ignore malformed optional JSON during save
        }
      }
      const smokeCheckPayload: SmokeCheckConfig | null =
        smokeStartCmd.trim() || smokeEnabled
          ? {
              enabled: smokeEnabled && Boolean(smokeStartCmd.trim()),
              startCommand: smokeStartCmd.trim(),
              readyUrl: smokeReadyUrl.trim() || undefined,
              startupTimeoutSec:
                Number.isFinite(parsedTimeout) && parsedTimeout > 0
                  ? Math.max(2, Math.min(120, Math.floor(parsedTimeout)))
                  : 20,
              checkCommands: parsedCheckCmds.length > 0 ? parsedCheckCmds : undefined,
              triggerMode: smokeTriggerMode,
              ...(browserEnabled
                ? {
                    browserCheck: {
                      enabled: true,
                      paths: parsedBrowserPaths.length > 0 ? parsedBrowserPaths : ["/"],
                      waitForSelector: browserSelector.trim() || undefined,
                      failOnConsoleError: browserFailConsole,
                      visualDiffMode,
                      maxVisualDiffRatio:
                        Number.isFinite(parsedVisualRatio) &&
                        parsedVisualRatio >= 0 &&
                        parsedVisualRatio <= 1
                          ? parsedVisualRatio
                          : undefined,
                      steps: parsedSteps && parsedSteps.length > 0 ? parsedSteps : undefined,
                    },
                  }
                : {}),
            }
          : null;
      await onSubmit(repo.id, {
        name: name.trim(),
        baseBranch: baseBranch.trim() || "main",
        githubRepo: githubRepo.trim(),
        mode,
        defaultTemplate,
        defaultTddMode,
        preferredImplementEngine: implEngine,
        preferredReviewEngine: reviewEngine,
        fallbackEngines: fallbackEngines.length > 0 ? fallbackEngines : null,
        sandboxMode,
        defaultDeliveryChannel: deliveryChannel,
        verificationCommands,
        setupCommands,
        forbiddenPaths,
        conventions: conventions.trim() || null,
        previewCommand: previewCommand.trim() || null,
        smokeCheck: smokeCheckPayload,
        maxConcurrentWorkers:
          maxConcurrentInput.trim() && Number.isFinite(parsedMaxConcurrent) && parsedMaxConcurrent > 0
            ? Math.floor(parsedMaxConcurrent)
            : null,
        dailyBudgetUsd:
          dailyBudgetInput.trim() && Number.isFinite(parsedDailyBudget) && parsedDailyBudget > 0
            ? parsedDailyBudget
            : null,
        autoCleanupWorktree,
      });
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  const handleSyncContract = async () => {
    setSyncingContract(true);
    setContractNotice(null);
    try {
      const res = await api.syncRepoContract(repo.id);
      setVerificationInput((res.repo.verificationCommands ?? []).join("\n"));
      setSetupInput((res.repo.setupCommands ?? []).join("\n"));
      setForbiddenInput((res.repo.forbiddenPaths ?? []).join(", "));
      setConventions(res.repo.conventions ?? "");
      setDefaultTemplate(res.repo.defaultTemplate);
      setDefaultTddMode(Boolean(res.repo.defaultTddMode));
      setSmokeEnabled(Boolean(res.repo.smokeCheck?.enabled));
      setSmokeStartCmd(res.repo.smokeCheck?.startCommand ?? "");
      setSmokeReadyUrl(res.repo.smokeCheck?.readyUrl ?? "");
      setSmokeTimeoutSec(String(res.repo.smokeCheck?.startupTimeoutSec ?? 20));
      setSmokeTriggerMode(res.repo.smokeCheck?.triggerMode ?? "every_gate");
      setSmokeCheckCmds((res.repo.smokeCheck?.checkCommands ?? []).join("\n"));
      setPreviewCommand(res.repo.previewCommand ?? "");
      setSandboxMode(res.repo.sandboxMode ?? "balanced");
      setBrowserEnabled(Boolean(res.repo.smokeCheck?.browserCheck?.enabled));
      setBrowserPaths((res.repo.smokeCheck?.browserCheck?.paths ?? ["/"]).join(", "));
      setBrowserSelector(res.repo.smokeCheck?.browserCheck?.waitForSelector ?? "");
      setBrowserFailConsole(Boolean(res.repo.smokeCheck?.browserCheck?.failOnConsoleError));
      setVisualDiffMode(res.repo.smokeCheck?.browserCheck?.visualDiffMode ?? "auto");
      setMaxVisualDiffRatio(
        res.repo.smokeCheck?.browserCheck?.maxVisualDiffRatio !== undefined
          ? String(res.repo.smokeCheck.browserCheck.maxVisualDiffRatio)
          : "0.02",
      );
      setBrowserStepsText(
        res.repo.smokeCheck?.browserCheck?.steps?.length
          ? JSON.stringify(res.repo.smokeCheck.browserCheck.steps)
          : "",
      );
      await loadPlaybook(repo.id);
      onRefresh?.();
      setContractNotice(`Synced super-work.json (${res.repo.contractSyncedAt ?? "ok"})`);
    } catch (err) {
      setContractNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncingContract(false);
    }
  };

  const handleExportContract = async () => {
    setSyncingContract(true);
    setContractNotice(null);
    try {
      const res = await api.exportRepoContract(repo.id);
      onRefresh?.();
      setContractNotice(`Exported super-work.json -> ${res.filePath}`);
    } catch (err) {
      setContractNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncingContract(false);
    }
  };

  const handleAddPlaybookRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRule.trim()) return;
    const scopePaths = newRuleScope
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    await api.addPlaybook(repo.id, {
      rule: newRule.trim(),
      scopePaths: scopePaths.length > 0 ? scopePaths : undefined,
      pinned: newRulePinned,
      enabled: true,
    });
    setNewRule("");
    setNewRuleScope("");
    setNewRulePinned(false);
    await loadPlaybook(repo.id);
    onRefresh?.();
  };

  const handleTogglePlaybook = async (entry: PlaybookEntry, field: "enabled" | "pinned") => {
    await api.patchPlaybook(entry.id, { [field]: !entry[field] });
    await loadPlaybook(repo.id);
    onRefresh?.();
  };

  const handleDeletePlaybook = async (entryId: string) => {
    await api.deletePlaybook(entryId);
    await loadPlaybook(repo.id);
    onRefresh?.();
  };

  const handlePrunePlaybook = async () => {
    setPruningPlaybook(true);
    setPruneNotice(null);
    try {
      const res = await api.prunePlaybook(repo.id);
      setPlaybook(res.entries);
      setPruneNotice(
        t("modal.repoSettings.playbookPrunedMsg")
          .replace("{removed}", String(res.prunedIds.length))
          .replace("{kept}", String(res.keptCount)),
      );
      onRefresh?.();
    } finally {
      setPruningPlaybook(false);
    }
  };

  const handleDeleteCase = async (entryId: string) => {
    await api.deleteCasebookEntry(entryId);
    await loadCasebook(repo.id, casebookQuery.trim() || undefined);
    onRefresh?.();
  };

  const toggleFallbackEngine = (eng: WorkerEngineId) => {
    setFallbackEngines((prev) =>
      prev.includes(eng) ? prev.filter((item) => item !== eng) : [...prev, eng],
    );
  };

  const prunableCount = playbook.filter((e) => e.prunable).length;

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4"
    >
      <div className="w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl">
        <div className="shrink-0 px-5 pt-5 space-y-4 border-b border-zinc-800">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-zinc-100">{t("modal.repoSettings.title")}</h3>
              <div className="font-mono text-[10px] text-zinc-500 mt-0.5 truncate max-w-md">
                {repo.rootPath}
              </div>
            </div>
            <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200">
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Settings Tab Bar */}
          <div className="flex items-center gap-1 text-xs -mb-px">
            <button
              type="button"
              onClick={() => setSettingsTab("runtime")}
              className={`px-3 py-2 border-b-2 font-medium transition ${
                settingsTab === "runtime"
                  ? "border-indigo-500 text-indigo-300"
                  : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {t("modal.repoSettings.tab.runtime")}
            </button>
            <button
              type="button"
              onClick={() => setSettingsTab("contract")}
              className={`inline-flex items-center gap-1.5 px-3 py-2 border-b-2 font-medium transition ${
                settingsTab === "contract"
                  ? "border-indigo-500 text-indigo-300"
                  : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <FileJson2 className="w-3.5 h-3.5" />
              {t("modal.repoSettings.tab.contract")}
            </button>
            <button
              type="button"
              onClick={() => setSettingsTab("playbook")}
              className={`inline-flex items-center gap-1.5 px-3 py-2 border-b-2 font-medium transition ${
                settingsTab === "playbook"
                  ? "border-indigo-500 text-indigo-300"
                  : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <BookOpen className="w-3.5 h-3.5" />
              {t("modal.repoSettings.tab.playbook")} ({playbook.length})
            </button>
            <button
              type="button"
              onClick={() => setSettingsTab("casebook")}
              className={`inline-flex items-center gap-1.5 px-3 py-2 border-b-2 font-medium transition ${
                settingsTab === "casebook"
                  ? "border-indigo-500 text-indigo-300"
                  : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <Database className="w-3.5 h-3.5" />
              {t("modal.repoSettings.tab.casebook")} ({casebook.length})
            </button>
          </div>
        </div>

        {(settingsTab === "runtime" || settingsTab === "contract") ? (
          <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0 overflow-hidden text-xs">
            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3">
              {settingsTab === "runtime" && (
              <>
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
                      onChange={(e) => setImplEngine(e.target.value as EnginePreference)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 font-mono text-zinc-100"
                    >
                      <option value="auto">{t("modal.dispatch.engineAuto")}</option>
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
                  <label className="block text-zinc-400 mb-1.5">
                    {t("modal.repoSettings.fallbackEngines")}
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {engineOptions.map((eng) => {
                      const orderIdx = fallbackEngines.indexOf(eng);
                      const active = orderIdx !== -1;
                      return (
                        <button
                          key={eng}
                          type="button"
                          onClick={() => toggleFallbackEngine(eng)}
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border font-mono text-[11px] transition ${
                            active
                              ? "border-indigo-500/40 bg-indigo-500/15 text-indigo-200"
                              : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200"
                          }`}
                        >
                          {active && (
                            <span className="px-1 rounded bg-indigo-500/30 text-[10px] text-indigo-100">
                              #{orderIdx + 1}
                            </span>
                          )}
                          <span>{eng}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label className="block text-zinc-400 mb-1">
                    {t("modal.repoSettings.sandboxTitle")}
                  </label>
                  <select
                    value={sandboxMode}
                    onChange={(e) => setSandboxMode(e.target.value as SandboxMode)}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 text-zinc-100"
                  >
                    <option value="balanced">{t("modal.repoSettings.sandboxBalanced")}</option>
                    <option value="strict">{t("modal.repoSettings.sandboxStrict")}</option>
                    <option value="off">{t("modal.repoSettings.sandboxOff")}</option>
                  </select>
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

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-zinc-400 mb-1">
                      {t("modal.repoSettings.maxConcurrent")}
                    </label>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={maxConcurrentInput}
                      onChange={(e) => setMaxConcurrentInput(e.target.value)}
                      placeholder={t("modal.repoSettings.quotaPlaceholder")}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
                    />
                  </div>
                  <div>
                    <label className="block text-zinc-400 mb-1">
                      {t("modal.repoSettings.dailyBudget")}
                    </label>
                    <input
                      type="number"
                      min="0.1"
                      step="0.5"
                      value={dailyBudgetInput}
                      onChange={(e) => setDailyBudgetInput(e.target.value)}
                      placeholder={t("modal.repoSettings.quotaPlaceholder")}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
                    />
                  </div>
                </div>

                <label className="flex items-start gap-2.5 rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={defaultTddMode}
                    onChange={(e) => setDefaultTddMode(e.target.checked)}
                    className="mt-0.5 rounded border-zinc-700 bg-zinc-950 text-rose-500 focus:ring-rose-500"
                  />
                  <div>
                    <div className="font-medium text-zinc-200">
                      {t("modal.repoSettings.defaultTddLabel")}
                    </div>
                    <p className="text-[11px] text-zinc-400 mt-0.5">
                      {t("modal.repoSettings.defaultTddDesc")}
                    </p>
                  </div>
                </label>

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
              </>
            )}

            {settingsTab === "contract" && (
              <>
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="text-[11px] text-zinc-400">
                    {repo.contractSyncedAt
                      ? `${t("modal.repoSettings.contractSyncedPrefix")} ${repo.contractSyncedAt}`
                      : "super-work.json"}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={syncingContract}
                      onClick={() => void handleSyncContract()}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-sky-500/40 bg-sky-500/15 hover:bg-sky-500/25 text-sky-200 text-[11px] disabled:opacity-50"
                    >
                      <Download className="w-3 h-3" />
                      {t("modal.repoSettings.syncContractBtn")}
                    </button>
                    <button
                      type="button"
                      disabled={syncingContract}
                      onClick={() => void handleExportContract()}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-indigo-500/40 bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-200 text-[11px] disabled:opacity-50"
                    >
                      <Upload className="w-3 h-3" />
                      {t("modal.repoSettings.exportContractBtn")}
                    </button>
                  </div>
                </div>

                {contractNotice && (
                  <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-200">
                    {contractNotice}
                  </div>
                )}

                <div>
                  <label className="block text-zinc-400 mb-1">
                    {t("modal.repoSettings.verificationCommands")}
                  </label>
                  <textarea
                    rows={2}
                    value={verificationInput}
                    onChange={(e) => setVerificationInput(e.target.value)}
                    placeholder={t("modal.repoSettings.verificationPlaceholder")}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100 leading-relaxed focus:outline-none focus:border-indigo-500"
                  />
                  <p className="text-[11px] text-zinc-500 mt-1">
                    {t("modal.repoSettings.verificationHint")}
                  </p>
                </div>

                <div>
                  <label className="block text-zinc-400 mb-1">
                    {t("modal.repoSettings.setupCommands")}
                  </label>
                  <textarea
                    rows={2}
                    value={setupInput}
                    onChange={(e) => setSetupInput(e.target.value)}
                    placeholder={t("modal.repoSettings.setupPlaceholder")}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100 leading-relaxed focus:outline-none focus:border-indigo-500"
                  />
                  <p className="text-[11px] text-zinc-500 mt-1">
                    {t("modal.repoSettings.setupHint")}
                  </p>
                </div>

                <div>
                  <label className="block text-zinc-400 mb-1">
                    {t("modal.repoSettings.forbiddenPaths")}
                  </label>
                  <input
                    value={forbiddenInput}
                    onChange={(e) => setForbiddenInput(e.target.value)}
                    placeholder={t("modal.repoSettings.forbiddenPlaceholder")}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
                  />
                </div>

                <div>
                  <label className="block text-zinc-400 mb-1">
                    {t("modal.repoSettings.conventions")}
                  </label>
                  <textarea
                    rows={4}
                    value={conventions}
                    onChange={(e) => setConventions(e.target.value)}
                    placeholder={t("modal.repoSettings.conventionsPlaceholder")}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100"
                  />
                </div>

                <div>
                  <label className="block text-zinc-400 mb-1">
                    {t("modal.repoSettings.previewCmd")}
                  </label>
                  <input
                    value={previewCommand}
                    onChange={(e) => setPreviewCommand(e.target.value)}
                    placeholder="bun run dev -- --port $PORT"
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
                  />
                </div>

                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3.5 space-y-3">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="font-semibold text-zinc-200 flex items-center gap-1.5">
                      <Activity className="w-3.5 h-3.5 text-emerald-400" />
                      {t("modal.repoSettings.smokeTitle")}
                    </span>
                    <label className="inline-flex items-center gap-1.5 text-zinc-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={smokeEnabled}
                        onChange={(e) => setSmokeEnabled(e.target.checked)}
                        className="rounded border-zinc-700 bg-zinc-950 text-indigo-500"
                      />
                      <span className="text-[11px]">{t("modal.repoSettings.smokeEnable")}</span>
                    </label>
                  </div>

                  {!smokeEnabled ? (
                    <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-950/50 px-3 py-2.5 text-[11px] text-zinc-500 flex flex-wrap items-center justify-between gap-2">
                      <span>{t("modal.repoSettings.smokeCollapsedHint")}</span>
                      {smokeStartCmd.trim() && (
                        <code className="font-mono text-[10px] text-zinc-400 bg-zinc-900 px-1.5 py-0.5 rounded">
                          {smokeStartCmd.trim()}
                        </code>
                      )}
                    </div>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setSmokeStartCmd("bun run src/index.ts");
                            setSmokeReadyUrl("http://127.0.0.1:$PORT/health");
                            setSmokeTimeoutSec("20");
                          }}
                          className="px-2 py-0.5 rounded border border-zinc-700 bg-zinc-950 hover:bg-zinc-900 text-[10px] font-mono text-zinc-300 transition"
                        >
                          {t("modal.repoSettings.smokePresetBun")}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setSmokeStartCmd("bun run preview --port $PORT --host 127.0.0.1");
                            setSmokeReadyUrl("http://127.0.0.1:$PORT/");
                            setSmokeTimeoutSec("20");
                          }}
                          className="px-2 py-0.5 rounded border border-zinc-700 bg-zinc-950 hover:bg-zinc-900 text-[10px] font-mono text-zinc-300 transition"
                        >
                          {t("modal.repoSettings.smokePresetWeb")}
                        </button>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                        <div>
                          <label className="block text-zinc-400 mb-1">
                            {t("modal.repoSettings.smokeStartCmd")}
                          </label>
                          <input
                            value={smokeStartCmd}
                            onChange={(e) => setSmokeStartCmd(e.target.value)}
                            placeholder="bun run src/server.ts"
                            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 font-mono text-zinc-100"
                          />
                        </div>
                        <div>
                          <label className="block text-zinc-400 mb-1">
                            {t("modal.repoSettings.smokeReadyUrl")}
                          </label>
                          <input
                            value={smokeReadyUrl}
                            onChange={(e) => setSmokeReadyUrl(e.target.value)}
                            placeholder="http://127.0.0.1:$PORT/health"
                            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 font-mono text-zinc-100"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2.5">
                        <div>
                          <label className="block text-zinc-400 mb-1">
                            {t("modal.repoSettings.smokeTimeout")}
                          </label>
                          <input
                            type="number"
                            min="2"
                            max="120"
                            value={smokeTimeoutSec}
                            onChange={(e) => setSmokeTimeoutSec(e.target.value)}
                            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 font-mono text-zinc-100"
                          />
                        </div>
                        <div>
                          <label className="block text-zinc-400 mb-1">
                            {t("modal.repoSettings.smokeTriggerMode")}
                          </label>
                          <select
                            value={smokeTriggerMode}
                            onChange={(e) => setSmokeTriggerMode(e.target.value as SmokeTriggerMode)}
                            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-100"
                          >
                            <option value="every_gate">{t("modal.repoSettings.smokeEveryGate")}</option>
                            <option value="delivery_only">{t("modal.repoSettings.smokeDeliveryOnly")}</option>
                          </select>
                        </div>
                      </div>

                      <div>
                        <label className="block text-zinc-400 mb-1">
                          {t("modal.repoSettings.smokeCheckCmds")}
                        </label>
                        <textarea
                          rows={2}
                          value={smokeCheckCmds}
                          onChange={(e) => setSmokeCheckCmds(e.target.value)}
                          placeholder="curl -fsS $SUPER_WORK_SMOKE_URL/api/health"
                          className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 font-mono text-zinc-100 leading-relaxed focus:outline-none focus:border-indigo-500"
                        />
                      </div>

                      <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-2.5 space-y-2">
                        <label className="inline-flex items-center gap-1.5 text-zinc-200 cursor-pointer font-medium">
                          <input
                            type="checkbox"
                            checked={browserEnabled}
                            onChange={(e) => setBrowserEnabled(e.target.checked)}
                            className="rounded border-zinc-700 bg-zinc-950 text-indigo-500"
                          />
                          <Eye className="w-3.5 h-3.5 text-sky-400" />
                          <span className="text-[11px]">{t("modal.repoSettings.browserGateEnable")}</span>
                        </label>
                        {browserEnabled && (
                          <div className="space-y-2 pt-1 pl-5">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                              <input
                                value={browserPaths}
                                onChange={(e) => setBrowserPaths(e.target.value)}
                                placeholder={t("modal.repoSettings.browserPaths")}
                                className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1 font-mono text-[11px] text-zinc-100"
                              />
                              <input
                                value={browserSelector}
                                onChange={(e) => setBrowserSelector(e.target.value)}
                                placeholder={t("modal.repoSettings.browserSelector")}
                                className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1 font-mono text-[11px] text-zinc-100"
                              />
                            </div>
                            <label className="inline-flex items-center gap-1.5 text-[11px] text-zinc-300 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={browserFailConsole}
                                onChange={(e) => setBrowserFailConsole(e.target.checked)}
                                className="rounded border-zinc-700 bg-zinc-950 text-indigo-500"
                              />
                              {t("modal.repoSettings.browserFailConsole")}
                            </label>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                              <div>
                                <label className="block text-[10px] text-zinc-400 mb-1">
                                  {t("modal.repoSettings.visualDiffMode")}
                                </label>
                                <select
                                  value={visualDiffMode}
                                  onChange={(e) =>
                                    setVisualDiffMode(e.target.value as VisualDiffMode)
                                  }
                                  className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1 font-mono text-[11px] text-zinc-100"
                                >
                                  <option value="auto">auto</option>
                                  <option value="enforce">enforce</option>
                                  <option value="informational">informational</option>
                                  <option value="off">off</option>
                                </select>
                              </div>
                              <div>
                                <label className="block text-[10px] text-zinc-400 mb-1">
                                  {t("modal.repoSettings.maxVisualDiffRatio")}
                                </label>
                                <input
                                  type="number"
                                  step="0.005"
                                  min="0"
                                  max="1"
                                  value={maxVisualDiffRatio}
                                  onChange={(e) => setMaxVisualDiffRatio(e.target.value)}
                                  className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1 font-mono text-[11px] text-zinc-100"
                                />
                              </div>
                            </div>
                            <div>
                              <label className="block text-[10px] text-zinc-400 mb-1">
                                {t("modal.repoSettings.browserStepsLabel")}
                              </label>
                              <input
                                value={browserStepsText}
                                onChange={(e) => setBrowserStepsText(e.target.value)}
                                placeholder={t("modal.repoSettings.browserStepsPlaceholder")}
                                className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1 font-mono text-[11px] text-zinc-100"
                              />
                            </div>
                          </div>
                        )}
                      </div>

                      <p className="text-[11px] text-zinc-500">{t("modal.repoSettings.smokeHint")}</p>
                    </>
                  )}
                </div>
              </>
            )}
            </div>

            <div className="shrink-0 border-t border-zinc-800 bg-zinc-900/95 px-5 py-3 flex justify-end gap-2">
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
        ) : settingsTab === "playbook" ? (
          <div className="flex flex-col flex-1 min-h-0 overflow-hidden text-xs">
            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                {pruneNotice ? (
                  <span className="text-[11px] text-emerald-300">{pruneNotice}</span>
                ) : (
                  <span className="text-[11px] text-zinc-500">
                    {playbook.length} rule(s)
                  </span>
                )}
                <button
                  type="button"
                  disabled={pruningPlaybook || prunableCount === 0}
                  onClick={() => void handlePrunePlaybook()}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-amber-500/35 bg-amber-500/15 hover:bg-amber-500/25 text-amber-200 text-[11px] font-medium disabled:opacity-40 transition"
                >
                  <Sparkles className="w-3 h-3" />
                  {pruningPlaybook
                    ? t("modal.repoSettings.playbookPruning")
                    : `${t("modal.repoSettings.playbookPruneBtn")} (${prunableCount})`}
                </button>
              </div>

              <form onSubmit={(e) => void handleAddPlaybookRule(e)} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 space-y-2">
                <input
                  required
                  value={newRule}
                  onChange={(e) => setNewRule(e.target.value)}
                  placeholder={t("modal.repoSettings.playbookAddPlaceholder")}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-zinc-100"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    value={newRuleScope}
                    onChange={(e) => setNewRuleScope(e.target.value)}
                    placeholder={t("modal.repoSettings.playbookScopePlaceholder")}
                    className="flex-1 min-w-44 bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1 font-mono text-[11px] text-emerald-300"
                  />
                  <label className="inline-flex items-center gap-1.5 text-zinc-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={newRulePinned}
                      onChange={(e) => setNewRulePinned(e.target.checked)}
                      className="rounded border-zinc-700 bg-zinc-950 text-indigo-500"
                    />
                    {t("modal.repoSettings.playbookPin")}
                  </label>
                  <button
                    type="submit"
                    className="inline-flex items-center gap-1 px-3 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-medium"
                  >
                    <Plus className="w-3 h-3" />
                    {t("modal.repoSettings.playbookAddBtn")}
                  </button>
                </div>
              </form>

              <div className="space-y-2">
                {playbookLoading ? (
                  <div className="py-6 text-center text-zinc-500">{t("drawer.loading")}</div>
                ) : playbook.length === 0 ? (
                  <div className="py-6 px-4 text-center rounded-lg border border-dashed border-zinc-800 text-zinc-500">
                    {t("modal.repoSettings.playbookEmpty")}
                  </div>
                ) : (
                  playbook.map((entry) => (
                    <div
                      key={entry.id}
                      className={`rounded-lg border p-2.5 space-y-1.5 ${
                        entry.enabled
                          ? "border-zinc-800 bg-zinc-900/60"
                          : "border-zinc-800/50 bg-zinc-900/20 opacity-60"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="space-y-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="px-1.5 py-0.2 rounded font-mono text-[10px] bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">
                              {entry.source}
                            </span>
                            {entry.pinned && (
                              <span className="px-1.5 py-0.2 rounded font-mono text-[10px] bg-amber-500/15 text-amber-300 border border-amber-500/30">
                                PIN
                              </span>
                            )}
                            {entry.healthStatus && entry.healthStatus !== "healthy" && (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded font-mono text-[10px] bg-rose-500/15 text-rose-300 border border-rose-500/30">
                                <AlertTriangle className="w-2.5 h-2.5" />
                                {t(`modal.repoSettings.health.${entry.healthStatus}` as const)}
                              </span>
                            )}
                            <span className="px-1.5 py-0.2 rounded font-mono text-[10px] bg-zinc-950 text-zinc-400 border border-zinc-800">
                              {t("modal.repoSettings.playbookHits")}: {entry.hitCount ?? 0}
                            </span>
                            <span className="font-mono text-[10px] text-emerald-300">
                              [{entry.scopePaths.join(", ")}]
                            </span>
                          </div>
                          <p className="text-zinc-200 leading-relaxed">{entry.rule}</p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => void handleTogglePlaybook(entry, "pinned")}
                            title={entry.pinned ? t("modal.repoSettings.playbookUnpin") : t("modal.repoSettings.playbookPin")}
                            className={`p-1 rounded border ${
                              entry.pinned
                                ? "border-amber-500/40 bg-amber-500/15 text-amber-300"
                                : "border-zinc-800 text-zinc-500 hover:text-zinc-200"
                            }`}
                          >
                            <Pin className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleTogglePlaybook(entry, "enabled")}
                            className="px-2 py-0.5 rounded border border-zinc-800 text-[10px] text-zinc-300 hover:bg-zinc-800"
                          >
                            {entry.enabled
                              ? t("modal.repoSettings.playbookDisable")
                              : t("modal.repoSettings.playbookEnable")}
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeletePlaybook(entry.id)}
                            className="p-1 rounded text-zinc-500 hover:text-rose-400"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="shrink-0 border-t border-zinc-800 bg-zinc-900/95 px-5 py-3 flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 rounded-lg border border-zinc-800 text-zinc-400 hover:text-zinc-200"
              >
                {t("modal.worktrees.close")}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col flex-1 min-h-0 overflow-hidden text-xs">
            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void loadCasebook(repo.id, casebookQuery.trim() || undefined);
                }}
                className="flex gap-2"
              >
                <div className="relative flex-1">
                  <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-2" />
                  <input
                    type="text"
                    value={casebookQuery}
                    onChange={(e) => setCasebookQuery(e.target.value)}
                    placeholder={t("modal.repoSettings.casebookSearchPlaceholder")}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg pl-8 pr-3 py-1.5 text-zinc-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <button
                  type="submit"
                  className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200"
                >
                  <Search className="w-3.5 h-3.5" />
                </button>
              </form>

              {casebookLoading ? (
                <div className="py-6 text-center text-zinc-500">{t("drawer.loading")}</div>
              ) : casebook.length === 0 ? (
                <div className="py-6 px-4 text-center rounded-lg border border-dashed border-zinc-800 text-zinc-500">
                  {t("modal.repoSettings.casebookEmpty")}
                </div>
              ) : (
                <div className="space-y-2.5">
                  {casebook.map((c) => (
                    <div
                      key={c.id}
                      className={`rounded-lg border p-3 space-y-1.5 ${
                        c.reverted
                          ? "border-rose-500/35 bg-rose-500/5"
                          : "border-zinc-800 bg-zinc-900/60"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span
                            className={`inline-flex items-center gap-1 px-1.5 py-0.2 rounded font-mono text-[10px] border ${
                              c.reverted
                                ? "bg-rose-500/15 text-rose-300 border-rose-500/30"
                                : "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                            }`}
                          >
                            {c.reverted && <RotateCcw className="w-2.5 h-2.5" />}
                            {c.reverted
                              ? t("modal.repoSettings.casebookRevertedBadge")
                              : t("modal.repoSettings.casebookVerifiedBadge")}
                          </span>
                          <span className="font-mono text-[10px] text-zinc-500">{c.ticketId}</span>
                          <span className="px-1.5 py-0.2 rounded font-mono text-[10px] bg-zinc-950 text-zinc-400 border border-zinc-800">
                            {t("modal.repoSettings.playbookHits")}: {c.hitCount}
                          </span>
                          <span className="font-mono text-[10px] text-emerald-300">
                            [{c.scopePaths.join(", ")}]
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleDeleteCase(c.id)}
                          className="p-1 rounded text-zinc-500 hover:text-rose-400 shrink-0"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                      <div className="font-medium text-zinc-100">{c.title}</div>
                      <p className="text-zinc-300 leading-relaxed">{c.solutionSummary}</p>
                      {c.pitfallsAndFixes && (
                        <p className="text-[11px] text-amber-300/90 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1">
                          {c.pitfallsAndFixes}
                        </p>
                      )}
                      {c.exportedSymbols.length > 0 && (
                        <div className="flex flex-wrap gap-1 pt-0.5">
                          {c.exportedSymbols.slice(0, 6).map((sym) => (
                            <code
                              key={sym}
                              className="px-1.5 py-0.2 rounded bg-indigo-500/10 border border-indigo-500/20 font-mono text-[10px] text-indigo-300"
                            >
                              {sym}
                            </code>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="shrink-0 border-t border-zinc-800 bg-zinc-900/95 px-5 py-3 flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 rounded-lg border border-zinc-800 text-zinc-400 hover:text-zinc-200"
              >
                {t("modal.worktrees.close")}
              </button>
            </div>
          </div>
        )}
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
  const [previews, setPreviews] = useState<PreviewSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [gcing, setGcing] = useState(false);
  const [gcResult, setGcResult] = useState<WorktreeGcResult | null>(null);

  const loadWorktrees = async () => {
    setLoading(true);
    try {
      const [wtRes, prvRes] = await Promise.all([
        api.listWorktrees(repoId),
        api.listPreviews(repoId),
      ]);
      setItems(wtRes.items);
      setPreviews(prvRes.previews);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setGcResult(null);
    void loadWorktrees();
  }, [open, repoId]);

  useEscapeKey(open, onClose);

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
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4"
    >
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

        {previews.length > 0 && (
          <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3 space-y-2 text-xs">
            <div className="font-semibold text-sky-300 flex items-center gap-1.5">
              <Play className="w-3.5 h-3.5" />
              {t("preview.activeTitle")} ({previews.length})
            </div>
            <div className="space-y-1.5">
              {previews.map((prv) => (
                <div
                  key={prv.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded border border-zinc-800 bg-zinc-950/80 px-2.5 py-1.5"
                >
                  <div className="min-w-0 flex items-center gap-2">
                    <span className="px-1.5 py-0.2 rounded font-mono text-[10px] bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                      {prv.status}
                    </span>
                    <span className="text-zinc-200 truncate max-w-xs">{prv.label}</span>
                    <a
                      href={prv.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 font-mono text-[11px] text-sky-300 hover:underline"
                    >
                      {prv.url}
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => void api.renewPreview(prv.id).then(() => loadWorktrees())}
                      className="px-2 py-0.5 rounded border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-[10px] text-zinc-200"
                    >
                      {t("preview.renewBtn")}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void api.stopPreview(prv.id).then(() => {
                          void loadWorktrees();
                          onChanged();
                        })
                      }
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500/20 text-[10px] text-rose-300"
                    >
                      <Square className="w-2.5 h-2.5" />
                      {t("preview.stopBtn")}
                    </button>
                  </div>
                </div>
              ))}
            </div>
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
