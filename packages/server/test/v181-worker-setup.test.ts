import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  type EngineHealthRecord,
  type OutboxExecutor,
  type SystemSetupConfig,
  type WorkerEngineId,
  SuperWorkKernel,
  nowIso,
} from "@super-work/core";
import {
  CliEnvironmentScanner,
  FsArtifactStore,
  GitWorktreeProvider,
  HeuristicControlLLM,
  MockWorkerDriver,
  MutableControlPlaneLLM,
  SqliteStateStore,
} from "@super-work/drivers";
import { createServerApp } from "../src/app.ts";

describe("v1.8.1 worker setup: api worker profile, CLI relay, test-worker", () => {
  const tempDirs: string[] = [];
  const servers: Array<{ stop: (force?: boolean) => void }> = [];

  afterEach(async () => {
    for (const s of servers.splice(0)) s.stop(true);
    for (const d of tempDirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function boot() {
    const dir = await mkdtemp(join(tmpdir(), "sw-v181-setup-"));
    tempDirs.push(dir);
    const stateStore = new SqliteStateStore(join(dir, "state.db"));
    const artifactStore = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));
    const mutableLlm = new MutableControlPlaneLLM(new HeuristicControlLLM());
    const outboxExecutor: OutboxExecutor = { async execute() { return { mode: "local_branch_ready" }; } };
    const kernel = new SuperWorkKernel({
      stateStore,
      artifactStore,
      workspace,
      llm: mutableLlm,
      drivers: [new MockWorkerDriver({ engine: "claude", stepDelayMs: 1 })],
      outboxExecutor,
    });
    const cliScanner = new CliEnvironmentScanner({
      which: () => null,
      runCmd: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    const app = createServerApp({ kernel, stateStore, artifactStore, mutableLlm, cliScanner });
    const post = (path: string, body: unknown) =>
      app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { app, stateStore, post };
  }

  const trip = (engine: WorkerEngineId): EngineHealthRecord => ({
    engine,
    status: "tripped",
    failureKind: "auth_invalid",
    reason: "401 invalid api key",
    trippedAt: nowIso(),
    cooldownUntil: new Date(Date.now() + 24 * 3600_000).toISOString(),
    consecutiveFailures: 3,
    updatedAt: nowIso(),
  });

  it("persists api/CLI profiles, never returns raw keys, and preserves/clears saved keys", async () => {
    const { app, stateStore, post } = await boot();
    const API_KEY = "sk-api-worker-SECRET-1234";
    const CLAUDE_KEY = "sk-ant-relay-SECRET-5678";
    const LLM_KEY = "sk-llm-SECRET-9999";

    const res = await post("/api/setup/configure", {
      llmPreset: "deepseek",
      llmBaseUrl: "https://api.deepseek.com/v1",
      llmModel: "deepseek-chat",
      llmApiKey: LLM_KEY,
      preferredImplementEngine: "api",
      preferredReviewEngine: "claude",
      apiWorkerProfile: { preset: "openai", baseUrl: "https://relay.example.com/v1/", model: "gpt-x", apiKey: API_KEY, effort: "high" },
      claudeProfile: { model: "opus", baseUrl: "https://claude-relay.example.com", apiKey: CLAUDE_KEY },
      codexProfile: { model: "gpt-5", baseUrl: "https://codex-relay.example.com/v1" },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const secret of [API_KEY, CLAUDE_KEY, LLM_KEY]) expect(text).not.toContain(secret);
    const configured = JSON.parse(text) as any;
    expect(configured.config.apiWorkerProfile).toMatchObject({
      preset: "openai",
      baseUrl: "https://relay.example.com/v1",
      model: "gpt-x",
      effort: "high",
      hasApiKey: true,
    });
    expect(configured.config.apiWorkerProfile.apiKey).toBeUndefined();
    expect(configured.config.apiWorkerProfile.maskedApiKey).toMatch(/^sk-\*{4}1234$/);
    expect(configured.config.claudeProfile).toMatchObject({ baseUrl: "https://claude-relay.example.com", hasApiKey: true });
    expect(configured.config.claudeProfile.apiKey).toBeUndefined();
    expect(configured.config.codexProfile).toMatchObject({ hasApiKey: false });
    expect(configured.config.codexProfile.maskedApiKey).toBeUndefined();

    // Raw keys are persisted server-side (needed to run turns) but never exposed by GET /status
    const saved = (await stateStore.getSystemSetting<SystemSetupConfig>("setup_config"))!;
    expect(saved.apiWorkerProfile?.apiKey).toBe(API_KEY);
    expect(saved.claudeProfile?.apiKey).toBe(CLAUDE_KEY);
    const statusText = await (await app.request("/api/setup/status")).text();
    for (const secret of [API_KEY, CLAUDE_KEY, LLM_KEY]) expect(statusText).not.toContain(secret);
    expect(JSON.parse(statusText).config.apiWorkerProfile.hasApiKey).toBe(true);

    // Omitting apiKey preserves the saved one; other fields update
    await post("/api/setup/configure", { apiWorkerProfile: { preset: "openai", baseUrl: "https://relay.example.com/v1", model: "gpt-y" } });
    const kept = (await stateStore.getSystemSetting<SystemSetupConfig>("setup_config"))!;
    expect(kept.apiWorkerProfile).toMatchObject({ model: "gpt-y", apiKey: API_KEY });
    expect(kept.claudeProfile?.apiKey).toBe(CLAUDE_KEY); // untouched profile untouched

    // CLI profile resent without key keeps it; clearApiKey removes it
    await post("/api/setup/configure", { claudeProfile: { model: "opus", baseUrl: "https://claude-relay.example.com" } });
    expect((await stateStore.getSystemSetting<SystemSetupConfig>("setup_config"))!.claudeProfile?.apiKey).toBe(CLAUDE_KEY);
    await post("/api/setup/configure", {
      claudeProfile: { model: "opus", clearApiKey: true },
      apiWorkerProfile: { preset: "openai", clearApiKey: true },
    });
    const cleared = (await stateStore.getSystemSetting<SystemSetupConfig>("setup_config"))!;
    expect(cleared.claudeProfile?.apiKey).toBeUndefined();
    expect(cleared.claudeProfile?.baseUrl).toBeUndefined();
    expect(cleared.apiWorkerProfile?.apiKey).toBeUndefined();

    // Preferred engines were synced and "api" is accepted as an engine id
    expect(cleared.preferredImplementEngine).toBe("api");
  });

  it("syncRepos:false preserves repo preferred engines (auto); default still syncs", async () => {
    const { stateStore, post } = await boot();
    const ts = nowIso();
    await stateStore.upsertRepo({
      id: "repo_sync",
      name: "sync-app",
      rootPath: "/tmp/sync-app",
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "fast",
      preferredImplementEngine: "auto",
      preferredReviewEngine: "codex",
      autoCleanupWorktree: true,
      defaultDeliveryChannel: "local_merge",
      createdAt: ts,
      updatedAt: ts,
    } as any);
    const repoOf = async () => (await stateStore.listRepos()).find((r) => r.id === "repo_sync")!;

    const kept = await post("/api/setup/configure", {
      preferredImplementEngine: "api",
      preferredReviewEngine: "claude",
      apiWorkerProfile: { preset: "openai", model: "gpt-x", apiKey: "k" },
      syncRepos: false,
    });
    expect(kept.status).toBe(200);
    expect((await repoOf()).preferredImplementEngine).toBe("auto");
    expect((await repoOf()).preferredReviewEngine).toBe("codex");

    // Default behavior unchanged: omitted syncRepos still syncs
    await post("/api/setup/configure", { preferredImplementEngine: "api", preferredReviewEngine: "claude" });
    expect((await repoOf()).preferredImplementEngine).toBe("api");
    expect((await repoOf()).preferredReviewEngine).toBe("claude");
  });

  it("applies preset base URL defaults and rejects malformed endpoints", async () => {
    const { stateStore, post } = await boot();
    const res = await post("/api/setup/configure", { apiWorkerProfile: { preset: "deepseek", model: "deepseek-chat", apiKey: "k" } });
    expect(res.status).toBe(200);
    expect((await stateStore.getSystemSetting<SystemSetupConfig>("setup_config"))!.apiWorkerProfile?.baseUrl).toBe(
      "https://api.deepseek.com/v1",
    );

    const bad = await post("/api/setup/configure", { geminiProfile: { baseUrl: "ftp://nope" } });
    expect(bad.status).toBe(400);
    const badPreset = await post("/api/setup/configure", { apiWorkerProfile: { preset: "nope" } });
    expect(badPreset.status).toBe(400);
    // Rejected requests must not have been half-saved
    expect((await stateStore.getSystemSetting<SystemSetupConfig>("setup_config"))!.geminiProfile?.baseUrl).toBeUndefined();
  });

  it("clears a tripped circuit breaker only for engines whose profile was updated", async () => {
    const { app, stateStore, post } = await boot();
    for (const e of ["api", "claude", "codex", "gemini"] as const) await stateStore.saveEngineHealth!(trip(e));

    const res = await post("/api/setup/configure", {
      apiWorkerProfile: { preset: "custom", baseUrl: "http://localhost:11434/v1", model: "llama" },
      claudeProfile: { model: "opus", apiKey: "new-claude-key" },
    });
    expect(res.status).toBe(200);

    const health = async (e: WorkerEngineId) => (await stateStore.getEngineHealth!(e))!;
    expect((await health("api")).status).toBe("healthy");
    expect((await health("api")).consecutiveFailures).toBe(0);
    expect((await health("claude")).status).toBe("healthy");
    expect((await health("codex")).status).toBe("tripped");
    expect((await health("gemini")).status).toBe("tripped");

    // A configure call without any worker profile leaves breakers alone
    await post("/api/setup/configure", { llmModel: "other" });
    expect((await health("codex")).status).toBe("tripped");

    const engines = (await (await app.request("/api/system/engines")).json()) as { engines: EngineHealthRecord[] };
    expect(engines.engines.find((e) => e.engine === "api")?.status).toBe("healthy");
  });

  it("POST /api/setup/test-worker tests api presets, saved keys and validates input", async () => {
    const seen: Array<{ path: string; auth: string | null; xKey: string | null; body: any }> = [];
    const mock = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        seen.push({ path: url.pathname, auth: req.headers.get("authorization"), xKey: req.headers.get("x-api-key"), body: await req.json().catch(() => ({})) });
        if (req.headers.get("authorization") === "Bearer wrong") return Response.json({ error: "denied" }, { status: 401 });
        return url.pathname.endsWith("/messages")
          ? Response.json({ content: [{ type: "text", text: "pong" }], usage: { input_tokens: 1, output_tokens: 1 } })
          : Response.json({ choices: [{ message: { role: "assistant", content: "pong" } }] });
      },
    });
    servers.push(mock);
    const baseUrl = `http://127.0.0.1:${mock.port}`;
    const { post } = await boot();

    const ok = (await (await post("/api/setup/test-worker", { engine: "api", preset: "openai", baseUrl: `${baseUrl}/v1`, model: "m", apiKey: "good" })).json()) as any;
    expect(ok.ok).toBe(true);
    expect(typeof ok.latencyMs).toBe("number");
    expect(typeof ok.message).toBe("string");
    expect(seen[0]).toMatchObject({ path: "/v1/chat/completions", auth: "Bearer good" });
    expect(seen[0]!.body.max_tokens).toBe(16);

    const anthropic = (await (await post("/api/setup/test-worker", { engine: "api", preset: "anthropic", baseUrl, model: "m", apiKey: "ant" })).json()) as any;
    expect(anthropic.ok).toBe(true);
    expect(seen[1]).toMatchObject({ path: "/v1/messages", xKey: "ant" });

    const denied = (await (await post("/api/setup/test-worker", { engine: "api", preset: "custom", baseUrl, model: "m", apiKey: "wrong" })).json()) as any;
    expect(denied.ok).toBe(false);
    expect(denied.message).toContain("401");
    expect(denied.message).not.toContain("wrong");

    // useSavedKey: fields and key come from the saved profile when omitted from the request
    await post("/api/setup/configure", { apiWorkerProfile: { preset: "openai", baseUrl, model: "saved-model", apiKey: "saved-key" } });
    const savedRes = (await (await post("/api/setup/test-worker", { engine: "api", useSavedKey: true })).json()) as any;
    expect(savedRes.ok).toBe(true);
    expect(seen.at(-1)).toMatchObject({ path: "/chat/completions", auth: "Bearer saved-key" });
    expect(seen.at(-1)!.body.model).toBe("saved-model");
    const noSaved = (await (await post("/api/setup/test-worker", { engine: "api", preset: "openai", baseUrl: "https://example.com/v1", model: "m" })).json()) as any;
    expect(noSaved.ok).toBe(false); // no key, not localhost: never silently uses the saved key

    // CLI engine: invalid relay URL fails whether or not the binary exists on this machine
    const cli = (await (await post("/api/setup/test-worker", { engine: "claude", baseUrl: "not-a-url" })).json()) as any;
    expect(cli.ok).toBe(false);
    expect(typeof cli.message).toBe("string");

    expect((await post("/api/setup/test-worker", { engine: "mock" })).status).toBe(400);
    expect((await post("/api/setup/test-worker", {})).status).toBe(400);
    expect((await post("/api/setup/test-worker", { engine: "api", preset: "bogus" })).status).toBe(400);
  });
});
