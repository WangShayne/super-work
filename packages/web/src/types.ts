export type OperatingMode = "off" | "observe" | "auto";
export type WorkerEngineId = "claude" | "codex" | "opencode" | "mock";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type PipelineTemplateId = "fast" | "standard" | "strict";
export type StageKind = "plan" | "implement" | "review" | "rebase";
export type DeliveryChannel = "auto_pr_or_branch" | "local_merge" | "github_pr";

export interface EpicSubtaskSpec {
  key: string;
  title: string;
  description: string;
  template: PipelineTemplateId;
  allowedPaths: string[];
  dependsOnKeys: string[];
  acceptanceCriteria: string[];
}

export interface EpicDecompositionPlan {
  epicTitle: string;
  summary: string;
  subtasks: EpicSubtaskSpec[];
}

export interface EngineModelProfile {
  model?: string;
  effort?: ReasoningEffort;
}

export type TicketStatus =
  | "triaging"
  | "proposed"
  | "queued"
  | "waiting_deps"
  | "planning"
  | "awaiting_plan_approval"
  | "implementing"
  | "reviewing"
  | "rebasing"
  | "watchdog_intervention"
  | "needs_human"
  | "outbox_pending"
  | "delivered"
  | "failed"
  | "cancelled";

export interface RepoConfig {
  id: string;
  name: string;
  rootPath: string;
  baseBranch: string;
  mode: OperatingMode;
  githubRepo?: string;
  defaultTemplate: PipelineTemplateId;
  preferredImplementEngine: WorkerEngineId;
  preferredReviewEngine: WorkerEngineId;
  autoCleanupWorktree?: boolean;
  verificationCommands?: string[];
  defaultDeliveryChannel?: DeliveryChannel;
  createdAt: string;
  updatedAt: string;
}

export interface Mandate {
  allowedPaths: string[];
  forbiddenPaths: string[];
  allowNetwork: boolean;
  allowExternalSideEffects: false;
  maxCostUsd: number;
  maxDurationSec: number;
  maxStageRetries: number;
}

export interface InlineStageNote {
  stageRunId: string;
  stage: StageKind;
  engine: WorkerEngineId;
  summary: string;
  changedFiles: string[];
  verificationPassed: boolean;
  reviewApproved?: boolean;
  spillArtifactIds: string[];
  createdAt: string;
}

export interface InlineMemory {
  goal: string;
  acceptanceCriteria: string[];
  planSummary?: string;
  stageNotes: InlineStageNote[];
  threadUpdates: Array<{ triggerId: string; message: string; createdAt: string }>;
  activeHint?: string;
}

