import { evaluateBarrierGroupState, evaluateSpeculativePrefix } from "../merge-train.ts";
import type {
  MergeTrainEntry,
  OutboxEntry,
  RepoConfig,
  Ticket,
} from "../types.ts";
import { isTerminalTicketStatus, newId, nowIso } from "../utils.ts";
import type { KernelCoordinatorContext } from "./context.ts";
import { executeLifecycleHookOp } from "./lifecycle-hooks.ts";

export async function ensureMergeTrainForOutboxOp(
  ctx: KernelCoordinatorContext,
  entry: OutboxEntry,
  ticket: Ticket,
  repo: RepoConfig,
): Promise<void> {
  if (entry.action !== "local_merge" || entry.status !== "pending") return;
  if (!ctx.stateStore.listMergeTrainEntries || !ctx.stateStore.saveMergeTrainEntry) return;

  const existing = await ctx.stateStore.listMergeTrainEntries({ repoId: repo.id });
  if (existing.some((m) => m.outboxId === entry.id)) return;

  const branchName = ticket.branchName ?? (entry.payload.branchName as string | undefined) ?? "";
  if (!branchName) return;

  const pos = ctx.stateStore.nextMergeTrainPosition
    ? await ctx.stateStore.nextMergeTrainPosition(repo.id)
    : existing.length + 1;
  const ts = nowIso();
  const status = ticket.barrierGroupId ? "barrier_waiting" : "queued";

  // If entering a Cross-Repo Barrier wait, immediately materialize HandoverDigest
  // so dependent cross-repo siblings can read upstream contracts without deadlocking!
  if (status === "barrier_waiting" && !ticket.handoverDigest) {
    await ctx.generateAndSaveHandoverDigest(ticket, repo).catch(() => ticket);
  }

  const trainEntry: MergeTrainEntry = {
    id: newId("trn"),
    repoId: repo.id,
    ticketId: ticket.id,
    outboxId: entry.id,
    branchName,
    baseBranch: ticket.targetBranch ?? repo.baseBranch,
    barrierGroupId: ticket.barrierGroupId,
    position: pos,
    status,
    createdAt: ts,
    updatedAt: ts,
  };
  await ctx.stateStore.saveMergeTrainEntry(trainEntry);
  const allForRepo = await ctx.stateStore.listMergeTrainEntries({ repoId: repo.id });
  ctx.emitEvent({
    type: "merge_train_updated",
    repoId: repo.id,
    entries: allForRepo,
    timestamp: ts,
  });
}

async function emitRepoTrainUpdate(
  ctx: KernelCoordinatorContext,
  repoId: string,
): Promise<MergeTrainEntry[]> {
  if (!ctx.stateStore.listMergeTrainEntries) return [];
  const entries = await ctx.stateStore.listMergeTrainEntries({ repoId });
  ctx.emitEvent({
    type: "merge_train_updated",
    repoId,
    entries,
    timestamp: nowIso(),
  });
  return entries;
}

