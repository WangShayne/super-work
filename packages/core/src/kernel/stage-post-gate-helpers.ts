import { pickNextFallbackEngine } from "../arena.ts";
import type { StageRun, Ticket } from "../types.ts";
import { nowIso } from "../utils.ts";
import type { KernelCoordinatorContext } from "./context.ts";
import { failCampaignWaveTicket } from "./stage-delivery-helpers.ts";
import type { StagePostTurnState } from "./stage-post-turn-helpers.ts";
import type { runRepoVerificationGateOp } from "./stage-verification-helpers.ts";

/** Handles a failed deterministic verification gate after the implement stage. */
export async function handleImplementGateFailureOp(
  ctx: KernelCoordinatorContext,
  s: StagePostTurnState,
  input: {
    gate: Awaited<ReturnType<typeof runRepoVerificationGateOp>>;
    worktreePath: string;
    changedFiles: string[];
    diffText: string;
    verificationArtifacts: Awaited<ReturnType<typeof runRepoVerificationGateOp>>["artifacts"];
  },
): Promise<void> {
  const { gate, worktreePath, changedFiles, diffText, verificationArtifacts } = input;
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

  const failedSummary = gate.result?.summary ?? "Deterministic verification gate failed";
  const failedRun: StageRun = {
    ...stageRun,
    status: "failed",
    nativeSessionId: discoveredSessionId,
    costUsd: stageCostUsd,
    spans: spans.toArray(),
    toolProfile,
    completedAt: nowIso(),
    summary: failedSummary,
  };
  const { note: failNote } = await ctx.memory.recordStageSpillAndNote({
    ticket,
    stageRun: failedRun,
    events: collectedEvents,
    changedFiles,
    diffText,
    summary: failedSummary,
    verificationPassed: false,
    extraArtifacts: verificationArtifacts.length > 0 ? verificationArtifacts : undefined,
  });
  failedRun.spillTranscriptId = failNote.spillArtifactIds[0];
  await ctx.stateStore.saveStageRun(failedRun);
  await ctx.captureTicketCheckpoint(ticket, repo, worktreePath, {
    stage: "implement",
    stageRunId: failedRun.id,
    engine: driverEngine,
    label: `Implement attempt #${ticket.stageRetries + 1} (failed gate)`,
    changedFiles,
    verificationPassed: false,
  });
  ctx.emitEvent({
    type: "stage_completed",
    ticketId: ticket.id,
    stageRun: failedRun,
    note: failNote,
    timestamp: failedRun.completedAt!,
  });

  const updatedFailSessions = discoveredSessionId
    ? { ...ticket.nativeSessions, [driverEngine]: discoveredSessionId }
    : ticket.nativeSessions;
  const updatedFailMemory = {
    ...ticket.inlineMemory,
    stageNotes: [...ticket.inlineMemory.stageNotes, failNote],
    activeHint: `Deterministic verification failed (${gate.result?.failedCommand ?? "checks"}). Fix the errors and verify locally:\n${failedSummary}`,
  };

  if (ticket.stageRetries < ticket.mandate.maxStageRetries) {
    const retrying: Ticket = {
      ...ticket,
      status: "queued",
      stageRetries: ticket.stageRetries + 1,
      costUsd: ticket.costUsd + stageCostUsd,
      nativeSessions: updatedFailSessions,
      activeEngine: driverEngine,
      inlineMemory: updatedFailMemory,
      updatedAt: nowIso(),
    };
    await ctx.stateStore.saveTicket(retrying);
    ctx.emitEvent({ type: "ticket_updated", ticket: retrying, timestamp: retrying.updatedAt });
  } else {
    const nextFailed = Array.from(new Set([...(ticket.failedEngines ?? []), driverEngine]));
    const fallbackEngine = pickNextFallbackEngine({
      currentEngine: driverEngine,
      failedEngines: nextFailed,
      repo,
      availableEngines,
      trippedEngines,
    });
    if (fallbackEngine) {
      const handedOff: Ticket = {
        ...ticket,
        status: "queued",
        stageRetries: 0,
        costUsd: ticket.costUsd + stageCostUsd,
        nativeSessions: updatedFailSessions,
        failedEngines: nextFailed,
        activeEngine: fallbackEngine,
        inlineMemory: {
          ...updatedFailMemory,
          activeHint: `[Engine Fallback: ${driverEngine} -> ${fallbackEngine}] ${driverEngine} exhausted retries on verification gate (${gate.result?.failedCommand ?? "checks"}). Preserved worktree changes; fix and pass verification:\n${failedSummary}`,
        },
        updatedAt: nowIso(),
      };
      await ctx.stateStore.saveTicket(handedOff);
      ctx.emitEvent({ type: "ticket_updated", ticket: handedOff, timestamp: handedOff.updatedAt });
    } else if (ticket.campaignId) {
      await failCampaignWaveTicket(
        ctx,
        {
          ...ticket,
          costUsd: ticket.costUsd + stageCostUsd,
          nativeSessions: updatedFailSessions,
          failedEngines: nextFailed,
          inlineMemory: updatedFailMemory,
        },
        repo,
        `Verification failed: ${gate.result?.failedCommand ?? failedSummary}`,
      );
    } else {
      await ctx.escalateTicket(
        {
          ...ticket,
          costUsd: ticket.costUsd + stageCostUsd,
          nativeSessions: updatedFailSessions,
          failedEngines: nextFailed,
          inlineMemory: updatedFailMemory,
        },
        "watchdog_escalation",
        `Deterministic verification failed after ${ticket.mandate.maxStageRetries} retries: ${gate.result?.failedCommand ?? failedSummary}`,
        { stageRunId: failedRun.id, failedCommand: gate.result?.failedCommand, failedEngines: nextFailed },
      );
    }
  }
}
