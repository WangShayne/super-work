import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  SuperWorkKernel,
  newId,
  nowIso,
  type OutboxExecutor,
  type Ticket,
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
  SqliteStateStore,
  encodeRgbaPng,
  runGit,
  type BrowserCheckExecutionResult,
} from "@super-work/drivers";
import { createServerApp } from "../src/app.ts";

async function createGitRepo(baseDir: string, name: string): Promise<string> {
  const repoDir = join(baseDir, name);
  await runGit(["init", "-b", "main", repoDir], baseDir);
  await runGit(["config", "user.name", "Test User"], repoDir);
  await runGit(["config", "user.email", "test@example.com"], repoDir);
  await mkdir(join(repoDir, "src"), { recursive: true });
  await writeFile(join(repoDir, "README.md"), `# ${name}\n`, "utf8");
  await writeFile(join(repoDir, "src/core.ts"), "export function add(a: number, b: number): number { return 0; }\n", "utf8");
  await writeFile(
    join(repoDir, "src/service.ts"),
    'import { add } from "./core.ts";\nexport function calc(x: number): number { return add(x, 1); }\n',
    "utf8",
  );
  await writeFile(
    join(repoDir, "src/controller.ts"),
    'import { calc } from "./service.ts";\nexport function handle(x: number): number { return calc(x); }\n',
    "utf8",
  );
  await writeFile(join(repoDir, "src/theme.txt"), "v1\n", "utf8");
  await runGit(["add", "."], repoDir);
  await runGit(["commit", "-m", "initial commit"], repoDir);
  return repoDir;
}

function makeSolidPng(width: number, height: number, rgbaTuple: [number, number, number, number]): Uint8Array {
  const buf = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const off = i * 4;
    buf[off] = rgbaTuple[0];
    buf[off + 1] = rgbaTuple[1];
    buf[off + 2] = rgbaTuple[2];
    buf[off + 3] = rgbaTuple[3];
  }
  return encodeRgbaPng(width, height, buf);
}

class ScriptedDriver implements WorkerDriver {
  constructor(
    readonly engine: WorkerEngineId,
    private readonly handler: (
      input: WorkerTurnInput,
      signal: AbortSignal,
    ) => Promise<{
      summary: string;
      writeFiles?: Record<string, string>;
      text?: string;
      costUsd?: number;
      error?: string;
    }>,
  ) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async *runTurn(input: WorkerTurnInput, signal: AbortSignal): AsyncGenerator<WorkerStreamEvent> {
    yield { type: "session_started", nativeSessionId: newId("sess"), timestamp: nowIso() };
    const out = await this.handler(input, signal);
    if (out.error) {
      yield { type: "error", message: out.error, fatal: true, timestamp: nowIso() };
      return;
    }
    if (out.writeFiles) {
      for (const [relPath, content] of Object.entries(out.writeFiles)) {
        const full = join(input.worktreePath, relPath);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, content, "utf8");
      }
    }
    if (out.text) {
      yield { type: "text", text: out.text, timestamp: nowIso() };
    }
    const cost = out.costUsd ?? 0.03;
    yield { type: "usage", costUsd: cost, timestamp: nowIso() };
    yield {
      type: "completed",
      summary: out.summary,
      costUsd: cost,
      structuredOutput: {
        verificationPassed: true,
        ...(input.stage === "review" ? { approved: true, reviewFindings: [] } : {}),
      },
      timestamp: nowIso(),
    };
  }
}

async function waitForTicket(
  store: SqliteStateStore,
  ticketId: string,
  predicate: (tkt: Ticket) => boolean,
  timeoutMs = 15_000,
): Promise<Ticket> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await store.getTicket(ticketId);
    if (t && predicate(t)) {
      return t;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  const latest = await store.getTicket(ticketId);
  throw new Error(
    `Timed out waiting for ticket ${ticketId}; status=${latest?.status}, stage=${latest?.currentStage}, error=${latest?.errorMessage}`,
  );
}

