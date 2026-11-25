import { Activity } from "lucide-react";

import { useI18n } from "../../i18n.tsx";
import type { SmokeTriggerMode, VisualDiffMode } from "../../types.ts";
import { BrowserGateFields } from "./BrowserGateFields.tsx";

export interface SmokeCheckSectionProps {
  smokeEnabled: boolean;
  setSmokeEnabled: (value: boolean) => void;
  smokeStartCmd: string;
  setSmokeStartCmd: (value: string) => void;
  smokeReadyUrl: string;
  setSmokeReadyUrl: (value: string) => void;
  smokeTimeoutSec: string;
  setSmokeTimeoutSec: (value: string) => void;
  smokeTriggerMode: SmokeTriggerMode;
  setSmokeTriggerMode: (value: SmokeTriggerMode) => void;
  smokeCheckCmds: string;
  setSmokeCheckCmds: (value: string) => void;
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

export function SmokeCheckSection({
  smokeEnabled,
  setSmokeEnabled,
  smokeStartCmd,
  setSmokeStartCmd,
  smokeReadyUrl,
  setSmokeReadyUrl,
  smokeTimeoutSec,
  setSmokeTimeoutSec,
  smokeTriggerMode,
  setSmokeTriggerMode,
  smokeCheckCmds,
  setSmokeCheckCmds,
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
}: SmokeCheckSectionProps) {
  const { t } = useI18n();
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3.5 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="font-semibold text-zinc-200 flex items-center gap-1.5">
          <Activity className="w-3.5 h-3.5 text-emerald-400" />
          {t("modal.repoSettings.smokeTitle")}
        </span>
        <label className="inline-flex items-center gap-1.5 text-zinc-300 cursor-pointer">
          <input
            type="checkbox"
            checked={smokeEnabled}
            onChange={(e) => setSmokeEnabled(e.target.checked)}
            className="rounded border-zinc-700 bg-zinc-950 text-indigo-500"
          />
          <span className="text-[11px]">{t("modal.repoSettings.smokeEnable")}</span>
        </label>
      </div>

      {!smokeEnabled ? (
        <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-950/50 px-3 py-2.5 text-[11px] text-zinc-500 flex flex-wrap items-center justify-between gap-2">
          <span>{t("modal.repoSettings.smokeCollapsedHint")}</span>
          {smokeStartCmd.trim() && (
            <code className="font-mono text-[10px] text-zinc-400 bg-zinc-900 px-1.5 py-0.5 rounded">
              {smokeStartCmd.trim()}
            </code>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setSmokeStartCmd("bun run src/index.ts");
                setSmokeReadyUrl("http://127.0.0.1:$PORT/health");
                setSmokeTimeoutSec("20");
              }}
              className="px-2 py-0.5 rounded border border-zinc-700 bg-zinc-950 hover:bg-zinc-900 text-[10px] font-mono text-zinc-300 transition"
            >
              {t("modal.repoSettings.smokePresetBun")}
            </button>
            <button
              type="button"
              onClick={() => {
                setSmokeStartCmd("bun run preview --port $PORT --host 127.0.0.1");
                setSmokeReadyUrl("http://127.0.0.1:$PORT/");
                setSmokeTimeoutSec("20");
              }}
              className="px-2 py-0.5 rounded border border-zinc-700 bg-zinc-950 hover:bg-zinc-900 text-[10px] font-mono text-zinc-300 transition"
            >
              {t("modal.repoSettings.smokePresetWeb")}
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div>
              <label className="block text-zinc-400 mb-1">
                {t("modal.repoSettings.smokeStartCmd")}
              </label>
              <input
                value={smokeStartCmd}
                onChange={(e) => setSmokeStartCmd(e.target.value)}
                placeholder="bun run src/server.ts"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 font-mono text-zinc-100"
              />
            </div>
            <div>
              <label className="block text-zinc-400 mb-1">
                {t("modal.repoSettings.smokeReadyUrl")}
              </label>
              <input
                value={smokeReadyUrl}
                onChange={(e) => setSmokeReadyUrl(e.target.value)}
                placeholder="http://127.0.0.1:$PORT/health"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 font-mono text-zinc-100"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block text-zinc-400 mb-1">
                {t("modal.repoSettings.smokeTimeout")}
              </label>
              <input
                type="number"
                min="2"
                max="120"
                value={smokeTimeoutSec}
                onChange={(e) => setSmokeTimeoutSec(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 font-mono text-zinc-100"
              />
            </div>
            <div>
              <label className="block text-zinc-400 mb-1">
                {t("modal.repoSettings.smokeTriggerMode")}
              </label>
              <select
                value={smokeTriggerMode}
                onChange={(e) => setSmokeTriggerMode(e.target.value as SmokeTriggerMode)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-100"
              >
                <option value="every_gate">{t("modal.repoSettings.smokeEveryGate")}</option>
                <option value="delivery_only">{t("modal.repoSettings.smokeDeliveryOnly")}</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-zinc-400 mb-1">
              {t("modal.repoSettings.smokeCheckCmds")}
            </label>
            <textarea
              rows={2}
              value={smokeCheckCmds}
              onChange={(e) => setSmokeCheckCmds(e.target.value)}
              placeholder="curl -fsS $SUPER_WORK_SMOKE_URL/api/health"
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 font-mono text-zinc-100 leading-relaxed focus:outline-none focus:border-indigo-500"
            />
          </div>

          <BrowserGateFields
            browserEnabled={browserEnabled}
            setBrowserEnabled={setBrowserEnabled}
            browserPaths={browserPaths}
            setBrowserPaths={setBrowserPaths}
            browserSelector={browserSelector}
            setBrowserSelector={setBrowserSelector}
            browserFailConsole={browserFailConsole}
            setBrowserFailConsole={setBrowserFailConsole}
            visualDiffMode={visualDiffMode}
            setVisualDiffMode={setVisualDiffMode}
            maxVisualDiffRatio={maxVisualDiffRatio}
            setMaxVisualDiffRatio={setMaxVisualDiffRatio}
            browserStepsText={browserStepsText}
            setBrowserStepsText={setBrowserStepsText}
          />

          <p className="text-[11px] text-zinc-500">{t("modal.repoSettings.smokeHint")}</p>
        </>
      )}
    </div>
  );
}
