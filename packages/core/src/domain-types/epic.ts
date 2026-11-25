import type { EnginePreference } from "./engine.ts";
import type { PipelineTemplateId } from "./pipeline.ts";
import type { ControlProbeStep } from "./probe.ts";

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
  probeSteps?: ControlProbeStep[];
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
