import type { PluginConfigSchema, PluginKind, PluginManifest } from "@super-work/core";

const KINDS: readonly PluginKind[] = ["driver", "trigger", "outbox", "llm", "tool"];
const PROP_TYPES = ["string", "number", "boolean", "array", "object"];
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export type ManifestResult = { ok: true; manifest: PluginManifest } | { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateSchema(raw: unknown): string | null {
  if (!isRecord(raw) || raw.type !== "object") return "configSchema.type must be 'object'";
  if (!isRecord(raw.properties)) return "configSchema.properties must be an object";
  for (const [key, prop] of Object.entries(raw.properties)) {
    if (!isRecord(prop) || typeof prop.type !== "string" || !PROP_TYPES.includes(prop.type)) {
      return `configSchema.properties.${key}.type is invalid`;
    }
  }
  if (raw.required !== undefined) {
    if (!Array.isArray(raw.required) || raw.required.some((r) => typeof r !== "string")) {
      return "configSchema.required must be a string array";
    }
    for (const r of raw.required as string[]) {
      if (!(r in raw.properties)) return `configSchema.required references unknown property '${r}'`;
    }
  }
  return null;
}

export function validateManifest(raw: unknown): ManifestResult {
  if (!isRecord(raw)) return { ok: false, error: "manifest must be a JSON object" };
  if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) return { ok: false, error: "invalid manifest id" };
  if (typeof raw.name !== "string" || !raw.name.trim()) return { ok: false, error: "manifest name is required" };
  if (typeof raw.version !== "string" || !SEMVER_RE.test(raw.version)) {
    return { ok: false, error: "manifest version must be semver" };
  }
  if (typeof raw.kind !== "string" || !KINDS.includes(raw.kind as PluginKind)) {
    return { ok: false, error: `manifest kind must be one of ${KINDS.join(", ")}` };
  }
  if (!Array.isArray(raw.capabilities) || raw.capabilities.some((c) => typeof c !== "string")) {
    return { ok: false, error: "manifest capabilities must be a string array" };
  }
  if (raw.description !== undefined && typeof raw.description !== "string") {
    return { ok: false, error: "manifest description must be a string" };
  }
  if (raw.configSchema !== undefined) {
    const err = validateSchema(raw.configSchema);
    if (err) return { ok: false, error: err };
  }
  const manifest: PluginManifest = {
    id: raw.id,
    name: raw.name,
    version: raw.version,
    kind: raw.kind as PluginKind,
    capabilities: raw.capabilities as string[],
    ...(raw.configSchema ? { configSchema: raw.configSchema as unknown as PluginConfigSchema } : {}),
    ...(raw.description ? { description: raw.description as string } : {}),
  };
  return { ok: true, manifest };
}

/** Validate `config` against a schema; returns an error message or null. */
export function validateConfig(schema: PluginConfigSchema | undefined, config: Record<string, unknown>): string | null {
  if (!schema) return null;
  for (const key of schema.required ?? []) {
    if (config[key] === undefined) return `missing required config '${key}'`;
  }
  for (const [key, value] of Object.entries(config)) {
    const prop = schema.properties[key];
    if (!prop) continue;
    const actual = Array.isArray(value) ? "array" : typeof value;
    if (actual !== prop.type) return `config '${key}' must be ${prop.type}`;
    if (prop.enum && !prop.enum.includes(value as string | number)) return `config '${key}' not in enum`;
  }
  return null;
}
