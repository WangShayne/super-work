import { createDefaultMandate, mandateScopesOverlap } from "./mandate.ts";
import type {
  EpicDecompositionPlan,
  EpicSubtaskSpec,
  PipelineTemplateId,
  RepoConfig,
} from "./types.ts";

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

export function sanitizeEpicSubtasks(
  rawSpecs: Array<Partial<EpicSubtaskSpec>>,
  defaultTemplate: PipelineTemplateId,
): EpicSubtaskSpec[] {
  const usedKeys = new Set<string>();
  const keyMap = new Map<string, string>();
  const specs: EpicSubtaskSpec[] = rawSpecs.slice(0, 8).map((raw, idx) => {
    const rawKey = typeof raw.key === "string" ? raw.key.trim() : "";
    const key = sanitizeKey(rawKey, idx, usedKeys);
    if (rawKey) {
      keyMap.set(rawKey, key);
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

  // Ensure overlapping allowedPaths between siblings have a deterministic dependency edge
  for (let i = 0; i < specs.length; i++) {
    const a = specs[i]!;
    const mandateA = createDefaultMandate({ allowedPaths: a.allowedPaths });
    for (let j = i + 1; j < specs.length; j++) {
      const b = specs[j]!;
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

export function normalizeEpicDecompositionPlan(
  raw: Partial<EpicDecompositionPlan>,
  fallbackInput: {
    repo: RepoConfig;
    title: string;
    description: string;
    defaultTemplate: PipelineTemplateId;
  },
): EpicDecompositionPlan {
  const subtasks =
    Array.isArray(raw.subtasks) && raw.subtasks.length > 0
      ? sanitizeEpicSubtasks(raw.subtasks, fallbackInput.defaultTemplate)
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
    text.matchAll(/\b((?:packages|apps|src)\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.*-]+)?)/g),
  ).map((m) => {
    const p = m[1]!.replace(/\/+$/, "");
    if (p.includes("*") || /\.[a-z0-9]+$/i.test(p)) return p;
    return `${p}/**`;
  });
  return Array.from(new Set(pkgMatches));
}

export function heuristicDecomposeEpic(input: {
  repo: RepoConfig;
  title: string;
  description: string;
  defaultTemplate: PipelineTemplateId;
}): EpicDecompositionPlan {
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
      const paths = extractScopedPaths(stepText);
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
        title: stepText.length > 72 ? `${stepText.slice(0, 69)}...` : stepText,
        description: `${input.title}\n\nSubtask focus: ${stepText}`,
        template: input.defaultTemplate,
        allowedPaths: paths.length > 0 ? paths : ["**"],
        dependsOnKeys,
        acceptanceCriteria: [`Complete: ${stepText}`, "All verification gates pass"],
      };
    });

    const sanitized = sanitizeEpicSubtasks(specs, input.defaultTemplate);
    return {
      epicTitle: input.title,
      summary: `Decomposed ${steps.length} actionable steps into parallel/staged DAG.`,
      subtasks: sanitized,
    };
  }

  // Module-based decomposition if distinct package/source paths are mentioned
  const detectedPaths = extractScopedPaths(`${input.title}\n${input.description}`);
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
    const sanitized = sanitizeEpicSubtasks(specs, input.defaultTemplate);
    return {
      epicTitle: input.title,
      summary: `Decomposed by module scope (${detectedPaths.length} modules).`,
      subtasks: sanitized,
    };
  }

  // Default 3-stage vertical slice DAG
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
    subtasks: sanitizeEpicSubtasks(defaultSpecs, input.defaultTemplate),
  };
}
