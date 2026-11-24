import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  SuperWorkKernel,
  newId,
  nowIso,
  type OutboxExecutor,
  type RepoConfig,
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
    "export function verifyToken(tok: string): boolean {\n  return tok.length > 0;\n}\n",
    "utf8",
  );
  await writeFile(
    join(repoDir, "src/shared.ts"),
    "export const sharedValue = 1;\nexport const mode = 'base';\n",
    "utf8",
  );
  await runGit(["add", "."], repoDir);
  await runGit(["commit", "-m", "initial commit"], repoDir);
  return repoDir;
}

class ScriptedWorkerDriver implements WorkerDriver {
  constructor(
    readonly engine: WorkerEngineId,
    private readonly handler: (input: WorkerTurnInput) => Promise<{
      summary: string;
      writeFiles?: Record<string, string>;
      structuredOutput?: NonNullable<Extract<WorkerStreamEvent, { type: "completed" }>["structuredOutput"]>;
    }>,
  ) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async *runTurn(input: WorkerTurnInput): AsyncGenerator<WorkerStreamEvent> {
    yield { type: "session_started", nativeSessionId: newId("sess"), timestamp: nowIso() };
    const result = await this.handler(input);
    if (result.writeFiles) {
      for (const [relPath, content] of Object.entries(result.writeFiles)) {
        const full = join(input.worktreePath, relPath);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, content, "utf8");
      }
    }
    yield { type: "usage", costUsd: 0.02, timestamp: nowIso() };
    yield {
      type: "completed",
      summary: result.summary,
      costUsd: 0.02,
      structuredOutput: result.structuredOutput ?? { verificationPassed: true },
      timestamp: nowIso(),
    };
  }
}

