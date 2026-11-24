import {
  heuristicDecomposeEpic,
  normalizeEpicDecompositionPlan,
  type AvailableRepoSummary,
} from "./epic.ts";
import { normalizeScopePattern } from "./mandate.ts";
import type {
  CampaignDirection,
  EpicDeliveryMode,
  PipelineTemplateId,
  RepoConfig,
  RepoProbeContextPack,
  RequirementIntakePlan,
  RequirementRouteKind,
} from "./types.ts";

export interface RequirementIntakePlanningInput {
  repo: RepoConfig;
  title?: string;
  requirement: string;
  preferredRoute?: "auto" | RequirementRouteKind;
  defaultTemplate: PipelineTemplateId;
  defaultTddMode?: boolean;
  maxBudgetUsd?: number;
  repoStructure?: string;
  availableRepos?: AvailableRepoSummary[];
  probeContext?: RepoProbeContextPack;
  metricHint?: {
    metricCommand?: string;
    targetValue?: number;
    direction?: CampaignDirection;
    metricUnit?: string;
    metricRegex?: string;
  };
}

/** Synthesize a concise single-line title from raw requirement prose. */
export function synthesizeRequirementTitle(requirement: string, explicitTitle?: string): string {
  const cleanExplicit = explicitTitle?.trim();
  if (cleanExplicit) {
    return cleanExplicit.slice(0, 80);
  }
  const firstNonEmpty =
    requirement
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/^#{1,6}\s+/, "").replace(/^(?:\d+[.)]|[-*])\s+/, "").trim())
      .find(Boolean) ?? "Autonomous Requirement";
  const firstClause = firstNonEmpty.split(/(?<=[。！？.!?;；])\s*/)[0]?.trim() || firstNonEmpty;
  if (firstClause.length <= 72) return firstClause;
  return `${firstClause.slice(0, 69).trimEnd()}...`;
}

function extractExplicitScopedPaths(text: string): string[] {
  const scopeTags = Array.from(text.matchAll(/scope:([^\s,;]+)/gi)).map((m) =>
    normalizeScopePattern(m[1]!),
  );
  const pathLiterals = Array.from(
    text.matchAll(
      /\b((?:packages|apps|src|services|scripts|docs|test|tests)\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.*-]+)*)/g,
    ),
  ).map((m) => {
    const raw = m[1]!.replace(/[),.;:]+$/, "").replace(/\/+$/, "");
    if (raw.includes("*") || /\.[a-z0-9]{1,8}$/i.test(raw)) {
      return normalizeScopePattern(raw);
    }
    return normalizeScopePattern(`${raw}/**`);
  });

  return Array.from(new Set([...scopeTags, ...pathLiterals]));
}

function inferModuleScopedPaths(
  requirement: string,
  probeContext?: RepoProbeContextPack,
): string[] {
  const explicit = extractExplicitScopedPaths(requirement);
  if (explicit.length > 0) {
    // Expand file-level mentions to cover sibling test files when pointing into a package dir
    const pkgRoots = new Set<string>();
    for (const p of explicit) {
      const m = p.match(/^(packages\/[^/]+|apps\/[^/]+)/);
      if (m && p.endsWith("/**") && p.split("/").length <= 3) {
        pkgRoots.add(`${m[1]}/**`);
      }
    }
    return Array.from(new Set([...explicit, ...pkgRoots]));
  }

  const matched = probeContext?.matchedFiles ?? [];
  if (matched.length === 0) return ["**"];

  const pkgGroups = new Set<string>();
  const topGroups = new Set<string>();
  for (const f of matched) {
    const pkgMatch = f.match(/^(packages\/[^/]+|apps\/[^/]+)\//);
    if (pkgMatch) {
      pkgGroups.add(`${pkgMatch[1]}/**`);
    } else {
      const top = f.split("/")[0];
      if (top) topGroups.add(f.includes("/") ? `${top}/**` : f);
    }
  }

  if (pkgGroups.size === 1 && topGroups.size === 0) {
    return Array.from(pkgGroups);
  }
  if (pkgGroups.size === 0 && topGroups.size === 1) {
    return Array.from(topGroups);
  }
  return ["**"];
}

function extractAcceptanceCriteria(requirement: string, repo: RepoConfig): string[] {
  const bulletLines = requirement
    .split(/\r?\n/)
    .map((l) => l.trim().match(/^(?:\d+[.)]|[-*])\s+(.+)$/)?.[1]?.trim())
    .filter((s): s is string => Boolean(s && s.length >= 6 && s.length <= 160));

  const criteria = bulletLines.slice(0, 5);
  for (const cmd of (repo.verificationCommands ?? []).slice(0, 2)) {
    const clean = cmd.trim();
    if (clean && !criteria.some((c) => c.includes(clean))) {
      criteria.push(`Pass repository gate: \`${clean}\``);
    }
  }
  if (criteria.length === 0) {
    criteria.push("Implement requirement within Mandate scope and pass all checks");
  }
  return criteria;
}

