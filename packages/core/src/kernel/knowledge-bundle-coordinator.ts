import { normalizePlaybookRuleText } from "../playbook.ts";
import type {
  CasebookEntry,
  ImportKnowledgeBundleResult,
  PlaybookEntry,
  RepoConfig,
  RepoKnowledgeBundle,
  TaskBlueprint,
} from "../types.ts";
import { newId, nowIso } from "../utils.ts";
import type { KernelCoordinatorContext } from "./context.ts";

export async function exportRepoKnowledgeBundle(
  ctx: KernelCoordinatorContext,
  repoId: string,
): Promise<RepoKnowledgeBundle> {
  const repo = await ctx.stateStore.getRepo(repoId);
  if (!repo) {
    throw new Error(`Repository not found: ${repoId}`);
  }
  const [playbookEntries, casebookEntries] = await Promise.all([
    ctx.stateStore.listPlaybookEntries(repo.id),
    ctx.stateStore.listCasebookEntries(repo.id, { includeReverted: true }),
  ]);

  return {
    version: 1,
    exportedAt: nowIso(),
    sourceRepoName: repo.name,
    playbook: playbookEntries
      .filter((e) => e.enabled)
      .map((e) => ({
        rule: e.rule,
        scopePaths: [...e.scopePaths],
        pinned: e.pinned,
      })),
    casebook: casebookEntries.map((c) => ({
      title: c.title,
      goalSummary: c.goalSummary,
      solutionSummary: c.solutionSummary,
      pitfallsAndFixes: c.pitfallsAndFixes,
      changedFiles: [...c.changedFiles],
      scopePaths: [...c.scopePaths],
      exportedSymbols: [...c.exportedSymbols],
      reverted: c.reverted,
    })),
    blueprints: (repo.blueprints ?? []).map((b) => ({
      ...b,
      builtin: false,
    })),
  };
}

export async function importRepoKnowledgeBundle(
  ctx: KernelCoordinatorContext,
  repoId: string,
  bundle: RepoKnowledgeBundle,
): Promise<ImportKnowledgeBundleResult> {
  if (!bundle || bundle.version !== 1) {
    throw new Error("Unsupported knowledge bundle version (expected version=1).");
  }
  const repo = await ctx.stateStore.getRepo(repoId);
  if (!repo) {
    throw new Error(`Repository not found: ${repoId}`);
  }

  const [existingPlaybook, existingCasebook] = await Promise.all([
    ctx.stateStore.listPlaybookEntries(repo.id),
    ctx.stateStore.listCasebookEntries(repo.id, { includeReverted: true }),
  ]);

  const existingRuleKeys = new Set(existingPlaybook.map((p) => normalizePlaybookRuleText(p.rule)));
  const existingCaseKeys = new Set(
    existingCasebook.map((c) => `${c.title.trim().toLowerCase()}::${c.goalSummary.trim().toLowerCase()}`),
  );
  const existingBpMap = new Map<string, TaskBlueprint>(
    (repo.blueprints ?? []).map((b) => [b.id, b]),
  );

  let importedPlaybook = 0;
  let importedCasebook = 0;
  let importedBlueprints = 0;
  let skippedDuplicates = 0;
  const ts = nowIso();

  for (const rawRule of bundle.playbook ?? []) {
    const cleanRule = rawRule.rule?.trim();
    if (!cleanRule) continue;
    const key = normalizePlaybookRuleText(cleanRule);
    if (existingRuleKeys.has(key)) {
      skippedDuplicates += 1;
      continue;
    }
    existingRuleKeys.add(key);
    const entry: PlaybookEntry = {
      id: newId("pbk"),
      repoId: repo.id,
      rule: cleanRule.slice(0, 220),
      scopePaths: rawRule.scopePaths?.length ? [...rawRule.scopePaths] : ["**"],
      source: "human",
      enabled: true,
      pinned: Boolean(rawRule.pinned),
      hitCount: 0,
      createdAt: ts,
      updatedAt: ts,
    };
    await ctx.stateStore.savePlaybookEntry(entry);
    ctx.emitEvent({ type: "playbook_updated", repoId: repo.id, entry, timestamp: ts });
    importedPlaybook += 1;
  }

  for (const rawCase of bundle.casebook ?? []) {
    const title = rawCase.title?.trim();
    const goalSummary = rawCase.goalSummary?.trim();
    if (!title || !goalSummary) continue;
    const key = `${title.toLowerCase()}::${goalSummary.toLowerCase()}`;
    if (existingCaseKeys.has(key)) {
      skippedDuplicates += 1;
      continue;
    }
    existingCaseKeys.add(key);
    const entry: CasebookEntry = {
      id: newId("cbk"),
      repoId: repo.id,
      ticketId: `bundle_${newId("src")}`,
      title,
      goalSummary,
      solutionSummary: rawCase.solutionSummary?.trim() || goalSummary,
      pitfallsAndFixes: rawCase.pitfallsAndFixes?.trim() || undefined,
      changedFiles: rawCase.changedFiles ?? [],
      scopePaths: rawCase.scopePaths?.length ? rawCase.scopePaths : ["**"],
      exportedSymbols: rawCase.exportedSymbols ?? [],
      reverted: Boolean(rawCase.reverted),
      hitCount: 0,
      createdAt: ts,
      updatedAt: ts,
    };
    await ctx.stateStore.saveCasebookEntry(entry);
    ctx.emitEvent({ type: "casebook_updated", repoId: repo.id, entry, timestamp: ts });
    importedCasebook += 1;
  }

  for (const rawBp of bundle.blueprints ?? []) {
    const cleanId = rawBp.id?.trim();
    if (!cleanId) continue;
    if (existingBpMap.has(cleanId)) {
      skippedDuplicates += 1;
      continue;
    }
    existingBpMap.set(cleanId, {
      ...rawBp,
      id: cleanId,
      builtin: false,
    });
    importedBlueprints += 1;
  }

  if (importedBlueprints > 0) {
    const updatedRepo: RepoConfig = {
      ...repo,
      blueprints: Array.from(existingBpMap.values()),
      updatedAt: nowIso(),
    };
    await ctx.stateStore.upsertRepo(updatedRepo);
    ctx.emitEvent({ type: "repo_updated", repo: updatedRepo, timestamp: updatedRepo.updatedAt });
  }

  return {
    importedPlaybook,
    importedCasebook,
    importedBlueprints,
    skippedDuplicates,
  };
}
