import { existsSync } from "node:fs";
import { detectTicketDependencyCycle } from "../epic.ts";
import { getFirstStage } from "../pipeline.ts";
import type {
  DagNodeMutationInput,
  InboxItem,
  RestoreCheckpointInput,
  StageKind,
  Ticket,
} from "../types.ts";
import { newId, nowIso } from "../utils.ts";
import type { KernelCoordinatorContext } from "./context.ts";

export async function getTicketCheckpointDiffOp(
  ctx: KernelCoordinatorContext,
  ticketId: string,
  checkpointId: string,
  baseCheckpointId?: string,
): Promise<{ diff: string; fromSha: string; toSha: string }> {
  const ticket = await ctx.stateStore.getTicket(ticketId);
  if (!ticket) {
    throw new Error(`Ticket not found: ${ticketId}`);
  }
  const repo = await ctx.stateStore.getRepo(ticket.repoId);
  if (!repo) {
    throw new Error(`Repository not found: ${ticket.repoId}`);
  }
  const cp = await ctx.stateStore.getCheckpoint(checkpointId);
  if (!cp || cp.ticketId !== ticket.id) {
    throw new Error(`Checkpoint '${checkpointId}' not found for ticket ${ticketId}`);
  }
  if (cp.cleanedAt) {
    throw new Error(`Checkpoint '${checkpointId}' has already been cleaned (${cp.cleanedAt}).`);
  }
  if (!ctx.workspace.getCommitDiff || !ctx.workspace.getHeadCommitSha) {
    throw new Error("WorkspaceProvider does not support checkpoint diff inspection.");
  }

  let fromSha: string;
  if (baseCheckpointId) {
    const baseCp = await ctx.stateStore.getCheckpoint(baseCheckpointId);
    if (!baseCp || baseCp.ticketId !== ticket.id || baseCp.cleanedAt) {
      throw new Error(`Base checkpoint '${baseCheckpointId}' not available for ticket ${ticketId}`);
    }
    fromSha = baseCp.commitSha;
  } else {
    const { effectiveBaseBranch } = await ctx.getEffectiveBaseInfo(ticket, repo);
    fromSha = await ctx.workspace.getHeadCommitSha(repo.rootPath, effectiveBaseBranch);
  }

  const diff = await ctx.workspace.getCommitDiff(repo.rootPath, fromSha, cp.commitSha);
  return { diff, fromSha, toSha: cp.commitSha };
}