function parseEmbeddedMetricSpec(
  requirement: string,
  metricHint?: RequirementIntakePlanningInput["metricHint"],
): {
  metricCommand: string;
  targetValue: number;
  direction: CampaignDirection;
  metricUnit?: string;
  metricRegex?: string;
} | null {
  const hintCmd = metricHint?.metricCommand?.trim();
  const hintTarget = metricHint?.targetValue;
  if (hintCmd && typeof hintTarget === "number" && Number.isFinite(hintTarget)) {
    return {
      metricCommand: hintCmd,
      targetValue: hintTarget,
      direction:
        metricHint?.direction ??
        (/\b(?:reduce|minimize|lower|faster|latency|size)\b|降低|压缩|缩短|减少/i.test(requirement)
          ? "decrease"
          : "increase"),
      metricUnit: metricHint?.metricUnit?.trim() || undefined,
      metricRegex: metricHint?.metricRegex?.trim() || undefined,
    };
  }

  // Detect explicit inline "metric: `<cmd>` ... target: <num>"
  const cmdMatch = requirement.match(/(?:metric(?:_command)?|指标命令|评估命令)\s*[:：=]\s*`([^`]+)`/i);
  const targetMatch = requirement.match(/(?:target(?:_value)?|目标值|目标)\s*[:：=]\s*(-?\d+(?:\.\d+)?)/i);
  if (cmdMatch?.[1] && targetMatch?.[1]) {
    const parsedTarget = Number(targetMatch[1]);
    if (Number.isFinite(parsedTarget)) {
      return {
        metricCommand: cmdMatch[1].trim(),
        targetValue: parsedTarget,
        direction: /\b(?:reduce|minimize|lower|latency|size)\b|降低|压缩|缩短|减少/i.test(requirement)
          ? "decrease"
          : "increase",
      };
    }
  }
  return null;
}

function countListItems(text: string): number {
  const lineItems = text
    .split(/\r?\n/)
    .filter((l) => /^\s*(?:\d+[.)]|[-*])\s+\S+/.test(l)).length;
  if (lineItems >= 2) return lineItems;
  return Array.from(
    text.matchAll(/(?:^|\s)\d+[.)]\s*[^\n\d]{4,}/g),
  ).length;
}

function touchesMultipleRepos(
  text: string,
  availableRepos?: AvailableRepoSummary[],
): boolean {
  if (!availableRepos || availableRepos.length <= 1) return false;
  let hits = 0;
  for (const r of availableRepos) {
    const escaped = r.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`, "i").test(text)) {
      hits += 1;
    }
  }
  return hits >= 2;
}

/**
 * Deterministic fallback planner that routes raw requirements to single_ticket,
 * epic_dag, or goal_campaign with scoped allowedPaths and acceptance criteria.
 */
