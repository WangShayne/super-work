import { selectEngineForStage } from "../pipeline.ts";
import type { RepoConfig, StageRun, Ticket } from "../types.ts";
import { isTerminalTicketStatus, newId, nowIso } from "../utils.ts";
import type { KernelCoordinatorContext } from "./context.ts";

export async function syncEpicStatusesOp(
  ctx: KernelCoordinatorContext,
  repo: RepoConfig,
): Promise<void> {
  const allTickets = await ctx.stateStore.listTickets();
  const epics = allTickets.filter(
    (t) => t.repoId === repo.id && t.isEpic && !isTerminalTicketStatus(t.status),
  );
  if (epics.length === 0) return;

  for (const epic of epics) {
    const children = allTickets.filter((t) => t.parentTicketId === epic.id);
    if (children.length === 0) continue;

    const childrenCost = children.reduce((sum, c) => sum + c.costUsd, 0);
    const epicRuns = await ctx.stateStore.listStageRuns(epic.id);
    const epicOwnCost = epicRuns.reduce((sum, r) => sum + r.costUsd, 0);
    const totalCost = childrenCost + epicOwnCost;

    if (ctx.activeTicketRuns.has(epic.id) || ctx.finalizingEpics.has(epic.id)) {
      if (Math.abs(epic.costUsd - totalCost) > 0.0001) {
        const updatedCost: Ticket = { ...epic, costUsd: totalCost, updatedAt: nowIso() };
        await ctx.stateStore.saveTicket(updatedCost);
        ctx.emitEvent({
          type: "ticket_updated",
          ticket: updatedCost,
          timestamp: updatedCost.updatedAt,
        });
      }
      continue;
    }

    const activeChildren = children.filter((c) => c.status !== "cancelled");
    const allCancelled = activeChildren.length === 0;
    const allDelivered =
      activeChildren.length > 0 && activeChildren.every((c) => c.status === "delivered");
    const blockedChild = activeChildren.find(
      (c) => c.status === "needs_human" || c.status === "failed",
    );

    let nextStatus: Ticket["status"] = epic.status;
    let nextError: string | undefined = epic.errorMessage;
    let shouldFinalizeUnified = false;

    if (allCancelled) {
      nextStatus = "cancelled";
      nextError = "All Epic subtasks were cancelled";
    } else if (epic.pendingEpicReplan) {
      nextStatus = "needs_human";
      nextError = `Pending adaptive Epic re-plan approval: ${epic.pendingEpicReplan.summary}`;
    } else if (blockedChild) {
      nextStatus = "needs_human";
      nextError = `Subtask ${blockedChild.subtaskKey ?? blockedChild.id} (${blockedChild.title}) requires attention: ${blockedChild.errorMessage ?? blockedChild.status}`;
    } else if (allDelivered) {
      if (epic.epicDeliveryMode === "per_subtask") {
        nextStatus = "delivered";
        nextError = undefined;
      } else {
        if (epic.status === "implementing") {
          shouldFinalizeUnified = true;
          nextStatus = "implementing";
          nextError = undefined;
        }
      }
    } else {
      if (epic.status === "needs_human") {
        nextStatus = "implementing";
        nextError = undefined;
      }
    }

    let currentEpic = epic;
    if (
      epic.status !== nextStatus ||
      Math.abs(epic.costUsd - totalCost) > 0.0001 ||
      epic.errorMessage !== nextError
    ) {
      currentEpic = {
        ...epic,
        status: nextStatus,
        costUsd: totalCost,
        errorMessage: nextError,
        updatedAt: nowIso(),
      };
      await ctx.stateStore.saveTicket(currentEpic);
      ctx.emitEvent({
        type: "ticket_updated",
        ticket: currentEpic,
        timestamp: currentEpic.updatedAt,
      });
    }

    if (shouldFinalizeUnified) {
      ctx.finalizingEpics.add(currentEpic.id);
      try {
        await finalizeUnifiedEpicOp(ctx, currentEpic, repo);
      } finally {
        ctx.finalizingEpics.delete(currentEpic.id);
      }
    }
  }
}

