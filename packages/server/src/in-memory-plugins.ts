import { nowIso } from "@super-work/core";
import type {
  PluginEvent,
  PluginEventListener,
  PluginListFilter,
  PluginLoaderPort,
  PluginManifest,
  PluginRegistry,
  PluginStatus,
} from "@super-work/core";

/** Minimal in-process registry; real discovery/loading is provided by a drivers-level loader. */
export class InMemoryPluginRegistry implements PluginRegistry {
  private readonly items = new Map<string, PluginStatus>();
  private readonly listeners = new Set<PluginEventListener>();

  get(id: string): PluginStatus | undefined {
    return this.items.get(id);
  }

  list(filter?: PluginListFilter): PluginStatus[] {
    return [...this.items.values()].filter(
      (s) =>
        (!filter?.kind || s.manifest.kind === filter.kind) &&
        (!filter?.state || s.state === filter.state),
    );
  }

  register(status: PluginStatus): void {
    const id = status.manifest.id;
    this.items.set(id, status);
    const timestamp = status.updatedAt;
    const event: PluginEvent =
      status.state === "failed"
        ? { type: "plugin_failed", pluginId: id, error: status.error, timestamp }
        : status.state === "enabled"
          ? { type: "plugin_enabled", pluginId: id, timestamp }
          : status.state === "disabled"
            ? { type: "plugin_disabled", pluginId: id, timestamp }
            : { type: "plugin_loaded", pluginId: id, manifest: status.manifest, timestamp };
    this.emit(event);
  }

  unregister(id: string): boolean {
    const removed = this.items.delete(id);
    if (removed) this.emit({ type: "plugin_unloaded", pluginId: id, timestamp: nowIso() });
    return removed;
  }

  subscribe(listener: PluginEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: PluginEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/** Registry-backed loader: `load` accepts a JSON-encoded manifest; no filesystem discovery. */
export class RegistryBackedPluginLoader implements PluginLoaderPort {
  constructor(private readonly registry: PluginRegistry) {}

  async load(source: string): Promise<PluginManifest> {
    let manifest: PluginManifest;
    try {
      manifest = JSON.parse(source) as PluginManifest;
    } catch {
      throw new Error("unsupported plugin source: expected a JSON manifest");
    }
    if (!manifest?.id || !manifest.name || !manifest.version || !manifest.kind) {
      throw new Error("invalid plugin manifest");
    }
    this.registry.register({ state: "loaded", manifest, updatedAt: nowIso() });
    return manifest;
  }

  async unload(id: string): Promise<void> {
    if (!this.registry.unregister(id)) throw new Error(`Plugin not found: ${id}`);
  }

  async list(): Promise<PluginStatus[]> {
    return this.registry.list();
  }

  async enable(id: string, config?: Record<string, unknown>): Promise<PluginStatus> {
    return this.transition(id, "enabled", config);
  }

  async disable(id: string): Promise<PluginStatus> {
    return this.transition(id, "disabled");
  }

  private transition(
    id: string,
    state: "enabled" | "disabled",
    config?: Record<string, unknown>,
  ): PluginStatus {
    const current = this.registry.get(id);
    if (!current) throw new Error(`Plugin not found: ${id}`);
    const next: PluginStatus = {
      manifest: current.manifest,
      config: config ?? current.config,
      state,
      updatedAt: nowIso(),
    };
    this.registry.register(next);
    return next;
  }
}