export function heuristicPlanRequirementIntake(
  input: RequirementIntakePlanningInput,
): RequirementIntakePlan {
  const reqText = input.requirement.trim();
  const title = synthesizeRequirementTitle(reqText, input.title);
  const embeddedMetric = parseEmbeddedMetricSpec(reqText, input.metricHint);

  const shouldUseCampaign =
    (input.preferredRoute === "goal_campaign" && embeddedMetric !== null) ||
    (input.preferredRoute !== "single_ticket" &&
      input.preferredRoute !== "epic_dag" &&
      embeddedMetric !== null);

  if (shouldUseCampaign && embeddedMetric) {
    const allowedPaths = inferModuleScopedPaths(reqText, input.probeContext);
    return {
      route: "goal_campaign",
      confidence: 0.9,
      rationale: `Detected quantitative optimization target (${embeddedMetric.direction} -> ${embeddedMetric.targetValue}) with executable metric command \`${embeddedMetric.metricCommand}\`.`,
      title,
      summary: `Create & start GoalCampaign optimizing '${title}' via metric \`${embeddedMetric.metricCommand}\`.`,
      campaignSpec: {
        name: title,
        goalPrompt: reqText,
        metricCommand: embeddedMetric.metricCommand,
        ...(embeddedMetric.metricRegex ? { metricRegex: embeddedMetric.metricRegex } : {}),
        ...(embeddedMetric.metricUnit ? { metricUnit: embeddedMetric.metricUnit } : {}),
        direction: embeddedMetric.direction,
        targetValue: embeddedMetric.targetValue,
        deliveryMode: "staging_branch",
        allowedPaths,
        maxIterations: 5,
        maxTotalBudgetUsd: Math.max(input.maxBudgetUsd ?? 6, 3),
      },
      ...(input.probeContext?.probeSteps.length
        ? { probeSteps: input.probeContext.probeSteps }
        : {}),
    };
  }

  const explicitPkgMentions = new Set(
    Array.from(reqText.matchAll(/\b((?:packages|apps)\/[a-zA-Z0-9_.-]+)/g)).map((m) => m[1]!),
  );
  const listCount = countListItems(reqText);
  const multiRepo = touchesMultipleRepos(reqText, input.availableRepos);

  const shouldUseEpic =
    input.preferredRoute === "epic_dag" ||
    (input.preferredRoute !== "single_ticket" &&
      (multiRepo ||
        listCount >= 3 ||
        (listCount >= 2 && explicitPkgMentions.size >= 2) ||
        explicitPkgMentions.size >= 3));

  if (shouldUseEpic) {
    const epicPlan = heuristicDecomposeEpic({
      repo: input.repo,
      title,
      description: reqText,
      defaultTemplate: input.defaultTemplate,
      repoStructure: input.repoStructure,
      availableRepos: input.availableRepos,
    });
    const repoSet = new Set(epicPlan.subtasks.map((s) => s.repoId ?? input.repo.id));
    const isCrossRepo = repoSet.size > 1 || !repoSet.has(input.repo.id);
    const epicDeliveryMode: EpicDeliveryMode = isCrossRepo ? "per_subtask" : "unified";

    return {
      route: "epic_dag",
      confidence: 0.85,
      rationale: multiRepo
        ? "Requirement spans multiple registered repositories; decomposing into cross-repo Epic DAG with Release Barrier."
        : `Requirement involves ${Math.max(listCount, explicitPkgMentions.size)} distinct modules/workstreams; decomposing into concurrent DAG subtasks.`,
      title: epicPlan.epicTitle || title,
      summary: epicPlan.summary,
      epicPlan: {
        ...epicPlan,
        epicDeliveryMode,
        ...(isCrossRepo ? { releaseBarrier: true } : {}),
      },
      ...(input.probeContext?.probeSteps.length
        ? { probeSteps: input.probeContext.probeSteps }
        : {}),
    };
  }

  const allowedPaths = inferModuleScopedPaths(reqText, input.probeContext);
  const acceptanceCriteria = extractAcceptanceCriteria(reqText, input.repo);
  const looksTinyDocs =
    allowedPaths.every((p) => /\.(md|txt)$/i.test(p) || p.startsWith("docs/")) ||
    /\b(?:typo|readme|docs?)\b|文案|错别字|文档/i.test(reqText);
  const template: PipelineTemplateId =
    input.defaultTemplate === "strict"
      ? "strict"
      : looksTinyDocs && reqText.length < 220
        ? "fast"
        : input.defaultTemplate;
  const tddMode = Boolean(
    input.defaultTddMode || /\btdd\b|测试先行|先写测试/i.test(reqText),
  );

  return {
    route: "single_ticket",
    confidence: 0.88,
    rationale:
      allowedPaths.length === 1 && allowedPaths[0] === "**"
        ? "Focused single-workstream requirement; executing on single pipeline with full repo visibility."
        : `Scoped directly to ${allowedPaths.join(", ")} for isolated single-ticket execution.`,
    title,
    summary: `Route as single ${template} ticket (${allowedPaths.join(", ")}).`,
    singleSpec: {
      description: reqText,
      template,
      tddMode,
      allowedPaths,
      acceptanceCriteria,
      priority: 1,
    },
    ...(input.probeContext?.probeSteps.length
      ? { probeSteps: input.probeContext.probeSteps }
      : {}),
  };
}