async function evaluateAndAdvanceBarriers(ctx: KernelCoordinatorContext): Promise<void> {
  if (!ctx.stateStore.listMergeTrainEntries || !ctx.stateStore.saveMergeTrainEntry) return;
  const allEntries = await ctx.stateStore.listMergeTrainEntries();
  const waitingGroups = new Set(
    allEntries
      .filter((e) => e.barrierGroupId && e.status === "barrier_waiting")
      .map((e) => e.barrierGroupId!),
  );
  if (waitingGroups.size === 0) return;

  const allTickets = await ctx.stateStore.listTickets();
  const trainByTicket = new Map(allEntries.map((e) => [e.ticketId, e]));

  for (const groupId of waitingGroups) {
    const groupTickets = allTickets.filter((t) => t.barrierGroupId === groupId && !t.isEpic);
    const groupEntries = allEntries.filter(
      (e) => e.barrierGroupId === groupId && e.status === "barrier_waiting",
    );
    const siblings = groupTickets.map((t) => ({
      ticketId: t.id,
      ticketStatus: t.status,
      trainStatus: trainByTicket.get(t.id)?.status,
    }));
    const groupState = evaluateBarrierGroupState(siblings);
    const ts = nowIso();

    if (groupState === "blocked") {
      const impactedRepos = new Set<string>();
      for (const entry of groupEntries) {
        const updated: MergeTrainEntry = {
          ...entry,
          status: "barrier_blocked",
          errorSummary: `Cross-repo release barrier '${groupId}' blocked because a sibling ticket failed or was escalated.`,
          updatedAt: ts,
        };
        await ctx.stateStore.saveMergeTrainEntry(updated);
        impactedRepos.add(entry.repoId);

        const outbox = await ctx.stateStore.getOutboxEntry(entry.outboxId);
        if (outbox && outbox.status !== "sent" && outbox.status !== "cancelled") {
          await ctx.stateStore.updateOutboxEntry({
            ...outbox,
            status: "failed",
            lastError: updated.errorSummary,
            updatedAt: ts,
          });
        }
        const tkt = await ctx.stateStore.getTicket(entry.ticketId);
        if (tkt && tkt.status === "outbox_pending") {
          await ctx.escalateTicket(
            tkt,
            "watchdog_escalation",
            updated.errorSummary!,
            { barrierGroupId: groupId, mergeTrainEntryId: entry.id },
          );
        }
      }
      for (const rId of impactedRepos) {
        await emitRepoTrainUpdate(ctx, rId);
      }
    } else if (groupState === "all_ready") {
      const impactedRepos = new Set<string>();
      for (const entry of groupEntries) {
        await ctx.stateStore.saveMergeTrainEntry({
          ...entry,
          status: "queued",
          updatedAt: ts,
        });
        impactedRepos.add(entry.repoId);
      }
      for (const rId of impactedRepos) {
        await emitRepoTrainUpdate(ctx, rId);
      }
    }
  }
}

async function handleFailedOrConflictingTrainSlot(
  ctx: KernelCoordinatorContext,
  entry: MergeTrainEntry,
  repo: RepoConfig,
  reason: string,
  kind: "merge_conflict" | "watchdog_escalation",
): Promise<void> {
  const ts = nowIso();
  await ctx.stateStore.saveMergeTrainEntry?.({
    ...entry,
    status: "ejected",
    errorSummary: reason,
    updatedAt: ts,
  });

  const outbox = await ctx.stateStore.getOutboxEntry(entry.outboxId);
  if (outbox) {
    const failedOutbox: OutboxEntry = {
      ...outbox,
      status: "failed",
      attempts: outbox.attempts + 1,
      lastError: reason,
      updatedAt: ts,
    };
    await ctx.stateStore.updateOutboxEntry(failedOutbox);
    ctx.emitEvent({ type: "outbox_failed", entry: failedOutbox, timestamp: ts });
  }

  const ticket = await ctx.stateStore.getTicket(entry.ticketId);
  if (!ticket) return;

  if (ticket.stageRetries < ticket.mandate.maxStageRetries) {
    const rewound: Ticket = {
      ...ticket,
      status: "queued",
      currentStage: "implement",
      stageRetries: ticket.stageRetries + 1,
      activeEngine: undefined,
      inlineMemory: {
        ...ticket.inlineMemory,
        activeHint: `Ejected from Merge Train (${entry.baseBranch}): ${reason}. Reconcile with latest ${entry.baseBranch} and re-verify.`,
      },
      updatedAt: ts,
    };
    await ctx.stateStore.saveTicket(rewound);
    ctx.emitEvent({ type: "ticket_updated", ticket: rewound, timestamp: ts });
  } else {
    await ctx.escalateTicket(ticket, kind, reason, {
      mergeTrainEntryId: entry.id,
      outboxId: entry.outboxId,
      branchName: entry.branchName,
    });
  }
}

