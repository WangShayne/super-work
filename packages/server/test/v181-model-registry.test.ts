import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { type OutboxExecutor, type SystemSetupConfig, SuperWorkKernel, nowIso } from "@super-work/core";
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

const DS_KEY = "sk-deepseek-V3-SECRET-1111";
const R1_KEY = "sk-deepseek-R1-SECRET-2222";
const ANTH_KEY = "sk-ant-SECRET-3333";

describe("v1.8.1 unified model registry: setup, test-model, role bindings, ticket pinning", () => {
  const tempDirs: string[] = [];
  const servers: Array<{ stop: (force?: boolean) => void }> = [];

  const booted: Array<{ kernel: SuperWorkKernel; stateStore: SqliteStateStore }> = [];

  afterEach(async () => {
    for (const s of servers.splice(0)) s.stop(true);
    // Background `void kernel.tick()` runs may still be in flight: cancel, settle, close before rm.
    for (const { kernel, stateStore } of booted.splice(0)) {
      for (const t of await stateStore.listTickets().catch(() => [])) {
        if (!["delivered", "cancelled", "failed", "reverted"].includes(t.status)) {
          await kernel.cancelTicket(t.id).catch(() => {});
        }
      }
      await new Promise((r) => setTimeout(r, 50));
      try {
        stateStore.close();
      } catch {
        // already closed
      }
    }
    for (const d of tempDirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function boot() {
    const dir = await mkdtemp(join(tmpdir(), "sw-v181-models-"));
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
    booted.push({ kernel, stateStore });
    const send = (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const ts = nowIso();
    await stateStore.upsertRepo({
      id: "repo_1", name: "demo", rootPath: dir, baseBranch: "main", mode: "observe", defaultTemplate: "standard",
      preferredImplementEngine: "mock", preferredReviewEngine: "mock", createdAt: ts, updatedAt: ts,
    });
    const saved = () => stateStore.getSystemSetting<SystemSetupConfig>("setup_config");
    return { app, stateStore, mutableLlm, send, post: (p: string, b: unknown) => send("POST", p, b), saved, dir };
  }

  const peers = () => [
    { id: "ds_v3", name: "DeepSeek-V3", kind: "api", apiProtocol: "deepseek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", apiKey: DS_KEY, workerAutoPool: false },
    { id: "ds_r1", name: "DeepSeek-R1", kind: "api", apiProtocol: "deepseek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-reasoner", apiKey: R1_KEY },
    { id: "anth", name: "Claude API", kind: "api", apiProtocol: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-x", apiKey: ANTH_KEY },
    { id: "local", name: "Ollama", kind: "api", apiProtocol: "ollama", baseUrl: "http://localhost:11434/v1", model: "llama3.1" },
  ];

  it("saves peer API + CLI profiles with role bindings, hot-swaps the control LLM and never leaks keys", async () => {
    const { post, send, saved, stateStore, mutableLlm } = await boot();
    const res = await post("/api/setup/configure", {
      modelProfiles: [...peers(), { id: "cli_claude", model: "opus", workerAutoPool: true }],
      controlModelId: "ds_v3",
      implementModelId: "cli_claude",
      reviewModelId: "ds_r1",
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const secret of [DS_KEY, R1_KEY, ANTH_KEY]) expect(text).not.toContain(secret);
    const body = JSON.parse(text) as any;
    const cfg = body.config;
    expect(cfg.controlModelId).toBe("ds_v3");
    expect(cfg.implementModelId).toBe("cli_claude");
    expect(cfg.reviewModelId).toBe("ds_r1");
    const ids = cfg.modelProfiles.map((p: any) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["cli_claude", "cli_codex", "cli_opencode", "cli_gemini", "ds_v3", "ds_r1", "anth", "local"]));
    const v3 = cfg.modelProfiles.find((p: any) => p.id === "ds_v3");
    expect(v3).toMatchObject({ kind: "api", apiProtocol: "deepseek", hasApiKey: true, maskedApiKey: "sk-****1111", ready: true, workerAutoPool: false });
    expect(v3).not.toHaveProperty("apiKey");
    expect(cfg.modelProfiles.find((p: any) => p.id === "local")).toMatchObject({ hasApiKey: false, ready: true });
    // scanner reports nothing installed => CLI profiles are not ready
    expect(cfg.modelProfiles.find((p: any) => p.id === "cli_claude")).toMatchObject({ builtinCli: true, ready: false, readyDetail: "CLI not installed", model: "opus" });
    expect(body.activeLlmProvider).toBe("deepseek:deepseek-chat");
    expect(mutableLlm.providerName).toBe("deepseek:deepseek-chat");

    // raw keys stay server-side
    expect((await saved())!.modelProfiles!.find((p) => p.id === "ds_v3")!.apiKey).toBe(DS_KEY);
    const status = await (await send("GET", "/api/setup/status")).text();
    for (const secret of [DS_KEY, R1_KEY, ANTH_KEY]) expect(status).not.toContain(secret);
    expect(JSON.parse(status).config.modelProfiles).toHaveLength(8);

    // switching the control model back to the heuristic planner hot-swaps again
    const back = await post("/api/setup/configure", { controlModelId: "heuristic" });
    expect(back.status).toBe(200);
    expect(mutableLlm.providerName).toBe("heuristic:local");
    expect((await stateStore.getSystemSetting<SystemSetupConfig>("setup_config"))!.modelProfiles).toHaveLength(8);
  });

  it("preserves saved keys by profile id, and clears them with clearApiKey", async () => {
    const { post, saved } = await boot();
    await post("/api/setup/configure", { modelProfiles: peers() });
    const edit = await post("/api/setup/configure", { modelProfiles: [{ id: "ds_v3", model: "deepseek-chat-2" }] });
    expect(edit.status).toBe(200);
    let v3 = (await saved())!.modelProfiles!.find((p) => p.id === "ds_v3")!;
    expect(v3).toMatchObject({ model: "deepseek-chat-2", apiKey: DS_KEY, apiProtocol: "deepseek", workerAutoPool: false });
    // blank string keeps the key; a new key replaces it
    await post("/api/setup/configure", { modelProfiles: [{ id: "ds_v3", apiKey: "  " }] });
    expect((await saved())!.modelProfiles!.find((p) => p.id === "ds_v3")!.apiKey).toBe(DS_KEY);
    await post("/api/setup/configure", { modelProfiles: [{ id: "ds_v3", apiKey: "sk-new-KEY-7777" }] });
    expect((await saved())!.modelProfiles!.find((p) => p.id === "ds_v3")!.apiKey).toBe("sk-new-KEY-7777");

    const clearRes = await post("/api/setup/configure", { modelProfiles: [{ id: "ds_v3", clearApiKey: true }] });
    const clearText = await clearRes.text();
    v3 = (await saved())!.modelProfiles!.find((p) => p.id === "ds_v3")!;
    expect(v3.apiKey).toBeUndefined();
    const pub = JSON.parse(clearText).config.modelProfiles.find((p: any) => p.id === "ds_v3");
    expect(pub).toMatchObject({ hasApiKey: false, ready: false, readyDetail: "API key required" });
    // other profiles keep theirs
    expect((await saved())!.modelProfiles!.find((p) => p.id === "ds_r1")!.apiKey).toBe(R1_KEY);
  });

  it("validates kinds, urls and role bindings without half-saving", async () => {
    const { post, saved } = await boot();
    await post("/api/setup/configure", { modelProfiles: peers() });
    const before = JSON.stringify(await saved());
    const cases: Array<[unknown, RegExp]> = [
      [{ modelProfiles: [{ id: "x", name: "x" }] }, /kind/],
      [{ modelProfiles: [{ id: "x", kind: "gpu" }] }, /kind/],
      [{ modelProfiles: [{ id: "x", kind: "api", apiProtocol: "bard" }] }, /apiProtocol/],
      [{ modelProfiles: [{ id: "x", kind: "cli", cliEngine: "emacs" }] }, /cliEngine/],
      [{ modelProfiles: [{ id: "x", kind: "api", baseUrl: "ftp://nope" }] }, /http/],
      [{ modelProfiles: "nope" }, /array/],
      [{ controlModelId: "ghost" }, /controlModelId/],
      [{ implementModelId: "heuristic" }, /implementModelId/],
      [{ reviewModelId: "ghost" }, /reviewModelId/],
    ];
    for (const [payload, msg] of cases) {
      const res = await post("/api/setup/configure", payload);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(msg);
    }
    expect(JSON.stringify(await saved())).toBe(before);
    // a role may point at a profile created in the same request
    const ok = await post("/api/setup/configure", {
      modelProfiles: [{ id: "fresh", kind: "api", apiProtocol: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-x", apiKey: "sk-f-1234567" }],
      reviewModelId: "fresh",
    });
    expect(ok.status).toBe(200);
    // builtin CLI kind is immutable
    await post("/api/setup/configure", { modelProfiles: [{ id: "cli_codex", kind: "api", model: "m" }] });
    expect((await saved())!.modelProfiles!.find((p) => p.id === "cli_codex")).toMatchObject({ kind: "cli", cliEngine: "codex", builtinCli: true, model: "m" });
  });

  it("keeps legacy fields working and mirrors them into peer profiles", async () => {
    const { post, saved } = await boot();
    const res = await post("/api/setup/configure", {
      llmPreset: "deepseek",
      llmBaseUrl: "https://api.deepseek.com/v1",
      llmModel: "deepseek-chat",
      llmApiKey: "sk-legacy-LLM-4444",
      claudeProfile: { model: "opus", baseUrl: "https://claude-relay.example.com", apiKey: "sk-legacy-CLAUDE-5555" },
      apiWorkerProfile: { preset: "openai", baseUrl: "https://relay.example.com/v1", model: "gpt-x", apiKey: "sk-legacy-API-6666" },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const s of ["LLM-4444", "CLAUDE-5555", "API-6666"]) expect(text).not.toContain(s);
    const cfg = (await saved())!;
    expect(cfg.llmApiKey).toBe("sk-legacy-LLM-4444");
    expect(cfg.claudeProfile).toMatchObject({ model: "opus" });
    expect(cfg.apiWorkerProfile).toMatchObject({ preset: "openai", model: "gpt-x" });
    const byId = (id: string) => cfg.modelProfiles!.find((p) => p.id === id)!;
    expect(byId("cli_claude")).toMatchObject({ model: "opus", baseUrl: "https://claude-relay.example.com", apiKey: "sk-legacy-CLAUDE-5555" });
    expect(byId("api_worker_default")).toMatchObject({ apiProtocol: "openai", model: "gpt-x", apiKey: "sk-legacy-API-6666" });
    expect(byId("api_llm_deepseek")).toMatchObject({ apiKey: "sk-legacy-LLM-4444", workerAutoPool: false });
    expect(cfg.controlModelId).toBe("api_llm_deepseek");

    // editing the legacy worker profile afterwards updates the peer profile too
    await post("/api/setup/configure", { apiWorkerProfile: { preset: "openai", model: "gpt-y" } });
    const next = (await saved())!;
    expect(next.modelProfiles!.find((p) => p.id === "api_worker_default")).toMatchObject({ model: "gpt-y", apiKey: "sk-legacy-API-6666" });
    // switching the legacy llm preset re-derives the control binding
    await post("/api/setup/configure", { llmPreset: "heuristic" });
    expect((await saved())!.controlModelId).toBe("heuristic");
  });

  it("syncs implement/review bindings onto repos (unless syncRepos=false) and PATCH /api/repos overrides them", async () => {
    const { post, send, stateStore } = await boot();
    await post("/api/setup/configure", { modelProfiles: peers(), implementModelId: "ds_r1", reviewModelId: "anth", syncRepos: false });
    expect((await stateStore.getRepo("repo_1"))!.implementModelId).toBeUndefined();

    await post("/api/setup/configure", { implementModelId: "ds_r1", reviewModelId: "anth", preferredImplementEngine: "api", preferredReviewEngine: "claude" });
    expect(await stateStore.getRepo("repo_1")).toMatchObject({ implementModelId: "ds_r1", reviewModelId: "anth", preferredImplementEngine: "api", preferredReviewEngine: "claude" });

    const patch = await send("PATCH", "/api/repos/repo_1", { implementModelId: " ds_v3 ", reviewModelId: null });
    expect(patch.status).toBe(200);
    expect(await stateStore.getRepo("repo_1")).toMatchObject({ implementModelId: "ds_v3", reviewModelId: undefined });
    // untouched bindings survive unrelated patches
    await send("PATCH", "/api/repos/repo_1", { name: "renamed" });
    expect((await stateStore.getRepo("repo_1"))!.implementModelId).toBe("ds_v3");

    const created = await send("POST", "/api/repos", { name: "fresh", rootPath: tempDirs[0], implementModelId: "auto", reviewModelId: "ds_r1" });
    expect(created.status).toBe(201);
    const repo = ((await created.json()) as { repo: { id: string } }).repo;
    expect(await stateStore.getRepo(repo.id)).toMatchObject({ implementModelId: "auto", reviewModelId: "ds_r1" });
  });

  it("POST /api/setup/test-model tests API profiles (keyless local, saved-key hydration, redaction) and validates input", async () => {
    const { post } = await boot();
    const seen: Array<{ path: string; auth: string | null; xKey: string | null; body: any }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        seen.push({ path: url.pathname, auth: req.headers.get("authorization"), xKey: req.headers.get("x-api-key"), body: await req.json().catch(() => null) });
        if (url.pathname.startsWith("/bad")) return new Response(`invalid key ${req.headers.get("authorization")}`, { status: 401 });
        if (url.pathname.endsWith("/messages")) return Response.json({ content: [{ type: "text", text: "{}" }] });
        return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
      },
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;

    await post("/api/setup/configure", {
      modelProfiles: [{ id: "saved", name: "Saved", kind: "api", apiProtocol: "openai", baseUrl: `${base}/v1`, model: "m1", apiKey: "sk-saved-HYDRATE-8888" }],
    });

    // keyless ollama on localhost
    let res = await post("/api/setup/test-model", { kind: "api", apiProtocol: "ollama", baseUrl: `${base}/v1`, model: "llama3.1" });
    let out = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(out).toMatchObject({ ok: true, providerName: "ollama:llama3.1" });
    expect(seen.at(-1)).toMatchObject({ path: "/v1/chat/completions", auth: null });
    expect(seen.at(-1)!.body.max_tokens).toBe(16);

    // useSavedKey hydrates the stored key by id when the request key is blank
    res = await post("/api/setup/test-model", { id: "saved", kind: "api", apiProtocol: "openai", baseUrl: `${base}/v1`, model: "m1", apiKey: "", useSavedKey: true });
    out = await res.json();
    expect(out.ok).toBe(true);
    expect(seen.at(-1)!.auth).toBe("Bearer sk-saved-HYDRATE-8888");
    expect(JSON.stringify(out)).not.toContain("HYDRATE-8888");

    // without useSavedKey a remote endpoint is rejected for the missing key
    res = await post("/api/setup/test-model", { id: "saved", kind: "api", apiProtocol: "openai", baseUrl: "https://api.openai.com/v1", model: "m1" });
    out = await res.json();
    expect(out).toMatchObject({ ok: false });
    expect(out.message).toMatch(/API Key is required/);

    // anthropic protocol: /v1/messages once + x-api-key
    res = await post("/api/setup/test-model", { kind: "api", apiProtocol: "anthropic", baseUrl: `${base}/v1`, model: "claude-x", apiKey: "sk-ant-TEST-9999" });
    out = await res.json();
    expect(out.ok).toBe(true);
    expect(seen.at(-1)).toMatchObject({ path: "/v1/messages", xKey: "sk-ant-TEST-9999" });

    // upstream error echoing the key is redacted
    res = await post("/api/setup/test-model", { kind: "api", apiProtocol: "openai", baseUrl: `${base}/bad/v1`, model: "m", apiKey: "sk-echo-LEAK-0000" });
    out = await res.json();
    expect(out.ok).toBe(false);
    expect(out.message).toContain("401");
    expect(JSON.stringify(out)).not.toContain("LEAK-0000");

    // validation
    for (const payload of [{}, { kind: "gpu" }, { kind: "api", apiProtocol: "bard" }, { kind: "cli", cliEngine: "emacs" }, { kind: "api", baseUrl: "ftp://x" }]) {
      expect((await post("/api/setup/test-model", payload)).status).toBe(400);
    }

    // CLI profile with an unreachable relay never throws and never leaks the key
    res = await post("/api/setup/test-model", { kind: "cli", cliEngine: "codex", baseUrl: "http://127.0.0.1:1", apiKey: "sk-relay-NOPE-1212" });
    out = await res.json();
    expect(res.status).toBe(200);
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).not.toContain("NOPE-1212");
  });

  it("quick-start populates normalized profiles with 'auto' worker bindings", async () => {
    const { post, saved } = await boot();
    const res = await post("/api/setup/quick-start", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.config.modelProfiles.map((p: any) => p.id)).toEqual(["cli_claude", "cli_codex", "cli_opencode", "cli_gemini"]);
    expect(body.config).toMatchObject({ controlModelId: "heuristic", implementModelId: "auto", reviewModelId: "auto" });
    expect(await saved()).toMatchObject({ controlModelId: "heuristic", implementModelId: "auto", reviewModelId: "auto" });

    // an existing custom profile survives a later quick-start
    await post("/api/setup/configure", { modelProfiles: peers().slice(0, 1) });
    await post("/api/setup/quick-start", {});
    expect((await saved())!.modelProfiles!.some((p) => p.id === "ds_v3" && p.apiKey === DS_KEY)).toBe(true);
  });

  it("persists preferredModelId through /api/tickets, /api/epics, /api/intake and live steer", async () => {
    const { post, stateStore } = await boot();
    await post("/api/setup/configure", { modelProfiles: peers() });

    const created = await post("/api/tickets", { repoId: "repo_1", title: "Pinned", description: "Do it", preferredModelId: " ds_r1 ", pauseBeforeRun: true });
    expect(created.status).toBe(201);
    const { ticket } = (await created.json()) as { ticket: any };
    expect(ticket).toMatchObject({ preferredModelId: "ds_r1", activeModelId: "ds_r1", preferredEngine: "api", activeEngine: "api" });
    expect(await stateStore.getTicket(ticket.id)).toMatchObject({ preferredModelId: "ds_r1", activeModelId: "ds_r1" });

    // an unknown id is persisted but does not pin an engine
    const unknown = await post("/api/tickets", { repoId: "repo_1", title: "Ghost", description: "x", preferredModelId: "ghost", preferredEngine: "claude", pauseBeforeRun: true });
    const ghost = ((await unknown.json()) as { ticket: any }).ticket;
    expect(ghost).toMatchObject({ preferredModelId: "ghost", preferredEngine: "claude", activeEngine: "claude" });
    expect(ghost.activeModelId).toBeUndefined();

    // no model id => untouched legacy behaviour
    const plain = ((await (await post("/api/tickets", { repoId: "repo_1", title: "Plain", description: "x", pauseBeforeRun: true })).json()) as { ticket: any }).ticket;
    expect(plain.preferredModelId).toBeUndefined();
    expect(plain.activeModelId).toBeUndefined();

    // live steer swaps the pinned model, and a bare engine choice clears the pin
    const steered = await post(`/api/tickets/${plain.id}/steer`, { instruction: "use the reasoner", preferredModelId: "ds_v3" });
    expect(steered.status).toBe(200);
    expect(((await steered.json()) as { ticket: any }).ticket).toMatchObject({ preferredModelId: "ds_v3", activeModelId: "ds_v3", preferredEngine: "api", activeEngine: "api" });
    const cleared = await post(`/api/tickets/${plain.id}/steer`, { instruction: "back to claude", preferredEngine: "claude" });
    const clearedTicket = ((await cleared.json()) as { ticket: any }).ticket;
    expect(clearedTicket).toMatchObject({ preferredEngine: "claude", activeEngine: "claude" });
    expect(clearedTicket.preferredModelId).toBeUndefined();
    expect(clearedTicket.activeModelId).toBeUndefined();
    expect((await stateStore.getTicket(plain.id))!.activeModelId).toBeUndefined();
    // steer without any engine/model choice leaves the pin alone
    await post(`/api/tickets/${ticket.id}/steer`, { instruction: "keep going" });
    expect(await stateStore.getTicket(ticket.id)).toMatchObject({ preferredModelId: "ds_r1", activeModelId: "ds_r1" });

    const epic = await post("/api/epics", {
      repoId: "repo_1", title: "Epic", description: "two parts", preferredModelId: "anth",
      subtasks: [
        { key: "a", title: "A", description: "a", allowedPaths: ["src/a/**"], template: "fast" },
        { key: "b", title: "B", description: "b", allowedPaths: ["src/b/**"], template: "fast" },
      ],
    });
    expect(epic.status).toBe(201);
    const { epic: epicTicket, subtasks } = (await epic.json()) as { epic: any; subtasks: any[] };
    expect(epicTicket.preferredModelId).toBe("anth");
    const subA = subtasks.find((s) => s.subtaskKey === "a");
    const subB = subtasks.find((s) => s.subtaskKey === "b");
    expect(subA).toMatchObject({ preferredModelId: "anth", activeModelId: "anth", preferredEngine: "api" });
    expect(subB).toMatchObject({ preferredModelId: "anth", activeModelId: "anth", preferredEngine: "api" });

    const intake = await post("/api/intake", { repoId: "repo_1", requirement: "Add a tiny helper module with a unit test", preferredModelId: "ds_v3" });
    expect(intake.status).toBe(201);
    const intakeBody = (await intake.json()) as { route: string; ticket?: any; epic?: any };
    const intakeTicket = intakeBody.ticket ?? intakeBody.epic;
    expect(intakeTicket?.preferredModelId).toBe("ds_v3");
  });

  it("deletes custom profiles, protects builtin CLI profiles and falls role bindings back", async () => {
    const { post, saved, stateStore } = await boot();
    const bind = await post("/api/setup/configure", {
      modelProfiles: peers(),
      controlModelId: "ds_v3",
      implementModelId: "ds_r1",
      reviewModelId: "anth",
      syncRepos: true,
    });
    expect(bind.status).toBe(200);
    expect(await saved()).toMatchObject({ controlModelId: "ds_v3", implementModelId: "ds_r1", reviewModelId: "anth" });
    expect((await stateStore.getRepo("repo_1"))!.implementModelId).toBe("ds_r1");

    // builtin CLI profiles cannot be deleted and nothing is half-applied
    const builtinId = ((await saved())!.modelProfiles ?? []).find((p) => p.builtinCli)!.id;
    const denied = await post("/api/setup/configure", { deleteModelProfileIds: ["ds_v3", builtinId] });
    expect(denied.status).toBe(400);
    expect(((await denied.json()) as { error: string }).error).toContain("cannot be deleted");
    expect((await saved())!.modelProfiles!.some((p) => p.id === "ds_v3")).toBe(true);
    expect((await saved())!.controlModelId).toBe("ds_v3");

    // deleting custom profiles removes them and falls dangling roles back (repos keep unrelated pins)
    const ok = await post("/api/setup/configure", { deleteModelProfileIds: ["ds_v3", "ds_r1", "does_not_exist"], syncRepos: false });
    expect(ok.status).toBe(200);
    const cfg = (await saved())!;
    expect(cfg.modelProfiles!.some((p) => p.id === "ds_v3" || p.id === "ds_r1")).toBe(false);
    expect(cfg.modelProfiles!.some((p) => p.id === "anth")).toBe(true);
    expect(cfg.controlModelId).toBe("heuristic");
    expect(cfg.implementModelId).toBe("auto");
    expect(cfg.reviewModelId).toBe("anth");
    const repo = (await stateStore.getRepo("repo_1"))!;
    expect(repo.implementModelId).toBe("auto");
    expect(repo.reviewModelId).toBe("anth");

    // binding a role to a profile deleted in the same request is rejected
    const bad = await post("/api/setup/configure", { deleteModelProfileIds: ["anth"], reviewModelId: "anth" });
    expect(bad.status).toBe(400);
    expect((await post("/api/setup/configure", { deleteModelProfileIds: "anth" })).status).toBe(400);
  });
});
