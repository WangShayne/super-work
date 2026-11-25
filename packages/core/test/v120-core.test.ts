import { describe, expect, it } from "bun:test";
import {
  IMMUTABLE_REPO_PATHS,
  MCP_TOOL_DEFINITIONS,
  buildCampaignWavePrompt,
  createDefaultMandate,
  evaluateBarrierGroupState,
  evaluateMetricDelta,
  evaluateSpeculativePrefix,
  handleMcpJsonRpcMessage,
  isCampaignTargetMet,
  parseMetricValueFromOutput,
  validateChangedFilesAgainstMandate,
  type GoalCampaign,
  type GoalCampaignWave,
  type McpJsonRpcResponse,
  type McpToolHost,
} from "../src/index.ts";

describe("v1.2.0 Core Logic (Campaigns, MergeTrain, Immutable super-work.json, MCP 1.2.0)", () => {
  it("Pillar A: parses numeric metrics accurately with regex, marker, and last-number fallbacks", () => {
    expect(
      parseMetricValueFromOutput(
        "warmup=12.0\nLatency: 84.5 ms\nLatency: 61.25 ms\n",
        "Latency:\\s*([0-9.]+)\\s*ms",
      ),
    ).toBe(61.25);

    expect(
      parseMetricValueFromOutput("noise 999\nSUPER_WORK_METRIC=42.75\ndone 100"),
    ).toBe(42.75);

    expect(parseMetricValueFromOutput("step 1 passed\nfinal score 93.4\n")).toBe(93.4);
    expect(parseMetricValueFromOutput("no digits here")).toBeNull();
    expect(parseMetricValueFromOutput("fallback 15.5 with bad regex", "[unclosed")).toBe(15.5);
  });

  it("Pillar A: evaluates metric deltas, target attainment, and wave prompt synthesis", () => {
    expect(evaluateMetricDelta(100, 82.5, "decrease")).toEqual({
      delta: -17.5,
      outcome: "improved",
    });
    expect(evaluateMetricDelta(100, 110, "decrease")).toEqual({
      delta: 10,
      outcome: "regressed",
    });
    expect(evaluateMetricDelta(50, 50, "increase")).toEqual({
      delta: 0,
      outcome: "unchanged",
    });
    expect(evaluateMetricDelta(50, 72, "increase")).toEqual({
      delta: 22,
      outcome: "improved",
    });

    expect(isCampaignTargetMet(45, 50, "decrease")).toBe(true);
    expect(isCampaignTargetMet(55, 50, "decrease")).toBe(false);
    expect(isCampaignTargetMet(90, 90, "increase")).toBe(true);
    expect(isCampaignTargetMet(89.9, 90, "increase")).toBe(false);

    const campaign: GoalCampaign = {
      id: "cmp_1",
      repoId: "repo_1",
      name: "Optimize query latency",
      goalPrompt: "Reduce p95 SQLite query latency under 25ms",
      metricCommand: "bun run bench",
      metricUnit: "ms",
      direction: "decrease",
      baselineValue: 80,
      currentValue: 55,
      targetValue: 25,
      deliveryMode: "staging_branch",
      stagingBranch: "super-work/campaign/cmp_1",
      allowedPaths: ["src/**"],
      template: "fast",
      maxIterations: 5,
      completedWaves: 2,
      maxTotalBudgetUsd: 5,
      totalCostUsd: 0.4,
      consecutiveNoImproveCount: 1,
      status: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
    };
    const waves: GoalCampaignWave[] = [
      {
        id: "w1",
        campaignId: "cmp_1",
        repoId: "repo_1",
        waveNumber: 1,
        status: "improved",
        beforeValue: 80,
        measuredValue: 55,
        delta: -25,
        costUsd: 0.2,
        summary: "Added composite index",
        startedAt: "2026-01-01T00:00:10.000Z",
      },
      {
        id: "w2",
        campaignId: "cmp_1",
        repoId: "repo_1",
        waveNumber: 2,
        status: "regressed",
        beforeValue: 55,
        measuredValue: 70,
        delta: 15,
        rolledBack: true,
        costUsd: 0.2,
        summary: "Caching mutex contention",
        startedAt: "2026-01-01T00:00:30.000Z",
      },
    ];

    const prompt = buildCampaignWavePrompt({
      campaign,
      waveNumber: 3,
      waves,
      preProbeSummary: "src/db.ts exports runQuery",
    });
    expect(prompt).toContain("Wave #3/5");
    expect(prompt).toContain("55 ms");
    expect(prompt).toContain("Target Metric: 25 ms");
    expect(prompt).toContain("Added composite index");
    expect(prompt).toContain("Caching mutex contention");
    expect(prompt).toContain("src/db.ts exports runQuery");
  });

  it("Pillar B: computes speculative prefix fast-forwards, culprit index, and release barrier readiness", () => {
    expect(
      evaluateSpeculativePrefix([{ passed: true }, { passed: true }, { passed: true }]),
    ).toEqual({
      passingPrefixCount: 3,
      culpritIndex: null,
      requeueIndices: [],
    });

    expect(
      evaluateSpeculativePrefix([
        { passed: true },
        { passed: false, errorSummary: "test failed" },
        { passed: true },
      ]),
    ).toEqual({
      passingPrefixCount: 1,
      culpritIndex: 1,
      requeueIndices: [2],
    });

    expect(
      evaluateSpeculativePrefix([{ passed: false }, { passed: true }]),
    ).toEqual({
      passingPrefixCount: 0,
      culpritIndex: 0,
      requeueIndices: [1],
    });

    expect(
      evaluateBarrierGroupState([
        { ticketId: "t1", ticketStatus: "outbox_pending", trainStatus: "barrier_waiting" },
        { ticketId: "t2", ticketStatus: "implementing" },
      ]),
    ).toBe("waiting");

    expect(
      evaluateBarrierGroupState([
        { ticketId: "t1", ticketStatus: "outbox_pending", trainStatus: "barrier_waiting" },
        { ticketId: "t2", ticketStatus: "outbox_pending", trainStatus: "barrier_waiting" },
      ]),
    ).toBe("all_ready");

    expect(
      evaluateBarrierGroupState([
        { ticketId: "t1", ticketStatus: "outbox_pending", trainStatus: "barrier_waiting" },
        { ticketId: "t2", ticketStatus: "failed" },
      ]),
    ).toBe("blocked");
  });

  it("Pillar D: classifies super-work.json modifications as non-expandable forbiddenViolations", () => {
    expect(IMMUTABLE_REPO_PATHS).toContain("super-work.json");
    expect(IMMUTABLE_REPO_PATHS).toContain("**/super-work.json");

    const mandate = createDefaultMandate({ allowedPaths: ["**"] });
    const check = validateChangedFilesAgainstMandate(
      ["src/app.ts", "super-work.json", "packages/api/super-work.json"],
      mandate,
    );
    expect(check.ok).toBe(false);
    expect(check.forbiddenViolations).toEqual([
      "super-work.json",
      "packages/api/super-work.json",
    ]);
    expect(check.scopeViolations).toEqual([]);
  });

  it("MCP: exposes 23 tools including manage_campaigns & manage_merge_train and advertises 1.3.0", async () => {
    expect(MCP_TOOL_DEFINITIONS).toHaveLength(27);
    const names = MCP_TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toContain("manage_campaigns");
    expect(names).toContain("manage_merge_train");

    const dispatched: string[] = [];
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
      manageCampaigns: async (args) => {
        dispatched.push(`campaign:${String(args.action)}`);
        return { campaigns: [] };
      },
      manageMergeTrain: async (args) => {
        dispatched.push(`train:${String(args.action)}`);
        return { entries: [] };
      },
    };

    const initRes = (await handleMcpJsonRpcMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      stubHost,
    )) as McpJsonRpcResponse;
    expect((initRes.result as { serverInfo: { version: string } }).serverInfo.version).toBe("1.6.0");

    const cRes = (await handleMcpJsonRpcMessage(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "manage_campaigns", arguments: { action: "list" } },
      },
      stubHost,
    )) as McpJsonRpcResponse;
    expect(cRes.error).toBeUndefined();

    const tRes = (await handleMcpJsonRpcMessage(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "manage_merge_train", arguments: { action: "flush" } },
      },
      stubHost,
    )) as McpJsonRpcResponse;
    expect(tRes.error).toBeUndefined();
    expect(dispatched).toEqual(["campaign:list", "train:flush"]);
  });
});
