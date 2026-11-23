import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  SuperWorkKernel,
  newId,
  nowIso,
  type KernelEvent,
  type OutboxExecutor,
  type Ticket,
  type WorkerDriver,
  type WorkerStreamEvent,
  type WorkerTurnInput,
} from "@super-work/core";
import {
  FsArtifactStore,
  GhOutboxExecutor,
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
  await mkdir(join(repoDir, "src"), { recursive: true });
  await writeFile(join(repoDir, "README.md"), `# ${name}\n`, "utf8");
  await writeFile(join(repoDir, "src/index.ts"), `export const repo = ${JSON.stringify(name)};\n`, "utf8");
  await runGit(["add", "."], repoDir);
  await runGit(["commit", "-m", "initial commit"], repoDir);
  return repoDir;
}

class CustomScriptedDriver implements WorkerDriver {
  readonly engine = "mock" as const;

  constructor(
    private readonly handler: (
      input: WorkerTurnInput,
      signal: AbortSignal,
    ) => Promise<{
      summary: string;
      changedFiles: string[];
      writeFiles?: Record<string, string>;
    }>,
  ) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async *runTurn(input: WorkerTurnInput, signal: AbortSignal): AsyncGenerator<WorkerStreamEvent> {
    yield { type: "session_started", nativeSessionId: newId("sess"), timestamp: nowIso() };
    const result = await this.handler(input, signal);
    if (result.writeFiles) {
      for (const [relPath, content] of Object.entries(result.writeFiles)) {
        const full = join(input.worktreePath, relPath);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, content, "utf8");
      }
    }
    yield { type: "usage", costUsd: 0.03, timestamp: nowIso() };
    yield {
      type: "completed",
      summary: result.summary,
      costUsd: 0.03,
      structuredOutput: {
        changedFiles: result.changedFiles,
        verificationPassed: true,
      },
      timestamp: nowIso(),
    };
  }
}