/** Normalize an LLM-produced RequirementIntakePlan and prevent invalid routes/specs. */
export function normalizeRequirementIntakePlan(
  raw: Partial<RequirementIntakePlan>,
  fallbackInput: RequirementIntakePlanningInput,
): RequirementIntakePlan {
  const heuristic = heuristicPlanRequirementIntake(fallbackInput);
  const forcedRoute =
    fallbackInput.preferredRoute && fallbackInput.preferredRoute !== "auto"
      ? fallbackInput.preferredRoute
      : undefined;

  let route: RequirementRouteKind =
    forcedRoute ??
    (raw.route === "single_ticket" || raw.route === "epic_dag" || raw.route === "goal_campaign"
      ? raw.route
      : heuristic.route);

  if (route === "goal_campaign") {
    const rawMetricCmd = raw.campaignSpec?.metricCommand?.trim() || heuristic.campaignSpec?.metricCommand?.trim();
    const rawTarget =
      typeof raw.campaignSpec?.targetValue === "number" &&
      Number.isFinite(raw.campaignSpec.targetValue)
        ? raw.campaignSpec.targetValue
        : heuristic.campaignSpec?.targetValue;

    if (!rawMetricCmd || rawTarget === undefined || !Number.isFinite(rawTarget)) {
      // Never route into goal_campaign without an executable metric command & numeric target
      route = forcedRoute === "goal_campaign" ? "single_ticket" : heuristic.route === "goal_campaign" ? "single_ticket" : heuristic.route;
    }
  }

  const title = String(raw.title ?? "").trim() || heuristic.title;
  const summary = String(raw.summary ?? "").trim() || heuristic.summary;
  const rationale = String(raw.rationale ?? "").trim() || heuristic.rationale;
  const confidenceRaw = typeof raw.confidence === "number" ? raw.confidence : heuristic.confidence;
  const confidence = Number(Math.max(0.1, Math.min(1, confidenceRaw)).toFixed(2));
  const probeSteps =
    Array.isArray(raw.probeSteps) && raw.probeSteps.length > 0
      ? raw.probeSteps
      : fallbackInput.probeContext?.probeSteps;

  if (route === "goal_campaign") {
    const baseCmp = heuristic.campaignSpec;
    const rawCmp = raw.campaignSpec;
    const metricCommand = rawCmp?.metricCommand?.trim() || baseCmp?.metricCommand || "";
    const targetValue =
      typeof rawCmp?.targetValue === "number" && Number.isFinite(rawCmp.targetValue)
        ? rawCmp.targetValue
        : (baseCmp?.targetValue ?? 0);
    const allowedPaths =
      Array.isArray(rawCmp?.allowedPaths) && rawCmp.allowedPaths.length > 0
        ? Array.from(new Set(rawCmp.allowedPaths.map((p) => normalizeScopePattern(String(p))).filter(Boolean)))
        : (baseCmp?.allowedPaths ?? ["**"]);

    return {
      route: "goal_campaign",
      confidence,
      rationale,
      title,
      summary,
      campaignSpec: {
        name: rawCmp?.name?.trim() || title,
        goalPrompt: rawCmp?.goalPrompt?.trim() || fallbackInput.requirement.trim(),
        metricCommand,
        ...(rawCmp?.metricRegex?.trim() || baseCmp?.metricRegex
          ? { metricRegex: rawCmp?.metricRegex?.trim() || baseCmp?.metricRegex }
          : {}),
        ...(rawCmp?.metricUnit?.trim() || baseCmp?.metricUnit
          ? { metricUnit: rawCmp?.metricUnit?.trim() || baseCmp?.metricUnit }
          : {}),
        direction:
          rawCmp?.direction === "increase" || rawCmp?.direction === "decrease"
            ? rawCmp.direction
            : (baseCmp?.direction ?? "increase"),
        targetValue,
        deliveryMode:
          rawCmp?.deliveryMode === "per_wave_merge" || rawCmp?.deliveryMode === "staging_branch"
            ? rawCmp.deliveryMode
            : "staging_branch",
        allowedPaths: allowedPaths.length > 0 ? allowedPaths : ["**"],
        maxIterations:
          typeof rawCmp?.maxIterations === "number" && rawCmp.maxIterations >= 1
            ? Math.min(20, Math.floor(rawCmp.maxIterations))
            : (baseCmp?.maxIterations ?? 5),
        maxTotalBudgetUsd:
          typeof rawCmp?.maxTotalBudgetUsd === "number" && rawCmp.maxTotalBudgetUsd > 0
            ? rawCmp.maxTotalBudgetUsd
            : (fallbackInput.maxBudgetUsd ?? baseCmp?.maxTotalBudgetUsd ?? 6),
      },
      ...(probeSteps?.length ? { probeSteps } : {}),
    };
  }

  if (route === "epic_dag") {
    const rawEpic = raw.epicPlan ?? heuristic.epicPlan;
    const normalizedEpic = normalizeEpicDecompositionPlan(rawEpic ?? {}, {
      repo: fallbackInput.repo,
      title,
      description: fallbackInput.requirement,
      defaultTemplate: fallbackInput.defaultTemplate,
      repoStructure: fallbackInput.repoStructure,
      availableRepos: fallbackInput.availableRepos,
    });
    const repoSet = new Set(normalizedEpic.subtasks.map((s) => s.repoId ?? fallbackInput.repo.id));
    const isCrossRepo = repoSet.size > 1 || !repoSet.has(fallbackInput.repo.id);
    const epicDeliveryMode: EpicDeliveryMode = isCrossRepo
      ? "per_subtask"
      : raw.epicPlan?.epicDeliveryMode === "per_subtask"
        ? "per_subtask"
        : "unified";

    return {
      route: "epic_dag",
      confidence,
      rationale,
      title: normalizedEpic.epicTitle || title,
      summary: normalizedEpic.summary || summary,
      epicPlan: {
        ...normalizedEpic,
        epicDeliveryMode,
        ...(isCrossRepo ? { releaseBarrier: true } : {}),
      },
      ...(probeSteps?.length ? { probeSteps } : {}),
    };
  }

  const rawSingle = raw.singleSpec;
  const fallbackSingle = heuristic.singleSpec!;
  const allowedPaths =
    Array.isArray(rawSingle?.allowedPaths) && rawSingle.allowedPaths.length > 0
      ? Array.from(new Set(rawSingle.allowedPaths.map((p) => normalizeScopePattern(String(p))).filter(Boolean)))
      : fallbackSingle.allowedPaths;
  const template: PipelineTemplateId =
    rawSingle?.template === "fast" || rawSingle?.template === "standard" || rawSingle?.template === "strict"
      ? rawSingle.template
      : fallbackSingle.template;
  const acceptanceCriteria =
    Array.isArray(rawSingle?.acceptanceCriteria) && rawSingle.acceptanceCriteria.length > 0
      ? rawSingle.acceptanceCriteria.map((c) => String(c).trim()).filter(Boolean)
      : fallbackSingle.acceptanceCriteria;

  return {
    route: "single_ticket",
    confidence,
    rationale,
    title,
    summary,
    singleSpec: {
      description: String(rawSingle?.description ?? "").trim() || fallbackSingle.description,
      template,
      tddMode:
        typeof rawSingle?.tddMode === "boolean"
          ? rawSingle.tddMode
          : Boolean(fallbackInput.defaultTddMode || fallbackSingle.tddMode),
      allowedPaths: allowedPaths.length > 0 ? allowedPaths : ["**"],
      acceptanceCriteria,
      priority:
        typeof rawSingle?.priority === "number" && Number.isFinite(rawSingle.priority)
          ? rawSingle.priority
          : fallbackSingle.priority,
    },
    ...(probeSteps?.length ? { probeSteps } : {}),
  };
}
