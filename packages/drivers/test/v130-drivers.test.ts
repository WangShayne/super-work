import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  createDefaultMandate,
  newId,
  nowIso,
  type RepoConfig,
  type Ticket,
  type WorkerTurnInput,
} from "@super-work/core";
import {
  BunSelfHostRunner,
  CliEnvironmentScanner,
  GitWorktreeProvider,
  SqliteStateStore,
  buildGeminiCliArgs,
  buildMacosSeatbeltProfile,
  buildSanitizedWorkerEnv,
  createGeminiParseState,
  parseGeminiStreamLine,
  runGit,
} from "../src/index.ts";

describe("v1.3.0 Drivers (GeminiCliDriver, Loopback Sandbox, Workspace Symlinks, Non-Starving SQLite, SelfHostRunner)", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const d of tempDirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("GeminiCliDriver: builds stage-appropriate flags and buffers delta stream-json events", () => {
    const baseInput: WorkerTurnInput = {
      ticketId: "tkt_g1",
      stageRunId: "sr_g1",
      stage: "review",
      prompt: "Audit PR changes",
      worktreePath: "/tmp/wt",
      mandate: createDefaultMandate({ allowedPaths: ["src/**"], maxCostUsd: 2 }),
      isResume: false,
      model: "gemini-2.5-pro",
      nativeSessionId: "g_sess_9",
    };

    const reviewArgs = buildGeminiCliArgs(baseInput);
    expect(reviewArgs).toEqual([
      "-p",
      "Audit PR changes",
      "-o",
      "stream-json",
      "--skip-trust",
      "--approval-mode",
      "plan",
      "-m",
      "gemini-2.5-pro",
      "-r",
      "g_sess_9",
    ]);

    const implArgs = buildGeminiCliArgs({ ...baseInput, stage: "implement", nativeSessionId: undefined });
    expect(implArgs).toContain("yolo");
    expect(implArgs).not.toContain("-r");

    const state = createGeminiParseState();
    expect(parseGeminiStreamLine('{"type":"init","session_id":"gem_123"}', state)[0]).toEqual(
      expect.objectContaining({ type: "session_started", nativeSessionId: "gem_123" }),
    );
    expect(
      parseGeminiStreamLine('{"type":"message","role":"assistant","content":"Hello ","delta":true}', state),
    ).toEqual([]);
    expect(
      parseGeminiStreamLine('{"type":"message","role":"assistant","content":"world","delta":true}', state),
    ).toEqual([]);

    const toolEvents = parseGeminiStreamLine(
      '{"type":"tool_use","tool_name":"read_file","tool_id":"call_1","parameters":{"path":"a.ts"}}',
      state,
    );
    expect(toolEvents.map((e) => e.type)).toEqual(["text", "tool_use"]);
    expect((toolEvents[0] as { text: string }).text).toBe("Hello world");

    const toolRes = parseGeminiStreamLine(
      '{"type":"tool_result","tool_id":"call_1","status":"success","output":"file body"}',
      state,
    );
    expect(toolRes[0]).toEqual(
      expect.objectContaining({ type: "tool_result", toolName: "read_file", isError: false }),
    );

    const endEvents = parseGeminiStreamLine(
      '{"type":"result","status":"success","stats":{"input_tokens":1000,"output_tokens":200}}',
      state,
    );
    expect(endEvents.map((e) => e.type)).toEqual(["usage", "completed"]);
    expect((endEvents[0] as { costUsd: number }).costUsd).toBe(0.0022);
  });

  it("CliEnvironmentScanner: probes Gemini CLI version, auth config, and local default model", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "sw-gemini-home-"));
    tempDirs.push(fakeHome);
    await mkdir(join(fakeHome, ".gemini"), { recursive: true });
    await writeFile(
      join(fakeHome, ".gemini", "settings.json"),
      JSON.stringify({
        model: { name: "gemini-2.5-pro" },
        security: { auth: { selectedType: "oauth-personal" } },
      }),
      "utf8",
    );

    const scanner = new CliEnvironmentScanner({
      homeDir: fakeHome,
      which: (bin) => `/opt/bin/${bin}`,
      runCmd: async (cmd) => {
        if ((cmd[0] ?? "").endsWith("gemini") && cmd[1] === "--version") {
          return { exitCode: 0, stdout: "0.66.0", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "" };
      },
    });

    const report = await scanner.scanAll();
    const gemini = report.tools.find((t) => t.id === "gemini");
    expect(gemini?.installed).toBe(true);
    expect(gemini?.version).toBe("0.66.0");
    expect(gemini?.authenticated).toBe(true);
    expect(gemini?.authSummary).toBe("oauth-personal");
    expect(gemini?.localDefaultModel).toBe("gemini-2.5-pro");
  });

  it("OS Sandbox: isolates gemini credentials and preserves localhost loopback in balanced mode only", () => {
    const env = buildSanitizedWorkerEnv({
      engine: "gemini",
      baseEnv: {
        PATH: "/usr/bin",
        GEMINI_API_KEY: "gem-key",
        GOOGLE_API_KEY: "goo-key",
        ANTHROPIC_API_KEY: "ant-secret",
        SUPER_WORK_TOKEN: "sw-secret",
      },
    });
    expect(env.GEMINI_API_KEY).toBe("gem-key");
    expect(env.GOOGLE_API_KEY).toBe("goo-key");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.SUPER_WORK_TOKEN).toBeUndefined();

    const balancedProfile = buildMacosSeatbeltProfile({
      worktreePath: "/tmp/wt",
      sandboxTempDir: "/tmp/wt-tmp",
      mode: "balanced",
      allowNetwork: false,
      homeDir: "/Users/demo",
    });
    expect(balancedProfile).toContain("(deny network*)");
    expect(balancedProfile).toContain('(allow network-bind (local ip "localhost:*"))');
    expect(balancedProfile).toContain("(allow network* (local unix-socket) (remote unix-socket))");

    const strictProfile = buildMacosSeatbeltProfile({
      worktreePath: "/tmp/wt",
      sandboxTempDir: "/tmp/wt-tmp",
      mode: "strict",
      allowNetwork: false,
      homeDir: "/Users/demo",
    });
    expect(strictProfile).toContain("(deny network*)");
    expect(strictProfile).not.toContain('localhost:*"');
  });

  it("GitWorktreeProvider: links local monorepo packages/* into detached worktree node_modules", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v130-wt-"));
    tempDirs.push(dir);
    const repoDir = join(dir, "mono");
    await runGit(["init", "-b", "main", repoDir], dir);
    await runGit(["config", "user.name", "Test User"], repoDir);
    await runGit(["config", "user.email", "test@example.com"], repoDir);
    await writeFile(join(repoDir, ".gitignore"), "node_modules/\n", "utf8");
    await mkdir(join(repoDir, "packages/alpha"), { recursive: true });
    await writeFile(
      join(repoDir, "packages/alpha/package.json"),
      JSON.stringify({ name: "@demo/alpha", version: "1.0.0" }),
      "utf8",
    );
    await mkdir(join(repoDir, "node_modules"), { recursive: true });
    await writeFile(join(repoDir, "node_modules/.seed"), "seed\n", "utf8");
    await runGit(["add", ".gitignore", "packages/alpha/package.json"], repoDir);
    await runGit(["commit", "-m", "init monorepo"], repoDir);

    const provider = new GitWorktreeProvider(join(dir, "worktrees"));
    const ts = nowIso();
    const repo: RepoConfig = {
      id: "repo_mono",
      name: "mono",
      rootPath: repoDir,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "fast",
      defaultTddMode: false,
      preferredImplementEngine: "claude",
      preferredReviewEngine: "claude",
      createdAt: ts,
      updatedAt: ts,
    };
    const ticket: Ticket = {
      id: "tkt_mono_1",
      repoId: repo.id,
      threadId: "thr_1",
      sourceTriggerId: "trg_1",
      title: "Test workspace link",
      description: "desc",
      status: "implementing",
      template: "fast",
      currentStage: "implement",
      stageRetries: 0,
      mandate: createDefaultMandate({ allowedPaths: ["packages/alpha/**"], maxCostUsd: 1 }),
      dependsOn: [],
      nativeSessions: {},
      inlineMemory: {
        goal: "goal",
        acceptanceCriteria: [],
        stageNotes: [],
        threadUpdates: [],
      },
      costUsd: 0,
      priority: 1,
      createdAt: ts,
      updatedAt: ts,
    };

    const ws = await provider.prepareWorkspace(ticket, repo);
    const linkedPkg = join(ws.worktreePath, "node_modules/@demo/alpha");
    expect(existsSync(linkedPkg)).toBe(true);
    expect(lstatSync(linkedPkg).isSymbolicLink()).toBe(true);
    expect(realpathSync(linkedPkg)).toBe(realpathSync(join(ws.worktreePath, "packages/alpha")));
    expect(JSON.parse(readFileSync(join(linkedPkg, "package.json"), "utf8")).name).toBe("@demo/alpha");

    await provider.cleanupWorkspace(ws.worktreePath, repoDir);
  });

  it("SqliteStateStore & BunSelfHostRunner: excludes local_merge in SQL claims, checkpoints WAL, and runs Boot Canary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v130-db-"));
    tempDirs.push(dir);
    const store = new SqliteStateStore(join(dir, "state.db"));
    const ts = nowIso();
    await store.upsertRepo({
      id: "repo_sql",
      name: "sql-app",
      rootPath: dir,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "fast",
      defaultTddMode: false,
      preferredImplementEngine: "claude",
      preferredReviewEngine: "claude",
      createdAt: ts,
      updatedAt: ts,
    });

    for (let i = 0; i < 6; i++) {
      await store.enqueueOutbox({
        id: newId("obx"),
        repoId: "repo_sql",
        ticketId: `tkt_m_${i}`,
        action: "local_merge",
        idempotencyKey: `k_m_${i}`,
        payload: {},
        status: "pending",
        attempts: 0,
        nextAttemptAt: ts,
        createdAt: `2026-01-01T00:00:0${i}.000Z`,
        updatedAt: ts,
      });
    }
    await store.enqueueOutbox({
      id: "obx_pr_target",
      repoId: "repo_sql",
      ticketId: "tkt_pr",
      action: "push_and_create_pr",
      idempotencyKey: "k_pr",
      payload: {},
      status: "pending",
      attempts: 0,
      nextAttemptAt: ts,
      createdAt: "2026-01-01T00:00:09.000Z",
      updatedAt: ts,
    });

    const claimed = await store.claimNextOutboxEntries(5, nowIso(), ["local_merge"]);
    expect(claimed.map((e) => e.id)).toEqual(["obx_pr_target"]);
    expect(() => store.checkpointWal()).not.toThrow();
    store.close();

    // Test BunSelfHostRunner build fail and real ephemeral health canary boot
    const failingRunner = new BunSelfHostRunner({
      selfRepoRoot: dir,
      buildCommand: [process.execPath, "-e", "process.exit(2)"],
      onTriggerReload: async () => {},
    });
    const buildFail = await failingRunner.verifyBuildAndCanaryBoot();
    expect(buildFail.ok).toBe(false);
    expect(buildFail.buildOk).toBe(false);

    const canaryScript = join(dir, "canary-server.ts");
    await writeFile(
      canaryScript,
      `Bun.serve({
        hostname: "127.0.0.1",
        port: Number(process.env.PORT),
        fetch(req) {
          if (new URL(req.url).pathname === "/api/health") {
            return Response.json({ ok: true });
          }
          return new Response("not found", { status: 404 });
        },
      });`,
      "utf8",
    );
    const passingRunner = new BunSelfHostRunner({
      selfRepoRoot: dir,
      serverEntryPath: canaryScript,
      buildCommand: [],
      canaryTimeoutMs: 5_000,
      onTriggerReload: async () => {},
    });
    const canaryOk = await passingRunner.verifyBuildAndCanaryBoot();
    expect(canaryOk.ok).toBe(true);
    expect(canaryOk.buildOk).toBe(true);
    expect(canaryOk.canaryPort).toBeGreaterThan(0);
  }, 15_000);
});
