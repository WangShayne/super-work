import type { Context } from "hono";
import type { Hono } from "hono";
import type {
  PluginConfigProperty,
  PluginConfigSchema,
  PluginKind,
  PluginLoaderPort,
  PluginRegistryReader,
  PluginState,
  PluginStatus,
} from "@super-work/core";

export interface PluginRouteDeps {
  registry: PluginRegistryReader;
  loader: PluginLoaderPort;
}

const PLUGIN_KINDS: readonly PluginKind[] = ["driver", "trigger", "outbox", "llm", "tool"];
const PLUGIN_STATES: readonly PluginState[] = ["loaded", "enabled", "disabled", "failed"];
const REDACTED = "****";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesType(prop: PluginConfigProperty, value: unknown): boolean {
  switch (prop.type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
  }
}

/** Validate `config` against a plugin's schema; returns human-readable errors (empty when valid). */
export function validateConfig(schema: PluginConfigSchema | undefined, config: unknown): string[] {
  if (!isPlainObject(config)) return ["config must be a JSON object"];
  const errors: string[] = [];
  const properties = schema?.properties ?? {};

  for (const [key, value] of Object.entries(config)) {
    const prop = Object.hasOwn(properties, key) ? properties[key] : undefined;
    if (!prop) {
      errors.push(`unknown config key: ${key}`);
      continue;
    }
    if (!matchesType(prop, value)) {
      errors.push(`config.${key} must be of type ${prop.type}`);
      continue;
    }
    if (prop.enum && !prop.enum.includes(value as string | number)) {
      errors.push(`config.${key} must be one of: ${prop.enum.join(", ")}`);
    }
  }
  for (const key of schema?.required ?? []) {
    if (config[key] === undefined) errors.push(`missing required config key: ${key}`);
  }
  return errors;
}

/** Mask values of `secret` config properties so they never leave the server. */
export function redactPluginStatus(status: PluginStatus): PluginStatus {
  const properties = status.manifest.configSchema?.properties;
  if (!status.config || !properties) return status;
  const config: Record<string, unknown> = { ...status.config };
  for (const [key, prop] of Object.entries(properties)) {
    if (prop.secret && config[key] !== undefined) config[key] = REDACTED;
  }
  return { ...status, config };
}

type ParsedBody = { ok: true; body: Record<string, unknown> } | { ok: false };

async function readJsonBody(c: Context, allowEmpty: boolean): Promise<ParsedBody> {
  const text = await c.req.text();
  if (!text.trim()) return allowEmpty ? { ok: true, body: {} } : { ok: false };
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? { ok: true, body: parsed } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function registerPluginRoutes(app: Hono, deps: PluginRouteDeps): void {
  const { registry, loader } = deps;
  const notFound = (c: Context, id: string) =>
    c.json({ error: `Plugin not found: ${id}` }, 404);
  const invalidBody = (c: Context) => c.json({ error: "request body must be a JSON object" }, 400);
  const invalidConfig = (c: Context, details: string[]) =>
    c.json({ error: "invalid config", details }, 400);

  // Run a loader mutation; loader rejections become 409 without leaking stacks.
  async function applyLoader(c: Context, op: () => Promise<PluginStatus>) {
    try {
      return c.json({ plugin: redactPluginStatus(await op()) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
  }

  app.get("/api/plugins", (c) => {
    const kind = c.req.query("kind") || undefined;
    const state = c.req.query("state") || undefined;
    if (kind && !PLUGIN_KINDS.includes(kind as PluginKind)) {
      return c.json({ error: `invalid kind: ${kind}`, allowed: PLUGIN_KINDS }, 400);
    }
    if (state && !PLUGIN_STATES.includes(state as PluginState)) {
      return c.json({ error: `invalid state: ${state}`, allowed: PLUGIN_STATES }, 400);
    }
    const plugins = registry
      .list({ kind: kind as PluginKind | undefined, state: state as PluginState | undefined })
      .map(redactPluginStatus);
    return c.json({ plugins });
  });

  app.get("/api/plugins/:id", (c) => {
    const id = c.req.param("id");
    const plugin = registry.get(id);
    if (!plugin) return notFound(c, id);
    return c.json({ plugin: redactPluginStatus(plugin) });
  });

  app.post("/api/plugins/:id/enable", async (c) => {
    const id = c.req.param("id");
    const plugin = registry.get(id);
    if (!plugin) return notFound(c, id);

    const parsed = await readJsonBody(c, true);
    if (!parsed.ok) return invalidBody(c);
    const config = parsed.body.config;
    if (config !== undefined) {
      const errors = validateConfig(plugin.manifest.configSchema, config);
      if (errors.length > 0) return invalidConfig(c, errors);
    }
    return applyLoader(c, () => loader.enable(id, config as Record<string, unknown> | undefined));
  });

  app.post("/api/plugins/:id/disable", (c) => {
    const id = c.req.param("id");
    if (!registry.get(id)) return notFound(c, id);
    return applyLoader(c, () => loader.disable(id));
  });

  app.put("/api/plugins/:id/config", async (c) => {
    const id = c.req.param("id");
    const plugin = registry.get(id);
    if (!plugin) return notFound(c, id);

    const parsed = await readJsonBody(c, false);
    if (!parsed.ok) return invalidBody(c);
    const errors = validateConfig(plugin.manifest.configSchema, parsed.body.config);
    if (errors.length > 0) return invalidConfig(c, errors);

    // PluginLoaderPort has no config-update method; enable() is idempotent and applies config.
    if (plugin.state !== "enabled") {
      return c.json({ error: `plugin must be enabled to update config (state: ${plugin.state})` }, 409);
    }
    return applyLoader(c, () => loader.enable(id, parsed.body.config as Record<string, unknown>));
  });
}
