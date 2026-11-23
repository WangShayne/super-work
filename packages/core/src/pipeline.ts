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

export function selectReviewEngine(input: {
  repo: RepoConfig;
  implementEngine: WorkerEngineId;
  availableEngines: WorkerEngineId[];
  explicitWatchdogEngine?: WorkerEngineId;
}): WorkerEngineId {
  const { repo, implementEngine, availableEngines, explicitWatchdogEngine } = input;
  if (explicitWatchdogEngine && availableEngines.includes(explicitWatchdogEngine)) {
    return explicitWatchdogEngine;
  }

  const realAvailable = availableEngines.filter((e) => e !== "mock");

  if (implementEngine !== "mock") {
    if (
      repo.preferredReviewEngine !== "mock" &&
      repo.preferredReviewEngine !== implementEngine &&
      realAvailable.includes(repo.preferredReviewEngine)
    ) {
      return repo.preferredReviewEngine;
    }

    const altReal = getAlternateEngine(implementEngine, realAvailable);
    if (altReal) {
      return altReal;
    }

    if (realAvailable.includes(implementEngine)) {
      // Single real-engine environment: run an isolated blind review session on the same engine
      return implementEngine;
    }
  }

  if (availableEngines.includes(repo.preferredReviewEngine)) {
    return repo.preferredReviewEngine;
  }
  return availableEngines[0] ?? repo.preferredReviewEngine;
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
