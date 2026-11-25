import { Download, Upload } from "lucide-react";

import { useI18n } from "../../i18n.tsx";
import type { RepoConfig, SmokeTriggerMode, VisualDiffMode } from "../../types.ts";
import { SmokeCheckSection } from "./SmokeCheckSection.tsx";
import { LifecycleHooksSection } from "./LifecycleHooksSection.tsx";

export interface ContractSettingsSectionProps {
  verificationInput: string;
  setVerificationInput: (value: string) => void;
  setupInput: string;
  setSetupInput: (value: string) => void;
  forbiddenInput: string;
  setForbiddenInput: (value: string) => void;
  conventions: string;
  setConventions: (value: string) => void;
  previewCommand: string;
  setPreviewCommand: (value: string) => void;
  preDeliverHooksInput: string;
  setPreDeliverHooksInput: (value: string) => void;
  postDeliverHooksInput: string;
  setPostDeliverHooksInput: (value: string) => void;
  onEscalateHooksInput: string;
  setOnEscalateHooksInput: (value: string) => void;
  hookTimeoutInput: string;
  setHookTimeoutInput: (value: string) => void;
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
  contractNotice: string | null;
  syncingContract: boolean;
  repo: RepoConfig;
  handleSyncContract: () => Promise<void>;
  handleExportContract: () => Promise<void>;
}

export function ContractSettingsSection({
  verificationInput,
  setVerificationInput,
  setupInput,
  setSetupInput,
  forbiddenInput,
  setForbiddenInput,
  conventions,
  setConventions,
  previewCommand,
  setPreviewCommand,
  preDeliverHooksInput,
  setPreDeliverHooksInput,
  postDeliverHooksInput,
  setPostDeliverHooksInput,
  onEscalateHooksInput,
  setOnEscalateHooksInput,
  hookTimeoutInput,
  setHookTimeoutInput,
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
  contractNotice,
  syncingContract,
  repo,
  handleSyncContract,
  handleExportContract,
}: ContractSettingsSectionProps) {
  const { t } = useI18n();
  return (
    <>
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] text-zinc-400">
          {repo.contractSyncedAt
            ? `${t("modal.repoSettings.contractSyncedPrefix")} ${repo.contractSyncedAt}`
            : "super-work.json"}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={syncingContract}
            onClick={() => void handleSyncContract()}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-sky-500/40 bg-sky-500/15 hover:bg-sky-500/25 text-sky-200 text-[11px] disabled:opacity-50"
          >
            <Download className="w-3 h-3" />
            {t("modal.repoSettings.syncContractBtn")}
          </button>
          <button
            type="button"
            disabled={syncingContract}
            onClick={() => void handleExportContract()}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-indigo-500/40 bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-200 text-[11px] disabled:opacity-50"
          >
            <Upload className="w-3 h-3" />
            {t("modal.repoSettings.exportContractBtn")}
          </button>
        </div>
      </div>

      {contractNotice && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-200">
          {contractNotice}
        </div>
      )}

      <div>
        <label className="block text-zinc-400 mb-1">
          {t("modal.repoSettings.verificationCommands")}
        </label>
        <textarea
          rows={2}
          value={verificationInput}
          onChange={(e) => setVerificationInput(e.target.value)}
          placeholder={t("modal.repoSettings.verificationPlaceholder")}
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100 leading-relaxed focus:outline-none focus:border-indigo-500"
        />
        <p className="text-[11px] text-zinc-500 mt-1">
          {t("modal.repoSettings.verificationHint")}
        </p>
      </div>

      <div>
        <label className="block text-zinc-400 mb-1">
          {t("modal.repoSettings.setupCommands")}
        </label>
        <textarea
          rows={2}
          value={setupInput}
          onChange={(e) => setSetupInput(e.target.value)}
          placeholder={t("modal.repoSettings.setupPlaceholder")}
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100 leading-relaxed focus:outline-none focus:border-indigo-500"
        />
        <p className="text-[11px] text-zinc-500 mt-1">
          {t("modal.repoSettings.setupHint")}
        </p>
      </div>

      <div>
        <label className="block text-zinc-400 mb-1">
          {t("modal.repoSettings.forbiddenPaths")}
        </label>
        <input
          value={forbiddenInput}
          onChange={(e) => setForbiddenInput(e.target.value)}
          placeholder={t("modal.repoSettings.forbiddenPlaceholder")}
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
        />
      </div>

      <div>
        <label className="block text-zinc-400 mb-1">
          {t("modal.repoSettings.conventions")}
        </label>
        <textarea
          rows={4}
          value={conventions}
          onChange={(e) => setConventions(e.target.value)}
          placeholder={t("modal.repoSettings.conventionsPlaceholder")}
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100"
        />
      </div>

      <div>
        <label className="block text-zinc-400 mb-1">
          {t("modal.repoSettings.previewCmd")}
        </label>
        <input
          value={previewCommand}
          onChange={(e) => setPreviewCommand(e.target.value)}
          placeholder="bun run dev -- --port $PORT"
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
        />
      </div>

      <SmokeCheckSection
        smokeEnabled={smokeEnabled}
        setSmokeEnabled={setSmokeEnabled}
        smokeStartCmd={smokeStartCmd}
        setSmokeStartCmd={setSmokeStartCmd}
        smokeReadyUrl={smokeReadyUrl}
        setSmokeReadyUrl={setSmokeReadyUrl}
        smokeTimeoutSec={smokeTimeoutSec}
        setSmokeTimeoutSec={setSmokeTimeoutSec}
        smokeTriggerMode={smokeTriggerMode}
        setSmokeTriggerMode={setSmokeTriggerMode}
        smokeCheckCmds={smokeCheckCmds}
        setSmokeCheckCmds={setSmokeCheckCmds}
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

      <LifecycleHooksSection
        preDeliverHooksInput={preDeliverHooksInput}
        setPreDeliverHooksInput={setPreDeliverHooksInput}
        postDeliverHooksInput={postDeliverHooksInput}
        setPostDeliverHooksInput={setPostDeliverHooksInput}
        onEscalateHooksInput={onEscalateHooksInput}
        setOnEscalateHooksInput={setOnEscalateHooksInput}
        hookTimeoutInput={hookTimeoutInput}
        setHookTimeoutInput={setHookTimeoutInput}
      />
    </>
  );
}