async function markSlotDelivered(
  ctx: KernelCoordinatorContext,
  entry: MergeTrainEntry,
  outbox: OutboxEntry,
  ticket: Ticket,
  repo: RepoConfig,
  resultPayload: Record<string, unknown>,
  bypassedSpeculation: boolean,
  speculativeCommitSha?: string,
): Promise<void> {
  const ts = nowIso();
  const commitSha =
    typeof resultPayload.commitSha === "string" ? resultPayload.commitSha : speculativeCommitSha;

  await ctx.stateStore.saveMergeTrainEntry?.({
    ...entry,
    status: "merged",
    bypassedSpeculation,
    speculativeCommitSha: speculativeCommitSha ?? entry.speculativeCommitSha,
    mergedCommitSha: commitSha,
    errorSummary: undefined,
    updatedAt: ts,
  });

  const sentOutbox: OutboxEntry = {
    ...outbox,
    status: "sent",
    resultPayload,
    lastError: undefined,
    updatedAt: ts,
  };
  await ctx.stateStore.updateOutboxEntry(sentOutbox);
  ctx.emitEvent({ type: "outbox_sent", entry: sentOutbox, timestamp: ts });

  const deliveredTicket: Ticket = {
    ...ticket,
    status: "delivered",
    mergedCommitSha: commitSha ?? ticket.mergedCommitSha,
    ...(repo.autoCleanupWorktree !== false || outbox.action === "local_merge"
      ? { worktreePath: undefined, worktreeCleanedAt: ticket.worktreeCleanedAt ?? ts }
      : {}),
    updatedAt: ts,
  };
  await ctx.stateStore.saveTicket(deliveredTicket);
  ctx.emitEvent({ type: "ticket_updated", ticket: deliveredTicket, timestamp: ts });

  await ctx.onOutboxTicketDelivered(deliveredTicket, repo, sentOutbox).catch(() => {});
}

