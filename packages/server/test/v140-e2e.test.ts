import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  MCP_TOOL_DEFINITIONS,
  SuperWorkKernel,
  newId,
  nowIso,
  planMilestoneWaves,
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
import { runCli } from "../../cli/src/index.ts";
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

describe("v1.4.0 End-to-End Milestones (Waves, Controlled Release, Run Digest, MCP 1.4.0)", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const d of tempDirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("planMilestoneWaves: non-overlapping paths share a wave, overlapping paths serialize", () => {
    const items = planMilestoneWaves(
      [
        ["a", ["src/alpha/**"]],
        ["b", ["src/beta/**"]],
        ["c", ["src/alpha/one.txt"]],
        ["d", ["**"]],
      ].map(([title, allowedPaths], index) => ({
        id: `msi_${index}`,
        index,
        requirement: String(title),
        title: String(title),
        route: "single_ticket" as const,
        allowedPaths: allowedPaths as string[],
      })),
    );
    expect(items.map((i) => i.waveIndex)).toEqual([0, 0, 1, 2]);
    expect(items[2]!.dependsOnIndices).toEqual([0]);
    expect(items[3]!.dependsOnIndices).toEqual([0, 1, 2]);
  });

  it("creates a multi-wave milestone, auto-synthesizes release notes + Inbox, and only releases on explicit request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v140-e2e-ms-"));
    tempDirs.push(dir);
    const repoPath = await initRealGitRepo(dir, "ms-app", {
      "README.md": "# Milestone App\n",
      "package.json": `${JSON.stringify({ name: "ms-app", version: "1.3.0" }, null, 2)}\n`,
      "packages/core/package.json": `${JSON.stringify({ name: "@ms/core", version: "1.3.0" }, null, 2)}\n`,
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
      preferredImplementEngine: "claude",
      preferredReviewEngine: "claude",
      createdAt: ts,
      updatedAt: ts,
    });

    const app = createServerApp({ kernel, stateStore: store, artifactStore: artifacts });
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      const createRes = await fetch(`${baseUrl}/api/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: "repo_ms",
          name: "Release train",
          targetVersion: "1.4.0",
          requirements: [
            "Create src/alpha/one.txt with the alpha marker",
            "Create src/beta/two.txt with the beta marker",
            "Append a second marker to src/alpha/one.txt",
          ],
        }),
      });
      expect(createRes.status).toBe(201);
      const { milestone } = (await createRes.json()) as { milestone: Milestone };
      expect(milestone.status).toBe("active");
      expect(milestone.items).toHaveLength(3);
      // Overlap serialization: item 3 touches alpha again -> wave 1, depends on item 1.
      expect(milestone.items.map((i) => i.waveIndex)).toEqual([0, 0, 1]);
      expect(milestone.items[2]!.dependsOnIndices).toEqual([0]);

      // Cross-wave dependsOn is wired onto the downstream ticket.
      const downstream = await store.getTicket(
        milestone.items[2]!.ticketId ?? milestone.items[2]!.epicId ?? "",
      );
      const upstreamId = milestone.items[0]!.ticketId ?? milestone.items[0]!.epicId;
      expect(downstream?.milestoneId ?? "").toBe(milestone.id);
      expect(downstream?.dependsOn).toContain(upstreamId as string);

      await kernel.runUntilIdle(60);

      const detail = (await (await fetch(`${baseUrl}/api/milestones/${milestone.id}`)).json()) as {
        milestone: Milestone;
      };
      expect(detail.milestone.status).toBe("ready_to_release");
      expect(detail.milestone.items.every((i) => i.status === "delivered")).toBe(true);
      expect(detail.milestone.releaseNotesEn).toContain("Release Notes");
      expect(detail.milestone.releaseNotesZh).toContain("发布说明");
      expect(detail.milestone.digestSummary).toBeTruthy();

      const inbox = await store.listInboxItems({ repoId: "repo_ms", status: "pending" });
      const readyItem = inbox.find((i) => i.kind === "milestone_ready");
      expect(readyItem?.contextPayload.milestoneId).toBe(milestone.id);
      expect(readyItem?.contextPayload.targetVersion).toBe("1.4.0");

      // Nothing was released automatically.
      expect((await runGit(["tag"], repoPath)).stdout.trim()).toBe("");
      expect(JSON.parse(await readFile(join(repoPath, "package.json"), "utf8")).version).toBe(
        "1.3.0",
      );

      const flight = await kernel.listFlightEvents({ repoId: "repo_ms", limit: 50 });
      expect(flight.some((e) => e.kind === "milestone_ready")).toBe(true);

      // Controlled release: bump only; no tag, no push.
      const releaseRes = await fetch(`${baseUrl}/api/milestones/${milestone.id}/release`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bumpVersion: true, createTag: false, pushRemote: false }),
      });
      expect(releaseRes.status).toBe(200);
      const released = (await releaseRes.json()) as { milestone: Milestone };
      expect(released.milestone.status).toBe("released");
      expect(released.milestone.releasedCommitSha).toBeTruthy();
      expect(released.milestone.releasedTag).toBeUndefined();

      expect(JSON.parse(await readFile(join(repoPath, "package.json"), "utf8")).version).toBe(
        "1.4.0",
      );
      expect(
        JSON.parse(await readFile(join(repoPath, "packages/core/package.json"), "utf8")).version,
      ).toBe("1.4.0");
      const subject = (await runGit(["log", "-1", "--format=%s"], repoPath)).stdout.trim();
      expect(subject).toBe("chore(release): bump version to v1.4.0");
      expect((await runGit(["tag"], repoPath)).stdout.trim()).toBe("");
      expect((await runGit(["remote"], repoPath)).stdout.trim()).toBe("");

      const afterInbox = await store.listInboxItems({ repoId: "repo_ms", status: "pending" });
      expect(afterInbox.some((i) => i.kind === "milestone_ready")).toBe(false);
      const flightAfter = await kernel.listFlightEvents({ repoId: "repo_ms", limit: 50 });
      expect(flightAfter.some((e) => e.kind === "milestone_released")).toBe(true);

      // Releasing twice is rejected.
      const again = await fetch(`${baseUrl}/api/milestones/${milestone.id}/release`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(again.status).toBe(400);

      // Run Digest REST + MCP 1.4.0 (25 tools) + CLI.
      const digestRes = await fetch(`${baseUrl}/api/digest?repoId=repo_ms&hours=24`);
      expect(digestRes.status).toBe(200);
      const { digest } = (await digestRes.json()) as {
        digest: { ticketSummary: { delivered: number }; markdownEn: string; markdownZh: string };
      };
      expect(digest.ticketSummary.delivered).toBeGreaterThanOrEqual(3);
      expect(digest.markdownEn.length).toBeGreaterThan(0);
      expect(digest.markdownZh.length).toBeGreaterThan(0);

      const mcpInfo = (await (await fetch(`${baseUrl}/api/mcp`)).json()) as { version: string };
      expect(mcpInfo.version).toBe("1.5.0");
      expect(MCP_TOOL_DEFINITIONS).toHaveLength(26);

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
        "1.5.0",
      );
      const tools = (await rpc("tools/list")).result.tools ?? [];
      expect(tools).toHaveLength(26);
      expect(tools.some((t) => t.name === "manage_milestones")).toBe(true);
      expect(tools.some((t) => t.name === "get_run_digest")).toBe(true);
      const listed = await rpc("tools/call", {
        name: "manage_milestones",
        arguments: { action: "list", repoId: "repo_ms" },
      });
      expect(listed.result.content?.[0]?.text).toContain(milestone.id);

      const cliOut: string[] = [];
      const cliCode = await runCli(["milestone", "list", "--json"], {
        baseUrl,
        stdout: (l) => cliOut.push(l),
        stderr: (l) => cliOut.push(l),
      });
      expect(cliCode).toBe(0);
      expect(cliOut.join("\n")).toContain(milestone.id);
    } finally {
      server.stop(true);
      await kernel.stop?.();
    }
  }, 120_000);
});
