export type OperatingMode = "off" | "observe" | "auto";

export type WorkerEngineId = "claude" | "codex" | "opencode" | "mock";

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface EngineModelProfile {
  model?: string;
  effort?: ReasoningEffort;
}

export type PipelineTemplateId = "fast" | "standard" | "strict";

export type StageKind = "plan" | "implement" | "review" | "rebase";

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

export type TriggerSource = "web" | "github_issue" | "github_pr" | "github_ci" | "cli";

export type DeliveryChannel = "auto_pr_or_branch" | "local_merge" | "github_pr";

export interface VerificationCommandOutput {
  command: string;
  exitCode: number;
  durationMs: number;
  output: string;
}

export interface VerificationRunResult {
  ok: boolean;
  results: VerificationCommandOutput[];
  failedCommand?: string;
  summary: string;
}

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

export interface Trigger {
  id: string;
  repoId: string;
  source: TriggerSource;
  externalRef?: string;
  threadKey: string;
  title: string;
  payload: Record<string, unknown>;
  rawText: string;
  createdAt: string;
}

export interface Thread {
  id: string;
  repoId: string;
  threadKey: string;
  subscribedTicketId?: string;
  metadata: Record<string, unknown>;
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

export interface ThreadUpdate {
  triggerId: string;
  message: string;
  createdAt: string;
}

export interface InlineMemory {
  goal: string;
  acceptanceCriteria: string[];
  planSummary?: string;
  stageNotes: InlineStageNote[];
  threadUpdates: ThreadUpdate[];
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
  preferredEngine?: WorkerEngineId;
  activeEngine?: WorkerEngineId;
  modelOverride?: string;
  effortOverride?: ReasoningEffort;
  inlineMemory: InlineMemory;
  costUsd: number;
  priority: number;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export type StageRunStatus = "running" | "completed" | "failed" | "aborted";

export interface StageRun {
  id: string;
  ticketId: string;
  stage: StageKind;
  engine: WorkerEngineId;
  status: StageRunStatus;
  nativeSessionId?: string;
  costUsd: number;
  startedAt: string;
  completedAt?: string;
  summary?: string;
  spillTranscriptId?: string;
}

export type ArtifactKind = "transcript" | "diff" | "test_log" | "review_report";

export interface SpillArtifact {
  id: string;
  ticketId: string;
  stageRunId?: string;
  kind: ArtifactKind;
  summary: string;
  storageUri: string;
  byteSize: number;
  createdAt: string;
}

export type InboxItemKind =
  | "observe_proposal"
  | "plan_approval"
  | "watchdog_escalation"
  | "mandate_violation"
  | "merge_conflict"
  | "outbox_signoff";

export type InboxItemStatus = "pending" | "approved" | "rejected";

export interface InboxItem {
  id: string;
  repoId: string;
  ticketId: string;
  kind: InboxItemKind;
  status: InboxItemStatus;
  title: string;
  summary: string;
  contextPayload: Record<string, unknown>;
  resolutionNote?: string;
  createdAt: string;
  resolvedAt?: string;
}

export type OutboxAction = "push_and_create_pr" | "local_merge" | "comment_issue" | "comment_pr";

export type OutboxStatus = "awaiting_approval" | "pending" | "processing" | "sent" | "failed" | "cancelled";

export interface OutboxEntry {
  id: string;
  repoId: string;
  ticketId: string;
  action: OutboxAction;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
  resultPayload?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
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
}

export interface TriageProposal {
  shouldCreateTicket: boolean;
  reason: string;
  title: string;
  description: string;
  template: PipelineTemplateId;
  allowedPaths: string[];
  acceptanceCriteria: string[];
  priority: number;
}

export interface ChainOfRecall {
  trigger: Trigger | null;
  thread: Thread | null;
  ticket: Ticket;
  threadTriggers: Trigger[];
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

export type KernelEvent =
  | { type: "repo_updated"; repo: RepoConfig; timestamp: string }
  | { type: "trigger_ingested"; trigger: Trigger; timestamp: string }
  | { type: "thread_routed"; ticketId: string; triggerId: string; message: string; timestamp: string }
  | { type: "ticket_created"; ticket: Ticket; timestamp: string }
  | { type: "ticket_updated"; ticket: Ticket; timestamp: string }
  | { type: "stage_started"; ticketId: string; stageRun: StageRun; timestamp: string }
  | { type: "worker_event"; ticketId: string; stageRunId: string; engine: WorkerEngineId; event: WorkerStreamEvent; timestamp: string }
  | { type: "stage_completed"; ticketId: string; stageRun: StageRun; note: InlineStageNote; timestamp: string }
  | { type: "watchdog_signal"; signal: WatchdogSignal; timestamp: string }
  | { type: "watchdog_decision"; ticketId: string; stageRunId: string; decision: WatchdogDecision; timestamp: string }
  | { type: "inbox_created"; item: InboxItem; timestamp: string }
  | { type: "inbox_resolved"; item: InboxItem; timestamp: string }
  | { type: "outbox_queued"; entry: OutboxEntry; timestamp: string }
  | { type: "outbox_sent"; entry: OutboxEntry; timestamp: string }
  | { type: "outbox_failed"; entry: OutboxEntry; timestamp: string }
  | { type: "worktrees_gc"; result: WorktreeGcResult; timestamp: string }
  | {
      type: "verification_completed";
      ticketId: string;
      stageRunId: string;
      result: VerificationRunResult;
      timestamp: string;
    };

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

export interface SystemSetupConfig {
  initialized: boolean;
  llmPreset: LlmProviderPreset;
  llmBaseUrl: string;
  llmModel: string;
  llmEffort?: ReasoningEffort;
  llmApiKey?: string;
  preferredImplementEngine: WorkerEngineId;
  preferredReviewEngine: WorkerEngineId;
  claudeProfile?: EngineModelProfile;
  codexProfile?: EngineModelProfile;
  opencodeProfile?: EngineModelProfile;
  updatedAt: string;
}

export interface PublicSetupStatus {
  initialized: boolean;
  activeLlmProvider: string;
  config: Omit<SystemSetupConfig, "llmApiKey"> & {
    hasApiKey: boolean;
    maskedApiKey?: string;
  };
  scanReport: CliScanReport;
}
