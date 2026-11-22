import { describe, expect, it } from "bun:test";
import type {
  PluginEvent,
  PluginEventListener,
  PluginListFilter,
  PluginLoaderPort,
  PluginManifest,
  PluginRegistry,
  PluginRegistryReader,
  PluginStatus,
} from "../src/index.ts";

const manifest = {
  id: "demo",
  name: "Demo",
  version: "1.0.0",
  kind: "driver",
  capabilities: ["run_turn"],
  configSchema: {
    type: "object",
    properties: { apiKey: { type: "string", secret: true } },
    required: ["apiKey"],
  },
} satisfies PluginManifest;

function createRegistry(): PluginRegistry {
  const items = new Map<string, PluginStatus>();
  const listeners = new Set<PluginEventListener>();
  return {
    get: (id) => items.get(id),
    list(filter?: PluginListFilter) {
      return [...items.values()].filter(
        (s) => (!filter?.kind || s.manifest.kind === filter.kind) && (!filter?.state || s.state === filter.state),
      );
    },
    register(status) {
      items.set(status.manifest.id, status);
    },
    unregister: (id) => items.delete(id),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function createLoader(registry: PluginRegistry, emit: (e: PluginEvent) => void): PluginLoaderPort {
  const now = () => new Date(0).toISOString();
  const require = (id: string): PluginStatus => {
    const s = registry.get(id);
    if (!s) throw new Error(`unknown plugin: ${id}`);
    return s;
  };
  const transition = (id: string, state: "enabled" | "disabled", config?: Record<string, unknown>): PluginStatus => {
    const next: PluginStatus = { manifest: require(id).manifest, state, config, updatedAt: now() };
    registry.register(next);
    emit({ type: state === "enabled" ? "plugin_enabled" : "plugin_disabled", pluginId: id, timestamp: now() });
    return next;
  };
  return {
    async load() {
      registry.register({ manifest, state: "loaded", updatedAt: now() });
      emit({ type: "plugin_loaded", pluginId: manifest.id, manifest, timestamp: now() });
      return manifest;
    },
    async unload(id) {
      require(id);
      registry.unregister(id);
      emit({ type: "plugin_unloaded", pluginId: id, timestamp: now() });
    },
    async list() {
      return registry.list();
    },
    async enable(id, config) {
      return transition(id, "enabled", config);
    },
    async disable(id) {
      return transition(id, "disabled");
    },
  };
}

function describeEvent(e: PluginEvent): string {
  switch (e.type) {
    case "plugin_loaded":
    case "plugin_unloaded":
    case "plugin_enabled":
    case "plugin_disabled":
      return e.type;
    case "plugin_failed":
      return `${e.type}:${e.error}`;
    default: {
      const unreachable: never = e;
      return unreachable;
    }
  }
}

describe("plugin contract", () => {
  it("walks load -> enable -> disable -> unload and emits ordered events", async () => {
    const registry = createRegistry();
    const events: PluginEvent[] = [];
    const loader = createLoader(registry, (e) => events.push(e));

    await loader.load("file:///demo");
    expect((await loader.list())[0]?.state).toBe("loaded");
    expect((await loader.enable("demo", { apiKey: "x" })).state).toBe("enabled");
    expect((await loader.disable("demo")).state).toBe("disabled");
    await loader.unload("demo");

    expect(registry.get("demo")).toBeUndefined();
    expect(events.map(describeEvent)).toEqual([
      "plugin_loaded",
      "plugin_enabled",
      "plugin_disabled",
      "plugin_unloaded",
    ]);
  });

  it("rejects operations on unknown ids", async () => {
    const loader = createLoader(createRegistry(), () => {});
    await expect(loader.unload("nope")).rejects.toThrow("unknown plugin");
  });

  it("filters via the narrow reader view and supports unsubscribe", () => {
    const registry = createRegistry();
    const reader: PluginRegistryReader = registry;
    registry.register({ manifest, state: "enabled", updatedAt: "t" });
    expect(reader.list({ kind: "driver", state: "enabled" })).toHaveLength(1);
    expect(reader.list({ kind: "llm" })).toHaveLength(0);

    const seen: PluginEvent[] = [];
    const off = registry.subscribe((e) => seen.push(e));
    off();
    expect(seen).toHaveLength(0);
  });

  it("enforces type-level invariants", () => {
    // @ts-expect-error invalid kind
    const badKind: PluginManifest = { ...manifest, kind: "bogus" };
    // @ts-expect-error failed state requires error
    const badFailed: PluginStatus = { manifest, state: "failed", updatedAt: "t" };
    expect(badKind).toBeDefined();
    expect(badFailed).toBeDefined();
  });
});
