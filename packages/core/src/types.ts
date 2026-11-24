export type OperatingMode = "off" | "observe" | "auto";

export type WorkerEngineId = "claude" | "codex" | "opencode" | "mock";

export type EnginePreference = WorkerEngineId | "auto";

export type TaskCategory = "ui" | "backend" | "refactor" | "test_ci" | "docs_chore";

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface EngineModelProfile {
  model?: string;
  effort?: ReasoningEffort;
}

export type PipelineTemplateId = "fast" | "standard" | "strict";

export type StageKind = "plan" | "spec_test" | "implement" | "review" | "rebase";

export type TicketStatus =
  | "triaging"
  | "proposed"
  | "queued"
  | "waiting_deps"
  | "planning"
  | "spec_testing"
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

export type SandboxMode = "off" | "balanced" | "strict";

export type VisualDiffMode = "off" | "auto" | "enforce" | "informational";

export interface BrowserInteractionStep {
  action: "click" | "fill" | "press" | "waitForSelector" | "waitForText";
  selector?: string;
  value?: string;
  timeoutMs?: number;
}

export interface BrowserCheckConfig {
  enabled: boolean;
  paths?: string[];
  viewportWidth?: number;
  viewportHeight?: number;
  waitForSelector?: string;
  failOnConsoleError?: boolean;
  timeoutMs?: number;
  steps?: BrowserInteractionStep[];
  visualDiffMode?: VisualDiffMode;
  maxVisualDiffRatio?: number;
}

export interface BrowserRouteCheckResult {
  path: string;
  url: string;
  ok: boolean;
  status?: number;
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  stepErrors?: string[];
  missingSelector?: string;
  screenshotArtifactId?: string;
  diffRatio?: number;
  visualDiffArtifactId?: string;
  baselineMatched?: boolean;
  durationMs: number;
}

export interface BrowserCheckSummary {
  executed: boolean;
  skippedReason?: string;
  ok: boolean;
  routes: BrowserRouteCheckResult[];
  summary: string;
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
  browserResult?: BrowserCheckSummary;
  rawScreenshots?: Array<{ routeIndex: number; path: string; bytes: Uint8Array }>;
  rawVisualDiffs?: Array<{ routeIndex: number; path: string; diffRatio: number; bytes: Uint8Array }>;
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
  tddMode?: boolean;
  preferredEngine?: EnginePreference;
  allowedPaths: string[];
  dependsOnKeys: string[];
  acceptanceCriteria: string[];
}

export type ControlProbeToolName =
  | "search_symbols"
  | "read_file_slice"
  | "grep_literals"
  | "git_recent_commits";

export interface ControlProbeRequest {
  tool: ControlProbeToolName;
  path?: string;
  query?: string;
  startLine?: number;
  endLine?: number;
  limit?: number;
}

export interface ControlProbeStep {
  step: number;
  tool: ControlProbeToolName;
  inputSummary: string;
  outputSummary: string;
  matchedPaths: string[];
  durationMs: number;
}

export interface RepoProbeContextPack {
  deterministicSummary: string;
  matchedFiles: string[];
  recentCommits: string[];
  probeSteps: ControlProbeStep[];
}

export interface EpicDecompositionPlan {
  epicTitle: string;
  summary: string;
  subtasks: EpicSubtaskSpec[];
  probeSteps?: ControlProbeStep[];
}

export interface SharedPlaybookRuleSpec {
  id?: string;
  rule: string;
  scopePaths?: string[];
  pinned?: boolean;
}

export type LifecycleHookEvent = "pre_deliver" | "post_deliver" | "on_escalate";

export interface LifecycleHooksConfig {
  preDeliver?: string[];
  postDeliver?: string[];
  onEscalate?: string[];
  timeoutSec?: number;
}

export interface HookExecutionRecord {
  event: LifecycleHookEvent;
  ok: boolean;
  results: VerificationCommandOutput[];
  failedCommand?: string;
  summary: string;
  executedAt: string;
}

