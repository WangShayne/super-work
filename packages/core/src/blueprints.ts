import type { DirectTicketInput } from "./ports.ts";
import type { RepoConfig, TaskBlueprint } from "./types.ts";

export const BUILTIN_TASK_BLUEPRINTS: readonly TaskBlueprint[] = [
  {
    id: "tdd-bugfix",
    name: "TDD Bugfix Guard",
    description: "Write a failing regression test first, lock it read-only, then fix production code.",
    template: "standard",
    preferredEngine: "auto",
    tddMode: true,
    deliveryGatePolicy: "risk_gated",
    riskThreshold: 40,
    promptPrefix: "Reproduce the bug with a minimal failing regression test before modifying implementation.",
    acceptanceCriteria: [
      "Failing test reproduces the exact reported bug before fix",
      "All verification commands pass without weakening locked tests",
    ],
    builtin: true,
  },
  {
    id: "ui-visual-polish",
    name: "UI & Visual Regression Check",
    description: "Scoped frontend update with adaptive Bandit routing and CDP/pixel diff verification.",
    template: "standard",
    preferredEngine: "auto",
    tddMode: false,
    visualDiffMode: "informational",
    deliveryGatePolicy: "risk_gated",
    riskThreshold: 45,
    promptPrefix: "Preserve existing responsive layout constraints and avoid console/runtime errors.",
    acceptanceCriteria: [
      "Zero browser console/page errors and responsive 1440x900 layout",
    ],
    builtin: true,
  },
  {
    id: "safe-refactor",
    name: "Safe Modular Refactor",
    description: "Strict review & risk-gated signoff for structural refactors across dependent modules.",
    template: "strict",
    preferredEngine: "auto",
    tddMode: true,
    deliveryGatePolicy: "risk_gated",
    riskThreshold: 30,
    promptPrefix: "Maintain 100% public API compatibility and preserve existing tests while splitting modules.",
    acceptanceCriteria: [
      "Public API signatures and existing tests remain passing",
      "No behavior regressions across 1-hop dependents",
    ],
    builtin: true,
  },
  {
    id: "backend-feature",
    name: "Backend Feature Delivery",
    description: "Balanced standard pipeline with TDD enabled and automatic Bandit engine selection.",
    template: "standard",
    preferredEngine: "auto",
    tddMode: true,
    deliveryGatePolicy: "risk_gated",
    riskThreshold: 35,
    acceptanceCriteria: [
      "New endpoint/service contracts covered by automated tests",
    ],
    builtin: true,
  },
  {
    id: "docs-chore",
    name: "Docs & Low-Risk Chore",
    description: "Fast single-pass execution optimized for documentation, comments, and low-risk chores.",
    template: "fast",
    preferredEngine: "auto",
    tddMode: false,
    deliveryGatePolicy: "always_auto",
    riskThreshold: 60,
    acceptanceCriteria: [
      "Documentation accurately reflects current CLI flags, routes, and versions",
    ],
    builtin: true,
  },
];

export function resolveRepoBlueprints(repo?: RepoConfig): TaskBlueprint[] {
  const byId = new Map<string, TaskBlueprint>();
  for (const bp of BUILTIN_TASK_BLUEPRINTS) {
    byId.set(bp.id, bp);
  }
  for (const custom of repo?.blueprints ?? []) {
    if (!custom.id?.trim()) continue;
    const cleanId = custom.id.trim();
    byId.set(cleanId, {
      ...custom,
      id: cleanId,
      builtin: false,
    });
  }
  return Array.from(byId.values());
}

/**
 * Resolution precedence: explicit ticket input > Blueprint preset > Repo defaults.
 */
export function applyBlueprintToTicketInput(
  input: DirectTicketInput,
  blueprint: TaskBlueprint,
): DirectTicketInput {
  const mergedCriteria =
    input.acceptanceCriteria && input.acceptanceCriteria.length > 0
      ? input.acceptanceCriteria
      : blueprint.acceptanceCriteria;
  const prefix = blueprint.promptPrefix?.trim();
  const baseDesc = input.description.trim();
  const enrichedDescription =
    prefix && !baseDesc.includes(prefix) ? `${prefix}\n\n${baseDesc}` : baseDesc;

  return {
    ...input,
    blueprintId: blueprint.id,
    description: enrichedDescription,
    template: input.template ?? blueprint.template,
    tddMode: input.tddMode !== undefined ? input.tddMode : blueprint.tddMode,
    preferredEngine: input.preferredEngine ?? blueprint.preferredEngine,
    allowedPaths:
      input.allowedPaths && input.allowedPaths.length > 0
        ? input.allowedPaths
        : blueprint.allowedPaths,
    deliveryGatePolicy: input.deliveryGatePolicy ?? blueprint.deliveryGatePolicy,
    riskThreshold:
      input.riskThreshold !== undefined ? input.riskThreshold : blueprint.riskThreshold,
    acceptanceCriteria: mergedCriteria,
  };
}
