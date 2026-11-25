import { describe, expect, it } from "bun:test";
import {
  buildRunDigestReport,
  createDefaultMandate,
  type FlightEvent,
  type StageRun,
  type Ticket,
} from "../src/index.ts";

const NOW = "2026-06-10T12:00:00.000Z";

function makeTicket(overrides: Partial<Ticket> & { id: string }): Ticket {
  return {
    repoId: "repo_a",
    threadId: "thr",
    sourceTriggerId: "trg",
    title: "t",
    description: "d",
    status: "delivered",
    template: "standard",
    currentStage: "implement",
    stageRetries: 0,
    mandate: createDefaultMandate({ allowedPaths: ["src/**"], maxCostUsd: 3 }),
    dependsOn: [],
    nativeSessions: {},
    activeEngine: "claude",
    inlineMemory: { goal: "g", acceptanceCriteria: [], stageNotes: [], threadUpdates: [] },
    costUsd: 1,
    priority: 1,
    createdAt: "2026-06-10T10:00:00.000Z",
    updatedAt: "2026-06-10T11:00:00.000Z",
    ...overrides,
  };
}

function makeRun(overrides: Partial<StageRun> & { id: string; ticketId: string }): StageRun {
  return {
    stage: "implement",
    engine: "claude",
    status: "completed",
    costUsd: 0.5,
    startedAt: "2026-06-10T10:00:00.000Z",
    completedAt: "2026-06-10T10:01:00.000Z",
    ...overrides,
  };
}

function makeEvent(overrides: Partial<FlightEvent> & { id: string; kind: FlightEvent["kind"] }): FlightEvent {
  return {
    repoId: "repo_a",
    summary: overrides.kind,
    createdAt: "2026-06-10T11:00:00.000Z",
    ...overrides,
  };
}