export interface RepoContractFile {
  version?: 1;
  defaultTemplate?: PipelineTemplateId;
  defaultTddMode?: boolean;
  deliveryGatePolicy?: DeliveryGatePolicy;
  riskThreshold?: number;
  sensitivePaths?: string[];
  verificationCommands?: string[];
  setupCommands?: string[];
  hooks?: LifecycleHooksConfig;
  smokeCheck?: SmokeCheckConfig;
  previewCommand?: string;
  sandboxMode?: SandboxMode;
  forbiddenPaths?: string[];
  conventions?: string;
  playbook?: SharedPlaybookRuleSpec[];
  blueprints?: TaskBlueprint[];
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
  screenshotArtifactIds?: string[];
  visualDiffArtifactIds?: string[];
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
  publicBaseUrl?: string;
  actionSecret?: string;
  githubWebhookSecret?: string;
  actionTtlMinutes?: number;
}

export type DeliveryGatePolicy = "always_auto" | "risk_gated" | "always_signoff";

export interface RiskFactor {
  key: string;
  label: string;
  delta: number;
  detail?: string;
}

export interface TicketRiskAssessment {
  score: number;
  level: "low" | "medium" | "high";
  requiresSignoff: boolean;
  threshold: number;
  policy: DeliveryGatePolicy;
  factors: RiskFactor[];
  evaluatedAt: string;
}

export type ReviewCommentAuthor = "human" | "ai";

export type ReviewCommentStatus = "open" | "resolved" | "dismissed";

