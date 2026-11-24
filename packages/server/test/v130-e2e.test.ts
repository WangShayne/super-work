import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  SuperWorkKernel,
  newId,
  nowIso,
  type RepoConfig,
  type SelfHostRunner,
  type WorkerDriver,
  type WorkerEngineId,
  type WorkerStreamEvent,
  type WorkerTurnInput,
} from "@super-work/core";
import {
  FsArtifactStore,
  GhOutboxExecutor,
  GitWorktreeProvider,
  HeuristicControlLLM,
  SqliteStateStore,
  runGit,
} from "@super-work/drivers";
import { runCli } from "../../cli/src/index.ts";
import { createServerApp } from "../src/app.ts";

class FlexibleScriptedDriver implements WorkerDriver {
  constructor(
    readonly engine: WorkerEngineId,
    private readonly handler: (
      input: WorkerTurnInput,
      signal: AbortSignal,
    ) => AsyncGenerator<WorkerStreamEvent>,
  ) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  runTurn(input: WorkerTurnInput, signal: AbortSignal): AsyncGenerator<WorkerStreamEvent> {
    return this.handler(input, signal);
  }
}

async function initRealGitRepo(
  baseDir: string,
  name: string,
  files: Record<string, string>,
): Promise<string> {
  const repoDir = join(baseDir, name);
  await runGit(["init", "-b", "main", repoDir], baseDir);
  await runGit(["config", "user.name", "Test User"], repoDir);
  await runGit(["config", "user.email", "test@example.com"], repoDir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(repoDir, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  await runGit(["add", ...Object.keys(files)], repoDir);
  await runGit(["commit", "-m", "initial commit"], repoDir);
  return repoDir;
}

describe("v1.3.0 End-to-End Self-Hosting Capabilities (Smart Intake, Contract Defaults, Canary+Drain, Auto-Revert)", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const d of tempDirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("syncs super-work.json defaultMode/defaultDeliveryChannel and runs HTTP+CLI Smart Intake end-to-end", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v130-intake-"));
    tempDirs.push(dir);
    const repoPath = await initRealGitRepo(dir, "self-app", {
      "README.md": "# Self App\n",
      "super-work.json": JSON.stringify({
        defaultTemplate: "fast",
        defaultMode: "auto",
        defaultDeliveryChannel: "local_merge",
        deliveryGatePolicy: "always_auto",
      }),
      "src/app.ts": "export const app = 1;\n",
    });

    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));

    const driver = new FlexibleScriptedDriver("claude", async function* (input) {
      yield { type: "session_started", nativeSessionId: newId("sess"), timestamp: nowIso() };
      await mkdir(join(input.worktreePath, "src"), { recursive: true });
      await writeFile(join(input.worktreePath, "src/feature.ts"), "export const feat = true;\n", "utf8");
      yield { type: "completed", summary: "added feature.ts", costUsd: 0.02, timestamp: nowIso() };
    });

    const kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm: new HeuristicControlLLM(),
      drivers: [driver],
      outboxExecutor: new GhOutboxExecutor(workspace),
      dataDir: dir,
    });

    const ts = nowIso();
    await store.upsertRepo({
      id: "repo_self",
      name: "self-app",
      rootPath: repoPath,
      baseBranch: "main",
      mode: "observe",
      defaultTemplate: "standard",
      defaultDeliveryChannel: "auto_pr_or_branch",
      preferredImplementEngine: "claude",
      preferredReviewEngine: "claude",
      createdAt: ts,
      updatedAt: ts,
    });

    await kernel.syncRepoContract("repo_self");
    const syncedRepo = await store.getRepo("repo_self");
    expect(syncedRepo?.mode).toBe("auto");
    expect(syncedRepo?.defaultDeliveryChannel).toBe("local_merge");

    const app = createServerApp({ kernel, stateStore: store, artifactStore: artifacts });
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      const epicPreviewRes = await fetch(`${baseUrl}/api/intake/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: "repo_self",
          requirement:
            "1. Update schema in packages/core/a.ts\n2. Add API in packages/server/b.ts\n3. Update UI in packages/web/c.tsx",
        }),
      });
      expect(epicPreviewRes.status).toBe(200);
      const epicPreview = (await epicPreviewRes.json()) as {
        plan: { route: string; epicPlan?: { subtasks: unknown[] } };
      };
      expect(epicPreview.plan.route).toBe("epic_dag");
      expect(epicPreview.plan.epicPlan?.subtasks.length).toBeGreaterThanOrEqual(2);

      // CLI `intake --preview --json`
      const cliOut: string[] = [];
      const cliCode = await runCli(
        ["intake", "--repo", "repo_self", "--preview", "--json", "Add src/feature.ts module"],
        {
          baseUrl,
          stdout: (l) => cliOut.push(l),
          stderr: (l) => cliOut.push(l),
        },
      );
      expect(cliCode).toBe(0);
      const cliJson = JSON.parse(cliOut.join("\n")) as {
        plan: { route: string; singleSpec?: { allowedPaths: string[] } };
      };
      expect(cliJson.plan.route).toBe("single_ticket");
      expect(cliJson.plan.singleSpec?.allowedPaths).toContain("src/feature.ts");

      // Submit real Smart Intake requirement & execute to local_merge delivery
      const submitRes = await fetch(`${baseUrl}/api/intake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: "repo_self",
          requirement: "Implement src/feature.ts flag module",
          deliveryGatePolicy: "always_auto",
        }),
      });
      expect(submitRes.status).toBe(201);
      const submitJson = (await submitRes.json()) as {
        route: string;
        ticket?: { id: string };
      };
      expect(submitJson.route).toBe("single_ticket");
      expect(submitJson.ticket?.id).toBeTruthy();

      await kernel.runUntilIdle(15);
      const finalTicket = await store.getTicket(submitJson.ticket!.id);
      expect(finalTicket?.status).toBe("delivered");
      expect(existsSync(join(repoPath, "src/feature.ts"))).toBe(true);
    } finally {
      await kernel.stop();
      server.stop(true);
      store.close();
    }
  }, 15_000);

  it("Boot Canary PASS drains active concurrent runs, checkpoints WAL, and triggers reload cleanly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v130-drain-"));
    tempDirs.push(dir);
    const selfRepo = await initRealGitRepo(dir, "self-repo", {
      "src/core.ts": "export const v = 1;\n",
    });
    const bgRepo = await initRealGitRepo(dir, "bg-repo", {
      "src/bg.ts": "export const bg = 1;\n",
    });

    const store = new SqliteStateStore(join(dir, "state.db"));
    let walCheckpoints = 0;
    const origCheckpoint = store.checkpointWal.bind(store);
    store.checkpointWal = () => {
      walCheckpoints += 1;
      origCheckpoint();
    };

    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));

    let releaseBg!: () => void;
    const bgGate = new Promise<void>((res) => {
      releaseBg = res;
    });
    let bgTurnStarted!: () => void;
    const bgStartedPromise = new Promise<void>((res) => {
      bgTurnStarted = res;
    });

    const reloadReasons: string[] = [];
    let activeCountAtReload = -1;

    const driver = new FlexibleScriptedDriver("claude", async function* (input) {
      yield { type: "session_started", nativeSessionId: newId("sess"), timestamp: nowIso() };
      if (input.prompt.includes("SLOW_BG_TASK")) {
        bgTurnStarted();
        await bgGate;
        await writeFile(join(input.worktreePath, "src/bg.ts"), "export const bg = 2;\n", "utf8");
      } else {
        await writeFile(join(input.worktreePath, "src/core.ts"), "export const v = 2;\n", "utf8");
      }
      yield { type: "completed", summary: "turn done", costUsd: 0.01, timestamp: nowIso() };
    });

    let kernel!: SuperWorkKernel;
    const runner: SelfHostRunner = {
      selfRepoRoot: selfRepo,
      async verifyBuildAndCanaryBoot() {
        return {
          ok: true,
          buildOk: true,
          canaryPort: 18432,
          durationMs: 25,
          summary: "Boot Canary /api/health -> 200 OK",
        };
      },
      async triggerProcessReload(reason) {
        activeCountAtReload = (
          kernel as unknown as { activeTicketRuns: Map<string, Promise<void>> }
        ).activeTicketRuns.size;
        reloadReasons.push(reason);
      },
    };

    kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm: new HeuristicControlLLM(),
      drivers: [driver],
      outboxExecutor: new GhOutboxExecutor(workspace),
      selfHostRunner: runner,
      dataDir: dir,
    });

    const ts = nowIso();
    const mkRepo = (id: string, name: string, rootPath: string): RepoConfig => ({
      id,
      name,
      rootPath,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "fast",
      defaultDeliveryChannel: "local_merge",
      deliveryGatePolicy: "always_auto",
      preferredImplementEngine: "claude",
      preferredReviewEngine: "claude",
      createdAt: ts,
      updatedAt: ts,
    });
    await store.upsertRepo(mkRepo("repo_self", "self-repo", selfRepo));
    await store.upsertRepo(mkRepo("repo_bg", "bg-repo", bgRepo));

    const app = createServerApp({ kernel, stateStore: store, artifactStore: artifacts });
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      // 1. Start slow background task so an activeTicketRun stays in-flight
      await kernel.createDirectTicket({
        repoId: "repo_bg",
        title: "SLOW_BG_TASK",
        description: "SLOW_BG_TASK keep running during canary",
        allowedPaths: ["src/**"],
      });
      await kernel.tick();
      await bgStartedPromise;

      // 2. Deliver self-hosted change into selfRepo main while BG run is still active
      const selfTicket = await kernel.createDirectTicket({
        repoId: "repo_self",
        title: "Upgrade self core",
        description: "Update src/core.ts",
        allowedPaths: ["src/**"],
      });
      await kernel.tick();
      for (let i = 0; i < 20; i++) {
        const cur = await store.getTicket(selfTicket.id);
        if (cur?.status === "outbox_pending") break;
        await new Promise((r) => setTimeout(r, 40));
        await kernel.tick();
      }
      await kernel.flushMergeTrain("repo_self");

      // Drain timer starts after ~30ms; active BG run must hold phase at "draining"
      await new Promise((r) => setTimeout(r, 120));
      expect(kernel.isDraining()).toBe(true);
      expect(kernel.getSelfReloadState().phase).toBe("draining");
      expect(reloadReasons).toHaveLength(0);

      const reloadApiMid = (await (await fetch(`${baseUrl}/api/system/reload`)).json()) as {
        reload: { phase: string };
      };
      expect(reloadApiMid.reload.phase).toBe("draining");

      // 3. Unblock BG run and let drain finish cleanly -> WAL checkpoint + reload triggers
      releaseBg();
      for (let i = 0; i < 30; i++) {
        if (reloadReasons.length > 0) break;
        await new Promise((r) => setTimeout(r, 80));
      }
      expect(walCheckpoints).toBeGreaterThanOrEqual(1);
      expect(reloadReasons).toHaveLength(1);
      expect(activeCountAtReload).toBe(0);
      expect(kernel.getSelfReloadState().phase).toBe("reloading");
      expect(existsSync(join(selfRepo, "src/core.ts"))).toBe(true);
    } finally {
      releaseBg();
      await kernel.stop();
      server.stop(true);
      store.close();
    }
  }, 15_000);

  it("Boot Canary FAIL automatically git-reverts broken self-merge, keeps daemon healthy, and escalates Inbox", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v130-revert-"));
    tempDirs.push(dir);
    const selfRepo = await initRealGitRepo(dir, "self-revert", {
      "src/healthy.ts": "export const ok = true;\n",
    });

    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));
    const reloadCalls: string[] = [];

    const driver = new FlexibleScriptedDriver("claude", async function* (input) {
      yield { type: "session_started", nativeSessionId: newId("sess"), timestamp: nowIso() };
      await writeFile(join(input.worktreePath, "src/broken.ts"), "syntax_error();\n", "utf8");
      yield { type: "completed", summary: "wrote broken.ts", costUsd: 0.01, timestamp: nowIso() };
    });

    const runner: SelfHostRunner = {
      selfRepoRoot: selfRepo,
      async verifyBuildAndCanaryBoot() {
        return {
          ok: false,
          buildOk: true,
          canaryPort: 18433,
          durationMs: 35,
          summary: "Boot Canary /api/health returned HTTP 500",
          errorOutput: "ReferenceError: broken symbol during boot",
        };
      },
      async triggerProcessReload(reason) {
        reloadCalls.push(reason);
      },
    };

    const kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm: new HeuristicControlLLM(),
      drivers: [driver],
      outboxExecutor: new GhOutboxExecutor(workspace),
      selfHostRunner: runner,
      dataDir: dir,
    });

    const ts = nowIso();
    await store.upsertRepo({
      id: "repo_rev",
      name: "self-revert",
      rootPath: selfRepo,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "fast",
      defaultDeliveryChannel: "local_merge",
      deliveryGatePolicy: "always_auto",
      preferredImplementEngine: "claude",
      preferredReviewEngine: "claude",
      createdAt: ts,
      updatedAt: ts,
    });

    const app = createServerApp({ kernel, stateStore: store, artifactStore: artifacts });
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      await kernel.createDirectTicket({
        repoId: "repo_rev",
        title: "Introduce broken change",
        description: "Write src/broken.ts",
        allowedPaths: ["src/**"],
      });
      await kernel.runUntilIdle(15);

      const reloadState = kernel.getSelfReloadState();
      expect(reloadState.phase).toBe("rolled_back");
      expect(reloadState.revertCommitSha).toBeTruthy();
      expect(reloadCalls).toHaveLength(0);
      expect(existsSync(join(selfRepo, "src/broken.ts"))).toBe(false);
      expect(existsSync(join(selfRepo, "src/healthy.ts"))).toBe(true);

      const inbox = await store.listInboxItems({ repoId: "repo_rev", status: "pending" });
      expect(inbox).toHaveLength(1);
      expect(inbox[0]?.kind).toBe("watchdog_escalation");
      expect(inbox[0]?.contextPayload?.selfHostRollback).toBe(true);
      expect(inbox[0]?.contextPayload?.revertCommitSha).toBe(reloadState.revertCommitSha);

      const healthRes = await fetch(`${baseUrl}/api/health`);
      expect(healthRes.status).toBe(200);
      expect(((await healthRes.json()) as { ok: boolean }).ok).toBe(true);
    } finally {
      await kernel.stop();
      server.stop(true);
      store.close();
    }
  }, 15_000);
});
