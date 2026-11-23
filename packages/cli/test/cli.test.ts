import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { SuperWorkKernel, type OutboxExecutor } from "@super-work/core";
import {
  FsArtifactStore,
  GitWorktreeProvider,
  HeuristicControlLLM,
  MockWorkerDriver,
  SqliteStateStore,
  runGit,
} from "../../drivers/src/index.ts";
import { createServerApp } from "../../server/src/app.ts";
import { runCli } from "../src/index.ts";

async function createTempGitRepo(baseDir: string): Promise<string> {
  const repoDir = join(baseDir, "repo");
  await runGit(["init", "-b", "main", repoDir], baseDir);
  await runGit(["config", "user.name", "CLI Test"], repoDir);
  await runGit(["config", "user.email", "cli@example.com"], repoDir);
  await writeFile(join(repoDir, "README.md"), "# CLI Repo\n", "utf8");
  await runGit(["add", "."], repoDir);
  await runGit(["commit", "-m", "init"], repoDir);
  return repoDir;
}

describe("@super-work/cli", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("supports status, epic --preview-only, dispatch --wait, and inbox list/approve against HTTP/SSE daemon", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-cli-test-"));
    tempDirs.push(dir);
    const repoDir = await createTempGitRepo(dir);

    const stateStore = new SqliteStateStore(join(dir, "state.db"));
    const artifactStore = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));
    const llm = new HeuristicControlLLM();
    const outboxExecutor: OutboxExecutor = {
      async execute(_entry, _repo, ticket) {
        return { mode: "local_branch_ready", branchName: ticket.branchName };
      },
    };

    const kernel = new SuperWorkKernel({
      stateStore,
      artifactStore,
      workspace,
      llm,
      drivers: [new MockWorkerDriver({ engine: "mock", stepDelayMs: 5 })],
      outboxExecutor,
      config: { schedulerIntervalMs: 50, outboxIntervalMs: 50 },
    });

    const ts = new Date().toISOString();
    await stateStore.upsertRepo({
      id: "repo_cli",
      name: "cli-demo",
      rootPath: repoDir,
      baseBranch: "main",
      mode: "observe",
      defaultTemplate: "fast",
      preferredImplementEngine: "mock",
      preferredReviewEngine: "mock",
      createdAt: ts,
      updatedAt: ts,
    });

    const app = createServerApp({
      kernel,
      stateStore,
      artifactStore,
      llmProviderName: llm.providerName,
    });

    kernel.start();
    const server = Bun.serve({ port: 0, fetch: app.fetch, idleTimeout: 60 });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      // 1. status command
      const statusOut: string[] = [];
      const statusCode = await runCli(["status", "--repo", "repo_cli"], {
        baseUrl,
        stdout: (l) => statusOut.push(l),
        stderr: (l) => statusOut.push(l),
      });
      expect(statusCode).toBe(0);
      expect(statusOut.join("\n")).toContain("cli-demo (repo_cli)");

      // 2. epic --preview-only
      const previewOut: string[] = [];
      const previewCode = await runCli(
        [
          "epic",
          "Build plugin hub",
          "-d",
          "1. packages/core types\n2. packages/web panel",
          "--preview-only",
        ],
        {
          baseUrl,
          stdout: (l) => previewOut.push(l),
          stderr: (l) => previewOut.push(l),
        },
      );
      expect(previewCode).toBe(0);
      expect(previewOut.join("\n")).toContain("Epic Preview: Build plugin hub");

      // 3. dispatch --wait
      const dispatchOut: string[] = [];
      const dispatchCode = await runCli(
        [
          "dispatch",
          "Add CLI test feature",
          "-d",
          "Create cli helper module",
          "--paths",
          "src/**",
          "--template",
          "fast",
          "--engine",
          "mock",
          "--wait",
        ],
        {
          baseUrl,
          waitTimeoutMs: 15_000,
          stdout: (l) => dispatchOut.push(l),
          stderr: (l) => dispatchOut.push(l),
        },
      );
      expect(dispatchCode).toBe(0);
      expect(dispatchOut.join("\n")).toContain("status=delivered");

      // 4. Trigger in observe mode -> inbox list -> inbox approve -> logs
      await app.request("/api/triggers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: "repo_cli",
          source: "cli",
          threadKey: "cli:obs:1",
          title: "Observe task",
          rawText: "Update scope:src/cli/**",
        }),
      });

      const listOut: string[] = [];
      const listCode = await runCli(["inbox", "list", "--json"], {
        baseUrl,
        stdout: (l) => listOut.push(l),
        stderr: (l) => listOut.push(l),
      });
      expect(listCode).toBe(0);
      const parsedInbox = JSON.parse(listOut.join("\n")) as {
        items: Array<{ id: string; ticketId: string }>;
      };
      expect(parsedInbox.items).toHaveLength(1);

      const approveOut: string[] = [];
      const approveCode = await runCli(
        ["inbox", "approve", parsedInbox.items[0]!.id, "-m", "Go ahead"],
        {
          baseUrl,
          stdout: (l) => approveOut.push(l),
          stderr: (l) => approveOut.push(l),
        },
      );
      expect(approveCode).toBe(0);
      expect(approveOut.join("\n")).toContain("approved");

      const logsOut: string[] = [];
      const logsCode = await runCli(["logs", parsedInbox.items[0]!.ticketId], {
        baseUrl,
        stdout: (l) => logsOut.push(l),
        stderr: (l) => logsOut.push(l),
      });
      expect(logsCode).toBe(0);
      expect(logsOut.join("\n")).toContain(parsedInbox.items[0]!.ticketId);
    } finally {
      server.stop(true);
      await kernel.stop();
      stateStore.close();
    }
  });
});