export interface TicketReviewComment {
  id: string;
  ticketId: string;
  repoId: string;
  filePath: string;
  line: number;
  side?: "new" | "old";
  codeSnippet?: string;
  author: ReviewCommentAuthor;
  severity?: ReviewSeverity;
  body: string;
  status: ReviewCommentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SubmitReviewCommentsInput {
  mode: "comment_only" | "request_changes";
  comments?: Array<{
    filePath: string;
    line: number;
    side?: "new" | "old";
    codeSnippet?: string;
    severity?: ReviewSeverity;
    body: string;
  }>;
  statusUpdates?: Array<{
    id: string;
    status: ReviewCommentStatus;
  }>;
  summaryNote?: string;
}

export type StageSpanKind =
  | "workspace_prep"
  | "setup_warmup"
  | "worker_turn"
  | "static_verify"
  | "smoke_cdp"
  | "visual_diff"
  | "git_ops"
  | "conflict_resolve";

export interface StageSpan {
  kind: StageSpanKind;
  label: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: "ok" | "failed" | "skipped";
  detail?: string;
}

export interface TaskBlueprint {
  id: string;
  name: string;
  description: string;
  template: PipelineTemplateId;
  preferredEngine?: EnginePreference;
  tddMode?: boolean;
  allowedPaths?: string[];
  deliveryGatePolicy?: DeliveryGatePolicy;
  riskThreshold?: number;
  visualDiffMode?: VisualDiffMode;
  promptPrefix?: string;
  acceptanceCriteria?: string[];
  builtin?: boolean;
}

export interface ConflictFileHunk {
  filePath: string;
  oursSummary: string;
  theirsSummary: string;
}

export interface ConflictSemanticContext {
  baseBranch: string;
  mergeBaseSha: string;
  upstreamCommitSummaries: string[];
  conflictFiles: string[];
  fileHunks: ConflictFileHunk[];
  resolvedAutomatically?: boolean;
  resolutionSummary?: string;
}

export interface DoctorCheckItem {
  id: string;
  category: "sqlite" | "worktree" | "preview" | "git_ref";
  status: "ok" | "warn" | "error";
  title: string;
  detail: string;
  fixable: boolean;
  fixed?: boolean;
  count?: number;
}

export interface SystemDoctorReport {
  healthy: boolean;
  checkedAt: string;
  fixesApplied: number;
  items: DoctorCheckItem[];
}

export interface BackupArchiveInfo {
  id: string;
  filename: string;
  filePath: string;
  byteSize: number;
  createdAt: string;
  dbIntegrityOk?: boolean;
}

export interface BackupRestoreResult {
  ok: boolean;
  restoredBackup: BackupArchiveInfo;
  preRestoreSafetyBackup?: BackupArchiveInfo;
  integrityDetail: string;
  restoredAt: string;
}

export interface RepoKnowledgeBundle {
  version: 1;
  exportedAt: string;
  sourceRepoName: string;
  playbook: Array<{ rule: string; scopePaths: string[]; pinned: boolean }>;
  casebook: Array<{
    title: string;
    goalSummary: string;
    solutionSummary: string;
    pitfallsAndFixes?: string;
    changedFiles: string[];
    scopePaths: string[];
    exportedSymbols: string[];
    reverted: boolean;
  }>;
  blueprints: TaskBlueprint[];
}

export interface ImportKnowledgeBundleResult {
  importedPlaybook: number;
  importedCasebook: number;
  importedBlueprints: number;
  skippedDuplicates: number;
}

export interface RepoConfig {
  id: string;
  name: string;
  rootPath: string;
  baseBranch: string;
  mode: OperatingMode;
  githubRepo?: string;
  defaultTemplate: PipelineTemplateId;
  defaultTddMode?: boolean;
  deliveryGatePolicy?: DeliveryGatePolicy;
  riskThreshold?: number;
  sensitivePaths?: string[];
  blueprints?: TaskBlueprint[];
  preferredImplementEngine: EnginePreference;
  preferredReviewEngine: WorkerEngineId;
  fallbackEngines?: WorkerEngineId[];
  autoCleanupWorktree?: boolean;
  verificationCommands?: string[];
  setupCommands?: string[];
  hooks?: LifecycleHooksConfig;
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
  preferredEngine?: EnginePreference;
  activeEngine?: WorkerEngineId;
  failedEngines?: WorkerEngineId[];
  arenaMode?: boolean;
  arenaCompetitorEngine?: WorkerEngineId;
  arenaCandidates?: ArenaCandidateResult[];
  arenaWinnerId?: string;
  tddMode?: boolean;
  lockedTestPaths?: string[];
  specTestCommitSha?: string;
  specTestChallengeCount?: number;
  taskCategory?: TaskCategory;
  routingRationale?: string;
  autoArenaEscalated?: boolean;
  impactSummary?: TicketImpactSummary;
  pauseBeforeRun?: boolean;
  blueprintId?: string;
  deliveryGatePolicy?: DeliveryGatePolicy;
  riskThreshold?: number;
  riskAssessment?: TicketRiskAssessment;
  conflictResolutionCount?: number;
  conflictContext?: ConflictSemanticContext;
  clarificationCount?: number;
  steerCount?: number;
  routineId?: string;
  campaignId?: string;
  campaignWave?: number;
  targetBranch?: string;
  barrierGroupId?: string;
  baseHeadAtRebase?: string;
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

export interface ToolUsageStat {
  toolName: string;
  calls: number;
  errors: number;
  approxDurationMs: number;
  sampleError?: string;
}

export interface StageToolProfile {
  totalToolCalls: number;
  totalToolErrors: number;
  byTool: ToolUsageStat[];
}

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
  spans?: StageSpan[];
  toolProfile?: StageToolProfile;
  steered?: boolean;
}

export type ArtifactKind =
  | "transcript"
  | "diff"
  | "test_log"
  | "smoke_log"
  | "review_report"
  | "handover"
  | "screenshot"
  | "visual_diff";

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
  | "epic_replan"
  | "clarification_request"
  | "campaign_paused";

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

export interface WorkerClarificationRequest {
  question: string;
  options: string[];
  recommendedOption: string;
  context?: string;
}

export interface SteerTicketInput {
  instruction: string;
  preferredEngine?: EnginePreference;
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

export interface TriageProposal {
  shouldCreateTicket: boolean;
  reason: string;
  title: string;
  description: string;
  template: PipelineTemplateId;
  allowedPaths: string[];
  acceptanceCriteria: string[];
  priority: number;
  probeSteps?: ControlProbeStep[];
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
    }
  | {
      type: "preview_updated";
      preview: PreviewSession;
      timestamp: string;
    }
  | {
      type: "checkpoint_created";
      checkpoint: TicketCheckpoint;
      timestamp: string;
    }
  | {
      type: "review_comment_updated";
      ticketId: string;
      comments: TicketReviewComment[];
      timestamp: string;
    }
  | {
      type: "eval_run_updated";
      repoId: string;
      evalRun: EvalRunRecord;
      timestamp: string;
    }
  | {
      type: "campaign_updated";
      repoId: string;
      campaign?: GoalCampaign;
      wave?: GoalCampaignWave;
      deletedId?: string;
      timestamp: string;
    }
  | {
      type: "merge_train_updated";
      repoId: string;
      entries: MergeTrainEntry[];
      timestamp: string;
    }
  | {
      type: "lifecycle_hook_executed";
      repoId: string;
      ticketId: string;
      record: HookExecutionRecord;
      timestamp: string;
    };

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
    notifications?: Omit<NotificationConfig, "webhookSecret" | "actionSecret" | "githubWebhookSecret"> & {
      hasWebhookSecret: boolean;
      maskedWebhookSecret?: string;
      hasActionSecret: boolean;
      maskedActionSecret?: string;
      hasGithubWebhookSecret: boolean;
      maskedGithubWebhookSecret?: string;
    };
  };
  scanReport: CliScanReport;
}

