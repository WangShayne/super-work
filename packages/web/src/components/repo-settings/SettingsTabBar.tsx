import { BookOpen, Database, FileJson2 } from "lucide-react";

import { useI18n } from "../../i18n.tsx";
import type { CasebookEntry, PlaybookEntry } from "../../types.ts";
import type { SettingsTab } from "./shared.ts";

export interface SettingsTabBarProps {
  settingsTab: SettingsTab;
  setSettingsTab: (tab: SettingsTab) => void;
  playbook: PlaybookEntry[];
  casebook: CasebookEntry[];
}

export function SettingsTabBar({
  settingsTab,
  setSettingsTab,
  playbook,
  casebook,
}: SettingsTabBarProps) {
  const { t } = useI18n();
  return (
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
  );
}
