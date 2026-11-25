import { classifyEngineError, getCooldownMsForFailureKind, isEngineTripped } from "../engine-health.ts";
import type { RepoConfig, StageKind, StageRun, Ticket, WorkerEngineId } from "../types.ts";
import type { KernelCoordinatorContext } from "./context.ts";

export function utcTodayString(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Engines whose circuit breaker is currently open (tripped and still cooling down). */
export async function collectTrippedEngines(ctx: KernelCoordinatorContext): Promise<WorkerEngineId[]> {
  try {
    const records = (await ctx.stateStore.listEngineHealth?.()) ?? [];
    const now = Date.now();
    return records.filter((r) => isEngineTripped(r, now)).map((r) => r.engine);
  } catch {
    return [];
  }
}

/** Persists a tripped record when the error is a deterministic account/model failure. */
export async function tripEngineIfDeterministic(
  ctx: KernelCoordinatorContext,
  input: { engine: WorkerEngineId; message: string; repoId: string; ticketId: string; stage: StageKind },
): Promise<boolean> {
  if (input.engine === "mock") return false;
  const cls = classifyEngineError(input.message);
  if (!cls?.deterministic) return false;
  try {
    const prev = await ctx.stateStore.getEngineHealth?.(input.engine);
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    await ctx.stateStore.saveEngineHealth?.({
      engine: input.engine,
      status: "tripped",
      failureKind: cls.kind,
      reason: input.message.slice(0, 500),
      trippedAt: now,
      cooldownUntil: new Date(nowMs + getCooldownMsForFailureKind(cls.kind)).toISOString(),
      consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1,
      lastProbedAt: prev?.lastProbedAt,
      updatedAt: now,
    });
    await ctx.recordFlightEvent?.({
      repoId: input.repoId,
      ticketId: input.ticketId,
      kind: "engine_tripped",
      engine: input.engine,
      summary: `Engine ${input.engine} tripped (${cls.kind}): ${input.message.slice(0, 160)}`,
      metadata: { failureKind: cls.kind, stage: input.stage },
    });
  } catch {
    // Circuit breaker bookkeeping must never fail the stage
  }
  return true;
}

/** Reverts/isolates root-repo writes made by a worker turn that ran in an isolated worktree. */
export async function quarantineSpilloverAfterTurn(
  ctx: KernelCoordinatorContext,
  input: {
    ticket: Ticket;
    repo: RepoConfig;
    stageRun: StageRun;
    engine: WorkerEngineId;
    preTurnDirtyPaths: string[];
  },
): Promise<void> {
  try {
    const res = await ctx.workspace.quarantineRepoSpillover?.({
      rootRepoPath: input.repo.rootPath,
      preTurnDirtyPaths: input.preTurnDirtyPaths,
    });
    if (!res || res.quarantinedPaths.length === 0) return;
    const summary = `Root repo spillover quarantined (${res.quarantinedPaths.length} path(s))`;
    await ctx.artifactStore
      .writeSpill(
        {
          ticketId: input.ticket.id,
          stageRunId: input.stageRun.id,
          kind: "log",
          summary,
          ext: "log",
        },
        res.diffSummary,
      )
      .then((artifact) => ctx.stateStore.saveArtifact(artifact, res.diffSummary));
    console.warn(
      `[super-work] ${summary} for ticket ${input.ticket.id}: ${res.quarantinedPaths.slice(0, 5).join(", ")}`,
    );
    await ctx.recordFlightEvent?.({
      repoId: input.repo.id,
      ticketId: input.ticket.id,
      kind: "spillover_quarantined",
      engine: input.engine,
      summary: `${summary}: ${res.quarantinedPaths.slice(0, 5).join(", ")}`,
      metadata: { paths: res.quarantinedPaths, stageRunId: input.stageRun.id },
    });
  } catch {
    // Spillover shield is best-effort and must never fail the stage
  }
}
