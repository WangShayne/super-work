import { describe, expect, it } from "bun:test";
import {
  BUILTIN_TASK_BLUEPRINTS,
  MCP_TOOL_DEFINITIONS,
  applyBlueprintToTicketInput,
  buildConflictResolutionPrompt,
  createDefaultMandate,
  evaluateTicketRisk,
  formatConflictCardSummary,
  handleMcpJsonRpcMessage,
  resolveRepoBlueprints,
  type ConflictSemanticContext,
  type McpJsonRpcResponse,
  type McpToolHost,
  type RepoConfig,
  type Ticket,
} from "../src/index.ts";
import { SpanRecorder } from "../src/kernel/span-recorder.ts";

function makeRepo(overrides?: Partial<RepoConfig>): RepoConfig {
  return {
    id: "repo_v100",
    name: "v100-app",
    rootPath: "/tmp/v100-app",
    baseBranch: "main",
    mode: "auto",
    defaultTemplate: "standard",
    defaultTddMode: false,
    forbiddenPaths: [".env*"],
    preferredImplementEngine: "claude",
    preferredReviewEngine: "codex",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeTicket(overrides?: Partial<Ticket>): Ticket {
  return {
    id: "tkt_v100",
    repoId: "repo_v100",
    threadId: "thr_v100",
    sourceTriggerId: "trg_v100",
    title: "Harden session token checks",
    description: "Ensure bearer tokens validate expiry cleanly",
    status: "implementing",
    template: "standard",
    currentStage: "rebase",
    stageRetries: 0,
    mandate: createDefaultMandate({ allowedPaths: ["src/**"], maxCostUsd: 3 }),
    dependsOn: [],
    nativeSessions: {},
    inlineMemory: {
      goal: "goal",
      acceptanceCriteria: [],
      stageNotes: [],
      threadUpdates: [],
    },
    costUsd: 0.1,
    priority: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("v1.0.0 Core Engines (A.1 Risk Gate + D.1 Blueprints + B.2 Conflict Context + C.1 Spans + MCP 1.0.0)", () => {
  it("A.1: computes deterministic risk scores and respects always_auto, risk_gated, and always_signoff", () => {
    const repoGated = makeRepo({
      deliveryGatePolicy: "risk_gated",
      riskThreshold: 35,
      sensitivePaths: ["src/auth/**"],
    });

    const riskyTicket = makeTicket({
      stageRetries: 1,
      conflictResolutionCount: 1,
      impactSummary: {
        directDependents: ["a.ts", "b.ts"],
        transitiveDependents: ["c.ts"],
        semanticDepTicketIds: [],
      },
    });

    const highRisk = evaluateTicketRisk({
      ticket: riskyTicket,
      repo: repoGated,
      changedFiles: ["src/auth/jwt.ts", "src/routes.ts"],
      addedLines: 320,
      deletedLines: 140,
      maxVisualDiffRatio: 0.05,
    });

    expect(highRisk.score).toBeGreaterThan(35);
    expect(highRisk.level).toBe("high");
    expect(highRisk.requiresSignoff).toBe(true);
    expect(highRisk.factors.some((f) => f.key === "sensitive_paths")).toBe(true);
    expect(highRisk.factors.some((f) => f.key === "conflict_resolved")).toBe(true);

    // always_auto keeps backward compatibility (never blocks automatic outbox delivery)
    const defaultRepo = makeRepo();
    const autoEval = evaluateTicketRisk({
      ticket: riskyTicket,
      repo: defaultRepo,
      changedFiles: ["src/auth/jwt.ts"],
      addedLines: 500,
    });
    expect(autoEval.policy).toBe("always_auto");
    expect(autoEval.requiresSignoff).toBe(false);

    // verified TDD + static + smoke + clean review reduces risk below threshold
    const lowRisk = evaluateTicketRisk({
      ticket: makeTicket({
        tddMode: true,
        lockedTestPaths: ["test/token.test.ts"],
      }),
      repo: repoGated,
      changedFiles: ["src/helpers/format.ts"],
      addedLines: 20,
      deletedLines: 4,
      staticVerificationPassed: true,
      smokeResult: {
        ok: true,
        port: 3000,
        readyUrl: "http://127.0.0.1:3000",
        startupDurationMs: 120,
        checkResults: [],
        serverOutputTail: "",
        summary: "PASS",
      },
      reviewReport: {
        verdict: "approved",
        summary: "Clean diff",
        findings: [],
        reviewedByEngine: "codex",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(lowRisk.score).toBeLessThanOrEqual(35);
    expect(lowRisk.requiresSignoff).toBe(false);

    // always_signoff blocks regardless of low score
    const forcedSignoff = evaluateTicketRisk({
      ticket: makeTicket({ deliveryGatePolicy: "always_signoff" }),
      repo: defaultRepo,
      changedFiles: ["README.md"],
      addedLines: 2,
      staticVerificationPassed: true,
    });
    expect(forcedSignoff.policy).toBe("always_signoff");
    expect(forcedSignoff.requiresSignoff).toBe(true);
  });

  it("D.1: merges built-in & custom blueprints and enforces explicit > blueprint > repo precedence", () => {
    expect(BUILTIN_TASK_BLUEPRINTS.length).toBe(5);
    const repo = makeRepo({
      defaultTemplate: "fast",
      defaultTddMode: false,
      deliveryGatePolicy: "always_auto",
      blueprints: [
        {
          id: "tdd-bugfix",
          name: "Custom Bugfix Override",
          description: "Org override",
          template: "strict",
          tddMode: true,
          deliveryGatePolicy: "risk_gated",
          riskThreshold: 25,
          allowedPaths: ["src/**"],
          promptPrefix: "[ORG-GUARD]",
          acceptanceCriteria: ["Custom AC"],
        },
        {
          id: "infra-mig",
          name: "DB Migration",
          description: "Zero-downtime migration",
          template: "strict",
          deliveryGatePolicy: "always_signoff",
          allowedPaths: ["migrations/**"],
        },
      ],
    });

    const list = resolveRepoBlueprints(repo);
    expect(list.length).toBe(6);
    const overridden = list.find((b) => b.id === "tdd-bugfix")!;
    expect(overridden.builtin).toBe(false);
    expect(overridden.template).toBe("strict");

    const appliedFromBp = applyBlueprintToTicketInput(
      { repoId: repo.id, title: "Fix edge case", description: "Fix null check" },
      overridden,
    );
    expect(appliedFromBp.template).toBe("strict");
    expect(appliedFromBp.tddMode).toBe(true);
    expect(appliedFromBp.deliveryGatePolicy).toBe("risk_gated");
    expect(appliedFromBp.riskThreshold).toBe(25);
    expect(appliedFromBp.allowedPaths).toEqual(["src/**"]);
    expect(appliedFromBp.description).toContain("[ORG-GUARD]");

    const explicitOverride = applyBlueprintToTicketInput(
      {
        repoId: repo.id,
        title: "Fix edge case",
        description: "Fix null check",
        template: "fast",
        tddMode: false,
        deliveryGatePolicy: "always_auto",
        allowedPaths: ["docs/**"],
      },
      overridden,
    );
    expect(explicitOverride.template).toBe("fast");
    expect(explicitOverride.tddMode).toBe(false);
    expect(explicitOverride.deliveryGatePolicy).toBe("always_auto");
    expect(explicitOverride.allowedPaths).toEqual(["docs/**"]);
  });

  it("B.2 & C.1: formats 3-way semantic conflict prompts and records StageSpan durations", () => {
    const ctx: ConflictSemanticContext = {
      baseBranch: "main",
      mergeBaseSha: "1234567890abcdef",
      upstreamCommitSummaries: ["abc1234 Rename helper"],
      conflictFiles: ["src/index.ts"],
      fileHunks: [
        {
          filePath: "src/index.ts",
          oursSummary: "+export const a = 1;",
          theirsSummary: "+export const a = 2;",
        },
      ],
    };
    const prompt = buildConflictResolutionPrompt(makeTicket({ lockedTestPaths: ["test/spec.test.ts"] }), ctx);
    expect(prompt).toContain("3-Way Semantic Rebase Conflict Resolution");
    expect(prompt).toContain("abc1234 Rename helper");
    expect(prompt).toContain("test/spec.test.ts");
    expect(formatConflictCardSummary(ctx)).toContain("Conflicting files (1): src/index.ts");

    const spans = new SpanRecorder();
    const prep = spans.start("workspace_prep", "Prepare");
    spans.end(prep, "ok", "branch-a");
    spans.addExisting([
      {
        kind: "static_verify",
        label: "Tests",
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T00:00:01.000Z",
        durationMs: 1000,
        status: "ok",
      },
    ]);
    expect(spans.toArray()).toHaveLength(2);
  });

  it("D.1 MCP: exposes submit_review_comments and system_doctor among 23 tools", async () => {
    expect(MCP_TOOL_DEFINITIONS).toHaveLength(26);
    const seen: string[] = [];
    const stubHost: McpToolHost = {
      getHealth: async () => ({ ok: true }),
      listRepos: async () => [],
      clarifySpec: async () => ({}),
      dispatchTicket: async () => ({}),
      dispatchEpic: async () => ({}),
      listTickets: async () => ({}),
      getTicketDetail: async () => ({}),
      listInbox: async () => ({}),
      resolveInbox: async () => ({}),
      searchMemoryAndCasebook: async () => ({}),
      triggerRoutine: async () => ({}),
      managePreview: async () => ({}),
      analyzeImpact: async () => ({}),
      manageCheckpoints: async () => ({}),
      mutateDagNode: async () => ({}),
      submitReviewComments: async (args) => {
        seen.push(`review:${String(args.ticketId)}`);
        return { comments: [], ticket: { id: args.ticketId } };
      },
      systemDoctor: async (args) => {
        seen.push(`doctor:${Boolean(args.fix)}`);
        return { healthy: true, fixesApplied: 0, items: [] };
      },
    };

    const reviewRes = await handleMcpJsonRpcMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "submit_review_comments",
          arguments: {
            ticketId: "tkt_1",
            mode: "comment_only",
            comments: [{ filePath: "src/a.ts", line: 10, body: "Extract helper" }],
          },
        },
      },
      stubHost,
    );
    expect((reviewRes as McpJsonRpcResponse | null)?.error).toBeUndefined();

    const docRes = await handleMcpJsonRpcMessage(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "system_doctor", arguments: { fix: true } },
      },
      stubHost,
    );
    expect((docRes as McpJsonRpcResponse | null)?.error).toBeUndefined();
    expect(seen).toEqual(["review:tkt_1", "doctor:true"]);
  });
});
