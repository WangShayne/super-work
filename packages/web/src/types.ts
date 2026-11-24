export type OperatingMode = "off" | "observe" | "auto";
export type WorkerEngineId = "claude" | "codex" | "opencode" | "mock";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type PipelineTemplateId = "fast" | "standard" | "strict";
export type StageKind = "plan" | "implement" | "review" | "rebase";
export type DeliveryChannel = "auto_pr_or_branch" | "local_merge" | "github_pr";
export type EpicDeliveryMode = "unified" | "per_subtask";

export type SmokeTriggerMode = "every_gate" | "delivery_only";

export type SandboxMode = "off" | "balanced" | "strict";

export interface BrowserCheckConfig {
  enabled: boolean;
  paths?: string[];
  viewportWidth?: number;
  viewportHeight?: number;
  waitForSelector?: string;
  failOnConsoleError?: boolean;
  timeoutMs?: number;
}

export interface SmokeCheckConfig {
  enabled: boolean;
  startCommand: string;
  readyUrl?: string;
  startupTimeoutSec?: number;
  checkCommands?: string[];
  triggerMode?: SmokeTriggerMode;
  browserCheck?: BrowserCheckConfig;
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
  previewCommand?: string;
  sandboxMode?: SandboxMode;
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

export interface RoutinePresetTemplate {
  id: string;
  nameZh: string;
  nameEn: string;
  descZh: string;
  descEn: string;
  scheduleKind: RoutineScheduleKind;
  cronExpr?: string;
  intervalMinutes?: number;
  activeHoursStart?: string;
  activeHoursEnd?: string;
  allowedPaths: string[];
  template: PipelineTemplateId;
  maxBudgetUsd: number;
  prompt: string;
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
  screenshotArtifactIds?: string[];
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

export interface NotificationConfig {
  macosEnabled: boolean;
  webhookEnabled: boolean;
  webhookUrl?: string;
  webhookSecret?: string;
  notifyOnInbox: boolean;
  notifyOnDelivery: boolean;
  notifyOnFailure: boolean;
  publicBaseUrl?: string;
  actionSecret?: string;
  githubWebhookSecret?: string;
  actionTtlMinutes?: number;
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
  previewCommand?: string;
  sandboxMode?: SandboxMode;
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
  inlineMemory: InlineMemory;
  handoverDigest?: HandoverDigest;
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
  kind: "transcript" | "diff" | "test_log" | "smoke_log" | "review_report" | "handover" | "screenshot";
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
    | "outbox_signoff"
    | "budget_cap"
    | "pr_followup"
    | "arena_tiebreak"
    | "epic_replan";
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

export type PreviewSessionStatus = "starting" | "ready" | "failed" | "stopped";

export interface PreviewSession {
  id: string;
  repoId: string;
  ticketId: string;
  candidateId?: string;
  label: string;
  worktreePath: string;
  command: string;
  port: number;
  url: string;
  status: PreviewSessionStatus;
  pid?: number;
  outputTail: string;
  error?: string;
  startedAt: string;
  expiresAt: string;
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
    activeRoutines?: number;
    activePreviews?: number;
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
  activePreview?: PreviewSession;
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

export interface TicketDetailResponse {
  ticket: Ticket;
  stageRuns: StageRun[];
  artifacts: SpillArtifact[];
  inboxItems: InboxItem[];
  outboxEntries: OutboxEntry[];
  diff: string;
  previews?: PreviewSession[];
  subtasks?: Ticket[];
  arenaCandidateDiffs?: Record<string, string>;
  upstreamDependencies?: Array<{
    id: string;
    repoId: string;
    repoName?: string;
    title: string;
    status: TicketStatus;
    handoverDigest?: HandoverDigest;
  }>;
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
    notifications?: Omit<
      NotificationConfig,
      "webhookSecret" | "actionSecret" | "githubWebhookSecret"
    > & {
      hasWebhookSecret: boolean;
      maskedWebhookSecret?: string;
      hasActionSecret: boolean;
      maskedActionSecret?: string;
      hasGithubWebhookSecret: boolean;
      maskedGithubWebhookSecret?: string;
    };
    updatedAt: string;
    hasApiKey: boolean;
    maskedApiKey?: string;
  };
  scanReport: CliScanReport;
}

export interface SpecClarificationQuestion {
  id: string;
  question: string;
  options: string[];
  recommendedIndex: number;
}

export interface SpecClarificationResult {
  ready: boolean;
  recommendedDispatchMode: "single" | "epic";
  recommendedTemplate: PipelineTemplateId;
  refinedTitle: string;
  refinedDescription: string;
  suggestedAllowedPaths: string[];
  acceptanceCriteria: string[];
  matchedFiles: string[];
  matchedCaseTitles: string[];
  questions: SpecClarificationQuestion[];
  rationale: string;
}

export interface LlmConnectionTestResult {
  ok: boolean;
  providerName: string;
  latencyMs: number;
  message: string;
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
