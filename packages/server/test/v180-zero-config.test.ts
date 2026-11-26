import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { SuperWorkKernel, type OutboxExecutor, type RepoConfig } from "@super-work/core";
import {
  CliEnvironmentScanner,
  FsArtifactStore,
  GitWorktreeProvider,
  HeuristicControlLLM,
  MockWorkerDriver,
  MutableControlPlaneLLM,
  SqliteStateStore,
  runGit,
} from "@super-work/drivers";
import { runCli } from "../../cli/src/index.ts";
import { createServerApp } from "../src/app.ts";

describe("v1.8.0 zero-config server APIs & CLI do", () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    for (const d of tempDirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function setup(claudeReady: boolean) {
    const dir = await mkdtemp(join(tmpdir(), "sw-v180-"));
    tempDirs.push(dir);
    const repoDir = join(dir, "repo");
    await runGit(["init", "-b", "trunk", repoDir], dir);
    await runGit(["config", "user.name", "T"], repoDir);
    await runGit(["config", "user.email", "t@example.com"], repoDir);
    await writeFile(join(repoDir, "README.md"), "# x\n", "utf8");
    await writeFile(join(repoDir, "bun.lock"), "", "utf8");
    await writeFile(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "demo", scripts: { typecheck: "tsc", test: "bun test" } }),
      "utf8",
    );
    await runGit(["add", "."], repoDir);
    await runGit(["commit", "-m", "init"], repoDir);

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
      drivers: [new MockWorkerDriver({ engine: "mock", stepDelayMs: 1 })],
      outboxExecutor,
    });
    const cliScanner = new CliEnvironmentScanner({
      which: (bin) => (claudeReady && bin === "claude" ? "/usr/bin/claude" : null),
      runCmd: async (cmd) =>
        cmd.includes("--json")
          ? { exitCode: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "oauth" }), stderr: "" }
          : { exitCode: 0, stdout: "v1.0.0", stderr: "" },
    });
    const app = createServerApp({ kernel, stateStore, artifactStore, mutableLlm, cliScanner });
    const post = (path: string, body?: unknown) =>
      app.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    return { dir, repoDir, app, post, kernel, stateStore };
  }

  it("POST /api/repos/detect validates input and returns detected defaults", async () => {
    const { repoDir, post, dir } = await setup(false);
    expect((await post("/api/repos/detect", {})).status).toBe(400);
    expect((await post("/api/repos/detect", { rootPath: join(dir, "missing") })).status).toBe(400);
    const res = await post("/api/repos/detect", { rootPath: repoDir });
    expect(res.status).toBe(200);
    const { detected } = (await res.json()) as { detected: Record<string, unknown> };
    expect(detected.baseBranch).toBe("trunk");
    expect(detected.stackLabel).toBe("bun");
    expect(detected.verificationCommands).toEqual(["bun run typecheck", "bun run test"]);
  });

  it("POST /api/repos expands smart preset and auto-populates verification; honors overrides", async () => {
    const { repoDir, post, app } = await setup(false);
    const res = await post("/api/repos", { name: "zero", rootPath: repoDir });
    expect(res.status).toBe(201);
    const { repo } = (await res.json()) as { repo: RepoConfig };
    expect(repo.autonomyPreset).toBe("smart");
    expect(repo.mode).toBe("auto");
    expect(repo.deliveryGatePolicy).toBe("risk_gated");
    expect(repo.riskThreshold).toBe(35);
    expect(repo.baseBranch).toBe("trunk");
    expect(repo.verificationCommands).toEqual(["bun run typecheck", "bun run test"]);

    const res2 = await post("/api/repos", {
      name: "auto",
      rootPath: repoDir,
      autonomyPreset: "autonomous",
      riskThreshold: 10,
      verificationCommands: [],
    });
    const r2 = ((await res2.json()) as { repo: RepoConfig }).repo;
    expect(r2.autonomyPreset).toBe("autonomous");
    expect(r2.deliveryGatePolicy).toBe("always_auto");
    expect(r2.riskThreshold).toBe(10);
    expect(r2.verificationCommands).toEqual([]);

    // Legacy behavior: explicit mode alone does not expand a preset.
    const res3 = await post("/api/repos", { name: "legacy", rootPath: repoDir, mode: "observe" });
    const r3 = ((await res3.json()) as { repo: RepoConfig }).repo;
    expect(r3.mode).toBe("observe");
    expect(r3.deliveryGatePolicy).toBeUndefined();

    const listed = (await (await app.request("/api/repos")).json()) as { repos: RepoConfig[] };
    expect(listed.repos.find((r) => r.id === repo.id)?.autonomyPreset).toBe("smart");

    // Legacy alias on POST normalizes to the canonical preset.
    const res4 = await post("/api/repos", { name: "legacy-alias", rootPath: repoDir, autonomyPreset: "autopilot" });
    const r4 = ((await res4.json()) as { repo: RepoConfig }).repo;
    expect(r4.autonomyPreset).toBe("autonomous");
    expect(r4.deliveryGatePolicy).toBe("always_auto");
  });

  it("PATCH /api/repos/:id switches presets and lets explicit fields override", async () => {
    const { repoDir, post, app } = await setup(false);
    const { repo } = (await (await post("/api/repos", { name: "p", rootPath: repoDir })).json()) as {
      repo: RepoConfig;
    };
    const patch = (body: unknown) =>
      app.request(`/api/repos/${repo.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const a = ((await (await patch({ autonomyPreset: "guarded" })).json()) as { repo: RepoConfig }).repo;
    expect(a.autonomyPreset).toBe("guarded");
    expect(a.deliveryGatePolicy).toBe("always_signoff");

    const b = ((await (await patch({ autonomyPreset: "autonomous", sandboxMode: "strict" })).json()) as {
      repo: RepoConfig;
    }).repo;
    expect(b.deliveryGatePolicy).toBe("always_auto");
    expect(b.sandboxMode).toBe("strict");

    const listed = (await (await app.request("/api/repos")).json()) as { repos: RepoConfig[] };
    expect(listed.repos.find((r) => r.id === repo.id)?.autonomyPreset).toBe("autonomous");
  });

  it("PATCH /api/repos/:id normalizes legacy copilot / standard / autopilot aliases", async () => {
    const { repoDir, post, app } = await setup(false);
    const { repo } = (await (await post("/api/repos", { name: "alias", rootPath: repoDir })).json()) as {
      repo: RepoConfig;
    };
    const patch = async (body: unknown) =>
      ((await (
        await app.request(`/api/repos/${repo.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      ).json()) as { repo: RepoConfig }).repo;

    const cases = [
      ["copilot", "guarded", "always_signoff"],
      ["autopilot", "autonomous", "always_auto"],
      ["standard", "smart", "risk_gated"],
    ] as const;
    for (const [legacy, canonical, gate] of cases) {
      const r = await patch({ autonomyPreset: legacy });
      expect(r.autonomyPreset).toBe(canonical);
      expect(r.deliveryGatePolicy).toBe(gate);
      const listed = (await (await app.request("/api/repos")).json()) as { repos: RepoConfig[] };
      expect(listed.repos.find((x) => x.id === repo.id)?.autonomyPreset).toBe(canonical);
    }
  });

  it("syncRepoContract respects autonomyPreset from .super-work.json", async () => {
    const { repoDir, post, stateStore, app, kernel } = await setup(false);
    await writeFile(
      join(repoDir, "super-work.json"),
      // Legacy alias in a pre-v1.8.0 contract file must still expand.
      JSON.stringify({ version: 1, autonomyPreset: "autopilot", riskThreshold: 20 }),
      "utf8",
    );
    const { repo } = (await (await post("/api/repos", { name: "c", rootPath: repoDir, mode: "observe" })).json()) as {
      repo: RepoConfig;
    };
    const stored = await stateStore.getRepo(repo.id);
    expect(stored?.deliveryGatePolicy).toBe("always_auto");
    expect(stored?.riskThreshold).toBe(20);
    expect(stored?.mode).toBe("auto");

    // A later PATCH override must survive a non-forced re-sync of a changed contract.
    await app.request(`/api/repos/${repo.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deliveryGatePolicy: "always_signoff" }),
    });
    await writeFile(
      join(repoDir, "super-work.json"),
      JSON.stringify({ version: 1, autonomyPreset: "autonomous", riskThreshold: 20, conventions: "x" }),
      "utf8",
    );
    await kernel.syncRepoContract(repo.id);
    const after = await stateStore.getRepo(repo.id);
    expect(after?.conventions).toBe("x");
    expect(after?.deliveryGatePolicy).toBe("always_signoff");
  });

  it("POST /api/setup/quick-start picks the ready CLI and falls back to heuristic", async () => {
    const ready = await setup(true);
    const res = await ready.post("/api/setup/quick-start");
    expect(res.status).toBe(200);
    const status = (await res.json()) as { initialized: boolean; config: { llmPreset: string } };
    expect(status.initialized).toBe(true);
    expect(status.config.llmPreset).toBe("claude_cli");

    const none = await setup(false);
    const res2 = await none.post("/api/setup/quick-start", {});
    const status2 = (await res2.json()) as { initialized: boolean; config: { llmPreset: string } };
    expect(status2.initialized).toBe(true);
    expect(status2.config.llmPreset).toBe("heuristic");
  });

  it("CLI `do --preview` and `do` work against the daemon", async () => {
    const { repoDir, post, app, kernel } = await setup(false);
    const { repo } = (await (await post("/api/repos", { name: "cli", rootPath: repoDir })).json()) as {
      repo: RepoConfig;
    };
    kernel.start();
    const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 60 });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    try {
      const out: string[] = [];
      const io = { baseUrl, stdout: (l: string) => out.push(l), stderr: (l: string) => out.push(l) };

      expect(await runCli(["do", "Add a helper module", "--preview", "--repo", repo.id], io)).toBe(0);
      expect(out.join("\n")).toContain("Route:");

      out.length = 0;
      expect(await runCli(["do", "Add a helper module", "--repo", repo.id, "--engine", "mock", "--json"], io)).toBe(0);
      const parsed = JSON.parse(out.join("\n")) as { route: string };
      expect(typeof parsed.route).toBe("string");

      out.length = 0;
      expect(await runCli(["do"], io)).toBe(1);
      expect(out.join("\n")).toContain("requirement text is required");

      out.length = 0;
      expect(await runCli(["help"], io)).toBe(0);
      expect(out.join("\n")).toContain("Advanced / Automation");
    } finally {
      kernel.stop?.();
      server.stop(true);
    }
  });
});