describe("v1.4.0 buildRunDigestReport", () => {
  const tickets = [
    makeTicket({ id: "t1", status: "delivered", activeEngine: "claude", costUsd: 2 }),
    makeTicket({ id: "t2", status: "failed", activeEngine: "claude", costUsd: 1 }),
    makeTicket({ id: "t3", status: "delivered", activeEngine: "codex", costUsd: 3, revertedAt: "2026-06-10T11:30:00.000Z" }),
    makeTicket({ id: "t4", status: "needs_human", activeEngine: "gemini", costUsd: 0.5 }),
    makeTicket({ id: "t5", status: "implementing", activeEngine: undefined, costUsd: 0.25 }),
    makeTicket({ id: "t6", repoId: "repo_b", status: "delivered", costUsd: 9 }),
    makeTicket({ id: "t_old", status: "delivered", updatedAt: "2026-05-01T00:00:00.000Z", costUsd: 7 }),
  ];
  const stageRuns = [
    makeRun({ id: "r1", ticketId: "t1", engine: "claude", costUsd: 1.5 }),
    makeRun({
      id: "r2",
      ticketId: "t2",
      engine: "claude",
      costUsd: 0.5,
      completedAt: "2026-06-10T10:03:00.000Z",
    }),
    makeRun({ id: "r3", ticketId: "t3", engine: "codex", costUsd: 2 }),
    makeRun({ id: "r5", ticketId: "t5", engine: "opencode", costUsd: 0.25, completedAt: undefined }),
  ];
  const events = [
    makeEvent({ id: "e1", kind: "scoped_gate_run", savedMs: 40_000, createdAt: "2026-06-10T10:10:00.000Z" }),
    makeEvent({ id: "e2", kind: "scoped_gate_run", savedMs: 20_000, createdAt: "2026-06-10T10:20:00.000Z" }),
    makeEvent({ id: "e3", kind: "canary_passed", createdAt: "2026-06-10T10:30:00.000Z" }),
    makeEvent({ id: "e4", kind: "reload_completed", createdAt: "2026-06-10T10:31:00.000Z" }),
    makeEvent({ id: "e5", kind: "canary_rolled_back", createdAt: "2026-06-10T10:40:00.000Z" }),
    makeEvent({ id: "e6", kind: "watchdog_switch", engine: "codex", createdAt: "2026-06-10T10:50:00.000Z" }),
    makeEvent({ id: "e_other", kind: "canary_passed", repoId: "repo_b" }),
    makeEvent({ id: "e_old", kind: "canary_passed", createdAt: "2026-05-01T00:00:00.000Z" }),
  ];

  const base = { tickets, stageRuns, flightEvents: events, now: NOW };

  it("aggregates ticket KPIs inside the window for one repo", () => {
    const d = buildRunDigestReport({ ...base, repoId: "repo_a", windowHours: 24 });
    expect(d.ticketSummary.total).toBe(5);
    expect(d.ticketSummary.delivered).toBe(1);
    expect(d.ticketSummary.reverted).toBe(1);
    expect(d.ticketSummary.escalated).toBe(1);
    expect(d.ticketSummary.active).toBe(2); // t4 (needs_human) + t5 (implementing) are non-terminal
    expect(d.ticketSummary.totalCostUsd).toBeCloseTo(2 + 1 + 3 + 0.5 + 0.25, 5);
  });

  it("builds per-engine breakdown for claude/codex/gemini/opencode", () => {
    const d = buildRunDigestReport({ ...base, repoId: "repo_a", windowHours: 24 });
    expect(d.engines.map((e) => e.engine)).toEqual(["claude", "codex", "gemini", "opencode"]);
    const claude = d.engines[0]!;
    expect(claude.tickets).toBe(2);
    expect(claude.delivered).toBe(1);
    expect(claude.failedOrReverted).toBe(1);
    expect(claude.passRate).toBeCloseTo(0.5, 5);
    expect(claude.totalCostUsd).toBeCloseTo(2, 5);
    expect(claude.avgDurationMs).toBeCloseTo((60_000 + 180_000) / 2, 5);
    const codex = d.engines[1]!;
    expect(codex.delivered).toBe(0); // reverted delivery does not count as delivered
    expect(codex.failedOrReverted).toBe(1);
    expect(codex.passRate).toBe(0);
    const gemini = d.engines[2]!;
    expect(gemini.tickets).toBe(1);
    expect(gemini.passRate).toBe(0); // no settled tickets -> no division by zero
    const opencode = d.engines[3]!;
    expect(opencode.tickets).toBe(1); // engine resolved from stage run when activeEngine is missing
    expect(opencode.avgDurationMs).toBe(0);
  });

  it("sums gate savings and self-host counters, ignoring other repos and out-of-window events", () => {
    const d = buildRunDigestReport({ ...base, repoId: "repo_a", windowHours: 24 });
    expect(d.gateSavings).toEqual({ scopedRuns: 2, totalSavedMs: 60_000 });
    expect(d.selfHost).toEqual({
      canaryPassed: 1,
      reloadsCompleted: 1,
      canaryRolledBack: 1,
      watchdogSwitches: 1,
    });
    expect(d.events.map((e) => e.id)).toEqual(["e6", "e5", "e4", "e3", "e2", "e1"]);
  });

  it("treats windowHours <= 0 as all time and includes every repo when repoId is omitted", () => {
    const d = buildRunDigestReport({ ...base, windowHours: 0 });
    expect(d.windowHours).toBe(0);
    expect(d.ticketSummary.total).toBe(tickets.length);
    expect(d.selfHost.canaryPassed).toBe(3);
  });

  it("emits bilingual markdown with matching figures", () => {
    const d = buildRunDigestReport({ ...base, repoId: "repo_a", windowHours: 24 });
    expect(d.markdownEn).toContain("Run Digest");
    expect(d.markdownEn).toContain("Window: last 24h");
    expect(d.markdownEn).toContain("saved 1m 0s");
    expect(d.markdownZh).toContain("运行摘要");
    expect(d.markdownZh).toContain("时间窗口：最近 24 小时");
    expect(d.markdownZh).toContain("回滚");
    expect(d.markdownEn).toContain("| claude |");
    expect(d.markdownZh).toContain("| codex |");
  });

  it("produces a valid empty digest", () => {
    const d = buildRunDigestReport({
      windowHours: 24,
      tickets: [],
      stageRuns: [],
      flightEvents: [],
      now: NOW,
    });
    expect(d.ticketSummary.total).toBe(0);
    expect(d.engines).toHaveLength(4);
    expect(d.markdownEn).toContain("(none)");
    expect(d.markdownZh).toContain("（无）");
  });
});
