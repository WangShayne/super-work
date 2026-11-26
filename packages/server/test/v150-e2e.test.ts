import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  MCP_TOOL_DEFINITIONS,
  SuperWorkKernel,
  newId,
  nowIso,
  type Milestone,
  type WorkerDriver,
  type WorkerEngineId,
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
import { createServerApp } from "../src/app.ts";

class ScriptedDriver implements WorkerDriver {
  constructor(
    readonly engine: WorkerEngineId,
    private readonly handler: (input: WorkerTurnInput) => AsyncGenerator<WorkerStreamEvent>,
  ) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  runTurn(input: WorkerTurnInput): AsyncGenerator<WorkerStreamEvent> {
    return this.handler(input);
  }
}

async function initRealGitRepo(
  baseDir: string,
  name: string,
  files: Record<string, string>,
): Promise<string> {
  const repoDir = join(baseDir, name);
  await runGit(["init", "-b", "main", repoDir], baseDir);
  await runGit(["config", "user.name", "Test User"], repoDir);
  await runGit(["config", "user.email", "test@example.com"], repoDir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(repoDir, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  await runGit(["add", ...Object.keys(files)], repoDir);
  await runGit(["commit", "-m", "initial commit"], repoDir);
  return repoDir;
}

describe("v1.5.0 Wave 3 End-to-End (milestone_branch staging, squash release, engines, MCP 1.5.0)", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const d of tempDirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("stages items zero-touch on the milestone branch, signs off once, and squash-releases losslessly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v150-e2e-ms-"));
    tempDirs.push(dir);
    const repoPath = await initRealGitRepo(dir, "ms-app", {
      "README.md": "# Milestone App\n",
      "package.json": `${JSON.stringify({ name: "ms-app", version: "1.4.0" }, null, 2)}\n`,
      "packages/core/package.json": `${JSON.stringify({ name: "@ms/core", version: "1.4.0" }, null, 2)}\n`,
    });

    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));

    const driver = new ScriptedDriver("claude", async function* (input) {
      yield { type: "session_started", nativeSessionId: newId("sess"), timestamp: nowIso() };
      const match = input.prompt.match(/src\/[a-z]+\/[a-z]+\.txt/);
      if (match) {
        const abs = join(input.worktreePath, match[0]);
        await mkdir(join(abs, ".."), { recursive: true });
        let prev = "";
        try {
          prev = await readFile(abs, "utf8");
        } catch {
          prev = "";
        }
        await writeFile(abs, `${prev}${input.ticketId}\n`, "utf8");
      }
      yield { type: "completed", summary: "edited file", costUsd: 0.02, timestamp: nowIso() };
    });

    const kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm: new HeuristicControlLLM(),
      drivers: [driver],
      outboxExecutor: new GhOutboxExecutor(workspace),
      dataDir: dir,
    });

    const ts = nowIso();
    await store.upsertRepo({
      id: "repo_ms",
      name: "ms-app",
      rootPath: repoPath,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "fast",
      defaultDeliveryChannel: "local_merge",
      // Even a strict gate policy must not interrupt staged milestone items.
      deliveryGatePolicy: "always_signoff",
      preferredImplementEngine: "claude",
      preferredReviewEngine: "claude",
      createdAt: ts,
      updatedAt: ts,
    });

    const app = createServerApp({ kernel, stateStore: store, artifactStore: artifacts });
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      const preSha = (await runGit(["rev-parse", "main"], repoPath)).stdout.trim();

      const badMode = await fetch(`${baseUrl}/api/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: "repo_ms",
          name: "bad",
          requirements: ["x"],
          integrationMode: "nope",
        }),
      });
      expect(badMode.status).toBe(400);

      const createRes = await fetch(`${baseUrl}/api/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: "repo_ms",
          name: "Staged release",
          targetVersion: "1.5.0",
          integrationMode: "milestone_branch",
          preferredRoute: "single_ticket",
          requirements: [
            "Create src/alpha/one.txt with the alpha marker",
            "Create src/beta/two.txt with the beta marker",
            "Append a second marker to src/alpha/one.txt",
          ],
        }),
      });
      expect(createRes.status).toBe(201);
      const { milestone } = (await createRes.json()) as { milestone: Milestone };
      expect(milestone.integrationMode).toBe("milestone_branch");
      expect(milestone.stagingBranch).toBe(`super-work/milestone/${milestone.id}`);
      const stagingBranch = milestone.stagingBranch as string;
      expect(
        (await runGit(["rev-parse", "--verify", `refs/heads/${stagingBranch}`], repoPath)).exitCode,
      ).toBe(0);

      const first = await store.getTicket(milestone.items[0]!.ticketId ?? "");
      expect(first?.targetBranch).toBe(stagingBranch);
      expect(first?.milestoneId).toBe(milestone.id);

      await kernel.runUntilIdle(60);

      const detail = (await (await fetch(`${baseUrl}/api/milestones/${milestone.id}`)).json()) as {
        milestone: Milestone;
      };
      expect(detail.milestone.status).toBe("ready_to_release");
      expect(detail.milestone.items.every((i) => i.status === "delivered")).toBe(true);
      expect(detail.milestone.releaseNotesEn).toContain("Release Notes");
      expect(detail.milestone.releaseNotesZh).toContain("发布说明");

      // Zero-touch: main untouched, exactly one signoff card (milestone_ready), no outbox signoffs.
      expect((await runGit(["rev-parse", "main"], repoPath)).stdout.trim()).toBe(preSha);
      const stagingCommits = (
        await runGit(["rev-list", "--count", `main..${stagingBranch}`], repoPath)
      ).stdout.trim();
      expect(Number(stagingCommits)).toBeGreaterThanOrEqual(3);
      const pending = await store.listInboxItems({ repoId: "repo_ms", status: "pending" });
      expect(pending.map((i) => i.kind)).toEqual(["milestone_ready"]);

      // Unified signoff: bump + squash, no tag, no push.
      const message = "feat: release v1.5.0 (staged milestone)";
      const releaseRes = await fetch(`${baseUrl}/api/milestones/${milestone.id}/release`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bumpVersion: true,
          squashReleaseCommit: true,
          releaseCommitMessage: message,
          createTag: false,
          pushRemote: false,
        }),
      });
      expect(releaseRes.status).toBe(200);
      const released = (await releaseRes.json()) as { milestone: Milestone };
      expect(released.milestone.status).toBe("released");
      expect(released.milestone.releasedTag).toBeUndefined();

      // Single clean release commit directly on top of the pre-release base.
      expect((await runGit(["rev-list", "--count", `${preSha}..main`], repoPath)).stdout.trim()).toBe(
        "1",
      );
      expect((await runGit(["rev-parse", "main~1"], repoPath)).stdout.trim()).toBe(preSha);
      expect((await runGit(["log", "-1", "--format=%s"], repoPath)).stdout.trim()).toBe(message);
      expect(released.milestone.releasedCommitSha).toBe(
        (await runGit(["rev-parse", "main"], repoPath)).stdout.trim(),
      );

      // Lossless: item content and bumped versions are all in the single commit.
      expect(await readFile(join(repoPath, "src/alpha/one.txt"), "utf8")).toContain("tkt_");
      expect(await readFile(join(repoPath, "src/beta/two.txt"), "utf8")).toContain("tkt_");
      expect(JSON.parse(await readFile(join(repoPath, "package.json"), "utf8")).version).toBe("1.5.0");
      expect(
        JSON.parse(await readFile(join(repoPath, "packages/core/package.json"), "utf8")).version,
      ).toBe("1.5.0");

      // Working tree clean, staging branch removed, no tag, no remote.
      expect((await runGit(["status", "--porcelain"], repoPath)).stdout.trim()).toBe("");
      expect(
        (await runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${stagingBranch}`], repoPath))
          .exitCode,
      ).not.toBe(0);
      expect((await runGit(["tag"], repoPath)).stdout.trim()).toBe("");
      expect((await runGit(["remote"], repoPath)).stdout.trim()).toBe("");
      const after = await store.listInboxItems({ repoId: "repo_ms", status: "pending" });
      expect(after.some((i) => i.kind === "milestone_ready")).toBe(false);
    } finally {
      await server.stop(true);
    }
  }, 60_000);

  it("exposes engine health REST routes and MCP 1.7.0 with 27 tools", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v150-e2e-mcp-"));
    tempDirs.push(dir);
    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));
    const kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm: new HeuristicControlLLM(),
      drivers: [],
      outboxExecutor: new GhOutboxExecutor(workspace),
      dataDir: dir,
    });
    const app = createServerApp({ kernel, stateStore: store, artifactStore: artifacts });
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      const listRes = await fetch(`${baseUrl}/api/system/engines`);
      expect(listRes.status).toBe(200);
      expect(Array.isArray(((await listRes.json()) as { engines: unknown[] }).engines)).toBe(true);

      const badProbe = await fetch(`${baseUrl}/api/system/engines/probe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ engine: "nope" }),
      });
      expect(badProbe.status).toBe(400);
      const resetRes = await fetch(`${baseUrl}/api/system/engines/mock/reset`, { method: "POST" });
      expect(resetRes.status).toBe(200);

      const mcpInfo = (await (await fetch(`${baseUrl}/api/mcp`)).json()) as { version: string };
      expect(mcpInfo.version).toBe("1.8.0");
      expect(MCP_TOOL_DEFINITIONS).toHaveLength(27);

      const rpc = async (method: string, params?: Record<string, unknown>) =>
        (await (
          await fetch(`${baseUrl}/api/mcp`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          })
        ).json()) as {
          result: {
            tools?: Array<{ name: string }>;
            serverInfo?: { version: string };
            content?: Array<{ text: string }>;
          };
        };
      expect((await rpc("initialize", { protocolVersion: "2025-03-26" })).result.serverInfo?.version).toBe(
        "1.8.0",
      );
      const tools = (await rpc("tools/list")).result.tools ?? [];
      expect(tools).toHaveLength(27);
      expect(tools.some((t) => t.name === "manage_engine_health")).toBe(true);
      const called = await rpc("tools/call", {
        name: "manage_engine_health",
        arguments: { action: "list" },
      });
      expect(called.result.content?.[0]?.text).toContain("engines");
    } finally {
      await server.stop(true);
    }
  });
});
