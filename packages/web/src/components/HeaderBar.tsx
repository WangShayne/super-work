import type { ReactNode } from "react";
import {
  Activity,
  Bot,
  BrainCircuit,
  Clock,
  Cpu,
  FileJson2,
  FolderGit2,
  Languages,
  Plus,
  Radio,
  Send,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import {
  formatEngineDisplayName,
  formatLlmProviderDisplay,
  useI18n,
} from "../i18n.tsx";
import type { HealthResponse, OperatingMode, RepoConfig } from "../types.ts";

interface HeaderBarProps {
  repos: RepoConfig[];
  selectedRepoId: string;
  onSelectRepo: (id: string) => void;
  onChangeMode: (repoId: string, mode: OperatingMode) => void;
  health: HealthResponse | null;
  sseConnected: boolean;
  runningTicketCount: number;
  attentionTicketCount: number;
  onOpenDispatch: () => void;
  onOpenSimulate: () => void;
  onOpenAddRepo: () => void;
  onOpenRepoSettings: () => void;
  onOpenContractSettings?: () => void;
  onOpenRoutines?: () => void;
  onOpenWorktrees: () => void;
  onOpenSetup: () => void;
}

interface StatusCapsuleProps {
  icon: ReactNode;
  label: string;
  value: string;
  extra?: string;
  tone?: "neutral" | "good" | "warn" | "accent";
  align?: "left" | "right";
  tooltipTitle: string;
  tooltipBody: string;
  tooltipFooter?: string;
  onClick?: () => void;
}

function StatusCapsule({
  icon,
  label,
  value,
  extra,
  tone = "neutral",
  align = "left",
  tooltipTitle,
  tooltipBody,
  tooltipFooter,
  onClick,
}: StatusCapsuleProps) {
  const toneClasses =
    tone === "good"
      ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-200"
      : tone === "warn"
        ? "border-amber-500/35 bg-amber-500/10 text-amber-200"
        : tone === "accent"
          ? "border-indigo-500/30 bg-indigo-500/10 text-indigo-200"
          : "border-zinc-800 bg-zinc-900/80 text-zinc-200";

  const alignClass = align === "right" ? "right-0" : "left-0";
  const interactiveClass = onClick
    ? "cursor-pointer hover:border-zinc-600 focus:outline-none focus:ring-1 focus:ring-indigo-500/60"
    : "cursor-help";

  const content = (
    <>
      <span className="shrink-0">{icon}</span>
      <span className="text-zinc-400">{label}：</span>
      <span className="font-medium text-zinc-100">{value}</span>
      {extra && <span className="text-zinc-400 font-mono text-[10px]">{extra}</span>}
    </>
  );

  return (
    <div className="relative group shrink-0">
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] whitespace-nowrap transition ${toneClasses} ${interactiveClass}`}
        >
          {content}
        </button>
      ) : (
        <div
          tabIndex={0}
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] whitespace-nowrap transition ${toneClasses} ${interactiveClass}`}
        >
          {content}
        </div>
      )}

      <div
        role="tooltip"
        className={`pointer-events-none invisible opacity-0 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100 transition-opacity duration-150 absolute top-full mt-1.5 ${alignClass} w-72 rounded-xl border border-zinc-700/80 bg-zinc-900/95 backdrop-blur p-3 shadow-2xl z-40 text-left space-y-1.5`}
      >
        <div className="text-[11px] font-semibold text-zinc-100">{tooltipTitle}</div>
        <p className="text-[11px] text-zinc-300 leading-relaxed">{tooltipBody}</p>
        {tooltipFooter && (
          <div className="pt-1 border-t border-zinc-800 text-[10px] font-mono text-indigo-300">
            {tooltipFooter}
          </div>
        )}
      </div>
    </div>
  );
}

