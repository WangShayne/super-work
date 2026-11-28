import type { EnginePreference, ReasoningEffort, TaskCategory, WorkerEngineId } from "./engine.ts";
import type { EpicReplanProposal } from "./epic.ts";
import type { EpicDeliveryMode, PipelineTemplateId, StageKind, TicketStatus, TriggerSource } from "./pipeline.ts";
import type { DeliveryGatePolicy, RefactorGuardConfig, ReviewFinding, TicketRiskAssessment } from "./review.ts";

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

export interface LastFullVerificationSnapshot {
  treeSha: string;
  baseHeadSha: string;
  commands: string[];
  durationMs?: number;
  stageRunId: string;
  verifiedAt: string;
}

export interface InlineMemory {
  goal: string;
  acceptanceCriteria: string[];
  planSummary?: string;
  lastFullVerification?: LastFullVerificationSnapshot;
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
  /** v1.8.1: ModelProfile id requested by the user. */
  preferredModelId?: string;
  activeEngine?: WorkerEngineId;
  /** v1.8.1: ModelProfile id resolved by routing / pinned for this ticket. */
  activeModelId?: string;
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
  milestoneId?: string;
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
  /** v1.8.1: ModelProfile that served this run (undefined for legacy runs). */
  modelProfileId?: string;
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
  | "visual_diff"
  | "log";

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

export interface SteerTicketInput {
  instruction: string;
  preferredEngine?: EnginePreference;
  preferredModelId?: string;
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
  preferredModelId?: string;
  targetStage?: StageKind;
}

export interface DagNodeMutationInput {
  action?: "update" | "pause" | "resume" | "rerun";
  title?: string;
  description?: string;
  preferredEngine?: EnginePreference;
  preferredModelId?: string;
  allowedPaths?: string[];
  dependsOn?: string[];
  tddMode?: boolean;
  pauseBeforeRun?: boolean;
}