export async function restoreTicketCheckpointOp(
  ctx: KernelCoordinatorContext,
  ticketId: string,
  checkpointId: string,
  input?: RestoreCheckpointInput,
): Promise<{ mode: "in_place" | "fork"; ticket: Ticket }> {
  const ticket = await ctx.stateStore.getTicket(ticketId);
  if (!ticket) {
    throw new Error(`Ticket not found: ${ticketId}`);
  }
  if (ticket.isEpic) {
    throw new Error("Checkpoints are supported on concrete execution tickets, not Epic umbrellas.");
  }
  const repo = await ctx.stateStore.getRepo(ticket.repoId);
  if (!repo) {
    throw new Error(`Repository not found: ${ticket.repoId}`);
  }
  const cp = await ctx.stateStore.getCheckpoint(checkpointId);
  if (!cp || cp.ticketId !== ticket.id) {
    throw new Error(`Checkpoint '${checkpointId}' not found for ticket ${ticketId}`);
  }
  if (cp.cleanedAt) {
    throw new Error(`Checkpoint '${checkpointId}' has already been cleaned (${cp.cleanedAt}).`);
  }
  if (!ctx.workspace.restoreWorktreeCheckpoint) {
    throw new Error("WorkspaceProvider does not support checkpoint restore.");
  }

  const mode = input?.mode ?? "in_place";
  const defaultTargetStage: StageKind =
    cp.stage === "baseline"
      ? getFirstStage(ticket.template, ticket.tddMode)
      : cp.stage;
  const targetStage: StageKind = input?.targetStage ?? defaultTargetStage;
  const keptNotes = ticket.inlineMemory.stageNotes.filter((n) => n.createdAt <= cp.createdAt);
  const discardedNotes = ticket.inlineMemory.stageNotes.filter((n) => n.createdAt > cp.createdAt);
  const pitfalls = discardedNotes
    .map((n) => `[${n.stage}] ${n.summary.replace(/\s+/g, " ").slice(0, 140)}`)
    .join("; ");
  const operatorPrompt = input?.prompt?.trim();
  const prefEngine = input?.preferredEngine ?? ticket.preferredEngine;

  if (mode === "fork") {
    const forkedBase = await ctx.createDirectTicket({
      repoId: repo.id,
      title: `[Fork] ${ticket.title}`,
      description: ticket.description,
      template: ticket.template,
      tddMode: ticket.tddMode,
      allowedPaths: ticket.mandate.allowedPaths,
      forbiddenPaths: ticket.mandate.forbiddenPaths,
      preferredEngine: prefEngine,
      startPoint: cp.commitSha,
      acceptanceCriteria: ticket.inlineMemory.acceptanceCriteria,
    });

    const forkHint = [
      `[Forked from ${ticket.id} checkpoint '${cp.label}' (${cp.commitSha.slice(0, 8)})]`,
      pitfalls ? `Parent discarded later attempt pitfalls to avoid: ${pitfalls}` : "",
      operatorPrompt ? `Operator steering instruction: ${operatorPrompt}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const updatedFork: Ticket = {
      ...forkedBase,
      currentStage: targetStage,
      inlineMemory: {
        ...forkedBase.inlineMemory,
        planSummary: ticket.inlineMemory.planSummary,
        stageNotes: keptNotes,
        activeHint: forkHint,
      },
      updatedAt: nowIso(),
    };
    await ctx.stateStore.saveTicket(updatedFork);
    ctx.emitEvent({ type: "ticket_updated", ticket: updatedFork, timestamp: updatedFork.updatedAt });
    return { mode: "fork", ticket: updatedFork };
  }

  const activeCtrl = ctx.abortControllers.get(ticket.id);
  if (activeCtrl) {
    activeCtrl.abort("checkpoint_restore");
  }
  const activeRun = ctx.activeTicketRuns.get(ticket.id);
  if (activeRun) {
    await Promise.race([activeRun, new Promise((r) => setTimeout(r, 800))]).catch(() => {});
  }

  const ws =
    ticket.worktreePath && existsSync(ticket.worktreePath)
      ? { worktreePath: ticket.worktreePath, branchName: ticket.branchName! }
      : await ctx.runWithRepoWorkspaceLock(repo.id, () =>
          ctx.workspace.prepareWorkspace(ticket, repo, { startPoint: cp.commitSha }),
        );

  await ctx.workspace.restoreWorktreeCheckpoint({
    worktreePath: ws.worktreePath,
    rootRepoPath: repo.rootPath,
    commitSha: cp.commitSha,
  });

  const resteerHint = [
    `[Time-Travel Restored to '${cp.label}' (${cp.commitSha.slice(0, 8)})]`,
    pitfalls ? `Discarded later attempt pitfalls to avoid: ${pitfalls}` : "",
    operatorPrompt ? `Operator steering instruction: ${operatorPrompt}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const shouldClearLocks = targetStage === "spec_test" || cp.stage === "baseline";
  const ts = nowIso();
  const restoredTicket: Ticket = {
    ...ticket,
    status: "queued",
    currentStage: targetStage,
    stageRetries: 0,
    worktreePath: ws.worktreePath,
    branchName: ws.branchName,
    worktreeCleanedAt: undefined,
    preferredEngine: prefEngine,
    activeEngine: prefEngine && prefEngine !== "auto" ? prefEngine : undefined,
    failedEngines: [],
    nativeSessions: {},
    lockedTestPaths: shouldClearLocks ? undefined : ticket.lockedTestPaths,
    specTestCommitSha: shouldClearLocks ? undefined : ticket.specTestCommitSha,
    errorMessage: undefined,
    inlineMemory: {
      ...ticket.inlineMemory,
      stageNotes: keptNotes,
      activeHint: resteerHint,
    },
    updatedAt: ts,
  };
  await ctx.stateStore.saveTicket(restoredTicket);
  ctx.emitEvent({ type: "ticket_updated", ticket: restoredTicket, timestamp: ts });
  return { mode: "in_place", ticket: restoredTicket };
}

export async function mutateDagNodeOp(
  ctx: KernelCoordinatorContext,
  ticketId: string,
  input: DagNodeMutationInput,
): Promise<Ticket> {
  const ticket = await ctx.stateStore.getTicket(ticketId);
  if (!ticket) {
    throw new Error(`Ticket not found: ${ticketId}`);
  }
  if (ticket.isEpic) {
    throw new Error("DAG live surgery operates on execution/subtask nodes, not Epic containers.");
  }

  const action = input.action ?? "update";
  const ts = nowIso();

  if (action === "pause") {
    const ctrl = ctx.abortControllers.get(ticket.id);
    if (ctrl) {
      ctrl.abort("dag_manual_pause");
    }
    const paused: Ticket = {
      ...ticket,
      pauseBeforeRun: false,
      status: "needs_human",
      activeEngine: undefined,
      errorMessage: "Paused manually in DAG Studio",
      updatedAt: ts,
    };
    await ctx.stateStore.saveTicket(paused);
    ctx.emitEvent({ type: "ticket_updated", ticket: paused, timestamp: ts });
    const inboxItem: InboxItem = {
      id: newId("inb"),
      repoId: ticket.repoId,
      ticketId: ticket.id,
      kind: "plan_approval",
      status: "pending",
      title: `DAG Breakpoint: ${ticket.title}`,
      summary: "Node paused in DAG Studio. Approve to resume execution.",
      contextPayload: { isDagBreakpoint: true, stage: ticket.currentStage },
      createdAt: ts,
    };
    await ctx.stateStore.saveInboxItem(inboxItem);
    ctx.emitEvent({ type: "inbox_created", item: inboxItem, timestamp: ts });
    return paused;
  }

  if (action === "resume" || action === "rerun") {
    if (action === "rerun") {
      ctx.abortControllers.get(ticket.id)?.abort("dag_rerun");
    }
    const pendingInbox = await ctx.stateStore.listInboxItems({
      ticketId: ticket.id,
      status: "pending",
    });
    for (const item of pendingInbox) {
      if (item.kind === "plan_approval" && item.contextPayload.isDagBreakpoint === true) {
        const resolved: InboxItem = {
          ...item,
          status: "approved",
          resolutionNote: `Auto-resolved via DAG ${action}`,
          resolvedAt: ts,
        };
        await ctx.stateStore.saveInboxItem(resolved);
        ctx.emitEvent({ type: "inbox_resolved", item: resolved, timestamp: ts });
      }
    }

    const hasPending = await ctx.hasUnfinishedDependencies(ticket);
    const nextTdd = input.tddMode !== undefined ? input.tddMode : ticket.tddMode;
    const nextPrefEngine =
      input.preferredEngine !== undefined ? input.preferredEngine : ticket.preferredEngine;
    const nextActiveEngine =
      input.preferredEngine !== undefined
        ? input.preferredEngine === "auto"
          ? undefined
          : input.preferredEngine
        : ticket.activeEngine;
    const nextAllowed =
      input.allowedPaths && input.allowedPaths.length > 0
        ? input.allowedPaths.map((p) => p.trim()).filter(Boolean)
        : ticket.mandate.allowedPaths;
    const nextTicket: Ticket =
      action === "resume"
        ? {
            ...ticket,
            pauseBeforeRun: false,
            preferredEngine: nextPrefEngine,
            activeEngine: nextActiveEngine,
            mandate: { ...ticket.mandate, allowedPaths: nextAllowed },
            status: hasPending ? "waiting_deps" : "queued",
            errorMessage: undefined,
            updatedAt: ts,
          }
        : {
            ...ticket,
            pauseBeforeRun: false,
            preferredEngine: nextPrefEngine,
            activeEngine: undefined,
            mandate: { ...ticket.mandate, allowedPaths: nextAllowed },
            status: hasPending ? "waiting_deps" : "queued",
            currentStage: getFirstStage(ticket.template, nextTdd),
            stageRetries: 0,
            tddMode: nextTdd,
            failedEngines: [],
            nativeSessions: {},
            lockedTestPaths: undefined,
            specTestCommitSha: undefined,
            errorMessage: undefined,
            updatedAt: ts,
          };
    await ctx.stateStore.saveTicket(nextTicket);
    ctx.emitEvent({ type: "ticket_updated", ticket: nextTicket, timestamp: ts });
    return nextTicket;
  }

  const editableStatuses = new Set<Ticket["status"]>([
    "waiting_deps",
    "queued",
    "proposed",
    "needs_human",
  ]);
  if (!editableStatuses.has(ticket.status) || ctx.activeTicketRuns.has(ticket.id)) {
    throw new Error(
      `Cannot mutate node '${ticket.id}' while in status '${ticket.status}'. Pause or wait for idle state first.`,
    );
  }

  let nextDependsOn = ticket.dependsOn;
  if (input.dependsOn !== undefined) {
    nextDependsOn = Array.from(new Set(input.dependsOn.map((d) => d.trim()).filter(Boolean)));
    const allTickets = await ctx.stateStore.listTickets();
    const byId = new Map(allTickets.map((t) => [t.id, t]));
    for (const depId of nextDependsOn) {
      const dep = byId.get(depId);
      if (!dep) {
        throw new Error(`Dependency ticket not found: ${depId}`);
      }
      if (dep.isEpic) {
        throw new Error(`Cannot depend on Epic container ticket: ${depId}`);
      }
    }
    const depsMap = new Map<string, string[]>();
    for (const t of allTickets) {
      depsMap.set(t.id, t.dependsOn);
    }
    if (detectTicketDependencyCycle(depsMap, ticket.id, nextDependsOn)) {
      throw new Error(`Dependency cycle detected involving ticket ${ticket.id}`);
    }
  }

  const nextTdd = input.tddMode !== undefined ? input.tddMode : ticket.tddMode;
  const nextPrefEngine =
    input.preferredEngine !== undefined ? input.preferredEngine : ticket.preferredEngine;
  const nextAllowed =
    input.allowedPaths && input.allowedPaths.length > 0
      ? input.allowedPaths.map((p) => p.trim()).filter(Boolean)
      : ticket.mandate.allowedPaths;

  let nextStatus = ticket.status;
  if (ticket.status === "waiting_deps" || ticket.status === "queued") {
    const hasPending = await ctx.hasUnfinishedDependencies({ ...ticket, dependsOn: nextDependsOn });
    nextStatus = hasPending ? "waiting_deps" : "queued";
  }

  const nextCurrentStage =
    input.tddMode !== undefined && ticket.inlineMemory.stageNotes.length === 0
      ? getFirstStage(ticket.template, nextTdd)
      : ticket.currentStage;

  const updated: Ticket = {
    ...ticket,
    title: input.title?.trim() || ticket.title,
    description: input.description?.trim() || ticket.description,
    preferredEngine: nextPrefEngine,
    activeEngine:
      nextPrefEngine && nextPrefEngine !== "auto" ? nextPrefEngine : undefined,
    tddMode: nextTdd,
    pauseBeforeRun:
      input.pauseBeforeRun !== undefined ? input.pauseBeforeRun : ticket.pauseBeforeRun,
    dependsOn: nextDependsOn,
    status: nextStatus,
    currentStage: nextCurrentStage,
    mandate: {
      ...ticket.mandate,
      allowedPaths: nextAllowed,
    },
    inlineMemory: {
      ...ticket.inlineMemory,
      goal: input.description?.trim() || ticket.inlineMemory.goal,
    },
    updatedAt: ts,
  };
  await ctx.stateStore.saveTicket(updated);
  ctx.emitEvent({ type: "ticket_updated", ticket: updated, timestamp: ts });
  return updated;
}
