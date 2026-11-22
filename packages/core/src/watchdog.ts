import type { ControlPlaneLLM, WatchdogConfig } from "./ports.ts";
import type {
  Mandate,
  StageRun,
  Ticket,
  WatchdogDecision,
  WatchdogSignal,
  WorkerEngineId,
  WorkerStreamEvent,
} from "./types.ts";
import { normalizeErrorSignature } from "./utils.ts";

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  silenceTimeoutMs: 180_000,
  repeatedErrorThreshold: 3,
  oscillationWindow: 3,
  budgetBurnWarningRatio: 0.8,
  pollIntervalMs: 5_000,
};

export interface WatchdogTracker {
  stageRunId: string;
  ticketId: string;
  engine: WorkerEngineId;
  mandate: Mandate;
  startedAtMs: number;
  lastEventAtMs: number;
  consecutiveErrorCount: number;
  lastErrorSignature: string;
  diffHashes: string[];
  costUsd: number;
  toolCallCount: number;
  hasChangedFiles: boolean;
  recentEvents: WorkerStreamEvent[];
}

export class TwoTierWatchdog {
  private readonly config: WatchdogConfig;

  constructor(
    private readonly llm: ControlPlaneLLM,
    config?: Partial<WatchdogConfig>,
  ) {
    this.config = { ...DEFAULT_WATCHDOG_CONFIG, ...config };
  }

  createTracker(
    stageRun: StageRun,
    mandate: Mandate,
    nowMs = Date.now(),
  ): WatchdogTracker {
    return {
      stageRunId: stageRun.id,
      ticketId: stageRun.ticketId,
      engine: stageRun.engine,
      mandate,
      startedAtMs: nowMs,
      lastEventAtMs: nowMs,
      consecutiveErrorCount: 0,
      lastErrorSignature: "",
      diffHashes: [],
      costUsd: stageRun.costUsd,
      toolCallCount: 0,
      hasChangedFiles: false,
      recentEvents: [],
    };
  }

  recordEvent(
    tracker: WatchdogTracker,
    event: WorkerStreamEvent,
    nowMs = Date.now(),
  ): void {
    tracker.lastEventAtMs = nowMs;
    tracker.recentEvents.push(event);
    if (tracker.recentEvents.length > 30) {
      tracker.recentEvents.shift();
    }

    switch (event.type) {
      case "tool_use":
        tracker.toolCallCount += 1;
        break;
      case "tool_result":
        if (event.isError) {
          this.pushErrorSignature(tracker, `${event.toolName}:${event.outputSummary}`);
        } else {
          tracker.consecutiveErrorCount = 0;
          tracker.lastErrorSignature = "";
        }
        break;
      case "error":
        this.pushErrorSignature(tracker, event.message);
        break;
      case "usage":
        tracker.costUsd = Math.max(tracker.costUsd, event.costUsd);
        break;
      case "completed":
        if (typeof event.costUsd === "number") {
          tracker.costUsd = Math.max(tracker.costUsd, event.costUsd);
        }
        break;
    }
  }

  recordDiffCheckpoint(tracker: WatchdogTracker, diffHash: string, hasFiles: boolean): void {
    tracker.hasChangedFiles = tracker.hasChangedFiles || hasFiles;
    if (!diffHash) return;
    const prev = tracker.diffHashes[tracker.diffHashes.length - 1];
    if (prev !== diffHash) {
      tracker.diffHashes.push(diffHash);
      if (tracker.diffHashes.length > 8) {
        tracker.diffHashes.shift();
      }
    }
  }

