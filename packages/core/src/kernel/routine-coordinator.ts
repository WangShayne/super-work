import { resolveFallbackChain } from "../arena.ts";
import { createDefaultMandate, validateChangedFilesAgainstMandate } from "../mandate.ts";
import { getFirstStage, getNextStage } from "../pipeline.ts";
import { computeNextRoutineRunAt, isWithinActiveHours, parseRoutineProbeVerdict } from "../routine.ts";
import type {
  InboxItem,
  PipelineTemplateId,
  RepoConfig,
  RoutineRun,
  RoutineScheduleKind,
  RoutineSpec,
  StageRun,
  Thread,
  Ticket,
  Trigger,
  WorkerEngineId,
  WorkerStreamEvent,
} from "../types.ts";
import { isTerminalTicketStatus, newId, nowIso } from "../utils.ts";
import type { KernelCoordinatorContext } from "./context.ts";

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function createRoutineSpec(
  ctx: KernelCoordinatorContext,
  input: {
    repoId: string;
    name: string;
    prompt: string;
    scheduleKind: RoutineScheduleKind;
    intervalMinutes?: number;
    cronExpr?: string;
    activeHoursStart?: string;
    activeHoursEnd?: string;
    allowedPaths?: string[];
    template?: PipelineTemplateId;
    preferredEngine?: WorkerEngineId;
    maxBudgetUsd?: number;
    enabled?: boolean;
    nextRunAt?: string;
  },
): Promise<RoutineSpec> {
  const repo = await ctx.stateStore.getRepo(input.repoId);
  if (!repo) {
    throw new Error(`Repository not found: ${input.repoId}`);
  }
  const ts = nowIso();
  const routine: RoutineSpec = {
    id: newId("rtn"),
    repoId: repo.id,
    name: input.name.trim(),
    prompt: input.prompt.trim(),
    scheduleKind: input.scheduleKind,
    intervalMinutes:
      input.scheduleKind === "interval"
        ? Math.max(1, Math.floor(input.intervalMinutes ?? 360))
        : undefined,
    cronExpr: input.scheduleKind === "cron" ? input.cronExpr?.trim() || "0 2 * * *" : undefined,
    activeHoursStart: input.activeHoursStart?.trim() || undefined,
    activeHoursEnd: input.activeHoursEnd?.trim() || undefined,
    allowedPaths:
      input.allowedPaths && input.allowedPaths.length > 0
        ? input.allowedPaths.map((p) => p.trim()).filter(Boolean)
        : ["**"],
    template: input.template ?? repo.defaultTemplate,
    preferredEngine: input.preferredEngine,
    maxBudgetUsd:
      typeof input.maxBudgetUsd === "number" && input.maxBudgetUsd > 0 ? input.maxBudgetUsd : 1.5,
    enabled: input.enabled ?? true,
    nextRunAt:
      input.nextRunAt ??
      computeNextRoutineRunAt({
        scheduleKind: input.scheduleKind,
        intervalMinutes: input.intervalMinutes ?? 360,
        cronExpr: input.cronExpr,
      }),
    createdAt: ts,
    updatedAt: ts,
  };
  await ctx.stateStore.saveRoutine(routine);
  ctx.emitEvent({ type: "routine_updated", repoId: repo.id, routine, timestamp: ts });
  return routine;
}

