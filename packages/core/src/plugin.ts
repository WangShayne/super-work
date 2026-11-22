// Plugin contract: pure types only. Concrete loaders/registries live outside core.

export type PluginKind = "driver" | "trigger" | "outbox" | "llm" | "tool";

/** Free-form capability tag; semantics are scoped by the plugin's `kind`. */
export type PluginCapability = string;

export interface PluginConfigProperty {
  type: "string" | "number" | "boolean" | "array" | "object";
  description?: string;
  default?: unknown;
  enum?: readonly (string | number)[];
  secret?: boolean;
}

/** Minimal JSON-Schema subset describing plugin configuration. */
export interface PluginConfigSchema {
  type: "object";
  properties: Record<string, PluginConfigProperty>;
  required?: readonly string[];
}

export interface PluginManifest {
  id: string;
  name: string;
  /** Semver string, e.g. "1.2.0". */
  version: string;
  kind: PluginKind;
  capabilities: readonly PluginCapability[];
  configSchema?: PluginConfigSchema;
  description?: string;
}

export type PluginState = "loaded" | "enabled" | "disabled" | "failed";

interface PluginStatusBase {
  manifest: PluginManifest;
  config?: Record<string, unknown>;
  updatedAt: string;
}

/** Discriminated by `state`: a failed plugin always carries an error. */
export type PluginStatus =
  | (PluginStatusBase & { state: "loaded" | "enabled" | "disabled"; error?: undefined })
  | (PluginStatusBase & { state: "failed"; error: string });

export type PluginEvent =
  | { type: "plugin_loaded"; pluginId: string; manifest: PluginManifest; timestamp: string }
  | { type: "plugin_unloaded"; pluginId: string; timestamp: string }
  | { type: "plugin_enabled"; pluginId: string; timestamp: string }
  | { type: "plugin_disabled"; pluginId: string; timestamp: string }
  | { type: "plugin_failed"; pluginId: string; error: string; timestamp: string };

export interface PluginListFilter {
  kind?: PluginKind;
  state?: PluginState;
}

/** Read-only view; sufficient for query endpoints (ISP). */
export interface PluginRegistryReader {
  get(id: string): PluginStatus | undefined;
  list(filter?: PluginListFilter): PluginStatus[];
}

export type PluginEventListener = (event: PluginEvent) => void;

export interface PluginRegistry extends PluginRegistryReader {
  /** Insert or replace the status for `status.manifest.id`. */
  register(status: PluginStatus): void;
  /** Remove a plugin; returns false when the id is unknown. */
  unregister(id: string): boolean;
  /** Subscribe to lifecycle events; returns an unsubscribe function. */
  subscribe(listener: PluginEventListener): () => void;
}
