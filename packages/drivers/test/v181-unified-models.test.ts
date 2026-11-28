import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  type CliScanReport,
  type ModelProfile,
  type StageRun,
  type SystemSetupConfig,
  type Ticket,
  createDefaultMandate,
  evaluateModelProfileReadiness,
  getFirstStage,
  isLocalModelEndpoint,
  mapProtocolToApiPreset,
  newId,
  normalizeSystemSetupConfig,
  nowIso,
  profileDriverEngine,
  protocolDefaultBaseUrl,
  resolveModelPreference,
  resolveStageModelSelection,
  toPublicModelProfile,
} from "@super-work/core";
import { resolveTurnWorkerAuthAndModel, selectStageProfile } from "../../core/src/kernel/stage-engine-helpers.ts";
import {
  AnthropicCompatibleControlLLM,
  CliFallbackControlLLM,
  CodexCliControlLLM,
  GeminiCliControlLLM,
  HeuristicControlLLM,
  OpenAICompatibleControlLLM,
  OpenCodeCliControlLLM,
  SqliteStateStore,
  anthropicMessagesUrl,
  buildControlPlaneLLMFromProfile,
  buildControlPlaneLLMFromSetup,
  createControlLLMFromProfile,
  parseCliJsonOutput,
  redactSecrets,
  testModelProfileConnection,
} from "../src/index.ts";

const baseSetup = (over: Partial<SystemSetupConfig> = {}): SystemSetupConfig => ({
  initialized: true,
  llmPreset: "heuristic",
  llmBaseUrl: "",
  llmModel: "",
  preferredImplementEngine: "claude",
  preferredReviewEngine: "codex",
  updatedAt: nowIso(),
  ...over,
});

const apiProfile = (id: string, over: Partial<ModelProfile> = {}): ModelProfile => ({
  id,
  name: id,
  kind: "api",
  apiProtocol: "deepseek",
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-chat",
  apiKey: `sk-${id}-SECRET-0001`,
  workerAutoPool: true,
  enabled: true,
  ...over,
});

const cliProfile = (id: string, cliEngine: ModelProfile["cliEngine"], over: Partial<ModelProfile> = {}): ModelProfile => ({
  id,
  name: id,
  kind: "cli",
  cliEngine,
  workerAutoPool: true,
  enabled: true,
  builtinCli: true,
  ...over,
});