export async function updateRoutineSpec(
  ctx: KernelCoordinatorContext,
  id: string,
  patch: Partial<Omit<RoutineSpec, "id" | "repoId" | "createdAt" | "updatedAt">>,
): Promise<RoutineSpec> {
  const existing = await ctx.stateStore.getRoutine(id);
  if (!existing) {
    throw new Error(`Routine not found: ${id}`);
  }
  const scheduleKind = patch.scheduleKind ?? existing.scheduleKind;
  const intervalMinutes =
    scheduleKind === "interval"
      ? Math.max(1, Math.floor(patch.intervalMinutes ?? existing.intervalMinutes ?? 360))
      : undefined;
  const cronExpr =
    scheduleKind === "cron" ? (patch.cronExpr ?? existing.cronExpr ?? "0 2 * * *").trim() : undefined;
  const scheduleChanged =
    patch.scheduleKind !== undefined ||
    patch.intervalMinutes !== undefined ||
    patch.cronExpr !== undefined;

  const updated: RoutineSpec = {
    ...existing,
    ...patch,
    name: patch.name !== undefined ? patch.name.trim() || existing.name : existing.name,
    prompt: patch.prompt !== undefined ? patch.prompt.trim() || existing.prompt : existing.prompt,
    scheduleKind,
    intervalMinutes,
    cronExpr,
    activeHoursStart:
      patch.activeHoursStart !== undefined
        ? patch.activeHoursStart?.trim() || undefined
        : existing.activeHoursStart,
    activeHoursEnd:
      patch.activeHoursEnd !== undefined
        ? patch.activeHoursEnd?.trim() || undefined
        : existing.activeHoursEnd,
    allowedPaths:
      patch.allowedPaths !== undefined
        ? patch.allowedPaths.map((p) => p.trim()).filter(Boolean)
        : existing.allowedPaths,
    nextRunAt:
      patch.nextRunAt ??
      (scheduleChanged
        ? computeNextRoutineRunAt({ scheduleKind, intervalMinutes, cronExpr })
        : existing.nextRunAt),
    id: existing.id,
    repoId: existing.repoId,
    createdAt: existing.createdAt,
    updatedAt: nowIso(),
  };
  await ctx.stateStore.saveRoutine(updated);
  ctx.emitEvent({ type: "routine_updated", repoId: updated.repoId, routine: updated, timestamp: updated.updatedAt });
  return updated;
}

export async function deleteRoutineSpec(
  ctx: KernelCoordinatorContext,
  id: string,
): Promise<boolean> {
  const existing = await ctx.stateStore.getRoutine(id);
  if (!existing) return false;
  const ok = await ctx.stateStore.deleteRoutine(id);
  if (ok) {
    ctx.emitEvent({
      type: "routine_updated",
      repoId: existing.repoId,
      deletedId: id,
      timestamp: nowIso(),
    });
  }
  return ok;
}

export async function triggerRoutineNowSpec(
  ctx: KernelCoordinatorContext,
  routineId: string,
): Promise<RoutineRun> {
  const routine = await ctx.stateStore.getRoutine(routineId);
  if (!routine) {
    throw new Error(`Routine not found: ${routineId}`);
  }
  const repo = await ctx.stateStore.getRepo(routine.repoId);
  if (!repo) {
    throw new Error(`Repository not found: ${routine.repoId}`);
  }
  return executeRoutineProbe(ctx, routine, repo, { ignoreWindow: true });
}

export async function processDueRoutinesTick(
  ctx: KernelCoordinatorContext,
  now = new Date(),
): Promise<number> {
  if (ctx.isStopped()) return 0;
  const routines = await ctx.stateStore.listRoutines();
  if (routines.length === 0) return 0;
  let triggered = 0;
  for (const routine of routines) {
    if (ctx.isStopped()) break;
    if (!routine.enabled || ctx.activeRoutineRuns.has(routine.id)) continue;
    if (routine.nextRunAt && new Date(routine.nextRunAt).getTime() > now.getTime()) {
      continue;
    }
    if (!isWithinActiveHours(now, routine.activeHoursStart, routine.activeHoursEnd)) {
      continue;
    }
    const repo = await ctx.stateStore.getRepo(routine.repoId);
    if (!repo || repo.mode === "off") continue;
    triggered += 1;
    await executeRoutineProbe(ctx, routine, repo, { ignoreWindow: false, now });
  }
  return triggered;
}

