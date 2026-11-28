import { describe, expect, it } from "bun:test";
import { buildModelDiscoveryUrls, discoverModelsFromEndpoint, parseDiscoveredModels } from "../src/index.ts";

const KEY = "sk-live-SECRET-9999";

type Route = { status?: number; body?: unknown; text?: string };

/** Stub fetch: maps exact URL -> response; unknown URLs are 404. Records calls + headers. */
function stub(routes: Record<string, Route>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const r = routes[url];
    if (!r) return new Response("not found", { status: 404 });
    return new Response(r.text ?? JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("v1.8.2 buildModelDiscoveryUrls", () => {
  it("openai-style order, dedupes /v1 and strips /chat/completions", () => {
    expect(buildModelDiscoveryUrls("https://x.test/")).toEqual([
      "https://x.test/models",
      "https://x.test/v1/models",
      "https://x.test/model",
      "https://x.test/v1/model",
    ]);
    expect(buildModelDiscoveryUrls("https://x.test/v1/chat/completions")).toEqual([
      "https://x.test/v1/models",
      "https://x.test/v1/model",
    ]);
  });

  it("anthropic tries /v1/models first; messages suffix stripped", () => {
    expect(buildModelDiscoveryUrls("https://a.test/messages", "anthropic")[0]).toBe("https://a.test/v1/models");
    expect(buildModelDiscoveryUrls("https://a.test", undefined, "claude")).toEqual([
      "https://a.test/v1/models",
      "https://a.test/models",
      "https://a.test/v1/model",
      "https://a.test/model",
    ]);
    expect(buildModelDiscoveryUrls("https://a.test/v1", "anthropic")).toEqual(["https://a.test/v1/models", "https://a.test/v1/model"]);
  });

  it("ollama / localhost append native /api/tags", () => {
    expect(buildModelDiscoveryUrls("http://localhost:11434/v1", "ollama").at(-1)).toBe("http://localhost:11434/api/tags");
    expect(buildModelDiscoveryUrls("http://127.0.0.1:8000").at(-1)).toBe("http://127.0.0.1:8000/api/tags");
    expect(buildModelDiscoveryUrls("https://x.test").some((u) => u.endsWith("/api/tags"))).toBe(false);
  });
});

describe("v1.8.2 parseDiscoveredModels", () => {
  it("handles data / models / model_list / arrays / single objects", () => {
    expect(parseDiscoveredModels({ data: [{ id: "gpt-4o", owned_by: "openai" }] })).toEqual([{ id: "gpt-4o", ownedBy: "openai" }]);
    expect(parseDiscoveredModels({ models: [{ name: "llama3:8b", model: "llama3:8b" }] })[0]?.id).toBe("llama3:8b");
    expect(parseDiscoveredModels({ model_list: [{ model_name: "gw-a" }, { id: "gw-b" }] }).map((m) => m.id)).toEqual(["gw-a", "gw-b"]);
    expect(parseDiscoveredModels([" a ", "b", ""]).map((m) => m.id)).toEqual(["a", "b"]);
    expect(parseDiscoveredModels({ id: "vllm-model" })).toEqual([{ id: "vllm-model" }]);
    expect(parseDiscoveredModels({ model: "tgi-model" })).toEqual([{ id: "tgi-model" }]);
  });

  it("strips models/ prefix only when id came from name, adds label, dedupes, caps at 500", () => {
    expect(parseDiscoveredModels({ models: [{ name: "models/gemini-2.5-pro", display_name: "Gemini 2.5 Pro" }] })).toEqual([
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    ]);
    expect(parseDiscoveredModels({ data: [{ id: "x", name: "models/x" }] })).toEqual([{ id: "x", label: "models/x" }]);
    expect(parseDiscoveredModels({ data: [{ id: "a" }, { id: "a" }, null, 7] })).toHaveLength(1);
    const many = Array.from({ length: 700 }, (_, i) => ({ id: `m${i}` }));
    expect(parseDiscoveredModels({ data: many })).toHaveLength(500);
    expect(parseDiscoveredModels("nope")).toEqual([]);
  });
});

describe("v1.8.2 discoverModelsFromEndpoint", () => {
  it("falls back /models 404 -> /model 200", async () => {
    const { fetchImpl, calls } = stub({ "https://gw.test/model": { body: { model_list: [{ model_name: "m1" }] } } });
    const res = await discoverModelsFromEndpoint({ kind: "api", protocol: "openai", baseUrl: "https://gw.test", apiKey: KEY, fetchImpl });
    expect(res.ok).toBe(true);
    expect(res.endpoint).toBe("https://gw.test/model");
    expect(res.models.map((m) => m.id)).toEqual(["m1"]);
    expect(calls.map((c) => c.url).slice(0, 3)).toEqual(["https://gw.test/models", "https://gw.test/v1/models", "https://gw.test/model"]);
  });

  it("anthropic hits /v1/models first with x-api-key + anthropic-version + Bearer", async () => {
    const { fetchImpl, calls } = stub({ "https://api.anthropic.com/v1/models": { body: { data: [{ id: "claude-sonnet-4-5" }] } } });
    const res = await discoverModelsFromEndpoint({ kind: "api", protocol: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: KEY, fetchImpl });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers["x-api-key"]).toBe(KEY);
    expect(calls[0]?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it("gemini cli sends x-goog-api-key", async () => {
    const { fetchImpl, calls } = stub({ "https://g.test/models": { body: { models: [{ name: "models/gemini-2.5-pro" }] } } });
    const res = await discoverModelsFromEndpoint({ kind: "cli", cliEngine: "gemini", baseUrl: "https://g.test", apiKey: KEY, fetchImpl });
    expect(res.models[0]?.id).toBe("gemini-2.5-pro");
    expect(calls[0]?.headers["x-goog-api-key"]).toBe(KEY);
  });

  it("ollama native /api/tags fallback, keyless", async () => {
    const { fetchImpl, calls } = stub({ "http://localhost:11434/api/tags": { body: { models: [{ name: "qwen2.5-coder" }] } } });
    const res = await discoverModelsFromEndpoint({ kind: "api", protocol: "ollama", baseUrl: "http://localhost:11434/v1", fetchImpl });
    expect(res.ok).toBe(true);
    expect(res.models.map((m) => m.id)).toEqual(["qwen2.5-coder"]);
    expect(calls[0]?.headers.Authorization).toBeUndefined();
  });

  it("keyless localhost works without apiKey", async () => {
    const { fetchImpl } = stub({ "http://127.0.0.1:8000/v1/models": { body: { data: [{ id: "local" }] } } });
    const res = await discoverModelsFromEndpoint({ kind: "cli", cliEngine: "codex", baseUrl: "http://127.0.0.1:8000/v1", fetchImpl });
    expect(res.ok).toBe(true);
  });

  it("stops immediately on 401 and never leaks the key", async () => {
    const { fetchImpl, calls } = stub({ "https://gw.test/models": { status: 401, text: `bad key ${KEY}` } });
    const res = await discoverModelsFromEndpoint({ kind: "api", protocol: "openai", baseUrl: "https://gw.test", apiKey: KEY, fetchImpl });
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(res.message).toContain("401");
    expect(JSON.stringify(res)).not.toContain(KEY);
  });

  it("html 200 falls through; empty valid list is ok; remote without key fails without network", async () => {
    const html = stub({ "https://gw.test/models": { text: "<html></html>" }, "https://gw.test/v1/models": { body: { data: [] } } });
    const res = await discoverModelsFromEndpoint({ kind: "api", baseUrl: "https://gw.test", apiKey: KEY, fetchImpl: html.fetchImpl });
    expect(res.ok).toBe(true);
    expect(res.models).toEqual([]);
    expect(res.endpoint).toBe("https://gw.test/v1/models");

    const none = stub({});
    const noKey = await discoverModelsFromEndpoint({ kind: "api", baseUrl: "https://gw.test", fetchImpl: none.fetchImpl });
    expect(noKey.ok).toBe(false);
    expect(none.calls).toHaveLength(0);
  });

  it("rejects non-http schemes / missing cli baseUrl, defaults api baseUrl, and never throws", async () => {
    const { fetchImpl, calls } = stub({ "https://api.openai.com/v1/models": { body: { data: [{ id: "gpt-4.1" }] } } });
    expect((await discoverModelsFromEndpoint({ kind: "api", baseUrl: "ftp://x.test", apiKey: KEY, fetchImpl })).ok).toBe(false);
    expect((await discoverModelsFromEndpoint({ kind: "cli", cliEngine: "claude", fetchImpl })).message).toContain("baseUrl");
    const def = await discoverModelsFromEndpoint({ kind: "api", protocol: "openai", apiKey: KEY, fetchImpl });
    expect(def.ok).toBe(true);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/models");
    const boom = (async () => {
      throw new Error(`connect failed with ${KEY}`);
    }) as unknown as typeof fetch;
    const res = await discoverModelsFromEndpoint({ kind: "api", baseUrl: "https://gw.test", apiKey: KEY, fetchImpl: boom });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain(KEY);
  });
});
