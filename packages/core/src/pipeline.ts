import type {
  PipelineTemplateId,
  RepoConfig,
  StageKind,
  TicketStatus,
  WorkerEngineId,
} from "./types.ts";

export interface PipelineTemplate {
  id: PipelineTemplateId;
  stages: StageKind[];
  requirePlanApproval: boolean;
  requireOutboxSignoff: boolean;
}

export const PIPELINE_TEMPLATES: Record<PipelineTemplateId, PipelineTemplate> = {
  fast: {
    id: "fast",
    stages: ["implement", "rebase"],
    requirePlanApproval: false,
    requireOutboxSignoff: false,
  },
  standard: {
    id: "standard",
    stages: ["plan", "implement", "review", "rebase"],
    requirePlanApproval: false,
    requireOutboxSignoff: false,
  },
  strict: {
    id: "strict",
    stages: ["plan", "implement", "review", "rebase"],
    requirePlanApproval: true,
    requireOutboxSignoff: true,
  },
};

export function getPipelineTemplate(id: PipelineTemplateId): PipelineTemplate {
  return PIPELINE_TEMPLATES[id];
}

export function getFirstStage(templateId: PipelineTemplateId): StageKind {
  return PIPELINE_TEMPLATES[templateId].stages[0]!;
}

export function getNextStage(templateId: PipelineTemplateId, current: StageKind): StageKind | null {
  const stages = PIPELINE_TEMPLATES[templateId].stages;
  const idx = stages.indexOf(current);
  if (idx === -1 || idx + 1 >= stages.length) {
    return null;
  }
  return stages[idx + 1]!;
}

export function statusForStage(stage: StageKind): TicketStatus {
  switch (stage) {
    case "plan":
      return "planning";
    case "implement":
      return "implementing";
    case "review":
      return "reviewing";
    case "rebase":
      return "rebasing";
  }
}

export function selectEngineForStage(
  repo: RepoConfig,
  stage: StageKind,
  explicitOverride?: WorkerEngineId,
): WorkerEngineId {
  if (explicitOverride) {
    return explicitOverride;
  }
  if (stage === "review") {
    return repo.preferredReviewEngine;
  }
  return repo.preferredImplementEngine;
}

export function getAlternateEngine(
  current: WorkerEngineId,
  available: WorkerEngineId[],
): WorkerEngineId | undefined {
  const preferenceOrder: WorkerEngineId[] =
    current === "claude"
      ? ["codex", "opencode", "mock"]
      : current === "codex"
        ? ["claude", "opencode", "mock"]
        : current === "opencode"
          ? ["claude", "codex", "mock"]
          : ["claude", "codex"];

  for (const candidate of preferenceOrder) {
    if (candidate !== current && available.includes(candidate)) {
      return candidate;
    }
  }
  return available.find((e) => e !== current);
}
