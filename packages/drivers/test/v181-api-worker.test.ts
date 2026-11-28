import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  type ApiWorkerProfile,
  type StageKind,
  type WorkerStreamEvent,
  type WorkerTurnInput,
  createDefaultMandate,
} from "@super-work/core";
import {
  ApiWorkerDriver,
  ClaudeCodeDriver,
  buildRelayEnv,
  testWorkerConnection,
  toolsForStage,
  wrapCommandWithOsSandbox,
} from "../src/index.ts";

type Scripted = { status?: number; body: unknown };

/** Local mock of an OpenAI-compatible or Anthropic-compatible endpoint with a scripted reply queue. */
function startMock(replies: Scripted[]) {
  const requests: Array<{ path: string; headers: Headers; body: any }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json().catch(() => ({}));
      requests.push({ path: new URL(req.url).pathname, headers: req.headers, body });
      const next = replies.shift() ?? { body: { choices: [{ message: { role: "assistant", content: "(script exhausted)" } }] } };
      return Response.json(next.body, { status: next.status ?? 200 });
    },
  });
  return { server, requests, baseUrl: `http://127.0.0.1:${server.port}` };
}

const oaCall = (id: string, name: string, args: unknown) => ({
  body: {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } }],
        },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  },
});
const oaText = (text: string) => ({
  body: { choices: [{ message: { role: "assistant", content: text } }], usage: { prompt_tokens: 50, completion_tokens: 10 } },
});
const anCall = (id: string, name: string, input: unknown) => ({
  body: {
    content: [{ type: "text", text: "working" }, { type: "tool_use", id, name, input }],
    stop_reason: "tool_use",
    usage: { input_tokens: 100, output_tokens: 20 },
  },
});
const anText = (text: string) => ({
  body: { content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 50, output_tokens: 10 } },
});

