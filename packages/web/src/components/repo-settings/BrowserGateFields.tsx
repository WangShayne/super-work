import { Eye } from "lucide-react";

import { useI18n } from "../../i18n.tsx";
import type { VisualDiffMode } from "../../types.ts";

export interface BrowserGateFieldsProps {
  browserEnabled: boolean;
  setBrowserEnabled: (value: boolean) => void;
  browserPaths: string;
  setBrowserPaths: (value: string) => void;
  browserSelector: string;
  setBrowserSelector: (value: string) => void;
  browserFailConsole: boolean;
  setBrowserFailConsole: (value: boolean) => void;
  visualDiffMode: VisualDiffMode;
  setVisualDiffMode: (value: VisualDiffMode) => void;
  maxVisualDiffRatio: string;
  setMaxVisualDiffRatio: (value: string) => void;
  browserStepsText: string;
  setBrowserStepsText: (value: string) => void;
}

export function BrowserGateFields({
  browserEnabled,
  setBrowserEnabled,
  browserPaths,
  setBrowserPaths,
  browserSelector,
  setBrowserSelector,
  browserFailConsole,
  setBrowserFailConsole,
  visualDiffMode,
  setVisualDiffMode,
  maxVisualDiffRatio,
  setMaxVisualDiffRatio,
  browserStepsText,
  setBrowserStepsText,
}: BrowserGateFieldsProps) {
  const { t } = useI18n();
  return (
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
  );
}
