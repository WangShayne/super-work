import { createDefaultMandate, mandateScopesOverlap, normalizeScopePattern } from "./mandate.ts";
import type {
  EpicDecompositionPlan,
  EpicReplanMutation,
  EpicReplanProposal,
  EpicSubtaskSpec,
  HandoverDigest,
  PipelineTemplateId,
  RepoConfig,
  Ticket,
} from "./types.ts";
import { nowIso } from "./utils.ts";

function sanitizeKey(raw: string | undefined, idx: number, used: Set<string>): string {
  const base = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  let candidate = base || `step_${idx + 1}`;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base || "step"}_${suffix++}`;
  }
  used.add(candidate);
  return candidate;
}

function canReach(
  fromKey: string,
  targetKey: string,
  edges: Map<string, string[]>,
  visited = new Set<string>(),
): boolean {
  if (fromKey === targetKey) return true;
  if (visited.has(fromKey)) return false;
  visited.add(fromKey);
  for (const next of edges.get(fromKey) ?? []) {
    if (canReach(next, targetKey, edges, visited)) {
      return true;
    }
  }
  return false;
}

export interface SanitizeEpicOptions {
  validRepoIds?: Set<string>;
  repoIdByName?: Map<string, string>;
  defaultRepoId?: string;
}

export function sanitizeEpicSubtasks(
  rawSpecs: Array<Partial<EpicSubtaskSpec>>,
  defaultTemplate: PipelineTemplateId,
  options?: SanitizeEpicOptions,
): EpicSubtaskSpec[] {
  const usedKeys = new Set<string>();
  const keyMap = new Map<string, string>();
  const defaultRepoId = options?.defaultRepoId ?? "";
  const specs: EpicSubtaskSpec[] = rawSpecs.slice(0, 8).map((raw, idx) => {
    const rawKey = typeof raw.key === "string" ? raw.key.trim() : "";
    const key = sanitizeKey(rawKey, idx, usedKeys);
    if (rawKey) {
      keyMap.set(rawKey, key);
    }
    const rawRepo = typeof raw.repoId === "string" ? raw.repoId.trim() : "";
    let resolvedRepoId: string | undefined;
    if (rawRepo) {
      if (!options?.validRepoIds || options.validRepoIds.has(rawRepo)) {
        resolvedRepoId = rawRepo;
      } else {
        const byName = options.repoIdByName?.get(rawRepo.toLowerCase());
        if (byName) {
          resolvedRepoId = byName;
        }
      }
    }
    const template: PipelineTemplateId =
      raw.template === "fast" || raw.template === "standard" || raw.template === "strict"
        ? raw.template
        : defaultTemplate;
    const allowedPaths =
      Array.isArray(raw.allowedPaths) && raw.allowedPaths.length > 0
        ? Array.from(new Set(raw.allowedPaths.map((p) => String(p).trim()).filter(Boolean)))
        : ["**"];
    const acceptanceCriteria = Array.isArray(raw.acceptanceCriteria)
      ? raw.acceptanceCriteria.map((c) => String(c).trim()).filter(Boolean)
      : ["All checks and Mandate constraints pass"];

    return {
      key,
      ...(resolvedRepoId ? { repoId: resolvedRepoId } : {}),
      title: String(raw.title ?? "").trim() || `Subtask ${key}`,
      description: String(raw.description ?? raw.title ?? "").trim() || `Implement ${key}`,
      template,
      allowedPaths: allowedPaths.length > 0 ? allowedPaths : ["**"],
      dependsOnKeys: Array.isArray(raw.dependsOnKeys)
        ? raw.dependsOnKeys.map((k) => String(k).trim()).filter(Boolean)
        : [],
      acceptanceCriteria,
    };
  });

  const validKeys = new Set(specs.map((s) => s.key));
  const byKey = new Map(specs.map((s) => [s.key, s]));
  // dependents graph: depKey -> keys waiting on depKey
  const dependents = new Map<string, string[]>();
  for (const s of specs) dependents.set(s.key, []);

  for (const spec of specs) {
    const cleanDeps: string[] = [];
    for (const rawDep of spec.dependsOnKeys) {
      const mapped = keyMap.get(rawDep) ?? rawDep;
      if (!validKeys.has(mapped) || mapped === spec.key) continue;
      // Cycle guard: dep -> spec is safe iff spec cannot already reach dep
      if (!canReach(spec.key, mapped, dependents)) {
        if (!cleanDeps.includes(mapped)) {
          cleanDeps.push(mapped);
          dependents.get(mapped)!.push(spec.key);
        }
      }
    }
    spec.dependsOnKeys = cleanDeps;
  }

  // Ensure overlapping allowedPaths between siblings in the SAME repository have a deterministic dependency edge
  for (let i = 0; i < specs.length; i++) {
    const a = specs[i]!;
    const aRepo = a.repoId ?? defaultRepoId;
    const mandateA = createDefaultMandate({ allowedPaths: a.allowedPaths });
    for (let j = i + 1; j < specs.length; j++) {
      const b = specs[j]!;
      const bRepo = b.repoId ?? defaultRepoId;
      if (aRepo !== bRepo) continue;
      const mandateB = createDefaultMandate({ allowedPaths: b.allowedPaths });
      if (!mandateScopesOverlap(mandateA, mandateB)) continue;
      if (canReach(a.key, b.key, dependents) || canReach(b.key, a.key, dependents)) continue;
      b.dependsOnKeys.push(a.key);
      dependents.get(a.key)!.push(b.key);
    }
  }

  // Topological sort (Kahn) preserving original order for peers
  const inDegree = new Map<string, number>();
  for (const s of specs) inDegree.set(s.key, s.dependsOnKeys.length);

  const ordered: EpicSubtaskSpec[] = [];
  const queue = specs.filter((s) => (inDegree.get(s.key) ?? 0) === 0);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    ordered.push(cur);
    for (const depChild of dependents.get(cur.key) ?? []) {
      const nextDeg = (inDegree.get(depChild) ?? 1) - 1;
      inDegree.set(depChild, nextDeg);
      if (nextDeg === 0) {
        const childSpec = byKey.get(depChild);
        if (childSpec) queue.push(childSpec);
      }
    }
  }

  return ordered.length === specs.length ? ordered : specs;
}

export interface AvailableRepoSummary {
  id: string;
  name: string;
  structure?: string;
}

function buildSanitizeOptions(
  defaultRepoId: string,
  availableRepos?: AvailableRepoSummary[],
): SanitizeEpicOptions | undefined {
  if (!availableRepos || availableRepos.length === 0) {
    return defaultRepoId ? { defaultRepoId } : undefined;
  }
  return {
    validRepoIds: new Set(availableRepos.map((r) => r.id)),
    repoIdByName: new Map(availableRepos.map((r) => [r.name.toLowerCase(), r.id])),
    defaultRepoId,
  };
}

function inferTargetRepoFromText(
  text: string,
  availableRepos: AvailableRepoSummary[] | undefined,
  defaultRepoId: string,
): AvailableRepoSummary | undefined {
  if (!availableRepos || availableRepos.length <= 1) return undefined;
  const lower = text.toLowerCase();
  for (const r of availableRepos) {
    const escapedId = r.id.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedName = r.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (
      new RegExp(`\\[${escapedName}\\]|\\b${escapedName}:|\\bin\\s+${escapedName}\\b|\\b${escapedName}\\b`, "i").test(
        lower,
      ) ||
      new RegExp(`\\b${escapedId}\\b`, "i").test(lower)
    ) {
      return r;
    }
  }
  return availableRepos.find((r) => r.id === defaultRepoId);
}

export function normalizeEpicDecompositionPlan(
  raw: Partial<EpicDecompositionPlan>,
  fallbackInput: {
    repo: RepoConfig;
    title: string;
    description: string;
    defaultTemplate: PipelineTemplateId;
    repoStructure?: string;
    availableRepos?: AvailableRepoSummary[];
  },
): EpicDecompositionPlan {
  const sanitizeOpts = buildSanitizeOptions(fallbackInput.repo.id, fallbackInput.availableRepos);
  const subtasks =
    Array.isArray(raw.subtasks) && raw.subtasks.length > 0
      ? sanitizeEpicSubtasks(raw.subtasks, fallbackInput.defaultTemplate, sanitizeOpts)
      : heuristicDecomposeEpic(fallbackInput).subtasks;

  return {
    epicTitle: String(raw.epicTitle ?? "").trim() || fallbackInput.title,
    summary:
      String(raw.summary ?? "").trim() ||
      `Decomposed into ${subtasks.length} scoped subtask(s).`,
    subtasks,
  };
}

function extractScopedPaths(text: string): string[] {
  const explicit = Array.from(text.matchAll(/scope:([^\s,;]+)/gi)).map((m) => m[1]!);
  if (explicit.length > 0) return Array.from(new Set(explicit));

  const pkgMatches = Array.from(
    text.matchAll(/\b((?:packages|apps|src|services)\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.*-]+)?)/g),
  ).map((m) => {
    const p = m[1]!.replace(/\/+$/, "");
    if (p.includes("*") || /\.[a-z0-9]+$/i.test(p)) return p;
    return `${p}/**`;
  });
  return Array.from(new Set(pkgMatches));
}

function extractKnownModulesFromRepoStructure(repoStructure?: string): string[] {
  if (!repoStructure) return [];
  const matches = Array.from(
    repoStructure.matchAll(/^\s*-\s+([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)?)/gm),
  ).map((m) => m[1]!.replace(/\/+$/, ""));
  return Array.from(new Set(matches));
}

function inferPathsFromRepoStructure(text: string, knownModules: string[]): string[] {
  if (knownModules.length === 0) return [];
  const lower = text.toLowerCase();
  const matched: string[] = [];
  for (const mod of knownModules) {
    const leaf = mod.split("/").pop() ?? mod;
    if (
      lower.includes(mod.toLowerCase()) ||
      (leaf.length >= 3 && new RegExp(`\\b${leaf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(lower))
    ) {
      matched.push(`${mod}/**`);
    }
  }
  return Array.from(new Set(matched));
}

export function heuristicDecomposeEpic(input: {
  repo: RepoConfig;
  title: string;
  description: string;
  defaultTemplate: PipelineTemplateId;
  repoStructure?: string;
  availableRepos?: AvailableRepoSummary[];
}): EpicDecompositionPlan {
  const sanitizeOpts = buildSanitizeOptions(input.repo.id, input.availableRepos);
  const knownModules = extractKnownModulesFromRepoStructure(input.repoStructure);
  const rawLines = input.description.split(/\r?\n/);
  const listItems = rawLines
    .map((l) => l.match(/^\s*(?:\d+[.)]|[-*])\s+(.+)$/)?.[1]?.trim())
    .filter((s): s is string => Boolean(s));

  // If numbered steps appear inline ("1. ... 2. ..."), extract them too
  const inlineItems =
    listItems.length >= 2
      ? listItems
      : Array.from(
          input.description.matchAll(/(?:^|\s)\d+[.)]\s*([^\n\d]+?)(?=(?:\s+\d+[.)]\s)|$)/g),
        )
          .map((m) => m[1]!.trim())
          .filter((s) => s.length >= 4);

  if (inlineItems.length >= 2) {
    const steps = inlineItems.slice(0, 5);
    const hasCoreFirst = /core|contract|schema|type|契约|核心|接口/i.test(steps[0]!);
    const specs: EpicSubtaskSpec[] = steps.map((stepText, idx) => {
      const targetRepo = inferTargetRepoFromText(stepText, input.availableRepos, input.repo.id);
      const repoKnownModules = targetRepo?.structure
        ? extractKnownModulesFromRepoStructure(targetRepo.structure)
        : knownModules;
      const explicitPaths = extractScopedPaths(stepText);
      const paths =
        explicitPaths.length > 0
          ? explicitPaths
          : inferPathsFromRepoStructure(stepText, repoKnownModules);
      const isIntegration =
        idx === steps.length - 1 &&
        /test|verify|integration|联调|测试|验收/i.test(stepText) &&
        steps.length > 2;
      let dependsOnKeys: string[] = [];
      if (isIntegration) {
        dependsOnKeys = steps.slice(0, idx).map((_, i) => `step_${i + 1}`);
      } else if (hasCoreFirst && idx > 0) {
        dependsOnKeys = ["step_1"];
      }
      return {
        key: `step_${idx + 1}`,
        ...(targetRepo && targetRepo.id !== input.repo.id ? { repoId: targetRepo.id } : {}),
        title: stepText.length > 72 ? `${stepText.slice(0, 69)}...` : stepText,
        description: `${input.title}\n\nSubtask focus: ${stepText}`,
        template: input.defaultTemplate,
        allowedPaths: paths.length > 0 ? paths : ["**"],
        dependsOnKeys,
        acceptanceCriteria: [`Complete: ${stepText}`, "All verification gates pass"],
      };
    });

    const sanitized = sanitizeEpicSubtasks(specs, input.defaultTemplate, sanitizeOpts);
    return {
      epicTitle: input.title,
      summary: `Decomposed ${steps.length} actionable steps into parallel/staged DAG.`,
      subtasks: sanitized,
    };
  }

  // Module-based decomposition if distinct package/source paths are mentioned
  const detectedExplicit = extractScopedPaths(`${input.title}\n${input.description}`);
  const detectedPaths =
    detectedExplicit.length >= 2
      ? detectedExplicit
      : inferPathsFromRepoStructure(`${input.title}\n${input.description}`, knownModules);
  if (detectedPaths.length >= 2) {
    const coreIdx = detectedPaths.findIndex((p) => p.startsWith("packages/core"));
    const specs: EpicSubtaskSpec[] = detectedPaths.slice(0, 5).map((pathGlob, idx) => {
      const modName = pathGlob.replace(/\/\*\*$/, "");
      const key = modName.replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase() || `mod_${idx + 1}`;
      const isCore = idx === coreIdx;
      const deps =
        coreIdx >= 0 && !isCore
          ? [
              detectedPaths[coreIdx]!
                .replace(/\/\*\*$/, "")
                .replace(/[^a-zA-Z0-9]+/g, "_")
                .toLowerCase(),
            ]
          : [];
      return {
        key,
        title: `${modName}: ${input.title}`,
        description: `${input.description}\n\nRestrict changes to ${pathGlob}.`,
        template: input.defaultTemplate,
        allowedPaths: [pathGlob],
        dependsOnKeys: deps,
        acceptanceCriteria: [`Scoped changes in ${pathGlob} pass verification`],
      };
    });
    const sanitized = sanitizeEpicSubtasks(specs, input.defaultTemplate, sanitizeOpts);
    return {
      epicTitle: input.title,
      summary: `Decomposed by module scope (${detectedPaths.length} modules).`,
      subtasks: sanitized,
    };
  }

  // Cross-repo heuristic if multiple repositories are explicitly referenced in title/description
  if (input.availableRepos && input.availableRepos.length > 1) {
    const combinedLower = `${input.title}\n${input.description}`.toLowerCase();
    const mentionedRepos = input.availableRepos.filter((r) => {
      const escapedName = r.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\b${escapedName}\\b`, "i").test(combinedLower);
    });
    if (mentionedRepos.length >= 2) {
      const specs: EpicSubtaskSpec[] = mentionedRepos.slice(0, 5).map((r, idx) => ({
        key: sanitizeKey(r.name, idx, new Set()),
        repoId: r.id,
        title: `[${r.name}] ${input.title}`,
        description: `${input.description}\n\nImplement repository-specific changes in ${r.name}.`,
        template: input.defaultTemplate,
        allowedPaths: ["**"],
        dependsOnKeys: idx > 0 ? [sanitizeKey(mentionedRepos[0]!.name, 0, new Set())] : [],
        acceptanceCriteria: [`Changes in ${r.name} pass verification`],
      }));
      return {
        epicTitle: input.title,
        summary: `Cross-repo Epic DAG across ${mentionedRepos.map((r) => r.name).join(" -> ")}.`,
        subtasks: sanitizeEpicSubtasks(specs, input.defaultTemplate, sanitizeOpts),
      };
    }
  }

  // Default vertical slice DAG (tailored to discovered repo structure if available)
  if (knownModules.length > 0) {
    const hasPackages = knownModules.some((m) => m.startsWith("packages/"));
    if (!hasPackages && knownModules.includes("src")) {
      const srcSpecs: EpicSubtaskSpec[] = [
        {
          key: "core",
          title: `[Contracts & Model] ${input.title}`,
          description: `${input.description}\n\nDefine data types and module interfaces.`,
          template: input.defaultTemplate,
          allowedPaths: ["src/**"],
          dependsOnKeys: [],
          acceptanceCriteria: ["Types and contracts compile cleanly"],
        },
        {
          key: "verify",
          title: `[Tests & Docs] ${input.title}`,
          description: `${input.description}\n\nAdd automated tests and update documentation.`,
          template: input.defaultTemplate,
          allowedPaths: knownModules.some((m) => m === "test" || m === "tests")
            ? ["test*/**", "*.md"]
            : ["**"],
          dependsOnKeys: ["core"],
          acceptanceCriteria: ["Tests and docs pass verification"],
        },
      ];
      return {
        epicTitle: input.title,
        summary: `Structure-aware 2-stage Epic DAG (${knownModules.slice(0, 5).join(", ")}).`,
        subtasks: sanitizeEpicSubtasks(srcSpecs, input.defaultTemplate, sanitizeOpts),
      };
    }
  }

  const defaultSpecs: EpicSubtaskSpec[] = [
    {
      key: "contracts",
      title: `[Contracts] ${input.title}`,
      description: `${input.description}\n\nDefine domain types, interfaces, and schemas first.`,
      template: input.defaultTemplate,
      allowedPaths: ["packages/core/**"],
      dependsOnKeys: [],
      acceptanceCriteria: ["Type contracts and interfaces compile cleanly"],
    },
    {
      key: "implementation",
      title: `[Backend] ${input.title}`,
      description: `${input.description}\n\nImplement drivers, storage, and HTTP API endpoints.`,
      template: input.defaultTemplate,
      allowedPaths: ["packages/drivers/**", "packages/server/**"],
      dependsOnKeys: ["contracts"],
      acceptanceCriteria: ["Driver and server logic implemented with tests"],
    },
    {
      key: "ui_and_verify",
      title: `[UI & Docs] ${input.title}`,
      description: `${input.description}\n\nWire Web Command Center UI and end-to-end verification.`,
      template: input.defaultTemplate,
      allowedPaths: ["packages/web/**", "*.md"],
      dependsOnKeys: ["implementation"],
      acceptanceCriteria: ["UI renders cleanly and end-to-end checks pass"],
    },
  ];
  return {
    epicTitle: input.title,
    summary: "Default 3-stage vertical Epic DAG (contracts -> backend -> UI & verification).",
    subtasks: sanitizeEpicSubtasks(defaultSpecs, input.defaultTemplate, sanitizeOpts),
  };
}

