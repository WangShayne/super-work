export type OperatingMode = "off" | "observe" | "auto";

export type WorkerEngineId = "claude" | "codex" | "opencode" | "gemini" | "api" | "mock";

export type EnginePreference = WorkerEngineId | "auto";

export type TaskCategory = "ui" | "backend" | "refactor" | "test_ci" | "docs_chore";

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type ApiWorkerPreset = "deepseek" | "openai" | "anthropic" | "custom";

export interface EngineModelProfile {
  model?: string;
  effort?: ReasoningEffort;
  baseUrl?: string;
  apiKey?: string;
}

export interface ApiWorkerProfile {
  preset: ApiWorkerPreset;
  baseUrl: string;
  model: string;
  apiKey?: string;
  effort?: ReasoningEffort;
}

// --- v1.8.1 Unified peer ModelProfile registry (CLI + API on equal footing) ---
export type ModelProfileKind = "cli" | "api";

export type CliEngineId = "claude" | "codex" | "opencode" | "gemini";

export type ApiModelProtocol = "deepseek" | "openai" | "anthropic" | "ollama";

export interface ModelProfile {
  id: string;
  name: string;
  kind: ModelProfileKind;
  cliEngine?: CliEngineId;
  apiProtocol?: ApiModelProtocol;
  baseUrl?: string;
  model?: string;
  effort?: ReasoningEffort;
  apiKey?: string;
  /** When false the profile is excluded from Worker 'auto' routing but stays usable as controlModelId. */
  workerAutoPool: boolean;
  enabled: boolean;
  builtinCli?: boolean;
}

/** v1.8.2 one entry from an upstream `/models` | `/model` listing. */
export interface DiscoveredModelItem {
  id: string;
  label?: string;
  ownedBy?: string;
}

export interface ModelDiscoveryResult {
  ok: boolean;
  models: DiscoveredModelItem[];
  endpoint?: string;
  latencyMs: number;
  message: string;
}

export type PublicModelProfile = Omit<ModelProfile, "apiKey"> & {
  hasApiKey: boolean;
  maskedApiKey?: string;
  ready: boolean;
  readyDetail?: string;
};

/** Profile with the raw apiKey replaced by presence flag + masked tail (safe for API responses). */
export type PublicEngineProfile<T extends { apiKey?: string }> = Omit<T, "apiKey"> & {
  hasApiKey: boolean;
  maskedApiKey?: string;
};

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
