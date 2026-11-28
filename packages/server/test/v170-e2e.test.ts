import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { MCP_TOOL_DEFINITIONS, SuperWorkKernel, buildRunDigestReport } from "@super-work/core";
import type { FlightEvent, RunDigestReport } from "@super-work/core/types";
import {
  FsArtifactStore,
  GhOutboxExecutor,
  GitWorktreeProvider,
  HeuristicControlLLM,
  MockWorkerDriver,
  SqliteStateStore,
} from "@super-work/drivers";
import { createServerApp } from "../src/app.ts";

const NOW = "2026-01-01T12:00:00.000Z";

function ev(id: string, kind: FlightEvent["kind"]): FlightEvent {
  return { id, kind, summary: kind, createdAt: "2026-01-01T11:00:00.000Z" };
}

describe("v1.7.0 Wave 2 End-to-End (MCP 1.7.0, Watchdog 2.0 / flake digest, core/types subpath)", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const d of tempDirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("exposes MCP 1.7.0 with 27 tools over REST and JSON-RPC initialize", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v170-e2e-"));
    tempDirs.push(dir);
    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));
    const kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm: new HeuristicControlLLM(),
      drivers: [new MockWorkerDriver({ engine: "mock", stepDelayMs: 1 })],
      outboxExecutor: new GhOutboxExecutor(workspace),
      dataDir: dir,
    });
    const app = createServerApp({ kernel, stateStore: store, artifactStore: artifacts });
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    try {
      const info = (await (await fetch(`${baseUrl}/api/mcp`)).json()) as { version: string };
      expect(info.version).toBe("1.8.1");
      expect(MCP_TOOL_DEFINITIONS).toHaveLength(27);

      const rpc = async (method: string) =>
        (await (
          await fetch(`${baseUrl}/api/mcp`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { protocolVersion: "2025-03-26" } }),
          })
        ).json()) as { result: { serverInfo?: { version: string }; tools?: unknown[] } };
      expect((await rpc("initialize")).result.serverInfo?.version).toBe("1.8.1");
      expect((await rpc("tools/list")).result.tools).toHaveLength(27);
    } finally {
      await server.stop(true);
    }
  });

  it("aggregates watchdog_extended / flake_retried into digest resilience and markdown", () => {
    const report: RunDigestReport = buildRunDigestReport({
      windowHours: 24,
      now: NOW,
      tickets: [],
      stageRuns: [],
      flightEvents: [
        ev("a", "watchdog_extended"),
        ev("b", "watchdog_extended"),
        ev("c", "flake_retried"),
        ev("d", "engine_tripped"),
      ],
    });
    expect(report.resilience).toEqual({
      engineTrips: 1,
      spilloverQuarantines: 0,
      watchdogExtensions: 2,
      flakeRetries: 1,
    });
    expect(report.markdownEn).toContain("Watchdog 2.0 extensions: 2");
    expect(report.markdownEn).toContain("Flake retries: 1");
    expect(report.markdownZh).toContain("Watchdog 2.0 自适应延长：2 次");
    expect(report.markdownZh).toContain("Flake 单次重试：1 次");
  });

  it("omits the new counters and markdown lines when no such events exist", () => {
    const report = buildRunDigestReport({
      windowHours: 24,
      now: NOW,
      tickets: [],
      stageRuns: [],
      flightEvents: [ev("d", "engine_tripped")],
    });
    expect(report.resilience).toEqual({ engineTrips: 1, spilloverQuarantines: 0 });
    expect(report.markdownEn).not.toContain("Flake retries");
    expect(report.markdownZh).not.toContain("Flake 单次重试");
  });

  it("resolves the type-only @super-work/core/types subpath and declares it in exports", async () => {
    const kinds: FlightEvent["kind"][] = ["watchdog_extended", "flake_retried"];
    expect(kinds).toHaveLength(2);
    const pkg = JSON.parse(await readFile(join(import.meta.dir, "../../core/package.json"), "utf8")) as {
      exports: Record<string, string>;
    };
    expect(pkg.exports["./types"]).toBe("./src/types.ts");
    expect(pkg.exports["."]).toBe("./src/index.ts");
  });
});