describe("v1.8.1 ApiWorkerDriver", () => {
  const tempDirs: string[] = [];
  const servers: Array<{ stop: (force?: boolean) => void }> = [];

  afterEach(async () => {
    for (const s of servers.splice(0)) s.stop(true);
    for (const d of tempDirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function setup(stage: StageKind = "implement", extra: Partial<WorkerTurnInput> = {}) {
    const dir = await mkdtemp(join(tmpdir(), "sw-api-worker-"));
    tempDirs.push(dir);
    const worktree = join(dir, "wt");
    await mkdir(worktree, { recursive: true });
    await writeFile(join(worktree, "a.txt"), "hello world\n", "utf8");
    await writeFile(join(dir, "outside.txt"), "TOP SECRET", "utf8");
    const input: WorkerTurnInput = {
      ticketId: "tkt_1",
      stageRunId: "sr_1",
      stage,
      worktreePath: worktree,
      prompt: "do the thing",
      mandate: createDefaultMandate(),
      isResume: false,
      sandboxMode: "off",
      ...extra,
    };
    return { dir, worktree, input };
  }

  async function collect(gen: AsyncGenerator<WorkerStreamEvent>): Promise<WorkerStreamEvent[]> {
    const out: WorkerStreamEvent[] = [];
    for await (const ev of gen) out.push(ev);
    return out;
  }

  const profile = (baseUrl: string, preset: ApiWorkerProfile["preset"], apiKey = "sk-test-key"): ApiWorkerProfile => ({
    preset,
    baseUrl,
    model: "test-model",
    apiKey,
  });

  it("OpenAI-compatible: read_file -> edit_file -> write_file -> completed", async () => {
    const mock = startMock([
      oaCall("c1", "read_file", { path: "a.txt" }),
      oaCall("c2", "edit_file", { path: "a.txt", old_string: "hello", new_string: "hi" }),
      oaCall("c3", "write_file", { path: "sub/b.txt", content: "new file" }),
      oaText("All done"),
    ]);
    servers.push(mock.server);
    const { worktree, input } = await setup();
    const driver = new ApiWorkerDriver(() => profile(`${mock.baseUrl}/v1`, "deepseek"));

    const events = await collect(driver.runTurn(input, new AbortController().signal));

    expect(await readFile(join(worktree, "a.txt"), "utf8")).toBe("hi world\n");
    expect(await readFile(join(worktree, "sub/b.txt"), "utf8")).toBe("new file");
    expect(events[0]!.type).toBe("session_started");
    expect(events.filter((e) => e.type === "tool_use").map((e) => (e as any).toolName)).toEqual([
      "read_file",
      "edit_file",
      "write_file",
    ]);
    expect(events.filter((e) => e.type === "tool_result").every((e) => !(e as any).isError)).toBe(true);
    expect(events.some((e) => e.type === "usage" && e.costUsd > 0)).toBe(true);
    const last = events.at(-1)!;
    expect(last.type).toBe("completed");
    expect((last as any).summary).toBe("All done");

    expect(mock.requests).toHaveLength(4);
    expect(mock.requests[0]!.path).toBe("/v1/chat/completions");
    expect(mock.requests[0]!.headers.get("authorization")).toBe("Bearer sk-test-key");
    const toolNames = mock.requests[0]!.body.tools.map((t: any) => t.function.name);
    expect(toolNames).toEqual(expect.arrayContaining(["read_file", "write_file", "edit_file", "run_command"]));
    // Tool results are fed back as role=tool messages
    const msgs = mock.requests[3]!.body.messages;
    expect(msgs.filter((m: any) => m.role === "tool")).toHaveLength(3);
  });

  it("Anthropic-compatible: x-api-key + version header, /v1 suffix not duplicated, tool results in one user turn", async () => {
    const mock = startMock([anCall("tu1", "read_file", { path: "a.txt" }), anCall("tu2", "write_file", { path: "c.txt", content: "x" }), anText("finished")]);
    servers.push(mock.server);
    const { worktree, input } = await setup();

    // baseUrl already ends with /v1 -> {baseUrl}/messages
    const events = await collect(
      new ApiWorkerDriver(() => profile(`${mock.baseUrl}/v1`, "anthropic")).runTurn(input, new AbortController().signal),
    );
    expect(events.at(-1)!.type).toBe("completed");
    expect(await readFile(join(worktree, "c.txt"), "utf8")).toBe("x");
    expect(mock.requests[0]!.path).toBe("/v1/messages");
    expect(mock.requests[0]!.headers.get("x-api-key")).toBe("sk-test-key");
    expect(mock.requests[0]!.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(mock.requests[0]!.body.tools[0].input_schema).toBeDefined();
    const second = mock.requests[1]!.body.messages.at(-1);
    expect(second.role).toBe("user");
    expect(second.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu1" });

    // bare host -> {baseUrl}/v1/messages
    const mock2 = startMock([anText("ok")]);
    servers.push(mock2.server);
    await collect(new ApiWorkerDriver(() => profile(mock2.baseUrl, "anthropic")).runTurn(input, new AbortController().signal));
    expect(mock2.requests[0]!.path).toBe("/v1/messages");
  });

  it("rejects path traversal, absolute paths and symlink escapes", async () => {
    const { dir, worktree, input } = await setup();
    await symlink(join(dir, "outside.txt"), join(worktree, "link.txt"));
    await symlink(join(dir, "missing-target.txt"), join(worktree, "dangling.txt"));
    const mock = startMock([
      oaCall("c1", "read_file", { path: "../outside.txt" }),
      oaCall("c2", "read_file", { path: join(dir, "outside.txt") }),
      oaCall("c3", "read_file", { path: "link.txt" }),
      oaCall("c4", "write_file", { path: "../pwned.txt", content: "x" }),
      oaCall("c5", "write_file", { path: "dangling.txt", content: "x" }),
      oaText("done"),
    ]);
    servers.push(mock.server);

    const events = await collect(
      new ApiWorkerDriver(() => profile(mock.baseUrl, "openai")).runTurn(input, new AbortController().signal),
    );
    const results = events.filter((e) => e.type === "tool_result") as Array<Extract<WorkerStreamEvent, { type: "tool_result" }>>;
    expect(results).toHaveLength(5);
    expect(results.every((r) => r.isError)).toBe(true);
    expect(JSON.stringify(events)).not.toContain("TOP SECRET");
    expect(existsSync(join(dir, "pwned.txt"))).toBe(false);
    expect(existsSync(join(dir, "missing-target.txt"))).toBe(false);
  });

  it("enforces stage-scoped tools: plan is read-only, review adds git_diff only", async () => {
    expect(toolsForStage("plan").map((t) => t.name)).toEqual(["read_file", "list_files", "grep_files"]);
    expect(toolsForStage("review").map((t) => t.name)).toEqual(["read_file", "list_files", "grep_files", "git_diff"]);
    expect(toolsForStage("implement").map((t) => t.name)).toContain("run_command");
    expect(toolsForStage("spec_test").map((t) => t.name)).toContain("edit_file");

    for (const stage of ["plan", "review"] as const) {
      const mock = startMock([
        oaCall("c1", "write_file", { path: "evil.txt", content: "x" }),
        oaCall("c2", "run_command", { command: "echo hi" }),
        oaText("done"),
      ]);
      servers.push(mock.server);
      const { worktree, input } = await setup(stage);
      const events = await collect(
        new ApiWorkerDriver(() => profile(mock.baseUrl, "openai")).runTurn(input, new AbortController().signal),
      );
      const sent = mock.requests[0]!.body.tools.map((t: any) => t.function.name);
      expect(sent).not.toContain("write_file");
      expect(sent).not.toContain("edit_file");
      expect(sent).not.toContain("run_command");
      expect(sent.includes("git_diff")).toBe(stage === "review");
      const results = events.filter((e) => e.type === "tool_result") as any[];
      expect(results.every((r) => r.isError && /not available/.test(r.outputSummary))).toBe(true);
      expect(existsSync(join(worktree, "evil.txt"))).toBe(false);
    }
  });

  it("review stage git_diff is read-only and reports changes", async () => {
    const { worktree, input } = await setup("review");
    const git = async (...args: string[]) => Bun.spawn(["git", "-C", worktree, ...args], { stdout: "pipe", stderr: "pipe" }).exited;
    await git("init", "-b", "main");
    await git("-c", "user.name=t", "-c", "user.email=t@t", "add", ".");
    await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init");
    await writeFile(join(worktree, "a.txt"), "changed\n", "utf8");
    const mock = startMock([oaCall("c1", "git_diff", { mode: "diff" }), oaCall("c2", "git_diff", { base: "--output=/tmp/x" }), oaText("ok")]);
    servers.push(mock.server);
    await collect(new ApiWorkerDriver(() => profile(mock.baseUrl, "openai")).runTurn(input, new AbortController().signal));
    const toolMsgs = mock.requests[2]!.body.messages.filter((m: any) => m.role === "tool");
    expect(toolMsgs[0].content).toContain("+changed");
    expect(toolMsgs[1].content).toContain("Invalid base ref");
  });

  it("implement stage: rejects locked readOnlyPaths, blocks git push / gh pr, runs normal commands", async () => {
    const { worktree, input } = await setup("implement", { readOnlyPaths: ["tests/locked.test.ts"] });
    await mkdir(join(worktree, "tests"), { recursive: true });
    await writeFile(join(worktree, "tests/locked.test.ts"), "orig", "utf8");
    const mock = startMock([
      oaCall("c1", "write_file", { path: "tests/locked.test.ts", content: "tampered" }),
      oaCall("c2", "edit_file", { path: "tests/locked.test.ts", old_string: "orig", new_string: "x" }),
      oaCall("c3", "run_command", { command: "git push origin main" }),
      oaCall("c4", "run_command", { command: "echo ok && gh pr create" }),
      oaCall("c5", "run_command", { command: "echo from-sandbox" }),
      oaText("done"),
    ]);
    servers.push(mock.server);
    const events = await collect(
      new ApiWorkerDriver(() => profile(mock.baseUrl, "openai")).runTurn(input, new AbortController().signal),
    );
    expect(await readFile(join(worktree, "tests/locked.test.ts"), "utf8")).toBe("orig");
    const results = events.filter((e) => e.type === "tool_result") as any[];
    expect(results.slice(0, 4).every((r) => r.isError)).toBe(true);
    expect(results[4].isError).toBe(false);
    expect(results[4].outputSummary).toContain("from-sandbox");
  });

  it("recovers from malformed tool arguments and honours the iteration cap + abort + budget", async () => {
    const { input } = await setup();
    const bad = startMock([oaCall("c1", "read_file", "{not json"), oaText("recovered")]);
    servers.push(bad.server);
    const ev1 = await collect(new ApiWorkerDriver(() => profile(bad.baseUrl, "openai")).runTurn(input, new AbortController().signal));
    expect((ev1.find((e) => e.type === "tool_result") as any).isError).toBe(true);
    expect(ev1.at(-1)!.type).toBe("completed");

    const loop = startMock(Array.from({ length: 40 }, (_, i) => oaCall(`c${i}`, "list_files", {})));
    servers.push(loop.server);
    const ev2 = await collect(new ApiWorkerDriver(() => profile(loop.baseUrl, "openai")).runTurn(input, new AbortController().signal));
    expect(loop.requests).toHaveLength(28);
    expect((ev2.at(-1) as any).summary).toContain("iteration limit");

    const expensive = startMock([
      { body: { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "x", type: "function", function: { name: "list_files", arguments: "{}" } }] } }], usage: { prompt_tokens: 5_000_000, completion_tokens: 0 } } },
      oaText("never"),
    ]);
    servers.push(expensive.server);
    const ev3 = await collect(
      new ApiWorkerDriver(() => profile(expensive.baseUrl, "openai")).runTurn(
        { ...input, mandate: createDefaultMandate({ maxCostUsd: 0.5 }) },
        new AbortController().signal,
      ),
    );
    expect(ev3.at(-1)!.type).toBe("error");
    expect(expensive.requests).toHaveLength(1);

    const aborted = new AbortController();
    aborted.abort();
    const ev4 = await collect(new ApiWorkerDriver(() => profile(loop.baseUrl, "openai")).runTurn(input, aborted.signal));
    expect(ev4.some((e) => e.type === "completed")).toBe(false);
  });

  it("surfaces HTTP errors without leaking the api key", async () => {
    const mock = startMock([{ status: 401, body: { error: "bad key sk-secret-123" } }]);
    servers.push(mock.server);
    const { input } = await setup();
    const events = await collect(
      new ApiWorkerDriver(() => profile(mock.baseUrl, "openai", "sk-secret-123")).runTurn(input, new AbortController().signal),
    );
    const err = events.at(-1) as any;
    expect(err.type).toBe("error");
    expect(err.message).toContain("401");
    expect(err.message).not.toContain("sk-secret-123");
    expect(mock.requests).toHaveLength(1); // 4xx is not retried
  });

  it("per-turn baseUrl/apiKey/model overrides win over the saved profile", async () => {
    const mock = startMock([oaText("ok")]);
    servers.push(mock.server);
    const { input } = await setup();
    const driver = new ApiWorkerDriver(() => profile("http://127.0.0.1:1", "openai", "saved-key"));
    await collect(
      driver.runTurn({ ...input, baseUrl: mock.baseUrl, apiKey: "turn-key", model: "turn-model", apiPreset: "custom" }, new AbortController().signal),
    );
    expect(mock.requests[0]!.headers.get("authorization")).toBe("Bearer turn-key");
    expect(mock.requests[0]!.body.model).toBe("turn-model");
  });

  it("isAvailable requires baseUrl + model and (apiKey or localhost)", async () => {
    const avail = (p?: Partial<ApiWorkerProfile>) =>
      new ApiWorkerDriver(() => (p ? ({ preset: "custom", baseUrl: "", model: "", ...p } as ApiWorkerProfile) : undefined)).isAvailable();
    expect(await avail()).toBe(false);
    expect(await avail({ baseUrl: "https://api.x.com/v1", model: "m" })).toBe(false);
    expect(await avail({ baseUrl: "https://api.x.com/v1", model: "m", apiKey: "k" })).toBe(true);
    expect(await avail({ baseUrl: "https://api.x.com/v1", model: "", apiKey: "k" })).toBe(false);
    expect(await avail({ baseUrl: "http://localhost:11434/v1", model: "llama" })).toBe(true);
    expect(await avail({ baseUrl: "http://127.0.0.1:8080", model: "m" })).toBe(true);
    expect(await new ApiWorkerDriver(async () => profile("https://x.com", "openai")).isAvailable()).toBe(true);
    expect(new ApiWorkerDriver(() => undefined).engine).toBe("api");
  });

  it("testWorkerConnection: api ping success/failure and CLI validation", async () => {
    const ok = startMock([oaText("pong")]);
    servers.push(ok.server);
    const good = await testWorkerConnection({ engine: "api", preset: "openai", baseUrl: ok.baseUrl, model: "m", apiKey: "k" });
    expect(good.ok).toBe(true);
    expect(good.latencyMs).toBeGreaterThanOrEqual(0);
    expect(ok.requests[0]!.body.max_tokens).toBe(16);

    const an = startMock([anText("pong")]);
    servers.push(an.server);
    expect((await testWorkerConnection({ engine: "api", preset: "anthropic", baseUrl: an.baseUrl, model: "m", apiKey: "k" })).ok).toBe(true);
    expect(an.requests[0]!.path).toBe("/v1/messages");
    expect(an.requests[0]!.body.max_tokens).toBe(16);

    const bad = startMock([{ status: 401, body: { error: "nope sk-leaky" } }]);
    servers.push(bad.server);
    const fail = await testWorkerConnection({ engine: "api", preset: "deepseek", baseUrl: bad.baseUrl, model: "m", apiKey: "sk-leaky" });
    expect(fail.ok).toBe(false);
    expect(fail.message).toContain("401");
    expect(fail.message).not.toContain("sk-leaky");

    expect((await testWorkerConnection({ engine: "api", preset: "custom", baseUrl: "https://x.com", model: "m" })).ok).toBe(false);
    expect((await testWorkerConnection({ engine: "api", preset: "custom", baseUrl: "", model: "m", apiKey: "k" })).message).toContain("baseUrl");
    expect((await testWorkerConnection({ engine: "api", preset: "custom", baseUrl: "https://x.com", model: "", apiKey: "k" })).message).toContain("model");
    expect((await testWorkerConnection({ engine: "api", baseUrl: "not a url", model: "m", apiKey: "k" })).ok).toBe(false);

    // CLI engines never pass with an invalid relay URL (whether or not the binary is installed here)
    expect((await testWorkerConnection({ engine: "gemini", baseUrl: "ftp://relay" })).ok).toBe(false);
    expect((await testWorkerConnection({ engine: "mock" })).ok).toBe(false);
  });

  it("CLI custom env injection survives the sandbox env sanitizer for all four CLI engines", () => {
    expect(buildRelayEnv("claude", {})).toBeUndefined();
    expect(buildRelayEnv("claude", { baseUrl: "https://r/x", apiKey: "k1" })).toEqual({
      ANTHROPIC_BASE_URL: "https://r/x",
      ANTHROPIC_API_KEY: "k1",
      ANTHROPIC_AUTH_TOKEN: "k1",
    });
    expect(buildRelayEnv("claude", { apiKey: "k1" })).not.toHaveProperty("ANTHROPIC_BASE_URL");
    expect(buildRelayEnv("codex", { baseUrl: "https://r/o" })).toEqual({ OPENAI_BASE_URL: "https://r/o" });
    expect(buildRelayEnv("opencode", { baseUrl: "https://r/o", apiKey: "k2" })).toEqual({
      OPENAI_BASE_URL: "https://r/o",
      OPENAI_API_KEY: "k2",
    });
    expect(buildRelayEnv("gemini", { baseUrl: "https://r/g", apiKey: "k3" })).toEqual({
      GEMINI_API_KEY: "k3",
      GOOGLE_GEMINI_BASE_URL: "https://r/g",
    });

    for (const engine of ["claude", "codex", "opencode", "gemini"] as const) {
      const extraEnv = buildRelayEnv(engine, { baseUrl: "https://relay.example/v1", apiKey: "relay-key" })!;
      const wrapped = wrapCommandWithOsSandbox({
        commandArgv: ["true"],
        worktreePath: tmpdir(),
        mode: "balanced",
        engine,
        skipOuterSandbox: true,
        baseEnv: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "ambient" },
        extraEnv,
      });
      for (const [k, v] of Object.entries(extraEnv)) expect(wrapped.env[k]).toBe(v);
    }
  });

  it("ClaudeCodeDriver injects relay env into the subprocess when the turn carries baseUrl/apiKey", async () => {
    const { dir, input } = await setup("plan");
    const script = join(dir, "fake-claude.sh");
    await writeFile(
      script,
      '#!/bin/sh\nprintf \'{"type":"result","subtype":"success","result":"%s|%s|%s"}\\n\' "$ANTHROPIC_BASE_URL" "$ANTHROPIC_API_KEY" "$ANTHROPIC_AUTH_TOKEN"\n',
      "utf8",
    );
    await chmod(script, 0o755);
    const driver = new ClaudeCodeDriver(script);
    const events = await collect(
      driver.runTurn({ ...input, baseUrl: "https://relay.example/anthropic", apiKey: "relay-key" }, new AbortController().signal),
    );
    const done = events.find((e) => e.type === "completed") as any;
    expect(done.summary).toBe("https://relay.example/anthropic|relay-key|relay-key");
  });
});
