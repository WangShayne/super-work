import { describe, expect, it } from "bun:test";
import {
  MCP_TOOL_DEFINITIONS,
  buildStageToolProfile,
  createDefaultMandate,
  extractWorkerClarificationRequest,
  handleMcpJsonRpcMessage,
  runChiefOfStaffQuery,
  type InboxItem,
  type McpJsonRpcResponse,
  type McpToolHost,
  type RepoConfig,
  type Ticket,
  type WorkerStreamEvent,
} from "../src/index.ts";
import { HeuristicControlLLM } from "../../drivers/src/llm/control-plane-llm.ts";

function makeRepo(overrides?: Partial<RepoConfig>): RepoConfig {
  return {
    id: "repo_v110",
    name: "v110-app",
    rootPath: "/tmp/v110-app",
    baseBranch: "main",
    mode: "observe",
    defaultTemplate: "standard",
    preferredImplementEngine: "claude",
    preferredReviewEngine: "codex",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeTicket(overrides?: Partial<Ticket>): Ticket {
  return {
    id: "tkt_v110",
    repoId: "repo_v110",
    threadId: "thr_v110",
    sourceTriggerId: "trg_v110",
    title: "Refactor auth middleware",
    description: "Ensure bearer check handles expiry cleanly",
    status: "implementing",
    template: "standard",
    currentStage: "implement",
    stageRetries: 0,
    mandate: createDefaultMandate({ allowedPaths: ["src/**"], maxCostUsd: 3 }),
    dependsOn: [],
    nativeSessions: {},
    activeEngine: "claude",
    inlineMemory: {
      goal: "goal",
      acceptanceCriteria: [],
      stageNotes: [],
      threadUpdates: [],
    },
    costUsd: 0.15,
    priority: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("v1.1.0 Core Engines (B.2 Tool Profiler & Clarification + A.2 Chief + MCP 1.1.0)", () => {
  it("B.2: aggregates StageToolProfile with FIFO matching across toolu_* IDs and captures errors", () => {
    const events: WorkerStreamEvent[] = [
      {
        type: "tool_use",
        toolName: "Read",
        inputSummary: "src/index.ts",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      {
        type: "tool_result",
        toolName: "toolu_01abc",
        isError: false,
        outputSummary: "120 lines",
        timestamp: "2026-01-01T00:00:00.150Z",
      },
      {
        type: "tool_use",
        toolName: "Bash",
        inputSummary: "bun test",
        timestamp: "2026-01-01T00:00:01.000Z",
      },
      {
        type: "tool_result",
        toolName: "toolu_02def",
        isError: true,
        outputSummary: "FAIL test/auth.test.ts: expected 401 got 200",
        timestamp: "2026-01-01T00:00:02.250Z",
      },
      {
        type: "tool_use",
        toolName: "Edit",
        inputSummary: "src/auth.ts",
        timestamp: "2026-01-01T00:00:02.300Z",
      },
      {
        type: "tool_result",
        toolName: "Edit",
        isError: false,
        outputSummary: "updated",
        timestamp: "2026-01-01T00:00:02.500Z",
      },
      {
        type: "tool_use",
        toolName: "Bash",
        inputSummary: "bun test",
        timestamp: "2026-01-01T00:00:03.000Z",
      },
      {
        type: "tool_result",
        toolName: "toolu_03ghi",
        isError: false,
        outputSummary: "all passed",
        timestamp: "2026-01-01T00:00:03.400Z",
      },
    ];

    const profile = buildStageToolProfile(events);
    expect(profile.totalToolCalls).toBe(4);
    expect(profile.totalToolErrors).toBe(1);
    expect(profile.byTool[0]?.toolName).toBe("Bash");
    expect(profile.byTool[0]?.calls).toBe(2);
    expect(profile.byTool[0]?.errors).toBe(1);
    expect(profile.byTool[0]?.approxDurationMs).toBe(1650);
    expect(profile.byTool[0]?.sampleError).toContain("FAIL test/auth.test.ts");
    const readRow = profile.byTool.find((r) => r.toolName === "Read");
    expect(readRow?.calls).toBe(1);
    expect(readRow?.approxDurationMs).toBe(150);
  });

  it("B.2: extracts structured [ASK_HUMAN] clarification requests safely and rejects incomplete ones", () => {
    const direct = extractWorkerClarificationRequest([], {
      question: "Pick header style?",
      options: ["Authorization Bearer", "X-Api-Key"],
      recommendedOption: "Authorization Bearer",
      context: "Existing routes use Bearer",
    });
    expect(direct?.question).toBe("Pick header style?");
    expect(direct?.recommendedOption).toBe("Authorization Bearer");

    const fromFencedText = extractWorkerClarificationRequest([
      { type: "thought", text: "Need ambiguity choice", timestamp: "2026-01-01T00:00:00.000Z" },
      {
        type: "text",
        text: [
          "Found two valid JWT libraries.",
          "[ASK_HUMAN]",
          "```json",
          JSON.stringify({
            question: "Which JWT verification behavior?",
            options: ["Reject missing exp", "Allow optional exp", "Reject missing exp"],
            recommendedOption: "Nonexistent Option",
          }),
          "```",
        ].join("\n"),
        timestamp: "2026-01-01T00:00:01.000Z",
      },
    ]);
    expect(fromFencedText).not.toBeNull();
    expect(fromFencedText?.options).toEqual(["Reject missing exp", "Allow optional exp"]);
    // Invalid recommendedOption falls back safely to options[0]
    expect(fromFencedText?.recommendedOption).toBe("Reject missing exp");

    expect(
      extractWorkerClarificationRequest([
        {
          type: "text",
          text: '[ASK_HUMAN] {"question":"Only one","options":["Only one"]}',
          timestamp: "2026-01-01T00:00:02.000Z",
        },
      ]),
    ).toBeNull();
    expect(extractWorkerClarificationRequest("Normal text output without marker")).toBeNull();
  });

  it("A.2: Chief-of-Staff answers queries using state + probes and returns confirmation-gated actions", async () => {
    const repo = makeRepo();
    const runningTicket = makeTicket({ id: "tkt_run", title: "Fix rate limiter", status: "implementing" });
    const highRiskTicket = makeTicket({
      id: "tkt_high",
      title: "Edit secrets",
      status: "needs_human",
      riskAssessment: {
        score: 85,
        level: "high",
        requiresSignoff: true,
        threshold: 35,
        policy: "risk_gated",
        factors: [],
        evaluatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const inboxItems: InboxItem[] = [
      {
        id: "inb_low",
        repoId: repo.id,
        ticketId: runningTicket.id,
        kind: "observe_proposal",
        status: "pending",
        title: "Low-risk proposal",
        summary: "Add unit test",
        contextPayload: {},
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "inb_high",
        repoId: repo.id,
        ticketId: highRiskTicket.id,
        kind: "mandate_violation",
        status: "pending",
        title: "High-risk violation",
        summary: "Scope check",
        contextPayload: {},
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    const res = await runChiefOfStaffQuery({
      question: "目前哪些工单需要纠偏或批量审批，顺便检查系统健康和备份",
      repo,
      allRepos: [repo],
      tickets: [runningTicket, highRiskTicket],
      inboxItems,
      metrics: {
        repoId: repo.id,
        todayDate: "2026-01-01",
        todayCostUsd: 0.42,
        totalCostUsd: 1.5,
        budgetExceeded: false,
        ticketCounts: {
          total: 2,
          active: 2,
          delivered: 0,
          failed: 0,
          cancelled: 0,
          needsHuman: 1,
        },
        deliveryRate: 1,
        byEngine: [],
      },
      memoryHits: [
        {
          entityType: "ticket",
          entityId: "tkt_old",
          repoId: repo.id,
          ticketId: "tkt_old",
          title: "Previous limiter work",
          snippet: "Token bucket implemented",
        },
      ],
      probeContext: {
        deterministicSummary: "- src/auth/jwt.ts [exports: verifyJwt]",
        matchedFiles: ["src/auth/jwt.ts"],
        recentCommits: ["abc123 init"],
        probeSteps: [
          {
            step: 1,
            tool: "search_symbols",
            inputSummary: "jwt",
            outputSummary: "src/auth/jwt.ts",
            matchedPaths: ["src/auth/jwt.ts"],
            durationMs: 4,
          },
        ],
      },
      llm: new HeuristicControlLLM(),
    });

    expect(res.answer).toContain("v110-app");
    expect(res.answer).toContain("src/auth/jwt.ts");
    expect(res.probeSteps).toHaveLength(1);
    const batchAct = res.suggestedActions.find((a) => a.kind === "batch_resolve_inbox");
    expect(batchAct).toBeDefined();
    expect(batchAct?.payload.inboxIds).toEqual(["inb_low"]);
    expect(res.suggestedActions.some((a) => a.kind === "steer_ticket")).toBe(true);
    expect(res.suggestedActions.some((a) => a.kind === "run_doctor")).toBe(true);
  });

  it("MCP: negotiates 1.3.0, exposes 23 tools, and dispatches steer/batch/ask_chief/manage_evals", async () => {
    expect(MCP_TOOL_DEFINITIONS).toHaveLength(27);
    const calls: string[] = [];
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
      submitReviewComments: async () => ({}),
      systemDoctor: async () => ({}),
      steerTicket: async (args) => {
        calls.push(`steer:${String(args.ticketId)}`);
        return { ticket: { id: args.ticketId, status: "queued" } };
      },
      batchResolveInbox: async (args) => {
        calls.push(`batch:${String(args.decision)}`);
        return { resolvedCount: 2, skippedCount: 0, results: [] };
      },
      askChief: async (args) => {
        calls.push(`ask:${String(args.question)}`);
        return { answer: "All healthy", highlights: [], suggestedActions: [], generatedAt: "now" };
      },
      manageEvals: async (args) => {
        calls.push(`eval:${String(args.action)}`);
        return { cases: [] };
      },
    };

    const initRes = (await handleMcpJsonRpcMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
      stubHost,
    )) as McpJsonRpcResponse;
    expect((initRes.result as { serverInfo: { version: string } }).serverInfo.version).toBe("1.8.2");

    for (const [idx, call] of [
      { name: "steer_ticket", arguments: { ticketId: "t1", instruction: "focus src/a.ts" } },
      { name: "batch_resolve_inbox", arguments: { decision: "approved", onlyLowRisk: true } },
      { name: "ask_chief", arguments: { question: "status?" } },
      { name: "manage_evals", arguments: { action: "list_cases" } },
    ].entries()) {
      const res = (await handleMcpJsonRpcMessage(
        { jsonrpc: "2.0", id: idx + 2, method: "tools/call", params: call },
        stubHost,
      )) as McpJsonRpcResponse;
      expect(res.error).toBeUndefined();
    }

    expect(calls).toEqual(["steer:t1", "batch:approved", "ask:status?", "eval:list_cases"]);
  });
});
