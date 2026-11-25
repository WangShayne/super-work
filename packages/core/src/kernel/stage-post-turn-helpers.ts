import { pickNextFallbackEngine } from "../arena.ts";
import { getAlternateEngine } from "../pipeline.ts";
import type { buildStageToolProfile } from "../tool-profiler.ts";
import type {
  RepoConfig,
  StageKind,
  StageRun,
  Ticket,
  WatchdogDecision,
  WatchdogSignal,
  WorkerEngineId,
  WorkerStreamEvent,
} from "../types.ts";
import { newId, nowIso } from "../utils.ts";
import type { KernelCoordinatorContext } from "./context.ts";
import type { SpanRecorder } from "./span-recorder.ts";
import { failCampaignWaveTicket } from "./stage-delivery-helpers.ts";
import { tripEngineIfDeterministic } from "./stage-engine-helpers.ts";

/** Shared state snapshot passed to every post-turn handler. */
export interface StagePostTurnState {
  ticket: Ticket;
  repo: RepoConfig;
  stage: StageKind;
  stageRun: StageRun;
  driverEngine: WorkerEngineId;
  spans: SpanRecorder;
  toolProfile: ReturnType<typeof buildStageToolProfile>;
  collectedEvents: WorkerStreamEvent[];
  discoveredSessionId: string | undefined;
  stageCostUsd: number;
  availableEngines: WorkerEngineId[];
  trippedEngines: WorkerEngineId[];
}

/** Handles user cancellation and kernel shutdown. Returns true when the stage was handled. */
export async function handleCancelledOrStoppedOp(
  ctx: KernelCoordinatorContext,
  s: StagePostTurnState,
): Promise<boolean> {
  const { ticket, stageRun, discoveredSessionId, stageCostUsd, spans, toolProfile } = s;
  const latestTicket = await ctx.stateStore.getTicket(ticket.id);
  if (latestTicket && latestTicket.status === "cancelled") {
    ctx.pendingSteers.delete(ticket.id);
    await ctx.stateStore.saveStageRun({
      ...stageRun,
      status: "aborted",
      nativeSessionId: discoveredSessionId,
      costUsd: stageCostUsd,
      spans: spans.toArray(),
      toolProfile,
      completedAt: nowIso(),
      summary: "Cancelled by user",
    });
    return true;
  }

  if (ctx.isStopped()) {
    ctx.pendingSteers.delete(ticket.id);
    await ctx.stateStore.saveStageRun({
      ...stageRun,
      status: "aborted",
      nativeSessionId: discoveredSessionId,
      costUsd: stageCostUsd,
      spans: spans.toArray(),
      toolProfile,
      completedAt: nowIso(),
      summary: "Aborted on kernel shutdown",
    });
    await ctx.stateStore.saveTicket({
      ...ticket,
      status: "queued",
      costUsd: ticket.costUsd + stageCostUsd,
      updatedAt: nowIso(),
    });
    return true;
  }
  return false;
}

/** Handles a live steer that aborted the turn. Returns true when handled. */
export async function handleLiveSteerOp(
  ctx: KernelCoordinatorContext,
  s: StagePostTurnState,
  abortSignal: AbortSignal,
): Promise<boolean> {
  const {
    ticket,
    stage,
    stageRun,
    driverEngine,
    spans,
    toolProfile,
    collectedEvents,
    discoveredSessionId,
    stageCostUsd,
  } = s;
  const pendingSteer = ctx.pendingSteers.get(ticket.id);
  if (!(pendingSteer && abortSignal.aborted)) return false;

  ctx.pendingSteers.delete(ticket.id);
  const ts = nowIso();
  const steeredRun: StageRun = {
    ...stageRun,
    status: "aborted",
    nativeSessionId: discoveredSessionId,
    costUsd: stageCostUsd,
    spans: spans.toArray(),
    toolProfile,
    steered: true,
    completedAt: ts,
    summary: `Live steer applied: ${pendingSteer.instruction.slice(0, 140)}`,
  };
  const { note: steerNote } = await ctx.memory.recordStageSpillAndNote({
    ticket,
    stageRun: steeredRun,
    events: collectedEvents,
    changedFiles: [],
    summary: steeredRun.summary!,
    verificationPassed: false,
  });
  steeredRun.spillTranscriptId = steerNote.spillArtifactIds[0];
  await ctx.stateStore.saveStageRun(steeredRun);
  ctx.emitEvent({
    type: "stage_completed",
    ticketId: ticket.id,
    stageRun: steeredRun,
    note: steerNote,
    timestamp: ts,
  });

  const preservedSessions =
    discoveredSessionId && stage !== "review"
      ? { ...ticket.nativeSessions, [driverEngine]: discoveredSessionId }
      : ticket.nativeSessions;
  const switchedEngine =
    pendingSteer.preferredEngine && pendingSteer.preferredEngine !== "auto"
      ? pendingSteer.preferredEngine
      : driverEngine;

  const steeredTicket: Ticket = {
    ...ticket,
    status: "queued",
    steerCount: (ticket.steerCount ?? 0) + 1,
    costUsd: ticket.costUsd + stageCostUsd,
    nativeSessions: preservedSessions,
    preferredEngine: pendingSteer.preferredEngine ?? ticket.preferredEngine,
    activeEngine: switchedEngine,
    inlineMemory: {
      ...ticket.inlineMemory,
      stageNotes: [...ticket.inlineMemory.stageNotes, steerNote],
      threadUpdates: [
        ...ticket.inlineMemory.threadUpdates,
        {
          triggerId: newId("str"),
          message: `[Live Steer]: ${pendingSteer.instruction}`,
          createdAt: ts,
        },
      ],
      activeHint: `[LIVE STEER]: ${pendingSteer.instruction}`,
    },
    updatedAt: ts,
  };
  await ctx.stateStore.saveTicket(steeredTicket);
  ctx.emitEvent({ type: "ticket_updated", ticket: steeredTicket, timestamp: ts });
  return true;
}

