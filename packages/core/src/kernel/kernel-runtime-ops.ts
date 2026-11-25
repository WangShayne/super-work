import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { OutboxProcessor } from "../outbox.ts";
import { getFirstStage } from "../pipeline.ts";
import type { KernelConfig } from "../ports.ts";
import { EventIntakeRouter } from "../router.ts";
import type {
  InboxItem,
  ManagedWorktreeItem,
  PreviewSession,
  RepoConfig,
  Ticket,
  WorktreeGcResult,
} from "../types.ts";
import { isTerminalTicketStatus, newId, nowIso } from "../utils.ts";
import type { KernelCoordinatorContext } from "./context.ts";
import { syncRepoContractOp } from "./contract-playbook-coordinator.ts";
import { syncEpicStatusesOp } from "./epic-lifecycle-coordinator.ts";
import { flushMergeTrainOp } from "./merge-train-coordinator.ts";
import { syncMilestonesOp } from "./milestone-coordinator.ts";
import { processDueRoutinesTick } from "./routine-coordinator.ts";
import { runTicketStageOp } from "./stage-execution-coordinator.ts";

export function utcTodayString(): string {
  return new Date().toISOString().slice(0, 10);
}

export function getEffectiveDailyBudget(repo: RepoConfig, todayDate: string): number | undefined {
  if (repo.dailyBudgetOverrideDate === todayDate && repo.dailyBudgetOverrideUsd !== undefined) {
    return repo.dailyBudgetOverrideUsd;
  }
  return repo.dailyBudgetUsd;
}

export async function recoverInterruptedRunsOp(
  ctx: KernelCoordinatorContext,
) : Promise<{ recoveredTickets: number; requeuedOutbox: number }> {
  const ts = nowIso();
  const interruptedStatuses = new Set<Ticket["status"]>([
    "planning",
    "spec_testing",
    "implementing",
    "reviewing",
    "rebasing",
    "watchdog_intervention",
  ]);
  const allTickets = await ctx.stateStore.listTickets();
  let recoveredTickets = 0;

  for (const ticket of allTickets) {
    if (!interruptedStatuses.has(ticket.status) || ctx.activeTicketRuns.has(ticket.id)) {
      continue;
    }

    const stageRuns = await ctx.stateStore.listStageRuns(ticket.id);
    const runningRuns = stageRuns.filter((r) => r.status === "running");

    if (ticket.isEpic && ticket.status !== "rebasing" && runningRuns.length === 0) {
      continue;
    }

    for (const run of runningRuns) {
      await ctx.stateStore.saveStageRun({
        ...run,
        status: "aborted",
        completedAt: ts,
        summary: "Interrupted by daemon restart (recovered)",
      });
    }

    const recoveryNote =
      "Previous turn was interrupted by daemon restart. Inspect current git status/diff in the worktree first and continue from existing progress.";
    const existingHint = ticket.inlineMemory.activeHint?.trim() ?? "";
    const nextHint = existingHint.includes(recoveryNote)
      ? existingHint
      : [existingHint, recoveryNote].filter(Boolean).join("\n\n");

    const recovered: Ticket = {
      ...ticket,
      status: "queued",
      activeEngine: undefined,
      inlineMemory: {
        ...ticket.inlineMemory,
        activeHint: nextHint,
      },
      updatedAt: ts,
    };
    await ctx.stateStore.saveTicket(recovered);
    ctx.emitEvent({ type: "ticket_updated", ticket: recovered, timestamp: ts });
    recoveredTickets += 1;
  }

  const requeuedOutbox = await ctx.stateStore.requeueInterruptedOutboxEntries(ts);
  return { recoveredTickets, requeuedOutbox };
}

export async function cleanupTicketWorktreeOp(
  ctx: KernelCoordinatorContext,
  ticketId: string,
) : Promise<Ticket | null> {
  const ticket = await ctx.stateStore.getTicket(ticketId);
  if (!ticket) return null;

  if (!isTerminalTicketStatus(ticket.status) || ctx.activeTicketRuns.has(ticketId)) {
    throw new Error(
      `Cannot cleanup worktree for non-terminal ticket ${ticketId} (${ticket.status})`,
    );
  }

  await ctx.previewProvider?.stopPreviewsForTicket(ticketId).catch(() => {});
  const repo = await ctx.stateStore.getRepo(ticket.repoId);
  if (ticket.worktreePath) {
    await ctx.workspace.cleanupWorkspace(ticket.worktreePath, repo?.rootPath);
  }
  if (ticket.arenaCandidates) {
    for (const cand of ticket.arenaCandidates) {
      if (cand.worktreePath && cand.worktreePath !== ticket.worktreePath) {
        await ctx.workspace.cleanupWorkspace(cand.worktreePath, repo?.rootPath).catch(() => {});
      }
    }
  }

  const ts = nowIso();
  if (repo) {
    await ctx.workspace.cleanupTicketCheckpoints?.(repo.rootPath, ticket.id).catch(() => {});
    await ctx.stateStore.markCheckpointsCleaned(ticket.id, ts).catch(() => {});
  }

  const updated: Ticket = {
    ...ticket,
    worktreePath: undefined,
    worktreeCleanedAt: ts,
    updatedAt: ts,
  };
  await ctx.stateStore.saveTicket(updated);
  ctx.emitEvent({ type: "ticket_updated", ticket: updated, timestamp: ts });
  return updated;
}

