import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { api } from "../api.ts";
import type { EngineRoomTarget } from "../components/EngineRoomPanel.tsx";
import { formatEngineDisplayName, useI18n, type TranslationKey } from "../i18n.tsx";
import type {
  AutonomyPreset,
  EnginePreference,
  PublicSetupStatus,
  RepoConfig,
  RepoMetricsSummary,
  WorkerEngineId,
} from "../types.ts";
import { AUTONOMY_PRESETS, formatUsd, inferAutonomyPreset } from "../utils/superAgent.ts";

const EngineRoomPanel = lazy(() =>
  import("../components/EngineRoomPanel.tsx").then((m) => ({ default: m.EngineRoomPanel })),
);

type RepoPatch = Parameters<typeof api.patchRepo>[1];

interface SettingsViewProps {
  repo: RepoConfig | undefined;
  repos: RepoConfig[];
  availableEngines: WorkerEngineId[];
  setupStatus: PublicSetupStatus | null;
  metrics: RepoMetricsSummary | null;
  target: EngineRoomTarget | null;
  onChangeAutonomyPreset: (repoId: string, preset: AutonomyPreset) => void;
  onPatchRepo: (repoId: string, patch: RepoPatch) => Promise<void>;
  onOpenAddRepo: () => void;
  onOpenSetup: () => void;
  onSetupSaved: (next: PublicSetupStatus) => void;
  onInspectTicket: (ticketId: string) => void;
  onRefresh: () => void;
}

const FIELD =
  "w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500 disabled:opacity-60";
const SAVE_BTN =
  "px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium disabled:opacity-40 transition";

function Card({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
        {hint && <p className="text-[11px] text-zinc-500 mt-0.5">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className="inline-flex items-center gap-2 text-xs text-zinc-200 cursor-pointer select-none">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative w-8 h-[18px] rounded-full transition disabled:opacity-50 ${
          checked ? "bg-indigo-500" : "bg-zinc-700"
        }`}
      >
        <span
          className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-all ${
            checked ? "left-[16px]" : "left-0.5"
          }`}
        />
      </button>
      {label}
    </label>
  );
}

