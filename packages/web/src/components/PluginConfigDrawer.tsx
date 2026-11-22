import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { parseApiError } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import type { PluginConfigProperty, PluginStatus } from "../types.ts";

interface PluginConfigDrawerProps {
  plugin: PluginStatus | null;
  onClose: () => void;
  /** Persist config; resolves once the server accepted it. */
  onSave: (plugin: PluginStatus, config: Record<string, unknown>) => Promise<void>;
}

type FormValues = Record<string, string | boolean>;

const INPUT_CLASS =
  "w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100 focus:outline-none focus:border-indigo-500";

function initialValue(prop: PluginConfigProperty, current: unknown): string | boolean {
  if (prop.secret) return "";
  const v = current !== undefined ? current : prop.default;
  if (prop.type === "boolean") return v === true;
  if (v === undefined || v === null) return "";
  if (prop.type === "array" || prop.type === "object") return JSON.stringify(v, null, 2);
  return String(v);
}

export function PluginConfigDrawer({ plugin, onClose, onSave }: PluginConfigDrawerProps) {
  const { t } = useI18n();
  const [values, setValues] = useState<FormValues>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const schema = plugin?.manifest.configSchema;
  const pluginId = plugin?.manifest.id;

  useEffect(() => {
    if (!plugin || !schema) return;
    const next: FormValues = {};
    for (const [key, prop] of Object.entries(schema.properties)) {
      next[key] = initialValue(prop, plugin.config?.[key]);
    }
    setValues(next);
    setError(null);
    // Reset only when a different plugin is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginId]);

  if (!plugin || !schema) return null;

  const required = new Set(schema.required ?? []);
  const hadStoredConfig = plugin.config !== undefined;

  /** Build payload from form values; returns an error message on invalid input. */
  const buildConfig = (): { config: Record<string, unknown> } | { error: string } => {
    const config: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(schema.properties)) {
      const raw = values[key];
      if (prop.type === "boolean") {
        config[key] = raw === true;
        continue;
      }
      const text = typeof raw === "string" ? raw.trim() : "";
      if (text === "") {
        if (prop.secret && hadStoredConfig && plugin.config?.[key] !== undefined) {
          return { error: `${t("plugins.config.secretRequired")} ${key}` };
        }
        if (required.has(key)) return { error: `${t("plugins.config.required")} ${key}` };
        continue;
      }
      if (prop.type === "number") {
        const n = Number(text);
        if (!Number.isFinite(n)) return { error: `${t("plugins.config.invalidNumber")} ${key}` };
        config[key] = n;
      } else if (prop.type === "array" || prop.type === "object") {
        try {
          config[key] = JSON.parse(text);
        } catch {
          return { error: `${t("plugins.config.invalidJson")} ${key}` };
        }
      } else if (prop.enum?.some((e) => typeof e === "number")) {
        const n = Number(text);
        config[key] = Number.isFinite(n) ? n : text;
      } else {
        config[key] = text;
      }
    }
    return { config };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const built = buildConfig();
    if ("error" in built) {
      setError(built.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(plugin, built.config);
      onClose();
    } catch (err) {
      setError(parseApiError(err));
    } finally {
      setSaving(false);
    }
  };

  const setValue = (key: string, v: string | boolean) =>
    setValues((prev) => ({ ...prev, [key]: v }));

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-xs" onClick={onClose}>
      <aside
        onClick={(e) => e.stopPropagation()}
        className="h-full w-full max-w-md border-l border-zinc-800 bg-zinc-950 p-5 space-y-4 overflow-y-auto shadow-2xl"
      >
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">{t("plugins.config.title")}</h3>
            <p className="text-[11px] text-zinc-500 font-mono">{plugin.manifest.name}</p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3 text-xs">
          {Object.entries(schema.properties).map(([key, prop]) => (
            <div key={key}>
              <label className="block text-zinc-400 mb-1">
                {key}
                {required.has(key) && <span className="text-rose-400"> *</span>}
                <span className="ml-2 text-[10px] font-mono text-zinc-600">{prop.type}</span>
              </label>
              {prop.type === "boolean" ? (
                <input
                  type="checkbox"
                  checked={values[key] === true}
                  onChange={(e) => setValue(key, e.target.checked)}
                  className="accent-indigo-500"
                />
              ) : prop.enum ? (
                <select
                  value={String(values[key] ?? "")}
                  onChange={(e) => setValue(key, e.target.value)}
                  className={INPUT_CLASS}
                >
                  <option value="" />
                  {prop.enum.map((opt) => (
                    <option key={String(opt)} value={String(opt)}>
                      {String(opt)}
                    </option>
                  ))}
                </select>
              ) : prop.type === "array" || prop.type === "object" ? (
                <textarea
                  rows={4}
                  value={String(values[key] ?? "")}
                  onChange={(e) => setValue(key, e.target.value)}
                  className={`${INPUT_CLASS} font-mono`}
                />
              ) : (
                <input
                  type={prop.secret ? "password" : prop.type === "number" ? "number" : "text"}
                  step={prop.type === "number" ? "any" : undefined}
                  autoComplete="off"
                  value={String(values[key] ?? "")}
                  onChange={(e) => setValue(key, e.target.value)}
                  placeholder={
                    prop.secret && plugin.config?.[key] !== undefined
                      ? t("plugins.config.secretKeep")
                      : undefined
                  }
                  className={INPUT_CLASS}
                />
              )}
              {prop.description && <p className="mt-1 text-[10px] text-zinc-500">{prop.description}</p>}
            </div>
          ))}

          {error && (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-rose-200">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="submit"
              disabled={saving}
              className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium disabled:opacity-40 transition"
            >
              {saving
                ? t("plugins.config.saving")
                : plugin.state === "enabled"
                  ? t("plugins.config.save")
                  : t("plugins.config.saveEnable")}
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}
