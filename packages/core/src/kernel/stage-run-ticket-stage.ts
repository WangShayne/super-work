import { pickNextFallbackEngine, resolveFallbackChain } from "../arena.ts";
import { computeEngineRoutingDecision, parseSpecTestChallenge } from "../engine-router.ts";
import { validateChangedFilesAgainstMandate } from "../mandate.ts";
import {
  getAlternateEngine,
  getFirstStage,
  getNextStage,
  getPipelineTemplate,
  selectEngineForStage,
  selectReviewEngine,
  statusForStage,
} from "../pipeline.ts";
import {
  formatBlockingFindingsForRework,
  formatNitSummary,
  parseReviewReport,
} from "../review.ts";
import { buildStageToolProfile, extractWorkerClarificationRequest } from "../tool-profiler.ts";
import type {
  InboxItem,
  ReviewReport,
  SpillArtifact,
  StageKind,
  StageRun,
  StageSpan,
  SystemSetupConfig,
  Ticket,
  WatchdogDecision,
  WatchdogSignal,
  WorkerEngineId,
  WorkerStreamEvent,
} from "../types.ts";
import { newId, nowIso } from "../utils.ts";
import { runArenaImplementStageOp } from "./arena-coordinator.ts";
import type { KernelCoordinatorContext } from "./context.ts";
import {
  autoResolveModifiedReviewComments,
  syncAiFindingsToReviewComments,
} from "./review-comments-coordinator.ts";
import { SpanRecorder } from "./span-recorder.ts";
import { failCampaignWaveTicket, mergeWaveToTargetStagingBranch } from "./stage-delivery-helpers.ts";
import {
  collectTrippedEngines,
  quarantineSpilloverAfterTurn,
  tripEngineIfDeterministic,
  utcTodayString,
} from "./stage-engine-helpers.ts";
import { handleRebaseStageOp } from "./stage-rebase-helpers.ts";
import { buildReviewEvidencePacketOp } from "./stage-review-helpers.ts";
import { handleSpecTestPostTurnOp } from "./stage-spec-test-helpers.ts";
import { runRepoVerificationGateOp } from "./stage-verification-helpers.ts";