export async function inspectWorktreesOp(
  ctx: KernelCoordinatorContext,
  repoId?: string,
) : Promise<ManagedWorktreeItem[]> {
  const [dirs, tickets, repos, previews] = await Promise.all([
    ctx.workspace.listWorktreeDirs(),
    ctx.stateStore.listTickets(),
    ctx.stateStore.listRepos(),
    ctx.previewProvider ? ctx.previewProvider.listPreviews(repoId) : Promise.resolve([]),
  ]);
  const previewByPath = new Map<string, PreviewSession>();
  for (const p of previews) {
    previewByPath.set(resolve(p.worktreePath), p);
  }
  const reposById = new Map(repos.map((r) => [r.id, r]));
  const ticketsByPath = new Map<string, Ticket>();
  const ticketsById = new Map<string, Ticket>();
  for (const t of tickets) {
    ticketsById.set(t.id, t);
    if (t.worktreePath) {
      ticketsByPath.set(resolve(t.worktreePath), t);
    }
    if (t.arenaCandidates) {
      for (const cand of t.arenaCandidates) {
        if (cand.worktreePath) {
          ticketsByPath.set(resolve(cand.worktreePath), t);
        }
      }
    }
  }

  const items: ManagedWorktreeItem[] = [];
  for (const dir of dirs) {
    const resolvedDir = resolve(dir);
    const matched = ticketsByPath.get(resolvedDir) ?? ticketsById.get(basename(resolvedDir));
    const activePreview = previewByPath.get(resolvedDir);
    if (matched) {
      const repo = reposById.get(matched.repoId);
      const item: ManagedWorktreeItem = {
        path: dir,
        ticketId: matched.id,
        ticketTitle: matched.title,
        ticketStatus: matched.status,
        repoId: matched.repoId,
        repoName: repo?.name,
        branchName: matched.branchName,
        reclaimable:
          isTerminalTicketStatus(matched.status) && !ctx.activeTicketRuns.has(matched.id),
        isOrphan: false,
        ...(activePreview ? { activePreview } : {}),
      };
      if (!repoId || item.repoId === repoId) {
        items.push(item);
      }
    } else {
      items.push({
        path: dir,
        reclaimable: true,
        isOrphan: true,
        ...(activePreview ? { activePreview } : {}),
      });
    }
  }
  return items;
}

export async function gcWorktreesOp(
  ctx: KernelCoordinatorContext,
  options?: { repoId?: string },
) : Promise<WorktreeGcResult> {
  const items = await ctx.inspectWorktrees(options?.repoId);
  const removedPaths: string[] = [];
  const cleanedTicketIds: string[] = [];
  let skippedActiveCount = 0;

  for (const item of items) {
    if (!item.reclaimable) {
      skippedActiveCount += 1;
      continue;
    }
    if (item.ticketId) {
      await ctx.cleanupTicketWorktree(item.ticketId);
      removedPaths.push(item.path);
      cleanedTicketIds.push(item.ticketId);
    } else {
      await ctx.workspace.cleanupWorkspace(item.path);
      removedPaths.push(item.path);
    }
  }

  const result: WorktreeGcResult = {
    removedPaths,
    cleanedTicketIds,
    skippedActiveCount,
    timestamp: nowIso(),
  };
  ctx.emitEvent({ type: "worktrees_gc", result, timestamp: result.timestamp });
  return result;
}