describe("v1.8.1 model registry: pure helpers", () => {
  it("maps protocols, defaults and local endpoints", () => {
    expect(protocolDefaultBaseUrl("anthropic")).toBe("https://api.anthropic.com");
    expect(protocolDefaultBaseUrl("ollama")).toBe("http://localhost:11434/v1");
    expect(mapProtocolToApiPreset("ollama")).toBe("openai");
    expect(mapProtocolToApiPreset("deepseek")).toBe("deepseek");
    for (const u of ["http://localhost:1234", "http://127.0.0.1/v1", "http://[::1]:11434", "http://0.0.0.0:8", "http://host.docker.internal:9"]) {
      expect(isLocalModelEndpoint(u)).toBe(true);
    }
    expect(isLocalModelEndpoint("https://api.openai.com/v1")).toBe(false);
    expect(isLocalModelEndpoint(undefined)).toBe(false);
    expect(profileDriverEngine({ kind: "cli", cliEngine: "gemini" })).toBe("gemini");
    expect(profileDriverEngine({ kind: "cli" })).toBe("claude");
    expect(profileDriverEngine({ kind: "api" })).toBe("api");
  });

  it("evaluates readiness for CLI and API profiles", () => {
    const scan = {
      scannedAt: nowIso(),
      recommendedImplementEngine: "claude",
      recommendedReviewEngine: "codex",
      tools: [
        { id: "claude", name: "Claude", installed: true, authenticated: true, authSummary: "logged in", workerSupported: true },
        { id: "codex", name: "Codex", installed: true, authenticated: false, workerSupported: true },
        { id: "gemini", name: "Gemini", installed: false, authenticated: null, workerSupported: true },
      ],
    } as CliScanReport;
    expect(evaluateModelProfileReadiness({ kind: "cli", cliEngine: "claude", enabled: false }, scan)).toEqual({ ready: false, detail: "disabled" });
    expect(evaluateModelProfileReadiness({ kind: "cli", cliEngine: "gemini", enabled: true }, scan)).toEqual({ ready: false, detail: "CLI not installed" });
    expect(evaluateModelProfileReadiness({ kind: "cli", cliEngine: "claude", enabled: true }, scan)).toEqual({ ready: true, detail: "logged in" });
    expect(evaluateModelProfileReadiness({ kind: "cli", cliEngine: "codex", enabled: true }, scan)).toEqual({ ready: false, detail: "CLI not logged in" });
    expect(evaluateModelProfileReadiness({ kind: "cli", cliEngine: "codex", enabled: true, apiKey: "k", baseUrl: "https://r" }, scan)).toEqual({ ready: true, detail: "CLI + custom relay" });
    expect(evaluateModelProfileReadiness({ kind: "cli", cliEngine: "codex", enabled: true, hasApiKey: true }, scan)).toEqual({ ready: true, detail: "CLI + custom key" });
    expect(evaluateModelProfileReadiness({ kind: "cli", cliEngine: "opencode", enabled: true }, null).ready).toBe(true);

    const api = { kind: "api" as const, enabled: true, baseUrl: "https://x/v1", model: "m" };
    expect(evaluateModelProfileReadiness({ ...api, apiProtocol: "openai" }).ready).toBe(false);
    expect(evaluateModelProfileReadiness({ ...api, apiProtocol: "openai", apiKey: "k" }).ready).toBe(true);
    expect(evaluateModelProfileReadiness({ ...api, apiProtocol: "ollama" }).ready).toBe(true);
    expect(evaluateModelProfileReadiness({ ...api, apiProtocol: "openai", baseUrl: "http://localhost:8080/v1" }).ready).toBe(true);
    expect(evaluateModelProfileReadiness({ kind: "api", enabled: true, apiProtocol: "ollama", baseUrl: "", model: "m" }).ready).toBe(false);
    expect(evaluateModelProfileReadiness({ kind: "api", enabled: true, apiProtocol: "ollama", baseUrl: "http://localhost:1", model: "" }).ready).toBe(false);
  });

  it("losslessly migrates a legacy SystemSetupConfig and masks keys in the public view", () => {
    const legacy = baseSetup({
      llmPreset: "deepseek",
      llmBaseUrl: "https://api.deepseek.com/v1",
      llmModel: "deepseek-chat",
      llmApiKey: "sk-llm-LEGACY-1111",
      claudeProfile: { model: "opus", baseUrl: "https://claude-relay.example.com", apiKey: "sk-ant-LEGACY-2222", effort: "high" },
      apiWorkerProfile: { preset: "openai", baseUrl: "https://relay.example.com/v1", model: "gpt-x", apiKey: "sk-api-LEGACY-3333" },
    });
    const norm = normalizeSystemSetupConfig(legacy);
    const ids = norm.modelProfiles!.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["cli_claude", "cli_codex", "cli_opencode", "cli_gemini", "api_worker_default", "api_llm_deepseek"]));
    const claude = norm.modelProfiles!.find((p) => p.id === "cli_claude")!;
    expect(claude).toMatchObject({ builtinCli: true, name: "Claude Code", model: "opus", baseUrl: "https://claude-relay.example.com", apiKey: "sk-ant-LEGACY-2222", effort: "high", workerAutoPool: true, enabled: true });
    const apiWorker = norm.modelProfiles!.find((p) => p.id === "api_worker_default")!;
    expect(apiWorker).toMatchObject({ kind: "api", apiProtocol: "openai", model: "gpt-x" });
    const llm = norm.modelProfiles!.find((p) => p.id === "api_llm_deepseek")!;
    expect(llm).toMatchObject({ apiProtocol: "deepseek", apiKey: "sk-llm-LEGACY-1111", workerAutoPool: false });
    expect(norm.controlModelId).toBe("api_llm_deepseek");
    expect(norm.implementModelId).toBe("auto");
    expect(norm.reviewModelId).toBe("auto");
    // legacy fields are preserved untouched
    expect(norm.llmApiKey).toBe("sk-llm-LEGACY-1111");
    expect(norm.claudeProfile?.apiKey).toBe("sk-ant-LEGACY-2222");
    // idempotent
    expect(normalizeSystemSetupConfig(norm)).toEqual(norm);

    const pub = norm.modelProfiles!.map((p) => toPublicModelProfile(p));
    const text = JSON.stringify(pub);
    for (const secret of ["LEGACY-1111", "LEGACY-2222", "LEGACY-3333"]) expect(text).not.toContain(secret);
    const pubClaude = pub.find((p) => p.id === "cli_claude")!;
    expect(pubClaude).not.toHaveProperty("apiKey");
    expect(pubClaude.hasApiKey).toBe(true);
    expect(pubClaude.maskedApiKey).toBe("sk-****2222");
    expect(pubClaude.ready).toBe(true);
  });

  it("dedupes an identical legacy llm preset and worker profile; claude_cli/codex_cli map to builtin control ids", () => {
    const dup = normalizeSystemSetupConfig(
      baseSetup({
        llmPreset: "openai",
        llmBaseUrl: "https://relay.example.com/v1/",
        llmModel: "gpt-x",
        llmApiKey: "sk-same",
        apiWorkerProfile: { preset: "openai", baseUrl: "https://relay.example.com/v1", model: "gpt-x", apiKey: "sk-same" },
      }),
    );
    expect(dup.modelProfiles!.filter((p) => p.kind === "api")).toHaveLength(1);
    expect(dup.controlModelId).toBe("api_worker_default");
    expect(normalizeSystemSetupConfig(baseSetup({ llmPreset: "claude_cli" })).controlModelId).toBe("cli_claude");
    expect(normalizeSystemSetupConfig(baseSetup({ llmPreset: "codex_cli" })).controlModelId).toBe("cli_codex");
    expect(normalizeSystemSetupConfig(baseSetup({ llmPreset: "heuristic" })).controlModelId).toBe("heuristic");
    expect(normalizeSystemSetupConfig(null).modelProfiles).toHaveLength(4);
  });

  it("falls back to heuristic/auto for dangling role ids", () => {
    const norm = normalizeSystemSetupConfig(
      baseSetup({ controlModelId: "gone", implementModelId: "gone", reviewModelId: "gone" }),
    );
    expect(norm.controlModelId).toBe("heuristic");
    expect(norm.implementModelId).toBe("auto");
    expect(norm.reviewModelId).toBe("auto");
  });
});

