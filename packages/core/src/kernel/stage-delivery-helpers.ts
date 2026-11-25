import type { RepoConfig, Ticket } from "../types.ts";
import { nowIso } from "../utils.ts";
import type { KernelCoordinatorContext } from "./context.ts";

export async function mergeWaveToTargetStagingBranch(
  ctx: KernelCoordinatorContext,
  ticket: Ticket,
  repo: RepoConfig,
  worktreePath: string,
  targetBranch: string,
  changedFiles: string[],
  diffText: string,
): Promise<void> {
  await ctx.runWithRepoWorkspaceLock(repo.id, () =>
    ctx.workspace.mergeBranchToBase({
      rootRepoPath: repo.rootPath,
      baseBranch: targetBranch,
      branchName: ticket.branchName!,
      worktreePath,
      commitMessage: ticket.campaignId
        ? `campaign(${ticket.campaignId}/w${ticket.campaignWave ?? 1}): ${ticket.title}`
        : `milestone(${ticket.milestoneId}): ${ticket.title}`,
      deleteBranch: true,
      noFf: true,
    }),
  );
  const deliveredTs = nowIso();
  await ctx.workspace.cleanupTicketCheckpoints?.(repo.rootPath, ticket.id).catch(() => {});
  await ctx.stateStore.markCheckpointsCleaned(ticket.id, deliveredTs).catch(() => {});
  let deliveredWave: Ticket = {
    ...ticket,
    status: "delivered",
    activeEngine: undefined,
    worktreePath: undefined,
    worktreeCleanedAt: deliveredTs,
    updatedAt: deliveredTs,
  };
  await ctx.maybeDistillClosedLoopLesson(deliveredWave, repo);
  await ctx.stateStore.saveTicket(deliveredWave);
  deliveredWave = await ctx.generateAndSaveHandoverDigest(deliveredWave, repo, {
    changedFiles,
    diffText,
  });
  await ctx.recordDeliveredCasebookEntry(deliveredWave, repo);
  ctx.emitEvent({ type: "ticket_updated", ticket: deliveredWave, timestamp: deliveredTs });
  if (deliveredWave.campaignId) {
    await ctx.onCampaignTicketSettled(deliveredWave, repo);
  }
}

export async function failCampaignWaveTicket(
  ctx: KernelCoordinatorContext,
  ticket: Ticket,
  repo: RepoConfig,
  reason: string,
): Promise<void> {
  const ts = nowIso();
  const failed: Ticket = {
    ...ticket,
    status: "failed",
    activeEngine: undefined,
    errorMessage: reason,
    updatedAt: ts,
  };
  await ctx.stateStore.saveTicket(failed);
  ctx.emitEvent({ type: "ticket_updated", ticket: failed, timestamp: ts });
  if (failed.worktreePath) {
    await ctx.cleanupTicketWorktree(failed.id).catch(() => {});
  }
  await ctx.onCampaignTicketSettled(
    (await ctx.stateStore.getTicket(failed.id)) ?? failed,
    repo,
  );
}