export async function flushMergeTrainOp(
  ctx: KernelCoordinatorContext,
  repoIdFilter?: string,
): Promise<number> {
  if (!ctx.stateStore.listMergeTrainEntries || !ctx.stateStore.saveMergeTrainEntry) {
    return 0;
  }

  // First backfill any pending local_merge outbox entries that haven't been mirrored yet
  const pendingOutbox = await ctx.stateStore.listOutboxEntries({
    repoId: repoIdFilter,
    status: "pending",
  });
  for (const obx of pendingOutbox) {
    if (obx.action !== "local_merge") continue;
    const [repo, tkt] = await Promise.all([
      ctx.stateStore.getRepo(obx.repoId),
      ctx.stateStore.getTicket(obx.ticketId),
    ]);
    if (repo && tkt) {
      await ensureMergeTrainForOutboxOp(ctx, obx, tkt, repo);
    }
  }

  await evaluateAndAdvanceBarriers(ctx);

  const allEntries = await ctx.stateStore.listMergeTrainEntries(
    repoIdFilter ? { repoId: repoIdFilter } : undefined,
  );
  const repoIds = Array.from(
    new Set(allEntries.filter((e) => e.status === "queued").map((e) => e.repoId)),
  );

  let mergedCount = 0;

  for (const repoId of repoIds) {
    if (ctx.isStopped()) break;
    const repo = await ctx.stateStore.getRepo(repoId);
    if (!repo) continue;

    await ctx.runWithRepoWorkspaceLock(repoId, async () => {
      while (!ctx.isStopped()) {
        const queued = (await ctx.stateStore.listMergeTrainEntries!({ repoId, status: "queued" }))
          .slice()
          .sort((a, b) => a.position - b.position);
        if (queued.length === 0) break;

        const currentBaseSha = ctx.workspace.getHeadCommitSha
          ? await ctx.workspace.getHeadCommitSha(repo.rootPath, queued[0]!.baseBranch).catch(() => "")
          : "";

        const singleTicket =
          queued.length === 1 ? await ctx.stateStore.getTicket(queued[0]!.ticketId) : null;
        const singleOutbox =
          queued.length === 1 ? await ctx.stateStore.getOutboxEntry(queued[0]!.outboxId) : null;

        const canSmartBypass =
          queued.length === 1 &&
          singleTicket &&
          singleOutbox &&
          Boolean(
            !ctx.workspace.prepareSpeculativeMergeSlot ||
              !ctx.workspace.fastForwardBranchToCommit ||
              (singleTicket.baseHeadAtRebase &&
                currentBaseSha &&
                singleTicket.baseHeadAtRebase === currentBaseSha),
          );

        if (canSmartBypass && singleTicket && singleOutbox) {
          const entry = queued[0]!;
          const preHook = await executeLifecycleHookOp(ctx, "pre_deliver", singleTicket, repo);
          if (!preHook.ok) {
            await handleFailedOrConflictingTrainSlot(
              ctx,
              entry,
              repo,
              `pre_deliver hook blocked delivery: ${preHook.summary}`,
              "watchdog_escalation",
            );
            await emitRepoTrainUpdate(ctx, repoId);
            break;
          }

          try {
            const payload = await ctx.outboxExecutor.execute(singleOutbox, repo, singleTicket);
            await markSlotDelivered(ctx, entry, singleOutbox, singleTicket, repo, payload, true);
            mergedCount += 1;
            await emitRepoTrainUpdate(ctx, repoId);
            continue;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await handleFailedOrConflictingTrainSlot(
              ctx,
              entry,
              repo,
              msg,
              msg.toLowerCase().includes("conflict") ? "merge_conflict" : "watchdog_escalation",
            );
            await emitRepoTrainUpdate(ctx, repoId);
            continue;
          }
        }

        // Speculative Merge Stack (max depth 3)
        if (
          !ctx.workspace.prepareSpeculativeMergeSlot ||
          !ctx.workspace.fastForwardBranchToCommit ||
          !currentBaseSha
        ) {
          // Safe sequential fallback if workspace provider lacks speculative primitives
          const entry = queued[0]!;
          const [tkt, obx] = await Promise.all([
            ctx.stateStore.getTicket(entry.ticketId),
            ctx.stateStore.getOutboxEntry(entry.outboxId),
          ]);
          if (!tkt || !obx) {
            await ctx.stateStore.saveMergeTrainEntry!({
              ...entry,
              status: "ejected",
              errorSummary: "Missing ticket or outbox entry",
              updatedAt: nowIso(),
            });
            continue;
          }
          try {
            const preHook = await executeLifecycleHookOp(ctx, "pre_deliver", tkt, repo);
            if (!preHook.ok) {
              throw new Error(`pre_deliver hook blocked delivery: ${preHook.summary}`);
            }
            const res = await ctx.outboxExecutor.execute(obx, repo, tkt);
            await markSlotDelivered(ctx, entry, obx, tkt, repo, res, true);
            mergedCount += 1;
          } catch (err) {
            await handleFailedOrConflictingTrainSlot(
              ctx,
              entry,
              repo,
              err instanceof Error ? err.message : String(err),
              "watchdog_escalation",
            );
          }
          await emitRepoTrainUpdate(ctx, repoId);
          continue;
        }

        const batch = queued.slice(0, 3);
        const batchTickets = new Map<string, Ticket>();
        const batchOutboxes = new Map<string, OutboxEntry>();
        for (const e of batch) {
          const [t, o] = await Promise.all([
            ctx.stateStore.getTicket(e.ticketId),
            ctx.stateStore.getOutboxEntry(e.outboxId),
          ]);
          if (t) batchTickets.set(e.id, t);
          if (o) batchOutboxes.set(e.id, o);
        }

        interface BuiltSlot {
          index: number;
          entry: MergeTrainEntry;
          ticket: Ticket;
          outbox: OutboxEntry;
          worktreePath: string;
          mergedCommitSha: string;
        }
        const builtSlots: BuiltSlot[] = [];
        let conflictSlot: { index: number; entry: MergeTrainEntry; reason: string } | null = null;
        let parentCommitSha = currentBaseSha;

        try {
          for (let i = 0; i < batch.length; i++) {
            const entry = batch[i]!;
            const tkt = batchTickets.get(entry.id);
            const obx = batchOutboxes.get(entry.id);
            if (!tkt || !obx) {
              conflictSlot = {
                index: i,
                entry,
                reason: "Missing ticket or outbox record",
              };
              break;
            }
            const slotRes = await ctx.workspace.prepareSpeculativeMergeSlot({
              rootRepoPath: repo.rootPath,
              baseCommitSha: parentCommitSha,
              branchName: entry.branchName,
              commitMessage: `Merge ${entry.branchName}: ${tkt.title}`,
              slotLabel: `train_p${entry.position}_${entry.id.slice(-6)}`,
            });
            if (!slotRes.ok || !slotRes.mergedCommitSha) {
              conflictSlot = {
                index: i,
                entry,
                reason: slotRes.conflictSummary ?? "Speculative merge failed",
              };
              break;
            }
            const validatingEntry: MergeTrainEntry = {
              ...entry,
              status: "validating",
              speculativeCommitSha: slotRes.mergedCommitSha,
              updatedAt: nowIso(),
            };
            await ctx.stateStore.saveMergeTrainEntry!(validatingEntry);
            builtSlots.push({
              index: i,
              entry: validatingEntry,
              ticket: tkt,
              outbox: obx,
              worktreePath: slotRes.worktreePath,
              mergedCommitSha: slotRes.mergedCommitSha,
            });
            parentCommitSha = slotRes.mergedCommitSha;
          }

          await emitRepoTrainUpdate(ctx, repoId);

          // Parallel validation across all built speculative merge slots
          const slotValidationResults = await Promise.all(
            builtSlots.map(async (slot) => {
              const commands = (repo.verificationCommands ?? []).map((c) => c.trim()).filter(Boolean);
              if (commands.length > 0) {
                const verifyRes = await ctx.workspace.runVerificationCommands(
                  slot.worktreePath,
                  commands,
                  slot.ticket.mandate.maxDurationSec,
                  {
                    sandboxMode: repo.sandboxMode ?? "balanced",
                    forbiddenPaths: slot.ticket.mandate.forbiddenPaths,
                    allowNetwork: slot.ticket.mandate.allowNetwork,
                    rootRepoPath: repo.rootPath,
                  },
                );
                if (!verifyRes.ok) {
                  return {
                    passed: false,
                    kind: "watchdog_escalation" as const,
                    errorSummary: verifyRes.summary,
                  };
                }
              }

              if (repo.smokeCheck?.enabled && repo.smokeCheck.startCommand?.trim() && ctx.workspace.runSmokeCheck) {
                const smokeRes = await ctx.workspace.runSmokeCheck(slot.worktreePath, repo.smokeCheck);
                if (!smokeRes.ok) {
                  return {
                    passed: false,
                    kind: "watchdog_escalation" as const,
                    errorSummary: `Smoke check failed: ${smokeRes.summary}`,
                  };
                }
              }

              const preHook = await executeLifecycleHookOp(ctx, "pre_deliver", slot.ticket, repo, {
                cwd: slot.worktreePath,
              });
              if (!preHook.ok) {
                return {
                  passed: false,
                  kind: "watchdog_escalation" as const,
                  errorSummary: `pre_deliver hook blocked delivery: ${preHook.summary}`,
                };
              }

              return { passed: true, kind: "watchdog_escalation" as const };
            }),
          );

          const evalSummary = evaluateSpeculativePrefix([
            ...slotValidationResults,
            ...(conflictSlot
              ? [{ passed: false, errorSummary: conflictSlot.reason }]
              : []),
          ]);

          const passCount = evalSummary.passingPrefixCount;
          if (passCount > 0) {
            const passingSlots = builtSlots.slice(0, passCount);
            const targetCommitSha = passingSlots[passingSlots.length - 1]!.mergedCommitSha;
            const worktreesToClean = [
              ...builtSlots.map((s) => s.worktreePath),
              ...passingSlots
                .map((s) => s.ticket.worktreePath)
                .filter((p): p is string => Boolean(p)),
            ];
            const branchesToDelete = passingSlots.map((s) => s.entry.branchName);

            await ctx.workspace.fastForwardBranchToCommit({
              rootRepoPath: repo.rootPath,
              baseBranch: batch[0]!.baseBranch,
              targetCommitSha,
              cleanupWorktrees: worktreesToClean,
              deleteBranches: branchesToDelete,
            });

            for (const slot of passingSlots) {
              await markSlotDelivered(
                ctx,
                slot.entry,
                slot.outbox,
                slot.ticket,
                repo,
                {
                  mode: "merge_train",
                  baseBranch: slot.entry.baseBranch,
                  branchName: slot.entry.branchName,
                  commitSha: slot.mergedCommitSha,
                  beforeSha: currentBaseSha,
                  isMergeCommit: true,
                  branchCleaned: true,
                },
                false,
                slot.mergedCommitSha,
              );
              mergedCount += 1;
            }
          }

          if (evalSummary.culpritIndex !== null) {
            const cIdx = evalSummary.culpritIndex;
            if (conflictSlot && cIdx === conflictSlot.index) {
              await handleFailedOrConflictingTrainSlot(
                ctx,
                conflictSlot.entry,
                repo,
                conflictSlot.reason,
                "merge_conflict",
              );
            } else if (builtSlots[cIdx]) {
              const culpritSlot = builtSlots[cIdx]!;
              const valRes = slotValidationResults[cIdx]!;
              await handleFailedOrConflictingTrainSlot(
                ctx,
                culpritSlot.entry,
                repo,
                valRes.errorSummary ?? "Speculative merge validation failed",
                valRes.kind,
              );
            }

            // Re-queue subsequent built slots so they restack cleanly on updated baseBranch
            for (const rqIdx of evalSummary.requeueIndices) {
              const rqSlot = builtSlots[rqIdx];
              if (!rqSlot) continue;
              await ctx.stateStore.saveMergeTrainEntry!({
                ...rqSlot.entry,
                status: "queued",
                speculativeCommitSha: undefined,
                updatedAt: nowIso(),
              });
            }
          }
        } finally {
          for (const slot of builtSlots) {
            await ctx.workspace.cleanupWorkspace(slot.worktreePath, repo.rootPath).catch(() => {});
          }
          await emitRepoTrainUpdate(ctx, repoId);
        }
      }
    });
  }

  return mergedCount;
}

