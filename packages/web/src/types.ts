// Core domain types are re-exported (type-only) from @super-work/core/types; only Web-specific
// API response types and Web-adapted overrides are declared locally.
export type {
  OperatingMode,
  WorkerEngineId,
  EnginePreference,
  TaskCategory,
  ReasoningEffort,
  PipelineTemplateId,
  StageKind,
  DeliveryChannel,
  EpicDeliveryMode,
  SmokeTriggerMode,
  SandboxMode,
  VerificationStrategy,
  ScopedVerificationInfo,
  VerificationCommandOutput,
  VerificationRunResult,
  VisualDiffMode,
  BrowserInteractionStep,
  BrowserCheckConfig,
  SmokeCheckConfig,
  HandoverDigest,
  EpicSubtaskSpec,
  EpicDecompositionPlan,
  EngineModelProfile,
  TicketStatus,
  SharedPlaybookRuleSpec,
  LifecycleHooksConfig,
  RepoContractFile,
  RoutineScheduleKind,
  RoutineRunStatus,
  RoutineSpec,
  RoutineRun,
  ArenaCandidateResult,
  EpicReplanMutationKind,
  EpicReplanMutation,
  EpicReplanProposal,
  PlaybookSource,
  PlaybookHealthStatus,
  PlaybookEntry,
  CasebookEntry,
  ReviewSeverity,
  ReviewFinding,
  NotificationConfig,
  RepoConfig,
  Mandate,
  InlineStageNote,
  InlineMemory,
  RefactorGuardConfig,
  Ticket,
  ToolUsageStat,
  StageToolProfile,
  StageRun,
  SpillArtifact,
  WorkerClarificationRequest,
  InboxItem,
  OutboxEntry,
  PreviewSessionStatus,
  PreviewSession,
  ManagedWorktreeItem,
  WorktreeGcResult,
  ChainOfRecall,
  MemorySearchHit,
  SymbolImpactReport,
  TicketImpactSummary,
  TicketCheckpoint,
  RestoreCheckpointInput,
  DagNodeMutationInput,
  CliToolId,
  DetectedCliTool,
  CliScanReport,
  LlmProviderPreset,
  PublicSetupStatus,
  SpecClarificationQuestion,
  SpecClarificationResult,
  EngineMetricRow,
  EngineCategoryMetricRow,
  RepoMetricsSummary,
  DeliveryGatePolicy,
  RiskFactor,
  TicketRiskAssessment,
  ReviewCommentAuthor,
  ReviewCommentStatus,
  TicketReviewComment,
  SubmitReviewCommentsInput,
  StageSpanKind,
  StageSpan,
  TaskBlueprint,
  ConflictFileHunk,
  ConflictSemanticContext,
  DoctorCheckItem,
  CodeHotspotItem,
  SystemDoctorReport,
  BackupArchiveInfo,
  ControlProbeStep,
  ChiefActionSuggestion,
  ChiefAskResult,
  BatchResolveInboxResult,
  EvalCase,
  EvalCandidateRun,
  EvalRunRecord,
  BackupRestoreResult,
  RepoKnowledgeBundle,
  ImportKnowledgeBundleResult,
  CampaignDirection,
  CampaignDeliveryMode,
  CampaignStatus,
  CampaignWaveStatus,
  GoalCampaign,
  GoalCampaignWave,
  CreateCampaignInput,
  MergeTrainEntryStatus,
  MergeTrainEntry,
  ServiceDaemonStatus,
  RequirementRouteKind,
  RequirementIntakeInput,
  RequirementIntakePlan,
  RequirementIntakeResult,
  SelfReloadPhase,
  SelfReloadState,
  FlightEventKind,
  EngineHealthStatus,
  EngineHealthFailureKind,
  EngineHealthRecord,
  FlightEvent,
  RunDigestEngineBreakdown,
  RunDigestReport,
  MilestoneStatus,
  MilestoneItem,
  MilestoneIntegrationMode,
  Milestone,
  AutonomyPreset,
  InboxHumanAction,
  RepoAutoDetectResult,
  ApiWorkerPreset,
  ApiWorkerProfile,
  PublicEngineProfile,
  ModelProfile,
  PublicModelProfile,
  ModelProfileKind,
  CliEngineId,
  ApiModelProtocol,
} from "@super-work/core/types";

import type {
  ModelProfile as CoreModelProfile,
  ApiWorkerProfile as CoreApiWorkerProfile,
  EngineModelProfile as CoreEngineModelProfile,
  EnginePreference,
  HandoverDigest,
  InboxItem,
  MilestoneIntegrationMode,
  OutboxEntry,
  PipelineTemplateId,
  PreviewSession,
  RoutineScheduleKind,
  SelfReloadState,
  ServiceDaemonStatus,
  SpillArtifact,
  StageRun,
  Ticket,
  TicketCheckpoint,
  TicketReviewComment,
  TicketStatus,
  WorkerEngineId,
} from "@super-work/core/types";

export type { DiscoveredModelItem, ModelDiscoveryResult } from "@super-work/core/types";

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
  /** v1.8.3 structured presentation fields (optional for backward compatibility). */
  category?: LiveEventCategory;
  badge?: string;
  headline?: string;
  detail?: string;
  engine?: string;
  toolName?: string;
  isError?: boolean;
}

export type LiveEventCategory = "stage" | "thought" | "tool" | "output" | "gate" | "alert";

export interface LlmConnectionTestResult {
  ok: boolean;
  providerName: string;
  latencyMs: number;
  message: string;
}

export interface WorkerConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  message: string;
}

/** v1.8.1 peer ModelProfile patch: apiKey replaces the saved key, clearApiKey removes it. */
export type ModelProfilePatch = Partial<CoreModelProfile> & { clearApiKey?: boolean };

export interface ModelConnectionTestResult {
  ok: boolean;
  providerName: string;
  latencyMs: number;
  message: string;
}

/** CLI engine profile patch: apiKey replaces the saved key, clearApiKey removes it. */
export type EngineProfilePatch = CoreEngineModelProfile & { clearApiKey?: boolean };
export type ApiWorkerProfilePatch = Partial<CoreApiWorkerProfile> & { clearApiKey?: boolean };

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

export interface ServiceStatusResponse {
  status: ServiceDaemonStatus;
  logs: { logFilePath: string; exists: boolean; lines: string[] };
}

export interface CreateMilestoneInput {
  repoId: string;
  name: string;
  targetVersion?: string;
  requirements: string[];
  preferredEngine?: EnginePreference;
  preferredModelId?: string;
  template?: PipelineTemplateId;
  maxBudgetUsdPerItem?: number;
  integrationMode?: MilestoneIntegrationMode;
  preferredRoute?: "auto" | "single_ticket";
}
