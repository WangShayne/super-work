import type { ReactNode } from "react";
import { ChevronDown, Clock, Compass, Database, FileDiff, History, Send, Terminal } from "lucide-react";
import { useI18n } from "../../i18n.tsx";
import type { EnginePreference } from "../../types.ts";

export type DrawerTab = "overview" | "changes" | "recall" | "outbox" | "checkpoints";

const SECONDARY_TABS: DrawerTab[] = ["recall", "outbox", "checkpoints"];

interface DrawerTabBarProps {
  tab: DrawerTab;
  setTab: (tab: DrawerTab) => void;
  moreOpen: boolean;
  setMoreOpen: (updater: (prev: boolean) => boolean) => void;
  checkpointCount: number;
  outboxCount: number;
  /** Low-frequency actions (Save Golden Eval, Reclaim Worktree, preview, …) shown in the More bar. */
  moreActions?: ReactNode;
}

/** 2 primary tabs (Overview / Changes) plus a quiet `More` secondary bar (tabs + low-frequency actions). */
export function DrawerTabBar({
  tab,
  setTab,
  moreOpen,
  setMoreOpen,
  checkpointCount,
  outboxCount,
  moreActions,
}: DrawerTabBarProps) {
  const { t } = useI18n();
  const primary = [
    { id: "overview" as const, label: t("drawer.tab.overview"), icon: Terminal },
    { id: "changes" as const, label: t("drawer.tab.changes"), icon: FileDiff },
  ];
  const secondary = [
    { id: "checkpoints" as const, label: `${t("drawer.tab.checkpoints")} (${checkpointCount})`, icon: Clock },
    { id: "recall" as const, label: t("drawer.tab.recall"), icon: History },
    { id: "outbox" as const, label: `${t("drawer.tab.outbox")} (${outboxCount})`, icon: Database },
  ];
  return (
    <>
      <div className="px-5 border-b border-zinc-800 flex items-center gap-1 bg-zinc-950" role="tablist">
        {primary.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`inline-flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 transition ${
              tab === id
                ? "border-indigo-500 text-indigo-300"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
        <button
          type="button"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((v) => !v)}
          className={`ml-auto inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] rounded-md transition ${
            moreOpen || SECONDARY_TABS.includes(tab)
              ? "text-indigo-300 bg-zinc-900"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          {t("drawer.more")}
          <ChevronDown className={`w-3 h-3 transition-transform ${moreOpen ? "rotate-180" : ""}`} aria-hidden="true" />
        </button>
      </div>
      {moreOpen && (
        <div className="px-5 py-2 border-b border-zinc-800 bg-zinc-900/40 flex flex-wrap items-center gap-2">
          {secondary.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] border transition ${
                tab === id
                  ? "border-indigo-500/50 bg-indigo-500/15 text-indigo-200"
                  : "border-zinc-800 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <Icon className="w-3 h-3" aria-hidden="true" />
              {label}
            </button>
          ))}
          {moreActions && (
            <div
              role="group"
              aria-label={t("drawer.moreActions")}
              className="basis-full flex flex-wrap items-center gap-2 pt-2 mt-1 border-t border-zinc-800/70 empty:hidden"
            >
              {moreActions}
            </div>
          )}
        </div>
      )}
    </>
  );
}

interface SteerBarProps {
  /** true → live steer of the running worker; false → thread follow-up message. */
  steerable: boolean;
  value: string;
  onChange: (value: string) => void;
  busy: boolean;
  engine: EnginePreference | "";
  onEngineChange: (engine: EnginePreference | "") => void;
  onSubmit: (e: React.FormEvent) => void;
}

/** Permanent footer input of the DeepDive drawer. */
export function SteerBar({ steerable, value, onChange, busy, engine, onEngineChange, onSubmit }: SteerBarProps) {
  const { t } = useI18n();
  return (
    <form onSubmit={onSubmit} className="px-5 py-3 border-t border-zinc-800 bg-zinc-900/60 flex items-center gap-2">
      {steerable && <Compass className="w-3.5 h-3.5 text-sky-400 shrink-0" aria-hidden />}
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={steerable ? t("drawer.liveSteerPlaceholder") : t("drawer.threadPlaceholder")}
        aria-label={t("drawer.steerBarLabel")}
        className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500"
      />
      {steerable && (
        <select
          value={engine}
          onChange={(e) => onEngineChange(e.target.value as EnginePreference | "")}
          aria-label={t("composer.engine")}
          className="bg-zinc-950 border border-zinc-800 rounded-md px-2 py-2 text-[11px] font-mono text-zinc-300"
        >
          <option value="">{t("drawer.keepEngine")}</option>
          {(["auto", "claude", "codex", "opencode", "gemini", "mock"] as const).map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
      )}
      <button
        type="submit"
        disabled={busy || !value.trim()}
        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium disabled:opacity-40 transition"
      >
        <Send className="w-3.5 h-3.5" />
        {steerable ? t("drawer.liveSteerBtn") : t("drawer.injectButton")}
      </button>
    </form>
  );
}