/** Handles a watchdog-triggered abort (hint injection, engine switch, escalation). */
export async function handleWatchdogAbortOp(
  ctx: KernelCoordinatorContext,
  s: StagePostTurnState,
  dec: WatchdogDecision,
  sig: WatchdogSignal | null,
): Promise<void> {
  const {
    ticket,
    repo,
    stageRun,
    driverEngine,
    spans,
    toolProfile,
    collectedEvents,
    discoveredSessionId,
    stageCostUsd,
    availableEngines,
    trippedEngines,
  } = s;
  const abortedRun: StageRun = {
    ...stageRun,
    status: "aborted",
    nativeSessionId: discoveredSessionId,
    costUsd: stageCostUsd,
    spans: spans.toArray(),
    toolProfile,
    completedAt: nowIso(),
    summary: `Watchdog ${dec.action}: ${dec.reason}`,
  };
  await ctx.memory.recordStageSpillAndNote({
    ticket,
    stageRun: abortedRun,
    events: collectedEvents,
    changedFiles: [],
    summary: abortedRun.summary!,
    verificationPassed: false,
  });

  if (dec.action === "INJECT_HINT") {
    const nextTicket: Ticket = {
      ...ticket,
      status: "queued",
      stageRetries: ticket.stageRetries + 1,
      costUsd: ticket.costUsd + stageCostUsd,
      nativeSessions: discoveredSessionId
        ? { ...ticket.nativeSessions, [driverEngine]: discoveredSessionId }
        : ticket.nativeSessions,
      inlineMemory: {
        ...ticket.inlineMemory,
        activeHint: dec.hint ?? dec.reason,
      },
      updatedAt: nowIso(),
    };
    await ctx.stateStore.saveStageRun(abortedRun);
    await ctx.stateStore.saveTicket(nextTicket);
    ctx.emitEvent({ type: "ticket_updated", ticket: nextTicket, timestamp: nextTicket.updatedAt });
    return;
  }

  if (dec.action === "SWITCH_ENGINE") {
    const nextFailed = Array.from(new Set([...(ticket.failedEngines ?? []), driverEngine]));
    const altEngine =
      dec.targetEngine &&
      dec.targetEngine !== driverEngine &&
      !nextFailed.includes(dec.targetEngine) &&
      availableEngines.includes(dec.targetEngine)
        ? dec.targetEngine
        : pickNextFallbackEngine({
            currentEngine: driverEngine,
            failedEngines: nextFailed,
            repo,
            availableEngines,
            trippedEngines,
          }) ?? getAlternateEngine(driverEngine, availableEngines);
    if (altEngine && altEngine !== driverEngine && !nextFailed.includes(altEngine)) {
      const nextTicket: Ticket = {
        ...ticket,
        status: "queued",
        activeEngine: altEngine,
        failedEngines: nextFailed,
        stageRetries: ticket.stageRetries + 1,
        costUsd: ticket.costUsd + stageCostUsd,
        inlineMemory: {
          ...ticket.inlineMemory,
          activeHint:
            dec.hint ??
            `[Fallback Engine: ${driverEngine} -> ${altEngine}] Switched due to: ${dec.reason}`,
        },
        updatedAt: nowIso(),
      };
      await ctx.stateStore.saveStageRun(abortedRun);
      await ctx.stateStore.saveTicket(nextTicket);
      await ctx.recordFlightEvent?.({
        repoId: repo.id,
        ticketId: ticket.id,
        kind: "watchdog_switch",
        engine: altEngine,
        summary: `Watchdog switched engine ${driverEngine} -> ${altEngine}: ${dec.reason}`,
        metadata: { fromEngine: driverEngine, toEngine: altEngine, stage: stageRun.stage },
      });
      ctx.emitEvent({ type: "ticket_updated", ticket: nextTicket, timestamp: nextTicket.updatedAt });
      return;
    }
  }

  await ctx.stateStore.saveStageRun(abortedRun);
  if (ticket.campaignId) {
    await failCampaignWaveTicket(ctx, { ...ticket, costUsd: ticket.costUsd + stageCostUsd }, repo, dec.reason);
  } else {
    await ctx.escalateTicket(
      { ...ticket, costUsd: ticket.costUsd + stageCostUsd },
      "watchdog_escalation",
      dec.reason,
      { signal: sig, decision: dec },
    );
  }
}

