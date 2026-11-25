import type { ReasoningEffort, WorkerEngineId } from "./engine.ts";
import type { StageKind } from "./pipeline.ts";
import type { ControlProbeStep } from "./probe.ts";
import type { ReviewFinding } from "./review.ts";
import type { Mandate } from "./ticket.ts";
import type { SandboxMode } from "./verification.ts";

export interface WorkerClarificationRequest {
  question: string;
  options: string[];
  recommendedOption: string;
  context?: string;
}

export type WorkerStreamEvent =
  | { type: "session_started"; nativeSessionId: string; timestamp: string }
  | { type: "thought"; text: string; timestamp: string }
  | { type: "tool_use"; toolName: string; inputSummary: string; timestamp: string }
  | { type: "tool_result"; toolName: string; isError: boolean; outputSummary: string; timestamp: string }
  | { type: "text"; text: string; timestamp: string }
  | { type: "usage"; costUsd: number; inputTokens?: number; outputTokens?: number; timestamp: string }
  | {
      type: "completed";
      summary: string;
      costUsd?: number;
      structuredOutput?: {
        approved?: boolean;
        feedback?: string;
        planSummary?: string;
        changedFiles?: string[];
        verificationPassed?: boolean;
        reviewFindings?: ReviewFinding[];
        clarificationRequest?: WorkerClarificationRequest;
      };
      timestamp: string;
    }
  | { type: "error"; message: string; fatal?: boolean; timestamp: string };

export interface WorkerTurnInput {
  ticketId: string;
  stageRunId: string;
  stage: StageKind;
  worktreePath: string;
  prompt: string;
  mandate: Mandate;
  nativeSessionId?: string;
  isResume: boolean;
  model?: string;
  effort?: ReasoningEffort;
  sandboxMode?: SandboxMode;
  rootRepoPath?: string;
  readOnlyPaths?: string[];
}

export type WatchdogSignalKind =
  | "silence_timeout"
  | "repeated_error"
  | "diff_oscillation"
  | "budget_burn"
  | "hard_budget_exceeded";

export interface WatchdogSignal {
  kind: WatchdogSignalKind;
  stageRunId: string;
  ticketId: string;
  engine: WorkerEngineId;
  details: string;
  metrics: {
    elapsedSec: number;
    silenceSec: number;
    consecutiveErrors: number;
    costUsd: number;
    maxCostUsd: number;
    diffHashesCount: number;
  };
  detectedAt: string;
}

export type WatchdogAction = "CONTINUE" | "INJECT_HINT" | "SWITCH_ENGINE" | "ESCALATE_HUMAN";

export interface WatchdogDecision {
  action: WatchdogAction;
  reason: string;
  hint?: string;
  targetEngine?: WorkerEngineId;
  probeSteps?: ControlProbeStep[];
}
