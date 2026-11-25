import { isSpecTestFilePath } from "../engine-router.ts";
import { validateChangedFilesAgainstMandate } from "../mandate.ts";
import { getNextStage } from "../pipeline.ts";
import { buildStageToolProfile } from "../tool-profiler.ts";
import type {
  RepoConfig,
  SpillArtifact,
  StageRun,
  Ticket,
  WorkerEngineId,
  WorkerStreamEvent,
} from "../types.ts";
import { nowIso } from "../utils.ts";
import type { KernelCoordinatorContext } from "./context.ts";

export async function handleSpecTestPostTurnOp(
  ctx: KernelCoordinatorContext,
  input: {
    ticket: Ticket;
    repo: RepoConfig;
    stageRun: StageRun;
    worktreePath: string;
    effectiveBaseBranch: string;
    driverEngine: WorkerEngineId;
    collectedEvents: WorkerStreamEvent[];
    completedEvent: Extract<WorkerStreamEvent, { type: "completed" }> | null;
    discoveredSessionId?: string;
    stageCostUsd: number;
  },
): Promise<void> {
  const {
    ticket,
    repo,
    stageRun,
    worktreePath,
    effectiveBaseBranch,
    driverEngine,
    collectedEvents,
    completedEvent,
    discoveredSessionId,
    stageCostUsd,
  } = input;

  const changedFiles = await ctx.workspace.getChangedFiles(worktreePath, effectiveBaseBranch);
  const diffText = await ctx.workspace.getDiff(worktreePath, effectiveBaseBranch);
  const textChunks = collectedEvents
    .filter((e): e is Extract<WorkerStreamEvent, { type: "text" }> => e.type === "text")
    .map((e) => e.text)
    .join("\n");
  const summary = completedEvent?.summary || textChunks || "spec_test completed";

  const forbiddenViolations = validateChangedFilesAgainstMandate(changedFiles, {
    ...ticket.mandate,
    allowedPaths: ["**"],
  }).forbiddenViolations;
  const nonTestFiles = changedFiles.filter((f) => !isSpecTestFilePath(f));
  const updatedSessions = discoveredSessionId
    ? { ...ticket.nativeSessions, [driverEngine]: discoveredSessionId }
    : ticket.nativeSessions;

  if (forbiddenViolations.length > 0 || nonTestFiles.length > 0) {
    const toRevert = Array.from(new Set([...forbiddenViolations, ...nonTestFiles]));
    await ctx.workspace.revertPaths(worktreePath, toRevert);
    const failSummary = `spec_test may only create/modify test files; reverted: ${toRevert.join(", ")}`;
    const failedRun: StageRun = {
      ...stageRun,
      status: "failed",
      nativeSessionId: discoveredSessionId,
      costUsd: stageCostUsd,
      completedAt: nowIso(),
      summary: failSummary,
    };
    await ctx.stateStore.saveStageRun(failedRun);
    const { note: errNote } = await ctx.memory.recordStageSpillAndNote({
      ticket,
      stageRun: failedRun,
      events: collectedEvents,
      changedFiles: toRevert,
      diffText,
      summary: failSummary,
      verificationPassed: false,
    });

    if (forbiddenViolations.length === 0 && ticket.stageRetries < ticket.mandate.maxStageRetries) {
      const retrying: Ticket = {
        ...ticket,
        status: "queued",
        stageRetries: ticket.stageRetries + 1,
        costUsd: ticket.costUsd + stageCostUsd,
        nativeSessions: updatedSessions,
        inlineMemory: {
          ...ticket.inlineMemory,
          stageNotes: [...ticket.inlineMemory.stageNotes, errNote],
          activeHint: `spec_test stage may ONLY write test files (*.test.*, *.spec.*, test/**, tests/**, __tests__/**). Reverted non-test files: ${nonTestFiles.join(", ")}. Write failing tests only.`,
        },
        updatedAt: nowIso(),
      };
      await ctx.stateStore.saveTicket(retrying);
      ctx.emitEvent({ type: "ticket_updated", ticket: retrying, timestamp: retrying.updatedAt });
    } else {
      await ctx.escalateTicket(
        {
          ...ticket,
          costUsd: ticket.costUsd + stageCostUsd,
          nativeSessions: updatedSessions,
          inlineMemory: {
            ...ticket.inlineMemory,
            stageNotes: [...ticket.inlineMemory.stageNotes, errNote],
          },
        },
        "mandate_violation",
        failSummary,
        { violations: toRevert, forbiddenViolations, nonTestFiles, interruptedStage: "spec_test" },
      );
    }
    return;
  }

  const testFiles = changedFiles.filter((f) => isSpecTestFilePath(f));
  if (testFiles.length === 0) {
    const emptySummary = "spec_test produced no test files to lock.";
    const failedRun: StageRun = {
      ...stageRun,
      status: "failed",
      nativeSessionId: discoveredSessionId,
      costUsd: stageCostUsd,
      completedAt: nowIso(),
      summary: emptySummary,
    };
    await ctx.stateStore.saveStageRun(failedRun);
    const { note: emptyNote } = await ctx.memory.recordStageSpillAndNote({
      ticket,
      stageRun: failedRun,
      events: collectedEvents,
      changedFiles: [],
      diffText,
      summary: emptySummary,
      verificationPassed: false,
    });

    if (ticket.stageRetries < ticket.mandate.maxStageRetries) {
      const retrying: Ticket = {
        ...ticket,
        status: "queued",
        stageRetries: ticket.stageRetries + 1,
        costUsd: ticket.costUsd + stageCostUsd,
        nativeSessions: updatedSessions,
        inlineMemory: {
          ...ticket.inlineMemory,
          stageNotes: [...ticket.inlineMemory.stageNotes, emptyNote],
          activeHint:
            "spec_test stage created zero test files. Write at least one failing test file encoding the acceptance criteria.",
        },
        updatedAt: nowIso(),
      };
      await ctx.stateStore.saveTicket(retrying);
      ctx.emitEvent({ type: "ticket_updated", ticket: retrying, timestamp: retrying.updatedAt });
    } else {
      await ctx.escalateTicket(
        {
          ...ticket,
          costUsd: ticket.costUsd + stageCostUsd,
          nativeSessions: updatedSessions,
          inlineMemory: {
            ...ticket.inlineMemory,
            stageNotes: [...ticket.inlineMemory.stageNotes, emptyNote],
          },
        },
        "watchdog_escalation",
        emptySummary,
        { stageRunId: failedRun.id },
      );
    }
    return;
  }

  const extraArtifacts: SpillArtifact[] = [];
  let redProbeHint = `Locked spec_test file(s): ${testFiles.join(", ")}. Implement ONLY production code to pass these tests.`;
  const commands = (repo.verificationCommands ?? []).map((c) => c.trim()).filter(Boolean);
  if (commands.length > 0) {
    const redRes = await ctx.workspace.runVerificationCommands(
      worktreePath,
      commands,
      ticket.mandate.maxDurationSec,
      {
        sandboxMode: repo.sandboxMode ?? "balanced",
        forbiddenPaths: ticket.mandate.forbiddenPaths,
        allowNetwork: ticket.mandate.allowNetwork,
        rootRepoPath: repo.rootPath,
      },
    );
    const logBody = redRes.results
      .map(
        (r) =>
          `$ ${r.command}\n[exit=${r.exitCode}, duration=${r.durationMs}ms]\n${r.output || "(no output)"}\n`,
      )
      .join("\n---\n");
    const probeArtifact = await ctx.artifactStore.writeSpill(
      {
        ticketId: ticket.id,
        stageRunId: stageRun.id,
        kind: "test_log",
        summary: `Red-first probe (${redRes.ok ? "GREEN advisory" : "RED expected fail"})`,
        ext: "log",
      },
      logBody || redRes.summary,
    );
    await ctx.stateStore.saveArtifact(probeArtifact, `${redRes.summary}\n${logBody}`);
    extraArtifacts.push(probeArtifact);
    redProbeHint = redRes.ok
      ? `Red-first probe passed early (advisory). Implement remaining behavior cleanly without modifying locked tests: ${testFiles.join(", ")}.`
      : `Red-first probe failed as expected (RED phase) on ${redRes.failedCommand ?? "tests"}. Locked read-only spec tests: ${testFiles.join(", ")}. Implement code until checks pass.`;
  }

  await ctx.workspace.commitAll(worktreePath, `super-work(${ticket.id}/spec_test): lock spec tests`);
  const specTestCommitSha = ctx.workspace.getHeadCommitSha
    ? await ctx.workspace.getHeadCommitSha(worktreePath).catch(() => undefined)
    : undefined;

  const finishedRun: StageRun = {
    ...stageRun,
    status: "completed",
    nativeSessionId: discoveredSessionId,
    costUsd: stageCostUsd,
    toolProfile: buildStageToolProfile(collectedEvents),
    completedAt: nowIso(),
    summary: `${summary}\nLocked ${testFiles.length} spec test file(s).`,
  };
  const { note } = await ctx.memory.recordStageSpillAndNote({
    ticket,
    stageRun: finishedRun,
    events: collectedEvents,
    changedFiles: testFiles,
    diffText,
    summary: finishedRun.summary!,
    verificationPassed: true,
    extraArtifacts: extraArtifacts.length > 0 ? extraArtifacts : undefined,
  });
  finishedRun.spillTranscriptId = note.spillArtifactIds[0];
  await ctx.stateStore.saveStageRun(finishedRun);
  ctx.emitEvent({
    type: "stage_completed",
    ticketId: ticket.id,
    stageRun: finishedRun,
    note,
    timestamp: finishedRun.completedAt!,
  });

  await ctx.captureTicketCheckpoint(ticket, repo, worktreePath, {
    stage: "spec_test",
    stageRunId: finishedRun.id,
    engine: driverEngine,
    label: `Locked ${testFiles.length} spec test file(s)`,
    changedFiles: testFiles,
    verificationPassed: true,
  });

  const nextStage = getNextStage(ticket.template, "spec_test", ticket.tddMode) ?? "implement";
  const nextTicket: Ticket = {
    ...ticket,
    status: "queued",
    currentStage: nextStage,
    stageRetries: 0,
    lockedTestPaths: testFiles,
    specTestCommitSha,
    costUsd: ticket.costUsd + stageCostUsd,
    nativeSessions: updatedSessions,
    activeEngine: undefined,
    failedEngines: [],
    inlineMemory: {
      ...ticket.inlineMemory,
      stageNotes: [...ticket.inlineMemory.stageNotes, note],
      activeHint: redProbeHint,
    },
    updatedAt: nowIso(),
  };
  await ctx.stateStore.saveTicket(nextTicket);
  ctx.emitEvent({ type: "ticket_updated", ticket: nextTicket, timestamp: nextTicket.updatedAt });
}
