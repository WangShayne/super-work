import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  SuperWorkKernel,
  newId,
  nowIso,
  type OutboxExecutor,
  type WorkerDriver,
  type WorkerEngineId,
  type WorkerStreamEvent,
  type WorkerTurnInput,
} from "@super-work/core";
import {
  FsArtifactStore,
  GitWorktreeProvider,
  HeuristicControlLLM,
  SqliteStateStore,
  runGit,
} from "@super-work/drivers";
import { runCli } from "../../cli/src/index.ts";
import { createServerApp } from "../src/app.ts";

async function createGitRepo(baseDir: string, name: string): Promise<string> {
  const repoDir = join(baseDir, name);
  await runGit(["init", "-b", "main", repoDir], baseDir);
  await runGit(["config", "user.name", "Test User"], repoDir);
  await runGit(["config", "user.email", "test@example.com"], repoDir);
  await mkdir(join(repoDir, "src/auth"), { recursive: true });
  await mkdir(join(repoDir, "test"), { recursive: true });
  await writeFile(join(repoDir, "README.md"), `# ${name}\n`, "utf8");
  await writeFile(
    join(repoDir, "src/auth/token.ts"),
    [
      "export function verifyToken(tok: string): boolean {",
      "  return tok.length > 0;",
      "}",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(repoDir, "test/token.test.ts"),
    [
      'import { expect, test } from "bun:test";',
      'import { verifyToken } from "../src/auth/token.ts";',
      'test("accepts valid prefix", () => {',
      '  expect(verifyToken("tok_valid")).toBe(true);',
      '  expect(verifyToken("bad")).toBe(false);',
      "});",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(repoDir, ".env"), "API_SECRET=do_not_expose_me\n", "utf8");
  await runGit(["add", "README.md", "src/auth/token.ts", "test/token.test.ts"], repoDir);
  await runGit(["commit", "-m", "initial commit"], repoDir);
  return repoDir;
}

class FlexibleScriptedWorkerDriver implements WorkerDriver {
  constructor(
    readonly engine: WorkerEngineId,
    private readonly handler: (
      input: WorkerTurnInput,
      signal: AbortSignal,
    ) => AsyncGenerator<WorkerStreamEvent>,
  ) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  runTurn(input: WorkerTurnInput, signal: AbortSignal): AsyncGenerator<WorkerStreamEvent> {
    return this.handler(input, signal);
  }
}

describe("v1.1.0 End-to-End Capabilities (A.1 Probes + A.2 Chief & Batch Inbox + B.2 Live Steer/Clarify/Profiler + D.1 Eval/Restore/Bundle)", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const d of tempDirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("A.1 + A.2 + MCP 1.1.0: runs read-only Spec Studio probes, Chief-of-Staff ask, low-risk Batch Inbox resolve, CLI, and 19 MCP tools", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v110-e2e-a-"));
    tempDirs.push(dir);
    const repoPath = await createGitRepo(dir, "v110-app");

    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));

    const noopDriver = new FlexibleScriptedWorkerDriver("claude", async function* () {
      yield { type: "session_started", nativeSessionId: newId("sess"), timestamp: nowIso() };
      yield { type: "completed", summary: "ok", costUsd: 0.01, timestamp: nowIso() };
    });

    const outboxExec: OutboxExecutor = {
      async execute(_entry, _repo, ticket) {
        return { prUrl: `local://delivered/${ticket.id}` };
      },
    };

    const kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm: new HeuristicControlLLM(),
      drivers: [noopDriver],
      outboxExecutor: outboxExec,
      dataDir: dir,
    });

    await store.upsertRepo({
      id: "repo_main",
      name: "v110-app",
      rootPath: repoPath,
      baseBranch: "main",
      mode: "observe",
      defaultTemplate: "fast",
      preferredImplementEngine: "claude",
      preferredReviewEngine: "claude",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });

    const app = createServerApp({ kernel, stateStore: store, artifactStore: artifacts });
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      // 1. A.1 Read-Only Spec Studio Probes
      const clarifyRes = await fetch(`${baseUrl}/api/specs/clarify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: "repo_main",
          title: "Fix verifyToken edge case",
          description: "Check src/auth/token.ts prefix check",
        }),
      });
      expect(clarifyRes.status).toBe(200);
      const clarifyJson = (await clarifyRes.json()) as {
        clarification: { matchedFiles: string[]; probeSteps?: Array<{ tool: string }> };
      };
      expect(clarifyJson.clarification.matchedFiles).toContain("src/auth/token.ts");
      expect(clarifyJson.clarification.probeSteps?.length).toBeGreaterThanOrEqual(2);

      // 2. Create 2 low-risk observe_proposal items + 1 non-low-risk mandate_violation item
      for (const idx of [1, 2]) {
        const trgRes = await fetch(`${baseUrl}/api/triggers`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repoId: "repo_main",
            source: "cli",
            threadKey: `thr_low_${idx}`,
            title: `Update token doc ${idx}`,
            rawText: "Improve README.md docs",
          }),
        });
        expect(trgRes.status).toBe(201);
      }

      const violationTicket = await kernel.createDirectTicket({
        repoId: "repo_main",
        title: "Violating task",
        description: "Should not batch approve",
        allowedPaths: ["src/**"],
        preferredEngine: "claude",
      });
      await store.saveTicket({ ...violationTicket, status: "needs_human", updatedAt: nowIso() });
      await store.saveInboxItem({
        id: "inb_mandate_high",
        repoId: "repo_main",
        ticketId: violationTicket.id,
        kind: "mandate_violation",
        status: "pending",
        title: "Mandate violation outside src/**",
        summary: "Edited .env",
        contextPayload: { canExpandMandate: false },
        createdAt: nowIso(),
      });

      // 3. A.2 Chief-of-Staff Ask via REST + CLI
      const chiefRes = await fetch(`${baseUrl}/api/chief/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: "repo_main",
          question: "总结当前待批项和低风险任务，涉及 verifyToken",
        }),
      });
      expect(chiefRes.status).toBe(200);
      const chiefJson = (await chiefRes.json()) as {
        answer: string;
        probeSteps?: unknown[];
        suggestedActions: Array<{ kind: string; payload: Record<string, unknown> }>;
      };
      expect(chiefJson.answer).toContain("v110-app");
      expect(chiefJson.probeSteps?.length).toBeGreaterThanOrEqual(1);
      expect(chiefJson.suggestedActions.some((a) => a.kind === "batch_resolve_inbox")).toBe(true);

      const cliAskOut: string[] = [];
      expect(
        await runCli(["ask", "总结待批项", "--repo", "repo_main", "--json"], {
          baseUrl,
          stdout: (l) => cliAskOut.push(l),
          stderr: () => {},
        }),
      ).toBe(0);
      expect(JSON.parse(cliAskOut.join("\n")).answer).toContain("v110-app");

      // 4. A.2 Batch Inbox Triage via CLI (--low-risk) approves only the 2 observe_proposals
      const cliBatchOut: string[] = [];
      expect(
        await runCli(
          [
            "inbox",
            "batch",
            "--repo",
            "repo_main",
            "--decision",
            "approved",
            "--low-risk",
            "--json",
          ],
          {
            baseUrl,
            stdout: (l) => cliBatchOut.push(l),
            stderr: () => {},
          },
        ),
      ).toBe(0);
      const batchResult = JSON.parse(cliBatchOut.join("\n")) as {
        resolvedCount: number;
        skippedCount: number;
      };
      expect(batchResult.resolvedCount).toBe(2);
      expect(batchResult.skippedCount).toBe(1);

      const remainingPending = await store.listInboxItems({ repoId: "repo_main", status: "pending" });
      expect(remainingPending).toHaveLength(1);
      expect(remainingPending[0]?.kind).toBe("mandate_violation");
      await kernel.runUntilIdle(30);

      // 5. MCP (GET /api/mcp + 23 tools + tools/call ask_chief)
      const mcpInfoRes = await fetch(`${baseUrl}/api/mcp`);
      expect(mcpInfoRes.status).toBe(200);
      expect(((await mcpInfoRes.json()) as { version: string }).version).toBe("1.8.3");

      const toolsListRes = await fetch(`${baseUrl}/api/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      const toolsListJson = (await toolsListRes.json()) as {
        result: { tools: Array<{ name: string }> };
      };
      expect(toolsListJson.result.tools).toHaveLength(27);
      expect(toolsListJson.result.tools.some((t) => t.name === "steer_ticket")).toBe(true);
      expect(toolsListJson.result.tools.some((t) => t.name === "manage_evals")).toBe(true);

      const askMcpRes = await fetch(`${baseUrl}/api/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "ask_chief", arguments: { repoId: "repo_main", question: "status" } },
        }),
      });
      expect(askMcpRes.status).toBe(200);
      const askMcpJson = (await askMcpRes.json()) as {
        result: { isError?: boolean; content: Array<{ text: string }> };
      };
      expect(askMcpJson.result.isError).toBeUndefined();
      expect(askMcpJson.result.content[0]?.text).toContain("v110-app");
    } finally {
      kernel.stop();
      server.stop(true);
    }
  });

  it("B.2: supports zero-penalty mid-turn Live Steer, Worker [ASK_HUMAN] (observe pause vs auto fallback, max 1), and StageToolProfile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v110-e2e-b-"));
    tempDirs.push(dir);
    const repoPath = await createGitRepo(dir, "v110-b2");

    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));

    let turnCounter = 0;
    let resolveTurn1Running!: () => void;
    const turn1Running = new Promise<void>((res) => {
      resolveTurn1Running = res;
    });
    const observedPrompts: Record<string, string[]> = {};

    const claudeDriver = new FlexibleScriptedWorkerDriver("claude", async function* (
      input,
      signal,
    ) {
      observedPrompts[input.ticketId] ??= [];
      observedPrompts[input.ticketId]!.push(input.prompt);
      turnCounter += 1;

      yield { type: "session_started", nativeSessionId: `sess_${turnCounter}`, timestamp: nowIso() };
      yield {
        type: "tool_use",
        toolName: "Read",
        inputSummary: "src/auth/token.ts",
        timestamp: "2026-01-01T00:00:00.000Z",
      };
      yield {
        type: "tool_result",
        toolName: "toolu_r1",
        isError: false,
        outputSummary: "read ok",
        timestamp: "2026-01-01T00:00:00.120Z",
      };

      if (input.prompt.includes("[CASE:STEER]") && !input.prompt.includes("[LIVE STEER]")) {
        // Hold turn open until mid-turn live steer aborts it
        resolveTurn1Running();
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return;
      }

      if (input.prompt.includes("[CASE:CLARIFY_HUMAN]")) {
        const askedOnce = input.prompt.includes("[HUMAN CLARIFICATION]");
        // Intentionally attempt a second [ASK_HUMAN] after resumption to test the max-1 guard
        if (!askedOnce) {
          yield {
            type: "completed",
            summary: "Need clarification on token header",
            costUsd: 0.01,
            structuredOutput: {
              clarificationRequest: {
                question: "Which auth header should be documented?",
                options: ["X-Api-Key", "Authorization Bearer"],
                recommendedOption: "Authorization Bearer",
                context: "Both appear in tests",
              },
            },
            timestamp: nowIso(),
          };
          return;
        }
        await mkdir(dirname(join(input.worktreePath, "src/auth/token.ts")), { recursive: true });
        await writeFile(
          join(input.worktreePath, "src/auth/token.ts"),
          'export function verifyToken(tok: string): boolean {\n  return tok.startsWith("tok_");\n}\n',
          "utf8",
        );
        yield {
          type: "completed",
          summary: "Implemented after human clarification",
          costUsd: 0.02,
          structuredOutput: {
            verificationPassed: true,
            clarificationRequest: {
              question: "Second ask should be ignored by cap=1",
              options: ["A", "B"],
              recommendedOption: "A",
            },
          },
          timestamp: nowIso(),
        };
        return;
      }

      if (
        input.prompt.includes("[CASE:CLARIFY_AUTO]") &&
        !input.prompt.includes("[AUTO-CLARIFIED]")
      ) {
        yield {
          type: "text",
          text: '[ASK_HUMAN]\n```json\n{"question":"Format style?","options":["Strict","Relaxed"],"recommendedOption":"Strict"}\n```',
          timestamp: nowIso(),
        };
        yield {
          type: "completed",
          summary: "Waiting for style confirmation",
          costUsd: 0.01,
          timestamp: nowIso(),
        };
        return;
      }

      await mkdir(dirname(join(input.worktreePath, "src/auth/token.ts")), { recursive: true });
      await writeFile(
        join(input.worktreePath, "src/auth/token.ts"),
        'export function verifyToken(tok: string): boolean {\n  return tok.startsWith("tok_");\n}\n',
        "utf8",
      );
      yield {
        type: "completed",
        summary: "Updated verifyToken cleanly",
        costUsd: 0.02,
        structuredOutput: { verificationPassed: true },
        timestamp: nowIso(),
      };
    });

    const outboxExec: OutboxExecutor = {
      async execute(_entry, _repo, ticket) {
        return { prUrl: `local://delivered/${ticket.id}` };
      },
    };

    const kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm: new HeuristicControlLLM(),
      drivers: [claudeDriver],
      outboxExecutor: outboxExec,
      dataDir: dir,
      config: { maxConcurrentWorkers: 1 },
    });

    await store.upsertRepo({
      id: "repo_b2",
      name: "v110-b2",
      rootPath: repoPath,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "fast",
      preferredImplementEngine: "claude",
      preferredReviewEngine: "claude",
      verificationCommands: ["bun test test/token.test.ts"],
      defaultDeliveryChannel: "local_merge",
      autoCleanupWorktree: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });

    const app = createServerApp({ kernel, stateStore: store, artifactStore: artifacts });
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      // 1. Mid-turn Live Steer
      const steerTicket = await kernel.createDirectTicket({
        repoId: "repo_b2",
        title: "Live Steer verification check",
        description: "[CASE:STEER] Check verifyToken with tok_ prefix",
        template: "fast",
        allowedPaths: ["src/**"],
        preferredEngine: "claude",
      });
      const tickPromise = kernel.tick();
      await turn1Running;

      const steerRes = await fetch(`${baseUrl}/api/tickets/${steerTicket.id}/steer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: "Use strict tok_ prefix match" }),
      });
      expect(steerRes.status).toBe(200);
      await tickPromise;
      await kernel.runUntilIdle(30);

      const steerDetailRes = await fetch(`${baseUrl}/api/tickets/${steerTicket.id}`);
      const steerDetail = (await steerDetailRes.json()) as {
        ticket: {
          status: string;
          stageRetries: number;
          steerCount?: number;
          failedEngines?: string[];
        };
        stageRuns: Array<{
          stage: string;
          steered?: boolean;
          toolProfile?: { totalToolCalls: number; byTool: Array<{ toolName: string }> };
        }>;
      };
      expect(steerDetail.ticket.status).toBe("delivered");
      expect(steerDetail.ticket.stageRetries).toBe(0);
      expect(steerDetail.ticket.steerCount).toBe(1);
      expect(steerDetail.ticket.failedEngines ?? []).toHaveLength(0);
      expect(steerDetail.stageRuns.some((r) => r.steered === true)).toBe(true);
      expect(
        steerDetail.stageRuns.some(
          (r) =>
            (r.toolProfile?.totalToolCalls ?? 0) >= 1 &&
            r.toolProfile?.byTool.some((b) => b.toolName === "Read"),
        ),
      ).toBe(true);
      expect(observedPrompts[steerTicket.id]!.some((p) => p.includes("[LIVE STEER]"))).toBe(true);

      // 2. Worker [ASK_HUMAN] in supervised (risk_gated) mode -> pauses into Inbox -> single-choice resume -> max 1 cap
      const clarTicket = await kernel.createDirectTicket({
        repoId: "repo_b2",
        title: "Worker Clarification Supervised",
        description: "[CASE:CLARIFY_HUMAN] Implement token verification",
        template: "fast",
        deliveryGatePolicy: "risk_gated",
        riskThreshold: 100,
        allowedPaths: ["src/**"],
        preferredEngine: "claude",
      });
      await kernel.runUntilIdle(30);

      const pausedTicket = await store.getTicket(clarTicket.id);
      expect(pausedTicket?.status).toBe("needs_human");
      expect(pausedTicket?.clarificationCount).toBe(1);
      const clarInbox = (await store.listInboxItems({ ticketId: clarTicket.id, status: "pending" }))[0]!;
      expect(clarInbox.kind).toBe("clarification_request");

      const resolveRes = await fetch(`${baseUrl}/api/inbox/${clarInbox.id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: "approved",
          selectedOption: "X-Api-Key",
        }),
      });
      expect(resolveRes.status).toBe(200);
      await kernel.runUntilIdle(30);

      const finalClarTicket = await store.getTicket(clarTicket.id);
      expect(finalClarTicket?.status).toBe("delivered");
      expect(finalClarTicket?.clarificationCount).toBe(1);
      expect(
        observedPrompts[clarTicket.id]!.some((p) => p.includes("[HUMAN CLARIFICATION]") && p.includes("X-Api-Key")),
      ).toBe(true);

      // 3. Worker [ASK_HUMAN] in unattended auto mode (always_auto + fast) -> auto-adopts recommendedOption
      const autoClarTicket = await kernel.createDirectTicket({
        repoId: "repo_b2",
        title: "Worker Clarification Auto",
        description: "[CASE:CLARIFY_AUTO] Auto adopt recommended option",
        template: "fast",
        deliveryGatePolicy: "always_auto",
        allowedPaths: ["src/**"],
        preferredEngine: "claude",
      });
      await kernel.runUntilIdle(30);

      const finalAutoTicket = await store.getTicket(autoClarTicket.id);
      expect(finalAutoTicket?.status).toBe("delivered");
      expect(finalAutoTicket?.clarificationCount).toBe(1);
      expect(
        await store.listInboxItems({ ticketId: autoClarTicket.id, status: "pending" }),
      ).toHaveLength(0);
      expect(
        observedPrompts[autoClarTicket.id]!.some(
          (p) => p.includes("[AUTO-CLARIFIED]") && p.includes("Strict"),
        ),
      ).toBe(true);
    } finally {
      kernel.stop();
      server.stop(true);
    }
  });

  it("D.1: executes isolated Golden Eval multi-engine replay, Knowledge Bundle portability, and verified Atomic Backup Restore", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v110-e2e-d-"));
    tempDirs.push(dir);
    const repoPath1 = await createGitRepo(dir, "v110-repo-1");
    const repoPath2 = await createGitRepo(dir, "v110-repo-2");

    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));

    const holdBox: { release: (() => void) | null; used: boolean } = {
      release: null,
      used: false,
    };
    let holdStarted!: () => void;
    const heldPromise = new Promise<void>((res) => {
      holdStarted = res;
    });

    const claudeDriver = new FlexibleScriptedWorkerDriver("claude", async function* (input) {
      yield { type: "session_started", nativeSessionId: newId("sess"), timestamp: nowIso() };
      if (input.prompt.includes("[HOLD_FOR_RESTORE_GUARD]") && !holdBox.used) {
        holdBox.used = true;
        await new Promise<void>((resolve) => {
          holdBox.release = resolve;
          holdStarted();
        });
      }
      await writeFile(
        join(input.worktreePath, "src/auth/token.ts"),
        'export function verifyToken(tok: string): boolean {\n  return tok.startsWith("tok_");\n}\n',
        "utf8",
      );
      yield {
        type: "completed",
        summary: "Passing token verification",
        costUsd: 0.03,
        structuredOutput: { verificationPassed: true },
        timestamp: nowIso(),
      };
    });

    const codexDriver = new FlexibleScriptedWorkerDriver("codex", async function* (input) {
      yield { type: "session_started", nativeSessionId: newId("sess"), timestamp: nowIso() };
      // Deliberately write failing token check during Golden Eval comparison
      await writeFile(
        join(input.worktreePath, "src/auth/token.ts"),
        "export function verifyToken(): boolean {\n  return false;\n}\n",
        "utf8",
      );
      yield {
        type: "completed",
        summary: "Broken token check",
        costUsd: 0.01,
        structuredOutput: { verificationPassed: false },
        timestamp: nowIso(),
      };
    });

    const outboxExec: OutboxExecutor = {
      async execute(_entry, _repo, ticket) {
        return { prUrl: `local://delivered/${ticket.id}` };
      },
    };

    const kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm: new HeuristicControlLLM(),
      drivers: [claudeDriver, codexDriver],
      outboxExecutor: outboxExec,
      dataDir: dir,
    });

    await store.upsertRepo({
      id: "repo_1",
      name: "v110-repo-1",
      rootPath: repoPath1,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "fast",
      preferredImplementEngine: "claude",
      preferredReviewEngine: "claude",
      verificationCommands: ["bun test test/token.test.ts"],
      blueprints: [
        {
          id: "team-security",
          name: "Team Security",
          description: "Custom blueprint",
          template: "strict",
          allowedPaths: ["src/auth/**"],
        },
      ],
      defaultDeliveryChannel: "local_merge",
      autoCleanupWorktree: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });

    await store.upsertRepo({
      id: "repo_2",
      name: "v110-repo-2",
      rootPath: repoPath2,
      baseBranch: "main",
      mode: "observe",
      defaultTemplate: "standard",
      preferredImplementEngine: "claude",
      preferredReviewEngine: "codex",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });

    const app = createServerApp({ kernel, stateStore: store, artifactStore: artifacts });
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      // Deliver source ticket cleanly
      const deliveredTicket = await kernel.createDirectTicket({
        repoId: "repo_1",
        title: "Implement tok_ prefix check",
        description: "Validate token starts with tok_",
        template: "fast",
        allowedPaths: ["src/**"],
        preferredEngine: "claude",
      });
      await kernel.runUntilIdle(30);
      expect((await store.getTicket(deliveredTicket.id))?.status).toBe("delivered");

      // 1. Golden Eval Suite save + isolated multi-engine replay
      const saveRes = await fetch(
        `${baseUrl}/api/evals/cases/from-ticket/${deliveredTicket.id}`,
        { method: "POST", body: "{}" },
      );
      expect(saveRes.status).toBe(201);
      const { evalCase } = (await saveRes.json()) as { evalCase: { id: string } };

      const ticketsBefore = (await store.listTickets()).length;
      const outboxBefore = (await store.listOutboxEntries()).length;
      const casebookBefore = (await store.listCasebookEntries("repo_1")).length;

      const evalRunRes = await fetch(`${baseUrl}/api/evals/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ evalCaseId: evalCase.id, engines: ["claude", "codex"] }),
      });
      expect(evalRunRes.status).toBe(201);
      const { evalRun } = (await evalRunRes.json()) as {
        evalRun: { results: Array<{ engine: string; passed: boolean }> };
      };
      expect(evalRun.results.find((r) => r.engine === "claude")?.passed).toBe(true);
      expect(evalRun.results.find((r) => r.engine === "codex")?.passed).toBe(false);

      // Eval runs leave zero side effects on live tables and clean up eval-worktrees
      expect((await store.listTickets()).length).toBe(ticketsBefore);
      expect((await store.listOutboxEntries()).length).toBe(outboxBefore);
      expect((await store.listCasebookEntries("repo_1")).length).toBe(casebookBefore);
      const evalWorktreeDir = join(dir, "eval-worktrees");
      expect(await readdir(evalWorktreeDir)).toHaveLength(0);

      const cliEvalLines: string[] = [];
      expect(
        await runCli(["eval", "list", "--repo", "repo_1", "--json"], {
          baseUrl,
          stdout: (l) => cliEvalLines.push(l),
          stderr: () => {},
        }),
      ).toBe(0);
      expect(JSON.parse(cliEvalLines.join("\n")).cases).toHaveLength(1);

      // 2. Knowledge Bundle export + import + dedup
      await kernel.addOrUpdatePlaybookRule({
        repoId: "repo_1",
        rule: "Always verify tok_ prefix in auth module",
        scopePaths: ["src/auth/**"],
        source: "human",
        pinned: true,
      });

      const bundlePath = join(dir, "repo1-bundle.json");
      expect(
        await runCli(["bundle", "export", "repo_1", "-o", bundlePath], {
          baseUrl,
          stdout: () => {},
          stderr: () => {},
        }),
      ).toBe(0);

      const importRes1 = await fetch(`${baseUrl}/api/repos/repo_2/knowledge-bundle/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(JSON.parse(await Bun.file(bundlePath).text())),
      });
      expect(importRes1.status).toBe(200);
      const imported1 = (await importRes1.json()) as {
        importedPlaybook: number;
        importedCasebook: number;
        importedBlueprints: number;
      };
      expect(imported1.importedPlaybook).toBeGreaterThanOrEqual(1);
      expect(imported1.importedCasebook).toBeGreaterThanOrEqual(1);
      expect(imported1.importedBlueprints).toBe(1);

      const importRes2 = await fetch(`${baseUrl}/api/repos/repo_2/knowledge-bundle/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(JSON.parse(await Bun.file(bundlePath).text())),
      });
      const imported2 = (await importRes2.json()) as { skippedDuplicates: number };
      expect(imported2.skippedDuplicates).toBeGreaterThan(0);

      // 3. Atomic Hot Backup + Active-Run Guard + Restore + Pre-Restore Safety Backup
      const bkpRes = await fetch(`${baseUrl}/api/system/backups`, { method: "POST" });
      expect(bkpRes.status).toBe(201);
      const { backup } = (await bkpRes.json()) as { backup: { id: string; filename: string } };

      const extraTicket = await kernel.createDirectTicket({
        repoId: "repo_1",
        title: "Temporary in-flight ticket",
        description: "[HOLD_FOR_RESTORE_GUARD] Hold until checked",
        template: "fast",
        allowedPaths: ["src/**"],
        preferredEngine: "claude",
      });
      const activeTick = kernel.tick();
      await heldPromise;

      const blockedRestore = await fetch(`${baseUrl}/api/system/backups/${backup.id}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: false }),
      });
      expect(blockedRestore.status).toBe(400);
      const blockedJson = (await blockedRestore.json()) as { error: string };
      expect(blockedJson.error).toContain("running");

      // Release held worker and drain until idle
      holdBox.release?.();
      await activeTick;
      await kernel.runUntilIdle(30);
      expect(await store.getTicket(extraTicket.id)).not.toBeNull();

      const restoreRes = await fetch(`${baseUrl}/api/system/backups/${backup.id}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(restoreRes.status).toBe(200);
      const restoreJson = (await restoreRes.json()) as {
        ok: boolean;
        preRestoreSafetyBackup?: { filename: string };
      };
      expect(restoreJson.ok).toBe(true);
      expect(restoreJson.preRestoreSafetyBackup?.filename).toContain(".sqlite");
      // Post-backup ticket was rolled back cleanly
      expect(await store.getTicket(extraTicket.id)).toBeNull();
      expect(await store.getTicket(deliveredTicket.id)).not.toBeNull();
    } finally {
      kernel.stop();
      server.stop(true);
    }
  });
});
