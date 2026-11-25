import { describe, expect, it } from "bun:test";
import {
  ACTIVE_DURATION_EXTENSION_SEC,
  DEFAULT_ENGINE_COOLDOWN_MS,
  PERSISTENT_ENGINE_COOLDOWN_MS,
  TRANSIENT_ENGINE_COOLDOWN_MS,
  TwoTierWatchdog,
  createDefaultMandate,
  getAlternateEngine,
  getCooldownMsForFailureKind,
  inferRefactorGuardFromRequirement,
  isPersistentEngineFailure,
  pickNextFallbackEngine,
  planMilestoneWaves,
  selectEngineForStage,
  selectReviewEngine,
  type ControlPlaneLLM,
  type RepoConfig,
  type StageRun,
  type WorkerEngineId,
} from "../src/index.ts";
import { heuristicPlanRequirementIntake as planRequirementIntake } from "../src/intake.ts";
import { releaseMilestoneOp } from "../src/kernel/milestone-coordinator.ts";
import { tripEngineIfDeterministic } from "../src/kernel/stage-engine-helpers.ts";
import {
  extractSingleFlakyTestTarget,
  runRepoVerificationGateOp,
} from "../src/kernel/stage-verification-helpers.ts";

function makeRepo(overrides?: Partial<RepoConfig>): RepoConfig {
  const ts = "2026-11-25T00:00:00.000Z";
  return {
    id: "repo_1",
    name: "demo",
    rootPath: "/tmp/demo",
    baseBranch: "main",
    mode: "auto",
    defaultTemplate: "standard",
    preferredImplementEngine: "claude",
    preferredReviewEngine: "claude",
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

describe("v1.7.0 tiered circuit breaker cooldowns", () => {
  it("keeps the legacy default and adds 15m / 24h tiers", () => {
    expect(DEFAULT_ENGINE_COOLDOWN_MS).toBe(30 * 60_000);
    expect(TRANSIENT_ENGINE_COOLDOWN_MS).toBe(15 * 60_000);
    expect(PERSISTENT_ENGINE_COOLDOWN_MS).toBe(24 * 60 * 60_000);
  });

  it("classifies persistent vs transient failure kinds", () => {
    for (const k of ["model_unsupported", "tier_ineligible", "auth_invalid", "quota_exhausted"] as const) {
      expect(isPersistentEngineFailure(k)).toBe(true);
      expect(getCooldownMsForFailureKind(k)).toBe(PERSISTENT_ENGINE_COOLDOWN_MS);
    }
    expect(isPersistentEngineFailure("transient")).toBe(false);
    expect(isPersistentEngineFailure(undefined)).toBe(false);
    expect(getCooldownMsForFailureKind("transient")).toBe(TRANSIENT_ENGINE_COOLDOWN_MS);
  });

  it("tripEngineIfDeterministic persists a 24h cooldown for quota exhaustion", async () => {
    const saved: Array<{ cooldownUntil?: string }> = [];
    const ctx = {
      stateStore: {
        getEngineHealth: async () => null,
        saveEngineHealth: async (r: { cooldownUntil?: string }) => {
          saved.push(r);
        },
      },
      recordFlightEvent: async () => undefined,
    } as never;
    const before = Date.now();
    const tripped = await tripEngineIfDeterministic(ctx, {
      engine: "claude",
      message: "Quota exceeded for project",
      repoId: "repo_1",
      ticketId: "tkt_1",
      stage: "implement",
    });
    expect(tripped).toBe(true);
    const until = Date.parse(saved[0]!.cooldownUntil!);
    expect(until - before).toBeGreaterThanOrEqual(PERSISTENT_ENGINE_COOLDOWN_MS - 5_000);
    expect(until - before).toBeLessThanOrEqual(PERSISTENT_ENGINE_COOLDOWN_MS + 5_000);
  });
});

describe("v1.7.0 strict fallbackEngines whitelist", () => {
  const all: WorkerEngineId[] = ["claude", "codex", "gemini", "opencode"];

  it("selectReviewEngine never crosses outside the whitelist", () => {
    const repo = makeRepo({
      preferredImplementEngine: "claude",
      preferredReviewEngine: "claude",
      fallbackEngines: ["opencode"],
    });
    const picked = selectReviewEngine({ repo, implementEngine: "claude", availableEngines: all });
    expect(picked).toBe("opencode");
  });

  it("allows isolated blind review on implementEngine when it is the only whitelisted engine left", () => {
    const repo = makeRepo({
      preferredImplementEngine: "claude",
      preferredReviewEngine: "claude",
      fallbackEngines: ["opencode"],
    });
    const picked = selectReviewEngine({
      repo,
      implementEngine: "claude",
      availableEngines: all,
      trippedEngines: ["opencode"],
    });
    expect(picked).toBe("claude");
  });

  it("selectEngineForStage skips tripped engines only within the whitelist", () => {
    const repo = makeRepo({ fallbackEngines: ["opencode"] });
    expect(selectEngineForStage(repo, "implement", undefined, ["claude"])).toBe("opencode");
    // opencode also tripped -> nothing whitelisted is healthy, keep the original rather than codex/gemini
    expect(selectEngineForStage(repo, "implement", undefined, ["claude", "opencode"])).toBe("claude");
  });

  it("pickNextFallbackEngine honors the whitelist", () => {
    const repo = makeRepo({ fallbackEngines: ["opencode"] });
    expect(pickNextFallbackEngine({ currentEngine: "claude", repo, availableEngines: all })).toBe("opencode");
    expect(
      pickNextFallbackEngine({
        currentEngine: "claude",
        failedEngines: ["opencode"],
        repo,
        availableEngines: all,
      }),
    ).toBeUndefined();
  });

  it("keeps legacy unrestricted behavior without fallbackEngines", () => {
    const repo = makeRepo();
    expect(pickNextFallbackEngine({ currentEngine: "claude", repo, availableEngines: all })).toBe("codex");
  });
});

describe("v1.7.0 milestone release Boot Canary", () => {
  function makeReleaseCtx(opts: { canaryOk: boolean; commitSha?: string; preSha?: string }) {
    const calls = {
      canary: [] as unknown[],
      reset: [] as unknown[],
      inbox: [] as Array<{ kind: string; contextPayload?: Record<string, unknown> }>,
      flight: [] as Array<{ kind: string }>,
      reloadPhases: [] as string[],
    };
    const repo = makeRepo({ rootPath: "/tmp/self" });
    const milestone = {
      id: "mst_1",
      repoId: repo.id,
      name: "v1.7.0",
      targetVersion: "1.7.0",
      integrationMode: "direct_main",
      status: "ready_to_release",
      items: [],
      createdAt: "t",
      updatedAt: "t",
    };
    let reloadState = { phase: "idle" } as { phase: string };
    const ctx = {
      stateStore: {
        getMilestone: async () => milestone,
        saveMilestone: async () => undefined,
        listMilestones: async () => [milestone],
        getRepo: async () => repo,
        listInboxItems: async () => [],
        saveInboxItem: async (i: { kind: string; contextPayload?: Record<string, unknown> }) => {
          calls.inbox.push(i);
        },
      },
      workspace: {
        getHeadCommitSha: async () => opts.preSha,
        executeMilestoneRelease: async () => ({ commitSha: opts.commitSha, pushed: false }),
        resetBranchRef: async (...args: unknown[]) => {
          calls.reset.push(args);
        },
      },
      runWithRepoWorkspaceLock: async (_id: string, fn: () => Promise<unknown>) => fn(),
      recordFlightEvent: async (e: { kind: string }) => {
        calls.flight.push(e);
      },
      emitEvent: () => undefined,
      selfHostRunner: {
        selfRepoRoot: "/tmp/self",
        verifyBuildAndCanaryBoot: async (o: unknown) => {
          calls.canary.push(o);
          return opts.canaryOk
            ? { ok: true, buildOk: true, canaryPort: 1234, durationMs: 5, summary: "ok" }
            : { ok: false, buildOk: false, durationMs: 5, summary: "boom" };
        },
        triggerProcessReload: async () => undefined,
      },
      get selfReloadState() {
        return reloadState;
      },
      setSelfReloadState: (s: { phase: string }) => {
        reloadState = s;
        calls.reloadPhases.push(s.phase);
      },
      isStopped: () => true, // keep the deferred drain loop inert in tests
      activeTicketRuns: new Map(),
      activeRoutineRuns: new Map(),
      finalizingEpics: new Set(),
      hasActiveOutboxFlush: () => false,
    };
    return { ctx: ctx as never, calls };
  }

  it("runs the canary on the released commit and schedules a reload when it passes", async () => {
    const { ctx, calls } = makeReleaseCtx({ canaryOk: true, commitSha: "newsha", preSha: "oldsha" });
    await releaseMilestoneOp(ctx, "mst_1");
    expect(calls.canary).toEqual([{ commitSha: "newsha" }]);
    expect(calls.reloadPhases).toContain("canary_probing");
    expect(calls.reloadPhases).toContain("draining");
    expect(calls.reset).toHaveLength(0);
  });

  it("resets baseBranch to preReleaseSha and escalates when the canary fails", async () => {
    const { ctx, calls } = makeReleaseCtx({ canaryOk: false, commitSha: "newsha", preSha: "oldsha" });
    const released = await releaseMilestoneOp(ctx, "mst_1");
    expect(released.status).toBe("released");
    expect(calls.reset).toEqual([["/tmp/self", "main", "oldsha"]]);
    expect(calls.flight.some((e) => e.kind === "canary_rolled_back")).toBe(true);
    expect(calls.inbox[0]?.kind).toBe("watchdog_escalation");
    expect(calls.inbox[0]?.contextPayload?.selfHostRollback).toBe(true);
    expect(calls.reloadPhases.at(-1)).toBe("rolled_back");
  });

  it("skips the canary when the release produced no new commit", async () => {
    const { ctx, calls } = makeReleaseCtx({ canaryOk: true, commitSha: "same", preSha: "same" });
    await releaseMilestoneOp(ctx, "mst_1");
    expect(calls.canary).toHaveLength(0);
  });
});

describe("v1.7.0 single-flake verification guard", () => {
  const flakyOut = [
    "packages/drivers/test/v090-drivers.test.ts:",
    "(fail) smoke > chrome cdp screenshot [5001ms]",
    "error: Chrome timed out waiting for CDP",
  ].join("\n");

  it("returns the lone untouched failing file with an external-process marker", () => {
    expect(extractSingleFlakyTestTarget(flakyOut, ["packages/core/src/x.ts"])).toBe(
      "packages/drivers/test/v090-drivers.test.ts",
    );
  });

  it("returns null when the failing file was changed, markers are absent, or multiple files fail", () => {
    expect(extractSingleFlakyTestTarget(flakyOut, ["packages/drivers/test/v090-drivers.test.ts"])).toBeNull();
    expect(
      extractSingleFlakyTestTarget(
        "(fail) packages/core/test/a.test.ts > assertion expected 1 got 2",
        [],
      ),
    ).toBeNull();
    expect(
      extractSingleFlakyTestTarget(
        "(fail) packages/core/test/a.test.ts > ECONNREFUSED\n(fail) packages/core/test/b.test.ts > ECONNREFUSED",
        [],
      ),
    ).toBeNull();
    expect(extractSingleFlakyTestTarget("", [])).toBeNull();
  });

  function makeGateCtx(rerunOk: boolean) {
    const runs: string[][] = [];
    const flights: Array<{ kind: string; metadata?: Record<string, unknown> }> = [];
    const failOutput =
      "(fail) packages/drivers/test/v090-drivers.test.ts > chrome cdp [5001ms]\nerror: timed out";
    const ctx = {
      getEffectiveBaseInfo: async () => ({ effectiveBaseBranch: "main" }),
      workspace: {
        getChangedFiles: async () => ["packages/core/src/a.ts"],
        runVerificationCommands: async (_p: string, cmds: string[]) => {
          runs.push(cmds);
          if (runs.length === 1) {
            return {
              ok: false,
              failedCommand: "bun test",
              summary: "bun test failed",
              results: [{ command: "bun test", exitCode: 1, durationMs: 1, output: failOutput }],
            };
          }
          return {
            ok: rerunOk,
            failedCommand: rerunOk ? undefined : cmds[0],
            summary: rerunOk ? "ok" : "still failing",
            results: [{ command: cmds[0], exitCode: rerunOk ? 0 : 1, durationMs: 1, output: "" }],
          };
        },
      },
      artifactStore: { writeSpill: async () => ({ id: "art_1" }) },
      stateStore: { saveArtifact: async () => undefined },
      emitEvent: () => undefined,
      recordFlightEvent: async (e: { kind: string; metadata?: Record<string, unknown> }) => {
        flights.push(e);
      },
    };
    return { ctx: ctx as never, runs, flights };
  }

  const repo = makeRepo({ verificationCommands: ["bun test"] });
  const ticket = { id: "tkt_1", mandate: createDefaultMandate({}) } as never;
  const stageRun = { id: "run_1", ticketId: "tkt_1", stage: "implement", engine: "claude" } as never;

  it("reruns the single flaky file once and passes the gate when it succeeds", async () => {
    const { ctx, runs, flights } = makeGateCtx(true);
    const res = await runRepoVerificationGateOp(ctx, ticket, repo, stageRun, "/tmp/wt");
    expect(res.passed).toBe(true);
    expect(runs).toHaveLength(2);
    expect(runs[1]).toEqual(["bun test packages/drivers/test/v090-drivers.test.ts"]);
    expect(res.result?.summary).toContain("[flake-retried PASS: packages/drivers/test/v090-drivers.test.ts]");
    expect(flights.find((f) => f.kind === "flake_retried")?.metadata).toEqual({
      testFile: "packages/drivers/test/v090-drivers.test.ts",
      stage: "implement",
    });
  });

  it("fails normally (single retry only) when the rerun fails", async () => {
    const { ctx, runs, flights } = makeGateCtx(false);
    const res = await runRepoVerificationGateOp(ctx, ticket, repo, stageRun, "/tmp/wt");
    expect(res.passed).toBe(false);
    expect(runs).toHaveLength(2);
    expect(flights.some((f) => f.kind === "flake_retried")).toBe(false);
  });
});

describe("v1.7.0 explicit scope priority & punctuation cleanup", () => {
  function plan(requirement: string) {
    return planRequirementIntake({
      repo: makeRepo(),
      requirement,
      preferredRoute: "single_ticket",
      defaultTemplate: "standard",
    } as never);
  }

  it("strips trailing punctuation and uses ONLY scope: tags when present", () => {
    const p = plan(
      "Refine retry logic (scope:packages/core/**, scope:packages/drivers/**). Also touches packages/web/src/app.tsx.",
    );
    expect(p.singleSpec?.allowedPaths).toEqual(["packages/core/**", "packages/drivers/**"]);
  });

  it("falls back to path literal inference when no scope: tag exists", () => {
    const p = plan("Fix bug in packages/core/src/router.ts please");
    expect(p.singleSpec?.allowedPaths).toContain("packages/core/src/router.ts");
  });
});

describe("v1.7.0 auto RefactorGuard & safe-refactor concurrency", () => {
  it("infers a guard for hotspot refactors naming a source file", () => {
    expect(
      inferRefactorGuardFromRequirement(
        "Safe-refactor packages/core/src/kernel/foo.ts to under 900 lines, tests in packages/core/test/foo.test.ts",
      ),
    ).toEqual({
      targetHotspotPath: "packages/core/src/kernel/foo.ts",
      maxLinesAfter: 900,
      enforceExportParity: true,
    });
    expect(inferRefactorGuardFromRequirement("split hotspot packages/core/src/a.ts")?.maxLinesAfter).toBe(1200);
  });

  it("returns undefined for non-refactor text or test-only targets", () => {
    expect(inferRefactorGuardFromRequirement("add feature in packages/core/src/a.ts")).toBeUndefined();
    expect(inferRefactorGuardFromRequirement("safe-refactor packages/core/test/a.test.ts")).toBeUndefined();
    expect(inferRefactorGuardFromRequirement("safe-refactor everything")).toBeUndefined();
  });

  it("attaches the inferred guard onto singleSpec", () => {
    const p = planRequirementIntake({
      repo: makeRepo(),
      requirement: "Safe-refactor packages/core/src/a.ts scope:packages/core/src/a.ts",
      defaultTemplate: "standard",
    } as never);
    expect(p.singleSpec?.refactorGuard?.targetHotspotPath).toBe("packages/core/src/a.ts");
  });

  it("disjoint guarded milestone items share wave 0; overlapping ones still serialize", () => {
    const guard = { targetHotspotPath: "x", enforceExportParity: true };
    const waves = planMilestoneWaves([
      { id: "a", index: 0, requirement: "r", title: "a", route: "single_ticket", allowedPaths: ["packages/core/src/a.ts"], refactorGuard: guard },
      { id: "b", index: 1, requirement: "r", title: "b", route: "single_ticket", allowedPaths: ["packages/core/src/b.ts"], refactorGuard: guard },
      { id: "c", index: 2, requirement: "r", title: "c", route: "single_ticket", allowedPaths: ["packages/core/src/a.ts"], refactorGuard: guard },
    ]);
    expect(waves.map((w) => w.waveIndex)).toEqual([0, 0, 1]);
    expect(waves[2]!.dependsOnIndices).toEqual([0]);
  });
});

describe("v1.7.0 Watchdog 2.0", () => {
  const llm: ControlPlaneLLM = {
    providerName: "stub",
    async triageTrigger() {
      throw new Error("unused");
    },
    async diagnoseWatchdog() {
      return { action: "CONTINUE", reason: "x" };
    },
  } as never;
  const mandate = createDefaultMandate({ maxCostUsd: 10, maxDurationSec: 100, maxStageRetries: 2 });
  const stageRun: StageRun = {
    id: "run_1",
    ticketId: "tkt_1",
    stage: "implement",
    engine: "claude",
    status: "running",
    costUsd: 0,
    startedAt: new Date(0).toISOString(),
  };

  function setup() {
    const wd = new TwoTierWatchdog(llm, { silenceTimeoutMs: 10_000_000 });
    const tracker = wd.createTracker(stageRun, mandate, 0);
    return { wd, tracker };
  }

  it("initializes extension state", () => {
    const { tracker } = setup();
    expect(tracker.durationExtensionCount).toBe(0);
    expect(tracker.lastExtensionDiffCount).toBe(0);
    expect(tracker.effectiveMaxDurationSec).toBe(100);
  });

  it("grants two 300s extensions on active progress, then hard-stops", () => {
    const { wd, tracker } = setup();
    wd.recordDiffCheckpoint(tracker, "h1", true);
    tracker.lastEventAtMs = 101_000;
    expect(wd.evaluateL1(tracker, 101_000)).toBeNull();
    expect(tracker.durationExtensionCount).toBe(1);
    expect(tracker.effectiveMaxDurationSec).toBe(100 + ACTIVE_DURATION_EXTENSION_SEC);

    wd.recordDiffCheckpoint(tracker, "h2", true);
    tracker.lastEventAtMs = 401_000;
    expect(wd.evaluateL1(tracker, 401_000)).toBeNull();
    expect(tracker.durationExtensionCount).toBe(2);
    expect(tracker.effectiveMaxDurationSec).toBe(700);

    wd.recordDiffCheckpoint(tracker, "h3", true);
    tracker.lastEventAtMs = 701_000;
    expect(wd.evaluateL1(tracker, 701_000)?.kind).toBe("hard_budget_exceeded");
  });

  it("does not extend without progress, with errors, or above 85% budget", () => {
    let { wd, tracker } = setup();
    tracker.lastEventAtMs = 101_000;
    expect(wd.evaluateL1(tracker, 101_000)?.kind).toBe("hard_budget_exceeded");

    ({ wd, tracker } = setup());
    wd.recordDiffCheckpoint(tracker, "h1", true);
    tracker.consecutiveErrorCount = 1;
    tracker.lastEventAtMs = 101_000;
    expect(wd.evaluateL1(tracker, 101_000)?.kind).toBe("hard_budget_exceeded");

    ({ wd, tracker } = setup());
    wd.recordDiffCheckpoint(tracker, "h1", true);
    tracker.costUsd = 8.6;
    tracker.lastEventAtMs = 101_000;
    expect(wd.evaluateL1(tracker, 101_000)?.kind).toBe("hard_budget_exceeded");
  });

  it("tolerates A->B->A but flags A->B->A->B", () => {
    const { wd, tracker } = setup();
    for (const h of ["A", "B", "A"]) wd.recordDiffCheckpoint(tracker, h, true);
    expect(wd.evaluateL1(tracker, 1_000)).toBeNull();
    wd.recordDiffCheckpoint(tracker, "B", true);
    expect(wd.evaluateL1(tracker, 1_000)?.kind).toBe("diff_oscillation");
  });
});

describe("v1.7.0 review follow-ups", () => {
  it("getAlternateEngine honors an explicit whitelist", () => {
    const all: WorkerEngineId[] = ["claude", "codex", "gemini", "opencode"];
    expect(getAlternateEngine("claude", all)).toBe("codex");
    expect(getAlternateEngine("claude", all, ["claude", "opencode"])).toBe("opencode");
    expect(getAlternateEngine("claude", all, ["claude"])).toBeUndefined();
  });

  it("selectReviewEngine never escapes the whitelist as a last resort", () => {
    const repo = makeRepo({
      preferredImplementEngine: "claude",
      preferredReviewEngine: "claude",
      fallbackEngines: ["opencode"],
    });
    const picked = selectReviewEngine({
      repo,
      implementEngine: "claude",
      availableEngines: ["codex", "gemini"],
    });
    expect(picked).toBe("claude");
  });

  it("flake retry also runs the gate commands that follow the failed `bun test`", async () => {
    const runs: string[][] = [];
    const failOutput =
      "(fail) packages/drivers/test/v090-drivers.test.ts > chrome cdp\nerror: timed out";
    const ctx = {
      getEffectiveBaseInfo: async () => ({ effectiveBaseBranch: "main" }),
      workspace: {
        getChangedFiles: async () => [],
        runVerificationCommands: async (_p: string, cmds: string[]) => {
          runs.push(cmds);
          if (runs.length === 1) {
            return {
              ok: false,
              failedCommand: "bun test",
              summary: "bun test failed",
              results: [{ command: "bun test", exitCode: 1, durationMs: 1, output: failOutput }],
            };
          }
          const isBuild = cmds[0] === "bun run build";
          return {
            ok: !isBuild,
            failedCommand: isBuild ? "bun run build" : undefined,
            summary: isBuild ? "build failed" : "ok",
            results: [{ command: cmds[0], exitCode: isBuild ? 1 : 0, durationMs: 1, output: "" }],
          };
        },
      },
      artifactStore: { writeSpill: async () => ({ id: "art_1" }) },
      stateStore: { saveArtifact: async () => undefined },
      emitEvent: () => undefined,
      recordFlightEvent: async () => undefined,
    } as never;
    const repo = makeRepo({ verificationCommands: ["bun test", "bun run build"] });
    const res = await runRepoVerificationGateOp(
      ctx,
      { id: "tkt_1", mandate: createDefaultMandate({}) } as never,
      repo,
      { id: "run_1", ticketId: "tkt_1", stage: "implement", engine: "claude" } as never,
      "/tmp/wt",
    );
    expect(runs.map((r) => r[0])).toEqual([
      "bun test",
      "bun test packages/drivers/test/v090-drivers.test.ts",
      "bun run build",
    ]);
    expect(res.passed).toBe(false);
    expect(res.result?.failedCommand).toBe("bun run build");
  });
});