export async function ejectMergeTrainEntryOp(
  ctx: KernelCoordinatorContext,
  entryId: string,
  reason = "Ejected from Merge Train by operator",
): Promise<MergeTrainEntry> {
  if (!ctx.stateStore.getMergeTrainEntry || !ctx.stateStore.saveMergeTrainEntry) {
    throw new Error("Configured StateStore does not support Merge Train.");
  }
  const entry = await ctx.stateStore.getMergeTrainEntry(entryId);
  if (!entry) {
    throw new Error(`Merge train entry not found: ${entryId}`);
  }
  const repo = await ctx.stateStore.getRepo(entry.repoId);
  if (!repo) {
    throw new Error(`Repository not found: ${entry.repoId}`);
  }

  const ts = nowIso();
  const ejected: MergeTrainEntry = {
    ...entry,
    status: "ejected",
    errorSummary: reason,
    updatedAt: ts,
  };
  await ctx.stateStore.saveMergeTrainEntry(ejected);

  const outbox = await ctx.stateStore.getOutboxEntry(entry.outboxId);
  if (outbox && outbox.status !== "sent") {
    await ctx.stateStore.updateOutboxEntry({
      ...outbox,
      status: "cancelled",
      lastError: reason,
      updatedAt: ts,
    });
  }

  const ticket = await ctx.stateStore.getTicket(entry.ticketId);
  if (ticket && !isTerminalTicketStatus(ticket.status)) {
    await ctx.escalateTicket(ticket, "watchdog_escalation", reason, {
      mergeTrainEntryId: entry.id,
      ejectedByOperator: true,
    });
  }

  await emitRepoTrainUpdate(ctx, entry.repoId);
  return (await ctx.stateStore.getMergeTrainEntry(entry.id)) ?? ejected;
}
