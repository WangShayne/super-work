import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  SuperWorkKernel,
  newId,
  nowIso,
  type EpicReplanProposal,
  type OutboxExecutor,
  type RepoConfig,
  type Ticket,
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
  MockWorkerDriver,
  SqliteStateStore,
  runGit,
} from "@super-work/drivers";
import { runCli } from "../../cli/src/index.ts";
import { createServerApp } from "../src/app.ts";

async function createGitRepo(baseDir: string, name: string): Promise<string> {
  const repoDir = join(baseDir, name);
  await runGit(["init", "-b", "main", repoDir], baseDir);
  await runGit(["config", "user.name", "Test User"], repoDir);
  await runGit(["config", "user.email", "test@example.com"], repoDir);
  await mkdir(join(repoDir, "src"), { recursive: true });
  await writeFile(join(repoDir, "README.md"), `# ${name}\n`, "utf8");
  await writeFile(join(repoDir, "src/index.ts"), `export const repo = ${JSON.stringify(name)};\n`, "utf8");
  await runGit(["add", "."], repoDir);
  await runGit(["commit", "-m", "initial commit"], repoDir);
  return repoDir;
}

class CustomEngineScriptedDriver implements WorkerDriver {
  constructor(
    readonly engine: WorkerEngineId,
    private readonly handler: (
      input: WorkerTurnInput,
      signal: AbortSignal,
    ) => Promise<{
      summary: string;
      writeFiles?: Record<string, string>;
      error?: string;
      costUsd?: number;
      text?: string;
    }>,
  ) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async *runTurn(input: WorkerTurnInput, signal: AbortSignal): AsyncGenerator<WorkerStreamEvent> {
    yield { type: "session_started", nativeSessionId: newId("sess"), timestamp: nowIso() };
    const result = await this.handler(input, signal);
    if (result.error) {
      yield { type: "error", message: result.error, fatal: true, timestamp: nowIso() };
      return;
    }
    if (result.writeFiles) {
      for (const [relPath, content] of Object.entries(result.writeFiles)) {
        const full = join(input.worktreePath, relPath);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, content, "utf8");
      }
    }
    if (result.text) {
      yield { type: "text", text: result.text, timestamp: nowIso() };
    }
    const cost = result.costUsd ?? 0.03;
    yield { type: "usage", costUsd: cost, timestamp: nowIso() };
    yield {
      type: "completed",
      summary: result.summary,
      costUsd: cost,
      structuredOutput: {
        verificationPassed: true,
        ...(input.stage === "review" ? { approved: true, reviewFindings: [] } : {}),
      },
      timestamp: nowIso(),
    };
  }
}

