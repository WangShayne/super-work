import { describe, expect, it } from "bun:test";
import {
  DEFAULT_ENGINE_COOLDOWN_MS,
  buildRunDigestReport,
  classifyEngineError,
  isEngineTripped,
  pickNextFallbackEngine,
  selectEngineForStage,
  selectReviewEngine,
  type EngineHealthRecord,
  type FlightEvent,
  type RepoConfig,
} from "../src/index.ts";

function makeRepo(overrides?: Partial<RepoConfig>): RepoConfig {
  const ts = "2026-11-23T00:00:00.000Z";
  return {
    id: "repo_1",
    name: "demo",
    rootPath: "/tmp/demo",
    baseBranch: "main",
    mode: "auto",
    defaultTemplate: "standard",
    preferredImplementEngine: "claude",
    preferredReviewEngine: "codex",
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

function tripped(cooldownUntil: string | undefined): EngineHealthRecord {
  return {
    engine: "claude",
    status: "tripped",
    failureKind: "model_unsupported",
    cooldownUntil,
    consecutiveFailures: 1,
    updatedAt: "2026-11-25T00:00:00.000Z",
  };
}

describe("v1.5.0 engine circuit breaker", () => {
  it("classifies deterministic vs transient errors", () => {
    expect(classifyEngineError("The model is not supported for this account")).toEqual({
      kind: "model_unsupported",
      deterministic: true,
    });
    expect(classifyEngineError("IneligibleTierError: upgrade")?.kind).toBe("tier_ineligible");
    expect(classifyEngineError("invalid_api_key")?.kind).toBe("auth_invalid");
    expect(classifyEngineError("Unauthorized")?.deterministic).toBe(true);
    expect(classifyEngineError("Not authenticated, run login")?.kind).toBe("auth_invalid");
    expect(classifyEngineError("Quota exceeded for project")?.kind).toBe("quota_exhausted");
    expect(classifyEngineError("billing issue")?.kind).toBe("quota_exhausted");
    expect(classifyEngineError("ECONNRESET while streaming")).toEqual({
      kind: "transient",
      deterministic: false,
    });
    expect(classifyEngineError("something odd happened")).toBeNull();
    expect(classifyEngineError("")).toBeNull();
  });

  it("isEngineTripped honours the 30 minute cooldown", () => {
    expect(DEFAULT_ENGINE_COOLDOWN_MS).toBe(30 * 60_000);
    const now = Date.parse("2026-11-25T12:00:00.000Z");
    const rec = tripped(new Date(now + DEFAULT_ENGINE_COOLDOWN_MS).toISOString());
    expect(isEngineTripped(rec, now)).toBe(true);
    expect(isEngineTripped(rec, now + DEFAULT_ENGINE_COOLDOWN_MS - 1)).toBe(true);
    expect(isEngineTripped(rec, now + DEFAULT_ENGINE_COOLDOWN_MS)).toBe(false);
    expect(isEngineTripped(tripped(undefined), now)).toBe(false);
    expect(isEngineTripped({ ...rec, status: "healthy" }, now)).toBe(false);
    expect(isEngineTripped(null, now)).toBe(false);
    expect(isEngineTripped(undefined, now)).toBe(false);
  });

  it("selectEngineForStage skips tripped engines but never empties the pool", () => {
    const repo = makeRepo();
    expect(selectEngineForStage(repo, "implement", undefined, ["claude"])).toBe("codex");
    expect(selectEngineForStage(repo, "implement", undefined, [])).toBe("claude");
    expect(selectEngineForStage(repo, "implement", undefined, ["claude", "codex", "gemini", "opencode"])).toBe(
      "claude",
    );
  });

  it("selectReviewEngine avoids tripped engines with a safe fallback", () => {
    const repo = makeRepo();
    const base = { repo, implementEngine: "claude" as const, availableEngines: ["claude", "codex", "gemini"] as const };
    expect(selectReviewEngine({ ...base, availableEngines: [...base.availableEngines] })).toBe("codex");
    expect(
      selectReviewEngine({ ...base, availableEngines: [...base.availableEngines], trippedEngines: ["codex"] }),
    ).toBe("gemini");
    // All real engines tripped: the pool is not emptied.
    expect(
      selectReviewEngine({
        ...base,
        availableEngines: [...base.availableEngines],
        trippedEngines: ["claude", "codex", "gemini"],
      }),
    ).toBe("codex");
  });

  it("pickNextFallbackEngine skips tripped engines and falls back when all are tripped", () => {
    const repo = makeRepo();
    const input = {
      currentEngine: "claude" as const,
      repo,
      availableEngines: ["claude", "codex", "gemini"] as ("claude" | "codex" | "gemini")[],
    };
    expect(pickNextFallbackEngine(input)).toBe("codex");
    expect(pickNextFallbackEngine({ ...input, trippedEngines: ["codex"] })).toBe("gemini");
    expect(pickNextFallbackEngine({ ...input, trippedEngines: ["codex", "gemini"] })).toBe("codex");
  });

  it("digest counts engine_tripped / spillover_quarantined events", () => {
    const ts = "2026-11-25T10:00:00.000Z";
    const ev = (id: string, kind: FlightEvent["kind"]): FlightEvent => ({
      id,
      kind,
      summary: kind,
      createdAt: ts,
    });
    const d = buildRunDigestReport({
      windowHours: 0,
      tickets: [],
      stageRuns: [],
      flightEvents: [ev("a", "engine_tripped"), ev("b", "engine_tripped"), ev("c", "spillover_quarantined")],
      now: ts,
    });
    expect(d.selfHost.engineTripped).toBe(2);
    expect(d.selfHost.spilloverQuarantined).toBe(1);
    expect(d.markdownEn).toContain("2 engine trips");
    expect(d.markdownZh).toContain("引擎熔断 2 次");
  });
});
