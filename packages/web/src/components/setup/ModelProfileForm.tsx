import { useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, XCircle } from "lucide-react";
import { api } from "../../api.ts";
import { FetchedModelPicker } from "./FetchedModelPicker.tsx";
import { useI18n, type TranslationKey } from "../../i18n.tsx";
import type { ModelConnectionTestResult, ReasoningEffort } from "../../types.ts";
import { isKeylessApi } from "../../utils/modelAdvisor.ts";
import {
  MODEL_TEMPLATES,
  TEMPLATE_GROUPS,
  draftFromTemplate,
  draftToTestPayload,
  type ProfileDraft,
} from "./modelTemplates.ts";

const INPUT =
  "w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs font-mono text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500 focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:opacity-60";
const BTN =
  "inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400";

interface ModelProfileFormProps {
  draft: ProfileDraft;
  /** true → "+ Add Model" (template picker visible); false → editing an existing profile. */
  isNew: boolean;
  saving: boolean;
  onChange: (next: ProfileDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}

/** Symmetric add/edit form for one ModelProfile (CLI or API); builtin CLI profiles keep kind/engine locked. */
export function ModelProfileForm({ draft, isNew, saving, onChange, onSave, onCancel }: ModelProfileFormProps) {
  const { t } = useI18n();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ModelConnectionTestResult | null>(null);
  const [testError, setTestError] = useState("");
  const [fetchedIds, setFetchedIds] = useState<string[]>([]);
  const set = (patch: Partial<ProfileDraft>) => {
    setResult(null);
    onChange({ ...draft, ...patch });
  };
  const isCli = draft.kind === "cli";
  // CLI relay fields are progressive disclosure: auto-open when already configured
  const [advancedOpen, setAdvancedOpen] = useState(Boolean(draft.baseUrl || draft.hasApiKey));
  const keyless = !isCli && isKeylessApi({ apiProtocol: draft.apiProtocol, baseUrl: draft.baseUrl });
  const efforts: ReasoningEffort[] = ["low", "medium", "high", "xhigh", ...(draft.cliEngine === "claude" ? (["max"] as const) : [])];
  const activeTemplate = MODEL_TEMPLATES.find(
    (tpl) => tpl.kind === draft.kind && (isCli ? tpl.cliEngine === draft.cliEngine : tpl.apiProtocol === draft.apiProtocol),
  );

  // Fetched models belong to one connection identity: reset on template switch or Base URL change.
  const resetKey = `${activeTemplate?.id ?? draft.cliEngine ?? ""}|${draft.baseUrl}`;

  const runTest = async () => {
    setTesting(true);
    setResult(null);
    setTestError("");
    try {
      setResult(await api.testModelConnection(draftToTestPayload(draft)));
    } catch (err) {
      setTestError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  const baseUrlField = (
    <label className="block min-w-0">
      <span className="block text-zinc-400 mb-1">{isCli ? t("worker.relayUrl") : t("models.form.baseUrlReq")}</span>
      <input value={draft.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} className={INPUT} />
    </label>
  );

  const keyField = (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1">
        <label htmlFor="model-profile-key" className="text-zinc-400">
          {isCli ? t("worker.relayKey") : keyless ? t("setup.apiKey") : t("models.form.keyReq")}
        </label>
        {draft.hasApiKey && !draft.clearApiKey && (
          <span className="text-[10px] font-mono text-emerald-400 truncate">
            {draft.maskedApiKey} · {t("setup.apiKeySavedHint")}
          </span>
        )}
      </div>
      <input
        id="model-profile-key"
        type="password"
        autoComplete="off"
        value={draft.apiKey}
        disabled={draft.clearApiKey}
        onChange={(e) => set({ apiKey: e.target.value })}
        placeholder={draft.hasApiKey ? `${draft.maskedApiKey ?? ""} (${t("setup.apiKeySavedHint")})` : t("setup.apiKeyPlaceholder")}
        className={INPUT}
      />
      {keyless && <p className="mt-1 text-[11px] text-emerald-400/90">{t("models.form.keyless")}</p>}
      {draft.hasApiKey && (
        <label className="inline-flex items-center gap-2 mt-1.5 text-[11px] text-zinc-400 cursor-pointer">
          <input
            type="checkbox"
            checked={draft.clearApiKey}
            onChange={(e) => set({ clearApiKey: e.target.checked, apiKey: "" })}
            className="rounded border-zinc-700 bg-zinc-950 text-indigo-500"
          />
          {t("worker.clearKey")}
        </label>
      )}
    </div>
  );

  const nameField = (
    <label className="block min-w-0">
      <span className="block text-zinc-400 mb-1">{t("models.form.name")}</span>
      <input value={draft.name} onChange={(e) => set({ name: e.target.value })} className={INPUT} />
    </label>
  );

  const suggestId = `model-suggest-${activeTemplate?.id ?? "cli"}`;
  const suggestions = [...new Set([...(isCli ? [] : (activeTemplate?.suggestions ?? [])), ...fetchedIds])];
  const modelField = (
    <label className="block min-w-0">
      <span className="block text-zinc-400 mb-1">{isCli ? t("models.form.modelOptional") : t("models.form.modelReq")}</span>
      <input
        value={draft.model}
        onChange={(e) => set({ model: e.target.value })}
        placeholder={isCli ? t("setup.followLocalDefault") : undefined}
        list={suggestions.length ? suggestId : undefined}
        className={INPUT}
      />
      {suggestions.length > 0 && (
        <datalist id={suggestId}>
          {suggestions.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      )}
    </label>
  );

  const effortField = (
    <label className="block min-w-0">
      <span className="block text-zinc-400 mb-1">{isCli ? t("models.form.effortOptional") : t("setup.effortLabel")}</span>
      <select value={draft.effort} onChange={(e) => set({ effort: e.target.value as ReasoningEffort | "" })} className={`${INPUT} font-sans`}>
        <option value="">{t("setup.effort.inherit")}</option>
        {efforts.map((e) => (
          <option key={e} value={e}>
            {t(`setup.effort.${e}` as TranslationKey)}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="rounded-xl border border-indigo-500/30 bg-zinc-900/70 p-3.5 space-y-3 text-xs sm:col-span-2">
      {isNew && (
        <div className="space-y-2.5">
          <div className="text-[11px] text-zinc-400">{t("models.form.pickTemplate")}</div>
          {TEMPLATE_GROUPS.map((group) => (
            <div key={group.track} className="space-y-1.5">
              <div className="text-[11px] font-medium text-zinc-300 break-words">{t(group.titleKey)}</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" role="radiogroup" aria-label={t(group.titleKey)}>
                {group.templates.map((tpl) => {
                  const selected = activeTemplate?.id === tpl.id;
                  return (
                    <button
                      key={tpl.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => {
                        setResult(null);
                        const next = draftFromTemplate(tpl);
                        setAdvancedOpen(false);
                        onChange(next);
                      }}
                      className={`px-2.5 py-2 rounded-lg border text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
                        selected ? "border-indigo-500 bg-indigo-500/10 text-zinc-100" : "border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-zinc-700"
                      }`}
                    >
                      <span className="block font-medium truncate">{t(tpl.titleKey)}</span>
                      <span className="block text-[10px] text-zinc-500 font-mono">{tpl.kind === "cli" ? "CLI" : "API"}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {draft.builtinCli && (
        <div className="text-[11px] text-zinc-500">
          {t("models.form.locked")} · <span className="font-mono text-zinc-300">CLI · {draft.cliEngine}</span>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {nameField}
        {isCli ? modelField : baseUrlField}
        {isCli && effortField}
      </div>

      {isCli ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40">
          <button
            type="button"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((v) => !v)}
            className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] text-zinc-300 hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 rounded-lg"
          >
            {advancedOpen ? <ChevronDown className="w-3.5 h-3.5 shrink-0" aria-hidden="true" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
            <span className="min-w-0 break-words">{t("models.form.advanced")}</span>
          </button>
          {advancedOpen && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-2.5 pt-1">
              {baseUrlField}
              {keyField}
              {draft.baseUrl.trim() && (
                <div className="sm:col-span-2">
                  <FetchedModelPicker draft={draft} resetKey={resetKey} onIds={setFetchedIds} onPick={(id) => set({ model: id })} labelKey="models.fetch.relay" disabled={saving} />
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <>
          {keyField}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="min-w-0 space-y-1.5">
              {modelField}
              <FetchedModelPicker draft={draft} resetKey={resetKey} onIds={setFetchedIds} onPick={(id) => set({ model: id })} disabled={saving} />
            </div>
            {effortField}
          </div>
        </>
      )}

      <label className="inline-flex items-center gap-2 text-zinc-200 cursor-pointer">
        <input
          type="checkbox"
          checked={draft.workerAutoPool}
          onChange={(e) => set({ workerAutoPool: e.target.checked })}
          className="rounded border-zinc-700 bg-zinc-950 text-indigo-500"
        />
        {t("models.autoPool")}
      </label>

      {(result || testError) && (
        <div
          role="status"
          className={`p-2.5 rounded-lg border text-[11px] flex items-start gap-2 break-words ${
            result?.ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-rose-500/30 bg-rose-500/10 text-rose-300"
          }`}
        >
          {result?.ok ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-px" /> : <XCircle className="w-3.5 h-3.5 shrink-0 mt-px" />}
          <span className="min-w-0">{result ? `${result.latencyMs}ms · ${result.message}` : testError}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button type="button" onClick={() => void runTest()} disabled={testing || saving} className={`${BTN} border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200`}>
          {testing && <Loader2 className="w-3 h-3 animate-spin" />}
          {testing ? t("setup.testing") : t("models.testConnection")}
        </button>
        <button type="button" onClick={onSave} disabled={saving || testing} className={`${BTN} bg-indigo-600 hover:bg-indigo-500 text-white`}>
          {saving ? t("setup.saving") : t("models.save")}
        </button>
        <button type="button" onClick={onCancel} disabled={saving} className={`${BTN} text-zinc-400 hover:text-zinc-200`}>
          {t("models.cancel")}
        </button>
      </div>
    </div>
  );
}
