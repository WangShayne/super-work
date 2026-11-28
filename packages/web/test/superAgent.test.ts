import { describe, expect, it } from "bun:test";
import type { EngineHealthRecord, Ticket, WorkerEngineId } from "../src/types.ts";
import {
  AUTONOMY_PRESETS,
  normalizeAutonomyPreset,
  classifyInboxHumanAction,
  countHealthAlerts,
  headlineState,
  healthAlertReasons,
  humanTicketPhase,
  inferAutonomyPreset,
  formatScopeTokens,
  isSemver,
  parsePathList,
  selectMissions,
  stageIndex,
  withScopeTokens,
  type HealthInput,
} from "../src/utils/superAgent.ts";

const tripped = (engine: WorkerEngineId): EngineHealthRecord =>
  ({ engine, status: "tripped", consecutiveFailures: 3 }) as EngineHealthRecord;

const health = (over: Partial<HealthInput> = {}): HealthInput => ({
  sseOffline: false,
  availableEngines: ["claude", "codex", "gemini", "mock"],
  engineHealth: [],
  repo: { preferredImplementEngine: "auto" },
  ...over,
});

const ticket = (over: Partial<Ticket>): Ticket =>
  ({ id: "t", title: "t", status: "queued", updatedAt: new Date(0).toISOString(), ...over }) as Ticket;