export async function startTicketPreviewOp(
  ctx: KernelCoordinatorContext,
  ticketId: string,
  candidateId?: string,
  ttlMinutes?: number,
) : Promise<PreviewSession> {
  if (!ctx.previewProvider) {
    throw new Error("Live preview provider is not configured in this kernel.");
  }
  const ticket = await ctx.stateStore.getTicket(ticketId);
  if (!ticket) {
    throw new Error(`Ticket not found: ${ticketId}`);
  }
  const repo = await ctx.stateStore.getRepo(ticket.repoId);
  if (!repo) {
    throw new Error(`Repository not found: ${ticket.repoId}`);
  }

  let worktreePath = ticket.worktreePath;
  let label = `${ticket.title}`;
  if (candidateId && ticket.arenaCandidates) {
    const cand = ticket.arenaCandidates.find((c) => c.candidateId === candidateId);
    if (!cand || !cand.worktreePath) {
      throw new Error(`Arena candidate '${candidateId}' has no active worktree.`);
    }
    worktreePath = cand.worktreePath;
    label = `${ticket.title} [${cand.engine} · ${cand.candidateId}]`;
  }
  if (!worktreePath || !existsSync(worktreePath)) {
    throw new Error(`No active worktree directory exists on disk for ticket ${ticketId}.`);
  }

  const command =
    repo.previewCommand?.trim() || repo.smokeCheck?.startCommand?.trim() || "";
  if (!command) {
    throw new Error(
      `Repository '${repo.name}' has neither previewCommand nor smokeCheck.startCommand configured.`,
    );
  }

  return ctx.previewProvider.startPreview({
    repoId: repo.id,
    ticketId: ticket.id,
    candidateId,
    label,
    worktreePath,
    command,
    ttlMinutes,
  });
}

export async function ensureBudgetCapInboxItemOp(
  ctx: KernelCoordinatorContext,
  repo: RepoConfig,
  ticket: Ticket,
  todaySpendUsd: number,
  dailyBudgetUsd: number,
  todayDate: string,
) : Promise<void> {
  const existingPending = await ctx.stateStore.listInboxItems({
    repoId: repo.id,
    status: "pending",
  });
  if (existingPending.some((i) => i.kind === "budget_cap")) {
    return;
  }
  const ts = nowIso();
  const item: InboxItem = {
    id: newId("inb"),
    repoId: repo.id,
    ticketId: ticket.id,
    kind: "budget_cap",
    status: "pending",
    title: `Daily budget cap reached for ${repo.name} ($${todaySpendUsd.toFixed(2)} / $${dailyBudgetUsd.toFixed(2)})`,
    summary: `Repository ${repo.name} spent $${todaySpendUsd.toFixed(4)} today (cap: $${dailyBudgetUsd.toFixed(2)}). In-flight stages finish cleanly; queued dispatch is paused until budget increase is approved.`,
    contextPayload: {
      repoId: repo.id,
      todaySpendUsd,
      dailyBudgetUsd,
      date: todayDate,
    },
    createdAt: ts,
  };
  await ctx.stateStore.saveInboxItem(item);
  ctx.emitEvent({ type: "inbox_created", item, timestamp: ts });
}

export async function hasUnfinishedDependenciesOp(
  ctx: KernelCoordinatorContext,
  ticket: Ticket,
) : Promise<boolean> {
  for (const depId of ticket.dependsOn) {
    const dep = await ctx.stateStore.getTicket(depId);
    if (!dep) return true;
    const barrierReady = Boolean(
      ticket.barrierGroupId &&
        dep.barrierGroupId === ticket.barrierGroupId &&
        dep.status === "outbox_pending" &&
        dep.handoverDigest,
    );
    if (dep.status !== "delivered" && !barrierReady) {
      return true;
    }
  }
  return false;
}

export async function getEffectiveBaseInfoOp(
  ctx: KernelCoordinatorContext,
  ticket: Ticket,
  repo: RepoConfig,
) : Promise<{ effectiveBaseBranch: string; parentEpic: Ticket | null }> {
  if (ticket.targetBranch && ticket.targetBranch !== repo.baseBranch) {
    await ctx.workspace.ensureBranch(repo.rootPath, ticket.targetBranch, repo.baseBranch);
    return { effectiveBaseBranch: ticket.targetBranch, parentEpic: null };
  }
  if (!ticket.parentTicketId) {
    return { effectiveBaseBranch: repo.baseBranch, parentEpic: null };
  }
  const parentEpic = await ctx.stateStore.getTicket(ticket.parentTicketId);
  if (
    parentEpic &&
    parentEpic.isEpic &&
    parentEpic.epicDeliveryMode !== "per_subtask" &&
    parentEpic.branchName
  ) {
    await ctx.workspace.ensureBranch(repo.rootPath, parentEpic.branchName, repo.baseBranch);
    return { effectiveBaseBranch: parentEpic.branchName, parentEpic };
  }
  return { effectiveBaseBranch: repo.baseBranch, parentEpic: null };
}

