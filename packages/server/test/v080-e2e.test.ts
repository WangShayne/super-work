import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  SuperWorkKernel,
  computeHmacSha256Hex,
  newId,
  nowIso,
  type BrowserCheckConfig,
  type OutboxExecutor,
  type RepoContractFile,
  type SystemSetupConfig,
  type WorkerDriver,
  type WorkerEngineId,
  type WorkerStreamEvent,
  type WorkerTurnInput,
} from "@super-work/core";
import {
  FsArtifactStore,
  GitWorktreeProvider,
  HeuristicControlLLM,
  MockWorkerDriver,
  NotificationDispatcher,
  SqliteStateStore,
  WorktreePreviewManager,
  runGit,
  type BrowserCheckExecutionResult,
} from "@super-work/drivers";
import { runCli } from "../../cli/src/index.ts";
import { createServerApp } from "../src/app.ts";

const ONE_BY_ONE_PNG_BYTES = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
);

async function createGitRepo(baseDir: string, name: string): Promise<string> {
  const repoDir = join(baseDir, name);
  await runGit(["init", "-b", "main", repoDir], baseDir);
  await runGit(["config", "user.name", "Test User"], repoDir);
  await runGit(["config", "user.email", "test@example.com"], repoDir);
  await mkdir(join(repoDir, "src"), { recursive: true });
  await writeFile(join(repoDir, "README.md"), `# ${name}\n`, "utf8");
  await writeFile(join(repoDir, "src/index.ts"), `export const repo = ${JSON.stringify(name)};\n`, "utf8");
  await runGit(["add", "."], repoDir);
  await runGit(["commit", "-m", "initial commit"], repoDir);
  return repoDir;
}

class CustomEngineScriptedDriver implements WorkerDriver {
  constructor(
    readonly engine: WorkerEngineId,
    private readonly handler: (
      input: WorkerTurnInput,
      signal: AbortSignal,
    ) => Promise<{
      summary: string;
      writeFiles?: Record<string, string>;
      error?: string;
      costUsd?: number;
      text?: string;
    }>,
  ) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async *runTurn(input: WorkerTurnInput, signal: AbortSignal): AsyncGenerator<WorkerStreamEvent> {
    yield { type: "session_started", nativeSessionId: newId("sess"), timestamp: nowIso() };
    const result = await this.handler(input, signal);
    if (result.error) {
      yield { type: "error", message: result.error, fatal: true, timestamp: nowIso() };
      return;
    }
    if (result.writeFiles) {
      for (const [relPath, content] of Object.entries(result.writeFiles)) {
        const full = join(input.worktreePath, relPath);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, content, "utf8");
      }
    }
    if (result.text) {
      yield { type: "text", text: result.text, timestamp: nowIso() };
    }
    const cost = result.costUsd ?? 0.02;
    yield { type: "usage", costUsd: cost, timestamp: nowIso() };
    yield {
      type: "completed",
      summary: result.summary,
      costUsd: cost,
      structuredOutput: {
        verificationPassed: true,
        ...(input.stage === "review" ? { approved: true, reviewFindings: [] } : {}),
      },
      timestamp: nowIso(),
    };
  }
}