function patternStaticPrefix(pattern: string): { prefix: string; isWildcard: boolean } {
  const norm = normalizeScopePattern(pattern);
  if (norm === "**" || norm === "*") {
    return { prefix: "", isWildcard: true };
  }
  const segs = norm.split("/");
  const clean: string[] = [];
  for (const s of segs) {
    if (/[*?[{]/.test(s)) break;
    clean.push(s);
  }
  return { prefix: clean.join("/"), isWildcard: false };
}

export function isSubtaskScopeWithinEpic(
  subtaskAllowedPaths: string[],
  epicAllowedPaths: string[],
): boolean {
  const epicPats = epicAllowedPaths.length > 0 ? epicAllowedPaths : ["**"];
  if (epicPats.some((p) => {
    const n = normalizeScopePattern(p);
    return n === "**" || n === "*";
  })) {
    return true;
  }
  const targetPats = subtaskAllowedPaths.length > 0 ? subtaskAllowedPaths : ["**"];
  if (targetPats.some((p) => {
    const n = normalizeScopePattern(p);
    return n === "**" || n === "*";
  })) {
    return false;
  }

  for (const subPat of targetPats) {
    const subNorm = normalizeScopePattern(subPat);
    const subInfo = patternStaticPrefix(subNorm);
    const covered = epicPats.some((epicPat) => {
      const epicNorm = normalizeScopePattern(epicPat);
      if (epicNorm === subNorm) return true;
      const epicInfo = patternStaticPrefix(epicNorm);
      if (epicInfo.isWildcard) return true;
      if (!epicInfo.prefix || !subInfo.prefix) return false;
      return (
        subInfo.prefix === epicInfo.prefix ||
        subInfo.prefix.startsWith(`${epicInfo.prefix}/`)
      );
    });
    if (!covered) return false;
  }
  return true;
}

export function classifyEpicReplanApproval(input: {
  epic: Ticket;
  repo: RepoConfig;
  mutations: EpicReplanMutation[];
}): { requiresHumanApproval: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const mut of input.mutations) {
    if (mut.kind === "add_subtask") {
      reasons.push(`Adds subtask '${mut.title ?? mut.targetSubtaskKey ?? "new"}'`);
    } else if (mut.kind === "skip_subtask") {
      reasons.push(`Skips subtask '${mut.targetSubtaskKey ?? mut.targetTicketId ?? "?"}'`);
    } else if (mut.kind === "update_subtask" && mut.allowedPaths && mut.allowedPaths.length > 0) {
      if (!isSubtaskScopeWithinEpic(mut.allowedPaths, input.epic.mandate.allowedPaths)) {
        reasons.push(
          `Expands allowedPaths (${mut.allowedPaths.join(", ")}) beyond Epic mandate (${input.epic.mandate.allowedPaths.join(", ")})`,
        );
      }
    }
  }
  return {
    requiresHumanApproval: reasons.length > 0,
    reasons,
  };
}

export function evaluateHeuristicEpicReplan(input: {
  epic: Ticket;
  completedSubtask: Ticket;
  digest: HandoverDigest;
  unstartedSubtasks: Ticket[];
  allSubtasks: Ticket[];
}): EpicReplanProposal {
  const createdAt = nowIso();
  const empty: EpicReplanProposal = {
    shouldReplan: false,
    requiresHumanApproval: false,
    summary: "No downstream DAG adjustment needed.",
    triggeredByTicketId: input.completedSubtask.id,
    mutations: [],
    createdAt,
  };

  if (input.unstartedSubtasks.length === 0) {
    return empty;
  }

  const mutations: EpicReplanMutation[] = [];
  const fullText = `${input.digest.summary}\n${input.digest.contractSnippets.join("\n")}\n${input.digest.formattedMarkdown}`;

  // 1. Honor explicit directive markers if present in digest summary/contract snippets
  const addMatch = fullText.match(/\[EPIC_REPLAN_ADD:\s*([^|\]]+?)(?:\s*\|\s*scope:([^\]]+))?\]/i);
  if (addMatch && input.allSubtasks.length < 10) {
    const newTitle = addMatch[1]!.trim();
    const rawScope = addMatch[2]?.split(",").map((s) => s.trim()).filter(Boolean) ?? ["**"];
    mutations.push({
      kind: "add_subtask",
      title: newTitle,
      description: `Adaptive integration step triggered by handover from ${input.completedSubtask.title}: ${newTitle}`,
      allowedPaths: rawScope,
      dependsOnKeys: input.completedSubtask.subtaskKey ? [input.completedSubtask.subtaskKey] : [],
      reason: `Handover from ${input.completedSubtask.title} requested an additional follow-up subtask`,
    });
  }

  const skipMatch = fullText.match(/\[EPIC_REPLAN_SKIP:\s*([a-zA-Z0-9_-]+)\]/i);
  if (skipMatch) {
    const keyToSkip = skipMatch[1]!.trim();
    const target = input.unstartedSubtasks.find(
      (s) => s.subtaskKey === keyToSkip || s.id === keyToSkip,
    );
    if (target) {
      mutations.push({
        kind: "skip_subtask",
        targetSubtaskKey: target.subtaskKey,
        targetTicketId: target.id,
        reason: `Upstream handover marked '${target.subtaskKey ?? target.title}' redundant`,
      });
    }
  }

  // 2. If completed subtask exported new concrete symbols/contracts not yet noted in a direct waiting dependent,
  // refine the downstream subtask's description/acceptanceCriteria inside its authorized scope.
  if (mutations.length === 0 && (input.digest.exportedSymbols.length > 0 || input.digest.contractSnippets.length > 0)) {
    const directDependents = input.unstartedSubtasks.filter((sub) =>
      sub.dependsOn.includes(input.completedSubtask.id),
    );
    for (const child of directDependents.slice(0, 2)) {
      const marker = `[Synced from ${input.completedSubtask.subtaskKey ?? input.completedSubtask.id}]`;
      if (child.description.includes(marker)) continue;
      const symSummary = input.digest.exportedSymbols.slice(0, 6).join(", ");
      const contractPart = input.digest.contractSnippets.slice(0, 2).join("; ");
      const addendumParts = [
        symSummary ? `Symbols: ${symSummary}` : "",
        contractPart ? `Contracts: ${contractPart}` : "",
      ].filter(Boolean);
      if (addendumParts.length === 0) continue;

      mutations.push({
        kind: "update_subtask",
        targetSubtaskKey: child.subtaskKey,
        targetTicketId: child.id,
        description: `${child.description}\n\n${marker} Align with upstream ${input.completedSubtask.title} — ${addendumParts.join(" | ")}`,
        acceptanceCriteria: symSummary
          ? [...child.inlineMemory.acceptanceCriteria, `Consume upstream exports (${symSummary})`]
          : undefined,
        reason: `Propagate newly finalized exports/contracts from ${input.completedSubtask.title}`,
      });
    }
  }

  if (mutations.length === 0) {
    return empty;
  }

  const { requiresHumanApproval, reasons } = classifyEpicReplanApproval({
    epic: input.epic,
    repo: {
      id: input.epic.repoId,
      name: "",
      rootPath: "",
      baseBranch: "main",
      mode: "observe",
      defaultTemplate: input.epic.template,
      preferredImplementEngine: "claude",
      preferredReviewEngine: "codex",
      createdAt,
      updatedAt: createdAt,
    },
    mutations,
  });

  return {
    shouldReplan: true,
    requiresHumanApproval,
    summary:
      reasons.length > 0
        ? `Adaptive DAG re-plan (${mutations.length} change(s)): ${reasons.join("; ")}`
        : `Refined ${mutations.length} downstream subtask specification(s) from ${input.completedSubtask.title} handover.`,
    triggeredByTicketId: input.completedSubtask.id,
    mutations: mutations.slice(0, 4),
    createdAt,
  };
}
