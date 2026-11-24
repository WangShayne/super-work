import { describe, expect, it } from "bun:test";
import {
  MCP_TOOL_DEFINITIONS,
  OutboxProcessor,
  computeEngineRoutingDecision,
  createDefaultMandate,
  getAlternateEngine,
  handleMcpJsonRpcMessage,
  heuristicPlanRequirementIntake,
  normalizeRequirementIntakePlan,
  nowIso,
  synthesizeRequirementTitle,
  type McpJsonRpcResponse,
  type McpToolHost,
  type OutboxAction,
  type OutboxEntry,
  type RepoConfig,
  type StateStore,
  type Ticket,
} from "../src/index.ts";

function makeRepo(overrides?: Partial<RepoConfig>): RepoConfig {
  const ts = nowIso();
  return {
    id: "repo_v130",
    name: "super-work",
    rootPath: "/tmp/super-work",
    baseBranch: "main",
    mode: "auto",
    defaultTemplate: "standard",
    defaultTddMode: false,
    defaultDeliveryChannel: "local_merge",
    preferredImplementEngine: "claude",
    preferredReviewEngine: "codex",
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

describe("v1.3.0 Core Modules (Smart Intake, Non-Starving Outbox, Gemini Routing, MCP 1.3.0)", () => {
  it("Requirement Intake: synthesizes titles, narrows single-ticket scope, decomposes multi-package epics, and validates campaigns", () => {
    expect(
      synthesizeRequirementTitle("### 1. Add `--wait` option for intake\nMore details on line 2."),
    ).toBe("Add `--wait` option for intake");

    const repo = makeRepo();
    const singlePlan = heuristicPlanRequirementIntake({
      repo,
      requirement: "Add a wait flag and help usage in packages/cli/src/index.ts",
      defaultTemplate: "standard",
    });
    expect(singlePlan.route).toBe("single_ticket");
    expect(singlePlan.singleSpec?.allowedPaths).toContain("packages/cli/src/index.ts");

    const epicPlan = heuristicPlanRequirementIntake({
      repo,
      requirement: [
        "1. Add new event types in packages/core/src/types.ts",
        "2. Add SSE endpoint in packages/server/src/routes/setup-system-routes.ts",
        "3. Render live banner in packages/web/src/components/HeaderBar.tsx",
      ].join("\n"),
      defaultTemplate: "standard",
    });
    expect(epicPlan.route).toBe("epic_dag");
    expect(epicPlan.epicPlan?.subtasks.length).toBeGreaterThanOrEqual(2);

    const campaignPlan = heuristicPlanRequirementIntake({
      repo,
      requirement: "Reduce cold startup time in packages/server/src/index.ts",
      defaultTemplate: "fast",
      metricHint: {
        metricCommand: "bun run bench:startup",
        targetValue: 120,
        direction: "decrease",
      },
    });
    expect(campaignPlan.route).toBe("goal_campaign");
    expect(campaignPlan.campaignSpec?.metricCommand).toBe("bun run bench:startup");
    expect(campaignPlan.campaignSpec?.direction).toBe("decrease");
    expect(campaignPlan.campaignSpec?.targetValue).toBe(120);

    // Prevent invalid goal_campaign route without metricCommand/targetValue
    const downgraded = normalizeRequirementIntakePlan(
      {
        route: "goal_campaign",
        confidence: 0.9,
        title: "No metric command provided",
        rationale: "Trying campaign without metric",
      },
      {
        repo,
        requirement: "Improve logging output in packages/server/src/app.ts",
        preferredRoute: "goal_campaign",
        defaultTemplate: "standard",
      },
    );
    expect(downgraded.route).toBe("single_ticket");
    expect(downgraded.singleSpec?.allowedPaths).toContain("packages/server/src/app.ts");
  });

  it("OutboxProcessor: passes excludeActions so held-back local_merge barriers never starve PR deliveries", async () => {
    const repo = makeRepo({ id: "repo_obx" });
    const ts = nowIso();
    const makeEntry = (idx: number, action: OutboxAction): OutboxEntry => ({
      id: `obx_${idx}`,
      repoId: repo.id,
      ticketId: `tkt_${idx}`,
      action,
      idempotencyKey: `idem_${idx}`,
      payload: {},
      status: "pending",
      attempts: 0,
      nextAttemptAt: ts,
      createdAt: `2026-01-01T00:00:0${idx}.000Z`,
      updatedAt: ts,
    });

    const entries: OutboxEntry[] = [
      makeEntry(1, "local_merge"),
      makeEntry(2, "local_merge"),
      makeEntry(3, "local_merge"),
      makeEntry(4, "local_merge"),
      makeEntry(5, "local_merge"),
      makeEntry(6, "local_merge"),
      makeEntry(7, "push_and_create_pr"),
    ];
    const recordedExcludes: Array<OutboxAction[] | undefined> = [];
    const executedIds: string[] = [];

    const stubStore = {
      async claimNextOutboxEntries(
        limit: number,
        _now: string,
        excludeActions?: OutboxAction[],
      ): Promise<OutboxEntry[]> {
        recordedExcludes.push(excludeActions);
        const excludes = new Set(excludeActions ?? []);
        const eligible = entries
          .filter((e) => e.status === "pending" && !excludes.has(e.action))
          .slice(0, limit);
        for (const item of eligible) {
          item.status = "processing";
        }
        return eligible.map((e) => ({ ...e }));
      },
      async updateOutboxEntry(updated: OutboxEntry): Promise<void> {
        const idx = entries.findIndex((e) => e.id === updated.id);
        if (idx >= 0) entries[idx] = { ...updated };
      },
      async getRepo(id: string): Promise<RepoConfig | null> {
        return id === repo.id ? repo : null;
      },
      async getTicket(id: string): Promise<Ticket | null> {
        return {
          id,
          repoId: repo.id,
          threadId: `thr_${id}`,
          sourceTriggerId: `trg_${id}`,
          title: `Ticket ${id}`,
          description: "desc",
          status: "outbox_pending",
          template: "fast",
          currentStage: "rebase",
          stageRetries: 0,
          mandate: createDefaultMandate({ allowedPaths: ["src/**"], maxCostUsd: 2 }),
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
          createdAt: ts,
          updatedAt: ts,
        };
      },
      async saveTicket(): Promise<void> {},
    } as unknown as StateStore;

    const processor = new OutboxProcessor(
      stubStore,
      {
        async execute(entry) {
          executedIds.push(entry.id);
          return { mode: "pr", prUrl: "https://example.com/pr/7" };
        },
      },
      () => {},
      5,
      undefined,
      { skipActions: new Set<OutboxAction>(["local_merge"]) },
    );

    const count = await processor.processDueEntries(5);
    expect(count).toBe(1);
    expect(recordedExcludes[0]).toEqual(["local_merge"]);
    expect(executedIds).toEqual(["obx_7"]);
    expect(entries.filter((e) => e.action === "local_merge").every((e) => e.status === "pending")).toBe(
      true,
    );
    expect(entries.find((e) => e.id === "obx_7")?.status).toBe("sent");
  });

  it("Gemini Engine Routing: supports gemini in alternate fallback and Bandit category routing", () => {
    expect(getAlternateEngine("claude", ["claude", "codex", "gemini"])).toBe("codex");
    expect(getAlternateEngine("claude", ["claude", "gemini"])).toBe("gemini");
    expect(getAlternateEngine("gemini", ["claude", "codex", "gemini"])).toBe("codex");

    const decision = computeEngineRoutingDecision({
      repo: makeRepo({ preferredImplementEngine: "gemini", preferredReviewEngine: "claude" }),
      ticket: {
        title: "Refactor server route handler",
        description: "Update REST endpoint validation",
        template: "standard",
        mandate: { allowedPaths: ["packages/server/src/**"] },
      },
      availableEngines: ["gemini"],
      historicalTickets: [],
      historicalStageRuns: [],
      casebookEntries: [],
      todaySpendUsd: 0,
      recentAutoArenaCountLastHour: 0,
    });
    expect(decision.chosenEngine).toBe("gemini");
    expect(decision.confidence).toBeGreaterThan(0);
  });

  it("MCP 1.3.0: exposes 23 tools including dispatch_requirement & manage_self_host and negotiates 1.3.0", async () => {
    expect(MCP_TOOL_DEFINITIONS).toHaveLength(23);
    const dispatchTool = MCP_TOOL_DEFINITIONS.find((t) => t.name === "dispatch_requirement");
    const selfHostTool = MCP_TOOL_DEFINITIONS.find((t) => t.name === "manage_self_host");
    expect(dispatchTool).toBeDefined();
    expect(selfHostTool).toBeDefined();

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
      dispatchRequirement: async (args) => {
        calls.push(`intake:${String(args.repoId)}:${Boolean(args.previewOnly)}`);
        return { route: "single_ticket" };
      },
      manageSelfHost: async (args) => {
        calls.push(`self:${String(args.action)}`);
        return { phase: "idle" };
      },
    };

    const initRes = (await handleMcpJsonRpcMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      stubHost,
    )) as McpJsonRpcResponse;
    expect((initRes.result as { serverInfo: { version: string } }).serverInfo.version).toBe("1.3.0");

    const r1 = (await handleMcpJsonRpcMessage(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "dispatch_requirement",
          arguments: { repoId: "repo_v130", requirement: "Add status badge", previewOnly: true },
        },
      },
      stubHost,
    )) as McpJsonRpcResponse;
    expect((r1.result as { isError?: boolean }).isError).toBeUndefined();

    const r2 = (await handleMcpJsonRpcMessage(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "manage_self_host", arguments: { action: "status" } },
      },
      stubHost,
    )) as McpJsonRpcResponse;
    expect((r2.result as { isError?: boolean }).isError).toBeUndefined();
    expect(calls).toEqual(["intake:repo_v130:true", "self:status"]);
  });
});