describe("v0.6.0 End-to-End Capabilities (Handover + Cross-Repo + Runtime Smoke Gate)", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("executes a Cross-Repo Epic, generates HandoverDigest without cross-repo git merge errors, and injects contracts into downstream repo prompts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v060-crossrepo-"));
    tempDirs.push(dir);
    const backendDir = await createGitRepo(dir, "backend-api");
    const frontendDir = await createGitRepo(dir, "frontend-sdk");

    const stateStore = new SqliteStateStore(join(dir, "state.db"));
    const artifactStore = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));
    const capturedPrompts = new Map<string, string>();

    const driver = new CustomScriptedDriver(async (input) => {
      capturedPrompts.set(input.ticketId, input.prompt);
      if (input.prompt.includes("Goal: Implement POST /api/orders with OrderPayload")) {
        const writeFiles: Record<string, string> = {
          "src/orders.ts": [
            "export interface OrderPayload { orderId: string; totalCents: number; }",
            "export async function createOrderHandler(payload: OrderPayload): Promise<string> {",
            "  return payload.orderId;",
            "}",
            'app.post("/api/orders", () => ({ status: 201 }));',
            "",
          ].join("\n"),
        };
        return {
          summary: "Implemented Orders endpoint and OrderPayload contract",
          changedFiles: ["src/orders.ts"],
          writeFiles,
        };
      }

      const writeFiles: Record<string, string> = {
        "src/sdk.ts": [
          "// Consumed upstream contract",
          'export const endpoint = "/api/orders";',
          "",
        ].join("\n"),
      };
      return {
        summary: "Implemented frontend Orders SDK client matching backend contract",
        changedFiles: ["src/sdk.ts"],
        writeFiles,
      };
    });

    const kernel = new SuperWorkKernel({
      stateStore,
      artifactStore,
      workspace,
      llm: new HeuristicControlLLM(),
      drivers: [driver],
      outboxExecutor: new GhOutboxExecutor(workspace),
    });

    const app = createServerApp({ kernel, stateStore, artifactStore });

    const regBackend = await app.request("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "repo_backend",
        name: "backend-api",
        rootPath: backendDir,
        baseBranch: "main",
        mode: "auto",
        defaultTemplate: "fast",
        preferredImplementEngine: "mock",
        preferredReviewEngine: "mock",
        defaultDeliveryChannel: "local_merge",
      }),
    });
    expect(regBackend.status).toBe(201);

    const regFrontend = await app.request("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "repo_frontend",
        name: "frontend-sdk",
        rootPath: frontendDir,
        baseBranch: "main",
        mode: "auto",
        defaultTemplate: "fast",
        preferredImplementEngine: "mock",
        preferredReviewEngine: "mock",
        defaultDeliveryChannel: "local_merge",
      }),
    });
    expect(regFrontend.status).toBe(201);

    const epicRes = await app.request("/api/epics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoId: "repo_backend",
        title: "Cross-Repo Orders Feature",
        description: "Build orders backend API then frontend SDK client",
        template: "fast",
        epicDeliveryMode: "unified", // should automatically coerce to per_subtask for cross-repo
        subtasks: [
          {
            key: "api",
            repoId: "repo_backend",
            title: "Add Orders API",
            description: "Implement POST /api/orders with OrderPayload",
            template: "fast",
            allowedPaths: ["src/**"],
            dependsOnKeys: [],
            acceptanceCriteria: ["POST /api/orders returns 201"],
          },
          {
            key: "sdk",
            repoId: "repo_frontend",
            title: "Add Orders SDK",
            description: "Create frontend SDK calling Orders API",
            template: "fast",
            allowedPaths: ["src/**"],
            dependsOnKeys: ["api"],
            acceptanceCriteria: ["SDK consumes POST /api/orders"],
          },
        ],
      }),
    });
    expect(epicRes.status).toBe(201);
    const created = (await epicRes.json()) as { epic: Ticket; subtasks: Ticket[] };
    expect(created.epic.epicDeliveryMode).toBe("per_subtask");
    expect(created.epic.branchName).toBeUndefined();

    const apiSub = created.subtasks.find((s) => s.subtaskKey === "api")!;
    const sdkSub = created.subtasks.find((s) => s.subtaskKey === "sdk")!;
    expect(apiSub.repoId).toBe("repo_backend");
    expect(sdkSub.repoId).toBe("repo_frontend");
    expect(sdkSub.status).toBe("waiting_deps");

    await kernel.runUntilIdle(30);

    const epicDetailRes = await app.request(`/api/tickets/${created.epic.id}`);
    expect(epicDetailRes.status).toBe(200);
    const epicDetail = (await epicDetailRes.json()) as {
      ticket: Ticket;
      subtasks?: Ticket[];
    };
    expect(epicDetail.ticket.status).toBe("delivered");
    expect(epicDetail.subtasks).toHaveLength(2);

    const apiDetailRes = await app.request(`/api/tickets/${apiSub.id}`);
    const apiDetail = (await apiDetailRes.json()) as {
      ticket: Ticket;
      artifacts: Array<{ kind: string; id: string }>;
    };
    expect(apiDetail.ticket.status).toBe("delivered");
    expect(apiDetail.ticket.handoverDigest?.version).toBe(1);
    expect(apiDetail.ticket.handoverDigest?.exportedSymbols.join(" ")).toContain("OrderPayload");
    expect(apiDetail.artifacts.some((a) => a.kind === "handover")).toBe(true);

    const sdkDetailRes = await app.request(`/api/tickets/${sdkSub.id}`);
    const sdkDetail = (await sdkDetailRes.json()) as {
      ticket: Ticket;
      upstreamDependencies?: Array<{ id: string; repoName?: string; handoverDigest?: { version: number } }>;
    };
    expect(sdkDetail.ticket.status).toBe("delivered");
    expect(sdkDetail.upstreamDependencies?.[0]?.id).toBe(apiSub.id);
    expect(sdkDetail.upstreamDependencies?.[0]?.repoName).toBe("backend-api");
    expect(sdkDetail.upstreamDependencies?.[0]?.handoverDigest?.version).toBe(1);

    const sdkPrompt = capturedPrompts.get(sdkSub.id) ?? "";
    expect(sdkPrompt).toContain("## Upstream Dependency Contracts (Handover Digest)");
    expect(sdkPrompt).toContain("OrderPayload");
    expect(sdkPrompt).toContain("/api/orders");

    // Verify files landed on respective base branches via local_merge
    const backendOrdersFile = await readFile(join(backendDir, "src/orders.ts"), "utf8");
    expect(backendOrdersFile).toContain("OrderPayload");
    const frontendSdkFile = await readFile(join(frontendDir, "src/sdk.ts"), "utf8");
    expect(frontendSdkFile).toContain("/api/orders");
  });

  it("supports CLI --depends-on cross-repo ticket creation and propagates contract drift updates when upstream reworks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v060-drift-"));
    tempDirs.push(dir);
    const repoADir = await createGitRepo(dir, "upstream-svc");
    const repoBDir = await createGitRepo(dir, "downstream-cli");

    const stateStore = new SqliteStateStore(join(dir, "state.db"));
    const artifactStore = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));

    let upTurn = 0;
    const driver = new CustomScriptedDriver(async (input) => {
      if (input.ticketId.startsWith("tkt_")) {
        if (input.stage === "plan") {
          return {
            summary: "Plan ready for downstream CLI integration",
            changedFiles: [],
          };
        }
        upTurn += 1;
        return {
          summary: upTurn === 1 ? "Initial v1 API export" : "Updated v2 API export with pagination",
          changedFiles: ["src/api.ts"],
          writeFiles: {
            "src/api.ts":
              upTurn === 1
                ? "export function getItems(): string[] { return []; }\n"
                : "export function getItemsV2(cursor?: string): string[] { return [cursor ?? '']; }\n",
          },
        };
      }
      return { summary: "ok", changedFiles: [] };
    });

    const fakePrOutbox: OutboxExecutor = {
      async execute(_entry, _repo, ticket) {
        return {
          mode: "github_pr",
          prNumber: 77,
          prUrl: "https://github.com/org/upstream/pull/77",
          branchName: ticket.branchName,
        };
      },
    };

    const kernel = new SuperWorkKernel({
      stateStore,
      artifactStore,
      workspace,
      llm: new HeuristicControlLLM(),
      drivers: [driver],
      outboxExecutor: fakePrOutbox,
    });

    const app = createServerApp({ kernel, stateStore, artifactStore });
    const httpServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    const baseUrl = `http://127.0.0.1:${httpServer.port}`;

    try {
      await app.request("/api/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "repo_up",
          name: "upstream-svc",
          rootPath: repoADir,
          baseBranch: "main",
          githubRepo: "org/upstream",
          mode: "auto",
          defaultTemplate: "fast",
          preferredImplementEngine: "mock",
          preferredReviewEngine: "mock",
        }),
      });
      await app.request("/api/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "repo_down",
          name: "downstream-cli",
          rootPath: repoBDir,
          baseBranch: "main",
          mode: "auto",
          defaultTemplate: "strict", // pauses at awaiting_plan_approval so it stays non-terminal for drift check
          preferredImplementEngine: "mock",
          preferredReviewEngine: "mock",
        }),
      });

      const outLines: string[] = [];
      const upCode = await runCli(
        [
          "dispatch",
          "Expose items API",
          "-d",
          "Implement getItems in src/api.ts",
          "--repo",
          "repo_up",
          "--paths",
          "src/**",
          "--json",
        ],
        { baseUrl, stdout: (l) => outLines.push(l) },
      );
      expect(upCode).toBe(0);
      const tktUp = (JSON.parse(outLines.join("\n")) as { ticket: Ticket }).ticket;

      const downOut: string[] = [];
      const downCode = await runCli(
        [
          "dispatch",
          "Build CLI consumer",
          "-d",
          "Consume upstream-svc getItems",
          "--repo",
          "repo_down",
          "--depends-on",
          tktUp.id,
          "--json",
        ],
        { baseUrl, stdout: (l) => downOut.push(l) },
      );
      expect(downCode).toBe(0);
      const tktDown = (JSON.parse(downOut.join("\n")) as { ticket: Ticket }).ticket;
      expect(tktDown.status).toBe("waiting_deps");
      expect(tktDown.dependsOn).toContain(tktUp.id);

      await kernel.runUntilIdle(30);

      const upDelivered = await stateStore.getTicket(tktUp.id);
      const downPaused = await stateStore.getTicket(tktDown.id);
      expect(upDelivered?.status).toBe("delivered");
      expect(upDelivered?.handoverDigest?.version).toBe(1);
      expect(upDelivered?.handoverDigest?.exportedSymbols.join(" ")).toContain("getItems");
      expect(downPaused?.status).toBe("awaiting_plan_approval");

      // Upstream PR receives rework comment -> generates v2 HandoverDigest and pushes ThreadUpdate drift alert
      const triggerRes = await app.request("/api/triggers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: "repo_up",
          source: "github_pr",
          externalRef: "gh:org/upstream:pr:77:review:rev_2",
          threadKey: "gh:org/upstream:pr:77",
          title: "PR #77 review",
          rawText: "Rename exported function to getItemsV2(cursor)",
          payload: { prNumber: 77, branch: upDelivered?.branchName },
        }),
      });
      expect(triggerRes.status).toBe(201);

      await kernel.runUntilIdle(30);

      const upV2 = await stateStore.getTicket(tktUp.id);
      const downAfterDrift = await stateStore.getTicket(tktDown.id);
      expect(upV2?.status).toBe("delivered");
      expect(upV2?.handoverDigest?.version).toBe(2);
      expect(upV2?.handoverDigest?.exportedSymbols.join(" ")).toContain("getItemsV2");
      expect(
        downAfterDrift?.inlineMemory.threadUpdates.some((u) =>
          u.message.includes("[Upstream Contract Updated v2"),
        ),
      ).toBe(true);
      expect(downAfterDrift?.inlineMemory.activeHint).toContain("Upstream Contract Updated v2");
    } finally {
      httpServer.stop(true);
    }
  });

  it("enforces ephemeral runtime smokeCheck (short-circuit on static fail, port release on crash/pass, self-heal & Playbook rule)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v060-smoke-"));
    tempDirs.push(dir);
    const repoDir = await createGitRepo(dir, "smoke-app");

    const stateStore = new SqliteStateStore(join(dir, "state.db"));
    const artifactStore = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));

    await writeFile(
      join(repoDir, "super-work.json"),
      JSON.stringify(
        {
          version: 1,
          defaultTemplate: "fast",
          verificationCommands: ["bun -e \"console.log('static verification passed')\""],
          smokeCheck: {
            enabled: true,
            startCommand: "bun run src/server.js",
            readyUrl: "http://127.0.0.1:$PORT/health",
            startupTimeoutSec: 5,
            checkCommands: [
              "bun -e \"const r = await fetch(process.env.SUPER_WORK_SMOKE_URL + '/ping'); if (!r.ok) process.exit(1);\"",
            ],
            triggerMode: "every_gate",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    let attempt = 0;
    const driver = new CustomScriptedDriver(async (input) => {
      if (input.stage !== "implement") {
        return { summary: "ok", changedFiles: [] };
      }
      attempt += 1;
      const sawBootErr = (input.prompt ?? "").includes("BOOT_ERR_MISSING_PORT");
      if (attempt === 1 && !sawBootErr) {
        return {
          summary: "Wrote initial server entrypoint",
          changedFiles: ["src/server.js"],
          writeFiles: {
            "src/server.js": [
              'console.error("BOOT_ERR_MISSING_PORT: process failed during startup");',
              "process.exit(1);",
              "",
            ].join("\n"),
          },
        };
      }

      return {
        summary: "Fixed src/server.js to bind process.env.PORT and serve /health and /ping",
        changedFiles: ["src/server.js"],
        writeFiles: {
          "src/server.js": [
            "const port = Number(process.env.PORT || 0);",
            "Bun.serve({",
            "  port,",
            '  hostname: "127.0.0.1",',
            "  fetch(req) {",
            "    const url = new URL(req.url);",
            '    if (url.pathname === "/health") return new Response("ok", { status: 200 });',
            '    if (url.pathname === "/ping") return new Response("pong", { status: 200 });',
            '    return new Response("not found", { status: 404 });',
            "  },",
            "});",
            'console.log("smoke-app listening on " + port);',
            "",
          ].join("\n"),
        },
      };
    });

    const kernel = new SuperWorkKernel({
      stateStore,
      artifactStore,
      workspace,
      llm: new HeuristicControlLLM(),
      drivers: [driver],
      outboxExecutor: new GhOutboxExecutor(workspace),
    });

    const recordedSmokePorts: number[] = [];
    const verificationEvents: Array<{ ok: boolean; smokePort?: number; failedStep?: string }> = [];
    kernel.subscribe((ev: KernelEvent) => {
      if (ev.type === "verification_completed") {
        const sr = ev.result.smokeResult;
        if (sr?.port) recordedSmokePorts.push(sr.port);
        verificationEvents.push({
          ok: ev.result.ok,
          smokePort: sr?.port,
          failedStep: sr?.failedStep,
        });
      }
    });

    const app = createServerApp({ kernel, stateStore, artifactStore });

    const regRes = await app.request("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "repo_smoke",
        name: "smoke-app",
        rootPath: repoDir,
        baseBranch: "main",
        mode: "auto",
        defaultTemplate: "standard",
        preferredImplementEngine: "mock",
        preferredReviewEngine: "mock",
        defaultDeliveryChannel: "local_merge",
      }),
    });
    expect(regRes.status).toBe(201);
    const regBody = (await regRes.json()) as { repo: { smokeCheck?: { enabled: boolean; triggerMode?: string } } };
    expect(regBody.repo.smokeCheck?.enabled).toBe(true);
    expect(regBody.repo.smokeCheck?.triggerMode).toBe("every_gate");

    const tktRes = await app.request("/api/tickets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoId: "repo_smoke",
        title: "Add smoke-verified HTTP server",
        description: "Implement src/server.js exposing /health and /ping on process.env.PORT",
        allowedPaths: ["src/**"],
      }),
    });
    expect(tktRes.status).toBe(201);
    const { ticket } = (await tktRes.json()) as { ticket: Ticket };

    await kernel.runUntilIdle(30);

    const detailRes = await app.request(`/api/tickets/${ticket.id}`);
    const detail = (await detailRes.json()) as {
      ticket: Ticket;
      artifacts: Array<{ kind: string; summary: string }>;
    };
    expect(detail.ticket.status).toBe("delivered");

    // Attempt 1 failed smoke early -> Attempt 2 self-healed implement + rebase passed
    expect(verificationEvents.some((v) => !v.ok && v.failedStep === "smoke:server_exited_early")).toBe(
      true,
    );
    expect(verificationEvents.some((v) => v.ok && Boolean(v.smokePort))).toBe(true);

    const smokeLogs = detail.artifacts.filter((a) => a.kind === "smoke_log");
    expect(smokeLogs.some((a) => a.summary.startsWith("FAIL"))).toBe(true);
    expect(smokeLogs.some((a) => a.summary.startsWith("PASS"))).toBe(true);

    // Every ephemeral smoke port must have zero listening server processes remaining after gate teardown
    for (const port of recordedSmokePorts) {
      let reachable = false;
      try {
        await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(400) });
        reachable = true;
      } catch {
        reachable = false;
      }
      expect(reachable).toBe(false);
    }

    // Closed-loop self-healing must distill a Playbook rule for smoke failure
    const playbookEntries = await stateStore.listPlaybookEntries("repo_smoke");
    expect(
      playbookEntries.some(
        (e) =>
          e.source === "auto_healed" &&
          e.rule.includes("Prevent runtime startup/smoke failure"),
      ),
    ).toBe(true);

    // Verify short-circuit: when static verificationCommands fails, smokeCheck must NOT boot!
    await writeFile(
      join(repoDir, "super-work.json"),
      JSON.stringify(
        {
          version: 1,
          defaultTemplate: "fast",
          verificationCommands: ["false"],
          smokeCheck: {
            enabled: true,
            startCommand: "bun run src/server.js",
            readyUrl: "http://127.0.0.1:$PORT/health",
            startupTimeoutSec: 5,
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await app.request("/api/repos/repo_smoke/contract/sync", { method: "POST" });

    const shortTkt = await kernel.createDirectTicket({
      repoId: "repo_smoke",
      title: "Short circuit check",
      description: "Static failure should skip smoke",
      allowedPaths: ["src/**"],
      maxDurationSec: 30,
    });
    const stalledShort = { ...shortTkt, mandate: { ...shortTkt.mandate, maxStageRetries: 0 } };
    await stateStore.saveTicket(stalledShort);

    await kernel.runUntilIdle(10);
    const shortArtifacts = await stateStore.listArtifacts(shortTkt.id);
    expect(shortArtifacts.some((a) => a.kind === "test_log" && a.summary.startsWith("FAIL"))).toBe(
      true,
    );
    expect(shortArtifacts.some((a) => a.kind === "smoke_log")).toBe(false);
    await kernel.cancelTicket(shortTkt.id, "cleanup short-circuit fixture");

    // Verify triggerMode: "delivery_only" skips smoke during implement and enforces it at rebase/delivery
    await writeFile(
      join(repoDir, "super-work.json"),
      JSON.stringify(
        {
          version: 1,
          defaultTemplate: "standard",
          verificationCommands: ["bun -e \"console.log('static ok')\""],
          smokeCheck: {
            enabled: true,
            startCommand: "bun run src/server.js",
            readyUrl: "http://127.0.0.1:$PORT/health",
            startupTimeoutSec: 5,
            triggerMode: "delivery_only",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await app.request("/api/repos/repo_smoke/contract/sync", { method: "POST" });

    const deliveryOnlyTkt = await kernel.createDirectTicket({
      repoId: "repo_smoke",
      title: "Delivery-only smoke gate",
      description: "BOOT_ERR_MISSING_PORT handled: write working server",
      template: "standard",
      allowedPaths: ["src/**"],
    });
    await kernel.runUntilIdle(20);
    const delDetailRes = await app.request(`/api/tickets/${deliveryOnlyTkt.id}`);
    const delDetail = (await delDetailRes.json()) as {
      ticket: Ticket;
      stageRuns: Array<{ id: string; stage: string }>;
      artifacts: Array<{ kind: string; stageRunId?: string; summary: string }>;
    };
    expect(delDetail.ticket.status).toBe("delivered");
    const implRunIds = new Set(delDetail.stageRuns.filter((r) => r.stage === "implement").map((r) => r.id));
    const rebaseRunIds = new Set(delDetail.stageRuns.filter((r) => r.stage === "rebase").map((r) => r.id));
    const delSmokeLogs = delDetail.artifacts.filter((a) => a.kind === "smoke_log");
    expect(delSmokeLogs).toHaveLength(1);
    expect(delSmokeLogs[0]!.summary.startsWith("PASS")).toBe(true);
    expect(implRunIds.has(delSmokeLogs[0]!.stageRunId ?? "")).toBe(false);
    expect(rebaseRunIds.has(delSmokeLogs[0]!.stageRunId ?? "")).toBe(true);
  });
});
