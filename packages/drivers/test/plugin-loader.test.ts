import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginEvent } from "@super-work/core";
import {
  FilePluginStateStore,
  MockWorkerDriver,
  PluginLoader,
  SqlitePluginStateStore,
  registerBuiltinPlugins,
  validateManifest,
  type PluginModule,
} from "../src/index.ts";

const good = {
  id: "demo",
  name: "Demo",
  version: "1.0.0",
  kind: "driver",
  capabilities: ["run_turn"],
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plugin-loader-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writePlugin(name: string, manifest: unknown, entry?: string): string {
  const p = join(dir, "plugins", name);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, "plugin.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  if (entry !== undefined) writeFileSync(join(p, "index.ts"), entry);
  return p;
}

const okEntry = "export default { activate: (c) => ({ cfg: c }), deactivate: () => {} };";

describe("validateManifest", () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ["bad id", { ...good, id: "../evil" }],
    ["bad semver", { ...good, version: "1" }],
    ["bad kind", { ...good, kind: "nope" }],
    ["caps not array", { ...good, capabilities: "x" }],
    ["schema required unknown", { ...good, configSchema: { type: "object", properties: {}, required: ["a"] } }],
  ];
  for (const [name, m] of bad) {
    it(`rejects ${name}`, () => expect(validateManifest(m).ok).toBe(false));
  }
  it("accepts valid", () => expect(validateManifest(good).ok).toBe(true));
  it("rejects non-object", () => expect(validateManifest("x").ok).toBe(false));
});

describe("PluginLoader", () => {
  it("loads, enables (idempotent), disables, unloads with events", async () => {
    const p = writePlugin("demo", good, okEntry);
    const loader = new PluginLoader();
    const events: string[] = [];
    loader.registry.subscribe((e: PluginEvent) => events.push(e.type));

    expect((await loader.load(p)).id).toBe("demo");
    expect((await loader.list())[0]?.state).toBe("loaded");
    const a = await loader.enable("demo", { x: 1 });
    const b = await loader.enable("demo");
    expect(a.state).toBe("enabled");
    expect(b).toEqual(a);
    expect(loader.getInstance("demo")).toEqual({ cfg: { x: 1 } });
    expect((await loader.disable("demo")).state).toBe("disabled");
    await loader.unload("demo");
    expect(await loader.list()).toEqual([]);
    expect(events).toEqual(["plugin_loaded", "plugin_enabled", "plugin_disabled", "plugin_unloaded"]);
  });

  it("rejects unknown ids", async () => {
    const loader = new PluginLoader();
    await expect(loader.enable("nope")).rejects.toThrow();
    await expect(loader.disable("nope")).rejects.toThrow();
    await expect(loader.unload("nope")).rejects.toThrow();
  });

  it("rejects duplicate load without clobbering the healthy plugin", async () => {
    const p = writePlugin("demo", good, okEntry);
    const loader = new PluginLoader();
    await loader.load(p);
    await loader.enable("demo");
    await expect(loader.load(p)).rejects.toThrow(/already loaded/);
    expect(loader.registry.get("demo")?.state).toBe("enabled");
  });

  it("discover isolates invalid manifest and import failures", async () => {
    writePlugin("a-good", { ...good, id: "good" }, okEntry);
    writePlugin("b-badmanifest", "{not json");
    writePlugin("c-badimport", { ...good, id: "boom" }, "throw new Error('kaboom');");
    writePlugin("d-noactivate", { ...good, id: "noact" }, "export default {};");
    const loader = new PluginLoader({ pluginsDir: join(dir, "plugins") });
    const events: PluginEvent[] = [];
    loader.registry.subscribe((e) => events.push(e));

    const list = await loader.discover();
    const byId = Object.fromEntries(list.map((s) => [s.manifest.id, s]));
    expect(byId.good?.state).toBe("loaded");
    expect(byId.boom?.state).toBe("failed");
    expect(byId.boom?.error).toContain("kaboom");
    expect(byId.noact?.state).toBe("failed");
    expect(byId["b-badmanifest"]?.state).toBe("failed");
    expect(events.filter((e) => e.type === "plugin_failed")).toHaveLength(3);
  });

  it("rejects entry path escaping plugin dir", async () => {
    const p = writePlugin("esc", { ...good, id: "esc", main: "../outside.ts" });
    const loader = new PluginLoader();
    await expect(loader.load(p)).rejects.toThrow(/escapes/);
    expect(loader.registry.get("esc")?.state).toBe("failed");
  });

  it("validates config and surfaces failure as failed status", async () => {
    const loader = new PluginLoader();
    const schema = { type: "object", properties: { key: { type: "string" } }, required: ["key"] };
    await loader.loadModule({ ...good, configSchema: schema }, { activate: () => 1 });
    const s = await loader.enable("demo", {});
    expect(s.state).toBe("failed");
    expect(s.error).toContain("key");
    // retry succeeds with valid config
    expect((await loader.enable("demo", { key: "v" })).state).toBe("enabled");
  });

  it("activate throw and timeout become failed", async () => {
    const loader = new PluginLoader({ activateTimeoutMs: 20 });
    await loader.loadModule({ ...good, id: "thrower" }, { activate: () => { throw new Error("nope"); } });
    await loader.loadModule({ ...good, id: "slow" }, { activate: () => new Promise(() => {}) });
    expect((await loader.enable("thrower")).error).toContain("nope");
    expect((await loader.enable("slow")).error).toContain("timed out");
  });

  it("disable still succeeds when deactivate throws", async () => {
    const loader = new PluginLoader();
    const mod: PluginModule = { activate: () => ({}), deactivate: () => { throw new Error("x"); } };
    await loader.loadModule(good, mod);
    await loader.enable("demo");
    expect((await loader.disable("demo")).state).toBe("disabled");
  });

  it("calls deactivate on unload", async () => {
    let deactivated = 0;
    const loader = new PluginLoader();
    await loader.loadModule(good, { activate: () => "inst", deactivate: (i) => { if (i === "inst") deactivated++; } });
    await loader.enable("demo");
    await loader.unload("demo");
    expect(deactivated).toBe(1);
  });

  it("registry listener errors are isolated", async () => {
    const loader = new PluginLoader();
    loader.registry.subscribe(() => { throw new Error("listener"); });
    await loader.loadModule(good, { activate: () => 1 });
    expect((await loader.enable("demo")).state).toBe("enabled");
  });
});

