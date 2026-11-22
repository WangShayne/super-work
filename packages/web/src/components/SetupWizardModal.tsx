import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  RefreshCw,
  Sparkles,
  Terminal,
  Wrench,
  X,
  XCircle,
} from "lucide-react";
import { api } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import type {
  CliScanReport,
  DetectedCliTool,
  LlmConnectionTestResult,
  LlmProviderPreset,
  PublicSetupStatus,
  ReasoningEffort,
  WorkerEngineId,
} from "../types.ts";

interface SetupWizardModalProps {
  open: boolean;
  setupStatus: PublicSetupStatus | null;
  availableEngines: WorkerEngineId[];
  onClose: () => void;
  onSaved: (next: PublicSetupStatus) => Promise<void>;
}

const PRESET_DEFAULTS: Record<LlmProviderPreset, { baseUrl: string; model: string }> = {
  deepseek: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  custom: { baseUrl: "http://localhost:11434/v1", model: "qwen2.5-coder" },
  claude_cli: { baseUrl: "", model: "" },
  codex_cli: { baseUrl: "", model: "" },
  heuristic: { baseUrl: "", model: "heuristic" },
};

export function SetupWizardModal({
  open,
  setupStatus,
  availableEngines,
  onClose,
  onSaved,
}: SetupWizardModalProps) {
  const { t } = useI18n();
  const [scanReport, setScanReport] = useState<CliScanReport | null>(null);
  const [preset, setPreset] = useState<LlmProviderPreset>("deepseek");
  const [baseUrl, setBaseUrl] = useState("https://api.deepseek.com/v1");
  const [model, setModel] = useState("deepseek-chat");
  const [llmEffort, setLlmEffort] = useState<ReasoningEffort>("low");
  const [apiKey, setApiKey] = useState("");
  const [implEngine, setImplEngine] = useState<WorkerEngineId>("claude");
  const [reviewEngine, setReviewEngine] = useState<WorkerEngineId>("codex");
  const [claudeModel, setClaudeModel] = useState("");
  const [claudeEffort, setClaudeEffort] = useState<ReasoningEffort | "">("");
  const [codexModel, setCodexModel] = useState("");
  const [codexEffort, setCodexEffort] = useState<ReasoningEffort | "">("");

  const [scanning, setScanning] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<LlmConnectionTestResult | null>(null);

  useEffect(() => {
    if (!open || !setupStatus) return;
    const cfg = setupStatus.config;
    setScanReport(setupStatus.scanReport);
    setPreset(cfg.llmPreset);
    setBaseUrl(cfg.llmBaseUrl || PRESET_DEFAULTS[cfg.llmPreset].baseUrl);
    const loadedModel =
      cfg.llmPreset === "claude_cli" && cfg.llmModel === "claude-cli" ? "" : cfg.llmModel;
    setModel(loadedModel || PRESET_DEFAULTS[cfg.llmPreset].model);
    setLlmEffort(cfg.llmEffort ?? "low");
    setImplEngine(cfg.preferredImplementEngine);
    setReviewEngine(cfg.preferredReviewEngine);
    setClaudeModel(cfg.claudeProfile?.model ?? "");
    setClaudeEffort(cfg.claudeProfile?.effort ?? "");
    setCodexModel(cfg.codexProfile?.model ?? "");
    setCodexEffort(cfg.codexProfile?.effort ?? "");
    setApiKey("");
    setTestResult(null);
  }, [open, setupStatus]);

  if (!open || !setupStatus) return null;

  const isFirstRun = !setupStatus.initialized;
  const needsApiFields = preset === "deepseek" || preset === "openai" || preset === "custom";
  const isCliLlm = preset === "claude_cli" || preset === "codex_cli";
  const engineChoices: WorkerEngineId[] =
    availableEngines.length > 0 ? availableEngines : ["claude", "codex", "mock"];
  const claudeScan = scanReport?.tools.find((tool) => tool.id === "claude");
  const codexScan = scanReport?.tools.find((tool) => tool.id === "codex");

  const handleSelectPreset = (next: LlmProviderPreset) => {
    setPreset(next);
    setBaseUrl(PRESET_DEFAULTS[next].baseUrl);
    setModel(PRESET_DEFAULTS[next].model);
    if (next === "claude_cli" || next === "codex_cli") {
      setLlmEffort("low");
    }
    setTestResult(null);
  };

  const handleRescan = async () => {
    setScanning(true);
    try {
      const res = await api.scanCliEnvironment();
      setScanReport(res.scanReport);
      setImplEngine(res.scanReport.recommendedImplementEngine);
      setReviewEngine(res.scanReport.recommendedReviewEngine);
    } finally {
      setScanning(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.testLlmConnection({
        llmPreset: preset,
        llmBaseUrl: baseUrl,
        llmModel: model,
        llmEffort: isCliLlm ? llmEffort : undefined,
        llmApiKey: apiKey.trim() || undefined,
        useSavedKey: setupStatus.config.hasApiKey && !apiKey.trim(),
      });
      setTestResult(res);
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const updated = await api.configureSetup({
        llmPreset: preset,
        llmBaseUrl: baseUrl,
        llmModel: model,
        llmEffort: isCliLlm ? llmEffort : undefined,
        llmApiKey: apiKey.trim() || undefined,
        preferredImplementEngine: implEngine,
        preferredReviewEngine: reviewEngine,
        claudeProfile: {
          model: claudeModel.trim() || undefined,
          effort: claudeEffort || undefined,
        },
        codexProfile: {
          model: codexModel.trim() || undefined,
          effort: codexEffort || undefined,
        },
      });
      await onSaved(updated);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const renderToolBadge = (tool: DetectedCliTool) => {
    if (!tool.installed) {
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 text-[10px] font-mono">
          <XCircle className="w-2.5 h-2.5" />
          {t("setup.status.missing")}
        </span>
      );
    }
    if (tool.authenticated === false) {
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 text-[10px] font-mono">
          <AlertTriangle className="w-2.5 h-2.5" />
          {t("setup.status.unauth")}
        </span>
      );
    }
    if (tool.authenticated === true) {
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[10px] font-mono">
          <CheckCircle2 className="w-2.5 h-2.5" />
          {t("setup.status.ready")}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 border border-sky-500/30 text-[10px] font-mono">
        <CheckCircle2 className="w-2.5 h-2.5" />
        {t("setup.status.detected")}
      </span>
    );
  };

  const presets: Array<{ id: LlmProviderPreset; title: string; desc: string }> = [
    {
      id: "deepseek",
      title: t("setup.preset.deepseek.title"),
      desc: t("setup.preset.deepseek.desc"),
    },
    {
      id: "openai",
      title: t("setup.preset.openai.title"),
      desc: t("setup.preset.openai.desc"),
    },
    {
      id: "claude_cli",
      title: t("setup.preset.claude_cli.title"),
      desc: t("setup.preset.claude_cli.desc"),
    },
    {
      id: "codex_cli",
      title: t("setup.preset.codex_cli.title"),
      desc: t("setup.preset.codex_cli.desc"),
    },
    {
      id: "heuristic",
      title: t("setup.preset.heuristic.title"),
      desc: t("setup.preset.heuristic.desc"),
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs p-4 overflow-y-auto">
      <div className="w-full max-w-3xl rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl overflow-hidden my-4">
        {/* Header */}
        <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/40">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <Wrench className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">
                {isFirstRun ? t("setup.title") : t("setup.settingsTitle")}
              </h2>
              <p className="text-[11px] font-mono text-zinc-500">
                {t("header.controlPlanePrefix")}: {setupStatus.activeLlmProvider}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-200">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-6 max-h-[80vh] overflow-y-auto text-xs">
          {isFirstRun && (
            <div className="p-3.5 rounded-xl border border-indigo-500/30 bg-indigo-500/10 text-indigo-200 flex items-start gap-2.5">
              <Sparkles className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
              <span>{t("setup.firstRunBanner")}</span>
            </div>
          )}

          {/* Panel A: CLI Environment Scan */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-semibold text-zinc-200">
                <Terminal className="w-4 h-4 text-sky-400" />
                {t("setup.cliSectionTitle")}
              </div>
              <button
                type="button"
                onClick={handleRescan}
                disabled={scanning}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-[11px] disabled:opacity-50"
              >
                <RefreshCw className={`w-3 h-3 ${scanning ? "animate-spin" : ""}`} />
                {scanning ? t("setup.scanning") : t("setup.rescan")}
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
              {(scanReport?.tools ?? []).map((tool) => (
                <div
                  key={tool.id}
                  className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-zinc-100">{tool.name}</span>
                    {renderToolBadge(tool)}
                  </div>
                  <div className="font-mono text-[10px] text-zinc-400 truncate">
                    {tool.version ?? tool.binaryPath ?? "—"}
                  </div>
                  {tool.authSummary && (
                    <div className="font-mono text-[10px] text-zinc-500 truncate">
                      {tool.authSummary}
                    </div>
                  )}
                  {(tool.localDefaultModel || tool.localDefaultEffort) && (
                    <div className="font-mono text-[10px] text-indigo-300/90 truncate">
                      {t("setup.localDefaultPrefix")}{" "}
                      {[tool.localDefaultModel, tool.localDefaultEffort].filter(Boolean).join(" · ")}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              <div>
                <label className="block text-zinc-400 mb-1">{t("setup.defaultImplEngine")}</label>
                <select
                  value={implEngine}
                  onChange={(e) => setImplEngine(e.target.value as WorkerEngineId)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100 font-mono"
                >
                  {engineChoices.map((eId) => (
                    <option key={eId} value={eId}>
                      {eId}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-zinc-400 mb-1">{t("setup.defaultReviewEngine")}</label>
                <select
                  value={reviewEngine}
                  onChange={(e) => setReviewEngine(e.target.value as WorkerEngineId)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100 font-mono"
                >
                  {engineChoices.map((eId) => (
                    <option key={eId} value={eId}>
                      {eId}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Worker CLI Model & Effort Defaults */}
            <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/35 p-4 space-y-3">
              <div>
                <div className="font-semibold text-zinc-200">{t("setup.workerProfilesTitle")}</div>
                <p className="text-[11px] text-zinc-400 mt-0.5">{t("setup.workerProfilesHint")}</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3 space-y-2.5">
                  <div className="font-medium text-zinc-200">{t("setup.claudeProfileTitle")}</div>
                  <div>
                    <label className="block text-zinc-400 mb-1">{t("setup.modelLabel")}</label>
                    <input
                      list="claude-model-presets"
                      value={claudeModel}
                      onChange={(e) => setClaudeModel(e.target.value)}
                      placeholder={
                        claudeScan?.localDefaultModel
                          ? `${t("setup.followLocalDefault")} (${claudeScan.localDefaultModel})`
                          : t("setup.followLocalDefault")
                      }
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 font-mono text-zinc-100 focus:outline-none focus:border-indigo-500"
                    />
                    <datalist id="claude-model-presets">
                      <option value="sonnet" />
                      <option value="opus" />
                      <option value="fable" />
                    </datalist>
                  </div>
                  <div>
                    <label className="block text-zinc-400 mb-1">{t("setup.effortLabel")}</label>
                    <select
                      value={claudeEffort}
                      onChange={(e) => setClaudeEffort(e.target.value as ReasoningEffort | "")}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-100"
                    >
                      <option value="">{t("setup.effort.inherit")}</option>
                      <option value="low">{t("setup.effort.low")}</option>
                      <option value="medium">{t("setup.effort.medium")}</option>
                      <option value="high">{t("setup.effort.high")}</option>
                      <option value="xhigh">{t("setup.effort.xhigh")}</option>
                      <option value="max">{t("setup.effort.max")}</option>
                    </select>
                  </div>
                </div>

                <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3 space-y-2.5">
                  <div className="font-medium text-zinc-200">{t("setup.codexProfileTitle")}</div>
                  <div>
                    <label className="block text-zinc-400 mb-1">{t("setup.modelLabel")}</label>
                    <input
                      value={codexModel}
                      onChange={(e) => setCodexModel(e.target.value)}
                      placeholder={
                        codexScan?.localDefaultModel
                          ? `${t("setup.followLocalDefault")} (${codexScan.localDefaultModel})`
                          : t("setup.followLocalDefault")
                      }
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 font-mono text-zinc-100 focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-zinc-400 mb-1">{t("setup.effortLabel")}</label>
                    <select
                      value={codexEffort}
                      onChange={(e) => setCodexEffort(e.target.value as ReasoningEffort | "")}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-100"
                    >
                      <option value="">
                        {codexScan?.localDefaultEffort
                          ? `${t("setup.effort.inherit")} (${codexScan.localDefaultEffort})`
                          : t("setup.effort.inherit")}
                      </option>
                      <option value="low">{t("setup.effort.low")}</option>
                      <option value="medium">{t("setup.effort.medium")}</option>
                      <option value="high">{t("setup.effort.high")}</option>
                      <option value="xhigh">{t("setup.effort.xhigh")}</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Panel B: Control-Plane LLM */}
          <section className="space-y-3 pt-2 border-t border-zinc-800/80">
            <div className="flex items-center gap-2 font-semibold text-zinc-200">
              <Cpu className="w-4 h-4 text-indigo-400" />
              {t("setup.llmSectionTitle")}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
              {presets.map((p) => {
                const selected = preset === p.id || (p.id === "openai" && preset === "custom");
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => handleSelectPreset(p.id)}
                    className={`text-left rounded-xl border p-3.5 transition space-y-1 ${
                      selected
                        ? "border-indigo-500 bg-indigo-500/10"
                        : "border-zinc-800 bg-zinc-900/40 hover:border-zinc-700"
                    }`}
                  >
                    <div className="font-semibold text-zinc-100">{p.title}</div>
                    <div className="text-[11px] text-zinc-400 leading-relaxed">{p.desc}</div>
                  </button>
                );
              })}
            </div>

            {isCliLlm && (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-zinc-400 mb-1">{t("setup.cliLlmModel")}</label>
                  <input
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder={
                      preset === "claude_cli"
                        ? claudeScan?.localDefaultModel || t("setup.followLocalDefault")
                        : codexScan?.localDefaultModel || t("setup.followLocalDefault")
                    }
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100 focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-zinc-400 mb-1">{t("setup.cliLlmEffort")}</label>
                  <select
                    value={llmEffort}
                    onChange={(e) => setLlmEffort(e.target.value as ReasoningEffort)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100"
                  >
                    <option value="low">{t("setup.effort.low")}</option>
                    <option value="medium">{t("setup.effort.medium")}</option>
                    <option value="high">{t("setup.effort.high")}</option>
                    <option value="xhigh">{t("setup.effort.xhigh")}</option>
                    {preset === "claude_cli" && <option value="max">{t("setup.effort.max")}</option>}
                  </select>
                </div>
              </div>
            )}

            {needsApiFields && (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-zinc-400 mb-1">{t("setup.baseUrl")}</label>
                    <input
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100 focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-zinc-400 mb-1">{t("setup.model")}</label>
                    <input
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100 focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-zinc-400">{t("setup.apiKey")}</label>
                    {setupStatus.config.hasApiKey && (
                      <span className="text-[10px] font-mono text-emerald-400">
                        {setupStatus.config.maskedApiKey} · {t("setup.apiKeySavedHint")}
                      </span>
                    )}
                  </div>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={
                      setupStatus.config.hasApiKey
                        ? `${setupStatus.config.maskedApiKey} (${t("setup.apiKeySavedHint")})`
                        : t("setup.apiKeyPlaceholder")
                    }
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>
            )}

            {testResult && (
              <div
                className={`p-3 rounded-lg border text-xs flex items-center gap-2 ${
                  testResult.ok
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                    : "border-rose-500/30 bg-rose-500/10 text-rose-300"
                }`}
              >
                {testResult.ok ? (
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                ) : (
                  <XCircle className="w-4 h-4 shrink-0" />
                )}
                <span>{testResult.message}</span>
              </div>
            )}
          </section>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-zinc-800 bg-zinc-900/40 flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={handleTest}
            disabled={testing}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 text-xs font-medium disabled:opacity-50"
          >
            {testing ? t("setup.testing") : t("setup.testConnection")}
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-2 rounded-lg border border-zinc-800 text-zinc-400 hover:text-zinc-200 text-xs"
            >
              {t("setup.later")}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium disabled:opacity-50"
            >
              {saving ? t("setup.saving") : t("setup.saveActivate")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
