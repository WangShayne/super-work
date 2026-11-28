import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { type OutboxExecutor, SuperWorkKernel } from "@super-work/core";
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

const KEY = "sk-relay-SECRET-4242";

describe("v1.8.2 POST /api/setup/models | /api/setup/model", () => {
  const tempDirs: string[] = [];
  const servers: Array<{ stop: (force?: boolean) => void }> = [];
  const stores: SqliteStateStore[] = [];

  afterEach(async () => {
    for (const s of servers.splice(0)) s.stop(true);
    await new Promise((r) => setTimeout(r, 20));
    for (const st of stores.splice(0)) {
      try {
        st.close();
      } catch {
        // already closed
      }
    }
    for (const d of tempDirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  /** Local upstream that lists models and records the Authorization header it saw. */
  function upstream() {
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const path = new URL(req.url).pathname;
        seen.push(req.headers.get("authorization") ?? "");
        if (path === "/v1/models") return Response.json({ data: [{ id: "relay-a" }, { id: "relay-b" }] });
        if (path === "/v1/model") return Response.json({ id: "single" });
        return new Response("nope", { status: 404 });
      },
    });
    servers.push(server);
    return { base: `http://127.0.0.1:${server.port}/v1`, seen };
  }

  async function boot() {
    const dir = await mkdtemp(join(tmpdir(), "sw-v182-disc-"));
    tempDirs.push(dir);
    const stateStore = new SqliteStateStore(join(dir, "state.db"));
    stores.push(stateStore);
    const artifactStore = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));
    const mutableLlm = new MutableControlPlaneLLM(new HeuristicControlLLM());
    const outboxExecutor: OutboxExecutor = { async execute() { return { mode: "local_branch_ready" }; } };
    const kernel = new SuperWorkKernel({
      stateStore, artifactStore, workspace, llm: mutableLlm,
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
    return { post };
  }

  it("lists models on both /models and /model aliases", async () => {
    const { post } = await boot();
    const { base } = upstream();
    for (const path of ["/api/setup/models", "/api/setup/model"]) {
      const res = await post(path, { kind: "api", apiProtocol: "openai", baseUrl: base, apiKey: KEY });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.ok).toBe(true);
      expect(body.models.map((m: any) => m.id)).toEqual(["relay-a", "relay-b"]);
      expect(body.endpoint).toBe(`${base}/models`);
      expect(typeof body.latencyMs).toBe("number");
    }
  });

  it("supports CLI custom relays and single-object /model responses", async () => {
    const { post } = await boot();
    const { base } = upstream();
    const res = await post("/api/setup/models", { kind: "cli", cliEngine: "codex", baseUrl: base.replace("/v1", "") });
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.models.length).toBeGreaterThan(0);
  });

  it("hydrates the saved key via useSavedKey and never leaks it", async () => {
    const { post } = await boot();
    const { base, seen } = upstream();
    const cfg = await post("/api/setup/configure", {
      modelProfiles: [{ id: "relay", name: "Relay", kind: "api", apiProtocol: "openai", baseUrl: base, model: "relay-a", apiKey: KEY }],
    });
    expect(cfg.status).toBe(200);
    const res = await post("/api/setup/models", { id: "relay", kind: "api", apiProtocol: "openai", baseUrl: base, useSavedKey: true });
    const text = await res.text();
    expect(JSON.parse(text).ok).toBe(true);
    expect(seen).toContain(`Bearer ${KEY}`);
    expect(text).not.toContain(KEY);

    seen.length = 0;
    await post("/api/setup/models", { id: "relay", kind: "api", baseUrl: base, apiKey: "typed-key-7777", useSavedKey: true });
    expect(seen[0]).toBe("Bearer typed-key-7777");
  });

  it("validates baseUrl and kind", async () => {
    const { post } = await boot();
    expect((await post("/api/setup/models", { kind: "api", baseUrl: "ftp://x.test/v1", apiKey: KEY })).status).toBe(400);
    expect((await post("/api/setup/model", { kind: "api", baseUrl: "not a url", apiKey: KEY })).status).toBe(400);
    const cli = await post("/api/setup/models", { kind: "cli", cliEngine: "claude" });
    expect(cli.status).toBe(400);
    expect(((await cli.json()) as any).error).toBe("baseUrl is required");
    expect((await post("/api/setup/models", { baseUrl: "https://x.test" })).status).toBe(400);
  });

  it("reports upstream auth failures without echoing the key", async () => {
    const { post } = await boot();
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(`denied ${KEY}`, { status: 401 }) });
    servers.push(server);
    const res = await post("/api/setup/models", { kind: "api", baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: KEY });
    const text = await res.text();
    expect(JSON.parse(text).ok).toBe(false);
    expect(text).not.toContain(KEY);
  });
});
