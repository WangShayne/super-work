import { AlertTriangle, Download, Pin, Plus, Sparkles, Trash2, Upload } from "lucide-react";

import { useI18n } from "../../i18n.tsx";
import type { PlaybookEntry } from "../../types.ts";
import { CloseFooter } from "./CloseFooter.tsx";

export interface PlaybookTabProps {
  playbook: PlaybookEntry[];
  playbookLoading: boolean;
  pruningPlaybook: boolean;
  pruneNotice: string | null;
  newRule: string;
  setNewRule: (value: string) => void;
  newRuleScope: string;
  setNewRuleScope: (value: string) => void;
  newRulePinned: boolean;
  setNewRulePinned: (value: boolean) => void;
  bundleBusy: boolean;
  bundleNotice: string | null;
  onClose?: () => void;
  handleAddPlaybookRule: (e: React.FormEvent) => Promise<void>;
  handleTogglePlaybook: (entry: PlaybookEntry, field: "enabled" | "pinned") => Promise<void>;
  handleDeletePlaybook: (entryId: string) => Promise<void>;
  handlePrunePlaybook: () => Promise<void>;
  handleExportBundle: () => Promise<void>;
  handleImportBundleFile: (file: File) => Promise<void>;
  prunableCount: number;
  bundleInputRef: React.RefObject<HTMLInputElement | null>;
}

export function PlaybookTab({
  playbook,
  playbookLoading,
  pruningPlaybook,
  pruneNotice,
  newRule,
  setNewRule,
  newRuleScope,
  setNewRuleScope,
  newRulePinned,
  setNewRulePinned,
  bundleBusy,
  bundleNotice,
  onClose,
  handleAddPlaybookRule,
  handleTogglePlaybook,
  handleDeletePlaybook,
  handlePrunePlaybook,
  handleExportBundle,
  handleImportBundleFile,
  prunableCount,
  bundleInputRef,
}: PlaybookTabProps) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden text-xs">
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {bundleNotice || pruneNotice ? (
            <span className="text-[11px] text-emerald-300">{bundleNotice ?? pruneNotice}</span>
          ) : (
            <span className="text-[11px] text-zinc-500">
              {playbook.length} rule(s)
            </span>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              ref={bundleInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void handleImportBundleFile(f);
              }}
            />
            <button
              type="button"
              disabled={bundleBusy}
              onClick={() => void handleExportBundle()}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 text-[11px] disabled:opacity-40 transition"
            >
              <Download className="w-3 h-3" />
              {t("bundle.exportBtn")}
            </button>
            <button
              type="button"
              disabled={bundleBusy}
              onClick={() => bundleInputRef.current?.click()}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 text-[11px] disabled:opacity-40 transition"
            >
              <Upload className="w-3 h-3" />
              {t("bundle.importBtn")}
            </button>
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

      <CloseFooter onClose={onClose} />
    </div>
  );
}