export async function executeRoutineProbe(
  ctx: KernelCoordinatorContext,
  routine: RoutineSpec,
  repo: RepoConfig,
  options?: { ignoreWindow?: boolean; now?: Date },
): Promise<RoutineRun> {
  if (ctx.activeRoutineRuns.has(routine.id)) {
    throw new Error(`Routine ${routine.id} is already probing`);
  }
  ctx.activeRoutineRuns.add(routine.id);
  const now = options?.now ?? new Date();
  const nextRunAt = computeNextRoutineRunAt(routine, now);
  const runId = newId("rrun");
  const startedAt = nowIso();

  try {
    if (routine.activeTicketId) {
      const prevTicket = await ctx.stateStore.getTicket(routine.activeTicketId);
      if (prevTicket && !isTerminalTicketStatus(prevTicket.status)) {
        const skippedRun: RoutineRun = {
          id: runId,
          routineId: routine.id,
          repoId: repo.id,
          status: "skipped_overlap",
          summary: `Skipped patrol because promoted ticket ${prevTicket.id} (${prevTicket.status}) is still open.`,
          changedFiles: [],
          costUsd: 0,
          startedAt,
          completedAt: nowIso(),
        };
        await ctx.stateStore.saveRoutineRun(skippedRun);
        const nextRoutine: RoutineSpec = {
          ...routine,
          lastRunAt: skippedRun.completedAt,
          lastRunStatus: "skipped_overlap",
          nextRunAt,
          updatedAt: nowIso(),
        };
        await ctx.stateStore.saveRoutine(nextRoutine);
        ctx.emitEvent({ type: "routine_run_updated", repoId: repo.id, routineId: routine.id, run: skippedRun, timestamp: skippedRun.completedAt! });
        ctx.emitEvent({ type: "routine_updated", repoId: repo.id, routine: nextRoutine, timestamp: nextRoutine.updatedAt });
        return skippedRun;
      }
    }

    const today = utcToday();
    const effectiveBudget = ctx.getEffectiveDailyBudget(repo, today);
    if (effectiveBudget !== undefined && effectiveBudget > 0) {
      const todaySpend = await ctx.stateStore.getDailyRepoSpendUsd(repo.id, today);
      if (todaySpend >= effectiveBudget) {
        const skippedBudget: RoutineRun = {
          id: runId,
          routineId: routine.id,
          repoId: repo.id,
          status: "skipped_budget",
          summary: `Skipped patrol: daily repo budget reached ($${todaySpend.toFixed(2)} / $${effectiveBudget.toFixed(2)}).`,
          changedFiles: [],
          costUsd: 0,
          startedAt,
          completedAt: nowIso(),
        };
        await ctx.stateStore.saveRoutineRun(skippedBudget);
        const nextRoutine: RoutineSpec = {
          ...routine,
          lastRunAt: skippedBudget.completedAt,
          lastRunStatus: "skipped_budget",
          nextRunAt,
          updatedAt: nowIso(),
        };
        await ctx.stateStore.saveRoutine(nextRoutine);
        ctx.emitEvent({ type: "routine_run_updated", repoId: repo.id, routineId: routine.id, run: skippedBudget, timestamp: skippedBudget.completedAt! });
        ctx.emitEvent({ type: "routine_updated", repoId: repo.id, routine: nextRoutine, timestamp: nextRoutine.updatedAt });
        return skippedBudget;
      }
    }

    const initialRun: RoutineRun = {
      id: runId,
      routineId: routine.id,
      repoId: repo.id,
      status: "probing",
      summary: `Probing ${routine.name}...`,
      changedFiles: [],
      costUsd: 0,
      startedAt,
    };
    await ctx.stateStore.saveRoutineRun(initialRun);
    ctx.emitEvent({ type: "routine_run_updated", repoId: repo.id, routineId: routine.id, run: initialRun, timestamp: startedAt });

    const availableEngines = await ctx.getAvailableEngines();
    const rawPreferred = routine.preferredEngine ?? repo.preferredImplementEngine;
    const preferred: WorkerEngineId =
      rawPreferred === "auto"
        ? (availableEngines.find((e) => e !== "mock") ?? availableEngines[0] ?? "claude")
        : rawPreferred;
    let driver = ctx.drivers.get(preferred);
    if (!driver) {
      const chain = resolveFallbackChain({
        primaryEngine: preferred,
        repo,
        availableEngines,
      });
      const alt = chain[0] ?? availableEngines[0];
      driver = alt ? ctx.drivers.get(alt) : undefined;
    }
    if (!driver) {
      const failedRun: RoutineRun = {
        ...initialRun,
        status: "failed",
        summary: `No available WorkerDriver for engine '${preferred}'`,
        completedAt: nowIso(),
      };
      await ctx.stateStore.saveRoutineRun(failedRun);
      const nextRoutine: RoutineSpec = {
        ...routine,
        activeTicketId: undefined,
        lastRunAt: failedRun.completedAt,
        lastRunStatus: "failed",
        nextRunAt,
        updatedAt: nowIso(),
      };
      await ctx.stateStore.saveRoutine(nextRoutine);
      ctx.emitEvent({ type: "routine_run_updated", repoId: repo.id, routineId: routine.id, run: failedRun, timestamp: failedRun.completedAt! });
      ctx.emitEvent({ type: "routine_updated", repoId: repo.id, routine: nextRoutine, timestamp: nextRoutine.updatedAt });
      return failedRun;
    }

    const probeId = `prb_${runId}`;
    const probeBranch = `super-work/routine-probe/${runId}`;
    const mandate = createDefaultMandate({
      allowedPaths: routine.allowedPaths.length > 0 ? routine.allowedPaths : ["**"],
      forbiddenPaths: repo.forbiddenPaths ?? [],
      maxCostUsd: routine.maxBudgetUsd,
    });
    const syntheticProbeTicket: Ticket = {
      id: probeId,
      repoId: repo.id,
      threadId: `thr_${probeId}`,
      sourceTriggerId: `trg_${probeId}`,
      title: `[Routine Probe] ${routine.name}`,
      description: `${routine.prompt}\n\nIMPORTANT PROBE RULE: If everything is healthy and no fix is required, make ZERO file edits and end with \`ROUTINE_VERDICT: CLEAN\`. Only modify files inside allowedPaths when applying a concrete minimal fix, or report \`ROUTINE_VERDICT: ISSUE_FOUND - <summary>\`.`,
      status: "implementing",
      template: routine.template,
      currentStage: "implement",
      stageRetries: 0,
      mandate,
      dependsOn: [],
      branchName: probeBranch,
      nativeSessions: {},
      inlineMemory: {
        goal: routine.prompt,
        acceptanceCriteria: ["Exit cleanly with no changes if healthy; apply minimal scoped fix if regression found."],
        stageNotes: [],
        threadUpdates: [],
      },
      costUsd: 0,
      priority: 0,
      createdAt: startedAt,
      updatedAt: startedAt,
    };

    const ws = await ctx.runWithRepoWorkspaceLock(repo.id, () =>
      ctx.workspace.prepareWorkspace(syntheticProbeTicket, repo, { startPoint: repo.baseBranch }),
    );

    const prompt = await ctx.buildEnrichedWorkerPrompt(syntheticProbeTicket, repo, "implement", {
      skipHitTracking: true,
    });

    const collectedEvents: WorkerStreamEvent[] = [];
    let completedEvent: Extract<WorkerStreamEvent, { type: "completed" }> | null = null;
    let stageCostUsd = 0;
    const ac = new AbortController();

    try {
      for await (const ev of driver.runTurn(
        {
          ticketId: probeId,
          stageRunId: runId,
          stage: "implement",
          worktreePath: ws.worktreePath,
          prompt,
          mandate,
          isResume: false,
          sandboxMode: repo.sandboxMode ?? "balanced",
          rootRepoPath: repo.rootPath,
        },
        ac.signal,
      )) {
        collectedEvents.push(ev);
        if (ev.type === "usage") {
          stageCostUsd = Math.max(stageCostUsd, ev.costUsd);
        } else if (ev.type === "completed") {
          completedEvent = ev;
          if (typeof ev.costUsd === "number") {
            stageCostUsd = Math.max(stageCostUsd, ev.costUsd);
          }
        }
      }
    } catch (err) {
      await ctx.workspace.cleanupWorkspace(ws.worktreePath, repo.rootPath).catch(() => {});
      await ctx.workspace.deleteBranch?.(repo.rootPath, ws.branchName).catch(() => {});
      const failedRun: RoutineRun = {
        ...initialRun,
        status: "failed",
        summary: err instanceof Error ? err.message : String(err),
        costUsd: stageCostUsd,
        completedAt: nowIso(),
      };
      await ctx.stateStore.saveRoutineRun(failedRun);
      const nextRoutine: RoutineSpec = {
        ...routine,
        activeTicketId: undefined,
        lastRunAt: failedRun.completedAt,
        lastRunStatus: "failed",
        nextRunAt,
        updatedAt: nowIso(),
      };
      await ctx.stateStore.saveRoutine(nextRoutine);
      ctx.emitEvent({ type: "routine_run_updated", repoId: repo.id, routineId: routine.id, run: failedRun, timestamp: failedRun.completedAt! });
      ctx.emitEvent({ type: "routine_updated", repoId: repo.id, routine: nextRoutine, timestamp: nextRoutine.updatedAt });
      return failedRun;
    }

    const rawChangedFiles = await ctx.workspace.getChangedFiles(ws.worktreePath, repo.baseBranch);
    const mandateCheck = validateChangedFilesAgainstMandate(rawChangedFiles, mandate);
    if (!mandateCheck.ok && mandateCheck.forbiddenViolations.length > 0) {
      await ctx.workspace.revertPaths(ws.worktreePath, mandateCheck.forbiddenViolations);
    }
    const changedFiles = await ctx.workspace.getChangedFiles(ws.worktreePath, repo.baseBranch);

    const textChunks = collectedEvents
      .filter((e): e is Extract<WorkerStreamEvent, { type: "text" }> => e.type === "text")
      .map((e) => e.text)
      .join("\n");
    const outputText = [completedEvent?.summary, textChunks].filter(Boolean).join("\n");
    const verdict = parseRoutineProbeVerdict(outputText, changedFiles);

    if (verdict.action === "clean") {
      await ctx.workspace.cleanupWorkspace(ws.worktreePath, repo.rootPath).catch(() => {});
      await ctx.workspace.deleteBranch?.(repo.rootPath, ws.branchName).catch(() => {});

      const cleanRun: RoutineRun = {
        ...initialRun,
        status: "clean",
        summary: verdict.summary,
        changedFiles: [],
        costUsd: stageCostUsd,
        completedAt: nowIso(),
      };
      await ctx.stateStore.saveRoutineRun(cleanRun);
      const nextRoutine: RoutineSpec = {
        ...routine,
        activeTicketId: undefined,
        lastRunAt: cleanRun.completedAt,
        lastRunStatus: "clean",
        nextRunAt,
        updatedAt: nowIso(),
      };
      await ctx.stateStore.saveRoutine(nextRoutine);
      ctx.emitEvent({ type: "routine_run_updated", repoId: repo.id, routineId: routine.id, run: cleanRun, timestamp: cleanRun.completedAt! });
      ctx.emitEvent({ type: "routine_updated", repoId: repo.id, routine: nextRoutine, timestamp: nextRoutine.updatedAt });
      return cleanRun;
    }

    const promoteTs = nowIso();
    const trigger: Trigger = {
      id: newId("trg"),
      repoId: repo.id,
      source: "cli",
      threadKey: `routine:${routine.id}:${runId}`,
      title: `[Routine] ${routine.name}`,
      payload: { routineId: routine.id, routineRunId: runId },
      rawText: `${routine.prompt}\n\nProbe findings: ${verdict.summary}`,
      createdAt: promoteTs,
    };
    await ctx.stateStore.saveTrigger(trigger);

    const thread: Thread = {
      id: newId("thr"),
      repoId: repo.id,
      threadKey: trigger.threadKey,
      metadata: { source: "routine", routineId: routine.id },
      createdAt: promoteTs,
      updatedAt: promoteTs,
    };
    await ctx.stateStore.upsertThread(thread);

    const ticketId = newId("tkt");

    if (verdict.isIssueReportOnly) {
      await ctx.workspace.cleanupWorkspace(ws.worktreePath, repo.rootPath).catch(() => {});
      await ctx.workspace.deleteBranch?.(repo.rootPath, ws.branchName).catch(() => {});

      const ticket: Ticket = {
        id: ticketId,
        repoId: repo.id,
        threadId: thread.id,
        sourceTriggerId: trigger.id,
        title: `[Routine Fix] ${routine.name}`,
        description: `${routine.prompt}\n\nDetected Issue:\n${verdict.summary}`,
        status: repo.mode === "auto" ? "queued" : "proposed",
        template: routine.template,
        currentStage: getFirstStage(routine.template),
        stageRetries: 0,
        mandate,
        dependsOn: [],
        nativeSessions: {},
        preferredEngine: routine.preferredEngine,
        routineId: routine.id,
        inlineMemory: {
          goal: `${routine.name}: ${verdict.summary}`,
          acceptanceCriteria: ["Resolve issue surfaced by scheduled patrol and pass verification"],
          stageNotes: [],
          threadUpdates: [],
        },
        costUsd: stageCostUsd,
        priority: 1,
        createdAt: promoteTs,
        updatedAt: promoteTs,
      };
      await ctx.stateStore.saveTicket(ticket);
      await ctx.stateStore.upsertThread({ ...thread, subscribedTicketId: ticket.id, updatedAt: promoteTs });
      ctx.emitEvent({ type: "ticket_created", ticket, timestamp: promoteTs });

      if (ticket.status === "proposed") {
        const proposalInbox: InboxItem = {
          id: newId("inb"),
          repoId: repo.id,
          ticketId: ticket.id,
          kind: "observe_proposal",
          status: "pending",
          title: `Routine Alert: ${routine.name}`,
          summary: verdict.summary,
          contextPayload: { routineId: routine.id, routineRunId: runId },
          createdAt: promoteTs,
        };
        await ctx.stateStore.saveInboxItem(proposalInbox);
        ctx.emitEvent({ type: "inbox_created", item: proposalInbox, timestamp: promoteTs });
      }

      const promotedRun: RoutineRun = {
        id: runId,
        routineId: routine.id,
        repoId: repo.id,
        status: "promoted",
        summary: `Promoted patrol finding to ${ticket.id}`,
        changedFiles: [],
        promotedTicketId: ticket.id,
        costUsd: stageCostUsd,
        startedAt,
        completedAt: nowIso(),
      };
      await ctx.stateStore.saveRoutineRun(promotedRun);
      const nextRoutine: RoutineSpec = {
        ...routine,
        activeTicketId: ticket.id,
        lastRunAt: promotedRun.completedAt,
        lastRunStatus: "promoted",
        nextRunAt,
        updatedAt: nowIso(),
      };
      await ctx.stateStore.saveRoutine(nextRoutine);
      ctx.emitEvent({ type: "routine_run_updated", repoId: repo.id, routineId: routine.id, run: promotedRun, timestamp: promotedRun.completedAt! });
      ctx.emitEvent({ type: "routine_updated", repoId: repo.id, routine: nextRoutine, timestamp: nextRoutine.updatedAt });
      return promotedRun;
    }

    const diffText = await ctx.workspace.getDiff(ws.worktreePath, repo.baseBranch);
    await ctx.workspace.commitAll(ws.worktreePath, `super-work(routine:${routine.id}): ${routine.name}`);

    const probeStageRun: StageRun = {
      id: newId("run"),
      ticketId,
      stage: "implement",
      engine: driver.engine,
      status: "running",
      costUsd: stageCostUsd,
      startedAt,
    };
    let promotedTicket: Ticket = {
      id: ticketId,
      repoId: repo.id,
      threadId: thread.id,
      sourceTriggerId: trigger.id,
      title: `[Routine Fix] ${routine.name}`,
      description: routine.prompt,
      status: "implementing",
      template: routine.template,
      currentStage: "implement",
      stageRetries: 0,
      mandate,
      dependsOn: [],
      worktreePath: ws.worktreePath,
      branchName: ws.branchName,
      nativeSessions: {},
      preferredEngine: routine.preferredEngine,
      activeEngine: driver.engine,
      routineId: routine.id,
      inlineMemory: {
        goal: routine.prompt,
        acceptanceCriteria: ["Scheduled patrol fix passes verification and review"],
        stageNotes: [],
        threadUpdates: [],
      },
      costUsd: stageCostUsd,
      priority: 1,
      createdAt: promoteTs,
      updatedAt: promoteTs,
    };
    await ctx.stateStore.saveTicket(promotedTicket);
    await ctx.stateStore.upsertThread({ ...thread, subscribedTicketId: promotedTicket.id, updatedAt: promoteTs });
    ctx.emitEvent({ type: "ticket_created", ticket: promotedTicket, timestamp: promoteTs });

    const gate = await ctx.runRepoVerificationGate(promotedTicket, repo, probeStageRun, ws.worktreePath, {
      isFinalDeliveryGate: false,
    });

    const finishedRun: StageRun = {
      ...probeStageRun,
      status: gate.passed ? "completed" : "failed",
      completedAt: nowIso(),
      summary: gate.passed
        ? verdict.summary
        : gate.result?.summary ?? "Routine fix failed verification gate",
      ...(gate.spans ? { spans: gate.spans } : {}),
    };
    const { note } = await ctx.memory.recordStageSpillAndNote({
      ticket: promotedTicket,
      stageRun: finishedRun,
      events: collectedEvents,
      changedFiles,
      diffText,
      summary: finishedRun.summary!,
      verificationPassed: gate.passed,
      extraArtifacts: gate.artifacts.length > 0 ? gate.artifacts : undefined,
    });
    finishedRun.spillTranscriptId = note.spillArtifactIds[0];
    await ctx.stateStore.saveStageRun(finishedRun);

    const postProbeMemory = {
      ...promotedTicket.inlineMemory,
      stageNotes: [note],
      activeHint: gate.passed
        ? undefined
        : `Routine probe changes need verification fix: ${finishedRun.summary}`,
    };

    const nextStageAfterImpl = getNextStage(promotedTicket.template, "implement");
    if (!gate.passed) {
      promotedTicket = {
        ...promotedTicket,
        status: "queued",
        currentStage: "implement",
        inlineMemory: postProbeMemory,
        updatedAt: nowIso(),
      };
      await ctx.stateStore.saveTicket(promotedTicket);
      ctx.emitEvent({ type: "ticket_updated", ticket: promotedTicket, timestamp: promotedTicket.updatedAt });
    } else if (!nextStageAfterImpl) {
      await ctx.enqueueDeliveryOutbox(
        {
          ...promotedTicket,
          inlineMemory: postProbeMemory,
        },
        repo,
      );
    } else {
      promotedTicket = {
        ...promotedTicket,
        status: "queued",
        currentStage: nextStageAfterImpl,
        activeEngine: undefined,
        inlineMemory: postProbeMemory,
        updatedAt: nowIso(),
      };
      await ctx.stateStore.saveTicket(promotedTicket);
      ctx.emitEvent({ type: "ticket_updated", ticket: promotedTicket, timestamp: promotedTicket.updatedAt });
    }

    const promotedRun: RoutineRun = {
      id: runId,
      routineId: routine.id,
      repoId: repo.id,
      status: "promoted",
      summary: `Promoted edits in ${changedFiles.join(", ")} -> ticket ${promotedTicket.id}`,
      changedFiles,
      promotedTicketId: promotedTicket.id,
      costUsd: stageCostUsd,
      startedAt,
      completedAt: nowIso(),
    };
    await ctx.stateStore.saveRoutineRun(promotedRun);
    const nextRoutine: RoutineSpec = {
      ...routine,
      activeTicketId: promotedTicket.id,
      lastRunAt: promotedRun.completedAt,
      lastRunStatus: "promoted",
      nextRunAt,
      updatedAt: nowIso(),
    };
    await ctx.stateStore.saveRoutine(nextRoutine);
    ctx.emitEvent({ type: "routine_run_updated", repoId: repo.id, routineId: routine.id, run: promotedRun, timestamp: promotedRun.completedAt! });
    ctx.emitEvent({ type: "routine_updated", repoId: repo.id, routine: nextRoutine, timestamp: nextRoutine.updatedAt });
    return promotedRun;
  } finally {
    ctx.activeRoutineRuns.delete(routine.id);
  }
}