export interface SpecClarificationQuestion {
  id: string;
  question: string;
  options: string[];
  recommendedIndex: number;
}

export interface SpecClarificationInput {
  repoId: string;
  title: string;
  description: string;
  template?: PipelineTemplateId;
  answers?: Record<string, string>;
}

export interface FileSymbolEntry {
  filePath: string;
  imports: string[];
  exportedSymbols: string[];
}

export interface SymbolImpactReport {
  targetFiles: string[];
  directDependents: string[];
  transitiveDependents: string[];
  neighborSignatures: Array<{
    filePath: string;
    relation: "target" | "direct_dependent" | "direct_import";
    symbols: string[];
  }>;
  contextPackMarkdown: string;
}

export interface TicketImpactSummary {
  directDependents: string[];
  transitiveDependents: string[];
  semanticDepTicketIds: string[];
}

export interface TicketCheckpoint {
  id: string;
  ticketId: string;
  repoId: string;
  stageRunId?: string;
  stage: StageKind | "baseline";
  engine?: WorkerEngineId;
  label: string;
  gitRef: string;
  commitSha: string;
  changedFiles: string[];
  verificationPassed?: boolean;
  createdAt: string;
  cleanedAt?: string;
}

export interface RestoreCheckpointInput {
  mode?: "in_place" | "fork";
  prompt?: string;
  preferredEngine?: EnginePreference;
  targetStage?: StageKind;
}

export interface DagNodeMutationInput {
  action?: "update" | "pause" | "resume" | "rerun";
  title?: string;
  description?: string;
  preferredEngine?: EnginePreference;
  allowedPaths?: string[];
  dependsOn?: string[];
  tddMode?: boolean;
  pauseBeforeRun?: boolean;
}

export interface SpecClarificationResult {
  ready: boolean;
  recommendedDispatchMode: "single" | "epic";
  recommendedTemplate: PipelineTemplateId;
  recommendedTddMode?: boolean;
  directDependents?: string[];
  transitiveDependents?: string[];
  refinedTitle: string;
  refinedDescription: string;
  suggestedAllowedPaths: string[];
  acceptanceCriteria: string[];
  matchedFiles: string[];
  matchedCaseTitles: string[];
  questions: SpecClarificationQuestion[];
  rationale: string;
  probeSteps?: ControlProbeStep[];
}

export type ChiefActionKind =
  | "dispatch_ticket"
  | "batch_resolve_inbox"
  | "steer_ticket"
  | "run_doctor"
  | "create_backup"
  | "open_ticket";

export interface ChiefActionSuggestion {
  id: string;
  kind: ChiefActionKind;
  label: string;
  description: string;
  payload: Record<string, unknown>;
}

