import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveRepoBlueprints } from "../blueprints.ts";
import { selectRelevantCasesForContext } from "../casebook.ts";
import { runChiefOfStaffQuery } from "../chief.ts";
import { buildRunDigestReport } from "../digest.ts";
import { buildHandoverDigest } from "../handover.ts";
import { formatPlaybookContext, selectPlaybookRulesForContext } from "../playbook.ts";
import type {
  ChiefAskInput,
  ChiefAskResult,
  FlightEvent,
  HandoverDigest,
  RepoConfig,
  ReviewEvidencePacket,
  RunDigestReport,
  StageKind,
  SymbolImpactReport,
  TaskBlueprint,
  Ticket,
} from "../types.ts";
import { nowIso } from "../utils.ts";
import type { KernelCoordinatorContext } from "./context.ts";
import { utcTodayString } from "./kernel-runtime-ops.ts";

async function listFlightEvents(
  ctx: KernelCoordinatorContext,
  filter?: { repoId?: string; limit?: number; sinceIso?: string },
): Promise<FlightEvent[]> {
  return (await ctx.stateStore.listFlightEvents?.(filter)) ?? [];
}

export async function buildEnrichedWorkerPromptOp(
  ctx: KernelCoordinatorContext,
  ticket: Ticket,
  repo: RepoConfig,
  stage: StageKind,
  options?: { skipHitTracking?: boolean; reviewEvidence?: ReviewEvidencePacket; worktreePath?: string },
) : Promise<string> {
  const ts = nowIso();
  const [relatedMemory, playbookEntries, caseEntries] = await Promise.all([
    ctx.stateStore.searchMemory(ticket.title, 6, repo.id),
    ctx.stateStore.listPlaybookEntries(repo.id, { onlyEnabled: true }),
    ctx.stateStore.listCasebookEntries(repo.id, { includeReverted: true }),
  ]);

  const upstreamHandovers: HandoverDigest[] = [];
  if (ticket.dependsOn.length > 0) {
    const reposById = new Map((await ctx.stateStore.listRepos()).map((r) => [r.id, r]));
    for (const depId of ticket.dependsOn) {
      const dep = await ctx.stateStore.getTicket(depId);
      if (!dep) continue;
      if (dep.handoverDigest) {
        upstreamHandovers.push(dep.handoverDigest);
      } else if (dep.status === "delivered") {
        const depFiles = Array.from(
          new Set(dep.inlineMemory.stageNotes.flatMap((n) => n.changedFiles)),
        );
        upstreamHandovers.push(
          buildHandoverDigest({
            ticket: dep,
            repoName: reposById.get(dep.repoId)?.name,
            changedFiles: depFiles,
            diffText: "",
            stageSummary: dep.inlineMemory.stageNotes.at(-1)?.summary || dep.title,
          }),
        );
      }
    }
  }

  const pathExists = (relPath: string): boolean => existsSync(join(repo.rootPath, relPath));
  const selectedPlaybook = selectPlaybookRulesForContext(
    playbookEntries,
    ticket.mandate.allowedPaths,
    8,
    1200,
    { pathExists },
  );
  const playbookContext = formatPlaybookContext(
    playbookEntries,
    ticket.mandate.allowedPaths,
    8,
    1200,
    { pathExists },
  );

  const otherCases = caseEntries.filter((c) => c.ticketId !== ticket.id);
  const ftsTicketIds = new Set(relatedMemory.map((m) => m.ticketId));
  const caseSelection = selectRelevantCasesForContext({
    cases: otherCases,
    ftsTicketIds,
    targetPaths: ticket.mandate.allowedPaths,
    queryText: `${ticket.title} ${ticket.description}`,
    maxPositive: 2,
    maxChars: 900,
  });

  if (!options?.skipHitTracking) {
    if (selectedPlaybook.length > 0) {
      await ctx.stateStore.recordPlaybookHits(
        selectedPlaybook.map((e) => e.id),
        ts,
      );
    }
    if (caseSelection.positiveCases.length > 0) {
      await ctx.stateStore.recordCasebookHits(
        caseSelection.positiveCases.map((c) => c.id),
        ts,
      );
    }
  }

  let symbolContextPack: string | undefined;
  if (
    (stage === "plan" || stage === "spec_test" || stage === "implement") &&
    ctx.workspace.analyzeSymbolImpact &&
    !ticket.mandate.allowedPaths.includes("**")
  ) {
    const impact = await ctx.workspace
      .analyzeSymbolImpact(repo.rootPath, ticket.mandate.allowedPaths)
      .catch(() => null);
    if (impact?.contextPackMarkdown?.trim()) {
      symbolContextPack = impact.contextPackMarkdown.trim();
    }
  }

  let surgicalContextPack: string | undefined;
  if (
    (stage === "plan" || stage === "implement" || stage === "review") &&
    ctx.workspace.buildSurgicalContextPack &&
    !ticket.mandate.allowedPaths.includes("**")
  ) {
    const pack = await ctx.workspace
      .buildSurgicalContextPack({
        worktreePath: ticket.worktreePath ?? repo.rootPath,
        allowedPaths: ticket.mandate.allowedPaths,
      })
      .catch(() => undefined);
    if (pack?.trim()) surgicalContextPack = pack.trim();
  }

  return ctx.memory.buildWorkerPromptContext(ticket, stage, relatedMemory, {
    surgicalContextPack,
    reviewEvidence: options?.reviewEvidence,
    worktreePath: options?.worktreePath,
    verificationCommands: repo.verificationCommands,
    smokeCheck: repo.smokeCheck,
    repoConventions:
      [repo.conventions?.trim(), symbolContextPack].filter(Boolean).join("\n\n") || undefined,
    playbookContext,
    casebookContext: caseSelection.formattedMarkdown || undefined,
    upstreamHandovers,
  });
}