describe("v1.8.1 model registry: stage model selection", () => {
  const profiles: ModelProfile[] = [
    cliProfile("cli_claude", "claude"),
    apiProfile("ds_v3", { name: "DeepSeek-V3", model: "deepseek-chat" }),
    apiProfile("ds_r1", { name: "DeepSeek-R1", model: "deepseek-reasoner" }),
    apiProfile("lite", { name: "Lite", workerAutoPool: false }),
  ];
  const repo = {} as { implementModelId?: string; reviewModelId?: string };
  const ticket = {} as Pick<Ticket, "activeModelId" | "preferredModelId" | "failedEngines">;
  const available = ["claude", "api"] as const;
  const common = { repo, ticket, availableEngines: [...available] };

  it("keeps lightweight workerAutoPool=false profiles out of 'auto' but usable when pinned / as control", () => {
    const setup = baseSetup({ modelProfiles: profiles, implementModelId: "auto" });
    const auto = resolveStageModelSelection({ ...common, stage: "implement", setupConfig: setup });
    expect(auto.profile?.id).toBe("cli_claude");

    const onlyLite = baseSetup({ modelProfiles: [profiles[3]!], implementModelId: "auto" });
    const none = resolveStageModelSelection({ ...common, stage: "implement", setupConfig: onlyLite, legacyEngine: "claude" });
    expect(none).toEqual({ engine: "claude" });

    const pinned = resolveStageModelSelection({ ...common, stage: "implement", setupConfig: baseSetup({ modelProfiles: profiles, implementModelId: "lite" }) });
    expect(pinned).toMatchObject({ engine: "api", profile: { id: "lite" } });

    const llm = buildControlPlaneLLMFromSetup(baseSetup({ modelProfiles: profiles, controlModelId: "lite" }));
    expect(llm.providerName).toBe("deepseek:deepseek-chat");
  });

  it("honors ticket.activeModelId ?? preferredModelId over repo/setup bindings, but not tripped/failed engines", () => {
    const setup = baseSetup({ modelProfiles: profiles, implementModelId: "cli_claude" });
    const t = { ...ticket, preferredModelId: "ds_r1" };
    expect(resolveStageModelSelection({ ...common, ticket: t, stage: "implement", setupConfig: setup }).profile?.id).toBe("ds_r1");
    const t2 = { ...t, activeModelId: "ds_v3" };
    expect(resolveStageModelSelection({ ...common, ticket: t2, stage: "implement", setupConfig: setup }).profile?.id).toBe("ds_v3");
    // repo binding beats setup binding
    expect(resolveStageModelSelection({ ...common, repo: { implementModelId: "ds_r1" }, stage: "plan", setupConfig: setup }).profile?.id).toBe("ds_r1");
    // tripped engine: explicit pin is skipped so legacy failover can pick another engine
    const tripped = resolveStageModelSelection({ ...common, ticket: t2, trippedEngines: ["api"], stage: "implement", setupConfig: setup, legacyEngine: "claude" });
    expect(tripped.profile?.id).toBe("cli_claude");
    // an unknown / disabled id is ignored
    const dis = baseSetup({ modelProfiles: [...profiles.slice(0, 1), apiProfile("off", { enabled: false })], implementModelId: "off" });
    expect(resolveStageModelSelection({ ...common, stage: "implement", setupConfig: dis, legacyEngine: "claude" })).toEqual({ engine: "claude" });
  });

  it("narrows implement 'auto' to the legacy concrete engine when one is requested", () => {
    const setup = baseSetup({ modelProfiles: profiles, implementModelId: "auto" });
    const sel = resolveStageModelSelection({ ...common, stage: "implement", setupConfig: setup, explicitEngine: true, legacyEngine: "api" });
    expect(sel.profile?.id).toBe("ds_v3");
    const none = resolveStageModelSelection({ ...common, stage: "implement", setupConfig: setup, explicitEngine: true, legacyEngine: "codex" });
    expect(none).toEqual({ engine: "codex" });
  });

  it("review 'auto' prefers a different engine/protocol, then a different profile id even when engine is shared", () => {
    const setup = baseSetup({ modelProfiles: profiles, reviewModelId: "auto" });
    const crossEngine = resolveStageModelSelection({ ...common, stage: "review", setupConfig: setup, implementProfileId: "cli_claude" });
    expect(crossEngine.engine).toBe("api");
    expect(crossEngine.profile?.id).toBe("ds_v3");

    // two API profiles share engine 'api' (same protocol): different profile id must still be chosen
    const apiOnly = baseSetup({ modelProfiles: [profiles[1]!, profiles[2]!], reviewModelId: "auto" });
    const sameEngine = resolveStageModelSelection({ ...common, stage: "review", setupConfig: apiOnly, implementProfileId: "ds_v3" });
    expect(sameEngine.engine).toBe("api");
    expect(sameEngine.profile?.id).toBe("ds_r1");
    expect(resolveStageModelSelection({ ...common, stage: "review", setupConfig: apiOnly, implementProfileId: "ds_r1" }).profile?.id).toBe("ds_v3");

    // different protocol counts as heterogeneous
    const mixed = baseSetup({
      modelProfiles: [profiles[1]!, apiProfile("anth", { apiProtocol: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-x" }), profiles[2]!],
      reviewModelId: "auto",
    });
    expect(resolveStageModelSelection({ ...common, stage: "review", setupConfig: mixed, implementProfileId: "ds_v3" }).profile?.id).toBe("anth");

    // single candidate: fallback to it
    const single = baseSetup({ modelProfiles: [profiles[1]!], reviewModelId: "auto" });
    expect(resolveStageModelSelection({ ...common, stage: "review", setupConfig: single, implementProfileId: "ds_v3" }).profile?.id).toBe("ds_v3");

    // explicit reviewModelId wins
    const explicit = baseSetup({ modelProfiles: profiles, reviewModelId: "ds_r1" });
    expect(resolveStageModelSelection({ ...common, stage: "review", setupConfig: explicit, implementProfileId: "ds_r1" }).profile?.id).toBe("ds_r1");
  });

  it("selectStageProfile reads the last implement run's modelProfileId for cross-review", async () => {
    const setup = baseSetup({ modelProfiles: [profiles[1]!, profiles[2]!], reviewModelId: "auto" });
    const run = (over: Partial<StageRun>): StageRun => ({
      id: newId("run"), ticketId: "t", stage: "implement", engine: "api", status: "completed", costUsd: 0, startedAt: nowIso(), ...over,
    });
    const ctx = { stateStore: { listStageRuns: async () => [run({ modelProfileId: "ds_r1" })] } } as never;
    const sel = await selectStageProfile(ctx, {
      ticket: { ...(ticket as Ticket) },
      repo: { preferredImplementEngine: "auto" } as never,
      stage: "review",
      setupConfig: setup,
      availableEngines: ["api"],
      trippedEngines: [],
      legacyEngine: "api",
    });
    expect(sel.profile?.id).toBe("ds_v3");
    // no profiles configured => legacy engine untouched
    const legacy = await selectStageProfile(ctx, {
      ticket: ticket as Ticket, repo: {} as never, stage: "implement", setupConfig: baseSetup(), availableEngines: ["claude"], trippedEngines: [], legacyEngine: "claude",
    });
    expect(legacy).toEqual({ engine: "claude" });
  });

  it("resolveModelPreference pins the profile engine; unknown ids are kept but do not pin", () => {
    const setup = baseSetup({ modelProfiles: profiles });
    expect(resolveModelPreference(setup, " ds_v3 ")).toEqual({ preferredModelId: "ds_v3", preferredEngine: "api", activeModelId: "ds_v3" });
    expect(resolveModelPreference(setup, "nope")).toEqual({ preferredModelId: "nope" });
    expect(resolveModelPreference(setup, "  ")).toEqual({});
  });

  it("injects the exact profile's model/effort/baseUrl/apiKey/apiPreset into the worker turn", () => {
    const p = apiProfile("ollama1", { apiProtocol: "ollama", baseUrl: "http://localhost:11434/v1", model: "llama3.1", apiKey: undefined, effort: "high" });
    const out = resolveTurnWorkerAuthAndModel("api", { preferredEngine: "api" }, undefined, "implement", p);
    expect(out).toEqual({ model: "llama3.1", effort: "high", baseUrl: "http://localhost:11434/v1", apiPreset: "openai" });
    const ds = apiProfile("ds");
    expect(resolveTurnWorkerAuthAndModel("api", {}, undefined, "review", ds)).toMatchObject({ apiKey: ds.apiKey, apiPreset: "deepseek", model: "deepseek-chat" });
    // ticket model override still applies to implement, but never to review
    expect(resolveTurnWorkerAuthAndModel("api", { modelOverride: "o" }, undefined, "implement", ds).model).toBe("o");
    expect(resolveTurnWorkerAuthAndModel("api", { modelOverride: "o" }, undefined, "review", ds).model).toBe("deepseek-chat");
    // a profile for another engine is ignored (driver fallback happened)
    expect(resolveTurnWorkerAuthAndModel("claude", {}, undefined, "implement", ds)).toEqual({ model: undefined, effort: undefined });
    const cli = cliProfile("cli_codex", "codex", { baseUrl: "https://relay", apiKey: "sk-r", model: "gpt-5" });
    expect(resolveTurnWorkerAuthAndModel("codex", {}, undefined, "implement", cli)).toEqual({ model: "gpt-5", effort: undefined, baseUrl: "https://relay", apiKey: "sk-r" });
  });
});

describe("v1.8.1 symmetric control-plane LLMs", () => {
  const tempDirs: string[] = [];
  const servers: Array<{ stop: (force?: boolean) => void }> = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) s.stop(true);
    for (const d of tempDirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  interface Seen { url: string; headers: Headers; body: unknown }
  function mock(respond: (req: Seen) => Response | Promise<Response>) {
    const seen: Seen[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const entry: Seen = { url: new URL(req.url).pathname, headers: req.headers, body: await req.json().catch(() => undefined) };
        seen.push(entry);
        return respond(entry);
      },
    });
    servers.push(server);
    return { seen, base: `http://127.0.0.1:${server.port}` };
  }
  const chat = (content: string) => Response.json({ choices: [{ message: { content } }] });
  const ask = (llm: { answerChiefQuestion?: (i: { question: string; contextSummary: string }) => Promise<{ answer: string }> }) =>
    llm.answerChiefQuestion!({ question: "q", contextSummary: "ctx" });

  it("builds the right ControlPlaneLLM class for every profile kind", () => {
    expect(createControlLLMFromProfile(cliProfile("a", "claude"))).toBeInstanceOf(CliFallbackControlLLM);
    expect(createControlLLMFromProfile(cliProfile("a", "codex"))).toBeInstanceOf(CodexCliControlLLM);
    expect(createControlLLMFromProfile(cliProfile("a", "gemini"))).toBeInstanceOf(GeminiCliControlLLM);
    expect(createControlLLMFromProfile(cliProfile("a", "opencode"))).toBeInstanceOf(OpenCodeCliControlLLM);
    expect(createControlLLMFromProfile(apiProfile("a", { apiProtocol: "anthropic" }))).toBeInstanceOf(AnthropicCompatibleControlLLM);
    for (const protocol of ["deepseek", "openai", "ollama"] as const) {
      expect(createControlLLMFromProfile(apiProfile("a", { apiProtocol: protocol }))).toBeInstanceOf(OpenAICompatibleControlLLM);
    }
    expect(buildControlPlaneLLMFromProfile(apiProfile("a")).providerName).toBe("deepseek:deepseek-chat");
    expect(buildControlPlaneLLMFromProfile(cliProfile("a", "gemini", { model: "gemini-2.5" })).providerName).toBe("cli:gemini(gemini-2.5)");
    expect(buildControlPlaneLLMFromProfile(cliProfile("a", "opencode")).providerName).toBe("cli:opencode(default)");
  });

  it("buildControlPlaneLLMFromSetup: 'heuristic', profile id, and legacy fallback", () => {
    const profiles = [apiProfile("ds_v3"), cliProfile("cli_claude", "claude", { model: "sonnet" })];
    expect(buildControlPlaneLLMFromSetup(baseSetup({ modelProfiles: profiles, controlModelId: "heuristic", llmPreset: "claude_cli" }))).toBeInstanceOf(HeuristicControlLLM);
    expect(buildControlPlaneLLMFromSetup(baseSetup({ modelProfiles: profiles, controlModelId: "ds_v3" })).providerName).toBe("deepseek:deepseek-chat");
    expect(buildControlPlaneLLMFromSetup(baseSetup({ modelProfiles: profiles, controlModelId: "cli_claude" })).providerName).toContain("cli:claude(sonnet");
    // disabled / unknown id falls back to legacy llmPreset logic
    const off = [apiProfile("ds_v3", { enabled: false })];
    expect(buildControlPlaneLLMFromSetup(baseSetup({ modelProfiles: off, controlModelId: "ds_v3", llmPreset: "claude_cli" })).providerName).toContain("cli:claude");
    expect(buildControlPlaneLLMFromSetup(baseSetup({ llmPreset: "heuristic" }))).toBeInstanceOf(HeuristicControlLLM);
  });

  it("keyless ollama/localhost OpenAI-compatible control LLM sends no Authorization header", async () => {
    const { seen, base } = mock(() => chat('{"answer":"local ok"}'));
    const llm = createControlLLMFromProfile(apiProfile("ollama", { apiProtocol: "ollama", baseUrl: `${base}/v1`, model: "llama3.1", apiKey: undefined }));
    expect((await ask(llm)).answer).toBe("local ok");
    expect(seen[0]!.url).toBe("/v1/chat/completions");
    expect(seen[0]!.headers.has("authorization")).toBe(false);

    const keyed = mock(() => chat('{"answer":"k"}'));
    await ask(createControlLLMFromProfile(apiProfile("ds", { baseUrl: `${keyed.base}/v1`, apiKey: "sk-live-KEY-9999" })));
    expect(keyed.seen[0]!.headers.get("authorization")).toBe("Bearer sk-live-KEY-9999");
  });

  it("AnthropicCompatibleControlLLM hits /v1/messages once, with all auth headers, and redacts secrets on errors", async () => {
    const KEY = "sk-ant-SECRET-ABCDEF123456";
    const ok = mock(() => Response.json({ content: [{ type: "text", text: '```json\n{"answer":"claude says hi"}\n```' }] }));
    for (const baseUrl of [ok.base, `${ok.base}/`, `${ok.base}/v1`, `${ok.base}/v1/`]) {
      const llm = new AnthropicCompatibleControlLLM({ apiKey: KEY, baseUrl, model: "claude-x" });
      expect(llm.providerName).toBe("anthropic:claude-x");
      expect((await ask(llm)).answer).toBe("claude says hi");
    }
    expect(ok.seen.map((s) => s.url)).toEqual(Array(4).fill("/v1/messages"));
    const first = ok.seen[0]!;
    expect(first.headers.get("x-api-key")).toBe(KEY);
    expect(first.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(first.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(first.body).toMatchObject({ model: "claude-x", max_tokens: expect.any(Number), messages: [{ role: "user" }] });

    const bad = mock(() => new Response(`invalid key ${KEY}`, { status: 401 }));
    const err = await ask(new AnthropicCompatibleControlLLM({ apiKey: KEY, baseUrl: bad.base, model: "m" })).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("401");
    expect((err as Error).message).not.toContain(KEY);

    expect(anthropicMessagesUrl("https://api.anthropic.com")).toBe("https://api.anthropic.com/v1/messages");
    expect(anthropicMessagesUrl("https://relay.example.com/v1/")).toBe("https://relay.example.com/v1/messages");
    expect(redactSecrets("Bearer abcdefghij1234 and sk-xyz-12345", ["sk-xyz-12345"])).not.toMatch(/abcdefghij1234|sk-xyz-12345/);
  });

  it("composite profile LLM falls back to the heuristic planner when the model is unreachable", async () => {
    const llm = buildControlPlaneLLMFromProfile(apiProfile("dead", { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" }));
    const res = await llm.answerChiefQuestion!({ question: "q", contextSummary: "summary text" });
    expect(res.answer).toBe("summary text");
  });

  it("Gemini and OpenCode CLI control LLMs parse their JSON envelopes and relay baseUrl/apiKey via env", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-sym-cli-"));
    tempDirs.push(dir);
    const dump = join(dir, "dump.txt");
    const fake = async (name: string, stdout: string) => {
      const p = join(dir, name);
      await writeFile(
        p,
        `#!/bin/sh\nprintf '%s\\n' "$*" > "${dump}.${name}"\nenv | grep -E '^(GEMINI_API_KEY|GOOGLE_GEMINI_BASE_URL|OPENAI_API_KEY|OPENAI_BASE_URL)=' >> "${dump}.${name}"\ncat <<'EOF'\n${stdout}\nEOF\n`,
      );
      await chmod(p, 0o755);
      return p;
    };
    const gem = await fake("gemini", JSON.stringify({ response: '```json\n{"answer":"gem"}\n```' }));
    const g = new GeminiCliControlLLM({ bin: gem, model: "gemini-2.5-pro", baseUrl: "https://gem-relay.example.com", apiKey: "gk-123456" });
    expect((await ask(g)).answer).toBe("gem");
    const gDump = await readFile(`${dump}.gemini`, "utf8");
    expect(gDump).toContain("-p ");
    expect(gDump).toContain("--output-format json");
    expect(gDump).toContain("-m gemini-2.5-pro");
    expect(gDump).toContain("GEMINI_API_KEY=gk-123456");
    expect(gDump).toContain("GOOGLE_GEMINI_BASE_URL=https://gem-relay.example.com");

    const ndjson = [
      JSON.stringify({ type: "step_start" }),
      JSON.stringify({ type: "text", part: { text: '{"answer":' } }),
      JSON.stringify({ type: "text", part: { text: '"oc"}' } }),
    ].join("\n");
    const oc = await fake("opencode", ndjson);
    const o = new OpenCodeCliControlLLM({ bin: oc, model: "anthropic/claude-x", apiKey: "ok-654321", baseUrl: "https://oc-relay.example.com/v1" });
    expect((await ask(o)).answer).toBe("oc");
    const oDump = await readFile(`${dump}.opencode`, "utf8");
    expect(oDump).toContain("run --format json -m anthropic/claude-x");
    expect(oDump).toContain("OPENAI_API_KEY=ok-654321");
    expect(oDump).toContain("OPENAI_BASE_URL=https://oc-relay.example.com/v1");

    expect(parseCliJsonOutput<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
    expect(parseCliJsonOutput<{ a: number }>('noise\n{"text":"{\\"a\\":2}"}')).toEqual({ a: 2 });
  });

  it("testModelProfileConnection: keyless local ok, remote keyless rejected, secrets redacted, never throws", async () => {
    const { seen, base } = mock(() => chat('{"ok":true}'));
    const okLocal = await testModelProfileConnection(apiProfile("o", { apiProtocol: "ollama", baseUrl: `${base}/v1`, model: "llama3.1", apiKey: undefined }));
    expect(okLocal.ok).toBe(true);
    expect(okLocal.providerName).toBe("ollama:llama3.1");
    expect(seen[0]!.headers.has("authorization")).toBe(false);
    expect(seen[0]!.body).toMatchObject({ max_tokens: 16 });

    const remote = await testModelProfileConnection(apiProfile("r", { apiProtocol: "openai", baseUrl: "https://api.openai.com/v1", apiKey: undefined }));
    expect(remote.ok).toBe(false);
    expect(remote.message).toMatch(/API Key is required/);

    const KEY = "sk-test-SECRET-424242";
    const echo = mock(() => new Response(`bad key ${KEY}`, { status: 401 }));
    const failed = await testModelProfileConnection(apiProfile("f", { baseUrl: `${echo.base}/v1`, apiKey: KEY }));
    expect(failed.ok).toBe(false);
    expect(failed.message).toContain("401");
    expect(failed.message).not.toContain(KEY);

    const anth = mock(() => Response.json({ content: [{ type: "text", text: "{}" }] }));
    const a = await testModelProfileConnection(apiProfile("a", { apiProtocol: "anthropic", baseUrl: `${anth.base}/v1`, apiKey: "ak-1234567890", model: "claude-x" }));
    expect(a.ok).toBe(true);
    expect(anth.seen[0]!.url).toBe("/v1/messages");
    expect(anth.seen[0]!.headers.get("x-api-key")).toBe("ak-1234567890");

    const unreachable = await testModelProfileConnection(apiProfile("u", { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k-1234" }));
    expect(unreachable.ok).toBe(false);

    const relayDown = await testModelProfileConnection(cliProfile("cli_codex", "codex", { baseUrl: "http://127.0.0.1:1", apiKey: "sk-relay-SECRET-1" }));
    expect(relayDown.ok).toBe(false);
    expect(relayDown.message).not.toContain("sk-relay-SECRET-1");
  });
});

describe("v1.8.1 SQLite persistence of model bindings", () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    for (const d of tempDirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it("round-trips repo implement/review ids, ticket preferred/active ids and stage run modelProfileId", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v181-sqlite-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "state.db");
    const store = new SqliteStateStore(dbPath);
    const ts = nowIso();
    const repo = {
      id: "repo_m", name: "m", rootPath: dir, baseBranch: "main", mode: "observe" as const,
      defaultTemplate: "standard" as const, preferredImplementEngine: "api" as const, preferredReviewEngine: "claude" as const,
      implementModelId: "ds_v3", reviewModelId: "auto", createdAt: ts, updatedAt: ts,
    };
    await store.upsertRepo(repo);
    const plain = { ...repo, id: "repo_plain", implementModelId: undefined, reviewModelId: undefined };
    await store.upsertRepo(plain);
    const trigger = { id: newId("trg"), repoId: repo.id, source: "web" as const, threadKey: "k", title: "t", payload: {}, rawText: "r", createdAt: ts };
    await store.saveTrigger(trigger);
    const thread = { id: newId("thr"), repoId: repo.id, threadKey: "k", metadata: {}, createdAt: ts, updatedAt: ts };
    await store.upsertThread(thread);
    const ticket: Ticket = {
      id: newId("tkt"), repoId: repo.id, threadId: thread.id, sourceTriggerId: trigger.id, title: "t", description: "d",
      status: "queued", template: "standard", currentStage: getFirstStage("standard"), stageRetries: 0,
      mandate: createDefaultMandate({ allowedPaths: ["**"] }), dependsOn: [], nativeSessions: {},
      preferredModelId: "ds_r1", activeModelId: "ds_r1",
      inlineMemory: { goal: "d", acceptanceCriteria: [], stageNotes: [], threadUpdates: [] },
      costUsd: 0, priority: 1, createdAt: ts, updatedAt: ts,
    };
    await store.saveTicket(ticket);
    const run: StageRun = { id: newId("run"), ticketId: ticket.id, stage: "implement", engine: "api", modelProfileId: "ds_r1", status: "running", costUsd: 0, startedAt: ts };
    await store.saveStageRun(run);

    // update path (ON CONFLICT) persists too
    await store.saveTicket({ ...ticket, activeModelId: "ds_v3", updatedAt: nowIso() });
    await store.saveStageRun({ ...run, status: "completed", modelProfileId: "ds_v3" });
    await store.upsertRepo({ ...repo, reviewModelId: "ds_r1" });

    const reopened = new SqliteStateStore(dbPath);
    const r = await reopened.getRepo("repo_m");
    expect(r).toMatchObject({ implementModelId: "ds_v3", reviewModelId: "ds_r1" });
    expect(await reopened.getRepo("repo_plain")).toMatchObject({ implementModelId: undefined, reviewModelId: undefined });
    const t = await reopened.getTicket(ticket.id);
    expect(t).toMatchObject({ preferredModelId: "ds_r1", activeModelId: "ds_v3" });
    const runs = await reopened.listStageRuns(ticket.id);
    expect(runs[0]).toMatchObject({ modelProfileId: "ds_v3", status: "completed" });
  });

  it("migrates an existing DB (adds the five new columns) without losing rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v181-migrate-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "state.db");
    const first = new SqliteStateStore(dbPath);
    const ts = nowIso();
    await first.upsertRepo({
      id: "r", name: "r", rootPath: dir, baseBranch: "main", mode: "observe", defaultTemplate: "standard",
      preferredImplementEngine: "mock", preferredReviewEngine: "mock", createdAt: ts, updatedAt: ts,
    });
    const { Database } = await import("bun:sqlite");
    const raw = new Database(dbPath);
    for (const [table, col] of [["repos", "implement_model_id"], ["repos", "review_model_id"], ["tickets", "preferred_model_id"], ["tickets", "active_model_id"], ["stage_runs", "model_profile_id"]] as const) {
      const cols = raw.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toContain(col);
    }
    raw.close();
    expect((await new SqliteStateStore(dbPath).getRepo("r"))?.implementModelId).toBeUndefined();
  });
});