export interface Ticket {
  id: string;
  repoId: string;
  threadId: string;
  sourceTriggerId: string;
  title: string;
  description: string;
  status: TicketStatus;
  template: PipelineTemplateId;
  currentStage: StageKind;
  stageRetries: number;
  mandate: Mandate;
  dependsOn: string[];
  parentTicketId?: string;
  isEpic?: boolean;
  subtaskKey?: string;
  worktreePath?: string;
  branchName?: string;
  worktreeCleanedAt?: string;
  nativeSessions: Partial<Record<WorkerEngineId, string>>;
  activeEngine?: WorkerEngineId;
  inlineMemory: InlineMemory;
  costUsd: number;
  priority: number;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StageRun {
  id: string;
  ticketId: string;
  stage: StageKind;
  engine: WorkerEngineId;
  status: "running" | "completed" | "failed" | "aborted";
  nativeSessionId?: string;
  costUsd: number;
  startedAt: string;
  completedAt?: string;
  summary?: string;
  spillTranscriptId?: string;
}

export interface SpillArtifact {
  id: string;
  ticketId: string;
  stageRunId?: string;
  kind: "transcript" | "diff" | "test_log" | "review_report";
  summary: string;
  storageUri: string;
  byteSize: number;
  createdAt: string;
}

export interface InboxItem {
  id: string;
  repoId: string;
  ticketId: string;
  kind:
    | "observe_proposal"
    | "plan_approval"
    | "watchdog_escalation"
    | "mandate_violation"
    | "merge_conflict"
    | "outbox_signoff";
  status: "pending" | "approved" | "rejected";
  title: string;
  summary: string;
  contextPayload: Record<string, unknown>;
  resolutionNote?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface OutboxEntry {
  id: string;
  repoId: string;
  ticketId: string;
  action: "push_and_create_pr" | "local_merge" | "comment_issue" | "comment_pr";
  idempotencyKey: string;
  payload: Record<string, unknown>;
  status: "awaiting_approval" | "pending" | "processing" | "sent" | "failed" | "cancelled";
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
  resultPayload?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface HealthResponse {
  ok: boolean;
  llmProvider: string;
  availableEngines: WorkerEngineId[];
  counts: {
    repos: number;
    tickets: number;
    pendingInbox: number;
    pendingOutbox: number;
    activeWorktrees?: number;
    reclaimableWorktrees?: number;
  };
  timestamp: string;
}

export interface ManagedWorktreeItem {
  path: string;
  ticketId?: string;
  ticketTitle?: string;
  ticketStatus?: TicketStatus;
  repoId?: string;
  repoName?: string;
  branchName?: string;
  reclaimable: boolean;
  isOrphan: boolean;
}

export interface WorktreeGcResult {
  removedPaths: string[];
  cleanedTicketIds: string[];
  skippedActiveCount: number;
  timestamp: string;
}

export interface ChainOfRecall {
  trigger: {
    id: string;
    source: string;
    threadKey: string;
    title: string;
    rawText: string;
    createdAt: string;
  } | null;
  thread: {
    id: string;
    threadKey: string;
    subscribedTicketId?: string;
  } | null;
  ticket: Ticket;
  threadTriggers: Array<{
    id: string;
    source: string;
    title: string;
    rawText: string;
    createdAt: string;
  }>;
  stageRuns: StageRun[];
  artifacts: SpillArtifact[];
  relatedTickets: Array<{
    ticketId: string;
    title: string;
    status: TicketStatus;
    snippet: string;
  }>;
}

export interface MemorySearchHit {
  entityType: string;
  entityId: string;
  ticketId: string;
  repoId: string;
  title: string;
  snippet: string;
}

export interface TicketDetailResponse {
  ticket: Ticket;
  stageRuns: StageRun[];
  artifacts: SpillArtifact[];
  inboxItems: InboxItem[];
  outboxEntries: OutboxEntry[];
  diff: string;
}

export interface LiveEventLogEntry {
  id: string;
  ticketId: string;
  kind: string;
  summary: string;
  timestamp: string;
  raw?: unknown;
}

export type CliToolId = "claude" | "codex" | "opencode" | "gh" | "git" | "bun";

export interface DetectedCliTool {
  id: CliToolId;
  name: string;
  installed: boolean;
  binaryPath?: string;
  version?: string;
  authenticated: boolean | null;
  authSummary?: string;
  localDefaultModel?: string;
  localDefaultEffort?: string;
  workerSupported: boolean;
}

export interface CliScanReport {
  scannedAt: string;
  tools: DetectedCliTool[];
  recommendedImplementEngine: WorkerEngineId;
  recommendedReviewEngine: WorkerEngineId;
}

export type LlmProviderPreset =
  | "deepseek"
  | "openai"
  | "custom"
  | "claude_cli"
  | "codex_cli"
  | "heuristic";

export interface PublicSetupStatus {
  initialized: boolean;
  activeLlmProvider: string;
  config: {
    initialized: boolean;
    llmPreset: LlmProviderPreset;
    llmBaseUrl: string;
    llmModel: string;
    llmEffort?: ReasoningEffort;
    preferredImplementEngine: WorkerEngineId;
    preferredReviewEngine: WorkerEngineId;
    claudeProfile?: EngineModelProfile;
    codexProfile?: EngineModelProfile;
    opencodeProfile?: EngineModelProfile;
    updatedAt: string;
    hasApiKey: boolean;
    maskedApiKey?: string;
  };
  scanReport: CliScanReport;
}

export interface LlmConnectionTestResult {
  ok: boolean;
  providerName: string;
  latencyMs: number;
  message: string;
}