export async function askChiefOp(
  ctx: KernelCoordinatorContext,
  input: ChiefAskInput,
) : Promise<ChiefAskResult> {
  const [allRepos, repo, tickets, inboxItems] = await Promise.all([
    ctx.stateStore.listRepos(),
    input.repoId ? ctx.stateStore.getRepo(input.repoId) : Promise.resolve(null),
    ctx.stateStore.listTickets(),
    ctx.stateStore.listInboxItems(),
  ]);
  const effectiveRepo = repo ?? (allRepos.length === 1 ? allRepos[0] : undefined);
  const [metrics, memoryHits, probeContext] = await Promise.all([
    ctx.stateStore.getMetricsSummary(effectiveRepo?.id, utcTodayString()),
    ctx.stateStore.searchMemory(input.question, 6, effectiveRepo?.id),
    effectiveRepo && ctx.workspace.runRepoPreProbe
      ? ctx.workspace
          .runRepoPreProbe(
            effectiveRepo.rootPath,
            input.question,
            effectiveRepo.forbiddenPaths,
          )
          .catch(() => undefined)
      : Promise.resolve(undefined),
  ]);

  return runChiefOfStaffQuery({
    question: input.question,
    repo: effectiveRepo,
    allRepos,
    tickets,
    inboxItems,
    metrics,
    memoryHits,
    probeContext,
    llm: ctx.llm,
    probeExecutor: effectiveRepo ? ctx.createRepoProbeExecutor(effectiveRepo) : undefined,
  });
}

export async function getRunDigestOp(
  ctx: KernelCoordinatorContext,
  options?: { repoId?: string; hours?: number },
) : Promise<RunDigestReport> {
  const windowHours = options?.hours ?? 24;
  const sinceIso =
    windowHours > 0 ? new Date(Date.now() - windowHours * 3_600_000).toISOString() : undefined;
  // Prefilter by the same window predicate the digest applies (ticket.updatedAt) so we only
  // fetch stage runs for in-window tickets instead of the entire history.
  const allTickets = await ctx.stateStore.listTickets(
    options?.repoId ? { repoId: options.repoId } : undefined,
  );
  const tickets = sinceIso
    ? allTickets.filter((t) => (t.updatedAt ?? t.createdAt) >= sinceIso)
    : allTickets;
  const stageRuns = (
    await Promise.all(tickets.map((t) => ctx.stateStore.listStageRuns(t.id)))
  ).flat();
  const flightEvents = await listFlightEvents(ctx, {
    repoId: options?.repoId,
    sinceIso,
    limit: 500,
  });
  return buildRunDigestReport({
    repoId: options?.repoId,
    windowHours,
    tickets,
    stageRuns,
    flightEvents,
  });
}

export async function analyzeRepoImpactOp(
  ctx: KernelCoordinatorContext,
  repoId: string,
  paths: string[],
) : Promise<SymbolImpactReport> {
  const repo = await ctx.stateStore.getRepo(repoId);
  if (!repo) {
    throw new Error(`Repository not found: ${repoId}`);
  }
  if (!ctx.workspace.analyzeSymbolImpact) {
    throw new Error("WorkspaceProvider does not support symbol impact analysis.");
  }
  return ctx.workspace.analyzeSymbolImpact(repo.rootPath, paths);
}

export async function listRepoBlueprintsOp(
  ctx: KernelCoordinatorContext,
  repoId: string,
) : Promise<TaskBlueprint[]> {
  const repo = await ctx.stateStore.getRepo(repoId);
  if (!repo) {
    throw new Error(`Repository not found: ${repoId}`);
  }
  return resolveRepoBlueprints(repo);
}
