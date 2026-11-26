import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Copy,
  Cpu,
  KeyRound,
  Plug,
  RefreshCw,
  Send,
  Terminal,
  XCircle,
} from "lucide-react";
import { api } from "../../api.ts";
import { useI18n, type TranslationKey } from "../../i18n.tsx";
import type {
  CliScanReport,
  DetectedCliTool,
  LlmConnectionTestResult,
  LlmProviderPreset,
  PublicSetupStatus,
  ReasoningEffort,
  WorkerEngineId,
} from "../../types.ts";

interface CustomizeSetupFormProps {
  setupStatus: PublicSetupStatus;
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

type ProfileId = "claude" | "codex" | "opencode" | "gemini";
type Profile = { model: string; effort: ReasoningEffort | "" };

const PROFILE_DEFS: Array<{
  id: ProfileId;
  titleKey: TranslationKey;
  datalist?: string[];
  efforts: ReasoningEffort[];
  fallbackPlaceholder?: string;
}> = [
  { id: "claude", titleKey: "setup.claudeProfileTitle", datalist: ["sonnet", "opus", "fable"], efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "codex", titleKey: "setup.codexProfileTitle", efforts: ["low", "medium", "high", "xhigh"] },
  { id: "opencode", titleKey: "setup.opencodeProfileTitle", efforts: ["low", "medium", "high", "xhigh", "max"], fallbackPlaceholder: "provider/model" },
  { id: "gemini", titleKey: "setup.geminiProfileTitle", datalist: ["gemini-2.5-pro", "gemini-2.5-flash"], efforts: ["low", "medium", "high"] },
];

const INPUT = "w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100 focus:outline-none focus:border-indigo-500";
const SELECT = "w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-100";

function ToolBadge({ tool }: { tool: DetectedCliTool }) {
  const { t } = useI18n();
  const base = "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono";
  if (!tool.installed)
    return (
      <span className={`${base} bg-zinc-800 text-zinc-500`}>
        <XCircle className="w-2.5 h-2.5" />
        {t("setup.status.missing")}
      </span>
    );
  if (tool.authenticated === false)
    return (
      <span className={`${base} bg-amber-500/15 text-amber-300 border border-amber-500/30`}>
        <AlertTriangle className="w-2.5 h-2.5" />
        {t("setup.status.unauth")}
      </span>
    );
  const ready = tool.authenticated === true;
  return (
    <span className={`${base} border ${ready ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" : "bg-sky-500/15 text-sky-300 border-sky-500/30"}`}>
      <CheckCircle2 className="w-2.5 h-2.5" />
      {ready ? t("setup.status.ready") : t("setup.status.detected")}
    </span>
  );
}

function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer text-zinc-200">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="rounded border-zinc-700 bg-zinc-950 text-indigo-500"
      />
      {label}
    </label>
  );
}

