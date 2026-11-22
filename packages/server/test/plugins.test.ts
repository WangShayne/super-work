import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { PluginManifest, PluginStatus } from "@super-work/core";
import { InMemoryPluginRegistry, RegistryBackedPluginLoader } from "../src/in-memory-plugins.ts";
import { registerPluginRoutes, validateConfig } from "../src/plugin-routes.ts";

const TS = "2026-01-01T00:00:00.000Z";

const driverManifest: PluginManifest = {
  id: "demo-driver",
  name: "Demo Driver",
  version: "1.0.0",
  kind: "driver",
  capabilities: ["run_turn"],
  configSchema: {
    type: "object",
    properties: {
      apiKey: { type: "string", secret: true },
      retries: { type: "number" },
      mode: { type: "string", enum: ["fast", "safe"] },
      verbose: { type: "boolean" },
    },
    required: ["apiKey"],
  },
};

const toolManifest: PluginManifest = {
  id: "demo-tool",
  name: "Demo Tool",
  version: "0.1.0",
  kind: "tool",
  capabilities: [],
};

function setup(initial: PluginStatus[] = []) {
  const registry = new InMemoryPluginRegistry();
  for (const s of initial) registry.register(s);
  const loader = new RegistryBackedPluginLoader(registry);
  const app = new Hono();
  registerPluginRoutes(app, { registry, loader });
  return { app, registry, loader };
}

