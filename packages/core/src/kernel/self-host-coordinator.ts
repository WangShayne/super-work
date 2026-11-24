import { resolve } from "node:path";
import type { InboxItem, OutboxEntry, RepoConfig, SelfReloadState, Ticket } from "../types.ts";
import { newId, nowIso } from "../utils.ts";
import type { KernelCoordinatorContext } from "./context.ts";

const DOC_ONLY_EXT_RE = /\.(md|mdx|txt)$/i;

function isDocOnlyChangeSet(files: string[]): boolean {
  if (files.length === 0) return false;
  return files.every((f) => DOC_ONLY_EXT_RE.test(f.trim()));
}

function setAndEmitReloadState(ctx: KernelCoordinatorContext, partial: Partial<SelfReloadState>): void {
  const next: SelfReloadState = {
    ...ctx.selfReloadState,
    ...partial,
    updatedAt: nowIso(),
  };
  ctx.setSelfReloadState(next);
  ctx.emitEvent({
    type: "self_reload_updated",
    state: next,
    timestamp: next.updatedAt,
  });
}

function scheduleDrainAndReload(
  ctx: KernelCoordinatorContext,
  reason: string,
  meta: { ticketId?: string; commitSha?: string; canaryPort?: number; canaryDurationMs?: number },
): void {
  const runner = ctx.selfHostRunner;
  if (!runner) return;

  const check = async (): Promise<void> => {
    if (ctx.isStopped()) return;
    const remaining =
      ctx.activeTicketRuns.size +
      ctx.activeRoutineRuns.size +
      ctx.finalizingEpics.size +
      (ctx.hasActiveOutboxFlush() ? 1 : 0);

    if (remaining > 0) {
      if (ctx.selfReloadState.activeRunsRemaining !== remaining) {
        setAndEmitReloadState(ctx, {
          phase: "draining",
          activeRunsRemaining: remaining,
          summary: `Draining ${remaining} active operation(s) before reloading daemon...`,
        });
      }
      const timer = setTimeout(() => {
        void check();
      }, 200);
      timer.unref?.();
      return;
    }

    try {
      await ctx.stateStore.checkpointWal?.();
    } catch {
      // Non-fatal WAL checkpoint before reload
    }

    setAndEmitReloadState(ctx, {
      phase: "reloading",
      activeRunsRemaining: 0,
      ...meta,
      summary: `Drain complete; reloading super-work daemon (${reason}).`,
    });

    await runner.triggerProcessReload(reason);
  };

  // Defer initial check slightly so the calling onOutboxTicketDelivered/flushOutbox frame exits cleanly
  const initialTimer = setTimeout(() => {
    void check();
  }, 30);
  initialTimer.unref?.();
}