describe("v0.7.0 End-to-End Capabilities (A.1 Routines + B.1 Fallback & Arena + C.1 Adaptive Epic + C.2 Casebook & Prune)", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("A.1 Probe-to-Promote Routines: clean probes leave zero tickets/worktrees, fixes promote to Ticket, overlap skips, and CLI routine commands work", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v070-routine-"));
    tempDirs.push(dir);
    const repoPath = await createGitRepo(dir, "patrol-app");

    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));

    let probeCount = 0;
    const probeDriver = new CustomEngineScriptedDriver("claude", async (input) => {
      if (input.stage === "implement" && input.ticketId.startsWith("prb_")) {
        probeCount += 1;
        if (probeCount === 1) {
          return {
            summary: "All tests passed. ROUTINE_VERDICT: CLEAN",
            text: "ROUTINE_VERDICT: CLEAN",
          };
        }
        return {
          summary: "Fixed missing health export in src/health.ts",
          writeFiles: {
            "src/health.ts": "export function checkHealth() { return { ok: true }; }\n",
          },
        };
      }
      return { summary: `${input.stage} ok`, text: "VERDICT: APPROVED" };
    });
    const reviewDriver = new MockWorkerDriver({ engine: "codex", stepDelayMs: 2 });

    const outboxExec: OutboxExecutor = {
      async execute(_entry, _repo, ticket) {
        return { prUrl: `local://pr/${ticket.id}` };
      },
    };

    const kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm: new HeuristicControlLLM(),
      drivers: [probeDriver, reviewDriver],
      outboxExecutor: outboxExec,
      config: { maxConcurrentWorkers: 2 },
    });

    const ts = nowIso();
    await store.upsertRepo({
      id: "repo_patrol",
      name: "patrol-app",
      rootPath: repoPath,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "fast",
      preferredImplementEngine: "claude",
      preferredReviewEngine: "codex",
      autoCleanupWorktree: true,
      defaultDeliveryChannel: "local_merge",
      createdAt: ts,
      updatedAt: ts,
    });

    const app = createServerApp({ kernel, stateStore: store, artifactStore: artifacts });
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      // 1. Add routine via CLI
      const cliOut: string[] = [];
      const addCode = await runCli(
        [
          "routine",
          "add",
          "Nightly Health Check",
          "-d",
          "Inspect exports and fix any missing health check",
          "--every",
          "60",
          "--repo",
          "repo_patrol",
          "--json",
        ],
        { baseUrl, stdout: (l) => cliOut.push(l) },
      );
      expect(addCode).toBe(0);
      const createdRoutine = JSON.parse(cliOut.join("\n")).routine as { id: string };

      // 2. First probe is CLEAN -> zero tickets, zero leftover probe worktrees
      const run1Res = await fetch(`${baseUrl}/api/routines/${createdRoutine.id}/run`, {
        method: "POST",
      });
      const run1Body = (await run1Res.json()) as { run: { status: string; promotedTicketId?: string } };
      expect(run1Body.run.status).toBe("clean");
      expect(run1Body.run.promotedTicketId).toBeUndefined();
      expect(await store.listTickets({ repoId: "repo_patrol" })).toHaveLength(0);
      expect(await workspace.listWorktreeDirs()).toHaveLength(0);

      // 3. Second probe finds & edits fix -> promotes to Ticket!
      const run2Res = await fetch(`${baseUrl}/api/routines/${createdRoutine.id}/run`, {
        method: "POST",
      });
      const run2Body = (await run2Res.json()) as { run: { status: string; promotedTicketId?: string } };
      expect(run2Body.run.status).toBe("promoted");
      expect(run2Body.run.promotedTicketId).toBeTruthy();

      // Verify overlap guard skips triggering a duplicate ticket while promoted ticket is still active
      // Wait first check: right after probe with `fast` template + `auto` mode, if gate passed, it queued `rebase`
      const promoted = await store.getTicket(run2Body.run.promotedTicketId!);
      expect(promoted?.routineId).toBe(createdRoutine.id);

      const run3Res = await fetch(`${baseUrl}/api/routines/${createdRoutine.id}/run`, {
        method: "POST",
      });
      const run3Body = (await run3Res.json()) as { run: { status: string } };
      expect(run3Body.run.status).toBe("skipped_overlap");

      // Finish ticket delivery -> clears routine.activeTicketId
      await kernel.runUntilIdle(10);
      const delivered = await store.getTicket(run2Body.run.promotedTicketId!);
      expect(delivered?.status).toBe("delivered");
      const refreshedRoutine = await store.getRoutine(createdRoutine.id);
      expect(refreshedRoutine?.activeTicketId).toBeUndefined();

      const runsOut: string[] = [];
      const runsCode = await runCli(
        ["routine", "runs", "--routine", createdRoutine.id],
        { baseUrl, stdout: (l) => runsOut.push(l) },
      );
      expect(runsCode).toBe(0);
      expect(runsOut.join("\n")).toContain("skipped_overlap");
      expect(runsOut.join("\n")).toContain("clean");
      expect(runsOut.join("\n")).toContain("promoted");
    } finally {
      server.stop(true);
      store.close();
    }
  });

  it("B.1 automatically falls back across engines on CLI error AND supports Arena Duel in observe & auto modes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v070-b1-"));
    tempDirs.push(dir);
    const repoPath = await createGitRepo(dir, "arena-app");

    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));

    let failClaudeOnce = true;
    const claudeDriver = new CustomEngineScriptedDriver("claude", async (input) => {
      if (failClaudeOnce) {
        failClaudeOnce = false;
        return { summary: "", error: "429 rate limit exceeded on claude" };
      }
      return {
        summary: "Claude concise impl",
        costUsd: 0.05,
        writeFiles: {
          "src/feature.ts": `export const impl = 'claude_${input.ticketId}';\n`,
        },
      };
    });

    const codexDriver = new CustomEngineScriptedDriver("codex", async (input) => {
      if (input.stage === "review") {
        return { summary: "Review passed VERDICT: APPROVED", text: "VERDICT: APPROVED" };
      }
      return {
        summary: "Codex concise winning impl",
        costUsd: 0.03,
        writeFiles: {
          "src/feature.ts": `export const impl = 'codex_${input.ticketId}';\n`,
        },
      };
    });

    const kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm: new HeuristicControlLLM(),
      drivers: [claudeDriver, codexDriver],
      outboxExecutor: new GhOutboxExecutor(workspace),
      config: { maxConcurrentWorkers: 4 },
    });

    const ts = nowIso();
    await store.upsertRepo({
      id: "repo_arena",
      name: "arena-app",
      rootPath: repoPath,
      baseBranch: "main",
      mode: "observe",
      defaultTemplate: "fast",
      preferredImplementEngine: "claude",
      preferredReviewEngine: "codex",
      fallbackEngines: ["codex"],
      defaultDeliveryChannel: "local_merge",
      autoCleanupWorktree: true,
      createdAt: ts,
      updatedAt: ts,
    });

    const app = createServerApp({ kernel, stateStore: store, artifactStore: artifacts });
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      // 1. Engine Fallback Chain: Claude returns 429 error -> auto handoff to Codex -> delivered!
      const fbTicket = await kernel.createDirectTicket({
        repoId: "repo_arena",
        title: "Fallback Test Task",
        description: "Fallback Test: implement feature despite primary engine 429 rate limit",
        template: "fast",
        allowedPaths: ["src/**"],
      });
      await kernel.runUntilIdle(10);
      const fbDone = await store.getTicket(fbTicket.id);
      expect(fbDone?.status).toBe("delivered");
      const fbRuns = await store.listStageRuns(fbTicket.id);
      expect(fbRuns.some((r) => r.engine === "claude" && r.status === "failed")).toBe(true);
      expect(fbRuns.some((r) => r.engine === "codex" && r.status === "completed")).toBe(true);

      // 2. Arena Duel in observe mode via CLI `--arena codex`
      const dispOut: string[] = [];
      const dCode = await runCli(
        [
          "dispatch",
          "Arena Observe Task",
          "-d",
          "Compare two implementations in src/feature.ts",
          "--repo",
          "repo_arena",
          "--paths",
          "src/**",
          "--template",
          "fast",
          "--arena",
          "codex",
          "--json",
        ],
        { baseUrl, stdout: (l) => dispOut.push(l) },
      );
      expect(dCode).toBe(0);
      const arenaTicket = JSON.parse(dispOut.join("\n")).ticket as Ticket;
      await kernel.runUntilIdle(8);

      const tied = await store.getTicket(arenaTicket.id);
      expect(tied?.status).toBe("needs_human");
      expect(tied?.arenaCandidates?.length).toBe(2);

      // Inspect GET /api/tickets/:id returns diffs for both candidates
      const detailRes = await fetch(`${baseUrl}/api/tickets/${arenaTicket.id}`);
      const detail = (await detailRes.json()) as {
        arenaCandidateDiffs?: Record<string, string>;
      };
      expect(detail.arenaCandidateDiffs?.cand_a).toContain("claude");
      expect(detail.arenaCandidateDiffs?.cand_b).toContain("codex");

      const inboxItems = await store.listInboxItems({ ticketId: arenaTicket.id, status: "pending" });
      const tieItem = inboxItems.find((i) => i.kind === "arena_tiebreak");
      expect(tieItem).toBeDefined();

      // Approve candidate B via CLI `--winner cand_b`
      const approveCode = await runCli(
        ["inbox", "approve", tieItem!.id, "--winner", "cand_b"],
        { baseUrl, stdout: () => {} },
      );
      expect(approveCode).toBe(0);
      await kernel.runUntilIdle(10);

      const arenaDone = await store.getTicket(arenaTicket.id);
      expect(arenaDone?.status).toBe("delivered");
      expect(arenaDone?.arenaWinnerId).toBe("cand_b");
      const featureCode = await readFile(join(repoPath, "src/feature.ts"), "utf8");
      expect(featureCode).toContain("codex");

      // 3. Arena Duel in auto mode -> automatically picks winner without Inbox tiebreak
      await store.upsertRepo({
        ...(await store.getRepo("repo_arena"))!,
        mode: "auto",
        updatedAt: nowIso(),
      });
      const autoArena = await kernel.createDirectTicket({
        repoId: "repo_arena",
        title: "Arena Auto Task",
        description: "Auto tie-break",
        template: "fast",
        allowedPaths: ["src/**"],
        arenaMode: true,
        arenaCompetitorEngine: "codex",
      });
      await kernel.runUntilIdle(10);
      const autoDone = await store.getTicket(autoArena.id);
      expect(autoDone?.status).toBe("delivered");
      expect(autoDone?.arenaWinnerId).toBeTruthy();
      expect(
        (await store.listInboxItems({ ticketId: autoArena.id })).some(
          (i) => i.kind === "arena_tiebreak",
        ),
      ).toBe(false);
    } finally {
      server.stop(true);
      store.close();
    }
  });

  it("C.1 executes Adaptive Epic Re-planning (auto in-scope refinement + human-approved topology add/skip & rewiring)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v070-c1-"));
    tempDirs.push(dir);
    const repoPath = await createGitRepo(dir, "adaptive-epic");

    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));

    const seenDescriptions = new Map<string, string>();
    const implDriver = new CustomEngineScriptedDriver("claude", async (input) => {
      seenDescriptions.set(input.ticketId, input.prompt);
      const rel =
        input.mandate.allowedPaths[0] === "**"
          ? `src/${input.ticketId}.ts`
          : `${input.mandate.allowedPaths[0]!.replace(/\/\*\*$/, "")}/${input.ticketId}.ts`;
      return {
        summary: `Completed ${rel}`,
        writeFiles: {
          [rel]: `export function api_${input.ticketId}() { return true; }\n`,
        },
      };
    });

    let llmCallCount = 0;
    const baseLlm = new HeuristicControlLLM();
    const llm = {
      providerName: "test-c1",
      triageTrigger: baseLlm.triageTrigger.bind(baseLlm),
      diagnoseWatchdog: baseLlm.diagnoseWatchdog.bind(baseLlm),
      async proposeEpicReplan(input: {
        completedSubtask: Ticket;
        unstartedSubtasks: Ticket[];
      }): Promise<EpicReplanProposal | null> {
        llmCallCount += 1;
        if (input.completedSubtask.subtaskKey === "s1") {
          // Round 1: in-scope refinement -> auto-applied!
          const s2 = input.unstartedSubtasks.find((u) => u.subtaskKey === "s2");
          if (!s2) return null;
          return {
            shouldReplan: true,
            requiresHumanApproval: false,
            summary: "Refine s2 with finalized s1 signature",
            triggeredByTicketId: input.completedSubtask.id,
            mutations: [
              {
                kind: "update_subtask",
                targetSubtaskKey: "s2",
                description: `${s2.description}\nIN_SCOPE_SYNC: call api_${input.completedSubtask.id}()`,
                reason: "Sync s1 contract",
              },
            ],
            createdAt: nowIso(),
          };
        }
        if (input.completedSubtask.subtaskKey === "s2") {
          // Round 2: topology mutation (skip s3 & add s_glue outside original scope) -> needs human approval!
          const s3 = input.unstartedSubtasks.find((u) => u.subtaskKey === "s3");
          if (!s3) return null;
          return {
            shouldReplan: true,
            requiresHumanApproval: false, // Kernel deterministically overrides this to true!
            summary: "Skip redundant s3 and insert s_glue integration step",
            triggeredByTicketId: input.completedSubtask.id,
            mutations: [
              {
                kind: "skip_subtask",
                targetSubtaskKey: "s3",
                reason: "Merged into s2 directly",
              },
              {
                kind: "add_subtask",
                targetSubtaskKey: "s_glue",
                title: "Glue doc integration",
                description: "Update README glue notes",
                allowedPaths: ["docs/**"],
                dependsOnKeys: ["s2"],
                reason: "Requires docs/** outside subtask scope",
              },
            ],
            createdAt: nowIso(),
          };
        }
        return null;
      },
    };

    const kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm,
      drivers: [implDriver],
      outboxExecutor: new GhOutboxExecutor(workspace),
      config: { maxConcurrentWorkers: 2 },
    });

    const ts = nowIso();
    await store.upsertRepo({
      id: "repo_epic",
      name: "adaptive-epic",
      rootPath: repoPath,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "fast",
      preferredImplementEngine: "claude",
      preferredReviewEngine: "claude",
      defaultDeliveryChannel: "local_merge",
      autoCleanupWorktree: true,
      createdAt: ts,
      updatedAt: ts,
    });

    const { epic } = await kernel.createEpic({
      repoId: "repo_epic",
      title: "Adaptive Epic",
      description: "Test dynamic DAG replan",
      template: "fast",
      epicDeliveryMode: "unified",
      subtasks: [
        {
          key: "s1",
          title: "Step 1 Core",
          description: "Core module",
          template: "fast",
          allowedPaths: ["src/core/**"],
          dependsOnKeys: [],
          acceptanceCriteria: ["Done"],
        },
        {
          key: "s2",
          title: "Step 2 Service",
          description: "Service module",
          template: "fast",
          allowedPaths: ["src/service/**"],
          dependsOnKeys: ["s1"],
          acceptanceCriteria: ["Done"],
        },
        {
          key: "s3",
          title: "Step 3 Legacy Cleanup",
          description: "Redundant step",
          template: "fast",
          allowedPaths: ["src/legacy/**"],
          dependsOnKeys: ["s2"],
          acceptanceCriteria: ["Done"],
        },
        {
          key: "s4",
          title: "Step 4 Final Test",
          description: "Final tests depending on s3",
          template: "fast",
          allowedPaths: ["src/final/**"],
          dependsOnKeys: ["s3"],
          acceptanceCriteria: ["Done"],
        },
      ],
    });

    // Run until s2 finishes and triggers human epic_replan gate
    await kernel.runUntilIdle(15);

    expect(llmCallCount).toBeGreaterThanOrEqual(2);
    const pausedEpic = await store.getTicket(epic.id);
    expect(pausedEpic?.status).toBe("needs_human");
    expect(pausedEpic?.epicReplanCount).toBe(1); // Round 1 auto-applied cleanly!
    expect(pausedEpic?.pendingEpicReplan).toBeDefined();

    // Verify s2 saw Round 1's auto-applied description!
    const allSubsBefore = (await store.listTickets({ repoId: "repo_epic" })).filter(
      (t) => t.parentTicketId === epic.id,
    );
    const s2 = allSubsBefore.find((t) => t.subtaskKey === "s2")!;
    expect(seenDescriptions.get(s2.id)).toContain("IN_SCOPE_SYNC");

    // Verify s3 and s4 are still held in waiting_deps until human resolves epic_replan
    const s3Before = allSubsBefore.find((t) => t.subtaskKey === "s3")!;
    const s4Before = allSubsBefore.find((t) => t.subtaskKey === "s4")!;
    expect(s3Before.status).toBe("waiting_deps");
    expect(s4Before.status).toBe("waiting_deps");

    // Approve epic_replan in Inbox
    const inboxItems = await store.listInboxItems({ ticketId: epic.id, status: "pending" });
    const replanItem = inboxItems.find((i) => i.kind === "epic_replan");
    expect(replanItem).toBeDefined();
    await kernel.resolveInboxItem(replanItem!.id, "approved");

    // Verify s3 cancelled, s_glue added, and s4 rewired cleanly so entire Epic delivers!
    await kernel.runUntilIdle(15);

    const finalEpic = await store.getTicket(epic.id);
    expect(finalEpic?.status).toBe("delivered");
    expect(finalEpic?.epicReplanCount).toBe(2);

    const allSubsAfter = (await store.listTickets({ repoId: "repo_epic" })).filter(
      (t) => t.parentTicketId === epic.id,
    );
    expect(allSubsAfter.find((t) => t.subtaskKey === "s3")?.status).toBe("cancelled");
    expect(allSubsAfter.find((t) => t.subtaskKey === "s_glue")?.status).toBe("delivered");
    expect(allSubsAfter.find((t) => t.subtaskKey === "s4")?.status).toBe("delivered");
  });

  it("C.2 distills Casebook entries with hit tracking, flips on git revert, and prunes only unpinned stale/suspect auto_healed Playbook rules", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v070-c2-"));
    tempDirs.push(dir);
    const repoPath = await createGitRepo(dir, "casebook-app");

    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));

    const capturedPrompts: string[] = [];
    const implDriver = new CustomEngineScriptedDriver("claude", async (input) => {
      capturedPrompts.push(input.prompt);
      const target =
        input.ticketId.includes("tkt_")
          ? `src/case_${capturedPrompts.length}.ts`
          : "src/default.ts";
      return {
        summary: `Exported parseJwtClaims in ${target}`,
        writeFiles: {
          [target]: `export function parseJwtClaims_${capturedPrompts.length}(raw: string) { return raw.length > 0; }\n`,
        },
      };
    });

    const kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm: new HeuristicControlLLM(),
      drivers: [implDriver],
      outboxExecutor: new GhOutboxExecutor(workspace),
      config: { maxConcurrentWorkers: 2 },
    });

    const ts = nowIso();
    await store.upsertRepo({
      id: "repo_case",
      name: "casebook-app",
      rootPath: repoPath,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "fast",
      preferredImplementEngine: "claude",
      preferredReviewEngine: "claude",
      defaultDeliveryChannel: "local_merge",
      autoCleanupWorktree: true,
      createdAt: ts,
      updatedAt: ts,
    });

    const app = createServerApp({ kernel, stateStore: store, artifactStore: artifacts });
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      // 1. First ticket delivers & writes Casebook entry
      const t1 = await kernel.createDirectTicket({
        repoId: "repo_case",
        title: "Add JWT claims parser helper",
        description: "Implement parseJwtClaims in src/",
        template: "fast",
        allowedPaths: ["src/**"],
      });
      await kernel.runUntilIdle(10);
      expect((await store.getTicket(t1.id))?.status).toBe("delivered");

      const casesRes = await fetch(`${baseUrl}/api/repos/repo_case/casebook`);
      const casesBody = (await casesRes.json()) as { entries: Array<{ id: string; ticketId: string; reverted: boolean; hitCount: number }> };
      expect(casesBody.entries.some((c) => c.ticketId === t1.id && !c.reverted)).toBe(true);

      // Seed both a human rule and an unpinned auto_healed rule linked to t1
      await kernel.addOrUpdatePlaybookRule({
        repoId: "repo_case",
        rule: "Never mutate auth secrets in place",
        scopePaths: ["src/**"],
        source: "human",
        pinned: false,
      });
      const autoRule = await kernel.addOrUpdatePlaybookRule({
        repoId: "repo_case",
        rule: "Validate base64url padding before decoding JWT",
        scopePaths: ["src/**"],
        source: "auto_healed",
        sourceTicketId: t1.id,
        pinned: false,
      });
      expect(autoRule).toBeTruthy();

      // 2. Second ticket sees positive Casebook + Playbook hit tracking
      const t2 = await kernel.createDirectTicket({
        repoId: "repo_case",
        title: "Extend JWT claims parser validation",
        description: "Add expiry check using parseJwtClaims in src/",
        template: "fast",
        allowedPaths: ["src/**"],
      });
      await kernel.runUntilIdle(10);
      expect((await store.getTicket(t2.id))?.status).toBe("delivered");
      expect(capturedPrompts[1]).toContain("Historical Verified Cases & Warnings (Casebook)");
      expect(capturedPrompts[1]).toContain(t1.id);
      const case1AfterHit = await store.getCasebookEntryByTicket(t1.id);
      expect(case1AfterHit?.hitCount).toBeGreaterThanOrEqual(1);

      // 3. Revert t2 -> flips t2 Casebook to reverted AND t2-linked auto rule or t1 revert flips t1 auto rule!
      // Let's revert t1 (note t2 touched a different file case_2.ts so git revert of t1 succeeds cleanly without conflict!)
      const revRes = await fetch(`${baseUrl}/api/tickets/${t1.id}/revert`, { method: "POST" });
      expect(revRes.status).toBe(200);

      const case1Reverted = await store.getCasebookEntryByTicket(t1.id);
      expect(case1Reverted?.reverted).toBe(true);
      const pbAfterRevert = await store.getPlaybookEntry(autoRule!.id);
      expect(pbAfterRevert?.suspect).toBe(true);

      // 4. Third ticket receives REVERTED PITFALL WARNING for t1
      const t3 = await kernel.createDirectTicket({
        repoId: "repo_case",
        title: "Rebuild JWT claims parser safely",
        description: "Parse claims without prior bug in src/",
        template: "fast",
        allowedPaths: ["src/**"],
      });
      await kernel.runUntilIdle(10);
      expect(capturedPrompts[2]).toContain("REVERTED PITFALL WARNING");
      expect(capturedPrompts[2]).toContain(t1.id);

      // 5. CLI `playbook prune` deletes ONLY suspect auto_healed rule and preserves human rule!
      const pruneOut: string[] = [];
      const pCode = await runCli(
        ["playbook", "prune", "--repo", "repo_case", "--json"],
        { baseUrl, stdout: (l) => pruneOut.push(l) },
      );
      expect(pCode).toBe(0);
      const pruneJson = JSON.parse(pruneOut.join("\n")) as {
        prunedIds: string[];
        keptCount: number;
        entries: Array<{ id: string; source: string }>;
      };
      expect(pruneJson.prunedIds).toContain(autoRule!.id);
      expect(pruneJson.entries.some((e) => e.source === "human")).toBe(true);

      // Verify CLI `casebook search` works cleanly
      const cbOut: string[] = [];
      const cbCode = await runCli(
        ["casebook", "search", "JWT", "--repo", "repo_case"],
        { baseUrl, stdout: (l) => cbOut.push(l) },
      );
      expect(cbCode).toBe(0);
      expect(cbOut.join("\n")).toContain("REVERTED WARNING");
    } finally {
      server.stop(true);
      store.close();
    }
  });
});