export function HeaderBar({
  repos,
  selectedRepoId,
  onSelectRepo,
  onChangeMode,
  health,
  sseConnected,
  runningTicketCount,
  attentionTicketCount,
  onOpenDispatch,
  onOpenSimulate,
  onOpenAddRepo,
  onOpenRepoSettings,
  onOpenContractSettings,
  onOpenRoutines,
  onOpenWorktrees,
  onOpenSetup,
}: HeaderBarProps) {
  const { locale, t, toggleLocale } = useI18n();
  const activeRepo = repos.find((r) => r.id === selectedRepoId) ?? repos[0];

  const modes: Array<{ id: OperatingMode; label: string; desc: string }> = [
    { id: "off", label: t("header.mode.off"), desc: t("header.mode.offDesc") },
    { id: "observe", label: t("header.mode.observe"), desc: t("header.mode.observeDesc") },
    { id: "auto", label: t("header.mode.auto"), desc: t("header.mode.autoDesc") },
  ];

  const implEngine = activeRepo?.preferredImplementEngine ?? "claude";
  const reviewEngine = activeRepo?.preferredReviewEngine ?? "codex";
  const availableList = (health?.availableEngines ?? []).map((e) =>
    formatEngineDisplayName(e, locale),
  );
  const llmDisplay = formatLlmProviderDisplay(health?.llmProvider, locale);
  const activeWorktrees = health?.counts.activeWorktrees ?? 0;
  const reclaimableWorktrees = health?.counts.reclaimableWorktrees ?? 0;

  const implDisplay = formatEngineDisplayName(implEngine, locale);
  const reviewDisplay = formatEngineDisplayName(reviewEngine, locale);
  const enginesCompactValue =
    implEngine === reviewEngine ? implDisplay : `${implDisplay} → ${reviewDisplay}`;
  const smokeEnabled = Boolean(activeRepo?.smokeCheck?.enabled);
  const hasStaticGate = Boolean(
    activeRepo?.contractSyncedAt || (activeRepo?.verificationCommands?.length ?? 0) > 0,
  );

  return (
    <header className="border-b border-zinc-800/80 bg-zinc-950/95 backdrop-blur sticky top-0 z-20">
      {/* Row 1: Primary Bar */}
      <div className="px-5 py-3 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/15 border border-indigo-400/30 flex items-center justify-center text-indigo-400">
              <Cpu className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold tracking-tight text-zinc-100 text-sm">super-work</span>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">
                  v0.8
                </span>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700/60">
                  {t("brand.badge")}
                </span>
              </div>
              <p className="text-[11px] text-zinc-500">{t("brand.subtitle")}</p>
            </div>
          </div>

          <div className="h-6 w-px bg-zinc-800 hidden sm:block" />

          <div className="flex items-center gap-2">
            <FolderGit2 className="w-4 h-4 text-zinc-400" />
            <select
              value={activeRepo?.id ?? ""}
              onChange={(e) => onSelectRepo(e.target.value)}
              className="bg-zinc-900 border border-zinc-800 rounded-md px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500"
            >
              {repos.length === 0 ? (
                <option value="">{t("header.noRepo")}</option>
              ) : (
                repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.baseBranch})
                  </option>
                ))
              )}
            </select>
            <button
              onClick={onOpenAddRepo}
              title={t("header.registerRepoTitle")}
              className="p-1.5 rounded-md border border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-100 hover:border-zinc-700 transition"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onOpenRepoSettings}
              disabled={!activeRepo}
              title={t("header.repoSettingsTitle")}
              className="p-1.5 rounded-md border border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-100 hover:border-zinc-700 disabled:opacity-40 transition"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
            </button>
          </div>

          {activeRepo && (
            <div className="flex items-center bg-zinc-900 rounded-lg p-0.5 border border-zinc-800">
              {modes.map((m) => {
                const selected = activeRepo.mode === m.id;
                const activeColors =
                  m.id === "auto"
                    ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                    : m.id === "observe"
                      ? "bg-amber-500/20 text-amber-300 border-amber-500/40"
                      : "bg-zinc-800 text-zinc-300 border-zinc-700";
                return (
                  <button
                    key={m.id}
                    title={m.desc}
                    onClick={() => onChangeMode(activeRepo.id, m.id)}
                    className={`px-2.5 py-1 rounded-md text-[11px] font-medium border transition ${
                      selected
                        ? activeColors
                        : "border-transparent text-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2.5 flex-wrap">
          <button
            onClick={onOpenSetup}
            title={t("header.settingsTitle")}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 text-xs font-medium transition"
          >
            <Settings className="w-3.5 h-3.5 text-zinc-400" />
            {t("header.settings")}
          </button>

          <button
            onClick={toggleLocale}
            title={t("header.langTitle")}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-xs font-medium transition"
          >
            <Languages className="w-3.5 h-3.5 text-indigo-400" />
            {t("header.langButton")}
          </button>

          <button
            onClick={onOpenSimulate}
            disabled={!activeRepo}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 text-xs font-medium disabled:opacity-40 transition"
          >
            <Send className="w-3.5 h-3.5 text-amber-400" />
            {t("header.simulateEvent")}
          </button>

          <button
            onClick={onOpenDispatch}
            disabled={!activeRepo}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium disabled:opacity-40 transition shadow-sm shadow-indigo-950"
          >
            <Plus className="w-3.5 h-3.5" />
            {t("header.dispatchTask")}
          </button>
        </div>
      </div>

      {/* Row 2: Self-Explanatory System Status Strip */}
      <div className="px-5 py-1.5 border-t border-zinc-800/60 bg-zinc-900/40 flex flex-wrap items-center gap-1.5">
        <StatusCapsule
          icon={
            <Radio
              className={`w-3 h-3 ${sseConnected ? "text-emerald-400" : "text-rose-400"}`}
            />
          }
          label={t("strip.sse.label")}
          value={sseConnected ? t("strip.sse.live") : t("strip.sse.reconnecting")}
          tone={sseConnected ? "good" : "warn"}
          align="left"
          tooltipTitle={t("strip.sse.label")}
          tooltipBody={t("strip.sse.desc")}
        />

        <StatusCapsule
          icon={<BrainCircuit className="w-3 h-3 text-indigo-400" />}
          label={t("strip.llm.label")}
          value={llmDisplay}
          tone="accent"
          align="left"
          onClick={onOpenSetup}
          tooltipTitle={t("strip.llm.label")}
          tooltipBody={t("strip.llm.desc")}
          tooltipFooter={`${t("header.controlPlanePrefix")}: ${health?.llmProvider ?? "heuristic:local"}`}
        />

        <StatusCapsule
          icon={<Bot className="w-3 h-3 text-sky-400" />}
          label={t("strip.engines.label")}
          value={enginesCompactValue}
          extra={`(${health?.availableEngines.length ?? 0})`}
          align="left"
          onClick={onOpenSetup}
          tooltipTitle={t("strip.engines.label")}
          tooltipBody={t("strip.engines.desc")}
          tooltipFooter={`${t("strip.engines.coding")}: ${implDisplay} · ${t("strip.engines.review")}: ${reviewDisplay} | ${t("strip.engines.detectedPrefix")} ${availableList.join(", ") || "—"}`}
        />

        {activeRepo && (
          <StatusCapsule
            icon={
              <FileJson2
                className={`w-3 h-3 ${
                  smokeEnabled ? "text-emerald-400" : hasStaticGate ? "text-indigo-400" : "text-zinc-400"
                }`}
              />
            }
            label={t("strip.contract.label")}
            value={
              smokeEnabled
                ? activeRepo.smokeCheck?.browserCheck?.enabled
                  ? t("strip.contract.smokeUiOn")
                  : t("strip.contract.smokeOn")
                : hasStaticGate
                  ? t("strip.contract.synced")
                  : t("strip.contract.unset")
            }
            tone={smokeEnabled ? "good" : hasStaticGate ? "accent" : "neutral"}
            align="left"
            onClick={onOpenContractSettings ?? onOpenRepoSettings}
            tooltipTitle={t("strip.contract.label")}
            tooltipBody={t("strip.contract.desc")}
            tooltipFooter={`Sandbox: ${activeRepo.sandboxMode ?? "balanced"} | ${
              smokeEnabled
                ? `Smoke: ${activeRepo.smokeCheck?.startCommand}`
                : `${activeRepo.verificationCommands?.length ?? 0} verification cmd(s)`
            }`}
          />
        )}

        <StatusCapsule
          icon={
            <ShieldCheck
              className={`w-3 h-3 ${
                attentionTicketCount > 0 ? "text-amber-400" : "text-emerald-400"
              }`}
            />
          }
          label={t("strip.watchdog.label")}
          value={
            attentionTicketCount > 0
              ? `${attentionTicketCount} ${t("strip.watchdog.alertSuffix")}`
              : t("strip.watchdog.guarding")
          }
          extra={
            attentionTicketCount === 0
              ? `(${runningTicketCount} ${t("strip.watchdog.runningSuffix")})`
              : undefined
          }
          tone={attentionTicketCount > 0 ? "warn" : "neutral"}
          align="right"
          tooltipTitle={t("strip.watchdog.label")}
          tooltipBody={t("strip.watchdog.desc")}
        />

        <StatusCapsule
          icon={<Activity className="w-3 h-3 text-sky-400" />}
          label={t("strip.outbox.label")}
          value={`${health?.counts.pendingOutbox ?? 0} ${t("strip.outbox.pendingSuffix")}`}
          align="right"
          tooltipTitle={t("strip.outbox.label")}
          tooltipBody={t("strip.outbox.desc")}
        />

        <StatusCapsule
          icon={
            <Clock
              className={`w-3 h-3 ${
                (health?.counts.activeRoutines ?? 0) > 0 ? "text-teal-400" : "text-zinc-400"
              }`}
            />
          }
          label={t("strip.routines.label")}
          value={
            (health?.counts.activeRoutines ?? 0) > 0
              ? `${health?.counts.activeRoutines} ${t("strip.routines.activeSuffix")}`
              : t("strip.routines.none")
          }
          tone={(health?.counts.activeRoutines ?? 0) > 0 ? "good" : "neutral"}
          align="right"
          onClick={onOpenRoutines}
          tooltipTitle={t("strip.routines.label")}
          tooltipBody={t("strip.routines.desc")}
        />

        <StatusCapsule
          icon={
            <FolderGit2
              className={`w-3 h-3 ${
                reclaimableWorktrees > 0 ? "text-amber-400" : "text-sky-400"
              }`}
            />
          }
          label={t("strip.worktrees.label")}
          value={
            reclaimableWorktrees > 0
              ? `${reclaimableWorktrees} ${t("strip.worktrees.reclaimableSuffix")}`
              : activeWorktrees > 0
                ? `${activeWorktrees} ${t("strip.worktrees.activeSuffix")}`
                : t("strip.worktrees.clean")
          }
          extra={
            (health?.counts.activePreviews ?? 0) > 0
              ? `(${health?.counts.activePreviews} ${t("strip.worktrees.liveSuffix")})`
              : reclaimableWorktrees > 0 && activeWorktrees > 0
                ? `(${activeWorktrees} ${t("strip.worktrees.activeSuffix")})`
                : undefined
          }
          tone={reclaimableWorktrees > 0 ? "warn" : "neutral"}
          align="right"
          onClick={onOpenWorktrees}
          tooltipTitle={t("strip.worktrees.label")}
          tooltipBody={t("strip.worktrees.desc")}
        />
      </div>
    </header>
  );
}
