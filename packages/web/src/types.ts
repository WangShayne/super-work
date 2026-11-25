export type OperatingMode = "off" | "observe" | "auto";
export type WorkerEngineId = "claude" | "codex" | "opencode" | "gemini" | "mock";
export type EnginePreference = WorkerEngineId | "auto";
export type TaskCategory = "ui" | "backend" | "refactor" | "test_ci" | "docs_chore";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type PipelineTemplateId = "fast" | "standard" | "strict";
export type StageKind = "plan" | "spec_test" | "implement" | "review" | "rebase";
export type DeliveryChannel = "auto_pr_or_branch" | "local_merge" | "github_pr";
export type EpicDeliveryMode = "unified" | "per_subtask";

export type SmokeTriggerMode = "every_gate" | "delivery_only";

export type SandboxMode = "off" | "balanced" | "strict";

export type VerificationStrategy = "always_full" | "impact_scoped";

export interface ScopedVerificationInfo {
  usedScoped: boolean;
  commandsRun: string[];
  skippedFullCommands?: string[];
  estimatedSavedMs?: number;
  reason: string;
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
  scopedVerification?: ScopedVerificationInfo;
}

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
  tddMode?: boolean;
  preferredEngine?: EnginePreference;
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

export interface SharedPlaybookRuleSpec {
  id?: string;
  rule: string;
  scopePaths?: string[];
  pinned?: boolean;
}

export interface LifecycleHooksConfig {
  preDeliver?: string[];
  postDeliver?: string[];
  onEscalate?: string[];
  timeoutSec?: number;
}

