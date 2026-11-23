import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  type ControlPlaneLLM,
  type OutboxExecutor,
  type RepoConfig,
  SuperWorkKernel,
  type Ticket,
  type WorkerDriver,
  createDefaultMandate,
  getFirstStage,
  newId,
  nowIso,
} from "@super-work/core";
import {
  FsArtifactStore,
  GhCliPollingSource,
  GhOutboxExecutor,
  GitWorktreeProvider,
  type MockScenarioKind,
  MockWorkerDriver,
  SqliteStateStore,
  runGit,
} from "../src/index.ts";

async function createTempGitRepo(baseDir: string): Promise<string> {
  const repoDir = join(baseDir, "repo");
  await runGit(["init", "-b", "main", repoDir], baseDir);
  await runGit(["config", "user.name", "Test User"], repoDir);
  await runGit(["config", "user.email", "test@example.com"], repoDir);
  await writeFile(join(repoDir, "README.md"), "# Demo Repo\n", "utf8");
  await runGit(["add", "."], repoDir);
  await runGit(["commit", "-m", "initial commit"], repoDir);
  return repoDir;
}

function makeTestLlm(allowedPathsOverride?: string[]): ControlPlaneLLM {
  return {
    providerName: "test-llm",
    async triageTrigger({ trigger }) {
      const pathsMatch = trigger.rawText.match(/scope:([a-zA-Z0-9_/*.-]+)/);
      const allowedPaths = allowedPathsOverride ?? (pathsMatch ? [pathsMatch[1]!] : ["src/**"]);
      return {
        shouldCreateTicket: true,
        reason: "Actionable development trigger",
        title: trigger.title,
        description: trigger.rawText,
        template: "standard",
        allowedPaths,
        acceptanceCriteria: ["Passes local verification"],
        priority: 1,
      };
    },
    async diagnoseWatchdog({ signal, availableEngines, stageRun }) {
      if (signal.kind === "repeated_error") {
        const alt = availableEngines.find((e) => e !== stageRun.engine);
        if (alt) {
          return {
            action: "SWITCH_ENGINE",
            reason: `Switching away from ${stageRun.engine} due to repeated error`,
            targetEngine: alt,
            hint: "Use clean implementation strategy",
          };
        }
      }
      return {
        action: "ESCALATE_HUMAN",
        reason: signal.details,
      };
    },
  };
}

describe("SuperWorkKernel E2E on real Git worktrees", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function setupEnv(scenarioResolver?: (title: string, engine: string) => MockScenarioKind) {
    const dir = await mkdtemp(join(tmpdir(), "sw-e2e-"));
    tempDirs.push(dir);

    const repoDir = await createTempGitRepo(dir);
    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));

    const delivered: Array<{ outboxId: string; ticketId: string; branchName: string }> = [];
    const outboxExecutor: OutboxExecutor = {
      async execute(entry, _repo, ticket) {
        delivered.push({
          outboxId: entry.id,
          ticketId: ticket.id,
          branchName: ticket.branchName ?? "",
        });
        return { prUrl: `local://pr/${ticket.id}`, branchName: ticket.branchName };
      },
    };

    const resolveScenario = (engine: string) => (input: { prompt: string }) =>
      scenarioResolver ? scenarioResolver(input.prompt, engine) : "happy_path";

    const claudeMock = new MockWorkerDriver({
      engine: "claude",
      scenarioResolver: resolveScenario("claude"),
      stepDelayMs: 2,
    });
    const codexMock = new MockWorkerDriver({
      engine: "codex",
      scenarioResolver: resolveScenario("codex"),
      stepDelayMs: 2,
    });

    const kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm: makeTestLlm(),
      drivers: [claudeMock, codexMock],
      outboxExecutor,
      config: { maxConcurrentWorkers: 4 },
    });

    const ts = nowIso();
    const repo: RepoConfig = {
      id: "repo_demo",
      name: "demo",
      rootPath: repoDir,
      baseBranch: "main",
      mode: "observe",
      defaultTemplate: "standard",
      preferredImplementEngine: "claude",
      preferredReviewEngine: "codex",
      createdAt: ts,
      updatedAt: ts,
    };
    await store.upsertRepo(repo);

    return { dir, repoDir, store, kernel, delivered, repo };
  }

  it("handles observe -> inbox approval -> standard cross-engine pipeline -> rebase -> outbox delivery", async () => {
    const { store, kernel, delivered, repo } = await setupEnv();

    const ingest = await kernel.ingestTrigger({
      repoId: repo.id,
      source: "github_issue",
      externalRef: "issue:101",
      threadKey: "gh:issue:101",
      title: "Add health endpoint",
      rawText: "Implement health endpoint under scope:src/health/**",
    });
    expect(ingest.action).toBe("proposed");
    if (ingest.action !== "proposed") throw new Error("expected proposed");

    // In observe mode, kernel does not execute until approved
    await kernel.runUntilIdle();
    expect((await store.getTicket(ingest.ticket.id))?.status).toBe("proposed");

    await kernel.resolveInboxItem(ingest.inboxItem.id, "approved", "Proceed carefully");
    await kernel.runUntilIdle();

    const finalTicket = await store.getTicket(ingest.ticket.id);
    expect(finalTicket?.status).toBe("delivered");
    expect(finalTicket?.worktreePath).toBeUndefined();
    expect(finalTicket?.worktreeCleanedAt).toBeDefined();
    expect(await kernel.inspectWorktrees(repo.id)).toHaveLength(0);
    const branchDiff = await kernel.workspace.getBranchDiff(
      repo.rootPath,
      repo.baseBranch,
      finalTicket!.branchName!,
    );
    expect(branchDiff).toContain("src/health");
    expect(finalTicket?.inlineMemory.stageNotes.map((n) => `${n.stage}:${n.engine}`)).toEqual([
      "plan:claude",
      "implement:claude",
      "review:codex",
      "rebase:claude",
    ]);
    expect(delivered).toHaveLength(1);

    const recall = await kernel.memory.getChainOfRecall(ingest.ticket.id);
    expect(recall?.stageRuns.length).toBe(4);
    expect(recall?.artifacts.length).toBeGreaterThanOrEqual(4);

    store.close();
  });

  it("routes follow-up triggers on subscribed thread directly into ticket inlineMemory", async () => {
    const { store, kernel, repo } = await setupEnv();
    await store.upsertRepo({ ...repo, mode: "auto" });

    const first = await kernel.ingestTrigger({
      repoId: repo.id,
      source: "github_issue",
      threadKey: "gh:issue:202",
      title: "Implement billing adapter",
      rawText: "Build adapter under scope:src/billing/**",
    });
    expect(first.action).toBe("queued");
    if (first.action !== "queued") throw new Error("expected queued");

    const followUp = await kernel.ingestTrigger({
      repoId: repo.id,
      source: "github_issue",
      threadKey: "gh:issue:202",
      title: "Comment on billing adapter",
      rawText: "Also support JPY zero-decimal rounding",
    });
    expect(followUp.action).toBe("routed_to_ticket");

    const updated = await store.getTicket(first.ticket.id);
    expect(updated?.inlineMemory.threadUpdates).toHaveLength(1);
    expect(updated?.inlineMemory.threadUpdates[0]!.message).toContain("JPY");

    store.close();
  });

  it("serializes overlapping Mandates via dependsOn while running disjoint Mandates concurrently", async () => {
    const { store, kernel, repo } = await setupEnv();
    await store.upsertRepo({ ...repo, mode: "auto" });

    const t1 = await kernel.createDirectTicket({
      repoId: repo.id,
      title: "Core refactor",
      description: "Update core module",
      template: "fast",
      allowedPaths: ["packages/core/**"],
    });
    const t2 = await kernel.createDirectTicket({
      repoId: repo.id,
      title: "Core tests",
      description: "Add tests in core",
      template: "fast",
      allowedPaths: ["packages/core/test/**"],
    });
    const t3 = await kernel.createDirectTicket({
      repoId: repo.id,
      title: "Web dashboard",
      description: "Update web ui",
      template: "fast",
      allowedPaths: ["packages/web/**"],
    });

    expect(t2.dependsOn).toContain(t1.id);
    expect(t2.status).toBe("waiting_deps");
    expect(t3.dependsOn).toEqual([]);
    expect(t3.status).toBe("queued");

    await kernel.runUntilIdle();

    expect((await store.getTicket(t1.id))?.status).toBe("delivered");
    expect((await store.getTicket(t2.id))?.status).toBe("delivered");
    expect((await store.getTicket(t3.id))?.status).toBe("delivered");

    store.close();
  });

  it("switches engine via Watchdog L1/L2 when claude hits repeated error loop and delivers via codex", async () => {
    const { store, kernel, repo } = await setupEnv((_prompt, engine) =>
      engine === "claude" ? "infinite_error_loop" : "happy_path",
    );
    await store.upsertRepo({ ...repo, mode: "auto" });

    const ticket = await kernel.createDirectTicket({
      repoId: repo.id,
      title: "Fix flaky parser",
      description: "Resolve parser edge case",
      template: "fast",
      allowedPaths: ["src/parser/**"],
    });

    await kernel.runUntilIdle();

    const finalTicket = await store.getTicket(ticket.id);
    expect(finalTicket?.status).toBe("delivered");
    const runs = await store.listStageRuns(ticket.id);
    expect(runs.some((r) => r.engine === "claude" && r.status === "aborted")).toBe(true);
    expect(runs.some((r) => r.engine === "codex" && r.status === "completed")).toBe(true);

    store.close();
  });

  it("reverts forbidden files and escalates mandate_violation to Attention Inbox", async () => {
    const { store, kernel, repo } = await setupEnv(() => "violate_mandate");
    await store.upsertRepo({ ...repo, mode: "auto" });

    const ticket = await kernel.createDirectTicket({
      repoId: repo.id,
      title: "Update config",
      description: "Should fail mandate check",
      template: "fast",
      allowedPaths: ["src/**"],
    });

    await kernel.runUntilIdle();

    const blocked = await store.getTicket(ticket.id);
    expect(blocked?.status).toBe("needs_human");
    expect(blocked?.errorMessage).toContain(".env.local");

    const inbox = await store.listInboxItems({ ticketId: ticket.id, status: "pending" });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.kind).toBe("mandate_violation");

    // Verify .env.local was reverted in worktree
    const envExists = await Bun.file(join(blocked!.worktreePath!, ".env.local")).exists();
    expect(envExists).toBe(false);

    // Cancelling the blocked ticket automatically reclaims its worktree when autoCleanupWorktree is enabled
    const cancelled = await kernel.cancelTicket(ticket.id, "Test cancel cleanup");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.worktreePath).toBeUndefined();
    expect(cancelled.worktreeCleanedAt).toBeDefined();
    expect(await kernel.inspectWorktrees(repo.id)).toHaveLength(0);

    store.close();
  });

  it("enforces deterministic verificationCommands gate and self-heals on retry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-verify-"));
    tempDirs.push(dir);
    const repoDir = await createTempGitRepo(dir);
    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));

    let attempts = 0;
    const verifyingDriver: WorkerDriver = {
      engine: "claude",
      async isAvailable() {
        return true;
      },
      async *runTurn(input) {
        attempts += 1;
        yield { type: "session_started", nativeSessionId: `s_${attempts}`, timestamp: nowIso() };
        await mkdir(join(input.worktreePath, "src"), { recursive: true });
        await writeFile(join(input.worktreePath, "src", "feature.ts"), "export const x = 1;\n");
        if (input.prompt.includes("Deterministic verification failed")) {
          await writeFile(join(input.worktreePath, "src", "verified.ok"), "ok\n");
        }
        yield {
          type: "completed",
          summary: `Attempt ${attempts} finished`,
          costUsd: 0.01,
          timestamp: nowIso(),
        };
      },
    };

    const kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm: makeTestLlm(),
      drivers: [verifyingDriver],
      outboxExecutor: new GhOutboxExecutor(workspace),
    });

    const ts = nowIso();
    await store.upsertRepo({
      id: "repo_verify",
      name: "verify-demo",
      rootPath: repoDir,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "fast",
      preferredImplementEngine: "claude",
      preferredReviewEngine: "claude",
      verificationCommands: ["test -f src/verified.ok"],
      createdAt: ts,
      updatedAt: ts,
    });

    const ticket = await kernel.createDirectTicket({
      repoId: "repo_verify",
      title: "Verified feature",
      description: "Ensure gate passes",
      template: "fast",
      allowedPaths: ["src/**"],
      preferredEngine: "claude",
    });

    await kernel.runUntilIdle();

    const finalTicket = await store.getTicket(ticket.id);
    expect(finalTicket?.status).toBe("delivered");
    expect(attempts).toBe(2);

    const artList = await store.listArtifacts(ticket.id);
    const testLogs = artList.filter((a) => a.kind === "test_log");
    expect(testLogs.some((a) => a.summary.startsWith("FAIL"))).toBe(true);
    expect(testLogs.some((a) => a.summary.startsWith("PASS"))).toBe(true);

    store.close();
  });

  it("delivers via local_merge directly into base branch and cleans temporary branch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-localmerge-"));
    tempDirs.push(dir);
    const repoDir = await createTempGitRepo(dir);
    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));

    const kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm: makeTestLlm(),
      drivers: [new MockWorkerDriver({ engine: "claude", stepDelayMs: 2 })],
      outboxExecutor: new GhOutboxExecutor(workspace),
    });

    const ts = nowIso();
    await store.upsertRepo({
      id: "repo_merge",
      name: "merge-demo",
      rootPath: repoDir,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "fast",
      preferredImplementEngine: "claude",
      preferredReviewEngine: "claude",
      defaultDeliveryChannel: "local_merge",
      autoCleanupWorktree: false,
      createdAt: ts,
      updatedAt: ts,
    });

    const ticket = await kernel.createDirectTicket({
      repoId: "repo_merge",
      title: "Merge feature locally",
      description: "Implement local merge change",
      template: "fast",
      allowedPaths: ["src/local/**"],
      preferredEngine: "claude",
    });

    await kernel.runUntilIdle();

    const finalTicket = await store.getTicket(ticket.id);
    expect(finalTicket?.status).toBe("delivered");
    expect(finalTicket?.worktreePath).toBeUndefined();

    const outbox = await store.listOutboxEntries({ ticketId: ticket.id });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.action).toBe("local_merge");
    expect(outbox[0]!.status).toBe("sent");
    expect(outbox[0]!.resultPayload).toMatchObject({
      mode: "local_merged",
      baseBranch: "main",
      branchCleaned: true,
    });

    // Verify committed change now lives directly in repoDir main branch and temp branch is deleted
    const mergedFile = join(repoDir, "src", "local", `${ticket.id}.ts`);
    expect(await Bun.file(mergedFile).exists()).toBe(true);
    const branchCheck = await runGit(["branch", "--list", finalTicket!.branchName!], repoDir);
    expect(branchCheck.stdout.trim()).toBe("");

    store.close();
  });

  it("orchestrates Epic DAG subtasks with parallel execution and upstream branch integration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-epic-"));
    tempDirs.push(dir);
    const repoDir = await createTempGitRepo(dir);
    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));

    const downstreamSawContract: Record<string, boolean> = {};
    const epicDriver: WorkerDriver = {
      engine: "claude",
      async isAvailable() {
        return true;
      },
      async *runTurn(input) {
        yield { type: "session_started", nativeSessionId: `ep_${input.ticketId}`, timestamp: nowIso() };
        const ticketHeader =
          input.prompt
            .split("\n")
            .find((l) => l.startsWith("Ticket:")) ?? input.prompt;
        if (ticketHeader.includes("[Contracts]")) {
          await mkdir(join(input.worktreePath, "packages/core"), { recursive: true });
          await writeFile(join(input.worktreePath, "packages/core/contract.ts"), "export interface Contract { ok: true }\n");
        } else if (ticketHeader.includes("[Backend]")) {
          downstreamSawContract.drivers = await Bun.file(
            join(input.worktreePath, "packages/core/contract.ts"),
          ).exists();
          await mkdir(join(input.worktreePath, "packages/drivers"), { recursive: true });
          await writeFile(join(input.worktreePath, "packages/drivers/impl.ts"), "export const impl = true;\n");
        } else if (ticketHeader.includes("[UI]")) {
          downstreamSawContract.web = await Bun.file(
            join(input.worktreePath, "packages/core/contract.ts"),
          ).exists();
          await mkdir(join(input.worktreePath, "packages/web"), { recursive: true });
          await writeFile(join(input.worktreePath, "packages/web/panel.tsx"), "export const Panel = () => null;\n");
        }
        yield { type: "completed", summary: "Subtask done", costUsd: 0.05, timestamp: nowIso() };
      },
    };

    const kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm: makeTestLlm(),
      drivers: [epicDriver],
      outboxExecutor: new GhOutboxExecutor(workspace),
    });

    const ts = nowIso();
    await store.upsertRepo({
      id: "repo_epic",
      name: "epic-demo",
      rootPath: repoDir,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "fast",
      preferredImplementEngine: "claude",
      preferredReviewEngine: "claude",
      createdAt: ts,
      updatedAt: ts,
    });

    const { epic, subtasks } = await kernel.createEpic({
      repoId: "repo_epic",
      title: "Plugin System Epic",
      description: "Add plugin architecture",
      template: "fast",
      preferredEngine: "claude",
      subtasks: [
        {
          key: "core",
          title: "[Contracts] Define core plugin types",
          description: "[Contracts] Define core plugin types",
          template: "fast",
          allowedPaths: ["packages/core/**"],
          dependsOnKeys: [],
          acceptanceCriteria: ["Types ready"],
        },
        {
          key: "drivers",
          title: "[Backend] Implement plugin loader",
          description: "[Backend] Implement plugin loader",
          template: "fast",
          allowedPaths: ["packages/drivers/**"],
          dependsOnKeys: ["core"],
          acceptanceCriteria: ["Loader ready"],
        },
        {
          key: "web",
          title: "[UI] Build plugin manager view",
          description: "[UI] Build plugin manager view",
          template: "fast",
          allowedPaths: ["packages/web/**"],
          dependsOnKeys: ["core"],
          acceptanceCriteria: ["UI ready"],
        },
      ],
    });

    expect(epic.isEpic).toBe(true);
    expect(subtasks).toHaveLength(3);
    expect(subtasks[0]!.status).toBe("queued");
    expect(subtasks[1]!.status).toBe("waiting_deps");
    expect(subtasks[2]!.status).toBe("waiting_deps");

    await kernel.runUntilIdle();

    expect(downstreamSawContract).toEqual({ drivers: true, web: true });
    for (const sub of subtasks) {
      expect((await store.getTicket(sub.id))?.status).toBe("delivered");
    }
    const finalEpic = await store.getTicket(epic.id);
    expect(finalEpic?.status).toBe("delivered");
    expect(finalEpic?.costUsd).toBeCloseTo(0.15, 3);

    store.close();
  });

  it("mirrors gitignored node_modules and workspace relative symlinks into isolated worktrees", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-nm-"));
    tempDirs.push(dir);
    const repoDir = await createTempGitRepo(dir);
    await writeFile(join(repoDir, ".gitignore"), "node_modules/\n", "utf8");
    await mkdir(join(repoDir, "packages/shared"), { recursive: true });
    await mkdir(join(repoDir, "packages/app"), { recursive: true });
    await writeFile(join(repoDir, "packages/shared/val.js"), "export const VAL = 1;\n", "utf8");
    await writeFile(join(repoDir, "packages/app/.gitkeep"), "", "utf8");
    await runGit(["add", "."], repoDir);
    await runGit(["commit", "-m", "add workspace packages"], repoDir);

    // Populate gitignored external & scoped workspace symlinks inside repoDir
    await mkdir(join(repoDir, "node_modules/ext-pkg"), { recursive: true });
    await writeFile(join(repoDir, "node_modules/ext-pkg/index.js"), "export const EXT = 100;\n", "utf8");
    await mkdir(join(repoDir, "packages/app/node_modules/@ws"), { recursive: true });
    await symlink("../../../shared", join(repoDir, "packages/app/node_modules/@ws/shared"));

    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));

    const customDriver: WorkerDriver = {
      engine: "claude",
      async isAvailable() {
        return true;
      },
      async *runTurn(input) {
        const ts = nowIso();
        await writeFile(
          join(input.worktreePath, "packages/shared/val.js"),
          "export const VAL = 42;\n",
          "utf8",
        );
        yield {
          type: "completed",
          summary: "Updated shared value to 42",
          costUsd: 0.03,
          timestamp: ts,
        };
      },
    };

    const kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm: makeTestLlm(),
      drivers: [customDriver],
      outboxExecutor: new GhOutboxExecutor(workspace),
    });

    const ts = nowIso();
    await store.upsertRepo({
      id: "repo_nm",
      name: "nm-demo",
      rootPath: repoDir,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "fast",
      preferredImplementEngine: "claude",
      preferredReviewEngine: "claude",
      defaultDeliveryChannel: "local_merge",
      verificationCommands: [
        `bun -e "import { EXT } from 'ext-pkg'; import { VAL } from './packages/app/node_modules/@ws/shared/val.js'; if (EXT + VAL !== 142) process.exit(1);"`,
      ],
      createdAt: ts,
      updatedAt: ts,
    });

    const ticket = await kernel.createDirectTicket({
      repoId: "repo_nm",
      title: "Update shared constant",
      description: "Update packages/shared/val.js and verify via mirrored dependencies",
      template: "fast",
      allowedPaths: ["packages/shared/**"],
      preferredEngine: "claude",
    });

    await kernel.runUntilIdle();

    const finalTicket = await store.getTicket(ticket.id);
    expect(finalTicket?.status).toBe("delivered");
    // Verification ran against the worktree's edited value (42), not main's (1)
    expect(await Bun.file(join(repoDir, "packages/shared/val.js")).text()).toContain("VAL = 42");

    // Ensure node_modules was never tracked by git
    const lsNodeModules = await runGit(["ls-files", "*node_modules*"], repoDir);
    expect(lsNodeModules.stdout.trim()).toBe("");

    store.close();
  });

  it("isolates same-engine review into a fresh session without clobbering implementer session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-blind-rev-"));
    tempDirs.push(dir);
    const repoDir = await createTempGitRepo(dir);
    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));

    const turns: Array<{ stage: string; isResume: boolean; nativeSessionId?: string }> = [];
    let reviewCount = 0;

    const sameEngineDriver: WorkerDriver = {
      engine: "claude",
      async isAvailable() {
        return true;
      },
      async *runTurn(input) {
        const ts = nowIso();
        turns.push({
          stage: input.stage,
          isResume: input.isResume,
          nativeSessionId: input.nativeSessionId,
        });

        if (input.stage === "plan") {
          yield { type: "session_started", nativeSessionId: "sess_impl_plan", timestamp: ts };
          yield { type: "completed", summary: "Plan complete", costUsd: 0.02, timestamp: ts };
          return;
        }

        if (input.stage === "implement") {
          await mkdir(join(input.worktreePath, "src"), { recursive: true });
          await writeFile(
            join(input.worktreePath, "src/feature.ts"),
            `export const rev = ${reviewCount};\n`,
            "utf8",
          );
          yield { type: "completed", summary: "Implemented fix", costUsd: 0.03, timestamp: ts };
          return;
        }

        if (input.stage === "review") {
          reviewCount += 1;
          yield {
            type: "session_started",
            nativeSessionId: `sess_review_${reviewCount}`,
            timestamp: ts,
          };
          const summary =
            reviewCount === 1
              ? "Needs fix\n\nVERDICT: **REJECTED** - missing check"
              : "Looks good\n\nVERDICT: APPROVED";
          yield { type: "completed", summary, costUsd: 0.02, timestamp: ts };
          return;
        }
      },
    };

    const kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm: makeTestLlm(),
      drivers: [sameEngineDriver],
      outboxExecutor: new GhOutboxExecutor(workspace),
    });

    const ts = nowIso();
    await store.upsertRepo({
      id: "repo_rev",
      name: "rev-demo",
      rootPath: repoDir,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "standard",
      preferredImplementEngine: "claude",
      preferredReviewEngine: "claude",
      defaultDeliveryChannel: "local_merge",
      createdAt: ts,
      updatedAt: ts,
    });

    const ticket = await kernel.createDirectTicket({
      repoId: "repo_rev",
      title: "Fix feature with review loop",
      description: "Verify blind same-engine review session isolation",
      template: "standard",
      allowedPaths: ["src/**"],
      preferredEngine: "claude",
    });

    await kernel.runUntilIdle();

    const finalTicket = await store.getTicket(ticket.id);
    expect(finalTicket?.status).toBe("delivered");
    expect(finalTicket?.nativeSessions.claude).toBe("sess_impl_plan");
    expect(turns).toEqual([
      { stage: "plan", isResume: false, nativeSessionId: undefined },
      { stage: "implement", isResume: true, nativeSessionId: "sess_impl_plan" },
      { stage: "review", isResume: false, nativeSessionId: undefined },
      { stage: "implement", isResume: true, nativeSessionId: "sess_impl_plan" },
      { stage: "review", isResume: false, nativeSessionId: undefined },
    ]);

    store.close();
  });

  it("recovers interrupted tickets and processing outbox rows without losing worktree edits or session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-recover-"));
    tempDirs.push(dir);
    const repoDir = await createTempGitRepo(dir);
    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));

    let seenPartialFile = false;
    let seenResumeId: string | undefined;
    const resumeDriver: WorkerDriver = {
      engine: "claude",
      async isAvailable() {
        return true;
      },
      async *runTurn(input) {
        const ts = nowIso();
        seenResumeId = input.nativeSessionId;
        seenPartialFile = await Bun.file(join(input.worktreePath, "src/partial.ts")).exists();
        yield { type: "completed", summary: "Recovered and finished", costUsd: 0.02, timestamp: ts };
      },
    };

    const kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm: makeTestLlm(),
      drivers: [resumeDriver],
      outboxExecutor: new GhOutboxExecutor(workspace),
    });

    const ts = nowIso();
    const repo: RepoConfig = {
      id: "repo_rec",
      name: "rec-demo",
      rootPath: repoDir,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "fast",
      preferredImplementEngine: "claude",
      preferredReviewEngine: "claude",
      defaultDeliveryChannel: "local_merge",
      createdAt: ts,
      updatedAt: ts,
    };
    await store.upsertRepo(repo);

    // Prepare interrupted ticket with partial worktree progress & running StageRun
    await store.upsertThread({
      id: "thr_rec",
      repoId: repo.id,
      threadKey: "rec:1",
      subscribedTicketId: "tkt_rec_1",
      metadata: {},
      createdAt: ts,
      updatedAt: ts,
    });
    const baseTicket: Ticket = {
      id: "tkt_rec_1",
      repoId: repo.id,
      threadId: "thr_rec",
      sourceTriggerId: "trg_rec",
      title: "Interrupted work",
      description: "Resume seamlessly",
      status: "implementing",
      template: "fast",
      currentStage: "implement",
      stageRetries: 0,
      mandate: createDefaultMandate({ allowedPaths: ["src/**"] }),
      dependsOn: [],
      nativeSessions: { claude: "sess_crash_1" },
      preferredEngine: "claude",
      inlineMemory: {
        goal: "Resume seamlessly",
        acceptanceCriteria: [],
        stageNotes: [],
        threadUpdates: [],
      },
      costUsd: 0,
      priority: 1,
      createdAt: ts,
      updatedAt: ts,
    };
    const ws = await workspace.prepareWorkspace(baseTicket, repo);
    await mkdir(join(ws.worktreePath, "src"), { recursive: true });
    await writeFile(join(ws.worktreePath, "src/partial.ts"), "export const partial = true;\n", "utf8");
    await store.saveTicket({ ...baseTicket, worktreePath: ws.worktreePath, branchName: ws.branchName });
    await store.saveStageRun({
      id: "run_orphan_1",
      ticketId: baseTicket.id,
      stage: "implement",
      engine: "claude",
      status: "running",
      costUsd: 0,
      startedAt: ts,
    });
    await store.enqueueOutbox({
      id: "obx_stuck_1",
      repoId: repo.id,
      ticketId: baseTicket.id,
      action: "comment_pr",
      idempotencyKey: "stuck_1",
      payload: { body: "orphan" },
      status: "processing",
      attempts: 0,
      nextAttemptAt: ts,
      createdAt: ts,
      updatedAt: ts,
    });

    const recovery = await kernel.recoverInterruptedRuns();
    expect(recovery.recoveredTickets).toBe(1);
    expect(recovery.requeuedOutbox).toBe(1);

    const recoveredTicket = await store.getTicket(baseTicket.id);
    expect(recoveredTicket?.status).toBe("queued");
    expect(recoveredTicket?.stageRetries).toBe(0);
    expect(recoveredTicket?.nativeSessions.claude).toBe("sess_crash_1");
    expect((await store.getStageRun("run_orphan_1"))?.status).toBe("aborted");
    expect((await store.getOutboxEntry("obx_stuck_1"))?.status).toBe("pending");

    await kernel.runUntilIdle();
    expect(seenPartialFile).toBe(true);
    expect(seenResumeId).toBe("sess_crash_1");
    expect((await store.getTicket(baseTicket.id))?.status).toBe("delivered");
    expect(await Bun.file(join(repoDir, "src/partial.ts")).exists()).toBe(true);

    store.close();
  });

  it("preserves out-of-scope edits on mandate_violation, supports zero-reburn expandMandate, and reverts on reject", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-mandate-expand-"));
    tempDirs.push(dir);
    const repoDir = await createTempGitRepo(dir);
    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));

    let turnCount = 0;
    const scopeCrossingDriver: WorkerDriver = {
      engine: "claude",
      async isAvailable() {
        return true;
      },
      async *runTurn(input) {
        turnCount += 1;
        await mkdir(join(input.worktreePath, "src"), { recursive: true });
        await mkdir(join(input.worktreePath, "docs"), { recursive: true });
        await writeFile(
          join(input.worktreePath, `src/${input.ticketId}.ts`),
          "export const code = 1;\n",
          "utf8",
        );
        await writeFile(
          join(input.worktreePath, `docs/${input.ticketId}.md`),
          `# Guide for ${input.ticketId}\n`,
          "utf8",
        );
        yield { type: "completed", summary: "Edited src + docs", costUsd: 0.01, timestamp: nowIso() };
      },
    };

    const kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm: makeTestLlm(),
      drivers: [scopeCrossingDriver],
      outboxExecutor: new GhOutboxExecutor(workspace),
    });

    const ts = nowIso();
    await store.upsertRepo({
      id: "repo_exp",
      name: "exp-demo",
      rootPath: repoDir,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "fast",
      preferredImplementEngine: "claude",
      preferredReviewEngine: "claude",
      defaultDeliveryChannel: "local_merge",
      createdAt: ts,
      updatedAt: ts,
    });

    // Case 1: Approve with expandMandate -> delivers without a second Worker turn
    const tExpand = await kernel.createDirectTicket({
      repoId: "repo_exp",
      title: "Feature + doc",
      description: "Write src/code.ts and docs/guide.md",
      template: "fast",
      allowedPaths: ["src/**"],
      preferredEngine: "claude",
    });
    await kernel.runUntilIdle();
    expect(turnCount).toBe(1);

    const paused = await store.getTicket(tExpand.id);
    expect(paused?.status).toBe("needs_human");
    expect(paused?.pendingViolationPaths).toEqual([`docs/${tExpand.id}.md`]);
    expect(await Bun.file(join(paused!.worktreePath!, `docs/${tExpand.id}.md`)).exists()).toBe(true);

    const inbox = await store.listInboxItems({ ticketId: tExpand.id, status: "pending" });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.contextPayload.canExpandMandate).toBe(true);

    await kernel.resolveInboxItem(inbox[0]!.id, "approved", "Allow docs", {
      expandMandate: true,
    });
    await kernel.runUntilIdle();

    expect(turnCount).toBe(1); // Zero extra worker turns consumed!
    expect((await store.getTicket(tExpand.id))?.status).toBe("delivered");
    expect(await Bun.file(join(repoDir, `docs/${tExpand.id}.md`)).exists()).toBe(true);

    // Case 2: Reject pending violation -> reverts out-of-scope file and cancels
    const tReject = await kernel.createDirectTicket({
      repoId: "repo_exp",
      title: "Reject doc change",
      description: "Will reject out-of-scope edit",
      template: "fast",
      allowedPaths: ["src/**"],
      preferredEngine: "claude",
    });
    await kernel.runUntilIdle();
    const rejPaused = await store.getTicket(tReject.id);
    expect(rejPaused?.status).toBe("needs_human");
    const rejInbox = await store.listInboxItems({ ticketId: tReject.id, status: "pending" });
    await kernel.resolveInboxItem(rejInbox[0]!.id, "rejected", "Do not modify docs");
    expect(await Bun.file(join(rejPaused!.worktreePath!, `docs/${tReject.id}.md`)).exists()).toBe(false);
    expect((await store.getTicket(tReject.id))?.status).toBe("cancelled");

    store.close();
  });

  it("executes unified Epic final gate with 1-round integration fixup and atomic local_merge", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-epic-unified-"));
    tempDirs.push(dir);
    const repoDir = await createTempGitRepo(dir);
    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));

    let fixupCalled = 0;
    const unifiedDriver: WorkerDriver = {
      engine: "claude",
      async isAvailable() {
        return true;
      },
      async *runTurn(input) {
        if (input.ticketId.startsWith("epc_")) {
          fixupCalled += 1;
          await writeFile(join(input.worktreePath, "integrated.ok"), "fixed-integration\n", "utf8");
          yield { type: "completed", summary: "Fixed Epic integration", costUsd: 0.04, timestamp: nowIso() };
          return;
        }
        const header = input.prompt.split("\n").find((l) => l.startsWith("Ticket:")) ?? input.prompt;
        if (header.includes("[ModA]")) {
          await mkdir(join(input.worktreePath, "packages/a"), { recursive: true });
          await writeFile(join(input.worktreePath, "packages/a/a.ts"), "export const a = 1;\n", "utf8");
        } else {
          await mkdir(join(input.worktreePath, "packages/b"), { recursive: true });
          await writeFile(join(input.worktreePath, "packages/b/b.ts"), "export const b = 2;\n", "utf8");
        }
        yield { type: "completed", summary: "Subtask done", costUsd: 0.02, timestamp: nowIso() };
      },
    };

    const kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm: makeTestLlm(),
      drivers: [unifiedDriver],
      outboxExecutor: new GhOutboxExecutor(workspace),
    });

    const ts = nowIso();
    // Fails ONLY once both packages/a/a.ts and packages/b/b.ts exist on staging without integrated.ok
    await store.upsertRepo({
      id: "repo_uni",
      name: "uni-demo",
      rootPath: repoDir,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "fast",
      preferredImplementEngine: "claude",
      preferredReviewEngine: "claude",
      defaultDeliveryChannel: "local_merge",
      verificationCommands: [
        "node -e \"const fs=require('fs'); if(fs.existsSync('packages/a/a.ts') && fs.existsSync('packages/b/b.ts') && !fs.existsSync('integrated.ok')) process.exit(1);\"",
      ],
      createdAt: ts,
      updatedAt: ts,
    });

    const { epic, subtasks } = await kernel.createEpic({
      repoId: "repo_uni",
      title: "Unified Staging Epic",
      description: "Parallel modules requiring cross-module integration marker",
      template: "fast",
      epicDeliveryMode: "unified",
      preferredEngine: "claude",
      subtasks: [
        {
          key: "mod_a",
          title: "[ModA] Build module A",
          description: "Build packages/a",
          template: "fast",
          allowedPaths: ["packages/a/**"],
          dependsOnKeys: [],
          acceptanceCriteria: ["A ready"],
        },
        {
          key: "mod_b",
          title: "[ModB] Build module B",
          description: "Build packages/b",
          template: "fast",
          allowedPaths: ["packages/b/**"],
          dependsOnKeys: [],
          acceptanceCriteria: ["B ready"],
        },
      ],
    });

    await kernel.runUntilIdle();

    expect(fixupCalled).toBe(1);
    for (const sub of subtasks) {
      expect((await store.getTicket(sub.id))?.status).toBe("delivered");
      // Individual subtasks merged into Epic staging, not separate Outbox PRs
      expect(await store.listOutboxEntries({ ticketId: sub.id })).toHaveLength(0);
    }

    const finalEpic = await store.getTicket(epic.id);
    expect(finalEpic?.status).toBe("delivered");
    const epicOutbox = await store.listOutboxEntries({ ticketId: epic.id });
    expect(epicOutbox).toHaveLength(1);
    expect(epicOutbox[0]!.action).toBe("local_merge");
    expect(epicOutbox[0]!.status).toBe("sent");

    // Verify all files + integration fixup landed atomically in main
    expect(await Bun.file(join(repoDir, "packages/a/a.ts")).exists()).toBe(true);
    expect(await Bun.file(join(repoDir, "packages/b/b.ts")).exists()).toBe(true);
    expect(await Bun.file(join(repoDir, "integrated.ok")).exists()).toBe(true);

    store.close();
  });

  it("enforces dailyBudgetUsd soft-boundary fuse and resumes after budget_cap Inbox approval", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-budget-cap-"));
    tempDirs.push(dir);
    const repoDir = await createTempGitRepo(dir);
    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));

    const costDriver: WorkerDriver = {
      engine: "claude",
      async isAvailable() {
        return true;
      },
      async *runTurn(input) {
        await mkdir(join(input.worktreePath, "src"), { recursive: true });
        await writeFile(join(input.worktreePath, `src/${input.ticketId}.ts`), "export const ok = 1;\n", "utf8");
        yield { type: "completed", summary: "Done", costUsd: 0.08, timestamp: nowIso() };
      },
    };

    const kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm: makeTestLlm(),
      drivers: [costDriver],
      outboxExecutor: new GhOutboxExecutor(workspace),
    });

    const ts = nowIso();
    await store.upsertRepo({
      id: "repo_cap",
      name: "cap-demo",
      rootPath: repoDir,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "fast",
      preferredImplementEngine: "claude",
      preferredReviewEngine: "claude",
      maxConcurrentWorkers: 1,
      dailyBudgetUsd: 0.05,
      createdAt: ts,
      updatedAt: ts,
    });

    const t1 = await kernel.createDirectTicket({
      repoId: "repo_cap",
      title: "First task",
      description: "Runs under cap before spend exceeds",
      template: "fast",
      allowedPaths: ["src/**"],
      preferredEngine: "claude",
    });
    const t2 = await kernel.createDirectTicket({
      repoId: "repo_cap",
      title: "Second task",
      description: "Paused by daily budget cap",
      template: "fast",
      allowedPaths: ["src/**"],
      preferredEngine: "claude",
    });

    await kernel.runUntilIdle();

    expect((await store.getTicket(t1.id))?.status).toBe("delivered");
    expect((await store.getTicket(t2.id))?.status).toBe("queued");

    const capInbox = await store.listInboxItems({ repoId: "repo_cap", status: "pending" });
    expect(capInbox).toHaveLength(1);
    expect(capInbox[0]!.kind).toBe("budget_cap");

    await kernel.resolveInboxItem(capInbox[0]!.id, "approved", "Increase daily cap", {
      budgetIncreaseUsd: 5,
    });
    await kernel.runUntilIdle();
    expect((await store.getTicket(t2.id))?.status).toBe("delivered");

    store.close();
  });

  it("handles full GitHub PR follow-up loop, bot-comment filtering, CI log ingestion, and 3-round cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-gh-pr-loop-"));
    tempDirs.push(dir);
    const bareDir = join(dir, "remote.git");
    await runGit(["init", "--bare", bareDir], dir);
    const repoDir = await createTempGitRepo(dir);
    await runGit(["remote", "add", "origin", bareDir], repoDir);
    await runGit(["push", "-u", "origin", "main"], repoDir);

    const ghLogPath = join(dir, "gh-calls.log");
    const ghStatePath = join(dir, "gh-state.json");
    await writeFile(
      ghStatePath,
      JSON.stringify({ prCreated: false, comments: [], failedChecks: [], branch: "" }),
      "utf8",
    );

    const mockGhPath = join(dir, "mock-gh.ts");
    await writeFile(
      mockGhPath,
      `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(ghLogPath)}, JSON.stringify(args) + "\\n");
const state = JSON.parse(readFileSync(${JSON.stringify(ghStatePath)}, "utf8"));
if (args[0] === "auth" && args[1] === "status") process.exit(0);
if (args[0] === "issue" && args[1] === "list") { console.log("[]"); process.exit(0); }
if (args[0] === "pr" && args[1] === "create") {
  const headIdx = args.indexOf("--head");
  state.prCreated = true;
  state.branch = headIdx >= 0 ? args[headIdx + 1] : state.branch;
  writeFileSync(${JSON.stringify(ghStatePath)}, JSON.stringify(state));
  console.log("https://github.com/acme/demo/pull/42");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "list") {
  if (!state.prCreated) { console.log("[]"); process.exit(0); }
  console.log(JSON.stringify([{
    number: 42,
    url: "https://github.com/acme/demo/pull/42",
    title: "PR Loop Feature",
    headRefName: state.branch,
    statusCheckRollup: state.failedChecks,
    comments: state.comments,
    reviews: []
  }]));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "comment") {
  console.log("https://github.com/acme/demo/pull/42#issuecomment-bot");
  process.exit(0);
}
if (args[0] === "run" && args[1] === "list") {
  console.log(JSON.stringify([{ databaseId: 9901 }]));
  process.exit(0);
}
if (args[0] === "run" && args[1] === "view") {
  console.log("FAIL test/pr.test.ts: expected export v2");
  process.exit(0);
}
process.exit(0);
`,
      "utf8",
    );
    await chmod(mockGhPath, 0o755);

    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));

    let rounds = 0;
    const prDriver: WorkerDriver = {
      engine: "claude",
      async isAvailable() {
        return true;
      },
      async *runTurn(input) {
        rounds += 1;
        await mkdir(join(input.worktreePath, "src"), { recursive: true });
        await writeFile(
          join(input.worktreePath, "src/feature.ts"),
          `export const rev = ${rounds};\n`,
          "utf8",
        );
        yield { type: "completed", summary: `Commit round ${rounds}`, costUsd: 0.01, timestamp: nowIso() };
      },
    };

    const kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm: makeTestLlm(),
      drivers: [prDriver],
      outboxExecutor: new GhOutboxExecutor(workspace, mockGhPath),
    });

    const ts = nowIso();
    await store.upsertRepo({
      id: "repo_pr",
      name: "pr-demo",
      rootPath: repoDir,
      baseBranch: "main",
      githubRepo: "acme/demo",
      mode: "auto",
      defaultTemplate: "standard",
      preferredImplementEngine: "claude",
      preferredReviewEngine: "claude",
      autoCleanupWorktree: true,
      createdAt: ts,
      updatedAt: ts,
    });

    const ticket = await kernel.createDirectTicket({
      repoId: "repo_pr",
      title: "PR Loop Feature",
      description: "Implement initial PR",
      template: "fast",
      allowedPaths: ["src/**"],
      preferredEngine: "claude",
    });

    await kernel.runUntilIdle();

    const afterPr = await store.getTicket(ticket.id);
    expect(afterPr?.status).toBe("delivered");
    expect(afterPr?.prNumber).toBe(42);
    expect(afterPr?.prUrl).toBe("https://github.com/acme/demo/pull/42");
    expect(afterPr?.worktreePath).toBeUndefined(); // cleaned after initial delivery

    const poller = new GhCliPollingSource(kernel, 60_000, mockGhPath);

    // Phase 2: Poller sees bot [super-work] comment (ignored!) + human comment + CI failure (with log!)
    await writeFile(
      ghStatePath,
      JSON.stringify({
        prCreated: true,
        branch: afterPr!.branchName!,
        failedChecks: [{ name: "ci-test", conclusion: "FAILURE" }],
        comments: [
          { id: "c_bot", body: "[super-work] Automated summary reply", createdAt: ts },
          { id: "c_human", body: "Please update feature.ts for CI", createdAt: ts },
        ],
      }),
      "utf8",
    );

    const ingested = await poller.pollOnce();
    expect(ingested).toBe(2); // CI failure + human comment (bot comment skipped)
    await kernel.runUntilIdle();

    const afterFollowup = await store.getTicket(ticket.id);
    expect(afterFollowup?.status).toBe("delivered");
    expect(afterFollowup?.prAutoFollowupCount).toBe(1);
    expect(afterFollowup?.inlineMemory.threadUpdates.some((u) => u.message.includes("FAIL test/pr.test.ts"))).toBe(true);

    // Ensure `gh pr create` ran ONLY once, while `gh pr comment` ran on follow-up push!
    const ghCalls = (await readFile(ghLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const prCreates = ghCalls.filter((c) => c[0] === "pr" && c[1] === "create");
    const prComments = ghCalls.filter((c) => c[0] === "pr" && c[1] === "comment");
    expect(prCreates).toHaveLength(1);
    expect(prComments.length).toBeGreaterThanOrEqual(1);

    // Phase 3: Enforce 3-round automatic PR follow-up cap
    for (let round = 2; round <= 4; round++) {
      await kernel.ingestTrigger({
        repoId: "repo_pr",
        source: "github_pr",
        externalRef: `manual_pr_comment_${round}`,
        threadKey: `gh:acme/demo:pr:42`,
        title: `PR comment round ${round}`,
        rawText: `More feedback round ${round}`,
        payload: { prNumber: 42, branch: afterPr!.branchName },
      });
      await kernel.runUntilIdle();
    }

    const capped = await store.getTicket(ticket.id);
    expect(capped?.status).toBe("needs_human");
    expect(capped?.prAutoFollowupCount).toBe(3);
    expect(capped?.errorMessage).toContain("3");

    store.close();
  });
});