export async function runTicketStageOp(
  ctx: KernelCoordinatorContext,
  ticketId: string,
): Promise<void> {
  let ticket = await ctx.stateStore.getTicket(ticketId);
  if (!ticket || ticket.status !== "queued") return;

  const repo = await ctx.stateStore.getRepo(ticket.repoId);
  if (!repo) return;

  const stage = ticket.currentStage || getFirstStage(ticket.template, ticket.tddMode);

  if (ticket.pauseBeforeRun) {
    const pauseTs = nowIso();
    const paused: Ticket = {
      ...ticket,
      pauseBeforeRun: false,
      status: "needs_human",
      errorMessage: `Paused at DAG breakpoint before '${stage}' stage`,
      updatedAt: pauseTs,
    };
    await ctx.stateStore.saveTicket(paused);
    ctx.emitEvent({ type: "ticket_updated", ticket: paused, timestamp: pauseTs });
    const bpInbox: InboxItem = {
      id: newId("inb"),
      repoId: repo.id,
      ticketId: ticket.id,
      kind: "plan_approval",
      status: "pending",
      title: `DAG Breakpoint: ${ticket.title}`,
      summary: `Execution paused before '${stage}' stage per DAG breakpoint. Approve to resume (optionally include steering guidance).`,
      contextPayload: { isDagBreakpoint: true, stage },
      createdAt: pauseTs,
    };
    await ctx.stateStore.saveInboxItem(bpInbox);
    ctx.emitEvent({ type: "inbox_created", item: bpInbox, timestamp: pauseTs });
    return;
  }

  const availableEngines = await ctx.getAvailableEngines();
  const trippedEngines = await collectTrippedEngines(ctx);

  const wantsAutoRouting =
    ticket.preferredEngine === "auto" ||
    (!ticket.preferredEngine && repo.preferredImplementEngine === "auto");
  if (wantsAutoRouting && !ticket.activeEngine && (stage === "spec_test" || stage === "implement")) {
    const currentTicket = ticket;
    const failedSet = currentTicket.failedEngines ?? [];
    const eligibleEngines = availableEngines.filter(
      (e) => !failedSet.includes(e) && !trippedEngines.includes(e),
    );
    const [repoTickets, casebookEntries] = await Promise.all([
      ctx.stateStore.listTickets({ repoId: repo.id }),
      ctx.stateStore.listCasebookEntries(repo.id, { includeReverted: true }),
    ]);
    const historicalTickets = repoTickets.filter((t) => t.id !== currentTicket.id);
    const runsLists = await Promise.all(
      historicalTickets.map((t) => ctx.stateStore.listStageRuns(t.id)),
    );
    const oneHourAgoMs = Date.now() - 3_600_000;
    const recentAutoArenaCountLastHour = historicalTickets.filter(
      (t) => t.autoArenaEscalated && Date.parse(t.createdAt) >= oneHourAgoMs,
    ).length;
    const today = utcTodayString();
    const effectiveDailyBudgetUsd = ctx.getEffectiveDailyBudget(repo, today);
    const todaySpendUsd =
      effectiveDailyBudgetUsd !== undefined
        ? await ctx.stateStore.getDailyRepoSpendUsd(repo.id, today)
        : 0;
    const routing = computeEngineRoutingDecision({
      repo,
      ticket,
      availableEngines: eligibleEngines.length > 0 ? eligibleEngines : availableEngines,
      historicalTickets,
      historicalStageRuns: runsLists.flat(),
      casebookEntries,
      todaySpendUsd,
      effectiveDailyBudgetUsd,
      recentAutoArenaCountLastHour,
    });
    ticket = {
      ...ticket,
      activeEngine: routing.chosenEngine,
      taskCategory: routing.category,
      routingRationale: routing.rationale,
      ...(stage === "implement" && routing.autoUpgradeArena && !ticket.arenaMode
        ? {
            arenaMode: true,
            arenaCompetitorEngine: routing.competitorEngine,
            autoArenaEscalated: true,
          }
        : {}),
      updatedAt: nowIso(),
    };
    await ctx.stateStore.saveTicket(ticket);
    ctx.emitEvent({ type: "ticket_updated", ticket, timestamp: ticket.updatedAt });
  }

  if (ticket.arenaMode && stage === "implement" && !ticket.arenaWinnerId) {
    const arenaHandled = await runArenaImplementStageOp(ctx, ticket, repo, availableEngines);
    if (arenaHandled) {
      return;
    }
  }

  let chosenEngine: WorkerEngineId;
  if (stage === "review") {
    const priorRuns = await ctx.stateStore.listStageRuns(ticket.id);
    const lastImplRun = [...priorRuns]
      .reverse()
      .find((r) => r.stage === "implement" && r.status === "completed");
    const rawImplPref =
      lastImplRun?.engine ?? ticket.preferredEngine ?? repo.preferredImplementEngine;
    const implementEngine: WorkerEngineId =
      rawImplPref === "auto"
        ? selectEngineForStage(repo, "implement", undefined, trippedEngines)
        : rawImplPref;
    chosenEngine = selectReviewEngine({
      repo,
      implementEngine,
      availableEngines,
      explicitWatchdogEngine: ticket.activeEngine,
      trippedEngines,
    });
  } else {
    const explicitEngine = ticket.activeEngine ?? ticket.preferredEngine;
    chosenEngine = selectEngineForStage(repo, stage, explicitEngine, trippedEngines);
    if (
      !ticket.activeEngine &&
      ((ticket.failedEngines ?? []).includes(chosenEngine) || trippedEngines.includes(chosenEngine))
    ) {
      chosenEngine =
        pickNextFallbackEngine({
          currentEngine: chosenEngine,
          failedEngines: ticket.failedEngines,
          repo,
          availableEngines,
          trippedEngines,
        }) ?? chosenEngine;
    }
  }

  let driver = ctx.drivers.get(chosenEngine);
  if (!driver) {
    const chain = resolveFallbackChain({
      primaryEngine: chosenEngine,
      repo,
      availableEngines,
      failedEngines: ticket.failedEngines,
      trippedEngines,
    });
    const alt = chain[0] ?? availableEngines[0];
    driver = alt ? ctx.drivers.get(alt) : undefined;
  }

  if (!driver) {
    await ctx.escalateTicket(
      ticket,
      "watchdog_escalation",
      `No WorkerDriver available for engine '${chosenEngine}'`,
      { chosenEngine },
    );
    return;
  }

  const spans = new SpanRecorder();
  const prepSpan = spans.start("workspace_prep", `Prepare worktree (${stage})`);
  const { effectiveBaseBranch } = await ctx.getEffectiveBaseInfo(ticket, repo);
  const hadWorktree = Boolean(ticket.worktreePath);
  const threadObj = !hadWorktree ? await ctx.stateStore.getThread(ticket.threadId) : null;
  const forkStartPoint =
    typeof threadObj?.metadata?.forkStartPoint === "string"
      ? threadObj.metadata.forkStartPoint
      : undefined;
  const lockedTicket = ticket;
  let ws: { worktreePath: string; branchName: string };
  try {
    ws = await ctx.runWithRepoWorkspaceLock(repo.id, () =>
      ctx.workspace.prepareWorkspace(lockedTicket, repo, {
        startPoint: forkStartPoint ?? effectiveBaseBranch,
      }),
    );
  } catch (err) {
    spans.end(prepSpan, "failed", err instanceof Error ? err.message : String(err));
    await ctx.escalateTicket(
      ticket,
      "watchdog_escalation",
      err instanceof Error ? err.message : String(err),
      { stage, phase: "prepare_workspace" },
    );
    return;
  }
  if (!hadWorktree && ticket.dependsOn.length > 0) {
    const depBranches: string[] = [];
    for (const depId of ticket.dependsOn) {
      const dep = await ctx.stateStore.getTicket(depId);
      if (dep?.branchName && dep.repoId === ticket.repoId) {
        depBranches.push(dep.branchName);
      }
    }
    if (depBranches.length > 0) {
      await ctx.workspace.integrateDependencyBranches(ws.worktreePath, depBranches);
    }
  }
  spans.end(prepSpan, "ok", ws.branchName);
  const existingSessionId =
    stage === "review" ? undefined : ticket.nativeSessions[driver.engine];
  const stageRun: StageRun = {
    id: newId("run"),
    ticketId: ticket.id,
    stage,
    engine: driver.engine,
    status: "running",
    nativeSessionId: existingSessionId,
    costUsd: 0,
    startedAt: nowIso(),
  };

  ticket = {
    ...ticket,
    status: statusForStage(stage),
    currentStage: stage,
    activeEngine: driver.engine,
    worktreePath: ws.worktreePath,
    branchName: ws.branchName,
    updatedAt: nowIso(),
  };
  await ctx.stateStore.saveTicket(ticket);
  await ctx.stateStore.saveStageRun(stageRun);
  ctx.emitEvent({ type: "ticket_updated", ticket, timestamp: ticket.updatedAt });
  ctx.emitEvent({ type: "stage_started", ticketId: ticket.id, stageRun, timestamp: stageRun.startedAt });

  if (!hadWorktree) {
    await ctx.captureTicketCheckpoint(ticket, repo, ws.worktreePath, {
      stage: "baseline",
      label: forkStartPoint
        ? `Forked baseline (${forkStartPoint.slice(0, 8)})`
        : `Initial baseline (${effectiveBaseBranch})`,
      changedFiles: [],
    });
  }

  if (stage === "rebase") {
    await handleRebaseStageOp(ctx, ticket, repo, stageRun);
    return;
  }

  const reviewEvidence =
    stage === "review"
      ? await buildReviewEvidencePacketOp(
          ctx,
          ticket,
          repo,
          ws.worktreePath,
          ticket.targetBranch ?? effectiveBaseBranch,
        )
      : undefined;
  const prompt = await ctx.buildEnrichedWorkerPrompt(
    ticket,
    repo,
    stage,
    reviewEvidence ? { reviewEvidence } : undefined,
  );

  const setupConfig = await ctx.stateStore.getSystemSetting<SystemSetupConfig>("setup_config");
  const engineProfile =
    driver.engine === "claude"
      ? setupConfig?.claudeProfile
      : driver.engine === "codex"
        ? setupConfig?.codexProfile
        : driver.engine === "opencode"
          ? setupConfig?.opencodeProfile
          : driver.engine === "gemini"
            ? setupConfig?.geminiProfile
            : undefined;
  const canApplyModelOverride = Boolean(
    ticket.modelOverride &&
      stage !== "review" &&
      (!ticket.preferredEngine || ticket.preferredEngine === driver.engine),
  );
  const effectiveModel = canApplyModelOverride ? ticket.modelOverride : engineProfile?.model;
  const effectiveEffort =
    stage !== "review" && ticket.effortOverride
      ? ticket.effortOverride
      : engineProfile?.effort;

  const abortController = new AbortController();
  ctx.abortControllers.set(ticket.id, abortController);

  const tracker = ctx.watchdog.createTracker(stageRun, ticket.mandate);
  const collectedEvents: WorkerStreamEvent[] = [];
  let completedEvent: Extract<WorkerStreamEvent, { type: "completed" }> | null = null;
  let watchdogDecision: WatchdogDecision | null = null;
  let watchdogSignal: WatchdogSignal | null = null;
  let discoveredSessionId = existingSessionId;
  let stageCostUsd = 0;

  const triggerWatchdogCheck = async (): Promise<boolean> => {
    if (abortController.signal.aborted || watchdogDecision) return false;
    const sig = ctx.watchdog.evaluateL1(tracker);
    if (!sig) return false;

    watchdogSignal = sig;
    ctx.emitEvent({ type: "watchdog_signal", signal: sig, timestamp: nowIso() });

    const probeContext = ctx.workspace.runRepoPreProbe
      ? await ctx.workspace
          .runRepoPreProbe(
            repo.rootPath,
            `${ticket.title}\n${sig.details}\n${ticket.mandate.allowedPaths.join(" ")}`,
            repo.forbiddenPaths,
          )
          .catch(() => undefined)
      : undefined;
    const decision = await ctx.watchdog.evaluateAndDecide({
      ticket,
      stageRun,
      signal: sig,
      recentEvents: tracker.recentEvents,
      availableEngines,
      probeContext,
      probeExecutor: ctx.createRepoProbeExecutor(repo),
    });
    ctx.emitEvent({
      type: "watchdog_decision",
      ticketId: ticket.id,
      stageRunId: stageRun.id,
      decision,
      timestamp: nowIso(),
    });

    if (decision.action === "CONTINUE") {
      tracker.lastEventAtMs = Date.now();
      tracker.consecutiveErrorCount = 0;
      return false;
    }

    watchdogDecision = decision;
    abortController.abort(`watchdog_${decision.action}`);
    return true;
  };

  const l1Timer = setInterval(() => {
    void triggerWatchdogCheck();
  }, ctx.watchdog.config.pollIntervalMs);

  const shieldSpillover = driver.engine !== "mock" && ws.worktreePath !== repo.rootPath;
  let preTurnDirtyPaths: string[] = [];
  if (shieldSpillover) {
    preTurnDirtyPaths =
      (await ctx.workspace.snapshotRepoDirtyPaths?.(repo.rootPath).catch(() => [])) ?? [];
  }

  const workerSpan = spans.start("worker_turn", `${driver.engine} ${stage}`);
  try {
    const stream = driver.runTurn(
      {
        ticketId: ticket.id,
        stageRunId: stageRun.id,
        stage,
        worktreePath: ws.worktreePath,
        prompt,
        mandate: ticket.mandate,
        nativeSessionId: existingSessionId,
        isResume: Boolean(existingSessionId),
        model: effectiveModel,
        effort: effectiveEffort,
        sandboxMode: repo.sandboxMode ?? "balanced",
        rootRepoPath: repo.rootPath,
        readOnlyPaths: stage === "implement" ? ticket.lockedTestPaths : undefined,
      },
      abortController.signal,
    );

    for await (const event of stream) {
      collectedEvents.push(event);
      ctx.emitEvent({
        type: "worker_event",
        ticketId: ticket.id,
        stageRunId: stageRun.id,
        engine: driver.engine,
        event,
        timestamp: event.timestamp,
      });

      ctx.watchdog.recordEvent(tracker, event);

      if (event.type === "session_started") {
        discoveredSessionId = event.nativeSessionId;
      } else if (event.type === "usage") {
        stageCostUsd = Math.max(stageCostUsd, event.costUsd);
      } else if (event.type === "completed") {
        completedEvent = event;
        if (typeof event.costUsd === "number") {
          stageCostUsd = Math.max(stageCostUsd, event.costUsd);
        }
      } else if (event.type === "tool_result" && stage === "implement") {
        try {
          const diffText = await ctx.workspace.getDiff(ws.worktreePath, effectiveBaseBranch);
          const changed = await ctx.workspace.getChangedFiles(ws.worktreePath, effectiveBaseBranch);
          const hash = new Bun.CryptoHasher("sha256").update(diffText).digest("hex").slice(0, 12);
          ctx.watchdog.recordDiffCheckpoint(tracker, hash, changed.length > 0);
        } catch {
          // Non-fatal
        }
      }

      if (await triggerWatchdogCheck()) {
        break;
      }
    }
  } catch (err) {
    if (!abortController.signal.aborted) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errEvent: WorkerStreamEvent = {
        type: "error",
        message: errMsg,
        fatal: true,
        timestamp: nowIso(),
      };
      collectedEvents.push(errEvent);
      ctx.watchdog.recordEvent(tracker, errEvent);
      await triggerWatchdogCheck();
    }
  } finally {
    clearInterval(l1Timer);
  }

  if (shieldSpillover) {
    await quarantineSpilloverAfterTurn(ctx, { ticket, repo, stageRun, engine: driver.engine, preTurnDirtyPaths });
  }

  const toolProfile = buildStageToolProfile(collectedEvents);
  const turnSpanStatus: StageSpan["status"] =
    ctx.pendingSteers.has(ticket.id)
      ? "ok"
      : watchdogDecision
        ? "failed"
        : !completedEvent && collectedEvents.some((e) => e.type === "error")
          ? "failed"
          : "ok";
  spans.end(workerSpan, turnSpanStatus, `$${stageCostUsd.toFixed(3)}`);

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
    return;
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
    return;
  }

  const pendingSteer = ctx.pendingSteers.get(ticket.id);
  if (pendingSteer && abortController.signal.aborted) {
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
        ? { ...ticket.nativeSessions, [driver.engine]: discoveredSessionId }
        : ticket.nativeSessions;
    const switchedEngine =
      pendingSteer.preferredEngine && pendingSteer.preferredEngine !== "auto"
        ? pendingSteer.preferredEngine
        : driver.engine;

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
    return;
  }

  if (watchdogDecision) {
    const dec: WatchdogDecision = watchdogDecision;
    const sig: WatchdogSignal | null = watchdogSignal;
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
          ? { ...ticket.nativeSessions, [driver.engine]: discoveredSessionId }
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
      const nextFailed = Array.from(new Set([...(ticket.failedEngines ?? []), driver.engine]));
      const altEngine =
        dec.targetEngine &&
        dec.targetEngine !== driver.engine &&
        !nextFailed.includes(dec.targetEngine) &&
        availableEngines.includes(dec.targetEngine)
          ? dec.targetEngine
          : pickNextFallbackEngine({
              currentEngine: driver.engine,
              failedEngines: nextFailed,
              repo,
              availableEngines,
              trippedEngines,
            }) ?? getAlternateEngine(driver.engine, availableEngines);
      if (altEngine && altEngine !== driver.engine && !nextFailed.includes(altEngine)) {
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
              `[Fallback Engine: ${driver.engine} -> ${altEngine}] Switched due to: ${dec.reason}`,
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
          summary: `Watchdog switched engine ${driver.engine} -> ${altEngine}: ${dec.reason}`,
          metadata: { fromEngine: driver.engine, toEngine: altEngine, stage: stageRun.stage },
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
    return;
  }

  const lastErrorEvent = [...collectedEvents].reverse().find((e) => e.type === "error");
  if (!completedEvent && lastErrorEvent && lastErrorEvent.type === "error") {
    const failedRun: StageRun = {
      ...stageRun,
      status: "failed",
      nativeSessionId: discoveredSessionId,
      costUsd: stageCostUsd,
      spans: spans.toArray(),
      toolProfile,
      completedAt: nowIso(),
      summary: lastErrorEvent.message,
    };
    await ctx.stateStore.saveStageRun(failedRun);
    await ctx.memory.recordStageSpillAndNote({
      ticket,
      stageRun: failedRun,
      events: collectedEvents,
      changedFiles: [],
      summary: lastErrorEvent.message,
      verificationPassed: false,
    });

    const nextFailed = Array.from(new Set([...(ticket.failedEngines ?? []), driver.engine]));
    const newlyTripped = await tripEngineIfDeterministic(ctx, {
      engine: driver.engine,
      message: lastErrorEvent.message,
      repoId: repo.id,
      ticketId: ticket.id,
      stage,
    });
    const fallbackEngine = pickNextFallbackEngine({
      currentEngine: driver.engine,
      failedEngines: nextFailed,
      repo,
      availableEngines,
      trippedEngines: newlyTripped ? [...trippedEngines, driver.engine] : trippedEngines,
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
          activeHint: `[Engine Fallback: ${driver.engine} -> ${fallbackEngine}] Previous engine errored (${lastErrorEvent.message}). Existing worktree state is preserved; continue and finish cleanly.`,
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
          activeHint: `Previous ${stage} attempt errored (${lastErrorEvent.message}). Fix and retry.`,
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
        `Stage ${stage} failed: ${lastErrorEvent.message}`,
      );
    } else {
      await ctx.escalateTicket(
        { ...ticket, costUsd: ticket.costUsd + stageCostUsd },
        "watchdog_escalation",
        `Stage ${stage} failed: ${lastErrorEvent.message}`,
        { stageRunId: stageRun.id, failedEngines: nextFailed },
      );
    }
    return;
  }

  if (stage === "spec_test") {
    await handleSpecTestPostTurnOp(ctx, {
      ticket,
      repo,
      stageRun,
      worktreePath: ws.worktreePath,
      effectiveBaseBranch,
      driverEngine: driver.engine,
      collectedEvents,
      completedEvent,
      discoveredSessionId,
      stageCostUsd,
    });
    return;
  }

  const changedFiles = await ctx.workspace.getChangedFiles(ws.worktreePath, effectiveBaseBranch);
  const diffText = await ctx.workspace.getDiff(ws.worktreePath, effectiveBaseBranch);
  const textChunks = collectedEvents
    .filter((e): e is Extract<WorkerStreamEvent, { type: "text" }> => e.type === "text")
    .map((e) => e.text)
    .join("\n");
  const summary = completedEvent?.summary || textChunks || `${stage} completed`;

  let tamperedLockedTests: string[] = [];
  if (
    stage === "implement" &&
    ticket.lockedTestPaths &&
    ticket.lockedTestPaths.length > 0 &&
    ticket.specTestCommitSha &&
    ctx.workspace.getChangedFilesSince
  ) {
    const changedSinceSpec = await ctx.workspace.getChangedFilesSince(
      ws.worktreePath,
      ticket.specTestCommitSha,
    );
    tamperedLockedTests = changedSinceSpec.filter((f) => ticket.lockedTestPaths!.includes(f));
    if (tamperedLockedTests.length > 0) {
      await ctx.workspace.revertPathsToCommit?.(
        ws.worktreePath,
        ticket.specTestCommitSha,
        tamperedLockedTests,
      );
    }
  }

  const challengeReason =
    stage === "implement" && ticket.tddMode
      ? parseSpecTestChallenge(`${summary}\n${textChunks}`)
      : null;

  if (tamperedLockedTests.length > 0 && !challengeReason) {
    const tamperSummary = `Locked spec_test file(s) modified during implement and reverted: ${tamperedLockedTests.join(", ")}`;
    const failedRun: StageRun = {
      ...stageRun,
      status: "failed",
      nativeSessionId: discoveredSessionId,
      costUsd: stageCostUsd,
      completedAt: nowIso(),
      summary: tamperSummary,
    };
    await ctx.stateStore.saveStageRun(failedRun);
    const { note: tNote } = await ctx.memory.recordStageSpillAndNote({
      ticket,
      stageRun: failedRun,
      events: collectedEvents,
      changedFiles: tamperedLockedTests,
      diffText,
      summary: tamperSummary,
      verificationPassed: false,
    });
    const updatedTamperSessions = discoveredSessionId
      ? { ...ticket.nativeSessions, [driver.engine]: discoveredSessionId }
      : ticket.nativeSessions;

    if (ticket.stageRetries < ticket.mandate.maxStageRetries) {
      const retrying: Ticket = {
        ...ticket,
        status: "queued",
        stageRetries: ticket.stageRetries + 1,
        costUsd: ticket.costUsd + stageCostUsd,
        nativeSessions: updatedTamperSessions,
        inlineMemory: {
          ...ticket.inlineMemory,
          stageNotes: [...ticket.inlineMemory.stageNotes, tNote],
          activeHint: `${tamperSummary}. Locked test files are read-only; fix production code or emit SPEC_TEST_CHALLENGE: <reason> if the spec test itself is flawed.`,
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
          nativeSessions: updatedTamperSessions,
          inlineMemory: {
            ...ticket.inlineMemory,
            stageNotes: [...ticket.inlineMemory.stageNotes, tNote],
          },
        },
        "mandate_violation",
        tamperSummary,
        { tamperedLockedTests, interruptedStage: stage },
      );
    }
    return;
  }

  const filesForMandate =
    ticket.lockedTestPaths && ticket.lockedTestPaths.length > 0
      ? changedFiles.filter((f) => !ticket.lockedTestPaths!.includes(f))
      : changedFiles;
  const mandateCheck = validateChangedFilesAgainstMandate(filesForMandate, ticket.mandate);

  if (!mandateCheck.ok) {
    const hasForbidden = mandateCheck.forbiddenViolations.length > 0;
    if (hasForbidden) {
      await ctx.workspace.revertPaths(ws.worktreePath, mandateCheck.violations);
    }

    const abortedRun: StageRun = {
      ...stageRun,
      status: "failed",
      nativeSessionId: discoveredSessionId,
      costUsd: stageCostUsd,
      completedAt: nowIso(),
      summary: `Mandate violation on paths: ${mandateCheck.violations.join(", ")}`,
    };
    await ctx.stateStore.saveStageRun(abortedRun);
    const { note: vNote } = await ctx.memory.recordStageSpillAndNote({
      ticket,
      stageRun: abortedRun,
      events: collectedEvents,
      changedFiles: mandateCheck.violations,
      diffText,
      summary: abortedRun.summary!,
      verificationPassed: false,
    });

    const updatedSessionsOnViolation =
      discoveredSessionId && stage !== "review"
        ? { ...ticket.nativeSessions, [driver.engine]: discoveredSessionId }
        : ticket.nativeSessions;

    const reason = hasForbidden
      ? `Worker attempted to modify forbidden paths (${mandateCheck.forbiddenViolations.join(", ")}) or out-of-scope paths: ${mandateCheck.violations.join(", ")} (changes reverted)`
      : `Worker modified files outside authorized allowedPaths: ${mandateCheck.scopeViolations.join(", ")} (preserved in worktree pending approval or revert)`;

    await ctx.escalateTicket(
      {
        ...ticket,
        costUsd: ticket.costUsd + stageCostUsd,
        nativeSessions: updatedSessionsOnViolation,
        pendingViolationPaths: hasForbidden ? undefined : mandateCheck.scopeViolations,
        inlineMemory: {
          ...ticket.inlineMemory,
          stageNotes: [...ticket.inlineMemory.stageNotes, vNote],
        },
      },
      "mandate_violation",
      reason,
      {
        violations: mandateCheck.violations,
        forbiddenViolations: mandateCheck.forbiddenViolations,
        scopeViolations: mandateCheck.scopeViolations,
        canExpandMandate: !hasForbidden && mandateCheck.scopeViolations.length > 0,
        interruptedStage: stage,
      },
    );
    return;
  }

  if (challengeReason) {
    const canRewind = (ticket.specTestChallengeCount ?? 0) < 1;
    const chRun: StageRun = {
      ...stageRun,
      status: canRewind ? "completed" : "failed",
      nativeSessionId: discoveredSessionId,
      costUsd: stageCostUsd,
      spans: spans.toArray(),
      toolProfile,
      completedAt: nowIso(),
      summary: `SPEC_TEST_CHALLENGE: ${challengeReason}`,
    };
    const { note: chNote } = await ctx.memory.recordStageSpillAndNote({
      ticket,
      stageRun: chRun,
      events: collectedEvents,
      changedFiles,
      diffText,
      summary: chRun.summary!,
      verificationPassed: false,
    });
    chRun.spillTranscriptId = chNote.spillArtifactIds[0];
    await ctx.stateStore.saveStageRun(chRun);
    ctx.emitEvent({
      type: "stage_completed",
      ticketId: ticket.id,
      stageRun: chRun,
      note: chNote,
      timestamp: chRun.completedAt!,
    });

    const updatedChallengeSessions = discoveredSessionId
      ? { ...ticket.nativeSessions, [driver.engine]: discoveredSessionId }
      : ticket.nativeSessions;

    if (canRewind) {
      const rewound: Ticket = {
        ...ticket,
        status: "queued",
        currentStage: "spec_test",
        stageRetries: 0,
        specTestChallengeCount: (ticket.specTestChallengeCount ?? 0) + 1,
        lockedTestPaths: undefined,
        activeEngine: undefined,
        failedEngines: [],
        costUsd: ticket.costUsd + stageCostUsd,
        nativeSessions: updatedChallengeSessions,
        inlineMemory: {
          ...ticket.inlineMemory,
          stageNotes: [...ticket.inlineMemory.stageNotes, chNote],
          activeHint: `[SPEC_TEST_CHALLENGE from implement] Review and repair the specification tests if justified: ${challengeReason}`,
        },
        updatedAt: nowIso(),
      };
      await ctx.stateStore.saveTicket(rewound);
      ctx.emitEvent({ type: "ticket_updated", ticket: rewound, timestamp: rewound.updatedAt });
      return;
    }

    await ctx.escalateTicket(
      {
        ...ticket,
        costUsd: ticket.costUsd + stageCostUsd,
        nativeSessions: updatedChallengeSessions,
        inlineMemory: {
          ...ticket.inlineMemory,
          stageNotes: [...ticket.inlineMemory.stageNotes, chNote],
        },
      },
      "watchdog_escalation",
      `SPEC_TEST_CHALLENGE raised again after max 1 rewind: ${challengeReason}`,
      { stageRunId: chRun.id, challengeReason },
    );
    return;
  }

  const workerClarification =
    (stage === "plan" || stage === "implement") && (ticket.clarificationCount ?? 0) < 1
      ? extractWorkerClarificationRequest(
          collectedEvents,
          completedEvent?.structuredOutput?.clarificationRequest,
        )
      : null;
  if (workerClarification) {
    const clarTs = nowIso();
    const clarRun: StageRun = {
      ...stageRun,
      status: "completed",
      nativeSessionId: discoveredSessionId,
      costUsd: stageCostUsd,
      spans: spans.toArray(),
      toolProfile,
      completedAt: clarTs,
      summary: `Clarification requested: ${workerClarification.question}`,
    };
    const { note: clarNote } = await ctx.memory.recordStageSpillAndNote({
      ticket,
      stageRun: clarRun,
      events: collectedEvents,
      changedFiles,
      diffText,
      summary: clarRun.summary!,
      verificationPassed: false,
    });
    clarRun.spillTranscriptId = clarNote.spillArtifactIds[0];
    await ctx.stateStore.saveStageRun(clarRun);
    ctx.emitEvent({
      type: "stage_completed",
      ticketId: ticket.id,
      stageRun: clarRun,
      note: clarNote,
      timestamp: clarTs,
    });

    const updatedClarSessions = discoveredSessionId
      ? { ...ticket.nativeSessions, [driver.engine]: discoveredSessionId }
      : ticket.nativeSessions;
    const effectiveGatePolicy =
      ticket.deliveryGatePolicy ?? repo.deliveryGatePolicy ?? "always_auto";
    const shouldPauseForHuman =
      repo.mode === "observe" ||
      ticket.template === "strict" ||
      effectiveGatePolicy === "risk_gated" ||
      effectiveGatePolicy === "always_signoff";

    if (shouldPauseForHuman) {
      await ctx.escalateTicket(
        {
          ...ticket,
          clarificationCount: (ticket.clarificationCount ?? 0) + 1,
          costUsd: ticket.costUsd + stageCostUsd,
          nativeSessions: updatedClarSessions,
          inlineMemory: {
            ...ticket.inlineMemory,
            stageNotes: [...ticket.inlineMemory.stageNotes, clarNote],
          },
        },
        "clarification_request",
        workerClarification.question,
        {
          clarification: workerClarification,
          stage,
          stageRunId: clarRun.id,
        },
      );
      return;
    }

    const autoLine = `[AUTO-CLARIFIED] Q: ${workerClarification.question} -> Adopted recommended option: ${workerClarification.recommendedOption}`;
    const autoResumed: Ticket = {
      ...ticket,
      status: "queued",
      clarificationCount: (ticket.clarificationCount ?? 0) + 1,
      costUsd: ticket.costUsd + stageCostUsd,
      nativeSessions: updatedClarSessions,
      activeEngine: driver.engine,
      inlineMemory: {
        ...ticket.inlineMemory,
        stageNotes: [...ticket.inlineMemory.stageNotes, clarNote],
        threadUpdates: [
          ...ticket.inlineMemory.threadUpdates,
          {
            triggerId: newId("clr"),
            message: autoLine,
            createdAt: clarTs,
          },
        ],
        activeHint: autoLine,
      },
      updatedAt: clarTs,
    };
    await ctx.stateStore.saveTicket(autoResumed);
    ctx.emitEvent({
      type: "ticket_updated",
      ticket: autoResumed,
      timestamp: clarTs,
    });
    return;
  }

  let reviewApproved =
    stage === "review" ? (completedEvent?.structuredOutput?.approved ?? true) : undefined;
  let reviewReport: ReviewReport | undefined;
  let reviewReportArtifact: SpillArtifact | undefined;
  if (stage === "review") {
    reviewReport = parseReviewReport({
      summary,
      textChunks,
      structuredOutput: completedEvent?.structuredOutput,
      engine: driver.engine,
    });
    reviewApproved = reviewReport.verdict === "approved";

    reviewReportArtifact = await ctx.artifactStore.writeSpill(
      {
        ticketId: ticket.id,
        stageRunId: stageRun.id,
        kind: "review_report",
        summary: `Review ${reviewReport.verdict} (${reviewReport.findings.length} finding(s))`,
        ext: "json",
      },
      JSON.stringify(reviewReport, null, 2),
    );
    await ctx.stateStore.saveArtifact(
      reviewReportArtifact,
      [
        reviewReport.verdict,
        ...reviewReport.findings.map((f) => `${f.severity} ${f.file ?? ""} ${f.message}`),
      ].join("\n"),
    );
    if (reviewReport.findings.length > 0) {
      await syncAiFindingsToReviewComments(ctx, ticket, reviewReport.findings);
    }
  }

  let verificationArtifacts: SpillArtifact[] = [];
  let verificationPassed = completedEvent?.structuredOutput?.verificationPassed ?? true;
  if (stage === "implement") {
    const gate = await runRepoVerificationGateOp(ctx, ticket, repo, stageRun, ws.worktreePath, {
      isFinalDeliveryGate: false,
    });
    spans.addExisting(gate.spans);
    verificationArtifacts = gate.artifacts;
    verificationPassed = gate.passed;
    if (!gate.passed) {
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
      await ctx.captureTicketCheckpoint(ticket, repo, ws.worktreePath, {
        stage: "implement",
        stageRunId: failedRun.id,
        engine: driver.engine,
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
        ? { ...ticket.nativeSessions, [driver.engine]: discoveredSessionId }
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
          activeEngine: driver.engine,
          inlineMemory: updatedFailMemory,
          updatedAt: nowIso(),
        };
        await ctx.stateStore.saveTicket(retrying);
        ctx.emitEvent({ type: "ticket_updated", ticket: retrying, timestamp: retrying.updatedAt });
      } else {
        const nextFailed = Array.from(new Set([...(ticket.failedEngines ?? []), driver.engine]));
        const fallbackEngine = pickNextFallbackEngine({
          currentEngine: driver.engine,
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
              activeHint: `[Engine Fallback: ${driver.engine} -> ${fallbackEngine}] ${driver.engine} exhausted retries on verification gate (${gate.result?.failedCommand ?? "checks"}). Preserved worktree changes; fix and pass verification:\n${failedSummary}`,
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
      return;
    }
  }

  const extraArtifacts: SpillArtifact[] = [...verificationArtifacts];
  if (reviewReportArtifact) extraArtifacts.push(reviewReportArtifact);

  const nitText =
    reviewApproved && reviewReport && reviewReport.findings.length > 0
      ? formatNitSummary(reviewReport.findings)
      : "";
  const noteSummary = nitText ? `${summary}\nAdvisory nits: ${nitText}` : summary;

  const finishedRun: StageRun = {
    ...stageRun,
    status: "completed",
    nativeSessionId: discoveredSessionId,
    costUsd: stageCostUsd,
    spans: spans.toArray(),
    toolProfile,
    completedAt: nowIso(),
    summary: noteSummary,
  };

  const { note } = await ctx.memory.recordStageSpillAndNote({
    ticket,
    stageRun: finishedRun,
    events: collectedEvents,
    changedFiles,
    diffText,
    summary: noteSummary,
    verificationPassed,
    reviewApproved,
    reviewFindings: reviewReport?.findings,
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

  const updatedSessions =
    discoveredSessionId && stage !== "review"
      ? { ...ticket.nativeSessions, [driver.engine]: discoveredSessionId }
      : ticket.nativeSessions;

  const updatedMemory = {
    ...ticket.inlineMemory,
    planSummary:
      stage === "plan"
        ? completedEvent?.structuredOutput?.planSummary || summary
        : ticket.inlineMemory.planSummary,
    stageNotes: [...ticket.inlineMemory.stageNotes, note],
    activeHint: undefined,
  };

  const template = getPipelineTemplate(ticket.template);

  if (stage === "plan") {
    if (template.requirePlanApproval) {
      const awaitingTicket: Ticket = {
        ...ticket,
        status: "awaiting_plan_approval",
        costUsd: ticket.costUsd + stageCostUsd,
        nativeSessions: updatedSessions,
        activeEngine: undefined,
        inlineMemory: updatedMemory,
        updatedAt: nowIso(),
      };
      await ctx.stateStore.saveTicket(awaitingTicket);
      ctx.emitEvent({ type: "ticket_updated", ticket: awaitingTicket, timestamp: awaitingTicket.updatedAt });

      const inboxItem: InboxItem = {
        id: newId("inb"),
        repoId: repo.id,
        ticketId: ticket.id,
        kind: "plan_approval",
        status: "pending",
        title: `Approve Plan: ${ticket.title}`,
        summary: updatedMemory.planSummary ?? summary,
        contextPayload: { stageRunId: finishedRun.id, spillArtifactIds: note.spillArtifactIds },
        createdAt: nowIso(),
      };
      await ctx.stateStore.saveInboxItem(inboxItem);
      ctx.emitEvent({ type: "inbox_created", item: inboxItem, timestamp: inboxItem.createdAt });
      return;
    }
  }

  if (stage === "implement") {
    await autoResolveModifiedReviewComments(ctx, ticket.id, changedFiles);
    await ctx.workspace.commitAll(ws.worktreePath, `super-work(${ticket.id}): ${ticket.title}`);
    await ctx.captureTicketCheckpoint(ticket, repo, ws.worktreePath, {
      stage: "implement",
      stageRunId: finishedRun.id,
      engine: driver.engine,
      label: "Implement verified & committed",
      changedFiles,
      verificationPassed: true,
    });
  }

  if (stage === "review" && reviewApproved === false) {
    const feedback =
      reviewReport && reviewReport.findings.length > 0
        ? formatBlockingFindingsForRework(reviewReport.findings)
        : completedEvent?.structuredOutput?.feedback || summary;
    if (ticket.stageRetries < ticket.mandate.maxStageRetries) {
      const sentBack: Ticket = {
        ...ticket,
        status: "queued",
        currentStage: "implement",
        stageRetries: ticket.stageRetries + 1,
        costUsd: ticket.costUsd + stageCostUsd,
        nativeSessions: updatedSessions,
        activeEngine: undefined,
        inlineMemory: {
          ...updatedMemory,
          activeHint: `Review requested changes. Address blocking findings:\n${feedback}`,
        },
        updatedAt: nowIso(),
      };
      await ctx.stateStore.saveTicket(sentBack);
      ctx.emitEvent({ type: "ticket_updated", ticket: sentBack, timestamp: sentBack.updatedAt });
      return;
    }
    if (ticket.campaignId) {
      await failCampaignWaveTicket(
        ctx,
        {
          ...ticket,
          costUsd: ticket.costUsd + stageCostUsd,
          nativeSessions: updatedSessions,
          inlineMemory: updatedMemory,
        },
        repo,
        `Code review rejected: ${feedback}`,
      );
    } else {
      await ctx.escalateTicket(
        {
          ...ticket,
          costUsd: ticket.costUsd + stageCostUsd,
          nativeSessions: updatedSessions,
          inlineMemory: updatedMemory,
        },
        "watchdog_escalation",
        `Code review rejected after ${ticket.mandate.maxStageRetries} revisions:\n${feedback}`,
        { stageRunId: finishedRun.id, findings: reviewReport?.findings ?? [] },
      );
    }
    return;
  }

  const nextStage: StageKind | null =
    stage === "implement" && ticket.prNumber
      ? "rebase"
      : getNextStage(ticket.template, stage, ticket.tddMode);
  if (!nextStage) {
    const readyTicket: Ticket = {
      ...ticket,
      costUsd: ticket.costUsd + stageCostUsd,
      nativeSessions: updatedSessions,
      activeEngine: undefined,
      inlineMemory: updatedMemory,
    };

    if (
      (ticket.campaignId || ticket.milestoneId) &&
      ticket.targetBranch &&
      ticket.targetBranch !== repo.baseBranch
    ) {
      await mergeWaveToTargetStagingBranch(
        ctx,
        readyTicket,
        repo,
        ws.worktreePath,
        ticket.targetBranch,
        changedFiles,
        diffText,
      );
      return;
    }

    const baseHeadAtRebase = ctx.workspace.getHeadCommitSha
      ? await ctx.workspace.getHeadCommitSha(repo.rootPath, effectiveBaseBranch).catch(() => undefined)
      : undefined;
    await ctx.enqueueDeliveryOutbox({ ...readyTicket, baseHeadAtRebase }, repo);
    return;
  }

  const advancing: Ticket = {
    ...ticket,
    status: "queued",
    currentStage: nextStage,
    stageRetries: 0,
    costUsd: ticket.costUsd + stageCostUsd,
    nativeSessions: updatedSessions,
    activeEngine: undefined,
    failedEngines: [],
    inlineMemory: updatedMemory,
    updatedAt: nowIso(),
  };
  await ctx.stateStore.saveTicket(advancing);
  ctx.emitEvent({ type: "ticket_updated", ticket: advancing, timestamp: advancing.updatedAt });
}
