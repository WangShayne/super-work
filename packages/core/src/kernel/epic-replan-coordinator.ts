import { classifyEpicReplanApproval, evaluateHeuristicEpicReplan, sanitizeEpicSubtasks } from "../epic.ts";
import { createDefaultMandate } from "../mandate.ts";
import { getFirstStage } from "../pipeline.ts";
import type { EpicReplanProposal, InboxItem, Thread, Ticket } from "../types.ts";
import { newId, nowIso } from "../utils.ts";
import type { KernelCoordinatorContext } from "./context.ts";

export async function applyEpicReplanProposalOp(
  ctx: KernelCoordinatorContext,
  epic: Ticket,
  proposal: EpicReplanProposal,
  options: { humanApproved: boolean },
): Promise<Ticket> {
  const repo = await ctx.stateStore.getRepo(epic.repoId);
  const allRepos = await ctx.stateStore.listRepos();
  const reposById = new Map(allRepos.map((r) => [r.id, r]));
  const allTickets = await ctx.stateStore.listTickets();
  const children = allTickets.filter((t) => t.parentTicketId === epic.id);

  const byKey = new Map<string, Ticket>();
  const byId = new Map<string, Ticket>();
  for (const c of children) {
    byId.set(c.id, c);
    if (c.subtaskKey) byKey.set(c.subtaskKey, c);
  }

  const ts = nowIso();
  let addedCount = 0;
  const addedMax = 3;
  const expandedEpicAllowed = new Set(epic.mandate.allowedPaths);

  for (const mut of proposal.mutations) {
    if (mut.kind === "update_subtask") {
      const target =
        (mut.targetTicketId ? byId.get(mut.targetTicketId) : undefined) ??
        (mut.targetSubtaskKey ? byKey.get(mut.targetSubtaskKey) : undefined);
      if (!target || (target.status !== "waiting_deps" && target.status !== "queued")) continue;

      const nextAllowed =
        mut.allowedPaths && mut.allowedPaths.length > 0
          ? mut.allowedPaths
          : target.mandate.allowedPaths;
      if (options.humanApproved) {
        for (const p of nextAllowed) expandedEpicAllowed.add(p);
      }
      const updatedChild: Ticket = {
        ...target,
        title: mut.title?.trim() || target.title,
        description: mut.description?.trim() || target.description,
        mandate: {
          ...target.mandate,
          allowedPaths: nextAllowed,
        },
        inlineMemory: {
          ...target.inlineMemory,
          goal: mut.description?.trim() || target.inlineMemory.goal,
          acceptanceCriteria:
            mut.acceptanceCriteria && mut.acceptanceCriteria.length > 0
              ? mut.acceptanceCriteria
              : target.inlineMemory.acceptanceCriteria,
        },
        updatedAt: ts,
      };
      await ctx.stateStore.saveTicket(updatedChild);
      ctx.emitEvent({ type: "ticket_updated", ticket: updatedChild, timestamp: ts });
      byId.set(updatedChild.id, updatedChild);
      if (updatedChild.subtaskKey) byKey.set(updatedChild.subtaskKey, updatedChild);
    } else if (mut.kind === "skip_subtask") {
      const target =
        (mut.targetTicketId ? byId.get(mut.targetTicketId) : undefined) ??
        (mut.targetSubtaskKey ? byKey.get(mut.targetSubtaskKey) : undefined);
      if (!target || target.status !== "waiting_deps") continue;

      const skipped: Ticket = {
        ...target,
        status: "cancelled",
        errorMessage: `Skipped by Adaptive Epic Re-plan: ${mut.reason}`,
        updatedAt: ts,
      };
      await ctx.stateStore.saveTicket(skipped);
      ctx.emitEvent({ type: "ticket_updated", ticket: skipped, timestamp: ts });
      byId.set(skipped.id, skipped);

      for (const sib of children) {
        if (sib.id === skipped.id || !sib.dependsOn.includes(skipped.id)) continue;
        const rewiredDeps = Array.from(
          new Set([
            ...sib.dependsOn.filter((d) => d !== skipped.id),
            ...skipped.dependsOn,
          ]),
        );
        const updatedSib: Ticket = {
          ...sib,
          dependsOn: rewiredDeps,
          updatedAt: ts,
        };
        await ctx.stateStore.saveTicket(updatedSib);
        ctx.emitEvent({ type: "ticket_updated", ticket: updatedSib, timestamp: ts });
        byId.set(updatedSib.id, updatedSib);
      }
    } else if (mut.kind === "add_subtask" && addedCount < addedMax && children.length < 10) {
      const targetRepo =
        (mut.repoId ? reposById.get(mut.repoId) : undefined) ?? repo;
      if (!targetRepo) continue;
      addedCount += 1;

      const [sanitizedSpec] = sanitizeEpicSubtasks(
        [
          {
            key: mut.targetSubtaskKey ?? `replan_${(epic.epicReplanCount ?? 0) + 1}_${addedCount}`,
            repoId: targetRepo.id,
            title: mut.title ?? `Adaptive step ${addedCount}`,
            description: mut.description ?? mut.reason,
            template: mut.template ?? epic.template,
            allowedPaths: mut.allowedPaths ?? ["**"],
            dependsOnKeys: mut.dependsOnKeys ?? [],
            acceptanceCriteria: mut.acceptanceCriteria ?? [mut.reason],
          },
        ],
        epic.template,
        { defaultRepoId: targetRepo.id },
      );
      if (!sanitizedSpec) continue;

      let subKey = sanitizedSpec.key;
      let suffix = 2;
      while (byKey.has(subKey)) {
        subKey = `${sanitizedSpec.key}_${suffix++}`;
      }

      const depIds = (mut.dependsOnKeys ?? [])
        .map((k) => byKey.get(k)?.id ?? byId.get(k)?.id)
        .filter((id): id is string => Boolean(id));
      if (depIds.length === 0 && byId.has(proposal.triggeredByTicketId)) {
        depIds.push(proposal.triggeredByTicketId);
      }

      const subThreadKey = `epic:${epic.id}:${subKey}`;
      const subThread: Thread = {
        id: newId("thr"),
        repoId: targetRepo.id,
        threadKey: subThreadKey,
        metadata: { source: "epic_replan", epicId: epic.id, subtaskKey: subKey },
        createdAt: ts,
        updatedAt: ts,
      };
      await ctx.stateStore.upsertThread(subThread);

      const newChildId = newId("tkt");
      const childMandate = createDefaultMandate({
        allowedPaths: sanitizedSpec.allowedPaths,
        forbiddenPaths: targetRepo.forbiddenPaths ?? [],
        maxCostUsd: 2.0,
      });
      if (options.humanApproved) {
        for (const p of childMandate.allowedPaths) expandedEpicAllowed.add(p);
      }

      let allDepsDelivered = depIds.length === 0;
      if (depIds.length > 0) {
        allDepsDelivered = depIds.every((id) => byId.get(id)?.status === "delivered");
      }

      const newChild: Ticket = {
        id: newChildId,
        repoId: targetRepo.id,
        threadId: subThread.id,
        sourceTriggerId: epic.sourceTriggerId,
        title: sanitizedSpec.title,
        description: sanitizedSpec.description,
        status: allDepsDelivered ? "queued" : "waiting_deps",
        template: sanitizedSpec.template,
        currentStage: getFirstStage(sanitizedSpec.template, epic.tddMode),
        stageRetries: 0,
        mandate: childMandate,
        dependsOn: depIds,
        parentTicketId: epic.id,
        isEpic: false,
        subtaskKey: subKey,
        nativeSessions: {},
        preferredEngine: epic.preferredEngine,
        activeEngine:
          epic.preferredEngine && epic.preferredEngine !== "auto"
            ? epic.preferredEngine
            : undefined,
        tddMode: epic.tddMode,
        inlineMemory: {
          goal: sanitizedSpec.description,
          acceptanceCriteria: sanitizedSpec.acceptanceCriteria,
          stageNotes: [],
          threadUpdates: [],
        },
        costUsd: 0,
        priority: 1,
        createdAt: ts,
        updatedAt: ts,
      };
      await ctx.stateStore.saveTicket(newChild);
      await ctx.stateStore.upsertThread({ ...subThread, subscribedTicketId: newChild.id, updatedAt: ts });
      ctx.emitEvent({ type: "ticket_created", ticket: newChild, timestamp: ts });
      children.push(newChild);
      byId.set(newChild.id, newChild);
      byKey.set(subKey, newChild);
    }
  }

  const updatedEpic: Ticket = {
    ...epic,
    status: "implementing",
    pendingEpicReplan: undefined,
    epicReplanCount: (epic.epicReplanCount ?? 0) + 1,
    epicReplanHistory: [...(epic.epicReplanHistory ?? []), proposal],
    mandate: {
      ...epic.mandate,
      allowedPaths: Array.from(expandedEpicAllowed),
    },
    errorMessage: undefined,
    updatedAt: ts,
  };
  await ctx.stateStore.saveTicket(updatedEpic);
  ctx.emitEvent({ type: "ticket_updated", ticket: updatedEpic, timestamp: ts });
  ctx.emitEvent({
    type: "epic_replanned",
    repoId: updatedEpic.repoId,
    epicId: updatedEpic.id,
    proposal,
    autoApplied: !options.humanApproved,
    timestamp: ts,
  });
  return updatedEpic;
}