export function SettingsView({
  repo,
  repos,
  availableEngines,
  setupStatus,
  metrics,
  target,
  onChangeAutonomyPreset,
  onPatchRepo,
  onOpenAddRepo,
  onOpenSetup,
  onSetupSaved,
  onInspectTicket,
  onRefresh,
}: SettingsViewProps) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [githubRepo, setGithubRepo] = useState("");
  const [budget, setBudget] = useState("");
  const [manualEngines, setManualEngines] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ key: string; text: string; error?: boolean } | null>(null);
  const [engineRoomOpen, setEngineRoomOpen] = useState(false);
  const engineRoomRef = useRef<HTMLDivElement | null>(null);

  const notif = setupStatus?.config.notifications;
  const [macos, setMacos] = useState(false);
  const [webhookOn, setWebhookOn] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");

  useEffect(() => {
    if (!repo) return;
    setName(repo.name);
    setBaseBranch(repo.baseBranch);
    setGithubRepo(repo.githubRepo ?? "");
    setBudget(repo.dailyBudgetUsd ? String(repo.dailyBudgetUsd) : "");
    setManualEngines(repo.preferredImplementEngine !== "auto");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo?.id, repo?.updatedAt]);

  useEffect(() => {
    setMacos(Boolean(notif?.macosEnabled));
    setWebhookOn(Boolean(notif?.webhookEnabled));
    setWebhookUrl(notif?.webhookUrl ?? "");
  }, [notif?.macosEnabled, notif?.webhookEnabled, notif?.webhookUrl]);

  useEffect(() => {
    if (!target) return;
    setEngineRoomOpen(true);
    const id = window.setTimeout(
      () => engineRoomRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
      120,
    );
    return () => window.clearTimeout(id);
  }, [target]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusyKey(key);
    setNotice(null);
    try {
      await fn();
      setNotice({ key, text: t("settings.saved") });
    } catch (err) {
      setNotice({ key, text: err instanceof Error ? err.message : String(err), error: true });
    } finally {
      setBusyKey(null);
    }
  };

  const noteFor = (key: string) =>
    notice?.key === key ? (
      <span className={`text-[11px] ${notice.error ? "text-rose-400" : "text-emerald-300"} break-words`}>
        {notice.text}
      </span>
    ) : null;

  const activePreset = inferAutonomyPreset(repo);
  const readyTools = (setupStatus?.scanReport.tools ?? []).filter((x) => x.installed && x.authenticated === true);
  const effectiveBudget = metrics?.effectiveDailyBudgetUsd ?? metrics?.dailyBudgetUsd;
  const spend = metrics?.todayCostUsd ?? 0;
  const spendPct = effectiveBudget && effectiveBudget > 0 ? Math.min(100, (spend / effectiveBudget) * 100) : 0;
  const autoEngines = repo?.preferredImplementEngine === "auto";

  const engineOptions = Array.from(new Set<WorkerEngineId>([...availableEngines, "mock"]));

  const saveNotifications = () =>
    run("notif", async () => {
      if (!setupStatus) throw new Error(t("settings.notif.needSetup"));
      const c = setupStatus.config;
      const next = await api.configureSetup({
        llmPreset: c.llmPreset,
        llmBaseUrl: c.llmBaseUrl,
        llmModel: c.llmModel,
        llmEffort: c.llmEffort,
        preferredImplementEngine: c.preferredImplementEngine,
        preferredReviewEngine: c.preferredReviewEngine,
        claudeProfile: c.claudeProfile,
        codexProfile: c.codexProfile,
        opencodeProfile: c.opencodeProfile,
        geminiProfile: c.geminiProfile,
        notifications: {
          macosEnabled: macos,
          webhookEnabled: webhookOn,
          webhookUrl: webhookUrl.trim() || undefined,
        },
      });
      onSetupSaved(next);
    });

  if (!repo) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-10 text-center space-y-3">
        <p className="text-sm text-zinc-400">{t("settings.noRepo")}</p>
        <button type="button" onClick={onOpenAddRepo} className={SAVE_BTN}>
          {t("composer.addRepoCta")}
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-6 space-y-4">
      {/* 1. Repository & Branch */}
      <Card title={t("settings.repo.title")}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <div>
            <label className="block text-zinc-400 mb-1">{t("modal.repo.name")}</label>
            <input value={name} onChange={(e) => setName(e.target.value)} className={FIELD} />
          </div>
          <div>
            <label className="block text-zinc-400 mb-1">{t("modal.repo.baseBranch")}</label>
            <input value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} className={`${FIELD} font-mono`} />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-zinc-400 mb-1">{t("modal.repo.path")}</label>
            <input value={repo.rootPath} readOnly disabled className={`${FIELD} font-mono`} />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-zinc-400 mb-1">
              {t("modal.repo.githubRepo")}
            </label>
            <input
              value={githubRepo}
              onChange={(e) => setGithubRepo(e.target.value)}
              placeholder={t("modal.repo.githubPlaceholder")}
              className={`${FIELD} font-mono`}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busyKey === "repo" || !name.trim()}
            onClick={() =>
              void run("repo", () =>
                onPatchRepo(repo.id, {
                  name: name.trim(),
                  baseBranch: baseBranch.trim() || "main",
                  githubRepo: githubRepo.trim(),
                }),
              )
            }
            className={SAVE_BTN}
          >
            {t("modal.repoSettings.save")}
          </button>
          <button
            type="button"
            onClick={onOpenAddRepo}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 text-xs transition"
          >
            <Plus className="w-3.5 h-3.5" />
            {t("header.registerRepoTitle")}
          </button>
          {noteFor("repo")}
        </div>
      </Card>

      {/* 2. Autonomy level */}
      <Card title={t("settings.autonomy.title")} hint={t("settings.autonomy.hint")}>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5" role="radiogroup">
          {AUTONOMY_PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={activePreset === p}
              onClick={() => {
                if (p !== activePreset) onChangeAutonomyPreset(repo.id, p);
              }}
              className={`text-left rounded-xl border p-3 space-y-1 transition ${
                activePreset === p
                  ? "border-indigo-500/60 bg-indigo-500/10"
                  : "border-zinc-800 bg-zinc-950/50 hover:border-zinc-600"
              }`}
            >
              <div className="text-xs font-semibold text-zinc-100">{t(`preset.${p}` as TranslationKey)}</div>
              <p className="text-[11px] text-zinc-400 leading-relaxed">{t(`preset.${p}Long` as TranslationKey)}</p>
            </button>
          ))}
        </div>
      </Card>

      {/* 3. Daily budget */}
      <Card title={t("settings.budget.title")} hint={t("settings.budget.hint")}>
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-36">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-zinc-500">$</span>
            <input
              type="number"
              min="0"
              step="1"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              placeholder="—"
              aria-label={t("settings.budget.title")}
              className={`${FIELD} pl-6 font-mono`}
            />
          </div>
          <button
            type="button"
            disabled={busyKey === "budget"}
            onClick={() =>
              void run("budget", async () => {
                const v = Number(budget);
                await onPatchRepo(repo.id, { dailyBudgetUsd: budget.trim() && v > 0 ? v : null });
              })
            }
            className={SAVE_BTN}
          >
            {t("modal.repoSettings.save")}
          </button>
          {noteFor("budget")}
        </div>
        <div>
          <div className="flex justify-between text-[11px] text-zinc-400 mb-1 font-mono">
            <span>{t("history.todaySpend")}</span>
            <span>
              {formatUsd(spend)}
              {effectiveBudget ? ` / ${formatUsd(effectiveBudget)}` : ""}
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
            <div
              className={`h-full ${metrics?.budgetExceeded ? "bg-rose-500" : "bg-indigo-500"}`}
              style={{ width: `${spendPct}%` }}
            />
          </div>
        </div>
      </Card>

      {/* 4. Engines */}
      <Card title={t("settings.engines.title")}>
        <div className="flex flex-wrap items-center gap-3">
          <Toggle
            checked={autoEngines}
            label={t("settings.engines.auto")}
            disabled={busyKey === "engines"}
            onChange={(v) =>
              void run("engines", async () => {
                await onPatchRepo(repo.id, {
                  preferredImplementEngine: v ? "auto" : (readyTools[0]?.id as EnginePreference | undefined) ?? "claude",
                });
              })
            }
          />
          <div className="flex flex-wrap gap-1.5">
            {readyTools.length === 0 ? (
              <span className="text-[11px] text-zinc-500">{t("settings.engines.noneReady")}</span>
            ) : (
              readyTools.map((tool) => (
                <span
                  key={tool.id}
                  className="px-2 py-0.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 text-[11px] font-mono"
                >
                  {tool.id} ✓
                </span>
              ))
            )}
          </div>
          {noteFor("engines")}
          <button
            type="button"
            onClick={onOpenSetup}
            className="ml-auto text-[11px] text-indigo-400 hover:text-indigo-300"
          >
            {t("settings.engines.customizeLlm")}
          </button>
        </div>
        <button
          type="button"
          onClick={() => setManualEngines((v) => !v)}
          aria-expanded={manualEngines}
          className="inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-300"
        >
          {manualEngines ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          {t("settings.engines.manual")}
        </button>
        {manualEngines && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div>
              <label className="block text-zinc-400 mb-1">{t("settings.engines.implement")}</label>
              <select
                value={repo.preferredImplementEngine}
                onChange={(e) =>
                  void run("engines", () =>
                    onPatchRepo(repo.id, { preferredImplementEngine: e.target.value as EnginePreference }),
                  )
                }
                className={FIELD}
              >
                <option value="auto">{formatEngineDisplayName("auto", "en")}</option>
                {engineOptions.map((e) => (
                  <option key={e} value={e}>
                    {formatEngineDisplayName(e, "en")}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-zinc-400 mb-1">{t("settings.engines.review")}</label>
              <select
                value={repo.preferredReviewEngine}
                onChange={(e) =>
                  void run("engines", () =>
                    onPatchRepo(repo.id, { preferredReviewEngine: e.target.value as WorkerEngineId }),
                  )
                }
                className={FIELD}
              >
                {engineOptions.map((e) => (
                  <option key={e} value={e}>
                    {formatEngineDisplayName(e, "en")}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
      </Card>

      {/* 5. Notifications */}
      <Card title={t("settings.notif.title")}>
        <div className="space-y-3">
          <Toggle checked={macos} onChange={setMacos} label={t("settings.notif.macos")} />
          <div className="space-y-2">
            <Toggle checked={webhookOn} onChange={setWebhookOn} label={t("settings.notif.webhook")} />
            {webhookOn && (
              <input
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
                placeholder="https://hooks.example.com/…"
                aria-label={t("settings.notif.webhook")}
                className={`${FIELD} font-mono`}
              />
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={busyKey === "notif" || !setupStatus} onClick={() => void saveNotifications()} className={SAVE_BTN}>
              {t("modal.repoSettings.save")}
            </button>
            {noteFor("notif")}
          </div>
        </div>
      </Card>

      {/* Layer 2 — Developer / Engine Room */}
      <div ref={engineRoomRef} className="pt-2">
        <button
          type="button"
          onClick={() => setEngineRoomOpen((v) => !v)}
          aria-expanded={engineRoomOpen}
          className="w-full flex items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-zinc-900/40 hover:bg-zinc-900 px-4 py-3 text-left transition"
        >
          <span>
            <span className="block text-sm font-semibold text-zinc-100">{t("engineRoom.title")}</span>
            <span className="block text-[11px] text-zinc-500">{t("engineRoom.subtitle")}</span>
          </span>
          {engineRoomOpen ? <ChevronDown className="w-4 h-4 text-zinc-400" /> : <ChevronRight className="w-4 h-4 text-zinc-400" />}
        </button>
        {engineRoomOpen && (
          <div className="mt-3">
            <Suspense fallback={<div className="py-8 text-center text-xs text-zinc-500">…</div>}>
              <EngineRoomPanel
                repo={repo}
                repos={repos}
                availableEngines={availableEngines}
                target={target}
                metrics={metrics}
                onInspectTicket={onInspectTicket}
                onRefresh={onRefresh}
                onPatchRepo={onPatchRepo}
              />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  );
}
