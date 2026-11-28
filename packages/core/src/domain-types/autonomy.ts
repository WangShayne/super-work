import type { EnginePreference, ReasoningEffort, WorkerEngineId } from "./engine.ts";
import type { EpicDecompositionPlan } from "./epic.ts";
import type { EpicDeliveryMode, PipelineTemplateId } from "./pipeline.ts";
import type { ControlProbeStep } from "./probe.ts";
import type { DeliveryGatePolicy, RefactorGuardConfig } from "./review.ts";
import type { Ticket } from "./ticket.ts";

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

export type RequirementRouteKind = "single_ticket" | "epic_dag" | "goal_campaign";

export interface RequirementIntakeInput {
  repoId: string;
  requirement: string;
  title?: string;
  preferredRoute?: "auto" | RequirementRouteKind;
  preferredEngine?: EnginePreference;
  preferredModelId?: string;
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

export interface RequirementIntakeSingleSpec {
  description: string;
  template: PipelineTemplateId;
  tddMode: boolean;
  allowedPaths: string[];
  acceptanceCriteria: string[];
  priority: number;
  /** Inferred export-preserving hotspot refactor guard (see inferRefactorGuardFromRequirement). */
  refactorGuard?: RefactorGuardConfig;
}

export interface RequirementIntakeCampaignSpec {
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
}

export interface RequirementIntakePlan {
  route: RequirementRouteKind;
  confidence: number;
  rationale: string;
  title: string;
  summary: string;
  singleSpec?: RequirementIntakeSingleSpec;
  epicPlan?: EpicDecompositionPlan & {
    epicDeliveryMode: EpicDeliveryMode;
    releaseBarrier?: boolean;
  };
  campaignSpec?: RequirementIntakeCampaignSpec;
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