export interface ChiefAskInput {
  repoId?: string;
  question: string;
}

export interface ChiefAskResult {
  answer: string;
  highlights: string[];
  probeSteps?: ControlProbeStep[];
  suggestedActions: ChiefActionSuggestion[];
  generatedAt: string;
}

export interface BatchResolveInboxInput {
  inboxIds?: string[];
  repoId?: string;
  kinds?: InboxItemKind[];
  onlyLowRisk?: boolean;
  decision: "approved" | "rejected";
  note?: string;
  deliveryAction?: "local_merge" | "push_and_create_pr";
}

export interface BatchResolveInboxResult {
  resolvedCount: number;
  skippedCount: number;
  results: Array<{ inboxId: string; ticketId: string; status: InboxItemStatus }>;
}

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

export type CampaignDirection = "increase" | "decrease";

export type CampaignDeliveryMode = "staging_branch" | "per_wave_merge";

export type CampaignStatus =
  | "idle"
  | "running"
  | "paused"
  | "completed"
  | "delivered"
  | "failed";

export type CampaignWaveStatus =
  | "running"
  | "improved"
  | "unchanged"
  | "regressed"
  | "failed";

export interface GoalCampaign {
  id: string;
  repoId: string;
  name: string;
  goalPrompt: string;
  metricCommand: string;
  metricRegex?: string;
  metricUnit?: string;
  direction: CampaignDirection;
  baselineValue?: number;
  currentValue?: number;
  targetValue: number;
  deliveryMode: CampaignDeliveryMode;
  stagingBranch?: string;
  lastGoodCommitSha?: string;
  allowedPaths: string[];
  template: PipelineTemplateId;
  preferredEngine?: EnginePreference;
  maxIterations: number;
  completedWaves: number;
  maxTotalBudgetUsd: number;
  totalCostUsd: number;
  consecutiveNoImproveCount: number;
  activeTicketId?: string;
  pauseReason?: string;
  deliveredPrUrl?: string;
  deliveredCommitSha?: string;
  status: CampaignStatus;
  createdAt: string;
  updatedAt: string;
}

export interface GoalCampaignWave {
  id: string;
  campaignId: string;
  repoId: string;
  waveNumber: number;
  ticketId?: string;
  status: CampaignWaveStatus;
  beforeValue: number;
  measuredValue?: number;
  delta?: number;
  commitSha?: string;
  rolledBack?: boolean;
  costUsd: number;
  summary: string;
  startedAt: string;
  completedAt?: string;
}

export interface CreateCampaignInput {
  repoId: string;
  name: string;
  goalPrompt: string;
  metricCommand: string;
  metricRegex?: string;
  metricUnit?: string;
  direction: CampaignDirection;
  targetValue: number;
  deliveryMode?: CampaignDeliveryMode;
  allowedPaths?: string[];
  template?: PipelineTemplateId;
  preferredEngine?: EnginePreference;
  maxIterations?: number;
  maxTotalBudgetUsd?: number;
  autoStart?: boolean;
}

export type MergeTrainEntryStatus =
  | "queued"
  | "barrier_waiting"
  | "validating"
  | "merged"
  | "ejected"
  | "barrier_blocked";

export interface MergeTrainEntry {
  id: string;
  repoId: string;
  ticketId: string;
  outboxId: string;
  branchName: string;
  baseBranch: string;
  barrierGroupId?: string;
  position: number;
  status: MergeTrainEntryStatus;
  bypassedSpeculation?: boolean;
  speculativeCommitSha?: string;
  mergedCommitSha?: string;
  errorSummary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceDaemonStatus {
  platform: "darwin" | "linux" | "unsupported";
  manager: "launchd" | "systemd" | "none";
  installed: boolean;
  running: boolean;
  pid?: number;
  serviceFilePath?: string;
  dataDir: string;
  host: string;
  port: number;
  logFilePath: string;
  logByteSize?: number;
  webUiBuilt: boolean;
  detail: string;
}
