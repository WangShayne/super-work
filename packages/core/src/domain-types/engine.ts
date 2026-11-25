export type OperatingMode = "off" | "observe" | "auto";

export type WorkerEngineId = "claude" | "codex" | "opencode" | "gemini" | "mock";

export type EnginePreference = WorkerEngineId | "auto";

export type TaskCategory = "ui" | "backend" | "refactor" | "test_ci" | "docs_chore";

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface EngineModelProfile {
  model?: string;
  effort?: ReasoningEffort;
}

export type EngineHealthStatus = "healthy" | "tripped";

export type EngineHealthFailureKind =
  | "model_unsupported"
  | "tier_ineligible"
  | "auth_invalid"
  | "quota_exhausted"
  | "transient";

export interface EngineHealthRecord {
  engine: WorkerEngineId;
  status: EngineHealthStatus;
  failureKind?: EngineHealthFailureKind;
  reason?: string;
  trippedAt?: string;
  cooldownUntil?: string;
  consecutiveFailures: number;
  lastProbedAt?: string;
  updatedAt: string;
}

// --- Flight Recorder & Run Digest (Direction D) ---
