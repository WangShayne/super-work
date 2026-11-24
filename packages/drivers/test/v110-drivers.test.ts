import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { createDefaultMandate, type RepoConfig, type Ticket } from "@super-work/core";
import {
  SqliteStateStore,
  executeReadOnlyProbeTool,
  isProbePathAllowed,
  runDeterministicRepoPreProbe,
  runGit,
  runWithOptionalProbes,
} from "../src/index.ts";

async function initSampleRepo(baseDir: string, name: string): Promise<string> {
  const dir = join(baseDir, name);
  await runGit(["init", "-b", "main", dir], baseDir);
  await runGit(["config", "user.name", "Test User"], dir);
  await runGit(["config", "user.email", "test@example.com"], dir);
  await mkdir(join(dir, "src/auth"), { recursive: true });
  await mkdir(join(dir, "certs"), { recursive: true });
  await mkdir(join(dir, "internal"), { recursive: true });
  await writeFile(
    join(dir, "src/auth/jwt.ts"),
    [
      "export interface JwtClaims { sub: string; exp: number }",
      "export function verifyJwtToken(token: string): boolean {",
      '  return token.startsWith("jwt_");',
      "}",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(dir, ".env"), "SECRET_KEY=super_secret_123\n", "utf8");
  await writeFile(join(dir, ".env.production"), "PROD_SECRET=top_secret\n", "utf8");
  await writeFile(join(dir, "certs/private.pem"), "PRIVATE KEY\n", "utf8");
  await writeFile(join(dir, "internal/secret.txt"), "CUSTOM_FORBIDDEN=1\n", "utf8");
  await runGit(["add", "src/auth/jwt.ts"], dir);
  await runGit(["commit", "-m", "feat: add verifyJwtToken"], dir);
  return dir;
}

describe("v1.1.0 Drivers (A.1 ReadOnlyRepoProber + 2-Round Probe Loop + D.1 Eval DB & Restore)", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const d of tempDirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("A.1: enforces path jail on .env/keys/traversal/forbiddenPaths and runs deterministic + tool probes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v110-probe-"));
    tempDirs.push(dir);
    const repoDir = await initSampleRepo(dir, "probe-app");
    const forbiddenPaths = ["internal/**"];

    expect(isProbePathAllowed("../etc/passwd", forbiddenPaths)).toBe(false);
    expect(isProbePathAllowed(".env", forbiddenPaths)).toBe(false);
    expect(isProbePathAllowed(".env.production", forbiddenPaths)).toBe(false);
    expect(isProbePathAllowed("certs/private.pem", forbiddenPaths)).toBe(false);
    expect(isProbePathAllowed(".git/config", forbiddenPaths)).toBe(false);
    expect(isProbePathAllowed("internal/secret.txt", forbiddenPaths)).toBe(false);
    expect(isProbePathAllowed("src/auth/jwt.ts", forbiddenPaths)).toBe(true);

    const blockedSlice = await executeReadOnlyProbeTool(
      repoDir,
      { tool: "read_file_slice", path: ".env" },
      forbiddenPaths,
    );
    expect(blockedSlice.outputSummary).toContain("Blocked");
    expect(blockedSlice.outputSummary).not.toContain("super_secret_123");

    const blockedForbidden = await executeReadOnlyProbeTool(
      repoDir,
      { tool: "read_file_slice", path: "internal/secret.txt" },
      forbiddenPaths,
    );
    expect(blockedForbidden.outputSummary).toContain("Blocked");
    expect(blockedForbidden.outputSummary).not.toContain("CUSTOM_FORBIDDEN");

    const preProbe = await runDeterministicRepoPreProbe(
      repoDir,
      "verifyJwtToken in src/auth/jwt.ts",
      forbiddenPaths,
    );
    expect(preProbe.matchedFiles).toContain("src/auth/jwt.ts");
    expect(preProbe.recentCommits[0]).toContain("add verifyJwtToken");
    expect(preProbe.probeSteps.length).toBeGreaterThanOrEqual(2);

    const symStep = await executeReadOnlyProbeTool(
      repoDir,
      { tool: "search_symbols", query: "verifyJwtToken" },
      forbiddenPaths,
    );
    expect(symStep.matchedPaths).toContain("src/auth/jwt.ts");

    const sliceStep = await executeReadOnlyProbeTool(
      repoDir,
      { tool: "read_file_slice", path: "src/auth/jwt.ts", startLine: 2, endLine: 4 },
      forbiddenPaths,
    );
    expect(sliceStep.outputSummary).toContain("verifyJwtToken");

    const grepStep = await executeReadOnlyProbeTool(
      repoDir,
      { tool: "grep_literals", query: "startsWith" },
      forbiddenPaths,
    );
    expect(grepStep.matchedPaths).toContain("src/auth/jwt.ts");

    const gitStep = await executeReadOnlyProbeTool(
      repoDir,
      { tool: "git_recent_commits", limit: 3 },
      forbiddenPaths,
    );
    expect(gitStep.outputSummary).toContain("add verifyJwtToken");
  });

  it("A.1: runWithOptionalProbes executes bounded max-2-round probe loop before final schema output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v110-loop-"));
    tempDirs.push(dir);
    const repoDir = await initSampleRepo(dir, "loop-app");

    const seenAllowProbes: boolean[] = [];
    const seenTranscripts: string[] = [];
    let callCount = 0;

    const { result, probeSteps } = await runWithOptionalProbes<{ verdict: string }>({
      probeExecutor: (req) => executeReadOnlyProbeTool(repoDir, req, [], 1),
      maxRounds: 2,
      invoke: async (transcript, allowProbes) => {
        callCount += 1;
        seenAllowProbes.push(allowProbes);
        seenTranscripts.push(transcript);
        if (callCount <= 3) {
          // Request probes in rounds 1 & 2, and try even in round 3 to ensure maxRounds=2 stops loop
          return {
            verdict: "ok",
            probeRequests: [{ tool: "read_file_slice", path: "src/auth/jwt.ts", startLine: 1, endLine: 3 }],
          };
        }
        return { verdict: "ok" };
      },
    });

    expect(result.verdict).toBe("ok");
    expect(callCount).toBe(3); // Round 0 probe, Round 1 probe, Round 2 allowProbes=false final answer
    expect(seenAllowProbes).toEqual([true, true, false]);
    expect(seenTranscripts[1]).toContain("verifyJwtToken");
    expect(probeSteps).toHaveLength(2);
  });

  it("D.1 & B.2: persists eval_cases/eval_runs, toolProfile/steered, blocks corrupt restore, and restores atomically", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v110-db-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "state.db");
    const store = new SqliteStateStore(dbPath);

    const repo: RepoConfig = {
      id: "repo_1",
      name: "app",
      rootPath: dir,
      baseBranch: "main",
      mode: "observe",
      defaultTemplate: "standard",
      preferredImplementEngine: "claude",
      preferredReviewEngine: "codex",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await store.upsertRepo(repo);

    const ticket1: Ticket = {
      id: "tkt_1",
      repoId: "repo_1",
      threadId: "thr_1",
      sourceTriggerId: "trg_1",
      title: "First ticket",
      description: "First",
      status: "delivered",
      template: "fast",
      currentStage: "rebase",
      stageRetries: 0,
      mandate: createDefaultMandate({ allowedPaths: ["src/**"], maxCostUsd: 2 }),
      dependsOn: [],
      nativeSessions: {},
      clarificationCount: 1,
      steerCount: 2,
      inlineMemory: { goal: "First", acceptanceCriteria: [], stageNotes: [], threadUpdates: [] },
      costUsd: 0.05,
      priority: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await store.saveTicket(ticket1);

    const loadedTkt1 = await store.getTicket("tkt_1");
    expect(loadedTkt1?.clarificationCount).toBe(1);
    expect(loadedTkt1?.steerCount).toBe(2);

    await store.saveStageRun({
      id: "run_prof",
      ticketId: "tkt_1",
      stage: "implement",
      engine: "claude",
      status: "aborted",
      costUsd: 0.02,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
      steered: true,
      toolProfile: {
        totalToolCalls: 3,
        totalToolErrors: 1,
        byTool: [{ toolName: "Bash", calls: 3, errors: 1, approxDurationMs: 250 }],
      },
    });
    const runs = await store.listStageRuns("tkt_1");
    expect(runs[0]?.steered).toBe(true);
    expect(runs[0]?.toolProfile?.totalToolCalls).toBe(3);

    await store.saveEvalCase({
      id: "evc_1",
      repoId: "repo_1",
      sourceTicketId: "tkt_1",
      title: "Golden case 1",
      description: "Benchmark",
      baseCommitSha: "abc12345",
      allowedPaths: ["src/**"],
      forbiddenPaths: [".env*"],
      verificationCommands: ["bun test"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect((await store.getEvalCase("evc_1"))?.title).toBe("Golden case 1");
    expect(await store.listEvalCases("repo_1")).toHaveLength(1);

    await store.saveEvalRun({
      id: "evr_1",
      evalCaseId: "evc_1",
      repoId: "repo_1",
      status: "completed",
      engines: ["claude"],
      results: [
        {
          engine: "claude",
          passed: true,
          verificationSummary: "PASS",
          durationMs: 120,
          costUsd: 0.02,
          changedFiles: ["src/a.ts"],
          addedLines: 10,
          deletedLines: 2,
          riskScore: 12,
        },
      ],
      maxBudgetUsd: 2,
      totalCostUsd: 0.02,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
    });
    expect(await store.listEvalRuns({ evalCaseId: "evc_1" })).toHaveLength(1);

    // Snapshot with 1 ticket, then add ticket_2 + corrupt file check
    const snapshotPath = join(dir, "snapshot.sqlite");
    await store.vacuumIntoBackup(snapshotPath);

    await store.saveTicket({
      ...ticket1,
      id: "tkt_2",
      threadId: "thr_2",
      sourceTriggerId: "trg_2",
      title: "Second ticket after snapshot",
    });
    expect(await store.listTickets()).toHaveLength(2);

    const corruptPath = join(dir, "corrupt.sqlite");
    await writeFile(corruptPath, "NOT A VALID SQLITE FILE", "utf8");
    await expect(store.restoreFromBackup(corruptPath)).rejects.toThrow();
    // Live DB remains untouched after rejected corrupt backup
    expect(await store.listTickets()).toHaveLength(2);

    const restored = await store.restoreFromBackup(snapshotPath);
    expect(restored.ok).toBe(true);
    expect(existsSync(dbPath)).toBe(true);
    const ticketsAfterRestore = await store.listTickets();
    expect(ticketsAfterRestore).toHaveLength(1);
    expect(ticketsAfterRestore[0]?.id).toBe("tkt_1");

    expect(await store.deleteEvalCase("evc_1")).toBe(true);
    expect(await store.getEvalCase("evc_1")).toBeNull();
  });
});
