import { describe, expect, it } from "bun:test";
import {
  MCP_TOOL_DEFINITIONS,
  auditPlaybookEntries,
  buildRunDigestReport,
  classifyEngineError,
  evaluatePlaybookRuleHygiene,
  handleMcpJsonRpcMessage,
  type FlightEvent,
  type PlaybookEntry,
} from "../src/index.ts";

const TS = "2026-11-25T00:00:00.000Z";

function entry(overrides: Partial<PlaybookEntry> & { rule: string }): PlaybookEntry {
  return {
    id: overrides.id ?? `pbk_${Math.random().toString(36).slice(2, 8)}`,
    repoId: "repo_1",
    scopePaths: ["**"],
    source: "human",
    enabled: true,
    pinned: false,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

describe("v1.6.0 playbook hygiene evaluator", () => {
  const noisy = [
    "Human approved continuation. All edits are already passing in the worktree.",
    "Reviewed 19-file Direction A diff and passing typecheck/test/build gates; approve local_merge and Boot Canary.",
    "Please keep this review fast and finish immediately.",
    "Everything is already verified, finish up.",
    "All 19 edited files are preserved in your worktree.",
    "Fixed per tkt_a413599779cf follow-up",
    "Looks fine, approve and boot canary.",
    "LGTM, tests passing, approved.",
  ];
  for (const rule of noisy) {
    it(`flags one-off noise: ${rule.slice(0, 40)}`, () => {
      const res = evaluatePlaybookRuleHygiene(rule, "human");
      expect(res.clean).toBe(false);
      expect(res.severity).toBe("noise");
      expect(res.reasons.length).toBeGreaterThan(0);
    });
  }

  it("is case-insensitive", () => {
    expect(evaluatePlaybookRuleHygiene("HUMAN APPROVED CONTINUATION", "human").clean).toBe(false);
    expect(evaluatePlaybookRuleHygiene("see MST_abc123 for context", "auto_healed").clean).toBe(false);
  });

  it("never flags repo_contract or pinned rules", () => {
    const text = "Human approved continuation for tkt_abc123";
    expect(evaluatePlaybookRuleHygiene(text, "repo_contract")).toEqual({
      clean: true,
      reasons: [],
      severity: "ok",
    });
    expect(evaluatePlaybookRuleHygiene(text, "human", { pinned: true }).clean).toBe(true);
  });

  it("keeps reusable engineering constraints clean", () => {
    const clean = [
      "Keep every packages/web Vite build JS chunk under 500 kB via React.lazy or manualChunks.",
      "Never import @super-work/drivers from packages/core.",
      "Always run bun run typecheck before approving a merge.",
      "Mirror new core/server capabilities across REST, CLI, MCP and bilingual Web UI.",
    ];
    for (const rule of clean) {
      expect(evaluatePlaybookRuleHygiene(rule, "human").clean).toBe(true);
    }
  });

  it("audits entries into a report", () => {
    const entries = [
      entry({ id: "a", rule: "Never use window.confirm in packages/web.", hitCount: 3 }),
      entry({ id: "b", rule: "Human approved continuation. Already verified.", hitCount: 1 }),
      entry({ id: "c", rule: "Human approved continuation.", pinned: true }),
      entry({ id: "d", rule: "approve local_merge tkt_deadbeef", enabled: false, source: "auto_healed" }),
    ];
    const report = auditPlaybookEntries(entries, "repo_1");
    expect(report.repoId).toBe("repo_1");
    expect(report.total).toBe(4);
    expect(report.noisyCount).toBe(2);
    expect(report.healthy).toBe(2);
    expect(report.noisyEntries.map((e) => e.id).sort()).toEqual(["b", "d"]);
    const b = report.noisyEntries.find((e) => e.id === "b")!;
    expect(b.hitCount).toBe(1);
    expect(b.enabled).toBe(true);
    expect(report.noisyEntries.find((e) => e.id === "d")!.enabled).toBe(false);
    expect(auditPlaybookEntries([]).total).toBe(0);
  });
});

describe("v1.6.0 engine error classification", () => {
  it("treats exhausted free tiers as deterministic quota_exhausted", () => {
    expect(classifyEngineError("You have reached the free usage limit")).toEqual({
      kind: "quota_exhausted",
      deterministic: true,
    });
    expect(classifyEngineError("Please Subscribe to OpenCode to continue")?.kind).toBe("quota_exhausted");
  });
});

describe("v1.6.0 digest gate reuse & resilience", () => {
  function ev(kind: FlightEvent["kind"], id: string, savedMs?: number): FlightEvent {
    return { id, kind, summary: kind, savedMs, createdAt: TS };
  }

  it("aggregates gate_reused and resilience counters", () => {
    const digest = buildRunDigestReport({
      tickets: [],
      stageRuns: [],
      flightEvents: [
        ev("gate_reused", "1", 1500),
        ev("gate_reused", "2", 500),
        ev("gate_reused", "3"),
        ev("scoped_gate_run", "4", 2000),
        ev("engine_tripped", "5"),
        ev("engine_tripped", "6"),
        ev("spillover_quarantined", "7"),
      ],
      windowHours: 0,
      now: TS,
    });
    expect(digest.gateReuse).toEqual({ reusedRuns: 3, totalSavedMs: 2000 });
    expect(digest.gateSavings).toEqual({ scopedRuns: 1, totalSavedMs: 2000 });
    expect(digest.resilience).toEqual({ engineTrips: 2, spilloverQuarantines: 1 });
    expect(digest.markdownEn).toContain("Rebase gate reuse: 3 run(s)");
    expect(digest.markdownZh).toContain("Rebase 校验门复用：3 次");
  });

  it("omits the reuse line when nothing was reused", () => {
    const digest = buildRunDigestReport({
      tickets: [],
      stageRuns: [],
      flightEvents: [],
      windowHours: 0,
      now: TS,
    });
    expect(digest.gateReuse).toEqual({ reusedRuns: 0, totalSavedMs: 0 });
    expect(digest.markdownEn).not.toContain("Rebase gate reuse");
  });
});

describe("v1.6.0 MCP surface", () => {
  it("advertises manage_playbook_hygiene as the 27th tool at version 1.7.0", async () => {
    expect(MCP_TOOL_DEFINITIONS).toHaveLength(27);
    const tool = MCP_TOOL_DEFINITIONS.find((t) => t.name === "manage_playbook_hygiene");
    expect(tool).toBeDefined();

    const calls: Array<Record<string, unknown>> = [];
    const host = {
      managePlaybookHygiene: async (args: Record<string, unknown>) => {
        calls.push(args);
        return { ok: true };
      },
    };
    const init = (await handleMcpJsonRpcMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
      host as never,
    )) as { result: { serverInfo: { version: string } } };
    expect(init.result.serverInfo.version).toBe("1.7.0");

    await handleMcpJsonRpcMessage(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "manage_playbook_hygiene", arguments: { action: "audit" } },
      },
      host as never,
    );
    expect(calls).toEqual([{ action: "audit" }]);
  });
});
