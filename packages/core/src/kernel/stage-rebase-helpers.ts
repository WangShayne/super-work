import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildConflictResolutionPrompt } from "../conflict-resolver.ts";
import { validateChangedFilesAgainstMandate } from "../mandate.ts";
import { selectEngineForStage } from "../pipeline.ts";
import type {
  ConflictSemanticContext,
  RepoConfig,
  StageRun,
  Ticket,
  TicketCheckpoint,
  WorkerStreamEvent,
} from "../types.ts";
import { nowIso } from "../utils.ts";
import type { KernelCoordinatorContext } from "./context.ts";
import { failCampaignWaveTicket, mergeWaveToTargetStagingBranch } from "./stage-delivery-helpers.ts";
import { collectTrippedEngines } from "./stage-engine-helpers.ts";
import { canReuseImplementGate, runRepoVerificationGateOp } from "./stage-verification-helpers.ts";
import { SpanRecorder } from "./span-recorder.ts";

export async function handleRebaseStageOp(
  ctx: KernelCoordinatorContext,
  ticket: Ticket,
  repo: RepoConfig,
  stageRun: StageRun,
): Promise<void> {
  const worktreePath = ticket.worktreePath!;
  const { effectiveBaseBranch, parentEpic } = await ctx.getEffectiveBaseInfo(ticket, repo);
  const spans = new SpanRecorder();
  let workingTicket = ticket;
  let preConflictCp: TicketCheckpoint | null = null;
  let attemptConflictCtx: ConflictSemanticContext | undefined;
  let autoResolvedConflict = false;
  let resolveCostUsd = 0;

  const commitSpan = spans.start("git_ops", `Commit & rebase onto ${effectiveBaseBranch}`);
  await ctx.workspace.commitAll(worktreePath, `super-work(${ticket.id}): ${ticket.title}`);
  const rebaseRes = await ctx.workspace.rebaseOntoBase(worktreePath, effectiveBaseBranch);
  spans.end(commitSpan, rebaseRes.ok ? "ok" : "failed", rebaseRes.conflictSummary);

  if (!rebaseRes.ok) {
    const canAttemptSemanticResolve =
      (ticket.conflictResolutionCount ?? 0) < 1 &&
      Boolean(ctx.workspace.prepareThreeWayConflictWorkspace);

    if (!canAttemptSemanticResolve) {
      const failedRun: StageRun = {
        ...stageRun,
        status: "failed",
        spans: spans.toArray(),
        completedAt: nowIso(),
        summary: rebaseRes.conflictSummary ?? "Rebase conflict",
      };
      await ctx.stateStore.saveStageRun(failedRun);

      if (ticket.stageRetries < ticket.mandate.maxStageRetries) {
        const retryTicket: Ticket = {
          ...ticket,
          status: "queued",
          currentStage: "implement",
          stageRetries: ticket.stageRetries + 1,
          inlineMemory: {
            ...ticket.inlineMemory,
            activeHint: `Rebase onto ${effectiveBaseBranch} failed with conflicts: ${rebaseRes.conflictSummary}. Update code to stay compatible and re-test.`,
          },
          updatedAt: nowIso(),
        };
        await ctx.stateStore.saveTicket(retryTicket);
        ctx.emitEvent({ type: "ticket_updated", ticket: retryTicket, timestamp: retryTicket.updatedAt });
      } else if (ticket.campaignId) {
        await failCampaignWaveTicket(
          ctx,
          ticket,
          repo,
          `Rebase conflict: ${rebaseRes.conflictSummary}`,
        );
      } else {
        await ctx.escalateTicket(
          ticket,
          "merge_conflict",
          `Rebase onto ${effectiveBaseBranch} conflicted: ${rebaseRes.conflictSummary}`,
          { branchName: ticket.branchName, conflictContext: ticket.conflictContext },
        );
      }
      return;
    }

    preConflictCp = await ctx.captureTicketCheckpoint(ticket, repo, worktreePath, {
      stage: "rebase",
      stageRunId: stageRun.id,
      label: `Pre-rebase conflict snapshot (${effectiveBaseBranch})`,
      changedFiles: [],
    });

    const prepSpan = spans.start("git_ops", "Prepare 3-way semantic conflict workspace");
    const prep = await ctx.workspace.prepareThreeWayConflictWorkspace!({
      worktreePath,
      rootRepoPath: repo.rootPath,
      baseBranch: effectiveBaseBranch,
    });
    attemptConflictCtx = {
      baseBranch: effectiveBaseBranch,
      mergeBaseSha: prep.mergeBaseSha,
      upstreamCommitSummaries: prep.upstreamCommitSummaries,
      conflictFiles: prep.conflictFiles,
      fileHunks: prep.fileHunks,
    };
    spans.end(
      prepSpan,
      prep.conflictFiles.length > 0 ? "ok" : "failed",
      `${prep.conflictFiles.length} file(s)`,
    );

    const availableEngines = await ctx.getAvailableEngines();
    let chosenEngine = selectEngineForStage(
      repo,
      "implement",
      ticket.preferredEngine,
      await collectTrippedEngines(ctx),
    );
    if (!ctx.drivers.has(chosenEngine) && availableEngines[0]) {
      chosenEngine = availableEngines[0];
    }
    const driver = ctx.drivers.get(chosenEngine);

    const failConflictEscalation = async (
      reason: string,
      collectedEvents: WorkerStreamEvent[] = [],
    ): Promise<void> => {
      if (preConflictCp && ctx.workspace.restoreWorktreeCheckpoint) {
        await ctx.workspace
          .restoreWorktreeCheckpoint({
            worktreePath,
            rootRepoPath: repo.rootPath,
            commitSha: preConflictCp.commitSha,
          })
          .catch(() => {});
      }
      const failedCtx: ConflictSemanticContext = {
        ...attemptConflictCtx!,
        resolvedAutomatically: false,
        resolutionSummary: reason,
      };
      const failedRun: StageRun = {
        ...stageRun,
        status: "failed",
        costUsd: resolveCostUsd,
        spans: spans.toArray(),
        completedAt: nowIso(),
        summary: reason,
      };
      const { note: failNote } = await ctx.memory.recordStageSpillAndNote({
        ticket,
        stageRun: failedRun,
        events: collectedEvents,
        changedFiles: attemptConflictCtx?.conflictFiles ?? [],
        summary: reason,
        verificationPassed: false,
      });
      failedRun.spillTranscriptId = failNote.spillArtifactIds[0];
      await ctx.stateStore.saveStageRun(failedRun);
      await ctx.escalateTicket(
        {
          ...ticket,
          costUsd: ticket.costUsd + resolveCostUsd,
          conflictResolutionCount: (ticket.conflictResolutionCount ?? 0) + 1,
          conflictContext: failedCtx,
          inlineMemory: {
            ...ticket.inlineMemory,
            stageNotes: [...ticket.inlineMemory.stageNotes, failNote],
          },
        },
        "merge_conflict",
        reason,
        {
          branchName: ticket.branchName,
          conflictContext: failedCtx,
          stageRunId: stageRun.id,
        },
      );
    };

    if (!driver || prep.conflictFiles.length === 0) {
      await failConflictEscalation(
        `Rebase onto ${effectiveBaseBranch} conflicted (${prep.conflictFiles.join(", ") || rebaseRes.conflictSummary}); automatic 3-way resolution unavailable.`,
      );
      return;
    }

    const conflictPrompt = buildConflictResolutionPrompt(ticket, attemptConflictCtx);
    const resolveSpan = spans.start(
      "worker_turn",
      `3-way conflict resolve (${prep.conflictFiles.length} file(s), ${driver.engine})`,
    );
    const collectedEvents: WorkerStreamEvent[] = [];
    let completedEvent: Extract<WorkerStreamEvent, { type: "completed" }> | undefined;
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(
      () => abortController.abort("conflict_resolve_timeout"),
      Math.max(30_000, ticket.mandate.maxDurationSec * 1000),
    );
    try {
      const stream = driver.runTurn(
        {
          ticketId: ticket.id,
          stageRunId: stageRun.id,
          stage: "implement",
          worktreePath,
          prompt: conflictPrompt,
          mandate: ticket.mandate,
          isResume: false,
          sandboxMode: repo.sandboxMode ?? "balanced",
          rootRepoPath: repo.rootPath,
          readOnlyPaths: ticket.lockedTestPaths,
        },
        abortController.signal,
      );
      for await (const ev of stream) {
        collectedEvents.push(ev);
        ctx.emitEvent({
          type: "worker_event",
          ticketId: ticket.id,
          stageRunId: stageRun.id,
          engine: driver.engine,
          event: ev,
          timestamp: ev.timestamp,
        });
        if (ev.type === "usage") {
          resolveCostUsd = Math.max(resolveCostUsd, ev.costUsd);
        } else if (ev.type === "completed") {
          completedEvent = ev;
          if (typeof ev.costUsd === "number") {
            resolveCostUsd = Math.max(resolveCostUsd, ev.costUsd);
          }
        }
      }
    } catch (err) {
      spans.end(resolveSpan, "failed", err instanceof Error ? err.message : String(err));
      await failConflictEscalation(
        `3-way conflict resolver errored: ${err instanceof Error ? err.message : String(err)}`,
        collectedEvents,
      );
      return;
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (!completedEvent) {
      const errMsg =
        [...collectedEvents].reverse().find((e) => e.type === "error")?.message ??
        "Conflict resolution worker did not complete";
      spans.end(resolveSpan, "failed", errMsg);
      await failConflictEscalation(`3-way conflict resolution failed: ${errMsg}`, collectedEvents);
      return;
    }

    const leftoverMarkers = prep.conflictFiles.filter((relPath) => {
      const abs = join(worktreePath, relPath);
      if (!existsSync(abs)) return false;
      const content = readFileSync(abs, "utf8");
      return /^(<{7}|={7}|>{7})/m.test(content);
    });
    if (leftoverMarkers.length > 0) {
      spans.end(resolveSpan, "failed", `Leftover conflict markers in ${leftoverMarkers.join(", ")}`);
      await failConflictEscalation(
        `3-way conflict resolution left unresolved markers in: ${leftoverMarkers.join(", ")}`,
        collectedEvents,
      );
      return;
    }

    if (
      ticket.lockedTestPaths &&
      ticket.lockedTestPaths.length > 0 &&
      ticket.specTestCommitSha &&
      ctx.workspace.getChangedFilesSince
    ) {
      const changedSinceSpec = await ctx.workspace.getChangedFilesSince(
        worktreePath,
        ticket.specTestCommitSha,
      );
      const tampered = changedSinceSpec.filter((f) => ticket.lockedTestPaths!.includes(f));
      if (tampered.length > 0) {
        await ctx.workspace.revertPathsToCommit?.(worktreePath, ticket.specTestCommitSha, tampered);
        spans.end(resolveSpan, "failed", `Tampered locked tests: ${tampered.join(", ")}`);
        await failConflictEscalation(
          `3-way conflict resolution modified locked spec tests (${tampered.join(", ")})`,
          collectedEvents,
        );
        return;
      }
    }

    const postResolveFiles = await ctx.workspace.getChangedFiles(worktreePath, effectiveBaseBranch);
    const mandateFiles = ticket.lockedTestPaths?.length
      ? postResolveFiles.filter((f) => !ticket.lockedTestPaths!.includes(f))
      : postResolveFiles;
    const mandateRes = validateChangedFilesAgainstMandate(mandateFiles, ticket.mandate);
    if (!mandateRes.ok) {
      spans.end(resolveSpan, "failed", `Mandate violation: ${mandateRes.violations.join(", ")}`);
      await failConflictEscalation(
        `3-way conflict resolution violated Mandate paths: ${mandateRes.violations.join(", ")}`,
        collectedEvents,
      );
      return;
    }

    const resolveSummary = completedEvent.summary || "3-way semantic conflict resolved";
    spans.end(resolveSpan, "ok", `$${resolveCostUsd.toFixed(3)}`);
    autoResolvedConflict = true;
    attemptConflictCtx = {
      ...attemptConflictCtx,
      resolvedAutomatically: true,
      resolutionSummary: resolveSummary.slice(0, 400),
    };
    workingTicket = {
      ...ticket,
      costUsd: ticket.costUsd + resolveCostUsd,
      conflictResolutionCount: (ticket.conflictResolutionCount ?? 0) + 1,
      conflictContext: attemptConflictCtx,
      inlineMemory: { ...ticket.inlineMemory, lastFullVerification: undefined },
    };
  }

  const reusable =
    rebaseRes.ok && !autoResolvedConflict
      ? await canReuseImplementGate(ctx, ticket, repo, worktreePath, effectiveBaseBranch)
      : undefined;
  let gateReused = false;
  let gate: Awaited<ReturnType<typeof runRepoVerificationGateOp>>;
  if (reusable) {
    gateReused = true;
    const reuseSpan = spans.start(
      "static_verify",
      "Reused full implement gate (fast-forward tree parity)",
    );
    spans.end(reuseSpan, "ok");
    await ctx
      .recordFlightEvent?.({
        repoId: repo.id,
        ticketId: ticket.id,
        kind: "gate_reused",
        summary: `Reused full implement gate at rebase (fast-forward tree parity onto ${effectiveBaseBranch})`,
        savedMs: reusable.durationMs ?? 90_000,
        metadata: { stage: "rebase", treeSha: reusable.treeSha, baseHeadSha: reusable.baseHeadSha },
      })
      ?.catch(() => {});
    gate = { passed: true, artifacts: [] };
  } else {
    gate = await runRepoVerificationGateOp(ctx, workingTicket, repo, stageRun, worktreePath, {
      isFinalDeliveryGate: !parentEpic,
    });
    spans.addExisting(gate.spans);
  }
  if (!gate.passed) {
    if (autoResolvedConflict && preConflictCp && ctx.workspace.restoreWorktreeCheckpoint) {
      await ctx.workspace
        .restoreWorktreeCheckpoint({
          worktreePath,
          rootRepoPath: repo.rootPath,
          commitSha: preConflictCp.commitSha,
        })
        .catch(() => {});
    }
    const failedSummary = gate.result?.summary ?? "Post-rebase verification gate failed";
    const failedCtx =
      autoResolvedConflict && attemptConflictCtx
        ? { ...attemptConflictCtx, resolvedAutomatically: false, resolutionSummary: failedSummary }
        : attemptConflictCtx;
    const failedRun: StageRun = {
      ...stageRun,
      status: "failed",
      costUsd: resolveCostUsd,
      spans: spans.toArray(),
      completedAt: nowIso(),
      summary: failedSummary,
    };
    const changedFiles = await ctx.workspace.getChangedFiles(worktreePath, effectiveBaseBranch);
    const { note: failNote } = await ctx.memory.recordStageSpillAndNote({
      ticket: workingTicket,
      stageRun: failedRun,
      events: [],
      changedFiles,
      summary: failedSummary,
      verificationPassed: false,
      extraArtifacts: gate.artifacts.length > 0 ? gate.artifacts : undefined,
    });
    await ctx.stateStore.saveStageRun(failedRun);

    if (!autoResolvedConflict && ticket.stageRetries < ticket.mandate.maxStageRetries) {
      const retryTicket: Ticket = {
        ...workingTicket,
        status: "queued",
        currentStage: "implement",
        stageRetries: ticket.stageRetries + 1,
        inlineMemory: {
          ...ticket.inlineMemory,
          stageNotes: [...ticket.inlineMemory.stageNotes, failNote],
          activeHint: `Post-rebase verification failed (${gate.result?.failedCommand ?? "checks"}). Fix the issue and ensure checks pass:\n${failedSummary}`,
        },
        updatedAt: nowIso(),
      };
      await ctx.stateStore.saveTicket(retryTicket);
      ctx.emitEvent({
        type: "ticket_updated",
        ticket: retryTicket,
        timestamp: retryTicket.updatedAt,
      });
    } else if (workingTicket.campaignId) {
      await failCampaignWaveTicket(ctx, workingTicket, repo, failedSummary);
    } else {
      await ctx.escalateTicket(
        {
          ...workingTicket,
          conflictContext: failedCtx,
          inlineMemory: {
            ...workingTicket.inlineMemory,
            stageNotes: [...workingTicket.inlineMemory.stageNotes, failNote],
          },
        },
        autoResolvedConflict ? "merge_conflict" : "watchdog_escalation",
        autoResolvedConflict
          ? `3-way conflict resolved edits failed verification gate: ${failedSummary}`
          : `Post-rebase verification failed: ${failedSummary}`,
        {
          stageRunId: stageRun.id,
          branchName: ticket.branchName,
          ...(failedCtx ? { conflictContext: failedCtx } : {}),
        },
      );
    }
    return;
  }

  if (autoResolvedConflict) {
    const commitResolvedSpan = spans.start("git_ops", "Commit resolved rebase tree");
    await ctx.workspace.commitAll(
      worktreePath,
      `super-work(${ticket.id}): 3-way conflict resolved onto ${effectiveBaseBranch}`,
    );
    spans.end(commitResolvedSpan, "ok");
  }

  const baseHeadAtRebase = ctx.workspace.getHeadCommitSha
    ? await ctx.workspace.getHeadCommitSha(repo.rootPath, effectiveBaseBranch).catch(() => undefined)
    : undefined;

  const finishedRun: StageRun = {
    ...stageRun,
    status: "completed",
    costUsd: resolveCostUsd,
    spans: spans.toArray(),
    completedAt: nowIso(),
    summary: autoResolvedConflict
      ? `3-way conflict auto-resolved onto ${effectiveBaseBranch}${gate.result?.summary ? `; ${gate.result.summary}` : ""}`
      : gateReused
        ? `Rebased cleanly onto ${effectiveBaseBranch}; Reused passing full implement verification (fast-forward tree parity)`
        : gate.artifacts.length > 0
        ? `Rebased cleanly onto ${effectiveBaseBranch}; ${gate.result?.summary ?? "verification passed"}`
        : `Rebased cleanly onto ${effectiveBaseBranch}`,
  };
  const changedFiles = await ctx.workspace.getChangedFiles(worktreePath, effectiveBaseBranch);
  const diffText = await ctx.workspace.getDiff(worktreePath, effectiveBaseBranch);
  const { note } = await ctx.memory.recordStageSpillAndNote({
    ticket: workingTicket,
    stageRun: finishedRun,
    events: [],
    changedFiles,
    diffText,
    summary: finishedRun.summary!,
    verificationPassed: true,
    extraArtifacts: gate.artifacts.length > 0 ? gate.artifacts : undefined,
  });
  finishedRun.spillTranscriptId = note.spillArtifactIds[0];
  await ctx.stateStore.saveStageRun(finishedRun);
  await ctx.captureTicketCheckpoint(workingTicket, repo, worktreePath, {
    stage: "rebase",
    stageRunId: finishedRun.id,
    engine: stageRun.engine,
    label: autoResolvedConflict
      ? `3-way conflict resolved onto ${effectiveBaseBranch}`
      : `Rebased cleanly onto ${effectiveBaseBranch}`,
    changedFiles,
    verificationPassed: true,
  });
  ctx.emitEvent({
    type: "stage_completed",
    ticketId: ticket.id,
    stageRun: finishedRun,
    note,
    timestamp: finishedRun.completedAt!,
  });

  if (parentEpic && parentEpic.branchName) {
    await ctx.runWithEpicLock(parentEpic.id, () =>
      ctx.workspace.mergeBranchToBase({
        rootRepoPath: repo.rootPath,
        baseBranch: parentEpic.branchName!,
        branchName: ticket.branchName!,
        worktreePath,
        commitMessage: `epic(${parentEpic.id}/${ticket.subtaskKey ?? ticket.id}): ${ticket.title}`,
        deleteBranch: true,
      }),
    );
    const deliveredTs = nowIso();
    await ctx.workspace.cleanupTicketCheckpoints?.(repo.rootPath, ticket.id).catch(() => {});
    await ctx.stateStore.markCheckpointsCleaned(ticket.id, deliveredTs).catch(() => {});
    let deliveredSubtask: Ticket = {
      ...workingTicket,
      status: "delivered",
      activeEngine: undefined,
      worktreePath: undefined,
      worktreeCleanedAt: deliveredTs,
      inlineMemory: {
        ...workingTicket.inlineMemory,
        stageNotes: [...workingTicket.inlineMemory.stageNotes, note],
      },
      updatedAt: deliveredTs,
    };
    await ctx.maybeDistillClosedLoopLesson(deliveredSubtask, repo);
    await ctx.stateStore.saveTicket(deliveredSubtask);
    deliveredSubtask = await ctx.generateAndSaveHandoverDigest(deliveredSubtask, repo, {
      changedFiles,
      diffText,
    });
    await ctx.recordDeliveredCasebookEntry(deliveredSubtask, repo);
    await ctx.maybeEvaluateEpicReplan(parentEpic.id, deliveredSubtask);
    return;
  }

  if (
    (ticket.campaignId || ticket.milestoneId) &&
    ticket.targetBranch &&
    ticket.targetBranch !== repo.baseBranch
  ) {
    await mergeWaveToTargetStagingBranch(
      ctx,
      {
        ...workingTicket,
        inlineMemory: {
          ...workingTicket.inlineMemory,
          stageNotes: [...workingTicket.inlineMemory.stageNotes, note],
        },
      },
      repo,
      worktreePath,
      ticket.targetBranch,
      changedFiles,
      diffText,
    );
    return;
  }

  await ctx.enqueueDeliveryOutbox(
    {
      ...workingTicket,
      baseHeadAtRebase,
      inlineMemory: {
        ...workingTicket.inlineMemory,
        stageNotes: [...workingTicket.inlineMemory.stageNotes, note],
      },
    },
    repo,
  );
}
