import { useRef, useState } from "react";
import {
  Bug,
  Eye,
  FolderGit2,
  GitBranch,
  Layers,
  Loader2,
  Play,
  Plus,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import { api } from "../api.ts";
import { formatEngineDisplayName, useI18n, type TranslationKey } from "../i18n.tsx";
import type {
  AutonomyPreset,
  EnginePreference,
  RepoConfig,
  RequirementIntakePlan,
  RequirementRouteKind,
  WorkerEngineId,
} from "../types.ts";
import {
  AUTONOMY_PRESETS,
  formatScopeTokens,
  inferAutonomyPreset,
  isSemver,
  parseMilestoneRequirements,
  parsePathList,
  withScopeTokens,
} from "../utils/superAgent.ts";

interface HeroComposerProps {
  repo: RepoConfig | undefined;
  repos: RepoConfig[];
  selectedRepoId: string;
  onSelectRepo: (id: string) => void;
  onChangeAutonomyPreset: (repoId: string, preset: AutonomyPreset) => void;
  availableEngines: WorkerEngineId[];
  onSubmitted: (route: RequirementRouteKind | "milestone") => Promise<void> | void;
  onOpenAddRepo: () => void;
}

const INPUT_CLS =
  "w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus-visible:border-indigo-500";

const PRESET_ACTIVE: Record<AutonomyPreset, string> = {
  guarded: "bg-sky-500/20 text-sky-300 border-sky-500/40",
  smart: "bg-indigo-500/20 text-indigo-200 border-indigo-500/40",
  autonomous: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
};

type StarterId = "bug" | "feature" | "refactor" | "release";

const STARTERS: { id: StarterId; icon: typeof Bug }[] = [
  { id: "bug", icon: Bug },
  { id: "feature", icon: Sparkles },
  { id: "refactor", icon: Layers },
  { id: "release", icon: GitBranch },
];

function planLabelKey(plan: RequirementIntakePlan) {
  if (plan.route === "epic_dag") return "composer.plan.multi" as const;
  if (plan.route === "goal_campaign") return "composer.plan.loop" as const;
  return "composer.plan.single" as const;
}

export function HeroComposer({
  repo,
  repos,
  selectedRepoId,
  onSelectRepo,
  onChangeAutonomyPreset,
  availableEngines,
  onSubmitted,
  onOpenAddRepo,
}: HeroComposerProps) {
  const { locale, t } = useI18n();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [plan, setPlan] = useState<RequirementIntakePlan | null>(null);
  const [busy, setBusy] = useState<"preview" | "run" | null>(null);
  const [error, setError] = useState("");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [releaseMode, setReleaseMode] = useState(false);
  const [version, setVersion] = useState("");
  const [milestoneTitle, setMilestoneTitle] = useState("");
  const [scopePaths, setScopePaths] = useState("");
  const [engine, setEngine] = useState<"auto" | WorkerEngineId>("auto");
  const [budget, setBudget] = useState("");

  const repoId = repo?.id ?? "";
  const requirement = text.trim();
  const versionOk = !releaseMode || isSemver(version);
  const canRun = Boolean(repoId && requirement && versionOk && busy === null);
  const scope = parsePathList(scopePaths);
  const scopeTokens = formatScopeTokens(scope);
  const activePreset = inferAutonomyPreset(repo);

  const buildPayload = () => ({
    repoId,
    // Scope paths become explicit `scope:<glob>` tokens, which core intake parses deterministically
    // into mandate.allowedPaths (packages/core/src/intake.ts extractScopeTags → inferModuleScopedPaths).
    requirement: withScopeTokens(requirement, scope),
    preferredRoute: "auto" as const,
    preferredEngine: (engine === "auto" ? undefined : engine) as EnginePreference | undefined,
    maxBudgetUsd: Number(budget) > 0 ? Number(budget) : undefined,
  });

  const onChangeText = (value: string) => {
    setText(value);
    if (plan) setPlan(null);
  };

  const applyStarter = (id: StarterId) => {
    const scaffold = t(`composer.starter.${id}.scaffold` as TranslationKey);
    onChangeText(scaffold);
    if (id === "release") {
      setOptionsOpen(true);
      setReleaseMode(true);
    }
    window.setTimeout(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const end = id === "release" ? 2 : scaffold.indexOf("\n") > 0 ? scaffold.indexOf("\n") : scaffold.length;
      el.setSelectionRange(end, end);
    }, 0);
  };

  const handlePreview = async () => {
    if (!requirement || !repoId) return;
    setBusy("preview");
    setError("");
    try {
      const res = await api.previewIntake({ ...buildPayload(), previewOnly: true });
      setPlan(res.plan);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const handleRun = async () => {
    if (!canRun) return;
    setBusy("run");
    setError("");
    try {
      if (releaseMode) {
        const requirements = parseMilestoneRequirements(text);
        await api.createMilestone({
          repoId,
          name: milestoneTitle.trim() || `Release ${version.trim()}`,
          targetVersion: version.trim().replace(/^v/, ""),
          requirements: requirements.length > 0 ? requirements : [requirement],
          maxBudgetUsdPerItem: Number(budget) > 0 ? Number(budget) : undefined,
          preferredEngine: engine === "auto" ? undefined : engine,
        });
        await onSubmitted("milestone");
      } else {
        const res = await api.submitIntake(buildPayload());
        await onSubmitted(res.route);
      }
      setText("");
      setPlan(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="w-full space-y-3">
      <div className="rounded-2xl border border-zinc-800/90 bg-zinc-900/75 p-4 shadow-xl shadow-black/30 focus-within:border-indigo-500/60 focus-within:ring-2 focus-within:ring-indigo-500/15 transition space-y-3">
        <textarea
          ref={textareaRef}
          rows={4}
          value={text}
          disabled={!repo}
          onChange={(e) => onChangeText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void handleRun();
            }
          }}
          placeholder={repo ? t("composer.placeholder") : t("composer.noRepo")}
          aria-label={t("composer.placeholder")}
          className="w-full min-h-[96px] resize-none bg-transparent text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none leading-relaxed"
        />

        {plan && (
          <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/5 px-3 py-2 text-xs space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <Sparkles className="w-3.5 h-3.5 text-indigo-400" aria-hidden="true" />
              <span className="font-semibold text-indigo-200">
                {t(planLabelKey(plan))}
                {plan.route === "epic_dag" && plan.epicPlan
                  ? ` · ${plan.epicPlan.subtasks.length} ${t("composer.plan.steps")}`
                  : ""}
              </span>
              <span className="text-zinc-300 truncate">{plan.title}</span>
            </div>
            <p className="text-zinc-400">{plan.rationale}</p>
            {(plan.singleSpec?.allowedPaths?.length ?? 0) > 0 && (
              <div className="flex flex-wrap gap-1">
                {plan.singleSpec?.allowedPaths.slice(0, 6).map((p) => (
                  <code
                    key={p}
                    className="px-1.5 py-0.5 rounded bg-zinc-950 border border-zinc-800 text-[10px] text-emerald-300"
                  >
                    {p}
                  </code>
                ))}
              </div>
            )}
          </div>
        )}

        {error && <div className="text-xs text-rose-400 break-words">{error}</div>}

        {/* Integrated context toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <div className="inline-flex items-center gap-1">
              <div className="inline-flex items-center gap-1.5 pl-2 rounded-full border border-zinc-800 bg-zinc-950/60">
                <FolderGit2 className="w-3.5 h-3.5 text-zinc-400" aria-hidden="true" />
                <select
                  value={repo?.id ?? selectedRepoId}
                  onChange={(e) => onSelectRepo(e.target.value)}
                  aria-label={t("header.repoSelect")}
                  className="bg-transparent py-1 pr-2 text-xs text-zinc-200 max-w-[190px] rounded-full"
                >
                  {repos.length === 0 ? (
                    <option value="">{t("header.noRepo")}</option>
                  ) : (
                    repos.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name} · {r.baseBranch}
                      </option>
                    ))
                  )}
                </select>
              </div>
              <button
                type="button"
                onClick={onOpenAddRepo}
                title={t("header.registerRepoTitle")}
                aria-label={t("header.registerRepoTitle")}
                className="p-1.5 rounded-full border border-zinc-800 bg-zinc-950/60 text-zinc-400 hover:text-zinc-100 hover:border-zinc-700 transition"
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>

            {repo && (
              <div
                role="radiogroup"
                aria-label={t("header.presetLabel")}
                className="inline-flex items-center rounded-full border border-zinc-800 bg-zinc-950/60 p-0.5"
              >
                {AUTONOMY_PRESETS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={activePreset === p}
                    title={t(`preset.${p}Desc` as TranslationKey)}
                    onClick={() => {
                      if (p !== activePreset) onChangeAutonomyPreset(repo.id, p);
                    }}
                    className={`px-2.5 py-1 rounded-full text-[11px] font-medium border transition ${
                      activePreset === p
                        ? PRESET_ACTIVE[p]
                        : "border-transparent text-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    {t(`preset.${p}` as TranslationKey)}
                  </button>
                ))}
              </div>
            )}

            <button
              type="button"
              onClick={() => setOptionsOpen((v) => !v)}
              aria-expanded={optionsOpen}
              aria-controls="composer-options"
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-medium transition ${
                optionsOpen
                  ? "border-indigo-500/40 bg-indigo-500/10 text-indigo-200"
                  : "border-zinc-800 bg-zinc-950/60 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" aria-hidden="true" />
              {t("composer.options")}
            </button>
          </div>

          <div className="flex items-center gap-2 ml-auto">
            <kbd className="hidden sm:inline text-[10px] text-zinc-600 font-mono">⌘⏎</kbd>
            {repo ? (
              <>
                <button
                  type="button"
                  disabled={!requirement || busy !== null || releaseMode}
                  onClick={() => void handlePreview()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-zinc-700/80 bg-transparent hover:bg-zinc-800 text-zinc-300 text-xs font-medium disabled:opacity-40 transition"
                >
                  {busy === "preview" ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                  )}
                  {t("composer.preview")}
                </button>
                <button
                  type="button"
                  disabled={!canRun}
                  onClick={() => void handleRun()}
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold disabled:opacity-40 transition"
                >
                  {busy === "run" ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Play className="w-3.5 h-3.5" aria-hidden="true" />
                  )}
                  {releaseMode ? t("composer.runRelease") : t("composer.run")}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={onOpenAddRepo}
                className="px-4 py-1.5 rounded-full bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition"
              >
                {t("composer.addRepoCta")}
              </button>
            )}
          </div>
        </div>

        {optionsOpen && (
          <div
            id="composer-options"
            className="border-t border-zinc-800 pt-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs"
          >
            <div className="md:col-span-2 flex flex-wrap items-center gap-3">
              <label className="inline-flex items-center gap-2 text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={releaseMode}
                  onChange={(e) => setReleaseMode(e.target.checked)}
                  className="rounded border-zinc-700 bg-zinc-950 text-indigo-500"
                />
                {t("composer.releaseMode")}
              </label>
              {releaseMode && (
                <>
                  <input
                    value={version}
                    onChange={(e) => setVersion(e.target.value)}
                    placeholder="vX.Y.Z"
                    aria-label={t("milestone.versionLabel")}
                    className={`${INPUT_CLS} !w-28 font-mono ${versionOk ? "" : "border-rose-500/60"}`}
                  />
                  <input
                    value={milestoneTitle}
                    onChange={(e) => setMilestoneTitle(e.target.value)}
                    placeholder={t("composer.milestoneTitle")}
                    className={`${INPUT_CLS} flex-1 min-w-[160px]`}
                  />
                  <span className="basis-full text-[11px] text-zinc-500">{t("composer.releaseHint")}</span>
                </>
              )}
            </div>
            <div>
              <label htmlFor="composer-scope" className="block text-zinc-400 mb-1">
                {t("composer.scopePaths")}
              </label>
              <input
                id="composer-scope"
                value={scopePaths}
                onChange={(e) => setScopePaths(e.target.value)}
                placeholder="packages/web/**, src/**"
                className={`${INPUT_CLS} font-mono`}
              />
              {scopeTokens.length > 0 && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  <span className="text-[10px] text-zinc-500">{t("composer.scopeTokensHint")}</span>
                  {scopeTokens.map((tok) => (
                    <code
                      key={tok}
                      className="px-1.5 py-0.5 rounded bg-zinc-950 border border-zinc-800 text-[10px] text-emerald-300"
                    >
                      {tok}
                    </code>
                  ))}
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="composer-engine" className="block text-zinc-400 mb-1">
                  {t("composer.engine")}
                </label>
                <select
                  id="composer-engine"
                  value={engine}
                  onChange={(e) => setEngine(e.target.value as "auto" | WorkerEngineId)}
                  className={INPUT_CLS}
                >
                  <option value="auto">{t("composer.engineAuto")}</option>
                  {availableEngines.map((e) => (
                    <option key={e} value={e}>
                      {formatEngineDisplayName(e, locale)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="composer-budget" className="block text-zinc-400 mb-1">
                  {t("composer.budget")}
                </label>
                <input
                  id="composer-budget"
                  type="number"
                  min="0"
                  step="0.5"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                  placeholder="2.0"
                  className={`${INPUT_CLS} font-mono`}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {requirement === "" && repo && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {STARTERS.map(({ id, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => applyStarter(id)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-zinc-800 bg-zinc-900/50 hover:bg-zinc-900 hover:border-zinc-700 text-zinc-400 hover:text-zinc-100 text-xs transition"
            >
              <Icon className="w-3.5 h-3.5" aria-hidden="true" />
              {t(`composer.starter.${id}` as TranslationKey)}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