describe("v1.0.0 End-to-End Capabilities (A.1 Risk Gate + B.1 Review Studio + B.2 3-Way Conflict + C.1 Spans/Doctor/Backup + D.1 Blueprints)", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const d of tempDirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("D.1 + A.1 + B.1 + C.1: executes Blueprint dispatch, Risk Gate signoff, Line Review rework auto-resolve, StageSpans, Doctor/Backup APIs, CLI & MCP", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v100-e2e-"));
    tempDirs.push(dir);
    const repoPath = await createGitRepo(dir, "v100-app");

    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));

    let implementAttempts = 0;
    const claudeDriver = new ScriptedWorkerDriver("claude", async (input) => {
      if (input.stage === "plan") {
        return {
          summary: "Planned token hardening",
          structuredOutput: { planSummary: "Harden verifyToken prefix check" },
        };
      }
      if (input.stage === "spec_test") {
        const writeFiles: Record<string, string> = {
          "test/token.test.ts": [
            `import { expect, test } from "bun:test";`,
            `import { verifyToken } from "../src/auth/token.ts";`,
            `test("requires tok_ prefix", () => {`,
            `  expect(verifyToken("tok_valid")).toBe(true);`,
            `  expect(verifyToken("bad")).toBe(false);`,
            `});`,
          ].join("\n"),
        };
        return {
          summary: "Added failing spec test for strict prefix check",
          writeFiles,
          structuredOutput: { verificationPassed: false },
        };
      }
      implementAttempts += 1;
      const body =
        implementAttempts === 1
          ? "export function verifyToken(tok: string): boolean {\n  return tok.startsWith('tok_');\n}\n"
          : "export function verifyToken(tok: string): boolean {\n  return tok.startsWith('tok_') && tok.length >= 6;\n}\n";
      const writeFiles: Record<string, string> = { "src/auth/token.ts": body };
      return {
        summary: `Implemented token hardening (#${implementAttempts})`,
        writeFiles,
        structuredOutput: { verificationPassed: true },
      };
    });

    const codexDriver = new ScriptedWorkerDriver("codex", async () => ({
      summary:
        implementAttempts === 1
          ? "Review completed cleanly with 1 advisory nit"
          : "Re-review clean with 0 findings",
      structuredOutput: {
        approved: true,
        reviewFindings:
          implementAttempts === 1
            ? [
                {
                  severity: "nit",
                  file: "src/auth/token.ts",
                  line: 1,
                  message: "Document expected token length contract",
                },
              ]
            : [],
      },
    }));

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
      config: { maxConcurrentWorkers: 2 },
    });

    await store.upsertRepo({
      id: "repo_main",
      name: "v100-app",
      rootPath: repoPath,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "standard",
      deliveryGatePolicy: "risk_gated",
      riskThreshold: 10,
      sensitivePaths: ["src/auth/**"],
      verificationCommands: ["bun test test/token.test.ts"],
      preferredImplementEngine: "claude",
      preferredReviewEngine: "codex",
      autoCleanupWorktree: false,
      defaultDeliveryChannel: "local_merge",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });

    const app = createServerApp({
      kernel,
      stateStore: store,
      artifactStore: artifacts,
    });
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      // 1. Verify Blueprints endpoint & CLI
      const bpRes = await fetch(`${baseUrl}/api/repos/repo_main/blueprints`);
      expect(bpRes.status).toBe(200);
      const bpJson = (await bpRes.json()) as { blueprints: Array<{ id: string }> };
      expect(bpJson.blueprints.length).toBe(5);
      expect(bpJson.blueprints.some((b) => b.id === "backend-feature")).toBe(true);

      const cliBpLines: string[] = [];
      expect(
        await runCli(["blueprints", "--repo", "repo_main", "--json"], {
          baseUrl,
          stdout: (l) => cliBpLines.push(l),
          stderr: () => {},
        }),
      ).toBe(0);
      expect(JSON.parse(cliBpLines.join("\n")).blueprints.length).toBe(5);

      // 2. Dispatch ticket with blueprintId ("backend-feature" enables tddMode) + riskThreshold 5 + explicit preferredEngine ("explicit > blueprint > repo")
      const createRes = await fetch(`${baseUrl}/api/tickets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: "repo_main",
          title: "Enforce token prefix & min length",
          description: "Update verifyToken",
          blueprintId: "backend-feature",
          preferredEngine: "claude",
          deliveryGatePolicy: "risk_gated",
          riskThreshold: 5,
          allowedPaths: ["src/auth/**", "test/**"],
        }),
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as {
        ticket: { id: string; blueprintId?: string; tddMode?: boolean; preferredEngine?: string };
      };
      expect(created.ticket.blueprintId).toBe("backend-feature");
      expect(created.ticket.tddMode).toBe(true);
      expect(created.ticket.preferredEngine).toBe("claude");

      await kernel.runUntilIdle(30);

      // 3. Should be held at outbox_pending due to sensitive path src/auth/** scoring > riskThreshold 5
      const detail1Res = await fetch(`${baseUrl}/api/tickets/${created.ticket.id}`);
      const detail1 = (await detail1Res.json()) as {
        ticket: { status: string; errorMessage?: string; riskAssessment?: { score: number; requiresSignoff: boolean } };
        stageRuns: Array<{ stage: string; spans?: Array<{ kind: string }> }>;
        reviewComments: Array<{ id: string; author: string; status: string }>;
        inboxItems: Array<{ id: string; kind: string; status: string }>;
      };
      if (detail1.ticket.status !== "outbox_pending") {
        console.error("UNEXPECTED TICKET STATE:", detail1.ticket, detail1.inboxItems);
      }
      expect(detail1.ticket.status).toBe("outbox_pending");
      expect(detail1.ticket.riskAssessment?.requiresSignoff).toBe(true);
      expect(detail1.ticket.riskAssessment?.score).toBeGreaterThan(5);
      expect(detail1.inboxItems.some((i) => i.kind === "outbox_signoff" && i.status === "pending")).toBe(true);

      // C.1 StageSpan assertions
      const implRun = detail1.stageRuns.find((r) => r.stage === "implement");
      expect(implRun?.spans?.some((s) => s.kind === "workspace_prep")).toBe(true);
      expect(implRun?.spans?.some((s) => s.kind === "worker_turn")).toBe(true);
      expect(implRun?.spans?.some((s) => s.kind === "static_verify")).toBe(true);

      // B.1 AI review finding auto-synced to ticket_review_comments
      expect(detail1.reviewComments.some((c) => c.author === "ai" && c.status === "open")).toBe(true);

      // 4. B.1 Human Line-Anchored Request Changes -> rewinds to implement -> auto-resolves open comments!
      const reviewPostRes = await fetch(`${baseUrl}/api/tickets/${created.ticket.id}/review-comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "request_changes",
          summaryNote: "Please check minimum length",
          comments: [
            {
              filePath: "src/auth/token.ts",
              line: 2,
              side: "new",
              severity: "major",
              body: "Ensure length >= 6",
            },
          ],
        }),
      });
      expect(reviewPostRes.status).toBe(200);
      await kernel.runUntilIdle(30);

      const detail2Res = await fetch(`${baseUrl}/api/tickets/${created.ticket.id}`);
      const detail2 = (await detail2Res.json()) as {
        ticket: { status: string };
        reviewComments: Array<{ id: string; status: string }>;
      };
      expect(implementAttempts).toBe(2);
      expect(detail2.ticket.status).toBe("outbox_pending");
      expect(detail2.reviewComments.every((c) => c.status === "resolved")).toBe(true);

      // Toggle one comment open and back via PATCH
      const targetCid = detail2.reviewComments[0]!.id;
      const patchCommentRes = await fetch(`${baseUrl}/api/review-comments/${targetCid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "open" }),
      });
      expect(patchCommentRes.status).toBe(200);
      expect(((await patchCommentRes.json()) as { comment: { status: string } }).comment.status).toBe("open");

      // 5. C.1 Doctor & SQLite Hot Backup HTTP + CLI + MCP
      const docRes = await fetch(`${baseUrl}/api/system/doctor`);
      expect(docRes.status).toBe(200);
      expect(((await docRes.json()) as { items: unknown[] }).items.length).toBeGreaterThanOrEqual(4);

      const bkpPost = await fetch(`${baseUrl}/api/system/backups`, { method: "POST" });
      expect(bkpPost.status).toBe(201);
      const bkpList = await fetch(`${baseUrl}/api/system/backups`);
      expect(((await bkpList.json()) as { backups: unknown[] }).backups.length).toBeGreaterThanOrEqual(1);

      const cliDocOut: string[] = [];
      expect(
        await runCli(["doctor", "--json"], {
          baseUrl,
          stdout: (l) => cliDocOut.push(l),
          stderr: () => {},
        }),
      ).toBe(0);
      expect(Array.isArray(JSON.parse(cliDocOut.join("\n")).items)).toBe(true);

      const mcpDocRes = await fetch(`${baseUrl}/api/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 99,
          method: "tools/call",
          params: { name: "system_doctor", arguments: { fix: false } },
        }),
      });
      expect(mcpDocRes.status).toBe(200);
      const mcpDocJson = (await mcpDocRes.json()) as { result: { content: Array<{ text: string }> } };
      expect(JSON.parse(mcpDocJson.result.content[0]!.text).items.length).toBeGreaterThanOrEqual(4);
    } finally {
      await kernel.stop();
      server.stop(true);
    }
  }, 30_000);

  it("B.2: resolves 3-way rebase conflict in 1 bounded turn and restores pre-rebase checkpoint + escalates merge_conflict on gate failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v100-conflict-"));
    tempDirs.push(dir);
    const repoPath = await createGitRepo(dir, "conflict-app");

    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));

    let resolveShouldBreakSyntax = false;
    const claudeDriver = new ScriptedWorkerDriver("claude", async (input) => {
      if (input.prompt.includes("3-Way Semantic Rebase Conflict Resolution")) {
        expect(input.prompt).toContain("upstream divergent edit");
        if (resolveShouldBreakSyntax) {
          return {
            summary: "Broken resolution attempt",
            writeFiles: {
              "src/shared.ts": "export const sharedValue = ;;;\n",
            },
          };
        }
        return {
          summary: "Cleanly merged upstream hotfix with ticket mode",
          writeFiles: {
            "src/shared.ts": "export const sharedValue = 99;\nexport const mode = 'ticket-feature';\n",
          },
        };
      }
      return {
        summary: "Edited sharedValue to 2",
        writeFiles: {
          "src/shared.ts": "export const sharedValue = 2;\nexport const mode = 'ticket-feature';\n",
        },
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

    const repo: RepoConfig = {
      id: "repo_conf",
      name: "conflict-app",
      rootPath: repoPath,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "fast",
      verificationCommands: ["bun -e \"import './src/shared.ts'\""],
      preferredImplementEngine: "claude",
      preferredReviewEngine: "claude",
      autoCleanupWorktree: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await store.upsertRepo(repo);

    // Helper: create pre-committed conflicting worktree directly at stage='rebase'
    const setupConflictingTicket = async (idSuffix: string) => {
      const tkt = await kernel.createDirectTicket({
        repoId: repo.id,
        title: `Conflicting ticket ${idSuffix}`,
        description: "Update shared.ts mode",
        template: "fast",
        allowedPaths: ["src/**"],
      });
      const ws = await workspace.prepareWorkspace(tkt, repo);
      await writeFile(
        join(ws.worktreePath, "src/shared.ts"),
        "export const sharedValue = 2;\nexport const mode = 'ticket-feature';\n",
        "utf8",
      );
      await workspace.commitAll(ws.worktreePath, "ticket branch edit");

      // Upstream commit creating same-line conflict on main
      await writeFile(
        join(repoPath, "src/shared.ts"),
        `export const sharedValue = 99;\nexport const mode = 'upstream-${idSuffix}';\n`,
        "utf8",
      );
      await runGit(["add", "src/shared.ts"], repoPath);
      await runGit(["commit", "-m", "upstream divergent edit"], repoPath);

      const rebasingTicket = {
        ...tkt,
        status: "queued" as const,
        currentStage: "rebase" as const,
        worktreePath: ws.worktreePath,
        branchName: ws.branchName,
        updatedAt: nowIso(),
      };
      await store.saveTicket(rebasingTicket);
      return { ticket: rebasingTicket, worktreePath: ws.worktreePath };
    };

    try {
      // Case A: Auto-resolution succeeds cleanly
      resolveShouldBreakSyntax = false;
      const caseA = await setupConflictingTicket("ok");
      await kernel.runUntilIdle(15);
      const afterA = await store.getTicket(caseA.ticket.id);
      expect(afterA?.status).toBe("delivered");
      expect(afterA?.conflictResolutionCount).toBe(1);
      expect(afterA?.conflictContext?.resolvedAutomatically).toBe(true);

      // Case B: Auto-resolution fails verification -> restores checkpoint & escalates merge_conflict
      resolveShouldBreakSyntax = true;
      const caseB = await setupConflictingTicket("fail");
      await kernel.runUntilIdle(15);
      const afterB = await store.getTicket(caseB.ticket.id);
      expect(afterB?.status).toBe("needs_human");
      expect(afterB?.conflictContext?.resolvedAutomatically).toBe(false);

      const inboxB = await store.listInboxItems({ ticketId: caseB.ticket.id, status: "pending" });
      expect(inboxB.some((i) => i.kind === "merge_conflict")).toBe(true);
    } finally {
      await kernel.stop();
    }
  }, 30_000);
});
