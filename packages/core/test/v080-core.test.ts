import { describe, expect, it } from "bun:test";
import {
  MCP_RESOURCES,
  MCP_TOOL_DEFINITIONS,
  applyClarificationAnswers,
  buildHeuristicSpecClarification,
  computeHmacSha256Hex,
  handleMcpJsonRpcMessage,
  parseGithubWebhookEvent,
  signActionToken,
  verifyActionToken,
  verifyWebhookHmacSha256,
  type CasebookEntry,
  type McpToolHost,
  type PlaybookEntry,
  type RepoConfig,
} from "../src/index.ts";

function makeRepo(overrides?: Partial<RepoConfig>): RepoConfig {
  return {
    id: "repo_1",
    name: "demo-app",
    rootPath: "/tmp/demo-app",
    baseBranch: "main",
    githubRepo: "acme/demo-app",
    mode: "auto",
    defaultTemplate: "standard",
    forbiddenPaths: [".env*", "*.pem"],
    sandboxMode: "balanced",
    maxConcurrentWorkers: 2,
    dailyBudgetUsd: 20,
    verificationCommands: ["bun test"],
    smokeCheck: {
      enabled: true,
      startCommand: "bun run start",
      browserCheck: { enabled: true, paths: ["/"] },
    },
    preferredImplementEngine: "mock",
    preferredReviewEngine: "mock",
    fallbackEngines: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("v0.8.0 Core Modules (D.1 Spec Studio + A.2 Webhooks + A.1 MCP Protocol)", () => {
  it("D.1: builds pre-flight spec clarification and applies clarification answers", () => {
    const repo = makeRepo();
    const cases: CasebookEntry[] = [
      {
        id: "case_1",
        repoId: repo.id,
        ticketId: "tkt_prev",
        title: "Harden auth token refresh",
        goalSummary: "Validate JWT expiry and auth middleware",
        solutionSummary: "Updated auth middleware and unit tests",
        scopePaths: ["packages/server/src/**"],
        changedFiles: ["packages/server/src/auth.ts"],
        exportedSymbols: ["verifyToken"],
        reverted: false,
        hitCount: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const playbook: PlaybookEntry[] = [
      {
        id: "pb_1",
        repoId: repo.id,
        rule: "Never bypass Bearer token middleware on admin APIs",
        scopePaths: ["packages/server/**"],
        source: "human",
        enabled: true,
        hitCount: 2,
        suspect: false,
        pinned: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    const singleSpec = buildHeuristicSpecClarification({
      repo,
      title: "Fix auth token verification",
      description: "Update auth middleware check and add unit tests.",
      repoStructure: [
        "- packages/server/src/auth.ts",
        "- packages/server/test/auth.test.ts",
        "- packages/web/src/App.tsx",
      ].join("\n"),
      casebookEntries: cases,
      playbookEntries: playbook,
    });

    expect(singleSpec.ready).toBe(true);
    expect(singleSpec.recommendedDispatchMode).toBe("single");
    expect(singleSpec.recommendedTemplate).toBe("strict");
    expect(singleSpec.matchedFiles).toContain("packages/server/src/auth.ts");
    expect(singleSpec.suggestedAllowedPaths).toContain("packages/server/src/**");
    expect(singleSpec.matchedCaseTitles).toContain("Harden auth token refresh");
    expect(singleSpec.acceptanceCriteria.some((c) => c.includes("Never bypass Bearer token"))).toBe(true);
    expect(singleSpec.questions.length).toBeGreaterThanOrEqual(1);
    expect(singleSpec.questions.length).toBeLessThanOrEqual(3);

    const applied = applyClarificationAnswers(singleSpec, {
      scope_boundary: "放宽至全仓库 (**)，允许跨模块顺带重构",
      verification_depth: "轻量快速交付：保持最小改动与快速验证通过即可",
    });
    expect(applied.suggestedAllowedPaths).toEqual(["**"]);
    expect(applied.recommendedTemplate).toBe("fast");
    expect(applied.refinedDescription).toContain("## Clarified Spec Decisions");

    const epicSpec = buildHeuristicSpecClarification({
      repo,
      title: "Full-stack multi-module refactor",
      description: [
        "1. Update core types",
        "2. Add server endpoints",
        "3. Update web dashboard UI",
        "4. Add E2E tests",
      ].join("\n"),
      repoStructure: "- packages/core/src/a.ts\n- packages/server/src/b.ts\n- packages/web/src/c.tsx",
    });
    expect(epicSpec.recommendedDispatchMode).toBe("epic");
  });

  it("A.2: signs and verifies action tokens with expiry & tampering guards", () => {
    const now = 1_700_000_000_000;
    const secret = "action-signing-secret";
    const token = signActionToken(
      {
        inboxId: "inb_1",
        ticketId: "tkt_1",
        repoId: "repo_1",
        kind: "outbox_signoff",
        exp: now + 60_000,
      },
      secret,
    );

    const ok = verifyActionToken(token, secret, now + 10_000);
    expect(ok.valid).toBe(true);
    if (ok.valid) {
      expect(ok.payload.inboxId).toBe("inb_1");
      expect(ok.payload.kind).toBe("outbox_signoff");
    }

    const expired = verifyActionToken(token, secret, now + 120_000);
    expect(expired.valid).toBe(false);

    const tamperedToken = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
    const tampered = verifyActionToken(tamperedToken, secret, now + 10_000);
    expect(tampered.valid).toBe(false);

    const wrongSecret = verifyActionToken(token, "wrong-secret", now + 10_000);
    expect(wrongSecret.valid).toBe(false);
  });

  it("A.2: verifies GitHub webhook HMAC SHA-256 signatures and normalizes inbound events", () => {
    const rawBody = JSON.stringify({ hello: "world" });
    const secret = "gh-sec-123";
    const sig = `sha256=${computeHmacSha256Hex(rawBody, secret)}`;
    expect(verifyWebhookHmacSha256(rawBody, sig, secret)).toBe(true);
    expect(verifyWebhookHmacSha256(rawBody, "sha256=deadbeef", secret)).toBe(false);
    expect(verifyWebhookHmacSha256(rawBody, sig, "")).toBe(false);

    const repos = [makeRepo({ githubRepo: "https://github.com/Acme/Demo-App.git" })];

    const issueRes = parseGithubWebhookEvent(
      "issues",
      {
        action: "opened",
        repository: { full_name: "acme/demo-app" },
        issue: { number: 42, title: "Bug in login", body: "Steps...", user: { login: "alice" } },
      },
      repos,
    );
    expect(issueRes.trigger?.source).toBe("github_issue");
    expect(issueRes.trigger?.title).toContain("#42 Bug in login");

    const ignoredIssue = parseGithubWebhookEvent(
      "issues",
      { action: "closed", repository: { full_name: "acme/demo-app" }, issue: { number: 42 } },
      repos,
    );
    expect(ignoredIssue.trigger).toBeUndefined();

    const selfComment = parseGithubWebhookEvent(
      "issue_comment",
      {
        action: "created",
        repository: { full_name: "acme/demo-app" },
        issue: { number: 7, title: "PR", pull_request: {} },
        comment: { id: 9, body: "[super-work] automated update", user: { login: "bot" } },
      },
      repos,
    );
    expect(selfComment.trigger).toBeUndefined();

    const prComment = parseGithubWebhookEvent(
      "issue_comment",
      {
        action: "created",
        repository: { full_name: "acme/demo-app" },
        issue: { number: 7, title: "Fix caching", pull_request: {} },
        comment: { id: 10, body: "Please add regression tests", user: { login: "bob" } },
      },
      repos,
    );
    expect(prComment.trigger?.source).toBe("github_pr");
    expect(prComment.trigger?.threadKey).toBe("github:pr:7");

    const prReview = parseGithubWebhookEvent(
      "pull_request_review",
      {
        action: "submitted",
        repository: { full_name: "acme/demo-app" },
        pull_request: { number: 8, title: "Add API" },
        review: { id: 11, state: "changes_requested", body: "Rename variable", user: { login: "carol" } },
      },
      repos,
    );
    expect(prReview.trigger?.source).toBe("github_pr");

    const checkFail = parseGithubWebhookEvent(
      "check_run",
      {
        action: "completed",
        repository: { full_name: "acme/demo-app" },
        check_run: {
          id: 99,
          name: "unit-tests",
          conclusion: "failure",
          head_branch: "feat/foo",
          pull_requests: [{ number: 12 }],
          output: { title: "1 test failed" },
        },
      },
      repos,
    );
    expect(checkFail.trigger?.source).toBe("github_ci");
    expect(checkFail.trigger?.threadKey).toBe("github:pr:12");

    const workflowPass = parseGithubWebhookEvent(
      "workflow_run",
      {
        action: "completed",
        repository: { full_name: "acme/demo-app" },
        workflow_run: { id: 100, name: "ci", conclusion: "success" },
      },
      repos,
    );
    expect(workflowPass.trigger).toBeUndefined();
  });

  it("A.1: handles MCP JSON-RPC initialize, notifications, tools, resources, and batch", async () => {
    expect(MCP_TOOL_DEFINITIONS.length).toBeGreaterThanOrEqual(10);
    expect(MCP_RESOURCES).toHaveLength(3);

    const host: McpToolHost = {
      getHealth: async () => ({ ok: true, version: "0.9.0" }),
      listRepos: async () => [makeRepo()],
      clarifySpec: async (args) => ({ ready: true, echoTitle: args.title }),
      dispatchTicket: async () => ({ ticket: { id: "tkt_1" } }),
      dispatchEpic: async () => ({ epic: { id: "tkt_epic" } }),
      listTickets: async () => ({ tickets: [] }),
      getTicketDetail: async () => ({ ticket: { id: "tkt_1" } }),
      listInbox: async () => ({ items: [{ id: "inb_1", status: "pending" }] }),
      resolveInbox: async () => ({ resolved: true }),
      searchMemoryAndCasebook: async () => ({ memoryHits: [], cases: [] }),
      triggerRoutine: async () => {
        throw new Error("Routine not found");
      },
      managePreview: async () => ({ previews: [] }),
      analyzeImpact: async () => ({ targetFiles: [], directDependents: [], transitiveDependents: [], neighborSignatures: [], contextPackMarkdown: "" }),
      manageCheckpoints: async () => ({ checkpoints: [] }),
      mutateDagNode: async () => ({ ticket: { id: "tkt_1" } }),
      submitReviewComments: async () => ({ comments: [] }),
      systemDoctor: async () => ({ healthy: true, checkedAt: "2026-01-01T00:00:00Z", fixesApplied: 0, items: [] }),
    };

    const initRes = (await handleMcpJsonRpcMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      },
      host,
    )) as { result: { protocolVersion: string; serverInfo: { name: string; version: string } } };
    expect(initRes.result.protocolVersion).toBe("2024-11-05");
    expect(initRes.result.serverInfo.version).toBe("1.2.0");

    const notifRes = await handleMcpJsonRpcMessage(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      host,
    );
    expect(notifRes).toBeNull();

    const listToolsRes = (await handleMcpJsonRpcMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      host,
    )) as { result: { tools: Array<{ name: string }> } };
    expect(listToolsRes.result.tools.map((t) => t.name)).toContain("manage_preview");

    const callOk = (await handleMcpJsonRpcMessage(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "clarify_spec", arguments: { repoId: "r1", title: "Hi", description: "Desc" } },
      },
      host,
    )) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(callOk.result.isError).toBeUndefined();
    expect(JSON.parse(callOk.result.content[0]!.text)).toEqual({ ready: true, echoTitle: "Hi" });

    const callErr = (await handleMcpJsonRpcMessage(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "trigger_routine", arguments: { routineId: "missing" } },
      },
      host,
    )) as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(callErr.result.isError).toBe(true);
    expect(callErr.result.content[0]!.text).toContain("Routine not found");

    const readRes = (await handleMcpJsonRpcMessage(
      { jsonrpc: "2.0", id: 5, method: "resources/read", params: { uri: "superwork://inbox/pending" } },
      host,
    )) as { result: { contents: Array<{ mimeType: string; text: string }> } };
    expect(readRes.result.contents[0]!.mimeType).toBe("application/json");
    expect(JSON.parse(readRes.result.contents[0]!.text)).toEqual({
      items: [{ id: "inb_1", status: "pending" }],
    });

    const batchRes = (await handleMcpJsonRpcMessage(
      [
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 6, method: "ping" },
      ],
      host,
    )) as Array<{ id: number; result: Record<string, unknown> }>;
    expect(batchRes).toHaveLength(1);
    expect(batchRes[0]!.id).toBe(6);
  });
});