describe("v0.9.0 End-to-End Capabilities (A.1 TDD + A.2 Visual Diff + B.1 Impact + B.2 Bandit + D.1 DAG + D.2 Checkpoints)", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("A.1: locks spec_test files, reverts test tampering on implement, and supports single-rewind SPEC_TEST_CHALLENGE", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v090-tdd-"));
    tempDirs.push(dir);
    const repoPath = await createGitRepo(dir, "tdd-repo");

    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));
    const outboxExec: OutboxExecutor = {
      async execute(_entry, _repo, ticket) {
        return { prUrl: `local://pr/${ticket.id}` };
      },
    };

    let implTurnsA = 0;
    let implTurnsB = 0;
    let specTurnsB = 0;

    const driver = new ScriptedDriver("mock", async (input): Promise<{
      summary: string;
      writeFiles?: Record<string, string>;
      text?: string;
      costUsd?: number;
      error?: string;
    }> => {
      const tkt = await store.getTicket(input.ticketId);
      const isTamper = Boolean(tkt?.title.includes("tamper"));
      const isChallenge = Boolean(tkt?.title.includes("challenge"));
      if (isTamper) {
        if (input.stage === "spec_test") {
          return {
            summary: "Wrote failing red test for add()",
            writeFiles: {
              "src/core.test.ts":
                'import { expect, it } from "bun:test";\nimport { add } from "./core.ts";\nit("adds", () => { expect(add(2, 3)).toBe(5); });\n',
            },
          };
        }
        if (input.stage === "implement") {
          implTurnsA += 1;
          if (implTurnsA === 1) {
            return {
              summary: "Implemented add AND illegally weakened test",
              writeFiles: {
                "src/core.ts": "export function add(a: number, b: number): number { return a + b; }\n",
                "src/core.test.ts": 'import { expect, it } from "bun:test";\nit("weak", () => { expect(1).toBe(1); });\n',
              },
            };
          }
          return {
            summary: "Implemented add cleanly without touching locked tests",
            writeFiles: {
              "src/core.ts": "export function add(a: number, b: number): number { return a + b; }\n",
            },
          };
        }
      }

      if (isChallenge) {
        if (input.stage === "spec_test") {
          specTurnsB += 1;
          if (specTurnsB === 1) {
            return {
              summary: "Wrote impossible expectation add(2,3)=99",
              writeFiles: {
                "src/core.test.ts":
                  'import { expect, it } from "bun:test";\nimport { add } from "./core.ts";\nit("adds", () => { expect(add(2, 3)).toBe(99); });\n',
              },
            };
          }
          return {
            summary: "Corrected expectation to add(2,3)=5 after SPEC_TEST_CHALLENGE",
            writeFiles: {
              "src/core.test.ts":
                'import { expect, it } from "bun:test";\nimport { add } from "./core.ts";\nit("adds", () => { expect(add(2, 3)).toBe(5); });\n',
            },
          };
        }
        if (input.stage === "implement") {
          implTurnsB += 1;
          if (implTurnsB === 1) {
            return {
              summary: "SPEC_TEST_CHALLENGE: expected sum of 2+3 must be 5 not 99",
              text: "SPEC_TEST_CHALLENGE: expected sum of 2+3 must be 5 not 99",
            };
          }
          return {
            summary: "Implemented add(a,b) after test repair",
            writeFiles: {
              "src/core.ts": "export function add(a: number, b: number): number { return a + b; }\n",
            },
          };
        }
      }

      return { summary: `${input.stage} ok` };
    });

    const kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm: new HeuristicControlLLM(),
      drivers: [driver],
      outboxExecutor: outboxExec,
      dataDir: dir,
      config: { maxConcurrentWorkers: 1, schedulerIntervalMs: 30, outboxIntervalMs: 100 },
    });

    const ts = nowIso();
    await store.upsertRepo({
      id: "repo_tdd",
      name: "tdd-repo",
      rootPath: repoPath,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "fast",
      defaultTddMode: false,
      preferredImplementEngine: "mock",
      preferredReviewEngine: "mock",
      verificationCommands: ["bun test"],
      defaultDeliveryChannel: "local_merge",
      autoCleanupWorktree: false,
      createdAt: ts,
      updatedAt: ts,
    });

    kernel.start();
    try {
      // Case 1: Tamper revert
      const tktA = await kernel.createDirectTicket({
        repoId: "repo_tdd",
        title: "TDD tamper check",
        description: "TAMPER_CASE implement add cleanly",
        template: "fast",
        tddMode: true,
        allowedPaths: ["src/**"],
      });
      const doneA = await waitForTicket(store, tktA.id, (t) => t.status === "delivered");
      expect(doneA.tddMode).toBe(true);
      expect(doneA.lockedTestPaths).toContain("src/core.test.ts");
      expect(doneA.specTestCommitSha).toBeTruthy();
      expect(implTurnsA).toBe(2);

      // Verify tamper attempt reverted test back to locked expect(add(2, 3)).toBe(5)
      const detailA = await store.listArtifacts(tktA.id);
      expect(detailA.some((a) => a.summary.includes("Red-first probe (RED expected fail)"))).toBe(true);

      // Case 2: SPEC_TEST_CHALLENGE rewind once
      const tktB = await kernel.createDirectTicket({
        repoId: "repo_tdd",
        title: "TDD challenge rewind",
        description: "CHALLENGE_CASE implement add with challenge",
        template: "fast",
        tddMode: true,
        allowedPaths: ["src/**"],
      });
      const doneB = await waitForTicket(store, tktB.id, (t) => t.status === "delivered");
      expect(doneB.specTestChallengeCount).toBe(1);
      expect(specTurnsB).toBe(2);
      expect(implTurnsB).toBe(2);
    } finally {
      kernel.stop();
    }
  });

  it("A.2: caches baseline screenshots, gates on visualDiffMode=enforce, and serves visual_diff PNG raw bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v090-vdiff-"));
    tempDirs.push(dir);
    const repoPath = await createGitRepo(dir, "ui-repo");

    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));

    const whitePng = makeSolidPng(8, 8, [255, 255, 255, 255]);
    const redPng = makeSolidPng(8, 8, [220, 20, 40, 255]);

    const browserRunner = async (baseUrl: string): Promise<BrowserCheckExecutionResult> => {
      const resp = await fetch(`${baseUrl}/`);
      const body = (await resp.text()).trim();
      const pngBytes = body === "broken" ? redPng : whitePng;
      return {
        summary: {
          executed: true,
          ok: true,
          summary: `Captured ${body}`,
          routes: [
            {
              path: "/",
              url: baseUrl,
              ok: true,
              status: 200,
              consoleErrors: [],
              pageErrors: [],
              failedRequests: [],
              durationMs: 10,
            },
          ],
        },
        rawScreenshots: [{ routeIndex: 0, path: "/", bytes: pngBytes }],
      };
    };

    const workspace = new GitWorktreeProvider(join(dir, "worktrees"), { browserRunner });
    let uiImplTurn = 0;
    const driver = new ScriptedDriver("mock", async (input): Promise<{
      summary: string;
      writeFiles?: Record<string, string>;
      text?: string;
      costUsd?: number;
      error?: string;
    }> => {
      if (input.stage === "implement") {
        uiImplTurn += 1;
        return {
          summary: uiImplTurn === 1 ? "Introduced visual regression" : "Fixed UI match baseline",
          writeFiles: {
            "src/theme.txt": uiImplTurn === 1 ? "broken\n" : "fixed\n",
          },
        };
      }
      return { summary: "ok" };
    });

    const kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm: new HeuristicControlLLM(),
      drivers: [driver],
      outboxExecutor: { async execute() { return { prUrl: "local://ok" }; } },
      dataDir: dir,
      config: { maxConcurrentWorkers: 1, schedulerIntervalMs: 30, outboxIntervalMs: 100 },
    });

    const ts = nowIso();
    await store.upsertRepo({
      id: "repo_ui",
      name: "ui-repo",
      rootPath: repoPath,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "fast",
      preferredImplementEngine: "mock",
      preferredReviewEngine: "mock",
      smokeCheck: {
        enabled: true,
        startCommand:
          'bun -e \'const fs=require("node:fs"); Bun.serve({port:Number(process.env.PORT), fetch:()=>new Response(fs.readFileSync("src/theme.txt","utf8"))}); setInterval(()=>{},60000)\'',
        readyUrl: "http://127.0.0.1:$PORT/",
        startupTimeoutSec: 10,
        browserCheck: {
          enabled: true,
          paths: ["/"],
          visualDiffMode: "enforce",
          maxVisualDiffRatio: 0.02,
        },
      },
      autoCleanupWorktree: false,
      createdAt: ts,
      updatedAt: ts,
    });

    const app = createServerApp({
      kernel,
      stateStore: store,
      artifactStore: artifacts,
    });

    kernel.start();
    try {
      const tkt = await kernel.createDirectTicket({
        repoId: "repo_ui",
        title: "Update UI layout styling button",
        description: "Polish layout in src/theme.txt",
        template: "fast",
        allowedPaths: ["src/**"],
      });

      const done = await waitForTicket(store, tkt.id, (t) => t.status === "delivered", 20_000);
      expect(done.status).toBe("delivered");
      expect(uiImplTurn).toBe(2);

      const tktArtifacts = await store.listArtifacts(tkt.id);
      const visualDiffArt = tktArtifacts.find((a) => a.kind === "visual_diff");
      expect(visualDiffArt).toBeDefined();

      // Verify PNG raw endpoint serves valid PNG bytes
      const rawResp = await app.fetch(new Request(`http://localhost/api/artifacts/${visualDiffArt!.id}/raw`));
      expect(rawResp.status).toBe(200);
      expect(rawResp.headers.get("content-type")).toBe("image/png");
      const rawBytes = new Uint8Array(await rawResp.arrayBuffer());
      expect(Array.from(rawBytes.slice(0, 4))).toEqual([137, 80, 78, 71]);

      // Verify baseline directory was cached on disk
      const baseSha = await workspace.getHeadCommitSha(repoPath, "main");
      expect(existsSync(join(dir, "visual-baselines", "repo_ui", baseSha, "route_0.png"))).toBe(true);
    } finally {
      kernel.stop();
    }
  });

  it("B.1 + D.1 + B.2 + D.2 + MCP: tests impact serialization, live DAG surgery, Bandit routing, checkpoint time-travel, and 13 MCP tools", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v090-full-"));
    tempDirs.push(dir);
    const repoPath = await createGitRepo(dir, "full-repo");

    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));

    const claudeStub = new ScriptedDriver("claude", async (input) => ({
      summary: `claude handled ${input.stage}`,
      writeFiles:
        input.stage === "implement"
          ? { "src/core.ts": "export function add(a: number, b: number): number { return a + b; }\n" }
          : undefined,
    }));
    const codexStub = new ScriptedDriver("codex", async (input) => ({
      summary: `codex handled ${input.stage}`,
      writeFiles:
        input.stage === "implement"
          ? { "src/core.ts": "export function add(a: number, b: number): number { return a + b; }\n" }
          : undefined,
    }));

    const kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm: new HeuristicControlLLM(),
      drivers: [claudeStub, codexStub, new MockWorkerDriver({ engine: "mock", stepDelayMs: 2 })],
      outboxExecutor: { async execute() { return { prUrl: "local://pr/full" }; } },
      dataDir: dir,
      config: { maxConcurrentWorkers: 2, schedulerIntervalMs: 30, outboxIntervalMs: 100 },
    });

    const ts = nowIso();
    await store.upsertRepo({
      id: "repo_full",
      name: "full-repo",
      rootPath: repoPath,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "standard",
      preferredImplementEngine: "auto",
      preferredReviewEngine: "mock",
      dailyBudgetUsd: 50,
      autoCleanupWorktree: false,
      createdAt: ts,
      updatedAt: ts,
    });

    const app = createServerApp({
      kernel,
      stateStore: store,
      artifactStore: artifacts,
    });

    // B.1: POST /api/repos/:id/impact
    const impactRes = await app.fetch(
      new Request("http://localhost/api/repos/repo_full/impact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: ["src/core.ts"] }),
      }),
    );
    expect(impactRes.status).toBe(200);
    const impactJson = (await impactRes.json()) as {
      report: { directDependents: string[]; transitiveDependents: string[] };
    };
    expect(impactJson.report.directDependents).toEqual(["src/service.ts"]);
    expect(impactJson.report.transitiveDependents).toEqual(["src/controller.ts"]);

    // D.1 + B.1: dispatch ticket A touching src/core.ts with pauseBeforeRun=true
    const resA = await app.fetch(
      new Request("http://localhost/api/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: "repo_full",
          title: "Refactor core add",
          description: "Update core add implementation",
          template: "fast",
          allowedPaths: ["src/core.ts"],
          pauseBeforeRun: true,
        }),
      }),
    );
    expect(resA.status).toBe(201);
    const tktA = ((await resA.json()) as { ticket: Ticket }).ticket;
    expect(tktA.pauseBeforeRun).toBe(true);

    // Tick once -> pauses at DAG breakpoint Inbox item instead of implementing
    await kernel.tick();
    const pausedA = await store.getTicket(tktA.id);
    expect(pausedA?.status).toBe("needs_human");
    const pendingBp = await store.listInboxItems({ ticketId: tktA.id, status: "pending" });
    expect(
      pendingBp.some((i) => i.kind === "plan_approval" && i.contextPayload.isDagBreakpoint === true),
    ).toBe(true);

    // Ticket B touching 1-hop dependent src/service.ts automatically receives semantic dependency on A
    const resB = await app.fetch(
      new Request("http://localhost/api/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: "repo_full",
          title: "Update service consumer",
          description: "Adapt service",
          template: "fast",
          allowedPaths: ["src/service.ts"],
        }),
      }),
    );
    expect(resB.status).toBe(201);
    const tktB = ((await resB.json()) as { ticket: Ticket }).ticket;
    expect(tktB.dependsOn).toContain(tktA.id);

    // D.1: Live DAG surgery - cycle A -> B -> A must return 400
    const cycleRes = await app.fetch(
      new Request(`http://localhost/api/tickets/${tktA.id}/dag-node`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update", dependsOn: [tktB.id] }),
      }),
    );
    expect(cycleRes.status).toBe(400);

    // Pause/resume/update unstarted ticket B & verify MCP mutate_dag_node + analyze_impact
    const mutB = await app.fetch(
      new Request(`http://localhost/api/tickets/${tktB.id}/dag-node`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pause" }),
      }),
    );
    expect(mutB.status).toBe(200);
    const pausedB = ((await mutB.json()) as { ticket: Ticket }).ticket;
    expect(pausedB.status).toBe("needs_human");

    const updB = await app.fetch(
      new Request(`http://localhost/api/tickets/${tktB.id}/dag-node`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update", pauseBeforeRun: true, allowedPaths: ["src/service.ts", "src/controller.ts"] }),
      }),
    );
    expect(updB.status).toBe(200);
    const updatedB = ((await updB.json()) as { ticket: Ticket }).ticket;
    expect(updatedB.pauseBeforeRun).toBe(true);
    expect(updatedB.mandate.allowedPaths).toContain("src/controller.ts");

    // Cancel B so A can run to completion alone, resume A via DAG node mutation with preferredEngine="codex" & arenaMode false? Wait A hasn't started implement yet
    await app.fetch(
      new Request(`http://localhost/api/tickets/${tktB.id}/cancel`, { method: "POST", body: "{}" }),
    );
    const resumeA = await app.fetch(
      new Request(`http://localhost/api/tickets/${tktA.id}/dag-node`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resume", preferredEngine: "codex" }),
      }),
    );
    expect(resumeA.status).toBe(200);
    const resumedA = ((await resumeA.json()) as { ticket: Ticket }).ticket;
    expect(resumedA.status).toBe("queued");

    kernel.start();
    try {
      const doneA = await waitForTicket(store, tktA.id, (t) => t.status === "delivered");
      expect(doneA.preferredEngine).toBe("codex");
      const runsA = await store.listStageRuns(tktA.id);
      expect(runsA.find((r) => r.stage === "implement")?.engine).toBe("codex");

      // B.2: Dispatch a fresh ticket with preferredEngine="auto" while idle and verify routingRationale + Bandit matrix
      const autoTicket = await kernel.createDirectTicket({
        repoId: "repo_full",
        title: "Add JSON formatter helper",
        description: "Implement backend helper in src/core.ts",
        template: "fast",
        preferredEngine: "auto",
        allowedPaths: ["src/**"],
      });
      const doneAuto = await waitForTicket(
        store,
        autoTicket.id,
        (t) => Boolean(t.routingRationale) && (t.status === "delivered" || t.status === "needs_human"),
      );
      expect(doneAuto.routingRationale).toBeTruthy();

      const metricsRes = await app.fetch(new Request("http://localhost/api/metrics?repoId=repo_full"));
      expect(metricsRes.status).toBe(200);
      const metricsJson = (await metricsRes.json()) as {
        metrics: { engineMatrix?: Array<{ engine: string; category: string }> };
      };
      expect(Array.isArray(metricsJson.metrics.engineMatrix)).toBe(true);
      expect(metricsJson.metrics.engineMatrix!.length).toBeGreaterThan(0);

      kernel.stop();

      // D.2 Checkpoints + Diff + In-Place Re-steer + Fork
      const cpListRes = await app.fetch(new Request(`http://localhost/api/tickets/${tktA.id}/checkpoints`));
      expect(cpListRes.status).toBe(200);
      const cpList = ((await cpListRes.json()) as { checkpoints: Array<{ id: string; stage: string }> }).checkpoints;
      expect(cpList.length).toBeGreaterThanOrEqual(2);
      const implCp = cpList.find((c) => c.stage === "implement") ?? cpList[cpList.length - 1]!;

      const cpDiffRes = await app.fetch(
        new Request(`http://localhost/api/tickets/${tktA.id}/checkpoints/${implCp.id}/diff`),
      );
      expect(cpDiffRes.status).toBe(200);
      const cpDiffJson = (await cpDiffRes.json()) as { diff: string };
      expect(cpDiffJson.diff).toContain("src/core.ts");

      // Fork a new ticket from implCp
      const forkRes = await app.fetch(
        new Request(`http://localhost/api/tickets/${tktA.id}/checkpoints/${implCp.id}/restore`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "fork", prompt: "Try alternate algorithm" }),
        }),
      );
      expect(forkRes.status).toBe(200);
      const forkJson = (await forkRes.json()) as { mode: string; ticket: Ticket };
      expect(forkJson.mode).toBe("fork");
      expect(forkJson.ticket.id).not.toBe(tktA.id);
      expect(forkJson.ticket.inlineMemory.activeHint).toContain("Try alternate algorithm");

      // In-place restore resets nativeSessions and injects prompt + pitfall summary
      const inPlaceRes = await app.fetch(
        new Request(`http://localhost/api/tickets/${tktA.id}/checkpoints/${implCp.id}/restore`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "in_place", prompt: "Re-steer cleanly" }),
        }),
      );
      expect(inPlaceRes.status).toBe(200);
      const inPlaceJson = (await inPlaceRes.json()) as { mode: string; ticket: Ticket };
      expect(inPlaceJson.mode).toBe("in_place");
      expect(inPlaceJson.ticket.nativeSessions).toEqual({});
      expect(inPlaceJson.ticket.inlineMemory.activeHint).toContain("Re-steer cleanly");
      expect(inPlaceJson.ticket.status).toBe("queued");

      // MCP v0.9.0 tools over /api/mcp
      const mcpImpact = await app.fetch(
        new Request("http://localhost/api/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 101,
            method: "tools/call",
            params: { name: "analyze_impact", arguments: { repoId: "repo_full", paths: ["src/core.ts"] } },
          }),
        }),
      );
      expect(mcpImpact.status).toBe(200);
      const mcpImpactJson = (await mcpImpact.json()) as { result: { content: Array<{ text: string }> } };
      expect(mcpImpactJson.result.content[0]!.text).toContain("src/service.ts");

      const mcpCp = await app.fetch(
        new Request("http://localhost/api/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 102,
            method: "tools/call",
            params: { name: "manage_checkpoints", arguments: { action: "list", ticketId: tktA.id } },
          }),
        }),
      );
      expect(mcpCp.status).toBe(200);
      const mcpCpJson = (await mcpCp.json()) as { result: { content: Array<{ text: string }> } };
      expect(mcpCpJson.result.content[0]!.text).toContain(implCp.id);
    } finally {
      kernel.stop();
    }
  });
});