describe("v0.8.0 End-to-End Capabilities (A.1 MCP + A.2 Webhooks/Cards + B.1 Browser/PNG + B.2 Live Preview + C.1/D.1)", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("A.1 & A.2: enforces Bearer auth on /api/mcp, runs CLI MCP stdio bridge, and handles signed GitHub webhooks + crawler-safe action cards + ChatOps", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v080-mcp-wh-"));
    tempDirs.push(dir);
    const repoPath = await createGitRepo(dir, "omni-repo");

    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));
    const dispatcher = new NotificationDispatcher(store, {
      macosSender: async () => {},
    });

    const webhookDeliveries: Array<{ payload: Record<string, unknown>; sigHeader: string | null }> = [];
    const webhookCollector = Bun.serve({
      port: 0,
      async fetch(req) {
        const raw = await req.text();
        webhookDeliveries.push({
          payload: JSON.parse(raw) as Record<string, unknown>,
          sigHeader: req.headers.get("x-super-work-signature"),
        });
        return new Response("ok", { status: 200 });
      },
    });

    const outboxExec: OutboxExecutor = {
      async execute(_entry, _repo, ticket) {
        return { prUrl: `local://pr/${ticket.id}` };
      },
    };

    const kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm: new HeuristicControlLLM(),
      drivers: [new MockWorkerDriver({ engine: "mock", stepDelayMs: 2 })],
      outboxExecutor: outboxExec,
      config: { maxConcurrentWorkers: 2 },
    });
    const detachDispatcher = dispatcher.attachToKernel(kernel);

    const ts = nowIso();
    await store.upsertRepo({
      id: "repo_omni",
      name: "omni-repo",
      rootPath: repoPath,
      baseBranch: "main",
      githubRepo: "acme/omni-repo",
      mode: "observe",
      defaultTemplate: "fast",
      preferredImplementEngine: "mock",
      preferredReviewEngine: "mock",
      autoCleanupWorktree: true,
      defaultDeliveryChannel: "local_merge",
      createdAt: ts,
      updatedAt: ts,
    });

    const prevToken = process.env.SUPER_WORK_TOKEN;
    const authToken = "tok-v080";
    process.env.SUPER_WORK_TOKEN = authToken;

    const app = createServerApp({
      kernel,
      stateStore: store,
      artifactStore: artifacts,
      notificationDispatcher: dispatcher,
      authToken,
    });
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      const setupCfg: SystemSetupConfig = {
        initialized: true,
        llmPreset: "heuristic",
        llmBaseUrl: "",
        llmModel: "",
        llmEffort: "low",
        preferredImplementEngine: "mock",
        preferredReviewEngine: "mock",
        claudeProfile: {},
        codexProfile: {},
        opencodeProfile: {},
        notifications: {
          macosEnabled: false,
          webhookEnabled: true,
          webhookUrl: `http://127.0.0.1:${webhookCollector.port}/hook`,
          webhookSecret: "wh-out-sec",
          publicBaseUrl: baseUrl,
          actionSecret: "act-sec",
          githubWebhookSecret: "gh-sec",
          actionTtlMinutes: 60,
          notifyOnInbox: true,
          notifyOnDelivery: false,
          notifyOnFailure: false,
        },
        updatedAt: nowIso(),
      };
      await store.setSystemSetting("setup_config", setupCfg);

      // 1. Bearer auth blocks unauthenticated /api/mcp
      const unauthMcp = await fetch(`${baseUrl}/api/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(unauthMcp.status).toBe(401);

      // 2. CLI `super-work mcp --no-auto-start` stdio bridge speaks pure JSON-RPC on stdout
      const mcpInputLines = [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26" },
        }),
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "clarify_spec",
            arguments: {
              repoId: "repo_omni",
              title: "Update src/index.ts exports",
              description: "Export version constant from src/index.ts",
            },
          },
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "resources/read",
          params: { uri: "superwork://health" },
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: {
            name: "dispatch_ticket",
            arguments: {
              repoId: "repo_omni",
              title: "MCP dispatched task",
              description: "Create helper in src/mcp_helper.ts",
              template: "fast",
              allowedPaths: ["src/**"],
            },
          },
        }),
      ];

      const mcpOutLines: string[] = [];
      const mcpErrLines: string[] = [];
      const mcpInputStream = (async function* () {
        for (const line of mcpInputLines) {
          yield line;
        }
      })();
      const mcpCode = await runCli(["mcp", "--no-auto-start"], {
        baseUrl,
        token: authToken,
        mcpInputLines: mcpInputStream,
        stdout: (line) => mcpOutLines.push(line),
        stderr: (line) => mcpErrLines.push(line),
      });
      expect(mcpCode).toBe(0);
      expect(mcpErrLines).toHaveLength(0);
      expect(mcpOutLines).toHaveLength(5);

      const parsedInit = JSON.parse(mcpOutLines[0]!) as { result: { serverInfo: { version: string } } };
      expect(parsedInit.result.serverInfo.version).toBe("0.8.0");
      const parsedTools = JSON.parse(mcpOutLines[1]!) as { result: { tools: Array<{ name: string }> } };
      expect(parsedTools.result.tools).toHaveLength(10);
      const parsedClarify = JSON.parse(mcpOutLines[2]!) as {
        result: { content: Array<{ text: string }> };
      };
      expect(JSON.parse(parsedClarify.result.content[0]!.text).ready).toBe(true);
      const parsedHealthRes = JSON.parse(mcpOutLines[3]!) as {
        result: { contents: Array<{ text: string }> };
      };
      expect(JSON.parse(parsedHealthRes.result.contents[0]!.text).ok).toBe(true);

      // Wait briefly so observe_proposal inbox notification from MCP dispatch arrives cleanly
      await new Promise((r) => setTimeout(r, 100));

      // 3. Inbound GitHub webhook bypasses SUPER_WORK_TOKEN and enforces X-Hub-Signature-256
      const ghBody = JSON.stringify({
        action: "opened",
        repository: { full_name: "acme/omni-repo" },
        issue: {
          number: 77,
          title: "Add health probe endpoint",
          body: "Please implement GET /healthz in src/index.ts",
          updated_at: "2026-01-01T00:00:00Z",
          user: { login: "alice" },
        },
      });
      const badGhRes = await fetch(`${baseUrl}/api/webhooks/github`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-github-event": "issues",
          "x-hub-signature-256": "sha256=deadbeef",
        },
        body: ghBody,
      });
      expect(badGhRes.status).toBe(401);

      const ghSig = `sha256=${computeHmacSha256Hex(ghBody, "gh-sec")}`;
      const okGhRes = await fetch(`${baseUrl}/api/webhooks/github`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-github-event": "issues",
          "x-hub-signature-256": ghSig,
        },
        body: ghBody,
      });
      expect(okGhRes.status).toBe(202);
      const okGhJson = (await okGhRes.json()) as {
        ok: boolean;
        result: { inboxItem?: { id: string; kind: string }; ticket?: { id: string } };
      };
      expect(okGhJson.ok).toBe(true);
      const targetInboxId = okGhJson.result.inboxItem?.id;
      const targetTicketId = okGhJson.result.ticket?.id;
      expect(targetInboxId).toBeTruthy();

      // Poll briefly for async NotificationDispatcher to deliver signed action card URL
      const deadline = Date.now() + 2_000;
      let matchedActionUrl = "";
      while (Date.now() < deadline && !matchedActionUrl) {
        const hit = webhookDeliveries.find((d) => d.payload.inboxId === targetInboxId);
        if (hit && typeof hit.payload.actionUrl === "string") {
          matchedActionUrl = hit.payload.actionUrl;
          break;
        }
        await new Promise((r) => setTimeout(r, 30));
      }
      expect(matchedActionUrl).toContain("/api/webhooks/action?token=");
      const actionToken = new URL(matchedActionUrl).searchParams.get("token")!;
      expect(actionToken).toBeTruthy();

      // 4. Crawler-safe GET renders HTML form and MUST NOT mutate Inbox state
      const getCardRes = await fetch(matchedActionUrl);
      expect(getCardRes.status).toBe(200);
      const cardHtml = await getCardRes.text();
      expect(cardHtml).toContain('form method="POST" action="/api/webhooks/action"');
      expect((await store.getInboxItem(targetInboxId!))?.status).toBe("pending");

      // 5. POST /api/webhooks/action approves Inbox item without Bearer token
      const postCardRes = await fetch(`${baseUrl}/api/webhooks/action`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "text/html",
        },
        body: new URLSearchParams({
          token: actionToken,
          decision: "approved",
          note: "Approved from mobile card",
        }).toString(),
      });
      expect(postCardRes.status).toBe(200);
      expect(await postCardRes.text()).toContain("Decision Recorded");
      expect((await store.getInboxItem(targetInboxId!))?.status).toBe("approved");

      // 6. Signed ChatOps callback enforces actionSecret HMAC and routes reply_ticket
      const chatOpsBody = JSON.stringify({
        action: "reply_ticket",
        ticketId: targetTicketId,
        message: "Follow-up instruction from ChatOps",
      });
      const badChatOps = await fetch(`${baseUrl}/api/webhooks/chatops`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-super-work-signature": "sha256=bad",
        },
        body: chatOpsBody,
      });
      expect(badChatOps.status).toBe(401);

      const okChatOps = await fetch(`${baseUrl}/api/webhooks/chatops`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-super-work-signature": `sha256=${computeHmacSha256Hex(chatOpsBody, "act-sec")}`,
        },
        body: chatOpsBody,
      });
      expect(okChatOps.status).toBe(200);

      await kernel.runUntilIdle(10);
    } finally {
      detachDispatcher();
      await kernel.stop();
      server.stop(true);
      webhookCollector.stop(true);
      store.close();
      if (prevToken === undefined) {
        delete process.env.SUPER_WORK_TOKEN;
      } else {
        process.env.SUPER_WORK_TOKEN = prevToken;
      }
    }
  });

  it("B.1: fails on CDP browser gate, triggers worker self-heal, persists PNG screenshot Spill, and serves raw image bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v080-b1-"));
    tempDirs.push(dir);
    const repoPath = await createGitRepo(dir, "ui-app");

    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));

    let browserCalls = 0;
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"), {
      browserRunner: async (readyUrl, cfg: BrowserCheckConfig): Promise<BrowserCheckExecutionResult> => {
        browserCalls += 1;
        if (browserCalls === 1) {
          return {
            summary: {
              executed: true,
              ok: false,
              routes: [
                {
                  path: cfg.paths?.[0] ?? "/",
                  url: readyUrl,
                  ok: false,
                  status: 200,
                  consoleErrors: [],
                  pageErrors: ["Uncaught TypeError: mount is not a function"],
                  failedRequests: [],
                  durationMs: 12,
                },
              ],
              summary: "Browser gate failed on / (Uncaught TypeError: mount is not a function)",
            },
            rawScreenshots: [{ routeIndex: 0, path: "/", bytes: ONE_BY_ONE_PNG_BYTES }],
          };
        }
        return {
          summary: {
            executed: true,
            ok: true,
            routes: [
              {
                path: cfg.paths?.[0] ?? "/",
                url: readyUrl,
                ok: true,
                status: 200,
                consoleErrors: [],
                pageErrors: [],
                failedRequests: [],
                durationMs: 10,
              },
            ],
            summary: "Browser gate passed across 1 route(s)",
          },
          rawScreenshots: [{ routeIndex: 0, path: "/", bytes: ONE_BY_ONE_PNG_BYTES }],
        };
      },
    });

    let driverTurns = 0;
    const driver = new CustomEngineScriptedDriver("claude", async (input) => {
      if (input.stage === "implement") {
        driverTurns += 1;
        return {
          summary: driverTurns === 1 ? "Initial UI mount" : "Fixed TypeError in UI mount",
          writeFiles: {
            "src/ui.ts": `export const mount = () => (${driverTurns === 1 ? "null" : "'mounted'"});\n`,
          },
        };
      }
      return { summary: "review ok", text: "VERDICT: APPROVED" };
    });

    const kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm: new HeuristicControlLLM(),
      drivers: [driver],
      outboxExecutor: {
        async execute(_entry, _repo, ticket) {
          return { prUrl: `local://pr/${ticket.id}` };
        },
      },
      config: { maxConcurrentWorkers: 1 },
    });

    const ts = nowIso();
    await store.upsertRepo({
      id: "repo_ui",
      name: "ui-app",
      rootPath: repoPath,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "fast",
      preferredImplementEngine: "claude",
      preferredReviewEngine: "claude",
      autoCleanupWorktree: false,
      defaultDeliveryChannel: "local_merge",
      verificationCommands: [],
      smokeCheck: {
        enabled: true,
        startCommand: `exec ${process.execPath} -e "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') })"`,
        readyUrl: "/",
        startupTimeoutSec: 5,
        browserCheck: { enabled: true, paths: ["/"] },
      },
      createdAt: ts,
      updatedAt: ts,
    });

    const app = createServerApp({ kernel, stateStore: store, artifactStore: artifacts });
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      const ticket = await kernel.createDirectTicket({
        repoId: "repo_ui",
        title: "Build UI widget",
        description: "Render widget cleanly in src/ui.ts",
        template: "fast",
        allowedPaths: ["src/**"],
      });

      await kernel.runUntilIdle(10);

      const finalTicket = await store.getTicket(ticket.id);
      expect(finalTicket?.status).toBe("delivered");
      expect(browserCalls).toBeGreaterThanOrEqual(2);
      expect(driverTurns).toBe(2);

      const ticketArtifacts = await store.listArtifacts(ticket.id);
      const screenshots = ticketArtifacts.filter((a) => a.kind === "screenshot");
      expect(screenshots.length).toBeGreaterThanOrEqual(2);

      const rawRes = await fetch(`${baseUrl}/api/artifacts/${screenshots[0]!.id}/raw`);
      expect(rawRes.status).toBe(200);
      expect(rawRes.headers.get("content-type")).toContain("image/png");
      const rawBytes = new Uint8Array(await rawRes.arrayBuffer());
      expect(rawBytes).toEqual(ONE_BY_ONE_PNG_BYTES);
    } finally {
      await kernel.stop();
      server.stop(true);
      store.close();
    }
  }, 15_000);

  it("B.2 & C.1 & D.1: manages bounded LRU Live Worktree Previews, CLI preview/clarify, and sandboxMode contract sync/export", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v080-b2-"));
    tempDirs.push(dir);
    const repoPath = await createGitRepo(dir, "preview-app");

    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));
    const previewManager = new WorktreePreviewManager({
      maxConcurrent: 2,
      defaultTtlMinutes: 20,
      startupTimeoutMs: 8_000,
    });

    const driver = new CustomEngineScriptedDriver("mock", async (input) => {
      const idx = input.mandate.allowedPaths[0]?.match(/f(\d+)\.ts/)?.[1] ?? "1";
      return {
        summary: `Updated feature ${idx}`,
        writeFiles: { [`src/f${idx}.ts`]: `export const feature = ${JSON.stringify(idx)};\n` },
      };
    });

    const kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm: new HeuristicControlLLM(),
      drivers: [driver],
      previewProvider: previewManager,
      outboxExecutor: {
        async execute(_entry, _repo, ticket) {
          return { prUrl: `local://pr/${ticket.id}` };
        },
      },
      config: { maxConcurrentWorkers: 1 },
    });

    const previewCmd = `${process.execPath} -e "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('live-preview-ok') })"`;
    const ts = nowIso();
    await store.upsertRepo({
      id: "repo_prv",
      name: "preview-app",
      rootPath: repoPath,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "fast",
      sandboxMode: "balanced",
      previewCommand: previewCmd,
      preferredImplementEngine: "mock",
      preferredReviewEngine: "mock",
      autoCleanupWorktree: false,
      defaultDeliveryChannel: "github_pr",
      verificationCommands: [],
      createdAt: ts,
      updatedAt: ts,
    });

    const app = createServerApp({ kernel, stateStore: store, artifactStore: artifacts });
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      // D.1 Spec Clarify REST & CLI --clarify-only
      const clarifyRes = await fetch(`${baseUrl}/api/specs/clarify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: "repo_prv",
          title: "Refactor src/index.ts exports",
          description: "Update exported repo name constant",
        }),
      });
      expect(clarifyRes.status).toBe(200);
      const clarifyJson = (await clarifyRes.json()) as {
        clarification: { ready: boolean; suggestedAllowedPaths: string[] };
      };
      expect(clarifyJson.clarification.ready).toBe(true);
      expect(clarifyJson.clarification.suggestedAllowedPaths).toContain("src/**");

      const cliClarifyOut: string[] = [];
      const cliClarifyCode = await runCli(
        [
          "dispatch",
          "Update src/index.ts",
          "-d",
          "Add helper",
          "--repo",
          "repo_prv",
          "--clarify-only",
          "--json",
        ],
        { baseUrl, stdout: (l) => cliClarifyOut.push(l) },
      );
      expect(cliClarifyCode).toBe(0);
      const cliClarifyJson = JSON.parse(cliClarifyOut.join("\n")) as {
        clarification: { ready: boolean };
      };
      expect(cliClarifyJson.clarification.ready).toBe(true);

      // C.1 Contract export & sync round-trip preserves previewCommand & sandboxMode
      const patchStrictRes = await fetch(`${baseUrl}/api/repos/repo_prv`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sandboxMode: "strict" }),
      });
      expect(patchStrictRes.status).toBe(200);

      const exportRes = await fetch(`${baseUrl}/api/repos/repo_prv/contract/export`, {
        method: "POST",
      });
      expect(exportRes.status).toBe(200);
      const contractText = await readFile(join(repoPath, "super-work.json"), "utf8");
      const contractJson = JSON.parse(contractText) as RepoContractFile;
      expect(contractJson.previewCommand).toBe(previewCmd);
      expect(contractJson.sandboxMode).toBe("strict");

      // Mutate locally to "off", then sync from super-work.json contract back to "strict"
      const patchOffRes = await fetch(`${baseUrl}/api/repos/repo_prv`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sandboxMode: "off" }),
      });
      expect(patchOffRes.status).toBe(200);
      const syncRes = await fetch(`${baseUrl}/api/repos/repo_prv/contract/sync`, { method: "POST" });
      expect(syncRes.status).toBe(200);
      const updatedRepo = await store.getRepo("repo_prv");
      expect(updatedRepo?.sandboxMode).toBe("strict");

      // B.2 Create 3 delivered tickets keeping worktrees intact (autoCleanupWorktree: false)
      const t1 = await kernel.createDirectTicket({
        repoId: "repo_prv",
        title: "Feature 1",
        description: "Create f1",
        template: "fast",
        allowedPaths: ["src/f1.ts"],
      });
      const t2 = await kernel.createDirectTicket({
        repoId: "repo_prv",
        title: "Feature 2",
        description: "Create f2",
        template: "fast",
        allowedPaths: ["src/f2.ts"],
      });
      const t3 = await kernel.createDirectTicket({
        repoId: "repo_prv",
        title: "Feature 3",
        description: "Create f3",
        template: "fast",
        allowedPaths: ["src/f3.ts"],
      });
      await kernel.runUntilIdle(15);

      expect((await store.getTicket(t1.id))?.status).toBe("delivered");
      expect((await store.getTicket(t2.id))?.status).toBe("delivered");
      expect((await store.getTicket(t3.id))?.status).toBe("delivered");

      const waitForPreviewBody = async (url: string): Promise<string> => {
        const deadline = Date.now() + 4_000;
        let lastErr: unknown;
        while (Date.now() < deadline) {
          try {
            const res = await fetch(url);
            if (res.ok) return await res.text();
          } catch (err) {
            lastErr = err;
          }
          await new Promise((r) => setTimeout(r, 60));
        }
        throw new Error(`Timed out fetching preview ${url}: ${String(lastErr ?? "not ready")}`);
      };

      // Start preview 1 & verify HTTP response + CLI preview list
      const p1Res = await fetch(`${baseUrl}/api/previews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketId: t1.id }),
      });
      expect(p1Res.status).toBe(201);
      const p1Json = (await p1Res.json()) as {
        preview: { id: string; url: string; expiresAt: string };
      };
      const p1 = p1Json.preview;
      expect(await waitForPreviewBody(p1.url)).toBe("live-preview-ok");

      const cliPrvOut: string[] = [];
      const cliPrvCode = await runCli(["preview", "list", "--repo", "repo_prv", "--json"], {
        baseUrl,
        stdout: (l) => cliPrvOut.push(l),
      });
      expect(cliPrvCode).toBe(0);
      const cliPrvJson = JSON.parse(cliPrvOut.join("\n")) as {
        previews: Array<{ id: string }>;
      };
      expect(cliPrvJson.previews.some((p) => p.id === p1.id)).toBe(true);

      // Start preview 2 & 3 -> maxConcurrent = 2 evicts p1
      const p2Res = await fetch(`${baseUrl}/api/previews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketId: t2.id }),
      });
      expect(p2Res.status).toBe(201);
      const p2Json = (await p2Res.json()) as { preview: { id: string; url: string } };
      const p2 = p2Json.preview;

      const p3Res = await fetch(`${baseUrl}/api/previews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketId: t3.id }),
      });
      expect(p3Res.status).toBe(201);
      const p3Json = (await p3Res.json()) as {
        preview: { id: string; url: string; expiresAt: string };
      };
      const p3 = p3Json.preview;
      expect(await waitForPreviewBody(p3.url)).toBe("live-preview-ok");

      const listAfterMaxJson = (await (
        await fetch(`${baseUrl}/api/previews?repoId=repo_prv`)
      ).json()) as { previews: Array<{ id: string; ticketId: string }> };
      const listAfterMax = listAfterMaxJson.previews;
      expect(listAfterMax).toHaveLength(2);
      expect(listAfterMax.some((p) => p.id === p1.id)).toBe(false);
      expect(listAfterMax.some((p) => p.id === p2.id)).toBe(true);
      expect(listAfterMax.some((p) => p.id === p3.id)).toBe(true);

      // Renew preview 3
      const renewRes = await fetch(`${baseUrl}/api/previews/${p3.id}/renew`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ttlMinutes: 45 }),
      });
      expect(renewRes.status).toBe(200);
      const renewedJson = (await renewRes.json()) as { preview: { expiresAt: string } };
      expect(Date.parse(renewedJson.preview.expiresAt)).toBeGreaterThan(Date.parse(p3.expiresAt));

      // Cleanup t3 worktree automatically stops p3 preview
      const cleanupRes = await fetch(`${baseUrl}/api/tickets/${t3.id}/cleanup-worktree`, {
        method: "POST",
      });
      expect(cleanupRes.status).toBe(200);

      const listAfterCleanupJson = (await (
        await fetch(`${baseUrl}/api/previews?repoId=repo_prv`)
      ).json()) as { previews: Array<{ id: string }> };
      const listAfterCleanup = listAfterCleanupJson.previews;
      expect(listAfterCleanup.some((p) => p.id === p3.id)).toBe(false);
      expect(listAfterCleanup.some((p) => p.id === p2.id)).toBe(true);
    } finally {
      await kernel.stop();
      server.stop(true);
      store.close();
    }
  }, 15_000);
});