export async function maybeEvaluateEpicReplanOp(
  ctx: KernelCoordinatorContext,
  epicId: string,
  completedSubtask: Ticket,
): Promise<void> {
  const epic = await ctx.stateStore.getTicket(epicId);
  if (!epic || !epic.isEpic) return;
  if ((epic.epicReplanCount ?? 0) >= 2 || epic.pendingEpicReplan) return;
  const repo = await ctx.stateStore.getRepo(epic.repoId);
  if (!repo) return;

  const digest = completedSubtask.handoverDigest;
  if (!digest) return;

  const allTickets = await ctx.stateStore.listTickets();
  const allSubtasks = allTickets.filter((t) => t.parentTicketId === epic.id);
  const unstartedSubtasks = allSubtasks.filter((t) => t.status === "waiting_deps");
  if (unstartedSubtasks.length === 0) return;

  let proposal: EpicReplanProposal | null = null;
  if (ctx.llm.proposeEpicReplan) {
    try {
      proposal = await ctx.llm.proposeEpicReplan({
        repo,
        epic,
        completedSubtask,
        digest,
        unstartedSubtasks,
        allSubtasks,
      });
    } catch {
      proposal = null;
    }
  }
  if (!proposal) {
    proposal = evaluateHeuristicEpicReplan({
      epic,
      completedSubtask,
      digest,
      unstartedSubtasks,
      allSubtasks,
    });
  }

  if (!proposal.shouldReplan || proposal.mutations.length === 0) {
    return;
  }

  const classification = classifyEpicReplanApproval({
    epic,
    repo,
    mutations: proposal.mutations,
  });
  const enforcedProposal: EpicReplanProposal = {
    ...proposal,
    requiresHumanApproval: classification.requiresHumanApproval,
    triggeredByTicketId: completedSubtask.id,
    createdAt: proposal.createdAt || nowIso(),
  };

  if (!enforcedProposal.requiresHumanApproval) {
    await applyEpicReplanProposalOp(ctx, epic, enforcedProposal, { humanApproved: false });
    return;
  }

  const ts = nowIso();
  const pausedEpic: Ticket = {
    ...epic,
    status: "needs_human",
    pendingEpicReplan: enforcedProposal,
    errorMessage: `Pending adaptive Epic re-plan approval: ${enforcedProposal.summary}`,
    updatedAt: ts,
  };
  await ctx.stateStore.saveTicket(pausedEpic);
  ctx.emitEvent({ type: "ticket_updated", ticket: pausedEpic, timestamp: ts });

  const inboxItem: InboxItem = {
    id: newId("inb"),
    repoId: epic.repoId,
    ticketId: epic.id,
    kind: "epic_replan",
    status: "pending",
    title: `Epic Re-Plan Approval: ${epic.title}`,
    summary: enforcedProposal.summary,
    contextPayload: {
      proposal: enforcedProposal,
      reasons: classification.reasons,
    },
    createdAt: ts,
  };
  await ctx.stateStore.saveInboxItem(inboxItem);
  ctx.emitEvent({ type: "inbox_created", item: inboxItem, timestamp: ts });
}
