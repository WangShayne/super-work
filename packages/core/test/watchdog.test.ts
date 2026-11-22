import { describe, expect, it } from "bun:test";
import { createDefaultMandate } from "../src/mandate.ts";
import type { ControlPlaneLLM } from "../src/ports.ts";
import type { StageRun, Ticket, WatchdogDecision } from "../src/types.ts";
import { TwoTierWatchdog } from "../src/watchdog.ts";

function makeFakeLlm(decision: WatchdogDecision): ControlPlaneLLM {
  return {
    providerName: "test-stub",
    async triageTrigger() {
      throw new Error("unused");
    },
    async diagnoseWatchdog() {
      return decision;
    },
  };
}

describe("TwoTierWatchdog L1 & L2 probes", () => {
  const mandate = createDefaultMandate({ maxCostUsd: 1.0, maxDurationSec: 300, maxStageRetries: 2 });
  const stageRun: StageRun = {
    id: "run_1",
    ticketId: "tkt_1",
    stage: "implement",
    engine: "claude",
    status: "running",
    costUsd: 0,
    startedAt: new Date(1000).toISOString(),
  };

  it("detects repeated_error at threshold without LLM call until L2", async () => {
    const wd = new TwoTierWatchdog(
      makeFakeLlm({ action: "SWITCH_ENGINE", reason: "stuck in error loop", targetEngine: "codex" }),
      { repeatedErrorThreshold: 3 },
    );
    const tracker = wd.createTracker(stageRun, mandate, 1000);

    for (let i = 0; i < 2; i++) {
      wd.recordEvent(
        tracker,
        { type: "tool_result", toolName: "Bash", isError: true, outputSummary: `Failed line ${i}`, timestamp: "" },
        2000 + i,
      );
      expect(wd.evaluateL1(tracker, 2000 + i)).toBeNull();
    }

    wd.recordEvent(
      tracker,
      { type: "tool_result", toolName: "Bash", isError: true, outputSummary: "Failed line 99", timestamp: "" },
      3000,
    );
    const sig = wd.evaluateL1(tracker, 3000);
    expect(sig).not.toBeNull();
    expect(sig!.kind).toBe("repeated_error");

    const ticket = { id: "tkt_1", stageRetries: 0, mandate } as Ticket;
    const dec = await wd.evaluateAndDecide({
      ticket,
      stageRun,
      signal: sig!,
      recentEvents: tracker.recentEvents,
      availableEngines: ["claude", "codex"],
    });
    expect(dec.action).toBe("SWITCH_ENGINE");
    expect(dec.targetEngine).toBe("codex");
  });

  it("detects A -> B -> A diff oscillation", () => {
    const wd = new TwoTierWatchdog(makeFakeLlm({ action: "INJECT_HINT", reason: "oscillating" }));
    const tracker = wd.createTracker(stageRun, mandate, 1000);

    wd.recordDiffCheckpoint(tracker, "hashA", true);
    expect(wd.evaluateL1(tracker, 2000)).toBeNull();
    wd.recordDiffCheckpoint(tracker, "hashB", true);
    expect(wd.evaluateL1(tracker, 2000)).toBeNull();
    wd.recordDiffCheckpoint(tracker, "hashA", true);

    const sig = wd.evaluateL1(tracker, 2000);
    expect(sig?.kind).toBe("diff_oscillation");
  });

  it("detects silence_timeout and hard_budget_exceeded and escalates when retries exhausted", async () => {
    const wd = new TwoTierWatchdog(makeFakeLlm({ action: "INJECT_HINT", reason: "try again" }), {
      silenceTimeoutMs: 5_000,
    });
    const tracker = wd.createTracker(stageRun, mandate, 0);
    const silenceSig = wd.evaluateL1(tracker, 6_000);
    expect(silenceSig?.kind).toBe("silence_timeout");

    wd.recordEvent(tracker, { type: "usage", costUsd: 1.2, timestamp: "" }, 6_100);
    const budgetSig = wd.evaluateL1(tracker, 6_200);
    expect(budgetSig?.kind).toBe("hard_budget_exceeded");

    const dec = await wd.evaluateAndDecide({
      ticket: { id: "tkt_1", stageRetries: 0, mandate } as Ticket,
      stageRun,
      signal: budgetSig!,
      recentEvents: [],
      availableEngines: ["claude"],
    });
    expect(dec.action).toBe("ESCALATE_HUMAN");
  });
});