export async function finalizeUnifiedEpicOp(
  ctx: KernelCoordinatorContext,
  epic: Ticket,
  repo: RepoConfig,
): Promise<void> {
  const branchName = epic.branchName ?? `super-work/epic/${epic.id}`;
  await ctx.workspace.ensureBranch(repo.rootPath, branchName, repo.baseBranch);
  const ws = await ctx.workspace.prepareWorkspace({ ...epic, branchName }, repo);

  const ts = nowIso();
  const stageRun: StageRun = {
    id: newId("run"),
    ticketId: epic.id,
    stage: "rebase",
    engine: selectEngineForStage(repo, "rebase", epic.preferredEngine),
    status: "running",
    costUsd: 0,
    startedAt: ts,
  };

  const rebasingEpic: Ticket = {
    ...epic,
    branchName: ws.branchName,
    worktreePath: ws.worktreePath,
    status: "rebasing",
    currentStage: "rebase",
    updatedAt: ts,
  };
  await ctx.stateStore.saveTicket(rebasingEpic);
  await ctx.stateStore.saveStageRun(stageRun);
  ctx.emitEvent({ type: "ticket_updated", ticket: rebasingEpic, timestamp: ts });

  const rebaseRes = await ctx.workspace.rebaseOntoBase(ws.worktreePath, repo.baseBranch);
  if (!rebaseRes.ok) {
    const failedRun: StageRun = {
      ...stageRun,
      status: "failed",
      completedAt: nowIso(),
      summary: rebaseRes.conflictSummary ?? "Epic rebase conflict",
    };
    await ctx.stateStore.saveStageRun(failedRun);

    if (rebasingEpic.stageRetries < 1) {
      const retryEpic: Ticket = {
        ...rebasingEpic,
        status: "queued",
        currentStage: "implement",
        template: "fast",
        stageRetries: 1,
        mandate: { ...rebasingEpic.mandate, maxStageRetries: 1 },
        inlineMemory: {
          ...rebasingEpic.inlineMemory,
          activeHint: `All Epic subtasks merged into staging branch ${ws.branchName}, but rebasing onto ${repo.baseBranch} failed: ${rebaseRes.conflictSummary}. Resolve integration conflicts across modules and re-verify.`,
        },
        updatedAt: nowIso(),
      };
      await ctx.stateStore.saveTicket(retryEpic);
      ctx.emitEvent({ type: "ticket_updated", ticket: retryEpic, timestamp: retryEpic.updatedAt });
    } else {
      await ctx.escalateTicket(
        rebasingEpic,
        "merge_conflict",
        `Epic integration rebase onto ${repo.baseBranch} conflicted: ${rebaseRes.conflictSummary}`,
        { branchName: ws.branchName },
      );
    }
    return;
  }

  const gate = await ctx.runRepoVerificationGate(rebasingEpic, repo, stageRun, ws.worktreePath, {
    isFinalDeliveryGate: true,
  });
  const changedFiles = await ctx.workspace.getChangedFiles(ws.worktreePath, repo.baseBranch);
  const diffText = await ctx.workspace.getDiff(ws.worktreePath, repo.baseBranch);

  if (!gate.passed) {
    const failedSummary = gate.result?.summary ?? "Epic final verification gate failed";
    const failedRun: StageRun = {
      ...stageRun,
      status: "failed",
      completedAt: nowIso(),
      summary: failedSummary,
    };
    const { note: failNote } = await ctx.memory.recordStageSpillAndNote({
      ticket: rebasingEpic,
      stageRun: failedRun,
      events: [],
      changedFiles,
      diffText,
      summary: failedSummary,
      verificationPassed: false,
      extraArtifacts: gate.artifacts.length > 0 ? gate.artifacts : undefined,
    });
    failedRun.spillTranscriptId = failNote.spillArtifactIds[0];
    await ctx.stateStore.saveStageRun(failedRun);

    if (rebasingEpic.stageRetries < 1) {
      const fixupEpic: Ticket = {
        ...rebasingEpic,
        status: "queued",
        currentStage: "implement",
        template: "fast",
        stageRetries: 1,
        mandate: { ...rebasingEpic.mandate, maxStageRetries: 1 },
        inlineMemory: {
          ...rebasingEpic.inlineMemory,
          stageNotes: [...rebasingEpic.inlineMemory.stageNotes, failNote],
          activeHint: `All Epic subtasks merged into staging branch ${ws.branchName}, but the final Epic integration verification failed (${gate.result?.failedCommand ?? "checks"}). Fix cross-module integration issues and pass checks:\n${failedSummary}`,
        },
        updatedAt: nowIso(),
      };
      await ctx.stateStore.saveTicket(fixupEpic);
      ctx.emitEvent({ type: "ticket_updated", ticket: fixupEpic, timestamp: fixupEpic.updatedAt });
    } else {
      await ctx.escalateTicket(
        {
          ...rebasingEpic,
          inlineMemory: {
            ...rebasingEpic.inlineMemory,
            stageNotes: [...rebasingEpic.inlineMemory.stageNotes, failNote],
          },
        },
        "watchdog_escalation",
        `Epic final verification failed after integration fixup: ${failedSummary}`,
        { stageRunId: stageRun.id, failedCommand: gate.result?.failedCommand },
      );
    }
    return;
  }

  const baseHeadAtRebase = ctx.workspace.getHeadCommitSha
    ? await ctx.workspace.getHeadCommitSha(repo.rootPath, repo.baseBranch).catch(() => undefined)
    : undefined;

  const finishedRun: StageRun = {
    ...stageRun,
    status: "completed",
    completedAt: nowIso(),
    summary:
      gate.artifacts.length > 0
        ? `Epic staging branch verified on ${ws.branchName}; ${gate.result?.summary ?? "verification passed"}`
        : `Epic staging branch ${ws.branchName} rebased cleanly onto ${repo.baseBranch}`,
  };
  const { note } = await ctx.memory.recordStageSpillAndNote({
    ticket: rebasingEpic,
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
  ctx.emitEvent({
    type: "stage_completed",
    ticketId: rebasingEpic.id,
    stageRun: finishedRun,
    note,
    timestamp: finishedRun.completedAt!,
  });

  await ctx.enqueueDeliveryOutbox(
    {
      ...rebasingEpic,
      baseHeadAtRebase,
      inlineMemory: {
        ...rebasingEpic.inlineMemory,
        stageNotes: [...rebasingEpic.inlineMemory.stageNotes, note],
      },
    },
    repo,
  );
}
