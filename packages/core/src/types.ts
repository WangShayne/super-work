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

export type EpicDeliveryMode = "unified" | "per_subtask";

export type SmokeTriggerMode = "every_gate" | "delivery_only";

export interface SmokeCheckConfig {
  enabled: boolean;
  startCommand: string;
  readyUrl?: string;
  startupTimeoutSec?: number;
  checkCommands?: string[];
  triggerMode?: SmokeTriggerMode;
}

export interface SmokeCheckResult {
  ok: boolean;
  port: number;
  readyUrl: string;
  startupDurationMs: number;
  probeStatus?: number;
  checkResults: VerificationCommandOutput[];
  serverOutputTail: string;
  failedStep?: string;
  summary: string;
}

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
  smokeResult?: SmokeCheckResult;
}

export interface HandoverDigest {
  ticketId: string;
  repoId: string;
  repoName?: string;
  title: string;
  summary: string;
  changedFiles: string[];
  exportedSymbols: string[];
  contractSnippets: string[];
  formattedMarkdown: string;
  version: number;
  generatedAt: string;
}

export interface EpicSubtaskSpec {
  key: string;
  repoId?: string;
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

export interface SharedPlaybookRuleSpec {
  id?: string;
  rule: string;
  scopePaths?: string[];
  pinned?: boolean;
}

export interface RepoContractFile {
  version?: 1;
  defaultTemplate?: PipelineTemplateId;
  verificationCommands?: string[];
  setupCommands?: string[];
  smokeCheck?: SmokeCheckConfig;
  forbiddenPaths?: string[];
  conventions?: string;
  playbook?: SharedPlaybookRuleSpec[];
}

export type RoutineScheduleKind = "interval" | "cron";

export type RoutineRunStatus =
  | "probing"
  | "clean"
  | "promoted"
  | "skipped_overlap"
  | "skipped_budget"
  | "failed";

export interface RoutineSpec {
  id: string;
  repoId: string;
  name: string;
  prompt: string;
  scheduleKind: RoutineScheduleKind;
  intervalMinutes?: number;
  cronExpr?: string;
  activeHoursStart?: string;
  activeHoursEnd?: string;
  allowedPaths: string[];
  template: PipelineTemplateId;
  preferredEngine?: WorkerEngineId;
  maxBudgetUsd: number;
  enabled: boolean;
  activeTicketId?: string;
  lastRunAt?: string;
  lastRunStatus?: RoutineRunStatus;
  nextRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RoutineRun {
  id: string;
  routineId: string;
  repoId: string;
  status: RoutineRunStatus;
  summary: string;
  changedFiles: string[];
  promotedTicketId?: string;
  costUsd: number;
  startedAt: string;
  completedAt?: string;
}

export interface ArenaCandidateResult {
  candidateId: string;
  engine: WorkerEngineId;
  branchName: string;
  worktreePath?: string;
  stageRunId: string;
  verificationPassed: boolean;
  verificationSummary: string;
  changedFiles: string[];
  addedLines: number;
  deletedLines: number;
  durationMs: number;
  costUsd: number;
  summary: string;
  diffArtifactId?: string;
  score: number;
  recommended?: boolean;
  rationale?: string;
}

export type EpicReplanMutationKind = "update_subtask" | "add_subtask" | "skip_subtask";

export interface EpicReplanMutation {
  kind: EpicReplanMutationKind;
  targetSubtaskKey?: string;
  targetTicketId?: string;
  title?: string;
  description?: string;
  allowedPaths?: string[];
  acceptanceCriteria?: string[];
  dependsOnKeys?: string[];
  repoId?: string;
  template?: PipelineTemplateId;
  reason: string;
}

export interface EpicReplanProposal {
  shouldReplan: boolean;
  requiresHumanApproval: boolean;
  summary: string;
  triggeredByTicketId: string;
  mutations: EpicReplanMutation[];
  createdAt: string;
}

export type PlaybookSource = "human" | "auto_healed" | "repo_contract";

export type PlaybookHealthStatus = "healthy" | "stale" | "zombie_path" | "suspect";

export interface PlaybookEntry {
  id: string;
  repoId: string;
  rule: string;
  scopePaths: string[];
  source: PlaybookSource;
  sourceTicketId?: string;
  enabled: boolean;
  pinned: boolean;
  hitCount?: number;
  lastMatchedAt?: string;
  suspect?: boolean;
  healthStatus?: PlaybookHealthStatus;
  prunable?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CasebookEntry {
  id: string;
  repoId: string;
  ticketId: string;
  title: string;
  goalSummary: string;
  solutionSummary: string;
  pitfallsAndFixes?: string;
  changedFiles: string[];
  scopePaths: string[];
  exportedSymbols: string[];
  reverted: boolean;
  hitCount: number;
  lastMatchedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type ReviewSeverity = "blocker" | "major" | "nit";

export interface ReviewFinding {
  severity: ReviewSeverity;
  file?: string;
  line?: number;
  message: string;
  suggestion?: string;
}

export interface ReviewReport {
  verdict: "approved" | "changes_requested";
  summary: string;
  findings: ReviewFinding[];
  reviewedByEngine: WorkerEngineId;
  createdAt: string;
}

export interface RevertResult {
  ok: boolean;
  revertCommitSha?: string;
  conflictFiles?: string[];
  error?: string;
}

export interface NotificationConfig {
  macosEnabled: boolean;
  webhookEnabled: boolean;
  webhookUrl?: string;
  webhookSecret?: string;
  notifyOnInbox: boolean;
  notifyOnDelivery: boolean;
  notifyOnFailure: boolean;
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
  fallbackEngines?: WorkerEngineId[];
  autoCleanupWorktree?: boolean;
  verificationCommands?: string[];
  setupCommands?: string[];
  smokeCheck?: SmokeCheckConfig;
  forbiddenPaths?: string[];
  conventions?: string;
  contractSyncedHash?: string;
  contractSyncedAt?: string;
  defaultDeliveryChannel?: DeliveryChannel;
  maxConcurrentWorkers?: number;
  dailyBudgetUsd?: number;
  dailyBudgetOverrideUsd?: number;
  dailyBudgetOverrideDate?: string;
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
  reviewFindings?: ReviewFinding[];
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
  epicDeliveryMode?: EpicDeliveryMode;
  prNumber?: number;
  prUrl?: string;
  prAutoFollowupCount?: number;
  mergedCommitSha?: string;
  revertedAt?: string;
  revertCommitSha?: string;
  pendingViolationPaths?: string[];
  worktreePath?: string;
  branchName?: string;
  worktreeCleanedAt?: string;
  nativeSessions: Partial<Record<WorkerEngineId, string>>;
  preferredEngine?: WorkerEngineId;
  activeEngine?: WorkerEngineId;
  failedEngines?: WorkerEngineId[];
  arenaMode?: boolean;
  arenaCompetitorEngine?: WorkerEngineId;
  arenaCandidates?: ArenaCandidateResult[];
  arenaWinnerId?: string;
  routineId?: string;
  epicReplanCount?: number;
  epicReplanHistory?: EpicReplanProposal[];
  pendingEpicReplan?: EpicReplanProposal;
  modelOverride?: string;
  effortOverride?: ReasoningEffort;
  inlineMemory: InlineMemory;
  handoverDigest?: HandoverDigest;
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

export type ArtifactKind =
  | "transcript"
  | "diff"
  | "test_log"
  | "smoke_log"
  | "review_report"
  | "handover";

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
  | "outbox_signoff"
  | "budget_cap"
  | "pr_followup"
  | "arena_tiebreak"
  | "epic_replan";

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
        reviewFindings?: ReviewFinding[];
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
  matchedCases?: CasebookEntry[];
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
    }
  | {
      type: "playbook_updated";
      repoId: string;
      entry?: PlaybookEntry;
      deletedId?: string;
      timestamp: string;
    }
  | {
      type: "routine_updated";
      repoId: string;
      routine?: RoutineSpec;
      deletedId?: string;
      timestamp: string;
    }
  | {
      type: "routine_run_updated";
      repoId: string;
      routineId: string;
      run: RoutineRun;
      timestamp: string;
    }
  | {
      type: "casebook_updated";
      repoId: string;
      entry: CasebookEntry;
      timestamp: string;
    }
  | {
      type: "epic_replanned";
      repoId: string;
      epicId: string;
      proposal: EpicReplanProposal;
      autoApplied: boolean;
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
  notifications?: NotificationConfig;
  updatedAt: string;
}

export interface PublicSetupStatus {
  initialized: boolean;
  activeLlmProvider: string;
  config: Omit<SystemSetupConfig, "llmApiKey" | "notifications"> & {
    hasApiKey: boolean;
    maskedApiKey?: string;
    notifications?: Omit<NotificationConfig, "webhookSecret"> & {
      hasWebhookSecret: boolean;
      maskedWebhookSecret?: string;
    };
  };
  scanReport: CliScanReport;
}

export interface EngineMetricRow {
  engine: WorkerEngineId;
  runs: number;
  completedRuns: number;
  failedRuns: number;
  totalCostUsd: number;
  avgDurationMs: number;
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
}
