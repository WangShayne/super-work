import { Activity, Cpu, FolderGit2, Languages, Plus, Radio, Send, ShieldCheck } from "lucide-react";
import { useI18n } from "../i18n.tsx";
import type { HealthResponse, OperatingMode, RepoConfig } from "../types.ts";

interface HeaderBarProps {
  repos: RepoConfig[];
  selectedRepoId: string;
  onSelectRepo: (id: string) => void;
  onChangeMode: (repoId: string, mode: OperatingMode) => void;
  health: HealthResponse | null;
  sseConnected: boolean;
  onOpenDispatch: () => void;
  onOpenSimulate: () => void;
  onOpenAddRepo: () => void;
}

export function HeaderBar({
  repos,
  selectedRepoId,
  onSelectRepo,
  onChangeMode,
  health,
  sseConnected,
  onOpenDispatch,
  onOpenSimulate,
  onOpenAddRepo,
}: HeaderBarProps) {
  const { t, toggleLocale } = useI18n();
  const activeRepo = repos.find((r) => r.id === selectedRepoId) ?? repos[0];

  const modes: Array<{ id: OperatingMode; label: string; desc: string }> = [
    { id: "off", label: t("header.mode.off"), desc: t("header.mode.offDesc") },
    { id: "observe", label: t("header.mode.observe"), desc: t("header.mode.observeDesc") },
    { id: "auto", label: t("header.mode.auto"), desc: t("header.mode.autoDesc") },
  ];

  return (
    <header className="border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur px-5 py-3 flex flex-wrap items-center justify-between gap-4 sticky top-0 z-20">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-indigo-500/15 border border-indigo-400/30 flex items-center justify-center text-indigo-400">
            <Cpu className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold tracking-tight text-zinc-100 text-sm">super-work</span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700/60">
                {t("brand.badge")}
              </span>
            </div>
            <p className="text-[11px] text-zinc-500">
              {t("brand.subtitle")}
            </p>
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

      <div className="flex items-center gap-3 flex-wrap">
        <div className="hidden lg:flex items-center gap-2 text-[11px]">
          <span
            className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full border ${
              sseConnected
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                : "border-rose-500/30 bg-rose-500/10 text-rose-300"
            }`}
          >
            <Radio className="w-3 h-3" />
            {sseConnected ? t("header.sse.live") : t("header.sse.reconnecting")}
          </span>

          {health?.availableEngines.map((eng) => (
            <span
              key={eng}
              className="px-2 py-1 rounded-md bg-zinc-900 border border-zinc-800 text-zinc-300 font-mono"
            >
              {eng}
            </span>
          ))}

          {health && (
            <span
              title={`${t("header.controlPlanePrefix")}: ${health.llmProvider}`}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-zinc-900 border border-zinc-800 text-zinc-400"
            >
              <ShieldCheck className="w-3 h-3 text-indigo-400" />
              {t("header.watchdog")}
            </span>
          )}

          {health && (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-zinc-900 border border-zinc-800 text-zinc-400">
              <Activity className="w-3 h-3 text-sky-400" />
              {t("header.outboxPrefix")}: {health.counts.pendingOutbox}
            </span>
          )}
        </div>

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
    </header>
  );
}
