import {
  buildCampaignWavePrompt,
  evaluateMetricDelta,
  isCampaignTargetMet,
  parseMetricValueFromOutput,
} from "../campaign.ts";
import { createDefaultMandate } from "../mandate.ts";
import type {
  CreateCampaignInput,
  GoalCampaign,
  GoalCampaignWave,
  InboxItem,
  RepoConfig,
  Ticket,
} from "../types.ts";
import { isTerminalTicketStatus, newId, nowIso } from "../utils.ts";
import type { KernelCoordinatorContext } from "./context.ts";
import { executeLifecycleHookOp } from "./lifecycle-hooks.ts";

async function measureMetricValue(
  ctx: KernelCoordinatorContext,
  repo: RepoConfig,
  campaign: GoalCampaign,
  gitRef: string,
): Promise<{ ok: boolean; value: number | null; rawOutput: string; error?: string }> {
  if (ctx.workspace.measureMetricAtRef) {
    try {
      const res = await ctx.workspace.measureMetricAtRef({
        rootRepoPath: repo.rootPath,
        gitRef,
        metricCommand: campaign.metricCommand,
        timeoutSec: 60,
        sandboxMode: repo.sandboxMode ?? "balanced",
        forbiddenPaths: repo.forbiddenPaths,
      });
      if (!res.ok) {
        return {
          ok: false,
          value: null,
          rawOutput: res.rawOutput,
          error: `Metric command exited with ${res.exitCode}: ${res.rawOutput.slice(-400)}`,
        };
      }
      const parsed = parseMetricValueFromOutput(res.rawOutput, campaign.metricRegex);
      if (parsed === null) {
        return {
          ok: false,
          value: null,
          rawOutput: res.rawOutput,
          error: `Unable to parse numeric metric from output: ${res.rawOutput.slice(-300)}`,
        };
      }
      return { ok: true, value: parsed, rawOutput: res.rawOutput };
    } catch (err) {
      return {
        ok: false,
        value: null,
        rawOutput: "",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const runRes = await ctx.workspace.runVerificationCommands(
    repo.rootPath,
    [campaign.metricCommand],
    60,
    {
      sandboxMode: repo.sandboxMode ?? "balanced",
      forbiddenPaths: repo.forbiddenPaths,
      allowNetwork: false,
      rootRepoPath: repo.rootPath,
    },
  );
  const rawOutput = runRes.results[0]?.output ?? runRes.summary;
  const parsed = runRes.ok ? parseMetricValueFromOutput(rawOutput, campaign.metricRegex) : null;
  return {
    ok: runRes.ok && parsed !== null,
    value: parsed,
    rawOutput,
    error: !runRes.ok || parsed === null ? runRes.summary : undefined,
  };
}

async function pauseCampaignWithInbox(
  ctx: KernelCoordinatorContext,
  campaign: GoalCampaign,
  reason: string,
  latestTicketId?: string,
): Promise<GoalCampaign> {
  const ts = nowIso();
  const paused: GoalCampaign = {
    ...campaign,
    status: "paused",
    activeTicketId: undefined,
    pauseReason: reason,
    updatedAt: ts,
  };
  await ctx.stateStore.saveCampaign?.(paused);
  ctx.emitEvent({
    type: "campaign_updated",
    repoId: paused.repoId,
    campaign: paused,
    timestamp: ts,
  });

  const existingPending = await ctx.stateStore.listInboxItems({
    repoId: paused.repoId,
    status: "pending",
  });
  if (
    !existingPending.some(
      (i) => i.kind === "campaign_paused" && i.contextPayload?.campaignId === paused.id,
    )
  ) {
    const inboxItem: InboxItem = {
      id: newId("inb"),
      repoId: paused.repoId,
      ticketId: latestTicketId ?? `campaign_${paused.id}`,
      kind: "campaign_paused",
      status: "pending",
      title: `Goal Campaign Paused: ${paused.name}`,
      summary: `${reason} (metric: ${paused.baselineValue ?? "?"} -> ${paused.currentValue ?? "?"}, target: ${paused.targetValue}${paused.metricUnit ? ` ${paused.metricUnit}` : ""}, waves: ${paused.completedWaves}/${paused.maxIterations}, spent: $${paused.totalCostUsd.toFixed(2)})`,
      contextPayload: {
        campaignId: paused.id,
        baselineValue: paused.baselineValue,
        currentValue: paused.currentValue,
        targetValue: paused.targetValue,
        direction: paused.direction,
        completedWaves: paused.completedWaves,
        maxIterations: paused.maxIterations,
        totalCostUsd: paused.totalCostUsd,
        maxTotalBudgetUsd: paused.maxTotalBudgetUsd,
        deliveryMode: paused.deliveryMode,
        stagingBranch: paused.stagingBranch,
        pauseReason: reason,
      },
      createdAt: ts,
    };
    await ctx.stateStore.saveInboxItem(inboxItem);
    ctx.emitEvent({ type: "inbox_created", item: inboxItem, timestamp: ts });
  }

  return paused;
}

export async function createCampaignOp(
  ctx: KernelCoordinatorContext,
  input: CreateCampaignInput,
): Promise<GoalCampaign> {
  if (!ctx.stateStore.saveCampaign) {
    throw new Error("Configured StateStore does not support Goal Campaigns.");
  }
  const repo = await ctx.stateStore.getRepo(input.repoId);
  if (!repo) {
    throw new Error(`Repository not found: ${input.repoId}`);
  }
  if (!input.name?.trim() || !input.goalPrompt?.trim() || !input.metricCommand?.trim()) {
    throw new Error("Campaign name, goalPrompt, and metricCommand are required.");
  }
  if (!Number.isFinite(input.targetValue)) {
    throw new Error("Campaign targetValue must be a finite number.");
  }

  const ts = nowIso();
  const id = newId("cmp");
  const deliveryMode = input.deliveryMode ?? "staging_branch";
  const campaign: GoalCampaign = {
    id,
    repoId: repo.id,
    name: input.name.trim(),
    goalPrompt: input.goalPrompt.trim(),
    metricCommand: input.metricCommand.trim(),
    metricRegex: input.metricRegex?.trim() || undefined,
    metricUnit: input.metricUnit?.trim() || undefined,
    direction: input.direction,
    targetValue: input.targetValue,
    deliveryMode,
    stagingBranch: deliveryMode === "staging_branch" ? `super-work/campaign/${id}` : undefined,
    allowedPaths:
      input.allowedPaths && input.allowedPaths.length > 0
        ? input.allowedPaths.map((s) => s.trim()).filter(Boolean)
        : ["**"],
    template: input.template ?? "fast",
    preferredEngine: input.preferredEngine,
    maxIterations: Math.max(1, Math.min(30, Math.floor(input.maxIterations ?? 5))),
    completedWaves: 0,
    maxTotalBudgetUsd: Math.max(0.5, Number(input.maxTotalBudgetUsd ?? 5.0)),
    totalCostUsd: 0,
    consecutiveNoImproveCount: 0,
    status: "idle",
    createdAt: ts,
    updatedAt: ts,
  };
  await ctx.stateStore.saveCampaign(campaign);
  ctx.emitEvent({ type: "campaign_updated", repoId: repo.id, campaign, timestamp: ts });

  if (input.autoStart) {
    return startCampaignOp(ctx, campaign.id);
  }
  return campaign;
}

async function dispatchNextWaveOp(
  ctx: KernelCoordinatorContext,
  campaign: GoalCampaign,
  repo: RepoConfig,
  extraGuidance?: string,
): Promise<GoalCampaign> {
  const waves = (await ctx.stateStore.listCampaignWaves?.(campaign.id)) ?? [];
  const nextWaveNumber = campaign.completedWaves + 1;
  const preProbe = ctx.workspace.runRepoPreProbe
    ? await ctx.workspace
        .runRepoPreProbe(repo.rootPath, campaign.goalPrompt, repo.forbiddenPaths)
        .catch(() => undefined)
    : undefined;

  let prompt = buildCampaignWavePrompt({
    campaign,
    waveNumber: nextWaveNumber,
    waves,
    preProbeSummary: preProbe?.deterministicSummary,
  });
  if (extraGuidance?.trim()) {
    prompt = `${prompt}\n\n## Human Guidance\n${extraGuidance.trim()}`;
  }

  const remainingBudget = Math.max(0.25, campaign.maxTotalBudgetUsd - campaign.totalCostUsd);
  const waveBudget = Number(Math.min(2.0, remainingBudget).toFixed(4));
  const targetBranch =
    campaign.deliveryMode === "staging_branch"
      ? (campaign.stagingBranch ?? `super-work/campaign/${campaign.id}`)
      : repo.baseBranch;

  const ticket = await ctx.createDirectTicket({
    repoId: repo.id,
    title: `[Campaign W${nextWaveNumber}] ${campaign.name}`,
    description: prompt,
    template: campaign.template,
    preferredEngine: campaign.preferredEngine,
    allowedPaths: campaign.allowedPaths,
    maxCostUsd: waveBudget,
    startPoint: targetBranch,
    targetBranch,
    campaignId: campaign.id,
    campaignWave: nextWaveNumber,
    threadKey: `campaign:${campaign.id}:w${nextWaveNumber}:${Date.now().toString(36)}`,
  });

  const ts = nowIso();
  const wave: GoalCampaignWave = {
    id: newId("wav"),
    campaignId: campaign.id,
    repoId: repo.id,
    waveNumber: nextWaveNumber,
    ticketId: ticket.id,
    status: "running",
    beforeValue: campaign.currentValue ?? campaign.baselineValue ?? 0,
    costUsd: 0,
    summary: `Wave ${nextWaveNumber} queued (${ticket.id})`,
    startedAt: ts,
  };
  await ctx.stateStore.saveCampaignWave?.(wave);

  const running: GoalCampaign = {
    ...campaign,
    status: "running",
    activeTicketId: ticket.id,
    pauseReason: undefined,
    updatedAt: ts,
  };
  await ctx.stateStore.saveCampaign?.(running);
  ctx.emitEvent({
    type: "campaign_updated",
    repoId: repo.id,
    campaign: running,
    wave,
    timestamp: ts,
  });
  return running;
}

export async function startCampaignOp(
  ctx: KernelCoordinatorContext,
  campaignId: string,
  options?: { note?: string },
): Promise<GoalCampaign> {
  if (!ctx.stateStore.getCampaign || !ctx.stateStore.saveCampaign) {
    throw new Error("Configured StateStore does not support Goal Campaigns.");
  }
  const existing = await ctx.stateStore.getCampaign(campaignId);
  if (!existing) {
    throw new Error(`Goal campaign not found: ${campaignId}`);
  }
  if (existing.status === "delivered" || existing.status === "completed") {
    return existing;
  }
  const repo = await ctx.stateStore.getRepo(existing.repoId);
  if (!repo) {
    throw new Error(`Repository not found: ${existing.repoId}`);
  }

  if (existing.status === "running" && existing.activeTicketId) {
    const activeTicket = await ctx.stateStore.getTicket(existing.activeTicketId);
    if (activeTicket && !isTerminalTicketStatus(activeTicket.status)) {
      return existing;
    }
  }

  let current: GoalCampaign = {
    ...existing,
    consecutiveNoImproveCount: existing.status === "paused" ? 0 : existing.consecutiveNoImproveCount,
  };

  if (current.deliveryMode === "staging_branch") {
    const stagingBranch = current.stagingBranch ?? `super-work/campaign/${current.id}`;
    await ctx.workspace.ensureBranch(repo.rootPath, stagingBranch, repo.baseBranch);
    const baseCommit =
      current.lastGoodCommitSha ??
      (ctx.workspace.getHeadCommitSha
        ? await ctx.workspace.getHeadCommitSha(repo.rootPath, stagingBranch)
        : undefined);
    current = {
      ...current,
      stagingBranch,
      lastGoodCommitSha: baseCommit,
    };
  }

  const targetRef =
    current.deliveryMode === "staging_branch"
      ? (current.stagingBranch ?? repo.baseBranch)
      : repo.baseBranch;

  if (current.baselineValue === undefined || current.currentValue === undefined) {
    const baseline = await measureMetricValue(ctx, repo, current, targetRef);
    const ts = nowIso();
    if (!baseline.ok || baseline.value === null) {
      const failed: GoalCampaign = {
        ...current,
        status: "failed",
        pauseReason: baseline.error ?? "Baseline metric measurement failed",
        updatedAt: ts,
      };
      await ctx.stateStore.saveCampaign(failed);
      ctx.emitEvent({ type: "campaign_updated", repoId: repo.id, campaign: failed, timestamp: ts });
      return failed;
    }
    current = {
      ...current,
      baselineValue: baseline.value,
      currentValue: baseline.value,
      updatedAt: ts,
    };
  }

  if (isCampaignTargetMet(current.currentValue!, current.targetValue, current.direction)) {
    const ts = nowIso();
    const completed: GoalCampaign = {
      ...current,
      status: "completed",
      activeTicketId: undefined,
      pauseReason: undefined,
      updatedAt: ts,
    };
    await ctx.stateStore.saveCampaign(completed);
    ctx.emitEvent({ type: "campaign_updated", repoId: repo.id, campaign: completed, timestamp: ts });
    return completed;
  }

  if (current.completedWaves >= current.maxIterations) {
    return pauseCampaignWithInbox(
      ctx,
      current,
      `Max iterations reached (${current.completedWaves}/${current.maxIterations}) before hitting target ${current.targetValue}`,
    );
  }
  if (current.totalCostUsd >= current.maxTotalBudgetUsd) {
    return pauseCampaignWithInbox(
      ctx,
      current,
      `Total campaign budget reached ($${current.totalCostUsd.toFixed(2)} / $${current.maxTotalBudgetUsd.toFixed(2)})`,
    );
  }

  return dispatchNextWaveOp(ctx, current, repo, options?.note);
}

export async function pauseCampaignOp(
  ctx: KernelCoordinatorContext,
  campaignId: string,
  reason = "Paused by user",
): Promise<GoalCampaign> {
  if (!ctx.stateStore.getCampaign || !ctx.stateStore.saveCampaign) {
    throw new Error("Configured StateStore does not support Goal Campaigns.");
  }
  const campaign = await ctx.stateStore.getCampaign(campaignId);
  if (!campaign) {
    throw new Error(`Goal campaign not found: ${campaignId}`);
  }
  const ts = nowIso();
  const paused: GoalCampaign = {
    ...campaign,
    status: "paused",
    pauseReason: reason,
    updatedAt: ts,
  };
  await ctx.stateStore.saveCampaign(paused);
  ctx.emitEvent({ type: "campaign_updated", repoId: paused.repoId, campaign: paused, timestamp: ts });
  return paused;
}

export async function onCampaignTicketSettledOp(
  ctx: KernelCoordinatorContext,
  ticket: Ticket,
  repo: RepoConfig,
): Promise<void> {
  if (!ticket.campaignId || !ctx.stateStore.getCampaign || !ctx.stateStore.saveCampaign) return;
  const campaign = await ctx.stateStore.getCampaign(ticket.campaignId);
  if (!campaign) return;
  if (campaign.activeTicketId !== ticket.id) return;
  if (campaign.status !== "running" && campaign.status !== "paused") return;

  const waves = (await ctx.stateStore.listCampaignWaves?.(campaign.id)) ?? [];
  const runningWave = [...waves]
    .reverse()
    .find((w) => w.ticketId === ticket.id && w.status === "running");
  if (!runningWave) return;

  const ts = nowIso();
  const targetRef =
    campaign.deliveryMode === "staging_branch"
      ? (campaign.stagingBranch ?? repo.baseBranch)
      : repo.baseBranch;

  const newTotalCost = Number((campaign.totalCostUsd + ticket.costUsd).toFixed(4));
  const completedWaves = campaign.completedWaves + 1;

  if (ticket.status !== "delivered") {
    if (
      campaign.deliveryMode === "staging_branch" &&
      campaign.stagingBranch &&
      campaign.lastGoodCommitSha &&
      ctx.workspace.resetBranchRef
    ) {
      await ctx.workspace
        .resetBranchRef(repo.rootPath, campaign.stagingBranch, campaign.lastGoodCommitSha)
        .catch(() => {});
    }
    const failedWave: GoalCampaignWave = {
      ...runningWave,
      status: "failed",
      costUsd: ticket.costUsd,
      rolledBack: campaign.deliveryMode === "staging_branch",
      summary: ticket.errorMessage || `Wave ended with status ${ticket.status}`,
      completedAt: ts,
    };
    await ctx.stateStore.saveCampaignWave?.(failedWave);

    if (ticket.status === "cancelled" || campaign.status === "paused") {
      const paused: GoalCampaign = {
        ...campaign,
        completedWaves,
        totalCostUsd: newTotalCost,
        activeTicketId: undefined,
        status: "paused",
        pauseReason: ticket.errorMessage || "Paused / cancelled by user",
        updatedAt: ts,
      };
      await ctx.stateStore.saveCampaign(paused);
      ctx.emitEvent({
        type: "campaign_updated",
        repoId: repo.id,
        campaign: paused,
        wave: failedWave,
        timestamp: ts,
      });
      return;
    }

    const nextNoImprove = campaign.consecutiveNoImproveCount + 1;
    const updated: GoalCampaign = {
      ...campaign,
      completedWaves,
      totalCostUsd: newTotalCost,
      consecutiveNoImproveCount: nextNoImprove,
      activeTicketId: undefined,
      updatedAt: ts,
    };

    if (nextNoImprove >= 2) {
      await pauseCampaignWithInbox(
        ctx,
        updated,
        `Plateau reached: 2 consecutive waves failed/did not improve metric (last: ${failedWave.summary})`,
        ticket.id,
      );
      return;
    }
    if (completedWaves >= updated.maxIterations) {
      await pauseCampaignWithInbox(
        ctx,
        updated,
        `Max iterations reached (${completedWaves}/${updated.maxIterations})`,
        ticket.id,
      );
      return;
    }
    if (newTotalCost >= updated.maxTotalBudgetUsd) {
      await pauseCampaignWithInbox(
        ctx,
        updated,
        `Total campaign budget reached ($${newTotalCost.toFixed(2)} / $${updated.maxTotalBudgetUsd.toFixed(2)})`,
        ticket.id,
      );
      return;
    }
    await dispatchNextWaveOp(ctx, updated, repo);
    return;
  }

  // Wave child ticket delivered onto staging branch or baseBranch -> measure metric!
  const measurement = await measureMetricValue(ctx, repo, campaign, targetRef);
  const headSha = ctx.workspace.getHeadCommitSha
    ? await ctx.workspace.getHeadCommitSha(repo.rootPath, targetRef).catch(() => undefined)
    : undefined;

  if (!measurement.ok || measurement.value === null) {
    let rolledBack = false;
    if (
      campaign.deliveryMode === "staging_branch" &&
      campaign.stagingBranch &&
      campaign.lastGoodCommitSha &&
      ctx.workspace.resetBranchRef
    ) {
      await ctx.workspace.resetBranchRef(
        repo.rootPath,
        campaign.stagingBranch,
        campaign.lastGoodCommitSha,
      );
      rolledBack = true;
    }
    const failWave: GoalCampaignWave = {
      ...runningWave,
      status: "failed",
      commitSha: headSha,
      rolledBack,
      costUsd: ticket.costUsd,
      summary: measurement.error || "Metric command failed or emitted no number",
      completedAt: ts,
    };
    await ctx.stateStore.saveCampaignWave?.(failWave);
    const nextNoImprove = campaign.consecutiveNoImproveCount + 1;
    const updated: GoalCampaign = {
      ...campaign,
      completedWaves,
      totalCostUsd: newTotalCost,
      consecutiveNoImproveCount: nextNoImprove,
      activeTicketId: undefined,
      updatedAt: ts,
    };
    if (nextNoImprove >= 2) {
      await pauseCampaignWithInbox(ctx, updated, `Plateau reached (${failWave.summary})`, ticket.id);
      return;
    }
    if (completedWaves >= updated.maxIterations) {
      await pauseCampaignWithInbox(
        ctx,
        updated,
        `Max iterations reached (${completedWaves}/${updated.maxIterations})`,
        ticket.id,
      );
      return;
    }
    if (newTotalCost >= updated.maxTotalBudgetUsd) {
      await pauseCampaignWithInbox(
        ctx,
        updated,
        `Total campaign budget reached ($${newTotalCost.toFixed(2)} / $${updated.maxTotalBudgetUsd.toFixed(2)})`,
        ticket.id,
      );
      return;
    }
    await dispatchNextWaveOp(ctx, updated, repo);
    return;
  }

  const measured = measurement.value;
  const evalDelta = evaluateMetricDelta(runningWave.beforeValue, measured, campaign.direction);

  let nextGoodSha = campaign.lastGoodCommitSha;
  let nextCurrentValue = campaign.currentValue ?? runningWave.beforeValue;
  let nextNoImprove = campaign.consecutiveNoImproveCount;
  let rolledBack = false;

  if (evalDelta.outcome === "improved") {
    nextGoodSha = headSha ?? campaign.lastGoodCommitSha;
    nextCurrentValue = measured;
    nextNoImprove = 0;
  } else {
    nextNoImprove += 1;
    if (
      campaign.deliveryMode === "staging_branch" &&
      campaign.stagingBranch &&
      campaign.lastGoodCommitSha &&
      ctx.workspace.resetBranchRef
    ) {
      await ctx.workspace.resetBranchRef(
        repo.rootPath,
        campaign.stagingBranch,
        campaign.lastGoodCommitSha,
      );
      rolledBack = true;
    }
  }

  const finishedWave: GoalCampaignWave = {
    ...runningWave,
    status: evalDelta.outcome,
    measuredValue: measured,
    delta: evalDelta.delta,
    commitSha: headSha,
    rolledBack,
    costUsd: ticket.costUsd,
    summary:
      evalDelta.outcome === "improved"
        ? `Metric improved ${runningWave.beforeValue} -> ${measured} (delta ${evalDelta.delta > 0 ? "+" : ""}${evalDelta.delta})`
        : evalDelta.outcome === "regressed"
          ? `Metric regressed ${runningWave.beforeValue} -> ${measured}; ${rolledBack ? "rolled back staging branch" : "flagged regressed"}`
          : `Metric unchanged at ${measured}${rolledBack ? "; reset staging branch" : ""}`,
    completedAt: ts,
  };
  await ctx.stateStore.saveCampaignWave?.(finishedWave);

  const nextCampaign: GoalCampaign = {
    ...campaign,
    currentValue: nextCurrentValue,
    lastGoodCommitSha: nextGoodSha,
    completedWaves,
    totalCostUsd: newTotalCost,
    consecutiveNoImproveCount: nextNoImprove,
    activeTicketId: undefined,
    updatedAt: ts,
  };

  ctx.emitEvent({
    type: "campaign_updated",
    repoId: repo.id,
    campaign: nextCampaign,
    wave: finishedWave,
    timestamp: ts,
  });

  if (campaign.status === "paused") {
    await ctx.stateStore.saveCampaign({ ...nextCampaign, status: "paused" });
    return;
  }

  if (isCampaignTargetMet(nextCurrentValue, campaign.targetValue, campaign.direction)) {
    const completed: GoalCampaign = {
      ...nextCampaign,
      status: "completed",
      pauseReason: undefined,
      updatedAt: nowIso(),
    };
    await ctx.stateStore.saveCampaign(completed);
    ctx.emitEvent({
      type: "campaign_updated",
      repoId: repo.id,
      campaign: completed,
      timestamp: completed.updatedAt,
    });
    return;
  }

  if (nextNoImprove >= 2) {
    await pauseCampaignWithInbox(
      ctx,
      nextCampaign,
      `Plateau reached: ${nextNoImprove} consecutive waves without improvement (current=${nextCurrentValue}, target=${campaign.targetValue})`,
      ticket.id,
    );
    return;
  }
  if (completedWaves >= nextCampaign.maxIterations) {
    await pauseCampaignWithInbox(
      ctx,
      nextCampaign,
      `Max iterations reached (${completedWaves}/${nextCampaign.maxIterations}) before target ${campaign.targetValue}`,
      ticket.id,
    );
    return;
  }
  if (newTotalCost >= nextCampaign.maxTotalBudgetUsd) {
    await pauseCampaignWithInbox(
      ctx,
      nextCampaign,
      `Total campaign budget reached ($${newTotalCost.toFixed(2)} / $${nextCampaign.maxTotalBudgetUsd.toFixed(2)})`,
      ticket.id,
    );
    return;
  }

  await dispatchNextWaveOp(ctx, nextCampaign, repo);
}

export async function deliverCampaignOp(
  ctx: KernelCoordinatorContext,
  campaignId: string,
  action: "local_merge" | "push_and_create_pr" = "local_merge",
): Promise<GoalCampaign> {
  if (!ctx.stateStore.getCampaign || !ctx.stateStore.saveCampaign) {
    throw new Error("Configured StateStore does not support Goal Campaigns.");
  }
  const campaign = await ctx.stateStore.getCampaign(campaignId);
  if (!campaign) {
    throw new Error(`Goal campaign not found: ${campaignId}`);
  }
  if (campaign.status === "delivered") {
    return campaign;
  }
  const repo = await ctx.stateStore.getRepo(campaign.repoId);
  if (!repo) {
    throw new Error(`Repository not found: ${campaign.repoId}`);
  }

  const ts = nowIso();
  if (campaign.deliveryMode === "per_wave_merge" || !campaign.stagingBranch) {
    const delivered: GoalCampaign = {
      ...campaign,
      status: "delivered",
      pauseReason: undefined,
      updatedAt: ts,
    };
    await ctx.stateStore.saveCampaign(delivered);
    ctx.emitEvent({ type: "campaign_updated", repoId: repo.id, campaign: delivered, timestamp: ts });
    return delivered;
  }

  const syntheticTicket: Ticket = {
    id: campaign.activeTicketId ?? `cmp_tkt_${campaign.id}`,
    repoId: repo.id,
    threadId: `thr_${campaign.id}`,
    sourceTriggerId: `trg_${campaign.id}`,
    title: `Campaign: ${campaign.name}`,
    description: campaign.goalPrompt,
    status: "outbox_pending",
    template: campaign.template,
    currentStage: "rebase",
    stageRetries: 0,
    mandate: createDefaultMandate({ allowedPaths: campaign.allowedPaths }),
    dependsOn: [],
    branchName: campaign.stagingBranch,
    nativeSessions: {},
    inlineMemory: {
      goal: campaign.goalPrompt,
      acceptanceCriteria: [],
      stageNotes: [],
      threadUpdates: [],
    },
    costUsd: campaign.totalCostUsd,
    priority: 1,
    createdAt: campaign.createdAt,
    updatedAt: ts,
  };

  // Run pre_deliver hook on stagingBranch via detached worktree before merging/PR
  if ((repo.hooks?.preDeliver?.length ?? 0) > 0 && ctx.workspace.prepareDetachedWorktree) {
    const detached = await ctx.workspace.prepareDetachedWorktree(
      repo.rootPath,
      campaign.stagingBranch,
      `hook_${campaign.id}`,
    );
    try {
      const hookRec = await executeLifecycleHookOp(ctx, "pre_deliver", syntheticTicket, repo, {
        cwd: detached.worktreePath,
      });
      if (!hookRec.ok) {
        throw new Error(`pre_deliver hook blocked campaign delivery: ${hookRec.summary}`);
      }
    } finally {
      await ctx.workspace.cleanupWorkspace(detached.worktreePath, repo.rootPath).catch(() => {});
    }
  } else if ((repo.hooks?.preDeliver?.length ?? 0) > 0) {
    const hookRec = await executeLifecycleHookOp(ctx, "pre_deliver", syntheticTicket, repo, {
      cwd: repo.rootPath,
    });
    if (!hookRec.ok) {
      throw new Error(`pre_deliver hook blocked campaign delivery: ${hookRec.summary}`);
    }
  }

  let deliveredCommitSha: string | undefined;
  let deliveredPrUrl: string | undefined;

  if (action === "local_merge") {
    const mergeRes = await ctx.runWithRepoWorkspaceLock(repo.id, () =>
      ctx.workspace.mergeBranchToBase({
        rootRepoPath: repo.rootPath,
        baseBranch: repo.baseBranch,
        branchName: campaign.stagingBranch!,
        commitMessage: `campaign(${campaign.id}): ${campaign.name} (${campaign.baselineValue ?? "?"} -> ${campaign.currentValue ?? "?"})`,
        deleteBranch: true,
        noFf: true,
      }),
    );
    deliveredCommitSha = mergeRes.commitSha;
  } else {
    const res = await ctx.outboxExecutor.execute(
      {
        id: newId("obx"),
        repoId: repo.id,
        ticketId: syntheticTicket.id,
        action: "push_and_create_pr",
        idempotencyKey: `campaign:${campaign.id}:pr`,
        payload: {
          title: `[Campaign] ${campaign.name}`,
          branchName: campaign.stagingBranch,
          forceGithubPr: true,
          summary: `Goal Campaign metric improved: ${campaign.baselineValue ?? "?"} -> ${campaign.currentValue ?? "?"} (target: ${campaign.targetValue})`,
        },
        status: "processing",
        attempts: 0,
        nextAttemptAt: ts,
        createdAt: ts,
        updatedAt: ts,
      },
      repo,
      syntheticTicket,
    );
    deliveredPrUrl = typeof res.prUrl === "string" ? res.prUrl : undefined;
  }

  const delivered: GoalCampaign = {
    ...campaign,
    status: "delivered",
    pauseReason: undefined,
    activeTicketId: undefined,
    deliveredCommitSha,
    deliveredPrUrl,
    updatedAt: nowIso(),
  };
  await ctx.stateStore.saveCampaign(delivered);
  ctx.emitEvent({
    type: "campaign_updated",
    repoId: repo.id,
    campaign: delivered,
    timestamp: delivered.updatedAt,
  });

  await executeLifecycleHookOp(ctx, "post_deliver", syntheticTicket, repo, {
    cwd: repo.rootPath,
  }).catch(() => {});

  return delivered;
}

export async function deleteCampaignOp(
  ctx: KernelCoordinatorContext,
  campaignId: string,
): Promise<boolean> {
  if (!ctx.stateStore.getCampaign || !ctx.stateStore.deleteCampaign) return false;
  const existing = await ctx.stateStore.getCampaign(campaignId);
  if (!existing) return false;
  const deleted = await ctx.stateStore.deleteCampaign(campaignId);
  if (deleted) {
    if (existing.stagingBranch && existing.status !== "delivered") {
      const repo = await ctx.stateStore.getRepo(existing.repoId);
      if (repo) {
        await ctx.workspace.deleteBranch?.(repo.rootPath, existing.stagingBranch).catch(() => {});
      }
    }
    ctx.emitEvent({
      type: "campaign_updated",
      repoId: existing.repoId,
      deletedId: campaignId,
      timestamp: nowIso(),
    });
  }
  return deleted;
}
