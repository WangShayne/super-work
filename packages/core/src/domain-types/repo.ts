import type { EnginePreference, OperatingMode, WorkerEngineId } from "./engine.ts";
import type { DeliveryChannel, PipelineTemplateId } from "./pipeline.ts";
import type { DeliveryGatePolicy } from "./review.ts";
import type { LifecycleHooksConfig, SandboxMode, SmokeCheckConfig, VerificationStrategy, VisualDiffMode } from "./verification.ts";

export interface SharedPlaybookRuleSpec {
  id?: string;
  rule: string;
  scopePaths?: string[];
  pinned?: boolean;
}

export interface RepoContractFile {
  version?: 1;
  defaultMode?: OperatingMode;
  defaultDeliveryChannel?: DeliveryChannel;
  defaultTemplate?: PipelineTemplateId;
  defaultTddMode?: boolean;
  deliveryGatePolicy?: DeliveryGatePolicy;
  riskThreshold?: number;
  sensitivePaths?: string[];
  verificationCommands?: string[];
  verificationStrategy?: VerificationStrategy;
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
  verificationStrategy?: VerificationStrategy;
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
