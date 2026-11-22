import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  type ControlPlaneLLM,
  type OutboxExecutor,
  type RepoConfig,
  SuperWorkKernel,
  nowIso,
} from "@super-work/core";
import {
  FsArtifactStore,
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

    store.close();
  });
});
