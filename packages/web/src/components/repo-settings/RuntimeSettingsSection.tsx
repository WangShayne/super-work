import { formatTemplate, useI18n } from "../../i18n.tsx";
import type {
  DeliveryChannel,
  DeliveryGatePolicy,
  EnginePreference,
  OperatingMode,
  PipelineTemplateId,
  SandboxMode,
  VerificationStrategy,
  WorkerEngineId,
} from "../../types.ts";

export interface RuntimeSettingsSectionProps {
  name: string;
  setName: (value: string) => void;
  baseBranch: string;
  setBaseBranch: (value: string) => void;
  githubRepo: string;
  setGithubRepo: (value: string) => void;
  mode: OperatingMode;
  setMode: (value: OperatingMode) => void;
  defaultTemplate: PipelineTemplateId;
  setDefaultTemplate: (value: PipelineTemplateId) => void;
  defaultTddMode: boolean;
  setDefaultTddMode: (value: boolean) => void;
  deliveryGatePolicy: DeliveryGatePolicy;
  setDeliveryGatePolicy: (value: DeliveryGatePolicy) => void;
  riskThresholdInput: string;
  setRiskThresholdInput: (value: string) => void;
  sensitivePathsInput: string;
  setSensitivePathsInput: (value: string) => void;
  implEngine: EnginePreference;
  setImplEngine: (value: EnginePreference) => void;
  reviewEngine: WorkerEngineId;
  setReviewEngine: (value: WorkerEngineId) => void;
  fallbackEngines: WorkerEngineId[];
  sandboxMode: SandboxMode;
  setSandboxMode: (value: SandboxMode) => void;
  verificationStrategy: VerificationStrategy;
  setVerificationStrategy: (value: VerificationStrategy) => void;
  deliveryChannel: DeliveryChannel;
  setDeliveryChannel: (value: DeliveryChannel) => void;
  maxConcurrentInput: string;
  setMaxConcurrentInput: (value: string) => void;
  dailyBudgetInput: string;
  setDailyBudgetInput: (value: string) => void;
  autoCleanupWorktree: boolean;
  setAutoCleanupWorktree: (value: boolean) => void;
  engineOptions: WorkerEngineId[];
  toggleFallbackEngine: (eng: WorkerEngineId) => void;
}

