import type {
  EnginePreference,
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

export function getEffectiveStages(id: PipelineTemplateId, tddMode?: boolean): StageKind[] {
  const base = [...PIPELINE_TEMPLATES[id].stages];
  if (!tddMode) return base;
  const implIdx = base.indexOf("implement");
  if (implIdx === -1) {
    return ["spec_test", ...base];
  }
  base.splice(implIdx, 0, "spec_test");
  return base;
}

export function getFirstStage(templateId: PipelineTemplateId, tddMode?: boolean): StageKind {
  return getEffectiveStages(templateId, tddMode)[0]!;
}

export function getNextStage(
  templateId: PipelineTemplateId,
  current: StageKind,
  tddMode?: boolean,
): StageKind | null {
  const stages = getEffectiveStages(templateId, tddMode);
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
    case "spec_test":
      return "spec_testing";
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
  explicitOverride?: EnginePreference,
  trippedEngines?: WorkerEngineId[],
): WorkerEngineId {
  const base = selectEngineForStageBase(repo, stage, explicitOverride);
  if (!trippedEngines?.includes(base) || base === "mock") return base;
  // Skip a tripped engine: prefer a healthy real engine in default order, else keep the original.
  const healthy = (["claude", "codex", "gemini", "opencode"] as WorkerEngineId[]).find(
    (e) => e !== base && !trippedEngines.includes(e),
  );
  return healthy ?? base;
}

function selectEngineForStageBase(
  repo: RepoConfig,
  stage: StageKind,
  explicitOverride?: EnginePreference,
): WorkerEngineId {
  if (explicitOverride && explicitOverride !== "auto") {
    return explicitOverride;
  }
  if (stage === "review") {
    return repo.preferredReviewEngine;
  }
  if (repo.preferredImplementEngine !== "auto") {
    return repo.preferredImplementEngine;
  }
  return repo.preferredReviewEngine === "mock" ? "mock" : "claude";
}

export function selectReviewEngine(input: {
  repo: RepoConfig;
  implementEngine: WorkerEngineId;
  availableEngines: WorkerEngineId[];
  explicitWatchdogEngine?: WorkerEngineId;
  trippedEngines?: WorkerEngineId[];
}): WorkerEngineId {
  const { repo, implementEngine, explicitWatchdogEngine } = input;
  const tripped = input.trippedEngines ?? [];
  const healthyAvailable = input.availableEngines.filter((e) => e === "mock" || !tripped.includes(e));
  // Never leave the pool without a real engine: if all real engines are tripped, use the full list.
  const availableEngines = healthyAvailable.some((e) => e !== "mock")
    ? healthyAvailable
    : input.availableEngines;
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
      ? ["codex", "gemini", "opencode", "mock"]
      : current === "codex"
        ? ["claude", "gemini", "opencode", "mock"]
        : current === "gemini"
          ? ["codex", "claude", "opencode", "mock"]
          : current === "opencode"
            ? ["claude", "codex", "gemini", "mock"]
            : ["claude", "codex", "gemini"];

  for (const candidate of preferenceOrder) {
    if (candidate !== current && available.includes(candidate)) {
      return candidate;
    }
  }
  return available.find((e) => e !== current);
}
