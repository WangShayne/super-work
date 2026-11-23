import { describe, expect, it } from "bun:test";
import {
  buildCasebookEntryFromTicket,
  classifyEpicReplanApproval,
  classifyPlaybookHealth,
  computeNextRoutineRunAt,
  createDefaultMandate,
  evaluateHeuristicEpicReplan,
  isSubtaskScopeWithinEpic,
  isWithinActiveHours,
  parseRoutineProbeVerdict,
  pickNextFallbackEngine,
  resolveFallbackChain,
  scoreArenaCandidates,
  selectPlaybookRulesForContext,
  selectRelevantCasesForContext,
  type CasebookEntry,
  type PlaybookEntry,
  type RepoConfig,
  type Ticket,
} from "../src/index.ts";

function makeRepo(overrides?: Partial<RepoConfig>): RepoConfig {
  const ts = "2026-11-23T00:00:00.000Z";
  return {
    id: "repo_1",
    name: "demo",
    rootPath: "/tmp/demo",
    baseBranch: "main",
    mode: "observe",
    defaultTemplate: "standard",
    preferredImplementEngine: "claude",
    preferredReviewEngine: "codex",
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

function makeTicket(overrides?: Partial<Ticket>): Ticket {
  const ts = "2026-11-23T00:00:00.000Z";
  return {
    id: "tkt_1",
    repoId: "repo_1",
    threadId: "thr_1",
    sourceTriggerId: "trg_1",
    title: "Implement auth helper",
    description: "Add auth token verification helper",
    status: "delivered",
    template: "standard",
    currentStage: "rebase",
    stageRetries: 0,
    mandate: createDefaultMandate({ allowedPaths: ["packages/core/**"] }),
    dependsOn: [],
    nativeSessions: {},
    inlineMemory: {
      goal: "Add auth helper",
      acceptanceCriteria: ["Passes tests"],
      stageNotes: [],
      threadUpdates: [],
    },
    costUsd: 0.1,
    priority: 1,
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

describe("v0.7.0 Core Domain Logic (A.1 + B.1 + C.1 + C.2)", () => {
  it("A.1 evaluates overnight & daytime active windows, cron nextRunAt, and clean/promote verdicts", () => {
    const insideNight = new Date(2026, 10, 23, 23, 30, 0);
    const earlyMorning = new Date(2026, 10, 24, 5, 15, 0);
    const afternoon = new Date(2026, 10, 23, 14, 0, 0);

    expect(isWithinActiveHours(insideNight, "23:00", "06:00")).toBe(true);
    expect(isWithinActiveHours(earlyMorning, "23:00", "06:00")).toBe(true);
    expect(isWithinActiveHours(afternoon, "23:00", "06:00")).toBe(false);
    expect(isWithinActiveHours(afternoon, "09:00", "18:00")).toBe(true);

    const base = new Date(2026, 10, 23, 1, 15, 0);
    const nextCron = new Date(
      computeNextRoutineRunAt({ scheduleKind: "cron", cronExpr: "0 2 * * *" }, base),
    );
    expect(nextCron.getHours()).toBe(2);
    expect(nextCron.getMinutes()).toBe(0);

    expect(parseRoutineProbeVerdict("All green. ROUTINE_VERDICT: CLEAN", []).action).toBe("clean");
    expect(
      parseRoutineProbeVerdict("ROUTINE_VERDICT: ISSUE_FOUND - flaky lockfile check", []),
    ).toEqual({
      action: "promote",
      summary: "flaky lockfile check",
      isIssueReportOnly: true,
    });
    expect(parseRoutineProbeVerdict("Patched typo", ["README.md"])).toMatchObject({
      action: "promote",
      isIssueReportOnly: false,
    });
  });

  it("B.1 enforces non-mock fallback chain ordering and scores Arena duel candidates", () => {
    const repo = makeRepo({ fallbackEngines: ["opencode", "codex"] });
    const chain = resolveFallbackChain({
      primaryEngine: "claude",
      repo,
      availableEngines: ["claude", "codex", "opencode", "mock"],
      failedEngines: [],
    });
    expect(chain).toEqual(["opencode", "codex"]);
    expect(chain.includes("mock")).toBe(false);

    expect(
      pickNextFallbackEngine({
        currentEngine: "opencode",
        failedEngines: ["claude", "opencode"],
        repo,
        availableEngines: ["claude", "codex", "opencode", "mock"],
      }),
    ).toBe("codex");

    // Exhausted all real engines -> never silently fall back to mock
    expect(
      pickNextFallbackEngine({
        currentEngine: "codex",
        failedEngines: ["claude", "opencode", "codex"],
        repo,
        availableEngines: ["claude", "codex", "opencode", "mock"],
      }),
    ).toBeUndefined();

    const [candA, candB] = scoreArenaCandidates(
      {
        candidateId: "cand_a",
        engine: "claude",
        branchName: "b1",
        stageRunId: "r1",
        verificationPassed: true,
        verificationSummary: "ok",
        changedFiles: ["src/a.ts"],
        addedLines: 40,
        deletedLines: 10,
        durationMs: 2500,
        costUsd: 0.12,
        summary: "Verbose solution",
      },
      {
        candidateId: "cand_b",
        engine: "codex",
        branchName: "b2",
        stageRunId: "r2",
        verificationPassed: true,
        verificationSummary: "ok",
        changedFiles: ["src/a.ts"],
        addedLines: 12,
        deletedLines: 4,
        durationMs: 1800,
        costUsd: 0.06,
        summary: "Clean concise solution",
      },
    );
    expect(candB.score).toBeGreaterThan(candA.score);
    expect(candB.recommended).toBe(true);
    expect(candA.recommended).toBe(false);
  });

  it("C.1 classifies in-scope adaptive Epic updates as auto-apply and topology/scope expansion as human approval", () => {
    const epic = makeTicket({
      id: "epc_1",
      isEpic: true,
      mandate: createDefaultMandate({ allowedPaths: ["packages/core/**", "packages/server/**"] }),
    });
    const repo = makeRepo();

    expect(isSubtaskScopeWithinEpic(["packages/core/src/**"], epic.mandate.allowedPaths)).toBe(true);
    expect(isSubtaskScopeWithinEpic(["packages/web/**"], epic.mandate.allowedPaths)).toBe(false);

    const autoCheck = classifyEpicReplanApproval({
      epic,
      repo,
      mutations: [
        {
          kind: "update_subtask",
          targetSubtaskKey: "server",
          description: "Consume new verifyJwt symbol",
          allowedPaths: ["packages/server/src/**"],
          reason: "Sync exported signature",
        },
      ],
    });
    expect(autoCheck.requiresHumanApproval).toBe(false);

    const approvalCheck = classifyEpicReplanApproval({
      epic,
      repo,
      mutations: [
        {
          kind: "add_subtask",
          title: "Add UI glue",
          allowedPaths: ["packages/web/**"],
          reason: "Requires new UI adapter",
        },
      ],
    });
    expect(approvalCheck.requiresHumanApproval).toBe(true);

    const childWaiting = makeTicket({
      id: "tkt_wait",
      parentTicketId: "epc_1",
      subtaskKey: "step_2",
      dependsOn: ["tkt_done"],
      status: "waiting_deps",
      description: "Implement endpoint",
    });
    const completedSub = makeTicket({ id: "tkt_done", subtaskKey: "step_1" });
    const prop = evaluateHeuristicEpicReplan({
      epic,
      completedSubtask: completedSub,
      digest: {
        ticketId: "tkt_done",
        repoId: "repo_1",
        title: "Auth contract",
        summary: "Added verifyToken helper",
        changedFiles: ["packages/core/src/auth.ts"],
        exportedSymbols: ["verifyToken(raw: string): boolean"],
        contractSnippets: ["POST /api/auth/verify"],
        formattedMarkdown: "...",
        version: 1,
        generatedAt: "2026-11-23T00:00:00.000Z",
      },
      unstartedSubtasks: [childWaiting],
      allSubtasks: [completedSub, childWaiting],
    });
    expect(prop.shouldReplan).toBe(true);
    expect(prop.requiresHumanApproval).toBe(false);
    expect(prop.mutations[0]?.kind).toBe("update_subtask");
  });

  it("C.2 scores hybrid Casebook recall, isolates reverted warnings, and protects human/pinned Playbook rules from decay", () => {
    const tDelivered = makeTicket({
      id: "tkt_ok",
      title: "Fix SQLite WAL busy lock",
      inlineMemory: {
        goal: "Prevent SQLITE_BUSY under concurrent outbox ticks",
        acceptanceCriteria: [],
        stageNotes: [
          {
            stageRunId: "r1",
            stage: "implement",
            engine: "claude",
            summary: "Added PRAGMA busy_timeout = 5000",
            changedFiles: ["packages/drivers/src/storage/sqlite-state-store.ts"],
            verificationPassed: true,
            spillArtifactIds: [],
            createdAt: "2026-11-23T00:00:00.000Z",
          },
        ],
        threadUpdates: [],
      },
    });
    const cOk: CasebookEntry = buildCasebookEntryFromTicket({ ticket: tDelivered });
    const cReverted: CasebookEntry = {
      ...buildCasebookEntryFromTicket({
        ticket: makeTicket({
          id: "tkt_bad",
          title: "Naive SQLite disable WAL attempt",
          revertedAt: "2026-11-23T01:00:00.000Z",
          mandate: createDefaultMandate({ allowedPaths: ["packages/drivers/**"] }),
        }),
      }),
      changedFiles: ["packages/drivers/src/storage/sqlite-state-store.ts"],
      scopePaths: ["packages/drivers/**"],
    };

    const recall = selectRelevantCasesForContext({
      cases: [cOk, cReverted],
      targetPaths: ["packages/drivers/src/storage/**"],
      queryText: "SQLite busy timeout concurrent",
      ftsTicketIds: new Set(["tkt_ok"]),
    });
    expect(recall.positiveCases.map((c) => c.ticketId)).toEqual(["tkt_ok"]);
    expect(recall.revertedWarnings.map((c) => c.ticketId)).toEqual(["tkt_bad"]);
    expect(recall.formattedMarkdown).toContain("REVERTED PITFALL WARNING");

    const nowMs = Date.parse("2026-11-23T00:00:00.000Z");
    const oldIso = "2026-09-01T00:00:00.000Z";
    const humanOld: PlaybookEntry = {
      id: "pb_h",
      repoId: "repo_1",
      rule: "Always keep transactions atomic",
      scopePaths: ["packages/drivers/**"],
      source: "human",
      enabled: true,
      pinned: false,
      hitCount: 0,
      createdAt: oldIso,
      updatedAt: oldIso,
    };
    const autoStale: PlaybookEntry = {
      ...humanOld,
      id: "pb_s",
      source: "auto_healed",
      rule: "Old unused auto rule",
    };
    const autoSuspect: PlaybookEntry = {
      ...humanOld,
      id: "pb_susp",
      source: "auto_healed",
      rule: "Suspect reverted rule",
      suspect: true,
      createdAt: "2026-11-22T00:00:00.000Z",
      updatedAt: "2026-11-22T00:00:00.000Z",
    };
    const autoZombie: PlaybookEntry = {
      ...humanOld,
      id: "pb_zom",
      source: "auto_healed",
      scopePaths: ["packages/deleted_pkg/**"],
      rule: "Removed pkg rule",
      createdAt: "2026-11-22T00:00:00.000Z",
      updatedAt: "2026-11-22T00:00:00.000Z",
    };

    expect(classifyPlaybookHealth(humanOld, { nowMs })).toMatchObject({
      status: "healthy",
      prunable: false,
    });
    expect(classifyPlaybookHealth(autoStale, { nowMs })).toMatchObject({
      status: "stale",
      prunable: true,
    });
    expect(classifyPlaybookHealth(autoSuspect, { nowMs })).toMatchObject({
      status: "suspect",
      prunable: true,
    });
    expect(
      classifyPlaybookHealth(autoZombie, { nowMs, pathExists: () => false }),
    ).toMatchObject({ status: "zombie_path", prunable: true });

    // Healthy rule should outrank suspect rule even though both match
    const selected = selectPlaybookRulesForContext(
      [autoSuspect, humanOld],
      ["packages/drivers/**"],
      1,
      1200,
      { nowMs },
    );
    expect(selected[0]?.id).toBe("pb_h");
  });
});
