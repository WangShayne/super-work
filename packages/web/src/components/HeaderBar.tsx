import { Clock, Cpu, FolderGit2, Home, Languages, Plus, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { useI18n, type TranslationKey } from "../i18n.tsx";
import type { EngineHealthRecord, RepoConfig, SelfReloadState, WorkerEngineId } from "../types.ts";
import { healthAlertReasons, type HealthAlertReason } from "../utils/superAgent.ts";

export type MainTab = "home" | "history" | "settings";

interface HeaderBarProps {
  activeTab: MainTab;
  onChangeTab: (tab: MainTab) => void;
  pendingInboxCount: number;
  historyCount: number;
  repos: RepoConfig[];
  selectedRepoId: string;
  onSelectRepo: (id: string) => void;
  /** SSE is offline AFTER the initial mount grace period (computed by App). */
  sseOffline: boolean;
  engineHealth: EngineHealthRecord[];
  availableEngines: WorkerEngineId[];
  selfReload?: SelfReloadState;
  onOpenAddRepo: () => void;
  onOpenCommandPalette: () => void;
  onOpenEngineHealth: () => void;
}

const REASON_KEY: Record<HealthAlertReason, TranslationKey> = {
  sse_offline: "header.alert.sse",
  no_healthy_engine: "header.alert.engines",
  pinned_engine_down: "header.alert.pinned",
};

export function HeaderBar({
  activeTab,
  onChangeTab,
  pendingInboxCount,
  historyCount,
  repos,
  selectedRepoId,
  onSelectRepo,
  sseOffline,
  engineHealth,
  availableEngines,
  selfReload,
  onOpenAddRepo,
  onOpenCommandPalette,
  onOpenEngineHealth,
}: HeaderBarProps) {
  const { t, toggleLocale } = useI18n();
  const activeRepo = repos.find((r) => r.id === selectedRepoId) ?? repos[0];
  const reasons = healthAlertReasons({ sseOffline, availableEngines, engineHealth, repo: activeRepo });
  const reloadPhase = selfReload && selfReload.phase !== "idle" ? selfReload : undefined;
  const reloadBad = reloadPhase?.phase === "rolled_back" || reloadPhase?.phase === "failed";

  const tabs: { id: MainTab; label: string; icon: typeof Home; badge?: ReactNode }[] = [
    {
      id: "home",
      label: t("nav.home"),
      icon: Home,
      badge:
        pendingInboxCount > 0 ? (
          <span className="px-1.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[10px] font-mono">
            {pendingInboxCount}
          </span>
        ) : null,
    },
    {
      id: "history",
      label: t("nav.history"),
      icon: Clock,
      badge: <span className="text-[10px] font-mono text-zinc-500">{historyCount}</span>,
    },
    { id: "settings", label: t("nav.settings"), icon: Settings },
  ];

  return (
    <header className="sticky top-0 z-20 border-b border-zinc-800/70 bg-zinc-950/90 backdrop-blur-md">
      <div className="min-h-[52px] px-4 sm:px-5 py-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        {/* Left: brand + health */}
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-indigo-500/15 border border-indigo-400/30 flex items-center justify-center text-indigo-400">
            <Cpu className="w-3.5 h-3.5" aria-hidden="true" />
          </div>
          <span className="font-semibold tracking-tight text-zinc-100 text-sm">super-work</span>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-300/90 border border-indigo-500/25">
            v1.8
          </span>
          {reloadPhase && (
            <span
              title={reloadPhase.summary ?? reloadPhase.error}
              className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                reloadBad
                  ? "bg-rose-500/15 text-rose-300 border-rose-500/35"
                  : "bg-amber-500/15 text-amber-200 border-amber-500/35 animate-pulse"
              }`}
            >
              {t(`selfHost.phase.${reloadPhase.phase}` as TranslationKey)}
            </span>
          )}
          {reasons.length === 0 ? (
            <span
              role="img"
              title={t("header.healthOk")}
              aria-label={t("header.healthOk")}
              className="inline-flex items-center px-1"
            >
              <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px] shadow-emerald-400/60" />
            </span>
          ) : (
            <button
              type="button"
              onClick={onOpenEngineHealth}
              title={t("header.alertsTitle")}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 text-amber-200 text-[11px] font-medium transition"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" aria-hidden="true" />
              {t(REASON_KEY[reasons[0]!])}
              {reasons.length > 1 ? ` +${reasons.length - 1}` : ""}
            </button>
          )}
        </div>

        {/* Center: floating pill tablist */}
        <div
          role="tablist"
          aria-label={t("header.mainNav")}
          className="order-last sm:order-none w-full sm:w-auto flex justify-center bg-zinc-900/80 border border-zinc-800/80 rounded-full p-0.5"
        >
          {tabs.map(({ id, label, icon: Icon, badge }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={activeTab === id}
              onClick={() => onChangeTab(id)}
              className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-medium transition ${
                activeTab === id ? "bg-zinc-800 text-zinc-100 shadow-sm" : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <Icon className="w-3.5 h-3.5" aria-hidden="true" />
              {label}
              {badge}
            </button>
          ))}
        </div>

        {/* Right: compact repo pill (non-home only), ⌘K, language */}
        <div className="flex items-center gap-2">
          {activeTab !== "home" && (
            <div className="flex items-center gap-1">
              <div className="inline-flex items-center gap-1.5 pl-2 rounded-full border border-zinc-800 bg-zinc-900">
                <FolderGit2 className="w-3.5 h-3.5 text-zinc-400" aria-hidden="true" />
                <select
                  value={activeRepo?.id ?? ""}
                  onChange={(e) => onSelectRepo(e.target.value)}
                  aria-label={t("header.repoSelect")}
                  className="bg-transparent py-1 pr-2 text-xs text-zinc-200 max-w-[160px] rounded-full"
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
                className="p-1.5 rounded-full border border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-100 hover:border-zinc-700 transition"
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={onOpenCommandPalette}
            title="⌘K / Ctrl+K"
            className="px-2.5 py-1 rounded-full border border-indigo-500/35 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-200 text-xs font-medium transition"
          >
            {t("header.cmdK")}
          </button>
          <button
            type="button"
            onClick={toggleLocale}
            title={t("header.langTitle")}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-xs transition"
          >
            <Languages className="w-3.5 h-3.5" aria-hidden="true" />
            {t("header.langButton")}
          </button>
        </div>
      </div>
    </header>
  );
}