/** Handles a worker turn that ended with a fatal error and no completion event. */
export async function handleFatalWorkerErrorOp(
  ctx: KernelCoordinatorContext,
  s: StagePostTurnState,
  errorMessage: string,
): Promise<void> {
  const {
    ticket,
    repo,
    stage,
    stageRun,
    driverEngine,
    spans,
    toolProfile,
    collectedEvents,
    discoveredSessionId,
    stageCostUsd,
    availableEngines,
    trippedEngines,
  } = s;
  const failedRun: StageRun = {
    ...stageRun,
    status: "failed",
    nativeSessionId: discoveredSessionId,
    costUsd: stageCostUsd,
    spans: spans.toArray(),
    toolProfile,
    completedAt: nowIso(),
    summary: errorMessage,
  };
  await ctx.stateStore.saveStageRun(failedRun);
  await ctx.memory.recordStageSpillAndNote({
    ticket,
    stageRun: failedRun,
    events: collectedEvents,
    changedFiles: [],
    summary: errorMessage,
    verificationPassed: false,
  });

  const nextFailed = Array.from(new Set([...(ticket.failedEngines ?? []), driverEngine]));
  const newlyTripped = await tripEngineIfDeterministic(ctx, {
    engine: driverEngine,
    message: errorMessage,
    repoId: repo.id,
    ticketId: ticket.id,
    stage,
  });
  const fallbackEngine = pickNextFallbackEngine({
    currentEngine: driverEngine,
    failedEngines: nextFailed,
    repo,
    availableEngines,
    trippedEngines: newlyTripped ? [...trippedEngines, driverEngine] : trippedEngines,
  });

  if (fallbackEngine) {
    const handedOff: Ticket = {
      ...ticket,
      status: "queued",
      activeEngine: fallbackEngine,
      failedEngines: nextFailed,
      stageRetries: 0,
      costUsd: ticket.costUsd + stageCostUsd,
      inlineMemory: {
        ...ticket.inlineMemory,
        activeHint: `[Engine Fallback: ${driverEngine} -> ${fallbackEngine}] Previous engine errored (${errorMessage}). Existing worktree state is preserved; continue and finish cleanly.`,
      },
      updatedAt: nowIso(),
    };
    await ctx.stateStore.saveTicket(handedOff);
    ctx.emitEvent({ type: "ticket_updated", ticket: handedOff, timestamp: handedOff.updatedAt });
  } else if (ticket.stageRetries < ticket.mandate.maxStageRetries) {
    const retried: Ticket = {
      ...ticket,
      status: "queued",
      stageRetries: ticket.stageRetries + 1,
      costUsd: ticket.costUsd + stageCostUsd,
      inlineMemory: {
        ...ticket.inlineMemory,
        activeHint: `Previous ${stage} attempt errored (${errorMessage}). Fix and retry.`,
      },
      updatedAt: nowIso(),
    };
    await ctx.stateStore.saveTicket(retried);
    ctx.emitEvent({ type: "ticket_updated", ticket: retried, timestamp: retried.updatedAt });
  } else if (ticket.campaignId) {
    await failCampaignWaveTicket(
      ctx,
      { ...ticket, costUsd: ticket.costUsd + stageCostUsd },
      repo,
      `Stage ${stage} failed: ${errorMessage}`,
    );
  } else {
    await ctx.escalateTicket(
      { ...ticket, costUsd: ticket.costUsd + stageCostUsd },
      "watchdog_escalation",
      `Stage ${stage} failed: ${errorMessage}`,
      { stageRunId: stageRun.id, failedEngines: nextFailed },
    );
  }
}
