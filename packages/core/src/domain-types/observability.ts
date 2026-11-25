import type { TaskCategory, WorkerEngineId } from "./engine.ts";
import type { SmokeCheckConfig } from "./verification.ts";

export interface EvalCase {
  id: string;
  repoId: string;
  sourceTicketId?: string;
  title: string;
  description: string;
  baseCommitSha: string;
  allowedPaths: string[];
  forbiddenPaths: string[];
  tddMode?: boolean;
  lockedTestPaths?: string[];
  verificationCommands: string[];
  smokeCheck?: SmokeCheckConfig;
  referenceMetrics?: {
    durationMs?: number;
    costUsd?: number;
    engine?: WorkerEngineId;
    addedLines?: number;
    deletedLines?: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface EvalCandidateRun {
  engine: WorkerEngineId;
  passed: boolean;
  verificationSummary: string;
  durationMs: number;
  costUsd: number;
  changedFiles: string[];
  addedLines: number;
  deletedLines: number;
  riskScore: number;
  error?: string;
}

export interface EvalRunRecord {
  id: string;
  evalCaseId: string;
  repoId: string;
  status: "running" | "completed" | "failed";
  engines: WorkerEngineId[];
  results: EvalCandidateRun[];
  maxBudgetUsd: number;
  totalCostUsd: number;
  startedAt: string;
  completedAt?: string;
}

export interface EngineMetricRow {
  engine: WorkerEngineId;
  runs: number;
  completedRuns: number;
  failedRuns: number;
  totalCostUsd: number;
  avgDurationMs: number;
}

export interface EngineCategoryMetricRow {
  engine: WorkerEngineId;
  category: TaskCategory;
  tickets: number;
  firstPassRate: number;
  deliveryRate: number;
  revertRate: number;
  avgCostUsd: number;
  compositeScore: number;
}

export interface RepoMetricsSummary {
  repoId?: string;
  todayDate: string;
  todayCostUsd: number;
  dailyBudgetUsd?: number;
  effectiveDailyBudgetUsd?: number;
  budgetExceeded: boolean;
  totalCostUsd: number;
  ticketCounts: {
    total: number;
    active: number;
    delivered: number;
    failed: number;
    cancelled: number;
    needsHuman: number;
  };
  deliveryRate: number;
  byEngine: EngineMetricRow[];
  engineMatrix?: EngineCategoryMetricRow[];
}

export type FlightEventKind =
  | "canary_passed"
  | "reload_completed"
  | "canary_rolled_back"
  | "scoped_gate_run"
  | "gate_reused"
  | "watchdog_switch"
  | "milestone_ready"
  | "milestone_released"
  | "engine_tripped"
  | "spillover_quarantined"
  | "flake_retried"
  | "watchdog_extended";

export interface FlightEvent {
  id: string;
  repoId?: string;
  ticketId?: string;
  kind: FlightEventKind;
  engine?: WorkerEngineId;
  summary: string;
  savedMs?: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface RunDigestEngineBreakdown {
  engine: WorkerEngineId;
  tickets: number;
  delivered: number;
  failedOrReverted: number;
  passRate: number;
  totalCostUsd: number;
  avgDurationMs: number;
}

export interface RunDigestReport {
  generatedAt: string;
  repoId?: string;
  windowHours: number;
  ticketSummary: {
    total: number;
    delivered: number;
    reverted: number;
    escalated: number;
    active: number;
    totalCostUsd: number;
  };
  gateSavings: { scopedRuns: number; totalSavedMs: number };
  /** Rebase-stage gate reuse (v1.6.0): `gate_reused` flight events. */
  gateReuse?: { reusedRuns: number; totalSavedMs: number };
  /** Engine/spillover resilience counters (v1.6.0). */
  resilience?: {
    engineTrips: number;
    spilloverQuarantines: number;
    /** Watchdog 2.0 adaptive extensions (v1.7.0); omitted when zero. */
    watchdogExtensions?: number;
    /** Single-flake gate retries (v1.7.0); omitted when zero. */
    flakeRetries?: number;
  };
  selfHost: {
    canaryPassed: number;
    reloadsCompleted: number;
    canaryRolledBack: number;
    watchdogSwitches: number;
    engineTripped: number;
    spilloverQuarantined: number;
  };
  engines: RunDigestEngineBreakdown[];
  events: FlightEvent[];
  markdownZh: string;
  markdownEn: string;
}

// --- Milestone Backlog Waves & Controlled Release (v1.4.0 Direction B) ---
