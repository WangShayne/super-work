import { useCallback, useEffect, useState } from "react";
import { Puzzle, RefreshCw } from "lucide-react";
import { api, parseApiError } from "../api.ts";
import { PluginConfigDrawer } from "../components/PluginConfigDrawer.tsx";
import { useI18n } from "../i18n.tsx";
import type { PluginState, PluginStatus } from "../types.ts";

const STATE_TONE: Record<PluginState, string> = {
  enabled: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  loaded: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  disabled: "border-zinc-700 bg-zinc-800 text-zinc-400",
  failed: "border-rose-500/30 bg-rose-500/10 text-rose-300",
};

interface Feedback {
  ok: boolean;
  text: string;
}

export function PluginsView() {
  const { t } = useI18n();
  const [plugins, setPlugins] = useState<PluginStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [configuring, setConfiguring] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.listPlugins();
      setPlugins(res.plugins);
    } catch (err) {
      setLoadError(parseApiError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const replacePlugin = (next: PluginStatus) =>
    setPlugins((prev) => prev.map((p) => (p.manifest.id === next.manifest.id ? next : p)));

  const handleToggle = async (p: PluginStatus) => {
    const id = p.manifest.id;
    const enabling = p.state !== "enabled";
    setPendingId(id);
    setFeedback(null);
    try {
      const res = enabling ? await api.enablePlugin(id) : await api.disablePlugin(id);
      replacePlugin(res.plugin);
      setFeedback({
        ok: true,
        text: `${p.manifest.name}: ${enabling ? t("plugins.enabledOk") : t("plugins.disabledOk")}`,
      });
    } catch (err) {
      setFeedback({ ok: false, text: `${p.manifest.name}: ${t("plugins.actionFailed")} — ${parseApiError(err)}` });
    } finally {
      setPendingId(null);
    }
  };

  const handleSaveConfig = async (p: PluginStatus, config: Record<string, unknown>) => {
    const id = p.manifest.id;
    // Server only accepts PUT /config for enabled plugins; otherwise enable with config.
    const res =
      p.state === "enabled" ? await api.updatePluginConfig(id, config) : await api.enablePlugin(id, config);
    replacePlugin(res.plugin);
    setFeedback({ ok: true, text: `${p.manifest.name}: ${t("plugins.config.savedOk")}` });
  };

  const configuringPlugin = plugins.find((p) => p.manifest.id === configuring) ?? null;

  return (
    <div className="px-5 py-5 space-y-4 max-w-5xl">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
          <Puzzle className="w-4 h-4 text-indigo-400" />
          {t("plugins.title")}
        </h2>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-xs font-medium disabled:opacity-40 transition"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          {t("plugins.refresh")}
        </button>
      </div>

      {feedback && (
        <div
          role="status"
          className={`rounded-lg border px-3 py-2 text-xs ${
            feedback.ok
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
              : "border-rose-500/30 bg-rose-500/10 text-rose-200"
          }`}
        >
          {feedback.text}
        </div>
      )}

      {loadError && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          {t("plugins.loadFailed")}: {loadError}
        </div>
      )}

      {loading && plugins.length === 0 ? (
        <p className="text-xs text-zinc-500">{t("plugins.loading")}</p>
      ) : plugins.length === 0 && !loadError ? (
        <p className="text-xs text-zinc-500">{t("plugins.empty")}</p>
      ) : (
        <ul className="space-y-2">
          {plugins.map((p) => {
            const { manifest } = p;
            const pending = pendingId === manifest.id;
            const hasSchema = !!manifest.configSchema && Object.keys(manifest.configSchema.properties).length > 0;
            return (
              <li
                key={manifest.id}
                className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 flex flex-wrap items-start justify-between gap-3"
              >
                <div className="space-y-1.5 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-zinc-100">{manifest.name}</span>
                    <span className="text-[10px] font-mono text-zinc-500">v{manifest.version}</span>
                    <span className="px-1.5 rounded border border-zinc-700 text-[10px] text-zinc-400">
                      {t(`plugins.kind.${manifest.kind}`)}
                    </span>
                    <span className={`px-1.5 rounded border text-[10px] ${STATE_TONE[p.state]}`}>
                      {t(`plugins.state.${p.state}`)}
                    </span>
                  </div>
                  {manifest.description && <p className="text-xs text-zinc-400">{manifest.description}</p>}
                  {manifest.capabilities.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {manifest.capabilities.map((c) => (
                        <span key={c} className="px-1.5 rounded bg-zinc-800 text-[10px] font-mono text-zinc-400">
                          {c}
                        </span>
                      ))}
                    </div>
                  )}
                  {p.error && <p className="text-xs text-rose-300">{p.error}</p>}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => setConfiguring(manifest.id)}
                    disabled={!hasSchema}
                    title={hasSchema ? undefined : t("plugins.noConfig")}
                    className="px-2.5 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-xs font-medium disabled:opacity-40 transition"
                  >
                    {t("plugins.configure")}
                  </button>
                  <button
                    role="switch"
                    aria-checked={p.state === "enabled"}
                    aria-label={p.state === "enabled" ? t("plugins.disable") : t("plugins.enable")}
                    title={p.state === "enabled" ? t("plugins.disable") : t("plugins.enable")}
                    disabled={pending}
                    onClick={() => void handleToggle(p)}
                    className={`relative w-9 h-5 rounded-full transition disabled:opacity-40 ${
                      p.state === "enabled" ? "bg-emerald-500" : "bg-zinc-700"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                        p.state === "enabled" ? "translate-x-4" : ""
                      }`}
                    />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <PluginConfigDrawer
        plugin={configuringPlugin}
        onClose={() => setConfiguring(null)}
        onSave={handleSaveConfig}
      />
    </div>
  );
}