export async function performTickOp(
  ctx: KernelCoordinatorContext,
  router: EventIntakeRouter,
  config: KernelConfig,
) : Promise<number> {
  if (ctx.isStopped() || (ctx.selfReloadState.phase === "draining" || ctx.selfReloadState.phase === "reloading")) return 0;
  let launched = 0;
  const initialRepos = await ctx.stateStore.listRepos();
  const epicById = new Map<string, Ticket>();
  for (const r of initialRepos) {
    if (ctx.isStopped()) return 0;
    const synced = (await syncRepoContractOp(ctx, r.id).catch(() => r)) ?? r;
    if (ctx.isStopped()) return 0;
    await router.resolveDependenciesForWaitingTickets(synced);
    await syncEpicStatusesOp(ctx, synced);
    await syncMilestonesOp(ctx, synced.id).catch(() => undefined);
  }
  if (ctx.isStopped()) return 0;
  await processDueRoutinesTick(ctx);
  if (ctx.isStopped()) return 0;
  const repos = await ctx.stateStore.listRepos();
  for (const t of await ctx.stateStore.listTickets()) {
    if (t.isEpic) epicById.set(t.id, t);
  }

  const capacity = config.maxConcurrentWorkers - ctx.activeTicketRuns.size;
  if (capacity <= 0) return 0;

  const activeByRepo = new Map<string, number>();
  for (const activeId of ctx.activeTicketRuns.keys()) {
    const activeTicket = await ctx.stateStore.getTicket(activeId);
    if (activeTicket) {
      activeByRepo.set(activeTicket.repoId, (activeByRepo.get(activeTicket.repoId) ?? 0) + 1);
    }
  }

  const reposById = new Map(repos.map((r) => [r.id, r]));
  const today = utcTodayString();
  const todaySpendCache = new Map<string, number>();

  const queued = await ctx.stateStore.listTickets({ status: "queued" });
  const candidates = queued.filter((t) => {
    if (ctx.activeTicketRuns.has(t.id)) return false;
    if (t.parentTicketId && epicById.get(t.parentTicketId)?.pendingEpicReplan) {
      return false;
    }
    return true;
  });

  for (const ticket of candidates) {
    if (ctx.isStopped()) break;
    if (launched >= capacity) break;
    const repo = reposById.get(ticket.repoId);
    const stage = ticket.currentStage || getFirstStage(ticket.template, ticket.tddMode);

    if (repo?.maxConcurrentWorkers && repo.maxConcurrentWorkers > 0) {
      const curRepoActive = activeByRepo.get(repo.id) ?? 0;
      if (curRepoActive >= repo.maxConcurrentWorkers) {
        continue;
      }
    }

    const effectiveBudget = repo ? getEffectiveDailyBudget(repo, today) : undefined;
    if (stage !== "rebase" && repo && effectiveBudget !== undefined && effectiveBudget > 0) {
      let spend = todaySpendCache.get(repo.id);
      if (spend === undefined) {
        spend = await ctx.stateStore.getDailyRepoSpendUsd(repo.id, today);
        todaySpendCache.set(repo.id, spend);
      }
      if (spend >= effectiveBudget) {
        await ensureBudgetCapInboxItemOp(ctx, repo, ticket, spend, effectiveBudget, today);
        continue;
      }
    }

    activeByRepo.set(ticket.repoId, (activeByRepo.get(ticket.repoId) ?? 0) + 1);
    launched += 1;
    const promise = runTicketStageOp(ctx, ticket.id).finally(() => {
      ctx.activeTicketRuns.delete(ticket.id);
      ctx.abortControllers.delete(ticket.id);
    });
    ctx.activeTicketRuns.set(ticket.id, promise);
  }
  return launched;
}

export async function runUntilIdleOp(
  ctx: KernelCoordinatorContext,
  tick: () => Promise<number>,
  outbox: OutboxProcessor,
  maxCycles = 30,
) : Promise<void> {
  for (let i = 0; i < maxCycles; i++) {
    const launched = await tick();
    const hadActive = ctx.activeTicketRuns.size > 0;
    if (hadActive) {
      await Promise.allSettled(Array.from(ctx.activeTicketRuns.values()));
    }
    const trainMerged = await flushMergeTrainOp(ctx, );
    const outboxSent = await outbox.processDueEntries();
    const reposAfter = await ctx.stateStore.listRepos();
    for (const repo of reposAfter) {
      await syncEpicStatusesOp(ctx, repo);
      await syncMilestonesOp(ctx, repo.id).catch(() => undefined);
    }

    const waiting = await ctx.stateStore.listTickets({ status: "waiting_deps" });
    const queued = await ctx.stateStore.listTickets({ status: "queued" });
    const pendingOutbox = await ctx.stateStore.listOutboxEntries({ status: "pending" });
    if (
      ctx.activeTicketRuns.size === 0 &&
      queued.length === 0 &&
      pendingOutbox.length === 0 &&
      waiting.length === 0
    ) {
      break;
    }
    if (
      ctx.activeTicketRuns.size === 0 &&
      !hadActive &&
      launched === 0 &&
      trainMerged === 0 &&
      outboxSent === 0
    ) {
      let canUnblock = false;
      for (const w of waiting) {
        if (!(await ctx.hasUnfinishedDependencies(w))) {
          canUnblock = true;
          break;
        }
      }
      if (!canUnblock && queued.length === 0) break;
    }
  }
}