export async function handleSelfHostPostMergeOp(
  ctx: KernelCoordinatorContext,
  deliveredTicket: Ticket,
  repo: RepoConfig,
  entry: OutboxEntry,
): Promise<void> {
  const runner = ctx.selfHostRunner;
  if (!runner) return;
  if (entry.action !== "local_merge") return;

  const targetBranch = deliveredTicket.targetBranch ?? repo.baseBranch;
  if (targetBranch !== repo.baseBranch) return;
  if (resolve(repo.rootPath) !== resolve(runner.selfRepoRoot)) return;
  if (deliveredTicket.revertedAt) return;

  const changedFiles = deliveredTicket.handoverDigest?.changedFiles ?? [];
  if (isDocOnlyChangeSet(changedFiles)) {
    return;
  }

  const commitSha =
    deliveredTicket.mergedCommitSha ??
    (typeof entry.resultPayload?.commitSha === "string" ? entry.resultPayload.commitSha : undefined);

  setAndEmitReloadState(ctx, {
    phase: "building",
    selfRepoRoot: runner.selfRepoRoot,
    ticketId: deliveredTicket.id,
    commitSha,
    revertCommitSha: undefined,
    error: undefined,
    summary: `Building self-hosted changes for ${deliveredTicket.title} (${commitSha ?? "HEAD"})...`,
  });

  setAndEmitReloadState(ctx, {
    phase: "canary_probing",
    summary: `Running build & Boot Canary health probe for ${commitSha ?? "HEAD"}...`,
  });

  const canary = await runner.verifyBuildAndCanaryBoot({ commitSha });
  if (canary.ok) {
    setAndEmitReloadState(ctx, {
      phase: "draining",
      canaryPort: canary.canaryPort,
      canaryDurationMs: canary.durationMs,
      activeRunsRemaining:
        ctx.activeTicketRuns.size + ctx.activeRoutineRuns.size + ctx.finalizingEpics.size,
      summary: `${canary.summary}. Draining active work before reload...`,
    });
    scheduleDrainAndReload(ctx, `Self-host delivery ${deliveredTicket.id} verified by Boot Canary`, {
      ticketId: deliveredTicket.id,
      commitSha,
      canaryPort: canary.canaryPort,
      canaryDurationMs: canary.durationMs,
    });
    return;
  }

  // Build or Boot Canary failed -> automatically revert broken commit and escalate to Inbox
  let revertCommitSha: string | undefined;
  let revertError: string | undefined;
  try {
    const revRes = await ctx.revertTicketDelivery(deliveredTicket.id);
    revertCommitSha = revRes.revertCommitSha;
  } catch (err) {
    revertError = err instanceof Error ? err.message : String(err);
  }

  const ts = nowIso();
  const detailText = [
    canary.summary,
    canary.errorOutput ? `\nBoot Canary output:\n${canary.errorOutput.slice(-1500)}` : "",
    revertCommitSha
      ? `\nAuto-Reverted commit ${commitSha ?? "?"} -> ${revertCommitSha} on ${repo.baseBranch}; live daemon stayed healthy.`
      : `\nAuto-revert failed: ${revertError ?? "no commit SHA"}`,
  ]
    .filter(Boolean)
    .join("\n");

  const inboxItem: InboxItem = {
    id: newId("inb"),
    repoId: repo.id,
    ticketId: deliveredTicket.id,
    kind: "watchdog_escalation",
    status: "pending",
    title: revertCommitSha
      ? `Self-Host Boot Canary Failed (Auto-Reverted): ${deliveredTicket.title}`
      : `Self-Host Boot Canary Failed: ${deliveredTicket.title}`,
    summary: detailText,
    contextPayload: {
      selfHostRollback: true,
      failedCommitSha: commitSha,
      revertCommitSha,
      revertError,
      canaryDurationMs: canary.durationMs,
      buildOk: canary.buildOk,
    },
    createdAt: ts,
  };
  await ctx.stateStore.saveInboxItem(inboxItem);
  ctx.emitEvent({ type: "inbox_created", item: inboxItem, timestamp: ts });

  setAndEmitReloadState(ctx, {
    phase: revertCommitSha ? "rolled_back" : "failed",
    ticketId: deliveredTicket.id,
    commitSha,
    revertCommitSha,
    canaryPort: canary.canaryPort,
    canaryDurationMs: canary.durationMs,
    error: canary.summary,
    summary: revertCommitSha
      ? `Canary failed and auto-reverted to ${revertCommitSha}`
      : `Canary failed: ${canary.summary}`,
  });
}

export async function triggerManualSelfReloadOp(
  ctx: KernelCoordinatorContext,
  options?: { force?: boolean; skipCanary?: boolean },
): Promise<SelfReloadState> {
  const runner = ctx.selfHostRunner;
  if (!runner) {
    const failed: SelfReloadState = {
      ...ctx.selfReloadState,
      phase: "failed",
      error: "SelfHostRunner is not configured in this daemon.",
      updatedAt: nowIso(),
    };
    ctx.setSelfReloadState(failed);
    return failed;
  }

  if (!options?.skipCanary) {
    setAndEmitReloadState(ctx, {
      phase: "canary_probing",
      selfRepoRoot: runner.selfRepoRoot,
      error: undefined,
      summary: "Manual reload requested: running build & Boot Canary probe...",
    });
    const canary = await runner.verifyBuildAndCanaryBoot();
    if (!canary.ok && !options?.force) {
      setAndEmitReloadState(ctx, {
        phase: "failed",
        canaryPort: canary.canaryPort,
        canaryDurationMs: canary.durationMs,
        error: canary.errorOutput || canary.summary,
        summary: `Canary failed before manual reload: ${canary.summary}`,
      });
      return ctx.selfReloadState;
    }
    setAndEmitReloadState(ctx, {
      phase: "draining",
      canaryPort: canary.canaryPort,
      canaryDurationMs: canary.durationMs,
      activeRunsRemaining:
        ctx.activeTicketRuns.size + ctx.activeRoutineRuns.size + ctx.finalizingEpics.size,
      summary: `${canary.summary}. Draining active work before reload...`,
    });
  } else {
    setAndEmitReloadState(ctx, {
      phase: "draining",
      selfRepoRoot: runner.selfRepoRoot,
      error: undefined,
      activeRunsRemaining:
        ctx.activeTicketRuns.size + ctx.activeRoutineRuns.size + ctx.finalizingEpics.size,
      summary: "Draining active work for manual reload...",
    });
  }

  scheduleDrainAndReload(ctx, "Manual operator reload", {
    canaryPort: ctx.selfReloadState.canaryPort,
    canaryDurationMs: ctx.selfReloadState.canaryDurationMs,
  });
  return ctx.selfReloadState;
}