/** Manual LLM preset / API key / 4-engine matrix / webhook secrets (collapsed by default in the wizard). */
export function CustomizeSetupForm({ setupStatus, availableEngines, onClose, onSaved }: CustomizeSetupFormProps) {
  const { t } = useI18n();
  const cfg = setupStatus.config;
  const [scanReport, setScanReport] = useState<CliScanReport | null>(setupStatus.scanReport);
  const [preset, setPreset] = useState<LlmProviderPreset>(cfg.llmPreset);
  const [baseUrl, setBaseUrl] = useState(cfg.llmBaseUrl || PRESET_DEFAULTS[cfg.llmPreset].baseUrl);
  const [model, setModel] = useState(
    (cfg.llmPreset === "claude_cli" && cfg.llmModel === "claude-cli" ? "" : cfg.llmModel) ||
      PRESET_DEFAULTS[cfg.llmPreset].model,
  );
  const [llmEffort, setLlmEffort] = useState<ReasoningEffort>(cfg.llmEffort ?? "low");
  const [apiKey, setApiKey] = useState("");
  const [implEngine, setImplEngine] = useState<WorkerEngineId>(cfg.preferredImplementEngine);
  const [reviewEngine, setReviewEngine] = useState<WorkerEngineId>(cfg.preferredReviewEngine);
  const [profiles, setProfiles] = useState<Record<ProfileId, Profile>>({
    claude: { model: cfg.claudeProfile?.model ?? "", effort: cfg.claudeProfile?.effort ?? "" },
    codex: { model: cfg.codexProfile?.model ?? "", effort: cfg.codexProfile?.effort ?? "" },
    opencode: { model: cfg.opencodeProfile?.model ?? "", effort: cfg.opencodeProfile?.effort ?? "" },
    gemini: { model: cfg.geminiProfile?.model ?? "", effort: cfg.geminiProfile?.effort ?? "" },
  });
  const n = cfg.notifications;
  const [macosEnabled, setMacosEnabled] = useState(n?.macosEnabled ?? false);
  const [webhookEnabled, setWebhookEnabled] = useState(n?.webhookEnabled ?? false);
  const [webhookUrl, setWebhookUrl] = useState(n?.webhookUrl ?? "");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [notifyOnInbox, setNotifyOnInbox] = useState(n?.notifyOnInbox ?? true);
  const [notifyOnDelivery, setNotifyOnDelivery] = useState(n?.notifyOnDelivery ?? true);
  const [notifyOnFailure, setNotifyOnFailure] = useState(n?.notifyOnFailure ?? true);
  const [publicBaseUrl, setPublicBaseUrl] = useState(n?.publicBaseUrl ?? "");
  const [actionSecret, setActionSecret] = useState("");
  const [githubWebhookSecret, setGithubWebhookSecret] = useState("");
  const [mcpCopied, setMcpCopied] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testingNotify, setTestingNotify] = useState(false);
  const [testResult, setTestResult] = useState<LlmConnectionTestResult | null>(null);
  const [notifyMsg, setNotifyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => setScanReport(setupStatus.scanReport), [setupStatus.scanReport]);

  const needsApiFields = preset === "deepseek" || preset === "openai" || preset === "custom";
  const isCliLlm = preset === "claude_cli" || preset === "codex_cli";
  const engineChoices: WorkerEngineId[] = availableEngines.length > 0 ? availableEngines : ["claude", "codex", "mock"];
  const scanOf = (id: ProfileId) => scanReport?.tools.find((tool) => tool.id === id);

  const presets: Array<{ id: LlmProviderPreset; title: string; desc: string }> = (
    ["deepseek", "openai", "claude_cli", "codex_cli", "heuristic"] as const
  ).map((id) => ({
    id,
    title: t(`setup.preset.${id}.title` as TranslationKey),
    desc: t(`setup.preset.${id}.desc` as TranslationKey),
  }));

  const notificationPayload = () => ({
    macosEnabled,
    webhookEnabled,
    webhookUrl: webhookUrl.trim() || undefined,
    webhookSecret: webhookSecret.trim() || undefined,
    notifyOnInbox,
    notifyOnDelivery,
    notifyOnFailure,
  });

  const guard = async (setBusy: (v: boolean) => void, fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const selectPreset = (next: LlmProviderPreset) => {
    setPreset(next);
    setBaseUrl(PRESET_DEFAULTS[next].baseUrl);
    setModel(PRESET_DEFAULTS[next].model);
    if (next === "claude_cli" || next === "codex_cli") setLlmEffort("low");
    setTestResult(null);
  };

  const rescan = () =>
    guard(setScanning, async () => {
      const res = await api.scanCliEnvironment();
      setScanReport(res.scanReport);
      setImplEngine(res.scanReport.recommendedImplementEngine);
      setReviewEngine(res.scanReport.recommendedReviewEngine);
    });

  const testConnection = () =>
    guard(setTesting, async () => {
      setTestResult(null);
      setTestResult(
        await api.testLlmConnection({
          llmPreset: preset,
          llmBaseUrl: baseUrl,
          llmModel: model,
          llmEffort: isCliLlm ? llmEffort : undefined,
          llmApiKey: apiKey.trim() || undefined,
          useSavedKey: cfg.hasApiKey && !apiKey.trim(),
        }),
      );
    });

  const save = () =>
    guard(setSaving, async () => {
      const profile = (id: ProfileId) => ({
        model: profiles[id].model.trim() || undefined,
        effort: profiles[id].effort || undefined,
      });
      const updated = await api.configureSetup({
        llmPreset: preset,
        llmBaseUrl: baseUrl,
        llmModel: model,
        llmEffort: isCliLlm ? llmEffort : undefined,
        llmApiKey: apiKey.trim() || undefined,
        preferredImplementEngine: implEngine,
        preferredReviewEngine: reviewEngine,
        claudeProfile: profile("claude"),
        codexProfile: profile("codex"),
        opencodeProfile: profile("opencode"),
        geminiProfile: profile("gemini"),
        notifications: {
          ...notificationPayload(),
          publicBaseUrl: publicBaseUrl.trim() || undefined,
          actionSecret: actionSecret.trim() || undefined,
          githubWebhookSecret: githubWebhookSecret.trim() || undefined,
        },
      });
      await onSaved(updated);
      onClose();
    });

  const testNotification = () =>
    guard(setTestingNotify, async () => {
      setNotifyMsg(null);
      const res = await api.testNotification(notificationPayload());
      setNotifyMsg(
        res.results.length === 0
          ? { ok: false, text: t("setup.notifyEnableFirst") }
          : { ok: res.ok, text: res.results.map((r) => `${r.channel}: ${r.detail ?? (r.ok ? "ok" : "failed")}`).join(" | ") },
      );
    });

  const copyMcp = () => {
    const snippet = JSON.stringify(
      { mcpServers: { "super-work": { command: "bun", args: ["run", "packages/cli/src/index.ts", "mcp"] } } },
      null,
      2,
    );
    void navigator.clipboard?.writeText(snippet).then(() => {
      setMcpCopied(true);
      window.setTimeout(() => setMcpCopied(false), 1800);
    });
  };

  const setProfile = (id: ProfileId, patch: Partial<Profile>) =>
    setProfiles((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  return (
    <div className="space-y-6 text-xs">
      {/* CLI scan + engines */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold text-zinc-200">
            <Terminal className="w-4 h-4 text-sky-400" />
            {t("setup.cliSectionTitle")}
          </div>
          <button
            type="button"
            onClick={() => void rescan()}
            disabled={scanning}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-[11px] disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${scanning ? "animate-spin" : ""}`} />
            {scanning ? t("setup.scanning") : t("setup.rescan")}
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
          {(scanReport?.tools ?? []).map((tool) => (
            <div key={tool.id} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-zinc-100">{tool.name}</span>
                <ToolBadge tool={tool} />
              </div>
              <div className="font-mono text-[10px] text-zinc-400 truncate">{tool.version ?? tool.binaryPath ?? "—"}</div>
              {tool.authSummary && <div className="font-mono text-[10px] text-zinc-500 truncate">{tool.authSummary}</div>}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {(
            [
              ["setup.defaultImplEngine", implEngine, setImplEngine],
              ["setup.defaultReviewEngine", reviewEngine, setReviewEngine],
            ] as const
          ).map(([labelKey, value, setter]) => (
            <div key={labelKey}>
              <label className="block text-zinc-400 mb-1">{t(labelKey)}</label>
              <select value={value} onChange={(e) => setter(e.target.value as WorkerEngineId)} className={`${SELECT} px-3 py-2 font-mono`}>
                {engineChoices.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>

        <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/35 p-4 space-y-3">
          <div>
            <div className="font-semibold text-zinc-200">{t("setup.workerProfilesTitle")}</div>
            <p className="text-[11px] text-zinc-400 mt-0.5">{t("setup.workerProfilesHint")}</p>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {PROFILE_DEFS.map((def) => {
              const scan = scanOf(def.id);
              const follow = scan?.localDefaultModel
                ? `${t("setup.followLocalDefault")} (${scan.localDefaultModel})`
                : (def.fallbackPlaceholder ?? t("setup.followLocalDefault"));
              return (
                <div key={def.id} className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3 space-y-2.5">
                  <div className="font-medium text-zinc-200">{t(def.titleKey)}</div>
                  <div>
                    <label className="block text-zinc-400 mb-1">{t("setup.modelLabel")}</label>
                    <input
                      list={def.datalist ? `${def.id}-model-presets` : undefined}
                      value={profiles[def.id].model}
                      onChange={(e) => setProfile(def.id, { model: e.target.value })}
                      placeholder={follow}
                      className={`${INPUT} px-2.5 py-1.5`}
                    />
                    {def.datalist && (
                      <datalist id={`${def.id}-model-presets`}>
                        {def.datalist.map((v) => (
                          <option key={v} value={v} />
                        ))}
                      </datalist>
                    )}
                  </div>
                  <div>
                    <label className="block text-zinc-400 mb-1">{t("setup.effortLabel")}</label>
                    <select
                      value={profiles[def.id].effort}
                      onChange={(e) => setProfile(def.id, { effort: e.target.value as ReasoningEffort | "" })}
                      className={SELECT}
                    >
                      <option value="">
                        {scan?.localDefaultEffort ? `${t("setup.effort.inherit")} (${scan.localDefaultEffort})` : t("setup.effort.inherit")}
                      </option>
                      {def.efforts.map((e) => (
                        <option key={e} value={e}>
                          {t(`setup.effort.${e}` as TranslationKey)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Control-plane LLM */}
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
                onClick={() => selectPreset(p.id)}
                className={`text-left rounded-xl border p-3.5 transition space-y-1 ${
                  selected ? "border-indigo-500 bg-indigo-500/10" : "border-zinc-800 bg-zinc-900/40 hover:border-zinc-700"
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
                placeholder={scanOf(preset === "claude_cli" ? "claude" : "codex")?.localDefaultModel || t("setup.followLocalDefault")}
                className={INPUT}
              />
            </div>
            <div>
              <label className="block text-zinc-400 mb-1">{t("setup.cliLlmEffort")}</label>
              <select value={llmEffort} onChange={(e) => setLlmEffort(e.target.value as ReasoningEffort)} className={`${SELECT} px-3 py-2`}>
                {(["low", "medium", "high", "xhigh", ...(preset === "claude_cli" ? ["max"] : [])] as ReasoningEffort[]).map((e) => (
                  <option key={e} value={e}>
                    {t(`setup.effort.${e}` as TranslationKey)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {needsApiFields && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-zinc-400 mb-1">{t("setup.baseUrl")}</label>
                <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className={INPUT} />
              </div>
              <div>
                <label className="block text-zinc-400 mb-1">{t("setup.model")}</label>
                <input value={model} onChange={(e) => setModel(e.target.value)} className={INPUT} />
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-zinc-400">{t("setup.apiKey")}</label>
                {cfg.hasApiKey && (
                  <span className="text-[10px] font-mono text-emerald-400">
                    {cfg.maskedApiKey} · {t("setup.apiKeySavedHint")}
                  </span>
                )}
              </div>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={cfg.hasApiKey ? `${cfg.maskedApiKey} (${t("setup.apiKeySavedHint")})` : t("setup.apiKeyPlaceholder")}
                className={INPUT}
              />
            </div>
          </div>
        )}

        {testResult && (
          <div
            className={`p-3 rounded-lg border text-xs flex items-center gap-2 ${
              testResult.ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-rose-500/30 bg-rose-500/10 text-rose-300"
            }`}
          >
            {testResult.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
            <span>{testResult.message}</span>
          </div>
        )}
      </section>

      {/* Notifications */}
      <section className="space-y-3 pt-2 border-t border-zinc-800/80">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2 font-semibold text-zinc-200">
              <Bell className="w-4 h-4 text-amber-400" />
              {t("setup.notificationsTitle")}
            </div>
            <p className="text-[11px] text-zinc-400 mt-0.5">{t("setup.notificationsDesc")}</p>
          </div>
          <button
            type="button"
            onClick={() => void testNotification()}
            disabled={testingNotify}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-amber-500/40 bg-amber-500/15 hover:bg-amber-500/25 text-amber-200 text-[11px] disabled:opacity-50 shrink-0"
          >
            <Send className="w-3 h-3" />
            {testingNotify ? t("setup.testingNotification") : t("setup.testNotificationBtn")}
          </button>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
          <div className="flex flex-wrap gap-4">
            <Check checked={macosEnabled} onChange={setMacosEnabled} label={t("setup.macosNotifyLabel")} />
            <Check checked={webhookEnabled} onChange={setWebhookEnabled} label={t("setup.webhookNotifyLabel")} />
          </div>
          {webhookEnabled && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-zinc-400 mb-1">{t("setup.webhookUrl")}</label>
                <input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..." className={INPUT} />
              </div>
              <div>
                <label className="block text-zinc-400 mb-1">
                  {t("setup.webhookSecret")}
                  {n?.hasWebhookSecret && <span className="ml-2 text-[10px] text-emerald-400">({t("setup.webhookSecretSavedHint")})</span>}
                </label>
                <input type="password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} placeholder="Optional HMAC secret" className={INPUT} />
              </div>
            </div>
          )}
          <div className="flex flex-wrap gap-4 pt-1 text-[11px] text-zinc-300">
            <Check checked={notifyOnInbox} onChange={setNotifyOnInbox} label={t("setup.notifyOnInbox")} />
            <Check checked={notifyOnDelivery} onChange={setNotifyOnDelivery} label={t("setup.notifyOnDelivery")} />
            <Check checked={notifyOnFailure} onChange={setNotifyOnFailure} label={t("setup.notifyOnFailure")} />
          </div>
          {notifyMsg && (
            <div className={`p-2.5 rounded-lg border text-[11px] ${notifyMsg.ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-rose-500/30 bg-rose-500/10 text-rose-300"}`}>
              {notifyMsg.text}
            </div>
          )}
        </div>
      </section>

      {/* MCP + remote webhooks */}
      <section className="space-y-3 pt-2 border-t border-zinc-800/80">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div>
            <h4 className="font-semibold text-zinc-200 flex items-center gap-1.5">
              <Plug className="w-3.5 h-3.5 text-teal-400" />
              {t("setup.mcpWebhookTitle")}
            </h4>
            <p className="text-[11px] text-zinc-400 mt-0.5">{t("setup.mcpWebhookDesc")}</p>
          </div>
          <button
            type="button"
            onClick={copyMcp}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-teal-500/40 bg-teal-500/10 hover:bg-teal-500/20 text-teal-200 text-[11px] shrink-0"
          >
            <Copy className="w-3 h-3" />
            {mcpCopied ? t("setup.mcpCopied") : t("setup.mcpCopyBtn")}
          </button>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
          <div>
            <label className="block text-zinc-400 mb-1">{t("setup.publicBaseUrl")}</label>
            <input value={publicBaseUrl} onChange={(e) => setPublicBaseUrl(e.target.value)} placeholder="https://my-mac.tailnet.ts.net:4318" className={INPUT} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <div className="flex items-center justify-between gap-2 mb-1">
                <label className="text-zinc-400">
                  {t("setup.actionSecret")}
                  {n?.hasActionSecret && <span className="ml-1.5 text-[10px] text-emerald-400">({n.maskedActionSecret})</span>}
                </label>
                <button
                  type="button"
                  onClick={() =>
                    setActionSecret(`${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`)
                  }
                  className="inline-flex items-center gap-1 text-[10px] text-indigo-300 hover:text-indigo-200"
                >
                  <KeyRound className="w-2.5 h-2.5" />
                  {t("setup.generateSecretBtn")}
                </button>
              </div>
              <input value={actionSecret} onChange={(e) => setActionSecret(e.target.value)} placeholder="HMAC secret for /api/webhooks/action & chatops" className={INPUT} />
            </div>
            <div>
              <label className="block text-zinc-400 mb-1">
                {t("setup.githubWebhookSecret")}
                {n?.hasGithubWebhookSecret && <span className="ml-1.5 text-[10px] text-emerald-400">({n.maskedGithubWebhookSecret})</span>}
              </label>
              <input type="password" value={githubWebhookSecret} onChange={(e) => setGithubWebhookSecret(e.target.value)} placeholder="Secret configured on GitHub /api/webhooks/github" className={INPUT} />
            </div>
          </div>
        </div>
      </section>

      {error && <div className="p-3 rounded-lg border border-rose-500/30 bg-rose-500/10 text-rose-300 break-words">{error}</div>}

      <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-zinc-800/80">
        <button
          type="button"
          onClick={() => void testConnection()}
          disabled={testing}
          className="px-3.5 py-2 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 font-medium disabled:opacity-50"
        >
          {testing ? t("setup.testing") : t("setup.testConnection")}
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium disabled:opacity-50"
        >
          {saving ? t("setup.saving") : t("setup.saveActivate")}
        </button>
      </div>
    </div>
  );
}