describe("superAgent helpers", () => {
  it("classifies inbox kinds into 3 human verbs", () => {
    expect(classifyInboxHumanAction("outbox_signoff")).toBe("approve");
    expect(classifyInboxHumanAction("milestone_ready")).toBe("approve");
    expect(classifyInboxHumanAction("clarification_request")).toBe("answer");
    expect(classifyInboxHumanAction("epic_replan")).toBe("answer");
    expect(classifyInboxHumanAction("budget_cap")).toBe("unblock");
    expect(classifyInboxHumanAction("merge_conflict")).toBe("unblock");
  });

  it("infers autonomy preset", () => {
    expect(inferAutonomyPreset(undefined)).toBe("smart");
    expect(inferAutonomyPreset({ autonomyPreset: "guarded" })).toBe("guarded");
    expect(inferAutonomyPreset({ deliveryGatePolicy: "always_auto" })).toBe("autonomous");
    expect(inferAutonomyPreset({ deliveryGatePolicy: "always_signoff" })).toBe("guarded");
    expect(inferAutonomyPreset({ deliveryGatePolicy: "risk_gated" })).toBe("smart");
  });

  it("maps legacy preset names on unmigrated repos", () => {
    const legacy = (v: string) => ({ autonomyPreset: v }) as unknown as Parameters<typeof inferAutonomyPreset>[0];
    expect(inferAutonomyPreset(legacy("copilot"))).toBe("guarded");
    expect(inferAutonomyPreset(legacy("standard"))).toBe("smart");
    expect(inferAutonomyPreset(legacy("autopilot"))).toBe("autonomous");
    expect(normalizeAutonomyPreset("autopilot")).toBe("autonomous");
    expect(normalizeAutonomyPreset("smart")).toBe("smart");
    expect(normalizeAutonomyPreset("bogus")).toBeUndefined();
    expect(normalizeAutonomyPreset("toString")).toBeUndefined();
    expect(AUTONOMY_PRESETS).toEqual(["guarded", "smart", "autonomous"]);
  });

  it("maps ticket phases, alerts and parsing", () => {
    expect(humanTicketPhase("implementing")).toBe("working");
    expect(humanTicketPhase("needs_human")).toBe("attention");
    expect(humanTicketPhase("delivered")).toBe("done");
    expect(parsePathList("a/**, b\nc")).toEqual(["a/**", "b", "c"]);
    expect(isSemver("v1.8.0")).toBe(true);
    expect(isSemver("1.8")).toBe(false);
  });

  it("does not alarm when optional CLIs are tripped but a real engine is healthy", () => {
    const input = health({ engineHealth: [tripped("codex"), tripped("gemini")] });
    expect(healthAlertReasons(input)).toEqual([]);
    expect(countHealthAlerts(input)).toBe(0);
  });

  it("alerts when no healthy real engine remains", () => {
    const input = health({
      availableEngines: ["claude", "codex", "mock"],
      engineHealth: [tripped("claude"), tripped("codex")],
    });
    expect(healthAlertReasons(input)).toEqual(["no_healthy_engine"]);
  });

  it("treats a mock-only or engine-less setup as a setup state, not an alert", () => {
    expect(countHealthAlerts(health({ availableEngines: ["mock"] }))).toBe(0);
    expect(countHealthAlerts(health({ availableEngines: [] }))).toBe(0);
  });

  it("alerts on sse offline (grace period is applied by the caller)", () => {
    expect(healthAlertReasons(health({ sseOffline: true }))).toEqual(["sse_offline"]);
    expect(countHealthAlerts(health({ sseOffline: false }))).toBe(0);
  });

  it("treats the 'api' worker as a real engine for health alerts", () => {
    // api + mock only: api is a real engine, healthy → no alert
    expect(countHealthAlerts(health({ availableEngines: ["api", "mock"] }))).toBe(0);
    // sole real engine 'api' tripped → no healthy real engine left
    expect(
      healthAlertReasons(health({ availableEngines: ["api", "mock"], engineHealth: [tripped("api")] })),
    ).toEqual(["no_healthy_engine"]);
    // tripped api with a healthy CLI sibling → no alert
    expect(
      healthAlertReasons(health({ availableEngines: ["claude", "api", "mock"], engineHealth: [tripped("api")] })),
    ).toEqual([]);
    // pinned to api, tripped, no fallback → pinned_engine_down; healthy fallback silences it
    const pinnedApi = (fallbackEngines?: WorkerEngineId[]) =>
      health({
        availableEngines: ["claude", "api", "mock"],
        engineHealth: [tripped("api")],
        repo: { preferredImplementEngine: "api", fallbackEngines },
      });
    expect(healthAlertReasons(pinnedApi())).toEqual(["pinned_engine_down"]);
    expect(healthAlertReasons(pinnedApi(["claude"]))).toEqual([]);
  });

  it("alerts when the pinned engine is tripped and no fallback is healthy", () => {
    const pinned = (fallbackEngines?: WorkerEngineId[]) =>
      health({
        engineHealth: [tripped("codex")],
        repo: { preferredImplementEngine: "codex", fallbackEngines },
      });
    expect(healthAlertReasons(pinned())).toEqual(["pinned_engine_down"]);
    expect(healthAlertReasons(pinned(["claude"]))).toEqual([]);
    // Fallback that is itself tripped does not count as healthy.
    expect(
      healthAlertReasons(
        health({
          engineHealth: [tripped("codex"), tripped("gemini")],
          repo: { preferredImplementEngine: "codex", fallbackEngines: ["gemini"] },
        }),
      ),
    ).toEqual(["pinned_engine_down"]);
    // "auto" never raises the pinned alert, and a healthy pinned engine does not either.
    expect(
      healthAlertReasons(health({ engineHealth: [tripped("codex")], repo: { preferredImplementEngine: "auto" } })),
    ).toEqual([]);
    expect(healthAlertReasons(health({ repo: { preferredImplementEngine: "claude" } }))).toEqual([]);
  });

  it("maps core stages onto the 4-stage pipeline and derives the hero headline", () => {
    expect(stageIndex("plan")).toBe(0);
    expect(stageIndex("spec_test")).toBe(0);
    expect(stageIndex("implement")).toBe(1);
    expect(stageIndex("review")).toBe(2);
    expect(stageIndex("rebase")).toBe(3);
    expect(stageIndex(undefined)).toBe(-1);
    expect(headlineState(2, 3)).toBe("decision");
    expect(headlineState(0, 1)).toBe("executing");
    expect(headlineState(0, 0)).toBe("idle");
  });

  it("selects active/recent vs all missions, newest first", () => {
    const now = Date.parse("2026-01-02T00:00:00Z");
    const recent = new Date(now - 60_000).toISOString();
    const old = new Date(now - 24 * 3_600_000).toISOString();
    const tickets = [
      ticket({ id: "old-done", status: "delivered", updatedAt: old }),
      ticket({ id: "run", status: "implementing", updatedAt: old }),
      ticket({ id: "fresh-done", status: "delivered", updatedAt: recent }),
      ticket({ id: "epic-done", status: "delivered", isEpic: true, updatedAt: recent }),
    ];
    expect(selectMissions(tickets, "active", now).map((x) => x.id)).toEqual(["fresh-done", "run"]);
    // Epics that are delivered are hidden; ties on updatedAt keep input order (stable sort).
    expect(selectMissions(tickets, "all", now).map((x) => x.id)).toEqual(["fresh-done", "old-done", "run"]);
  });

  it("formats scope paths as explicit scope:<glob> tokens", () => {
    expect(formatScopeTokens(["packages/web/**", " scope:src/** ", "", "a b"])).toEqual([
      "scope:packages/web/**",
      "scope:src/**",
      "scope:ab",
    ]);
    expect(withScopeTokens("fix it", [])).toBe("fix it");
    expect(withScopeTokens("fix it", ["packages/web/**"])).toBe("fix it\n\nscope:packages/web/**");
  });
});
