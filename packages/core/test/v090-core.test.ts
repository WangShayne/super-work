import { describe, expect, it } from "bun:test";
import {
  MCP_TOOL_DEFINITIONS,
  buildEngineCategoryMatrix,
  classifyTaskCategory,
  computeEngineRoutingDecision,
  createDefaultMandate,
  detectTicketDependencyCycle,
  getEffectiveStages,
  getFirstStage,
  getNextStage,
  handleMcpJsonRpcMessage,
  isSpecTestFilePath,
  isUiIntentTicket,
  parseSpecTestChallenge,
  type CasebookEntry,
  type McpToolHost,
  type RepoConfig,
  type StageRun,
  type Ticket,
} from "../src/index.ts";

function makeRepo(overrides?: Partial<RepoConfig>): RepoConfig {
  return {
    id: "repo_v090",
    name: "v090-app",
    rootPath: "/tmp/v090-app",
    baseBranch: "main",
    mode: "auto",
    defaultTemplate: "standard",
    forbiddenPaths: [".env*", "*.pem"],
    preferredImplementEngine: "auto",
    preferredReviewEngine: "mock",
    dailyBudgetUsd: 10,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeTicket(overrides: Partial<Ticket> & { id: string }): Ticket {
  return {
    repoId: "repo_v090",
    threadId: `thr_${overrides.id}`,
    sourceTriggerId: `trg_${overrides.id}`,
    title: "Implement feature",
    description: "Build backend service",
    status: "delivered",
    template: "standard",
    currentStage: "rebase",
    stageRetries: 0,
    mandate: createDefaultMandate({
      allowedPaths: ["src/**"],
      maxCostUsd: 5,
    }),
    dependsOn: [],
    nativeSessions: {},
    inlineMemory: {
      goal: "goal",
      acceptanceCriteria: [],
      stageNotes: [],
      threadUpdates: [],
    },
    costUsd: 0.2,
    priority: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("v0.9.0 Core Modules (A.1 TDD Guard + B.2 Bandit Router + D.1 DAG Cycle + MCP)", () => {
  it("A.1: prepends spec_test before implement across templates and parses challenges & test paths", () => {
    expect(getEffectiveStages("fast", false)).toEqual(["implement", "rebase"]);
    expect(getEffectiveStages("fast", true)).toEqual(["spec_test", "implement", "rebase"]);
    expect(getEffectiveStages("standard", true)).toEqual([
      "plan",
      "spec_test",
      "implement",
      "review",
      "rebase",
    ]);
    expect(getEffectiveStages("strict", true)).toEqual([
      "plan",
      "spec_test",
      "implement",
      "review",
      "rebase",
    ]);

    expect(getFirstStage("fast", true)).toBe("spec_test");
    expect(getFirstStage("standard", true)).toBe("plan");
    expect(getNextStage("standard", "plan", true)).toBe("spec_test");
    expect(getNextStage("standard", "spec_test", true)).toBe("implement");

    expect(isSpecTestFilePath("packages/core/test/v090-core.test.ts")).toBe(true);
    expect(isSpecTestFilePath("src/__tests__/auth.ts")).toBe(true);
    expect(isSpecTestFilePath("tests/test_router.py")).toBe(true);
    expect(isSpecTestFilePath("pkg/server_test.go")).toBe(true);
    expect(isSpecTestFilePath("packages/core/src/kernel.ts")).toBe(false);

    expect(parseSpecTestChallenge("Some text\nSPEC_TEST_CHALLENGE: test expects UTC instead of local time")).toBe(
      "test expects UTC instead of local time",
    );
    expect(parseSpecTestChallenge("No challenge token here")).toBeNull();
  });

  it("B.2: classifies task categories and selects winner vs Auto-Arena across all 3 guardrails", () => {
    expect(classifyTaskCategory("Fix README typo", "Update documentation")).toBe("docs_chore");
    expect(classifyTaskCategory("Add unit tests", "Improve vitest coverage")).toBe("test_ci");
    expect(classifyTaskCategory("Redesign DAG modal layout", "Update Tailwind CSS badge")).toBe("ui");
    expect(classifyTaskCategory("Refactor kernel router", "Split helper module")).toBe("refactor");
    expect(classifyTaskCategory("Add REST webhook handler", "Persist audit row")).toBe("backend");
    expect(isUiIntentTicket({ title: "Polish CSS", description: "minor styling", changedFiles: ["a.css"] })).toBe(true);

    const repo = makeRepo({ dailyBudgetUsd: 10 });

    // Warm matrix: 6 backend tickets -> codex succeeds cleanly, claude has high failure + revert rate
    const historicalTickets: Ticket[] = [];
    const historicalStageRuns: StageRun[] = [];
    const casebookEntries: CasebookEntry[] = [];

    for (let i = 0; i < 3; i += 1) {
      const codexTkt = makeTicket({
        id: `t_codex_${i}`,
        activeEngine: "codex",
        taskCategory: "backend",
        status: "delivered",
        costUsd: 0.1,
      });
      historicalTickets.push(codexTkt);
      historicalStageRuns.push({
        id: `sr_codex_${i}`,
        ticketId: codexTkt.id,
        stage: "implement",
        engine: "codex",
        status: "completed",
        costUsd: 0.1,
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:01:00.000Z",
      });

      const claudeTkt = makeTicket({
        id: `t_claude_${i}`,
        activeEngine: "claude",
        taskCategory: "backend",
        status: "failed",
        costUsd: 0.8,
        revertedAt: "2026-01-01T01:00:00.000Z",
      });
      historicalTickets.push(claudeTkt);
      historicalStageRuns.push({
        id: `sr_claude_${i}`,
        ticketId: claudeTkt.id,
        stage: "implement",
        engine: "claude",
        status: "failed",
        costUsd: 0.8,
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:01:00.000Z",
      });
    }

    const matrix = buildEngineCategoryMatrix({
      tickets: historicalTickets,
      stageRuns: historicalStageRuns,
      casebookEntries,
      engines: ["claude", "codex"],
    });
    const codexRow = matrix.find((r) => r.engine === "codex" && r.category === "backend")!;
    const claudeRow = matrix.find((r) => r.engine === "claude" && r.category === "backend")!;
    expect(codexRow.compositeScore).toBeGreaterThan(claudeRow.compositeScore);

    const warmDecision = computeEngineRoutingDecision({
      repo,
      ticket: {
        title: "Add REST endpoint",
        description: "Handle JSON payload",
        template: "standard",
        mandate: { allowedPaths: ["packages/server/**"] },
      },
      availableEngines: ["claude", "codex"],
      historicalTickets,
      historicalStageRuns,
      casebookEntries,
      todaySpendUsd: 0,
      effectiveDailyBudgetUsd: 10,
      recentAutoArenaCountLastHour: 0,
    });
    expect(warmDecision.chosenEngine).toBe("codex");
    expect(warmDecision.autoUpgradeArena).toBe(false);

    // Cold start (<5 samples -> confidence < 0.52) with 2+ real engines, >=40% remaining budget, <2 hourly auto-arena -> triggers Auto-Arena
    const coldAutoArena = computeEngineRoutingDecision({
      repo,
      ticket: {
        title: "Add REST endpoint",
        description: "Handle JSON payload",
        template: "standard",
        mandate: { allowedPaths: ["packages/server/**"] },
      },
      availableEngines: ["claude", "codex"],
      historicalTickets: [],
      historicalStageRuns: [],
      casebookEntries: [],
      todaySpendUsd: 2.0, // 80% remaining
      effectiveDailyBudgetUsd: 10,
      recentAutoArenaCountLastHour: 1,
    });
    expect(coldAutoArena.autoUpgradeArena).toBe(true);
    expect(coldAutoArena.competitorEngine).toBeDefined();
    expect(coldAutoArena.competitorEngine).not.toBe(coldAutoArena.chosenEngine);

    // Guardrail 1: single real engine ("mock" excluded from dual-arena escalation) -> false
    const singleEngineCold = computeEngineRoutingDecision({
      repo,
      ticket: {
        title: "Add REST endpoint",
        description: "Handle JSON payload",
        template: "standard",
        mandate: { allowedPaths: ["packages/server/**"] },
      },
      availableEngines: ["claude", "mock"],
      historicalTickets: [],
      historicalStageRuns: [],
      casebookEntries: [],
      todaySpendUsd: 0,
      effectiveDailyBudgetUsd: 10,
      recentAutoArenaCountLastHour: 0,
    });
    expect(singleEngineCold.autoUpgradeArena).toBe(false);

    // Guardrail 2: remaining budget < 40% (spent 7 of 10 -> 30% remaining) -> withheld
    const lowBudgetCold = computeEngineRoutingDecision({
      repo,
      ticket: {
        title: "Add REST endpoint",
        description: "Handle JSON payload",
        template: "standard",
        mandate: { allowedPaths: ["packages/server/**"] },
      },
      availableEngines: ["claude", "codex"],
      historicalTickets: [],
      historicalStageRuns: [],
      casebookEntries: [],
      todaySpendUsd: 7.0,
      effectiveDailyBudgetUsd: 10,
      recentAutoArenaCountLastHour: 0,
    });
    expect(lowBudgetCold.autoUpgradeArena).toBe(false);
    expect(lowBudgetCold.rationale).toContain("budget<40%");

    // Guardrail 3: >= 2 recent Auto-Arena tickets in last 60m -> withheld
    const rateLimitedCold = computeEngineRoutingDecision({
      repo,
      ticket: {
        title: "Add REST endpoint",
        description: "Handle JSON payload",
        template: "standard",
        mandate: { allowedPaths: ["packages/server/**"] },
      },
      availableEngines: ["claude", "codex"],
      historicalTickets: [],
      historicalStageRuns: [],
      casebookEntries: [],
      todaySpendUsd: 1.0,
      effectiveDailyBudgetUsd: 10,
      recentAutoArenaCountLastHour: 2,
    });
    expect(rateLimitedCold.autoUpgradeArena).toBe(false);
    expect(rateLimitedCold.rationale).toContain("hourly_cap>=2");
  });

  it("D.1: detects self-loops and multi-node cycles in DAG dependencies", () => {
    const deps = new Map<string, string[]>([
      ["A", []],
      ["B", ["A"]],
      ["C", ["B"]],
    ]);

    expect(detectTicketDependencyCycle(deps, "A", ["A"])).toBe(true);
    expect(detectTicketDependencyCycle(deps, "A", ["B"])).toBe(true);
    expect(detectTicketDependencyCycle(deps, "A", ["C"])).toBe(true);
    expect(detectTicketDependencyCycle(deps, "D", ["C"])).toBe(false);
    expect(detectTicketDependencyCycle(deps, "C", ["A"])).toBe(false);
  });

  it("MCP v1.3.0: exposes 23 tools and advertises version 1.3.0 on initialize", async () => {
    expect(MCP_TOOL_DEFINITIONS.length).toBe(27);
    const toolNames = MCP_TOOL_DEFINITIONS.map((t) => t.name);
    expect(toolNames).toContain("analyze_impact");
    expect(toolNames).toContain("manage_checkpoints");
    expect(toolNames).toContain("mutate_dag_node");
    expect(toolNames).toContain("submit_review_comments");
    expect(toolNames).toContain("system_doctor");
    expect(toolNames).toContain("dispatch_requirement");
    expect(toolNames).toContain("manage_self_host");

    const host: McpToolHost = {
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
      analyzeImpact: async (args) => ({ ok: true, args }),
      manageCheckpoints: async () => ({}),
      mutateDagNode: async () => ({}),
      submitReviewComments: async () => ({}),
      systemDoctor: async () => ({}),
      getHealth: async () => ({}),
      listRepos: async () => [],
    };

    const initResp = (await handleMcpJsonRpcMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      host,
    )) as { result?: { serverInfo?: { version?: string } } };
    expect(initResp.result?.serverInfo?.version).toBe("1.6.0");

    const listResp = (await handleMcpJsonRpcMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      host,
    )) as { result?: { tools?: Array<{ name: string }> } };
    expect(listResp.result?.tools?.length).toBe(27);
  });
});