const seed = (): PluginStatus[] => [
  { manifest: driverManifest, state: "loaded", updatedAt: TS },
  { manifest: toolManifest, state: "disabled", updatedAt: TS },
];

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describe("plugin management API", () => {
  it("lists plugins and filters by kind/state", async () => {
    const { app } = setup(seed());

    const all = (await (await app.request("/api/plugins")).json()) as { plugins: PluginStatus[] };
    expect(all.plugins.map((p) => p.manifest.id).sort()).toEqual(["demo-driver", "demo-tool"]);

    const byKind = (await (await app.request("/api/plugins?kind=tool")).json()) as {
      plugins: PluginStatus[];
    };
    expect(byKind.plugins.map((p) => p.manifest.id)).toEqual(["demo-tool"]);

    const byState = (await (await app.request("/api/plugins?state=loaded")).json()) as {
      plugins: PluginStatus[];
    };
    expect(byState.plugins.map((p) => p.manifest.id)).toEqual(["demo-driver"]);
  });

  it("rejects invalid list filters with 400", async () => {
    const { app } = setup(seed());
    expect((await app.request("/api/plugins?kind=bogus")).status).toBe(400);
    expect((await app.request("/api/plugins?state=bogus")).status).toBe(400);
  });

  it("returns plugin detail or 404 for unknown id", async () => {
    const { app } = setup(seed());
    const ok = await app.request("/api/plugins/demo-driver");
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { plugin: PluginStatus };
    expect(body.plugin.manifest.id).toBe("demo-driver");
    expect(body.plugin.state).toBe("loaded");

    const missing = await app.request("/api/plugins/nope");
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toContain("nope");
  });

  it("enables with config, then disables", async () => {
    const { app } = setup(seed());

    const enable = await app.request(
      "/api/plugins/demo-driver/enable",
      json("POST", { config: { apiKey: "sk-secret", retries: 3, mode: "fast" } }),
    );
    expect(enable.status).toBe(200);
    const enabled = ((await enable.json()) as { plugin: PluginStatus }).plugin;
    expect(enabled.state).toBe("enabled");
    expect(enabled.config?.retries).toBe(3);

    const disable = await app.request("/api/plugins/demo-driver/disable", json("POST"));
    expect(disable.status).toBe(200);
    expect(((await disable.json()) as { plugin: PluginStatus }).plugin.state).toBe("disabled");
  });

  it("enables without a body when no config is needed", async () => {
    const { app } = setup(seed());
    const res = await app.request("/api/plugins/demo-tool/enable", { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { plugin: PluginStatus }).plugin.state).toBe("enabled");
  });

  it("returns 404 for unknown ids on enable/disable/config", async () => {
    const { app } = setup(seed());
    expect((await app.request("/api/plugins/nope/enable", json("POST", {}))).status).toBe(404);
    expect((await app.request("/api/plugins/nope/disable", json("POST"))).status).toBe(404);
    expect(
      (await app.request("/api/plugins/nope/config", json("PUT", { config: {} }))).status,
    ).toBe(404);
  });

  it("rejects malformed JSON and non-object bodies with 400", async () => {
    const { app } = setup(seed());
    const bad = await app.request("/api/plugins/demo-driver/enable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(bad.status).toBe(400);

    const arr = await app.request("/api/plugins/demo-driver/enable", json("POST", [1]));
    expect(arr.status).toBe(400);

    const missing = await app.request("/api/plugins/demo-driver/config", { method: "PUT" });
    expect(missing.status).toBe(400);
  });

  it("rejects invalid config with 400 and details", async () => {
    const { app } = setup(seed());
    const cases: unknown[] = [
      "str",
      null,
      { apiKey: "k", unknown: 1 },
      { apiKey: 123 },
      { retries: 1 },
      { apiKey: "k", mode: "reckless" },
    ];
    for (const config of cases) {
      const res = await app.request(
        "/api/plugins/demo-driver/enable",
        json("POST", { config }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; details: string[] };
      expect(body.error).toBe("invalid config");
      expect(body.details.length).toBeGreaterThan(0);
    }
  });

  it("rejects non-empty config for a plugin without configSchema", async () => {
    const { app } = setup(seed());
    const res = await app.request("/api/plugins/demo-tool/enable", json("POST", { config: { a: 1 } }));
    expect(res.status).toBe(400);
  });

  it("updates config for enabled plugins and 409s otherwise", async () => {
    const { app } = setup(seed());

    const notEnabled = await app.request(
      "/api/plugins/demo-driver/config",
      json("PUT", { config: { apiKey: "k" } }),
    );
    expect(notEnabled.status).toBe(409);

    await app.request("/api/plugins/demo-driver/enable", json("POST", { config: { apiKey: "k" } }));
    const updated = await app.request(
      "/api/plugins/demo-driver/config",
      json("PUT", { config: { apiKey: "k2", verbose: true } }),
    );
    expect(updated.status).toBe(200);
    const plugin = ((await updated.json()) as { plugin: PluginStatus }).plugin;
    expect(plugin.state).toBe("enabled");
    expect(plugin.config?.verbose).toBe(true);

    const invalid = await app.request(
      "/api/plugins/demo-driver/config",
      json("PUT", { config: { verbose: "yes", apiKey: "k" } }),
    );
    expect(invalid.status).toBe(400);
    const missingConfig = await app.request("/api/plugins/demo-driver/config", json("PUT", {}));
    expect(missingConfig.status).toBe(400);
  });

  it("redacts secret config values in all responses", async () => {
    const { app } = setup(seed());
    const enable = await app.request(
      "/api/plugins/demo-driver/enable",
      json("POST", { config: { apiKey: "sk-secret", retries: 2 } }),
    );
    const enabled = ((await enable.json()) as { plugin: PluginStatus }).plugin;
    expect(enabled.config?.apiKey).toBe("****");
    expect(enabled.config?.retries).toBe(2);

    const detail = await (await app.request("/api/plugins/demo-driver")).text();
    const list = await (await app.request("/api/plugins")).text();
    expect(detail).not.toContain("sk-secret");
    expect(list).not.toContain("sk-secret");
  });

  it("maps loader failures to 409 without throwing", async () => {
    const { app, loader } = setup(seed());
    loader.enable = async () => {
      throw new Error("plugin is broken");
    };
    const res = await app.request("/api/plugins/demo-tool/enable", { method: "POST" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("plugin is broken");
  });

  it("does not expose plugin routes when deps are not injected", async () => {
    const { createServerApp } = await import("../src/app.ts");
    const app = createServerApp({} as Parameters<typeof createServerApp>[0]);
    expect((await app.request("/api/plugins")).status).toBe(404);
  });
});

describe("validateConfig", () => {
  const schema = driverManifest.configSchema;

  it("accepts a valid config", () => {
    expect(validateConfig(schema, { apiKey: "k", retries: 1, mode: "safe", verbose: false })).toEqual(
      [],
    );
  });

  it("reports each violation", () => {
    const errors = validateConfig(schema, { retries: "x", extra: 1, mode: "nope" });
    expect(errors).toContain("unknown config key: extra");
    expect(errors).toContain("config.retries must be of type number");
    expect(errors.some((e) => e.startsWith("config.mode must be one of"))).toBe(true);
    expect(errors).toContain("missing required config key: apiKey");
  });

  it("rejects non-objects and prototype keys", () => {
    expect(validateConfig(schema, [])).toEqual(["config must be a JSON object"]);
    expect(validateConfig(undefined, { a: 1 })).toEqual(["unknown config key: a"]);
    expect(validateConfig(schema, { apiKey: "k", constructor: 1 })).toContain(
      "unknown config key: constructor",
    );
  });

  it("accepts empty config when there is no schema", () => {
    expect(validateConfig(undefined, {})).toEqual([]);
  });
});