export interface RepoContractFile {
  version?: 1;
  defaultTemplate?: PipelineTemplateId;
  defaultTddMode?: boolean;
  deliveryGatePolicy?: DeliveryGatePolicy;
  riskThreshold?: number;
  sensitivePaths?: string[];
  verificationCommands?: string[];
  verificationStrategy?: VerificationStrategy;
  setupCommands?: string[];
  smokeCheck?: SmokeCheckConfig;
  previewCommand?: string;
  sandboxMode?: SandboxMode;
  forbiddenPaths?: string[];
  conventions?: string;
  playbook?: SharedPlaybookRuleSpec[];
  blueprints?: TaskBlueprint[];
  hooks?: LifecycleHooksConfig;
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
  defaultTddMode?: boolean;
  deliveryGatePolicy?: DeliveryGatePolicy;
  riskThreshold?: number;
  sensitivePaths?: string[];
  blueprints?: TaskBlueprint[];
  hooks?: LifecycleHooksConfig;
  preferredImplementEngine: EnginePreference;
  preferredReviewEngine: WorkerEngineId;
  fallbackEngines?: WorkerEngineId[];
  autoCleanupWorktree?: boolean;
  verificationCommands?: string[];
  verificationStrategy?: VerificationStrategy;
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

export interface RefactorGuardConfig {
  targetHotspotPath?: string;
  maxLinesAfter?: number;
  enforceExportParity?: boolean;
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
  refactorGuard?: RefactorGuardConfig;
  lockedTestPaths?: string[];
  specTestCommitSha?: string;
  specTestChallengeCount?: number;
  taskCategory?: TaskCategory;
  routingRationale?: string;
  autoArenaEscalated?: boolean;
  impactSummary?: TicketImpactSummary;
  pauseBeforeRun?: boolean;
  routineId?: string;
  epicReplanCount?: number;
  epicReplanHistory?: EpicReplanProposal[];
  pendingEpicReplan?: EpicReplanProposal;
  blueprintId?: string;
  deliveryGatePolicy?: DeliveryGatePolicy;
  riskThreshold?: number;
  riskAssessment?: TicketRiskAssessment;
  conflictContext?: ConflictSemanticContext;
  conflictResolutionCount?: number;
  clarificationCount?: number;
  steerCount?: number;
  campaignId?: string;
  campaignWave?: number;
  targetBranch?: string;
  barrierGroupId?: string;
  baseHeadAtRebase?: string;
  inlineMemory: InlineMemory;
  handoverDigest?: HandoverDigest;
  costUsd: number;
  priority: number;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

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
  status: "running" | "completed" | "failed" | "aborted";
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

export interface SpillArtifact {
  id: string;
  ticketId: string;
  stageRunId?: string;
  kind:
    | "transcript"
    | "diff"
    | "test_log"
    | "smoke_log"
    | "review_report"
    | "handover"
    | "screenshot"
    | "visual_diff";
  summary: string;
  storageUri: string;
  byteSize: number;
  createdAt: string;
}

export interface WorkerClarificationRequest {
  question: string;
  options: string[];
  recommendedOption: string;
  context?: string;
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
    | "epic_replan"
    | "clarification_request"
    | "campaign_paused"
    | "milestone_ready";
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
    activeCampaigns?: number;
    queuedMergeTrain?: number;
  };
  selfReload?: SelfReloadState;
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

export interface TicketDetailResponse {
  ticket: Ticket;
  stageRuns: StageRun[];
  artifacts: SpillArtifact[];
  inboxItems: InboxItem[];
  outboxEntries: OutboxEntry[];
  diff: string;
  previews?: PreviewSession[];
  checkpoints?: TicketCheckpoint[];
  reviewComments?: TicketReviewComment[];
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

export type CliToolId = "claude" | "codex" | "opencode" | "gemini" | "gh" | "git" | "bun";

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
    geminiProfile?: EngineModelProfile;
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
  side: "new" | "old";
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
  summaryNote?: string;
  comments: Array<{
    filePath: string;
    line: number;
    side?: "new" | "old";
    codeSnippet?: string;
    severity?: ReviewSeverity;
    body: string;
  }>;
  statusUpdates?: Array<{ id: string; status: ReviewCommentStatus }>;
}

export type StageSpanKind =
  | "workspace_prep"
  | "worker_turn"
  | "static_verify"
  | "smoke_cdp"
  | "visual_diff"
  | "git_ops";

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
  visualDiffMode?: VisualDiffMode;
  deliveryGatePolicy?: DeliveryGatePolicy;
  riskThreshold?: number;
  allowedPaths?: string[];
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

export interface PlaybookHygieneReport {
  repoId?: string;
  total: number;
  healthy: number;
  noisyCount: number;
  noisyEntries: Array<{
    id: string;
    rule: string;
    source: "human" | "auto_healed" | "repo_contract";
    hitCount: number;
    enabled: boolean;
    reasons: string[];
  }>;
}

export interface PlaybookHygienePruneResult {
  audited: PlaybookHygieneReport;
  affectedIds: string[];
  mode: "disable" | "delete";
  dryRun: boolean;
}

export interface DoctorCheckItem {
  id: string;
  category: "sqlite" | "worktree" | "preview" | "git_ref" | "code" | "playbook";
  status: "ok" | "warn" | "error";
  title: string;
  detail: string;
  fixable: boolean;
  fixed?: boolean;
  count?: number;
}

export interface CodeHotspotItem {
  filePath: string;
  lineCount: number;
  exportedSymbolCount: number;
  dependentCount: number;
  packageDir: string;
  repoId?: string;
}

export interface SystemDoctorReport {
  healthy: boolean;
  checkedAt: string;
  fixesApplied: number;
  items: DoctorCheckItem[];
  hotspots?: CodeHotspotItem[];
}

export interface BackupArchiveInfo {
  id: string;
  filename: string;
  filePath: string;
  byteSize: number;
  createdAt: string;
  dbIntegrityOk?: boolean;
}

export interface ControlProbeStep {
  step: number;
  tool: "search_symbols" | "read_file_slice" | "grep_literals" | "git_recent_commits";
  inputSummary: string;
  outputSummary: string;
  matchedPaths: string[];
  durationMs: number;
}

export interface ChiefActionSuggestion {
  id: string;
  kind:
    | "dispatch_ticket"
    | "batch_resolve_inbox"
    | "steer_ticket"
    | "run_doctor"
    | "create_backup"
    | "open_ticket";
  label: string;
  description: string;
  payload: Record<string, unknown>;
}

export interface ChiefAskResult {
  answer: string;
  highlights: string[];
  probeSteps?: ControlProbeStep[];
  suggestedActions: ChiefActionSuggestion[];
  generatedAt: string;
}

export interface BatchResolveInboxResult {
  resolvedCount: number;
  skippedCount: number;
  results: Array<{ inboxId: string; ticketId: string; status: "pending" | "approved" | "rejected" }>;
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
  referenceMetrics?: {
    durationMs?: number;
    costUsd?: number;
    engine?: WorkerEngineId;
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

export type CampaignDirection = "increase" | "decrease";
export type CampaignDeliveryMode = "staging_branch" | "per_wave_merge";
export type CampaignStatus = "idle" | "running" | "paused" | "completed" | "delivered" | "failed";
export type CampaignWaveStatus = "running" | "improved" | "unchanged" | "regressed" | "failed";

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

export interface ServiceStatusResponse {
  status: ServiceDaemonStatus;
  logs: { logFilePath: string; exists: boolean; lines: string[] };
}

export type RequirementRouteKind = "single_ticket" | "epic_dag" | "goal_campaign";

export interface RequirementIntakeInput {
  repoId: string;
  requirement: string;
  title?: string;
  preferredRoute?: "auto" | RequirementRouteKind;
  preferredEngine?: EnginePreference;
  template?: PipelineTemplateId;
  tddMode?: boolean;
  deliveryGatePolicy?: DeliveryGatePolicy;
  maxBudgetUsd?: number;
  previewOnly?: boolean;
  metricCommand?: string;
  metricRegex?: string;
  metricUnit?: string;
  direction?: CampaignDirection;
  targetValue?: number;
  modelOverride?: string;
  effortOverride?: ReasoningEffort;
}

export interface RequirementIntakePlan {
  route: RequirementRouteKind;
  confidence: number;
  rationale: string;
  title: string;
  summary: string;
  singleSpec?: {
    description: string;
    template: PipelineTemplateId;
    tddMode: boolean;
    allowedPaths: string[];
    acceptanceCriteria: string[];
    priority: number;
  };
  epicPlan?: EpicDecompositionPlan & {
    epicDeliveryMode: EpicDeliveryMode;
    releaseBarrier?: boolean;
  };
  campaignSpec?: {
    name: string;
    goalPrompt: string;
    metricCommand: string;
    metricRegex?: string;
    metricUnit?: string;
    direction: CampaignDirection;
    targetValue: number;
    deliveryMode: CampaignDeliveryMode;
    allowedPaths: string[];
    maxIterations: number;
    maxTotalBudgetUsd: number;
  };
  probeSteps?: ControlProbeStep[];
}

export interface RequirementIntakeResult {
  route: RequirementRouteKind;
  plan: RequirementIntakePlan;
  ticket?: Ticket;
  epic?: Ticket;
  subtasks?: Ticket[];
  campaign?: GoalCampaign;
}

export type SelfReloadPhase =
  | "idle"
  | "building"
  | "canary_probing"
  | "draining"
  | "reloading"
  | "rolled_back"
  | "failed";

export interface SelfReloadState {
  phase: SelfReloadPhase;
  selfRepoRoot?: string;
  ticketId?: string;
  commitSha?: string;
  revertCommitSha?: string;
  canaryPort?: number;
  canaryDurationMs?: number;
  activeRunsRemaining?: number;
  summary?: string;
  error?: string;
  updatedAt: string;
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
  | "spillover_quarantined";

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
  gateReuse?: { reusedRuns: number; totalSavedMs: number };
  resilience?: { engineTrips: number; spilloverQuarantines: number };
  selfHost: {
    canaryPassed: number;
    reloadsCompleted: number;
    canaryRolledBack: number;
    watchdogSwitches: number;
  };
  engines: RunDigestEngineBreakdown[];
  events: FlightEvent[];
  markdownZh: string;
  markdownEn: string;
}

// --- Milestone Backlog Waves & Controlled Release (v1.4.0 Direction B) ---

export type MilestoneStatus = "active" | "ready_to_release" | "released" | "cancelled";

export interface MilestoneItem {
  id: string;
  index: number;
  requirement: string;
  title: string;
  route: RequirementRouteKind;
  ticketId?: string;
  epicId?: string;
  campaignId?: string;
  waveIndex: number;
  allowedPaths: string[];
  dependsOnIndices: number[];
  status: "pending" | "running" | "delivered" | "failed" | "needs_human";
  summary?: string;
}

export type MilestoneIntegrationMode = "direct_main" | "milestone_branch";

export interface Milestone {
  id: string;
  repoId: string;
  name: string;
  targetVersion?: string;
  integrationMode?: MilestoneIntegrationMode;
  stagingBranch?: string;
  status: MilestoneStatus;
  items: MilestoneItem[];
  releaseNotesZh?: string;
  releaseNotesEn?: string;
  digestSummary?: string;
  releasedCommitSha?: string;
  releasedTag?: string;
  githubReleaseUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMilestoneInput {
  repoId: string;
  name: string;
  targetVersion?: string;
  requirements: string[];
  preferredEngine?: EnginePreference;
  template?: PipelineTemplateId;
  maxBudgetUsdPerItem?: number;
  integrationMode?: MilestoneIntegrationMode;
  preferredRoute?: "auto" | "single_ticket";
}
