import { join } from "node:path";
import {
  buildHeuristicSpecClarification,
  getAlternateEngine,
  heuristicDecomposeEpic,
  heuristicDistillPlaybookLesson,
  heuristicPlanRequirementIntake,
} from "@super-work/core";
import type {
  CampaignDirection,
  ControlPlaneLLM,
  EpicDecompositionPlan,
  MemorySearchHit,
  PipelineTemplateId,
  RepoConfig,
  RepoProbeContextPack,
  RequirementIntakePlan,
  SpecClarificationResult,
  StageRun,
  Ticket,
  TriageProposal,
  Trigger,
  WatchdogDecision,
  WatchdogSignal,
  WorkerEngineId,
} from "@super-work/core";

export class HeuristicControlLLM implements ControlPlaneLLM {
  readonly providerName = "heuristic:local";

  async triageTrigger(input: {
    repo: RepoConfig;
    trigger: Trigger;
    activeTickets?: Ticket[];
    relatedMemory?: MemorySearchHit[];
    repoStructure?: string;
    probeContext?: RepoProbeContextPack;
  }): Promise<TriageProposal> {
    const text = `${input.trigger.title}\n${input.trigger.rawText}`;
    const lower = text.toLowerCase();

    // Skip trivial non-actionable noise comments
    if (/^(lgtm|thanks|thank you|\+1|ping)\s*[!.]*$/i.test(input.trigger.rawText.trim())) {
      return {
        shouldCreateTicket: false,
        reason: "Ignored conversational acknowledgement with no actionable engineering work",
        title: input.trigger.title,
        description: input.trigger.rawText,
        template: input.repo.defaultTemplate,
        allowedPaths: ["**"],
        acceptanceCriteria: [],
        priority: 1,
      };
    }

    const explicitScope = text.match(/scope:([^\s,;]+)/i)?.[1];
    const pathMatches = text.match(/(?:packages|src|apps|docs|test)\/[a-zA-Z0-9_./*-]+/g) ?? [];
    const probeMatched = input.probeContext?.matchedFiles ?? [];
    const structureMatches: string[] = [];
    if (!explicitScope && pathMatches.length === 0 && input.repoStructure) {
      const mods = Array.from(
        input.repoStructure.matchAll(/^\s*-\s+([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)?)/gm),
      ).map((m) => m[1]!.replace(/\/+$/, ""));
      for (const mod of mods) {
        const leaf = mod.split("/").pop() ?? mod;
        if (leaf.length >= 3 && new RegExp(`\\b${leaf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(lower)) {
          structureMatches.push(`${mod}/**`);
        }
      }
    }
    const allowedPaths = explicitScope
      ? [explicitScope]
      : pathMatches.length > 0
        ? Array.from(new Set(pathMatches)).slice(0, 4)
        : probeMatched.length > 0
          ? Array.from(new Set(probeMatched)).slice(0, 4)
          : structureMatches.length > 0
            ? Array.from(new Set(structureMatches)).slice(0, 4)
            : ["**"];

    const isFast =
      lower.includes("typo") ||
      lower.includes("readme") ||
      lower.includes("quickfix") ||
      lower.includes("hotfix");
    const isStrict =
      lower.includes("security") ||
      lower.includes("auth") ||
      lower.includes("migration") ||
      lower.includes("payment");

    const template: PipelineTemplateId = isStrict
      ? "strict"
      : isFast
        ? "fast"
        : input.repo.defaultTemplate;

    const priority = lower.includes("ci") || lower.includes("urgent") || lower.includes("crash") ? 2 : 1;

    return {
      shouldCreateTicket: true,
      reason: `Triaged ${input.trigger.source} event into ${template} pipeline (scope: ${allowedPaths.join(", ")})`,
      title: input.trigger.title,
      description: input.trigger.rawText,
      template,
      allowedPaths,
      acceptanceCriteria: [
        "All changes remain inside authorized Mandate paths",
        "Relevant checks/tests pass before delivery",
      ],
      priority,
      ...(input.probeContext?.probeSteps.length
        ? { probeSteps: input.probeContext.probeSteps }
        : {}),
    };
  }

  async diagnoseWatchdog(input: {
    ticket: Ticket;
    stageRun: StageRun;
    signal: WatchdogSignal;
    availableEngines: WorkerEngineId[];
    probeContext?: RepoProbeContextPack;
  }): Promise<WatchdogDecision> {
    const probeSteps = input.probeContext?.probeSteps.length
      ? input.probeContext.probeSteps
      : undefined;
    if (input.signal.kind === "hard_budget_exceeded") {
      return { action: "ESCALATE_HUMAN", reason: input.signal.details, ...(probeSteps ? { probeSteps } : {}) };
    }

    const alt = getAlternateEngine(input.stageRun.engine, input.availableEngines);
    if (
      (input.signal.kind === "repeated_error" || input.signal.kind === "diff_oscillation") &&
      alt &&
      input.ticket.stageRetries === 0
    ) {
      return {
        action: "SWITCH_ENGINE",
        reason: `${input.signal.kind} detected on ${input.stageRun.engine}; switching to ${alt}`,
        targetEngine: alt,
        hint: `Previous engine (${input.stageRun.engine}) hit ${input.signal.kind}: ${input.signal.details}. Take a fresh approach.`,
        ...(probeSteps ? { probeSteps } : {}),
      };
    }

    if (input.ticket.stageRetries < input.ticket.mandate.maxStageRetries) {
      return {
        action: "INJECT_HINT",
        reason: `Injecting corrective hint after ${input.signal.kind}`,
        hint: `Watchdog alert (${input.signal.kind}): ${input.signal.details}. Stop repeating failing steps and verify assumptions.`,
        ...(probeSteps ? { probeSteps } : {}),
      };
    }

    return {
      action: "ESCALATE_HUMAN",
      reason: `Retries exhausted after ${input.signal.kind}: ${input.signal.details}`,
      ...(probeSteps ? { probeSteps } : {}),
    };
  }

  async planEpicDecomposition(input: {
    repo: RepoConfig;
    title: string;
    description: string;
    defaultTemplate: PipelineTemplateId;
    repoStructure?: string;
    playbookRules?: string;
    conventions?: string;
    availableRepos?: Array<{ id: string; name: string; structure?: string }>;
    probeContext?: RepoProbeContextPack;
  }): Promise<EpicDecompositionPlan> {
    const plan = heuristicDecomposeEpic(input);
    return input.probeContext?.probeSteps.length
      ? { ...plan, probeSteps: input.probeContext.probeSteps }
      : plan;
  }

  async distillPlaybookLesson(input: {
    repo: RepoConfig;
    ticket: Ticket;
    failureKind: "verification" | "smoke" | "review";
    failureSummary: string;
    fixSummary: string;
    changedFiles: string[];
  }): Promise<{ rule: string; scopePaths: string[] } | null> {
    return heuristicDistillPlaybookLesson({
      failureKind: input.failureKind,
      failureSummary: input.failureSummary,
      fixSummary: input.fixSummary,
      changedFiles: input.changedFiles,
      allowedPaths: input.ticket.mandate.allowedPaths,
    });
  }

  async distillHandoverDigest(): Promise<null> {
    return null;
  }

  async clarifySpec(input: {
    repo: RepoConfig;
    title: string;
    description: string;
    defaultTemplate: PipelineTemplateId;
    repoStructure?: string;
    probeContext?: RepoProbeContextPack;
  }): Promise<SpecClarificationResult> {
    return buildHeuristicSpecClarification(input);
  }

  async planRequirementIntake(input: {
    repo: RepoConfig;
    title: string;
    requirement: string;
    defaultTemplate: PipelineTemplateId;
    defaultTddMode?: boolean;
    repoStructure?: string;
    availableRepos?: Array<{ id: string; name: string; structure?: string }>;
    probeContext?: RepoProbeContextPack;
    metricHint?: {
      metricCommand?: string;
      targetValue?: number;
      direction?: CampaignDirection;
      metricUnit?: string;
      metricRegex?: string;
    };
  }): Promise<RequirementIntakePlan> {
    return heuristicPlanRequirementIntake(input);
  }
}

