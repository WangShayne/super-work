import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { SuperWorkKernel, type OutboxExecutor, type WorkerTurnInput, nowIso } from "@super-work/core";
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
import { createServerApp } from "../src/app.ts";

describe("First-Run Setup & CLI Scan Server API", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const d of tempDirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("reports initial CLI scan, masks API key, updates repo engines, and hot-swaps MutableControlPlaneLLM", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-setup-api-"));
    tempDirs.push(dir);

    const repoDir = join(dir, "repo");
    await runGit(["init", "-b", "main", repoDir], dir);
    await runGit(["config", "user.name", "Test User"], repoDir);
    await runGit(["config", "user.email", "test@example.com"], repoDir);
    await writeFile(join(repoDir, "README.md"), "# Demo\n", "utf8");
    await runGit(["add", "."], repoDir);
    await runGit(["commit", "-m", "init"], repoDir);

    const stateStore = new SqliteStateStore(join(dir, "state.db"));
    const artifactStore = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));
    const mutableLlm = new MutableControlPlaneLLM(new HeuristicControlLLM());

    const outboxExecutor: OutboxExecutor = {
      async execute() {
        return { mode: "local_branch_ready" };
      },
    };

    const observedTurns: Array<{ engine: string; stage: string; model?: string; effort?: string }> =
      [];
    const wrapDriver = (engine: "claude" | "codex") => {
      const inner = new MockWorkerDriver({ engine, stepDelayMs: 1 });
      return {
        engine,
        isAvailable: () => inner.isAvailable(),
        runTurn(input: WorkerTurnInput, signal: AbortSignal) {
          observedTurns.push({
            engine,
            stage: input.stage,
            model: input.model,
            effort: input.effort,
          });
          return inner.runTurn(input, signal);
        },
      };
    };

    const kernel = new SuperWorkKernel({
      stateStore,
      artifactStore,
      workspace,
      llm: mutableLlm,
      drivers: [wrapDriver("claude"), wrapDriver("codex")],
      outboxExecutor,
    });

    const ts = nowIso();
    await stateStore.upsertRepo({
      id: "repo_1",
      name: "demo",
      rootPath: repoDir,
      baseBranch: "main",
      mode: "observe",
      defaultTemplate: "standard",
      preferredImplementEngine: "mock",
      preferredReviewEngine: "mock",
      createdAt: ts,
      updatedAt: ts,
    });

    const cliScanner = new CliEnvironmentScanner({
      which: (bin) => (bin === "claude" || bin === "codex" ? `/usr/bin/${bin}` : null),
      runCmd: async (cmd) => {
        if (cmd.includes("--json")) {
          return { exitCode: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "oauth" }), stderr: "" };
        }
        return { exitCode: 0, stdout: "v1.0.0", stderr: "" };
      },
    });

    const app = createServerApp({
      kernel,
      stateStore,
      artifactStore,
      mutableLlm,
      cliScanner,
    });

    // 1. Initial status is uninitialized with live CLI scan
    const statusRes1 = await app.request("/api/setup/status");
    expect(statusRes1.status).toBe(200);
    const status1 = (await statusRes1.json()) as {
      initialized: boolean;
      activeLlmProvider: string;
      scanReport: { recommendedImplementEngine: string; recommendedReviewEngine: string };
    };
    expect(status1.initialized).toBe(false);
    expect(status1.activeLlmProvider).toBe("heuristic:local");
    expect(status1.scanReport.recommendedImplementEngine).toBe("claude");
    expect(status1.scanReport.recommendedReviewEngine).toBe("codex");

    // 2. Test heuristic connection
    const testRes = await app.request("/api/setup/test-llm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ llmPreset: "heuristic", llmBaseUrl: "", llmModel: "heuristic" }),
    });
    expect(testRes.status).toBe(200);
    expect(((await testRes.json()) as { ok: boolean }).ok).toBe(true);

    // 3. Configure DeepSeek API key + preferred engines -> key is masked in response and LLM hot-swaps!
    const cfgRes = await app.request("/api/setup/configure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        llmPreset: "deepseek",
        llmBaseUrl: "https://api.deepseek.com/v1",
        llmModel: "deepseek-chat",
        llmEffort: "low",
        llmApiKey: "sk-secret-1234567890abcd",
        preferredImplementEngine: "claude",
        preferredReviewEngine: "codex",
        claudeProfile: { model: "opus", effort: "high" },
        codexProfile: { model: "gpt-5.6-sol", effort: "xhigh" },
      }),
    });
    expect(cfgRes.status).toBe(200);
    const cfg = (await cfgRes.json()) as {
      initialized: boolean;
      activeLlmProvider: string;
      config: {
        hasApiKey: boolean;
        maskedApiKey?: string;
        llmApiKey?: string;
        claudeProfile?: { model?: string; effort?: string };
        codexProfile?: { model?: string; effort?: string };
      };
    };
    expect(cfg.initialized).toBe(true);
    expect(cfg.activeLlmProvider).toBe("deepseek:deepseek-chat");
    expect(cfg.config.hasApiKey).toBe(true);
    expect(cfg.config.maskedApiKey).toBe("sk-****abcd");
    expect(cfg.config.llmApiKey).toBeUndefined();
    expect(cfg.config.claudeProfile).toEqual({ model: "opus", effort: "high" });
    expect(cfg.config.codexProfile).toEqual({ model: "gpt-5.6-sol", effort: "xhigh" });

    // Per-ticket model/effort override persists through POST /api/tickets
    const ticketRes = await app.request("/api/tickets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoId: "repo_1",
        title: "Test overrides",
        description: "Verify override fields",
        preferredEngine: "claude",
        modelOverride: "sonnet",
        effortOverride: "low",
      }),
    });
    expect(ticketRes.status).toBe(201);
    const createdTicket = ((await ticketRes.json()) as { ticket: { modelOverride?: string; effortOverride?: string } }).ticket;
    expect(createdTicket.modelOverride).toBe("sonnet");
    expect(createdTicket.effortOverride).toBe("low");

    // Health reflects hot-swapped LLM provider immediately
    const healthRes = await app.request("/api/health");
    expect(((await healthRes.json()) as { llmProvider: string }).llmProvider).toBe(
      "deepseek:deepseek-chat",
    );

    // Registered repo engines updated
    const repo = await stateStore.getRepo("repo_1");
    expect(repo?.preferredImplementEngine).toBe("claude");
    expect(repo?.preferredReviewEngine).toBe("codex");

    // Drain ticket execution & confirm claude gets per-ticket overrides while codex review gets codexProfile
    await kernel.runUntilIdle();
    await kernel.stop();

    const planTurn = observedTurns.find((t) => t.stage === "plan");
    const implTurn = observedTurns.find((t) => t.stage === "implement");
    const reviewTurn = observedTurns.find((t) => t.stage === "review");
    expect(planTurn).toMatchObject({ engine: "claude", model: "sonnet", effort: "low" });
    expect(implTurn).toMatchObject({ engine: "claude", model: "sonnet", effort: "low" });
    expect(reviewTurn).toMatchObject({ engine: "codex", model: "gpt-5.6-sol", effort: "xhigh" });

    stateStore.close();
  });
});
