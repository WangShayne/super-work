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
  DeliveryGatePolicy,
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
  TaskBlueprint,
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
    blueprintId?: string;
    deliveryGatePolicy?: DeliveryGatePolicy;
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
  const [blueprints, setBlueprints] = useState<TaskBlueprint[]>([]);
  const [blueprintId, setBlueprintId] = useState("");
  const [deliveryGatePolicy, setDeliveryGatePolicy] = useState<DeliveryGatePolicy | "">("");
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
      setBlueprintId("");
      setDeliveryGatePolicy("");
      api
        .listBlueprints(repoId)
        .then((res) => setBlueprints(res.blueprints))
        .catch(() => setBlueprints([]));
    }
  }, [open, repoId, defaultTemplate, defaultEngine, defaultTddMode]);

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
          blueprintId: blueprintId || undefined,
          deliveryGatePolicy: deliveryGatePolicy || undefined,
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

  const handleSelectBlueprint = (bp: TaskBlueprint | null) => {
    if (!bp) {
      setBlueprintId("");
      setDeliveryGatePolicy("");
      setTemplate(defaultTemplate);
      setEngine(defaultEngine);
      setTddMode(Boolean(defaultTddMode));
      setAcceptanceCriteria([]);
      return;
    }
    setBlueprintId(bp.id);
    setTemplate(bp.template);
    if (bp.preferredEngine) setEngine(bp.preferredEngine);
    if (bp.tddMode !== undefined) setTddMode(bp.tddMode);
    if (bp.deliveryGatePolicy) setDeliveryGatePolicy(bp.deliveryGatePolicy);
    if (bp.allowedPaths && bp.allowedPaths.length > 0) setPaths(bp.allowedPaths.join(", "));
    if (bp.acceptanceCriteria && bp.acceptanceCriteria.length > 0) {
      setAcceptanceCriteria(bp.acceptanceCriteria);
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
          {dispatchMode === "single" && blueprints.length > 0 && (
            <div className="space-y-1.5">
              <label className="block text-zinc-400">{t("modal.dispatch.blueprintLabel")}</label>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => handleSelectBlueprint(null)}
                  className={`px-2 py-1 rounded-md border text-[11px] transition ${
                    blueprintId === ""
                      ? "border-indigo-500 bg-indigo-500/20 text-indigo-200"
                      : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {t("modal.dispatch.blueprintNone")}
                </button>
                {blueprints.map((bp) => (
                  <button
                    key={bp.id}
                    type="button"
                    title={bp.description}
                    onClick={() => handleSelectBlueprint(bp)}
                    className={`px-2 py-1 rounded-md border font-mono text-[11px] transition ${
                      blueprintId === bp.id
                        ? "border-emerald-500 bg-emerald-500/20 text-emerald-200"
                        : "border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-zinc-700"
                    }`}
                  >
                    {bp.name}
                  </button>
                ))}
              </div>
            </div>
          )}

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
          {dispatchMode === "single" && (
            <div>
              <label className="block text-zinc-400 mb-1">
                {t("modal.dispatch.gatePolicyLabel")}
              </label>
              <select
                value={deliveryGatePolicy}
                onChange={(e) => setDeliveryGatePolicy(e.target.value as DeliveryGatePolicy | "")}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 text-zinc-100"
              >
                <option value="">{t("modal.dispatch.gatePolicyInherit")}</option>
                <option value="always_auto">always_auto</option>
                <option value="risk_gated">risk_gated (A.1 Risk Score)</option>
                <option value="always_signoff">always_signoff</option>
              </select>
            </div>
          )}
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
