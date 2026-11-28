import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  SuperWorkKernel,
  newId,
  nowIso,
  type RepoConfig,
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
  ServiceManager,
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

describe("v1.2.0 End-to-End Capabilities (A Campaigns + B MergeTrain/Barrier + C.1 Service + D Hooks/Immutable/MCP21)", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const d of tempDirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("Pillar A: runs GoalCampaign improvement, monotonic regression rollback, 2-wave plateau Inbox pause, resume, and delivery", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v120-e2e-cmp-"));
    tempDirs.push(dir);
    const repoPath = await initRealGitRepo(dir, "cmp-app", {
      "README.md": "# Campaign App\n",
      "score.txt": "10\n",
    });

    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));

    let waveCall = 0;
    const driver = new FlexibleScriptedDriver("claude", async function* (input) {
      waveCall += 1;
      yield { type: "session_started", nativeSessionId: newId("sess"), timestamp: nowIso() };
      let nextVal = "10";
      if (input.prompt.includes("Hit target")) {
        nextVal = "35";
      } else if (waveCall === 1) {
        nextVal = "20"; // Wave 1 improves 10 -> 20
      } else if (waveCall === 2) {
        nextVal = "5"; // Wave 2 regresses -> rolled back
      } else if (waveCall === 3) {
        nextVal = "18"; // Wave 3 fails to beat 20 -> rolled back -> plateau fuse
      } else {
        nextVal = "35";
      }
      await writeFile(join(input.worktreePath, "score.txt"), `${nextVal}\n`, "utf8");
      yield { type: "completed", summary: `set score=${nextVal}`, costUsd: 0.05, timestamp: nowIso() };
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

    await store.upsertRepo({
      id: "repo_cmp",
      name: "cmp-app",
      rootPath: repoPath,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "fast",
      defaultDeliveryChannel: "local_merge",
      preferredImplementEngine: "claude",
      preferredReviewEngine: "claude",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });

    const app = createServerApp({ kernel, stateStore: store, artifactStore: artifacts });
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      const createRes = await fetch(`${baseUrl}/api/campaigns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: "repo_cmp",
          name: "Raise benchmark score",
          goalPrompt: "Optimize score.txt up to 30",
          metricCommand: "cat score.txt",
          direction: "increase",
          targetValue: 30,
          deliveryMode: "staging_branch",
          maxIterations: 6,
          maxTotalBudgetUsd: 5,
          autoStart: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const { campaign } = (await createRes.json()) as { campaign: { id: string } };

      await kernel.runUntilIdle(40);

      // Should have paused at wave 3 (1 improvement + 2 consecutive regressions/no-improve)
      const detailRes = await fetch(`${baseUrl}/api/campaigns/${campaign.id}`);
      const detail = (await detailRes.json()) as {
        campaign: {
          status: string;
          baselineValue: number;
          currentValue: number;
          stagingBranch: string;
          completedWaves: number;
        };
        waves: Array<{ waveNumber: number; status: string; rolledBack?: boolean; measuredValue?: number }>;
      };
      expect(detail.campaign.status).toBe("paused");
      expect(detail.campaign.baselineValue).toBe(10);
      expect(detail.campaign.currentValue).toBe(20);
      expect(detail.campaign.completedWaves).toBe(3);
      expect(detail.waves.find((w) => w.waveNumber === 1)?.status).toBe("improved");
      expect(detail.waves.find((w) => w.waveNumber === 2)?.rolledBack).toBe(true);
      expect(detail.waves.find((w) => w.waveNumber === 3)?.rolledBack).toBe(true);

      // Staging branch must retain rolled-back monotonic best state ("20\n"), NOT 5 or 18!
      const stagedScore = await runGit(
        ["show", `${detail.campaign.stagingBranch}:score.txt`],
        repoPath,
      );
      expect(stagedScore.stdout.trim()).toBe("20");

      // Attention Inbox holds a campaign_paused card
      const inbox = await store.listInboxItems({ repoId: "repo_cmp", status: "pending" });
      const pauseItem = inbox.find((i) => i.kind === "campaign_paused");
      expect(pauseItem).toBeDefined();

      // Human approves pause card with guidance -> resumes Wave 4 -> hits 35 >= 30 -> completed!
      const resResolve = await fetch(`${baseUrl}/api/inbox/${pauseItem!.id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "approved", note: "Hit target directly" }),
      });
      expect(resResolve.status).toBe(200);

      await kernel.runUntilIdle(30);

      const completedDetail = (await (
        await fetch(`${baseUrl}/api/campaigns/${campaign.id}`)
      ).json()) as {
        campaign: { status: string; currentValue: number; completedWaves: number };
      };
      expect(completedDetail.campaign.status).toBe("completed");
      expect(completedDetail.campaign.currentValue).toBe(35);

      // Deliver staging branch to main
      const deliverRes = await fetch(`${baseUrl}/api/campaigns/${campaign.id}/deliver`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "local_merge" }),
      });
      expect(deliverRes.status).toBe(200);
      const deliveredJson = (await deliverRes.json()) as {
        campaign: { status: string; deliveredCommitSha?: string };
      };
      expect(deliveredJson.campaign.status).toBe("delivered");
      expect(deliveredJson.campaign.deliveredCommitSha).toBeTruthy();
      expect((await readFile(join(repoPath, "score.txt"), "utf8")).trim()).toBe("35");
    } finally {
      server.stop(true);
      store.close();
    }
  }, 15_000);

  it("Pillar B: executes Smart-Bypass, 3-ticket Speculative Merge Train culprit ejection & revert, plus Cross-Repo Release Barrier", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v120-e2e-trn-"));
    tempDirs.push(dir);
    const repoTrain = await initRealGitRepo(dir, "train-app", {
      "README.md": "# Train App\n",
      "verify.mjs":
        'import { existsSync } from "node:fs"; if (existsSync("bad.txt")) { console.error("forbidden bad.txt found"); process.exit(1); }\n',
    });
    const repoApi = await initRealGitRepo(dir, "barrier-api", {
      "README.md": "# Barrier API\n",
      "src/api.ts": "export const API_V = 1;\n",
    });
    const repoWeb = await initRealGitRepo(dir, "barrier-web", {
      "README.md": "# Barrier Web\n",
      "src/web.ts": "export const WEB_V = 1;\n",
    });

    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));

    const ticketActions = new Map<string, (wtPath: string) => Promise<void>>();
    const driver = new FlexibleScriptedDriver("claude", async function* (input) {
      yield { type: "session_started", nativeSessionId: newId("sess"), timestamp: nowIso() };
      const customAction = ticketActions.get(input.ticketId);
      if (customAction) {
        await customAction(input.worktreePath);
      } else if (input.prompt.includes("## Ticket: BARRIER_API")) {
        await writeFile(join(input.worktreePath, "src/api.ts"), "export const API_V = 2;\n", "utf8");
      } else if (input.prompt.includes("## Ticket: BARRIER_WEB")) {
        await writeFile(join(input.worktreePath, "src/web.ts"), "export const WEB_V = 2;\n", "utf8");
      }
      yield { type: "completed", summary: "edited file", costUsd: 0.02, timestamp: nowIso() };
    });

    // Update verify.mjs in train-app so individual T2 passes isolated implement,
    // while combined S2 = S1(ok1.txt) + T2(bad.txt) fails integration verification!
    await writeFile(
      join(repoTrain, "verify.mjs"),
      'import { existsSync } from "node:fs"; if (existsSync("ok1.txt") && existsSync("bad.txt")) { console.error("semantic conflict ok1+bad"); process.exit(1); }\n',
      "utf8",
    );
    await runGit(["add", "verify.mjs"], repoTrain);
    await runGit(["commit", "-m", "chore: add integration verifier"], repoTrain);

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
    const mkRepo = (id: string, name: string, rootPath: string, verify?: string[]): RepoConfig => ({
      id,
      name,
      rootPath,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "fast",
      defaultDeliveryChannel: "local_merge",
      preferredImplementEngine: "claude",
      preferredReviewEngine: "claude",
      verificationCommands: verify ?? [],
      maxConcurrentWorkers: 4,
      createdAt: ts,
      updatedAt: ts,
    });
    await store.upsertRepo(mkRepo("repo_train", "train-app", repoTrain, ["node verify.mjs"]));
    await store.upsertRepo(mkRepo("repo_api", "barrier-api", repoApi));
    await store.upsertRepo(mkRepo("repo_web", "barrier-web", repoWeb));

    // 1. Smart-Bypass single local_merge ticket
    const tBypass = await kernel.createDirectTicket({
      repoId: "repo_train",
      title: "Single bypass delivery",
      description: "Write bypass.txt",
      allowedPaths: ["bypass.txt"],
    });
    ticketActions.set(tBypass.id, async (wt) => {
      await writeFile(join(wt, "bypass.txt"), "ok\n", "utf8");
    });
    await kernel.runUntilIdle(15);
    const bypassTrain = (await kernel.listMergeTrain("repo_train")).find(
      (m) => m.ticketId === tBypass.id,
    );
    expect(bypassTrain?.status).toBe("merged");
    expect(bypassTrain?.bypassedSpeculation).toBe(true);
    expect(existsSync(join(repoTrain, "bypass.txt"))).toBe(true);

    // 2. Speculative 3-ticket train: batch-prepare all 3 into outbox_pending WITHOUT flushing train first!
    // Force stage execution without auto outbox flush by raising maxStageRetries=0 on T2 so it escalates on eject.
    const t1 = await kernel.createDirectTicket({
      repoId: "repo_train",
      title: "T1 ok1",
      description: "Write ok1.txt",
      allowedPaths: ["ok1.txt"],
    });
    ticketActions.set(t1.id, async (wt) => {
      await writeFile(join(wt, "ok1.txt"), "1\n", "utf8");
    });
    const t2 = await kernel.createDirectTicket({
      repoId: "repo_train",
      title: "T2 conflict with T1",
      description: "Write bad.txt",
      allowedPaths: ["bad.txt"],
    });
    ticketActions.set(t2.id, async (wt) => {
      await writeFile(join(wt, "bad.txt"), "2\n", "utf8");
    });
    // Set T2 maxStageRetries = 0 so train ejection escalates rather than looping back into implement
    const t2Loaded = await store.getTicket(t2.id);
    await store.saveTicket({
      ...t2Loaded!,
      mandate: { ...t2Loaded!.mandate, maxStageRetries: 0 },
    });
    const t3 = await kernel.createDirectTicket({
      repoId: "repo_train",
      title: "T3 ok3",
      description: "Write ok3.txt",
      allowedPaths: ["ok3.txt"],
    });
    ticketActions.set(t3.id, async (wt) => {
      await writeFile(join(wt, "ok3.txt"), "3\n", "utf8");
    });

    // Run ticks only until all 3 enter outbox_pending (do NOT flush outbox/train between ticks!)
    for (let step = 0; step < 12; step++) {
      await kernel.tick();
      if ((kernel as unknown as { activeTicketRuns: Map<string, Promise<void>> }).activeTicketRuns.size > 0) {
        await Promise.allSettled(
          Array.from(
            (kernel as unknown as { activeTicketRuns: Map<string, Promise<void>> }).activeTicketRuns.values(),
          ),
        );
      }
      const list = await store.listTickets({ repoId: "repo_train" });
      if (
        [t1.id, t2.id, t3.id].every(
          (id) => list.find((t) => t.id === id)?.status === "outbox_pending",
        )
      ) {
        break;
      }
    }
    expect((await store.getTicket(t2.id))?.status).toBe("outbox_pending");

    const mergedTrainCount = await kernel.flushMergeTrain("repo_train");
    expect(mergedTrainCount).toBe(2); // T1 fast-forwarded, T2 ejected, T3 re-queued & merged!

    const trainEntries = await kernel.listMergeTrain("repo_train");
    expect(trainEntries.find((m) => m.ticketId === t1.id)?.status).toBe("merged");
    expect(trainEntries.find((m) => m.ticketId === t1.id)?.bypassedSpeculation).toBe(false);
    expect(trainEntries.find((m) => m.ticketId === t2.id)?.status).toBe("ejected");
    expect(trainEntries.find((m) => m.ticketId === t3.id)?.status).toBe("merged");
    expect(existsSync(join(repoTrain, "ok1.txt"))).toBe(true);
    expect(existsSync(join(repoTrain, "ok3.txt"))).toBe(true);
    expect(existsSync(join(repoTrain, "bad.txt"))).toBe(false);

    // Individual T1 safe git revert -m 1 keeps T3 intact!
    await kernel.revertTicketDelivery(t1.id);
    expect(existsSync(join(repoTrain, "ok1.txt"))).toBe(false);
    expect(existsSync(join(repoTrain, "ok3.txt"))).toBe(true);

    // 3. Cross-Repo Epic Release Barrier
    const epicRes = await kernel.createEpic({
      repoId: "repo_api",
      title: "Cross-repo synchronized release",
      description: "Update API and Web contracts atomically",
      releaseBarrier: true,
      subtasks: [
        {
          key: "api",
          repoId: "repo_api",
          title: "BARRIER_API change",
          description: "BARRIER_API update api.ts",
          template: "fast",
          allowedPaths: ["src/**"],
          dependsOnKeys: [],
          acceptanceCriteria: [],
        },
        {
          key: "web",
          repoId: "repo_web",
          title: "BARRIER_WEB change",
          description: "BARRIER_WEB update web.ts",
          template: "fast",
          allowedPaths: ["src/**"],
          dependsOnKeys: ["api"],
          acceptanceCriteria: [],
        },
      ],
    });
    const apiSub = epicRes.subtasks.find((s) => s.subtaskKey === "api")!;
    const webSub = epicRes.subtasks.find((s) => s.subtaskKey === "web")!;
    ticketActions.set(apiSub.id, async (wt) => {
      await writeFile(join(wt, "src/api.ts"), "export const API_V = 2;\n", "utf8");
    });
    ticketActions.set(webSub.id, async (wt) => {
      await writeFile(join(wt, "src/web.ts"), "export const WEB_V = 2;\n", "utf8");
    });
    expect(apiSub.barrierGroupId).toBe(epicRes.epic.id);
    expect(webSub.barrierGroupId).toBe(epicRes.epic.id);

    // Advance until API reaches outbox_pending and verify barrier_waiting + HandoverDigest unblocks Web!
    for (let i = 0; i < 6; i++) {
      await kernel.tick();
      const active = (kernel as unknown as { activeTicketRuns: Map<string, Promise<void>> }).activeTicketRuns;
      if (active.size > 0) await Promise.allSettled(Array.from(active.values()));
      const apiNow = await store.getTicket(apiSub.id);
      if (apiNow?.status === "outbox_pending") break;
    }
    await kernel.flushMergeTrain();
    const barrierStateMid = await kernel.listMergeTrain("repo_api");
    expect(barrierStateMid.find((m) => m.ticketId === apiSub.id)?.status).toBe("barrier_waiting");
    expect((await store.getTicket(apiSub.id))?.handoverDigest).toBeDefined();

    // Now finish Web -> barrier releases both API & Web atomically!
    await kernel.runUntilIdle(20);
    expect((await store.getTicket(apiSub.id))?.status).toBe("delivered");
    expect((await store.getTicket(webSub.id))?.status).toBe("delivered");
    expect(await readFile(join(repoApi, "src/api.ts"), "utf8")).toContain("API_V = 2");
    expect(await readFile(join(repoWeb, "src/web.ts"), "utf8")).toContain("WEB_V = 2");

    await kernel.stop();
    store.close();
  }, 15_000);

  it("Pillar C.1 & D & MCP 21 + CLI: enforces immutable super-work.json, lifecycle hooks, Service API, and CLI commands", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v120-e2e-hooks-"));
    tempDirs.push(dir);
    const repoPath = await initRealGitRepo(dir, "hooks-app", {
      "README.md": "# Hooks App\n",
      "super-work.json": '{"defaultTemplate":"fast"}\n',
      "src/app.ts": "export const v = 1;\n",
    });
    const hookEventsLog = join(dir, "hooks-events.log");

    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));

    const driver = new FlexibleScriptedDriver("claude", async function* (input) {
      yield { type: "session_started", nativeSessionId: newId("sess"), timestamp: nowIso() };
      if (input.prompt.includes("TAMPER_CONTRACT")) {
        await writeFile(
          join(input.worktreePath, "super-work.json"),
          '{"forbiddenPaths":[]}\n',
          "utf8",
        );
      } else if (input.prompt.includes("BLOCK_PRE_DELIVER")) {
        await writeFile(join(input.worktreePath, "block_deliver"), "1", "utf8");
      } else {
        await writeFile(join(input.worktreePath, "src/app.ts"), "export const v = 2;\n", "utf8");
      }
      yield { type: "completed", summary: "turn done", costUsd: 0.01, timestamp: nowIso() };
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

    await store.upsertRepo({
      id: "repo_hooks",
      name: "hooks-app",
      rootPath: repoPath,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "fast",
      defaultDeliveryChannel: "local_merge",
      preferredImplementEngine: "claude",
      preferredReviewEngine: "claude",
      hooks: {
        preDeliver: [
          "node -e 'if (require(\"fs\").existsSync(\"block_deliver\")) { console.error(\"blocked by policy\"); process.exit(1); }'",
        ],
        postDeliver: [
          `node -e 'require("fs").appendFileSync(${JSON.stringify(hookEventsLog)}, "post:" + process.env.SUPER_WORK_HOOK_TICKET_ID + "\\n")'`,
        ],
        onEscalate: [
          `node -e 'require("fs").appendFileSync(${JSON.stringify(hookEventsLog)}, "esc:" + process.env.SUPER_WORK_HOOK_TICKET_ID + "\\n")'`,
        ],
        timeoutSec: 30,
      },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });

    const svcManager = new ServiceManager({
      platform: "darwin",
      homeDir: dir,
      cwd: dir,
      dataDir: dir,
      execRunner: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
    });
    const app = createServerApp({
      kernel,
      stateStore: store,
      artifactStore: artifacts,
      serviceManager: svcManager,
    });
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      // 1. Worker tampering super-work.json is reverted & escalated (canExpandMandate: false) + on_escalate hook fires
      const tamperTicket = await kernel.createDirectTicket({
        repoId: "repo_hooks",
        title: "Attempt tamper",
        description: "TAMPER_CONTRACT",
        allowedPaths: ["README.md"],
      });
      await kernel.runUntilIdle(15);
      const tTamper = await store.getTicket(tamperTicket.id);
      expect(tTamper?.status).toBe("needs_human");
      const inboxTamper = (await store.listInboxItems({ ticketId: tamperTicket.id }))[0]!;
      expect(inboxTamper.kind).toBe("mandate_violation");
      expect(inboxTamper.contextPayload.canExpandMandate).toBe(false);

      // 2. pre_deliver blocking prevents delivery (disjoint allowedPaths so it doesn't wait on tamperTicket)
      const blockedTicket = await kernel.createDirectTicket({
        repoId: "repo_hooks",
        title: "Blocked pre_deliver",
        description: "BLOCK_PRE_DELIVER",
        allowedPaths: ["block_deliver"],
      });
      const blkLoaded = await store.getTicket(blockedTicket.id);
      await store.saveTicket({
        ...blkLoaded!,
        mandate: { ...blkLoaded!.mandate, maxStageRetries: 0 },
      });
      await kernel.runUntilIdle(15);
      expect((await store.getTicket(blockedTicket.id))?.status).toBe("needs_human");
      expect(existsSync(join(repoPath, "block_deliver"))).toBe(false);

      // 3. Valid ticket passes pre_deliver and executes post_deliver hook
      const cleanTicket = await kernel.createDirectTicket({
        repoId: "repo_hooks",
        title: "Clean update",
        description: "CLEAN_UPDATE",
        allowedPaths: ["src/**"],
      });
      await kernel.runUntilIdle(15);
      expect((await store.getTicket(cleanTicket.id))?.status).toBe("delivered");
      // Give async post_deliver hook a short moment if awaited or spawned
      await new Promise((r) => setTimeout(r, 100));
      const logContent = await readFile(hookEventsLog, "utf8");
      expect(logContent).toContain(`esc:${tamperTicket.id}`);
      expect(logContent).toContain(`post:${cleanTicket.id}`);

      // 4. Service status REST API + MCP 1.2.0 (21 tools) + CLI campaign/train/service
      const svcRes = await fetch(`${baseUrl}/api/system/service`);
      expect(svcRes.status).toBe(200);
      const svcJson = (await svcRes.json()) as { status: { manager: string; dataDir: string } };
      expect(svcJson.status.manager).toBe("launchd");
      expect(svcJson.status.dataDir).toBe(dir);

      const mcpInfo = (await (await fetch(`${baseUrl}/api/mcp`)).json()) as { version: string };
      expect(mcpInfo.version).toBe("1.8.2");

      const toolsList = (await (
        await fetch(`${baseUrl}/api/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        })
      ).json()) as { result: { tools: Array<{ name: string }> } };
      expect(toolsList.result.tools).toHaveLength(27);
      expect(toolsList.result.tools.some((t) => t.name === "manage_campaigns")).toBe(true);
      expect(toolsList.result.tools.some((t) => t.name === "manage_merge_train")).toBe(true);

      const cliOut: string[] = [];
      const trainCode = await runCli(["train", "list", "--json"], {
        baseUrl,
        stdout: (l) => cliOut.push(l),
        stderr: (l) => cliOut.push(l),
      });
      expect(trainCode).toBe(0);
      expect(cliOut.join("\n")).toContain("entries");

      const cmpOut: string[] = [];
      const cmpCode = await runCli(["campaign", "list", "--json"], {
        baseUrl,
        stdout: (l) => cmpOut.push(l),
        stderr: (l) => cmpOut.push(l),
      });
      expect(cmpCode).toBe(0);
      expect(cmpOut.join("\n")).toContain("campaigns");

      const svcOut: string[] = [];
      const svcCode = await runCli(["service", "status", "--json", "--data-dir", dir], {
        stdout: (l) => svcOut.push(l),
        stderr: (l) => svcOut.push(l),
      });
      expect(svcCode).toBe(0);
      expect(JSON.parse(svcOut.join("\n")).dataDir).toBe(dir);
    } finally {
      server.stop(true);
      store.close();
    }
  }, 15_000);
});
