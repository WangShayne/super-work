import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, XCircle } from "lucide-react";
import { api } from "../../api.ts";
import { useI18n, type TranslationKey } from "../../i18n.tsx";
import type { DiscoveredModelItem } from "../../types.ts";
import { draftToTestPayload, type ProfileDraft } from "./modelTemplates.ts";

interface FetchedModelPickerProps {
  draft: ProfileDraft;
  /** Fills the Model field (chip click or auto-select of the first model). */
  onPick: (id: string) => void;
  /** Reports fetched ids so the parent can merge them into the Model <datalist>. */
  onIds?: (ids: string[]) => void;
  /** Changing this value (template / baseUrl) discards fetched models and any in-flight result. */
  resetKey: string;
  labelKey?: TranslationKey;
  disabled?: boolean;
}

/** "Fetch Models" button + filterable chip tray backed by live upstream /models | /model discovery. */
export function FetchedModelPicker({ draft, onPick, onIds, resetKey, labelKey = "models.fetch.button", disabled }: FetchedModelPickerProps) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [models, setModels] = useState<DiscoveredModelItem[] | null>(null);
  const [filter, setFilter] = useState("");
  const seq = useRef(0);

  useEffect(() => {
    seq.current += 1;
    setLoading(false);
    setError("");
    setModels(null);
    setFilter("");
    onIds?.([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the connection identity changes
  }, [resetKey]);

  const run = async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError("");
    try {
      const res = await api.fetchProviderModels(draftToTestPayload(draft));
      if (mine !== seq.current) return;
      if (!res.ok) {
        setModels(null);
        setError(res.message);
        return;
      }
      setModels(res.models);
      onIds?.(res.models.map((m) => m.id));
      if (!draft.model.trim() && res.models[0]) onPick(res.models[0].id);
    } catch (err) {
      if (mine === seq.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  };

  const needle = filter.trim().toLowerCase();
  const visible = (models ?? []).filter((m) => !needle || m.id.toLowerCase().includes(needle) || m.label?.toLowerCase().includes(needle));

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={() => void run()}
        disabled={loading || disabled}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-[11px] text-zinc-200 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
      >
        {loading ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : <RefreshCw className="w-3 h-3" aria-hidden="true" />}
        {loading ? t("models.fetch.loading") : t(labelKey)}
      </button>
      {error && (
        <div role="status" className="flex items-start gap-1.5 p-2 rounded-lg border border-rose-500/30 bg-rose-500/10 text-[11px] text-rose-300 break-words">
          <XCircle className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" />
          <span className="min-w-0">{error}</span>
        </div>
      )}
      {models && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2 space-y-1.5">
          <div className="text-[11px] text-zinc-400">
            {models.length === 0 ? t("models.fetch.empty") : t("models.fetch.count").replace("{n}", String(models.length))}
          </div>
          {models.length > 8 && (
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t("models.fetch.filter")}
              aria-label={t("models.fetch.filter")}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-md px-2 py-1 text-[11px] font-mono text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500"
            />
          )}
          <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
            {visible.map((m) => (
              <button
                key={m.id}
                type="button"
                title={m.label ?? m.ownedBy}
                aria-pressed={m.id === draft.model}
                onClick={() => onPick(m.id)}
                className={`px-2 py-0.5 rounded-md border text-[11px] font-mono transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
                  m.id === draft.model ? "border-indigo-500 bg-indigo-500/15 text-zinc-100" : "border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-zinc-600"
                }`}
              >
                {m.id}
              </button>
            ))}
            {models.length > 0 && visible.length === 0 && <span className="text-[11px] text-zinc-500">{t("models.fetch.noMatch")}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