export function RuntimeSettingsSection({
  name,
  setName,
  baseBranch,
  setBaseBranch,
  githubRepo,
  setGithubRepo,
  mode,
  setMode,
  defaultTemplate,
  setDefaultTemplate,
  defaultTddMode,
  setDefaultTddMode,
  deliveryGatePolicy,
  setDeliveryGatePolicy,
  riskThresholdInput,
  setRiskThresholdInput,
  sensitivePathsInput,
  setSensitivePathsInput,
  implEngine,
  setImplEngine,
  reviewEngine,
  setReviewEngine,
  fallbackEngines,
  sandboxMode,
  setSandboxMode,
  verificationStrategy,
  setVerificationStrategy,
  deliveryChannel,
  setDeliveryChannel,
  maxConcurrentInput,
  setMaxConcurrentInput,
  dailyBudgetInput,
  setDailyBudgetInput,
  autoCleanupWorktree,
  setAutoCleanupWorktree,
  engineOptions,
  toggleFallbackEngine,
}: RuntimeSettingsSectionProps) {
  const { locale, t } = useI18n();
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-zinc-400 mb-1">{t("modal.repo.name")}</label>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100"
          />
        </div>
        <div>
          <label className="block text-zinc-400 mb-1">{t("modal.repo.baseBranch")}</label>
          <input
            required
            value={baseBranch}
            onChange={(e) => setBaseBranch(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-zinc-400 mb-1">
            {t("modal.repoSettings.defaultTemplate")}
          </label>
          <select
            value={defaultTemplate}
            onChange={(e) => setDefaultTemplate(e.target.value as PipelineTemplateId)}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 text-zinc-100"
          >
            <option value="fast">{formatTemplate("fast", locale)}</option>
            <option value="standard">{formatTemplate("standard", locale)}</option>
            <option value="strict">{formatTemplate("strict", locale)}</option>
          </select>
        </div>
        <div>
          <label className="block text-zinc-400 mb-1">{t("modal.repo.initialMode")}</label>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as OperatingMode)}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 text-zinc-100"
          >
            <option value="observe">{t("header.mode.observe")} (observe)</option>
            <option value="auto">{t("header.mode.auto")} (auto)</option>
            <option value="off">{t("header.mode.off")} (off)</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-zinc-400 mb-1">
            {t("modal.repoSettings.implEngine")}
          </label>
          <select
            value={implEngine}
            onChange={(e) => setImplEngine(e.target.value as EnginePreference)}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 font-mono text-zinc-100"
          >
            <option value="auto">{t("modal.dispatch.engineAuto")}</option>
            {engineOptions.map((eng) => (
              <option key={eng} value={eng}>
                {eng}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-zinc-400 mb-1">
            {t("modal.repoSettings.reviewEngine")}
          </label>
          <select
            value={reviewEngine}
            onChange={(e) => setReviewEngine(e.target.value as WorkerEngineId)}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 font-mono text-zinc-100"
          >
            {engineOptions.map((eng) => (
              <option key={eng} value={eng}>
                {eng}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="block text-zinc-400 mb-1.5">
          {t("modal.repoSettings.fallbackEngines")}
        </label>
        <div className="flex flex-wrap gap-2">
          {engineOptions.map((eng) => {
            const orderIdx = fallbackEngines.indexOf(eng);
            const active = orderIdx !== -1;
            return (
              <button
                key={eng}
                type="button"
                onClick={() => toggleFallbackEngine(eng)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border font-mono text-[11px] transition ${
                  active
                    ? "border-indigo-500/40 bg-indigo-500/15 text-indigo-200"
                    : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {active && (
                  <span className="px-1 rounded bg-indigo-500/30 text-[10px] text-indigo-100">
                    #{orderIdx + 1}
                  </span>
                )}
                <span>{eng}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <label className="block text-zinc-400 mb-1">
          {t("modal.repoSettings.sandboxTitle")}
        </label>
        <select
          value={sandboxMode}
          onChange={(e) => setSandboxMode(e.target.value as SandboxMode)}
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 text-zinc-100"
        >
          <option value="balanced">{t("modal.repoSettings.sandboxBalanced")}</option>
          <option value="strict">{t("modal.repoSettings.sandboxStrict")}</option>
          <option value="off">{t("modal.repoSettings.sandboxOff")}</option>
        </select>
      </div>

      <div>
        <label className="block text-zinc-400 mb-1">
          {t("modal.repoSettings.verificationStrategyTitle")}
        </label>
        <select
          value={verificationStrategy}
          onChange={(e) => setVerificationStrategy(e.target.value as VerificationStrategy)}
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 text-zinc-100"
        >
          <option value="always_full">
            {t("modal.repoSettings.verificationStrategyAlwaysFull")}
          </option>
          <option value="impact_scoped">
            {t("modal.repoSettings.verificationStrategyImpactScoped")}
          </option>
        </select>
        <p className="mt-1 text-[11px] text-zinc-500">
          {t("modal.repoSettings.verificationStrategyHint")}
        </p>
      </div>

      <div>
        <label className="block text-zinc-400 mb-1">{t("modal.repo.githubRepo")}</label>
        <input
          value={githubRepo}
          onChange={(e) => setGithubRepo(e.target.value)}
          placeholder={t("modal.repo.githubPlaceholder")}
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
        />
      </div>

      <div>
        <label className="block text-zinc-400 mb-1">
          {t("modal.repoSettings.deliveryChannel")}
        </label>
        <select
          value={deliveryChannel}
          onChange={(e) => setDeliveryChannel(e.target.value as DeliveryChannel)}
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 text-zinc-100"
        >
          <option value="auto_pr_or_branch">{t("modal.repoSettings.channel.auto")}</option>
          <option value="local_merge">{t("modal.repoSettings.channel.localMerge")}</option>
          <option value="github_pr">{t("modal.repoSettings.channel.githubPr")}</option>
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-zinc-400 mb-1">
            {t("modal.repoSettings.maxConcurrent")}
          </label>
          <input
            type="number"
            min="1"
            step="1"
            value={maxConcurrentInput}
            onChange={(e) => setMaxConcurrentInput(e.target.value)}
            placeholder={t("modal.repoSettings.quotaPlaceholder")}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
          />
        </div>
        <div>
          <label className="block text-zinc-400 mb-1">
            {t("modal.repoSettings.dailyBudget")}
          </label>
          <input
            type="number"
            min="0.1"
            step="0.5"
            value={dailyBudgetInput}
            onChange={(e) => setDailyBudgetInput(e.target.value)}
            placeholder={t("modal.repoSettings.quotaPlaceholder")}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
          />
        </div>
      </div>

      <label className="flex items-start gap-2.5 rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-3 cursor-pointer">
        <input
          type="checkbox"
          checked={defaultTddMode}
          onChange={(e) => setDefaultTddMode(e.target.checked)}
          className="mt-0.5 rounded border-zinc-700 bg-zinc-950 text-rose-500 focus:ring-rose-500"
        />
        <div>
          <div className="font-medium text-zinc-200">
            {t("modal.repoSettings.defaultTddLabel")}
          </div>
          <p className="text-[11px] text-zinc-400 mt-0.5">
            {t("modal.repoSettings.defaultTddDesc")}
          </p>
        </div>
      </label>

      <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-3 space-y-2.5">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-zinc-400 mb-1">
              {t("modal.repoSettings.deliveryGateLabel")}
            </label>
            <select
              value={deliveryGatePolicy}
              onChange={(e) => setDeliveryGatePolicy(e.target.value as DeliveryGatePolicy)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-2 text-zinc-100"
            >
              <option value="always_auto">always_auto</option>
              <option value="risk_gated">risk_gated (A.1 Risk Gate)</option>
              <option value="always_signoff">always_signoff</option>
            </select>
          </div>
          <div>
            <label className="block text-zinc-400 mb-1">
              {t("modal.repoSettings.riskThresholdLabel")}
            </label>
            <input
              type="number"
              min="0"
              max="100"
              step="5"
              value={riskThresholdInput}
              onChange={(e) => setRiskThresholdInput(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
            />
          </div>
        </div>
        <div>
          <label className="block text-zinc-400 mb-1">
            {t("modal.repoSettings.sensitivePathsLabel")}
          </label>
          <input
            value={sensitivePathsInput}
            onChange={(e) => setSensitivePathsInput(e.target.value)}
            placeholder="**/auth/**, *secret*, *migration*, package.json"
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 font-mono text-zinc-100"
          />
        </div>
      </div>

      <label className="flex items-start gap-2.5 rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-3 cursor-pointer">
        <input
          type="checkbox"
          checked={autoCleanupWorktree}
          onChange={(e) => setAutoCleanupWorktree(e.target.checked)}
          className="mt-0.5 rounded border-zinc-700 bg-zinc-950 text-indigo-500 focus:ring-indigo-500"
        />
        <div>
          <div className="font-medium text-zinc-200">
            {t("modal.repoSettings.autoCleanupLabel")}
          </div>
          <p className="text-[11px] text-zinc-400 mt-0.5">
            {t("modal.repoSettings.autoCleanupDesc")}
          </p>
        </div>
      </label>
    </>
  );
}