describe("persistence", () => {
  const schema = {
    type: "object",
    properties: { mode: { type: "string" }, token: { type: "string", secret: true } },
  };
  const mk = () => writePlugin("demo", { ...good, configSchema: schema }, okEntry);

  async function roundTrip(makeStore: () => import("../src/index.ts").PluginStateStore) {
    const p = mk();
    const l1 = new PluginLoader({ stateStore: makeStore() });
    await l1.load(p);
    await l1.enable("demo", { mode: "fast", token: "s3cret" });

    const l2 = new PluginLoader({ stateStore: makeStore() });
    await l2.restore();
    const s = l2.registry.get("demo");
    expect(s?.state).toBe("enabled");
    expect(s?.config).toEqual({ mode: "fast" }); // secret not persisted

    await l2.unload("demo");
    const l3 = new PluginLoader({ stateStore: makeStore() });
    expect(await l3.restore()).toEqual([]);
  }

  it("sqlite store", async () => {
    const db = new Database(":memory:");
    await roundTrip(() => new SqlitePluginStateStore(db));
  });

  it("file store", async () => {
    const file = join(dir, "state.json");
    await roundTrip(() => new FilePluginStateStore(file));
  });

  it("restored plugin with removed source is failed, not thrown", async () => {
    const store = new FilePluginStateStore(join(dir, "s.json"));
    await store.save({ id: "ghost", source: join(dir, "missing"), state: "enabled", updatedAt: "t" });
    const loader = new PluginLoader({ stateStore: store });
    const list = await loader.restore();
    expect(list[0]?.state).toBe("failed");
  });
});

describe("builtin adapters", () => {
  it("registers built-ins and activates a working driver", async () => {
    const loader = new PluginLoader();
    await registerBuiltinPlugins(loader);
    const ids = (await loader.list()).map((s) => s.manifest.id);
    expect(ids).toContain("worker-mock");
    expect(ids).toContain("worker-claude-code");
    await loader.enable("worker-mock");
    const driver = loader.getInstance<MockWorkerDriver>("worker-mock");
    expect(driver?.engine).toBe("mock");
    expect(await driver?.isAvailable()).toBe(true);
    // idempotent re-registration does not throw
    await registerBuiltinPlugins(loader);
  });

  it("direct construction remains supported", () => {
    expect(new MockWorkerDriver().engine).toBe("mock");
  });
});