  evaluateL1(tracker: WatchdogTracker, nowMs = Date.now()): WatchdogSignal | null {
    const elapsedSec = Math.max(0, (nowMs - tracker.startedAtMs) / 1000);
    const silenceSec = Math.max(0, (nowMs - tracker.lastEventAtMs) / 1000);

    const makeSignal = (
      kind: WatchdogSignal["kind"],
      details: string,
    ): WatchdogSignal => ({
      kind,
      stageRunId: tracker.stageRunId,
      ticketId: tracker.ticketId,
      engine: tracker.engine,
      details,
      metrics: {
        elapsedSec,
        silenceSec,
        consecutiveErrors: tracker.consecutiveErrorCount,
        costUsd: tracker.costUsd,
        maxCostUsd: tracker.mandate.maxCostUsd,
        diffHashesCount: tracker.diffHashes.length,
      },
      detectedAt: new Date(nowMs).toISOString(),
    });

    if (
      tracker.costUsd > tracker.mandate.maxCostUsd ||
      elapsedSec > tracker.mandate.maxDurationSec
    ) {
      return makeSignal(
        "hard_budget_exceeded",
        `Budget or time ceiling exceeded (cost=$${tracker.costUsd.toFixed(3)}/$${tracker.mandate.maxCostUsd}, elapsed=${elapsedSec.toFixed(0)}s/${tracker.mandate.maxDurationSec}s)`,
      );
    }

    if (tracker.consecutiveErrorCount >= this.config.repeatedErrorThreshold) {
      return makeSignal(
        "repeated_error",
        `Detected ${tracker.consecutiveErrorCount} consecutive similar errors: ${tracker.lastErrorSignature}`,
      );
    }

    if (this.hasOscillation(tracker.diffHashes)) {
      return makeSignal(
        "diff_oscillation",
        `Worktree diff oscillated across recent checkpoints (${tracker.diffHashes.slice(-4).join(" -> ")})`,
      );
    }

    if (nowMs - tracker.lastEventAtMs > this.config.silenceTimeoutMs) {
      return makeSignal(
        "silence_timeout",
        `No worker stream activity for ${silenceSec.toFixed(0)}s (limit ${Math.round(this.config.silenceTimeoutMs / 1000)}s)`,
      );
    }

    if (
      tracker.mandate.maxCostUsd > 0 &&
      tracker.costUsd >= tracker.mandate.maxCostUsd * this.config.budgetBurnWarningRatio &&
      !tracker.hasChangedFiles &&
      tracker.toolCallCount > 0
    ) {
      return makeSignal(
        "budget_burn",
        `Spent $${tracker.costUsd.toFixed(3)} (${Math.round((tracker.costUsd / tracker.mandate.maxCostUsd) * 100)}% of budget) without producing file changes`,
      );
    }

    return null;
  }

  async evaluateAndDecide(input: {
    ticket: Ticket;
    stageRun: StageRun;
    signal: WatchdogSignal;
    recentEvents: WorkerStreamEvent[];
    availableEngines: WorkerEngineId[];
  }): Promise<WatchdogDecision> {
    if (input.signal.kind === "hard_budget_exceeded") {
      return {
        action: "ESCALATE_HUMAN",
        reason: input.signal.details,
      };
    }

    if (input.ticket.stageRetries >= input.ticket.mandate.maxStageRetries) {
      return {
        action: "ESCALATE_HUMAN",
        reason: `Exceeded max stage retries (${input.ticket.mandate.maxStageRetries}) after ${input.signal.kind}: ${input.signal.details}`,
      };
    }

    return this.llm.diagnoseWatchdog({
      ticket: input.ticket,
      stageRun: input.stageRun,
      signal: input.signal,
      recentEvents: input.recentEvents,
      availableEngines: input.availableEngines,
    });
  }

  private pushErrorSignature(tracker: WatchdogTracker, rawMessage: string): void {
    const sig = normalizeErrorSignature(rawMessage);
    if (!sig) return;
    if (sig === tracker.lastErrorSignature) {
      tracker.consecutiveErrorCount += 1;
    } else {
      tracker.lastErrorSignature = sig;
      tracker.consecutiveErrorCount = 1;
    }
  }

  private hasOscillation(hashes: string[]): boolean {
    if (hashes.length < this.config.oscillationWindow) return false;
    const len = hashes.length;
    // A -> B -> A pattern
    return hashes[len - 1] === hashes[len - 3] && hashes[len - 1] !== hashes[len - 2];
  }
}
