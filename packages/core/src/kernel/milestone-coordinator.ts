import { buildRunDigestReport } from "../digest.ts";
import {
  type PlannedMilestoneItem,
  planMilestoneWaves,
  synthesizeMilestoneReleaseNotes,
} from "../milestone.ts";
import type {
  EnginePreference,
  GoalCampaign,
  InboxItem,
  Milestone,
  MilestoneItem,
  MilestoneIntegrationMode,
  PipelineTemplateId,
  RequirementIntakePlan,
  RequirementRouteKind,
  Ticket,
} from "../types.ts";
import { newId, nowIso } from "../utils.ts";
import type { KernelCoordinatorContext } from "./context.ts";
import { maybeVerifyAndReloadSelfHostMilestoneOp } from "./self-host-coordinator.ts";

const MAX_MILESTONE_ITEMS = 20;

export interface CreateMilestoneInput {
  repoId: string;
  name: string;
  targetVersion?: string;
  requirements: string[];
  preferredEngine?: EnginePreference;
  template?: PipelineTemplateId;
  maxBudgetUsdPerItem?: number;
  preferredRoute?: "auto" | RequirementRouteKind;
  integrationMode?: MilestoneIntegrationMode;
}

export interface ReleaseMilestoneOptions {
  bumpVersion?: boolean;
  createTag?: boolean;
  pushRemote?: boolean;
  squashReleaseCommit?: boolean;
  releaseCommitMessage?: string;
  /** Optional GitHub Release (requires createTag + pushRemote). Default false. */
  createGithubRelease?: boolean;
}

function requireMilestoneStore(ctx: KernelCoordinatorContext) {
  const { saveMilestone, getMilestone, listMilestones } = ctx.stateStore;
  if (!saveMilestone || !getMilestone || !listMilestones) {
    throw new Error("State store does not support milestones");
  }
  return {
    save: saveMilestone.bind(ctx.stateStore),
    get: getMilestone.bind(ctx.stateStore),
    list: listMilestones.bind(ctx.stateStore),
  };
}

function planAllowedPaths(plan: RequirementIntakePlan): string[] {
  if (plan.route === "single_ticket") return plan.singleSpec?.allowedPaths ?? [];
  if (plan.route === "goal_campaign") return plan.campaignSpec?.allowedPaths ?? [];
  return Array.from(new Set((plan.epicPlan?.subtasks ?? []).flatMap((s) => s.allowedPaths)));
}

function upstreamId(item: MilestoneItem): string | undefined {
  return item.epicId ?? item.ticketId;
}

async function persist(ctx: KernelCoordinatorContext, milestone: Milestone): Promise<Milestone> {
  const next: Milestone = { ...milestone, updatedAt: nowIso() };
  await requireMilestoneStore(ctx).save(next);
  ctx.emitEvent({
    type: "milestone_updated",
    repoId: next.repoId,
    milestone: next,
    timestamp: next.updatedAt,
  });
  return next;
}

/** Dispatch a single item (creating its ticket / epic / campaign) once its upstream IDs exist. */
async function dispatchItem(
  ctx: KernelCoordinatorContext,
  milestone: Milestone,
  item: MilestoneItem,
  plan: RequirementIntakePlan,
  opts: {
    template?: PipelineTemplateId;
    preferredEngine?: EnginePreference;
    maxBudgetUsdPerItem?: number;
  },
): Promise<MilestoneItem> {
  const stagingBranch =
    milestone.integrationMode === "milestone_branch" ? milestone.stagingBranch : undefined;
  const deps = item.dependsOnIndices
    .map((i) => milestone.items[i])
    .map((d) => (d ? upstreamId(d) : undefined))
    .filter((id): id is string => Boolean(id));

  if (plan.route === "goal_campaign" && plan.campaignSpec) {
    const spec = plan.campaignSpec;
    const campaign: GoalCampaign = await ctx.createCampaign({
      repoId: milestone.repoId,
      name: spec.name,
      goalPrompt: spec.goalPrompt,
      metricCommand: spec.metricCommand,
      metricRegex: spec.metricRegex,
      metricUnit: spec.metricUnit,
      direction: spec.direction,
      targetValue: spec.targetValue,
      deliveryMode: spec.deliveryMode,
      allowedPaths: spec.allowedPaths,
      template: opts.template ?? "standard",
      preferredEngine: opts.preferredEngine,
      maxIterations: spec.maxIterations,
      maxTotalBudgetUsd: opts.maxBudgetUsdPerItem ?? spec.maxTotalBudgetUsd,
      autoStart: true,
    });
    return { ...item, campaignId: campaign.id, title: plan.title, status: "running" };
  }

  if (plan.route === "epic_dag" && plan.epicPlan) {
    const { epic, subtasks } = await ctx.createEpic({
      repoId: milestone.repoId,
      title: plan.title,
      description: item.requirement,
      template: opts.template,
      epicDeliveryMode: plan.epicPlan.epicDeliveryMode,
      releaseBarrier: plan.epicPlan.releaseBarrier,
      preferredEngine: opts.preferredEngine,
      maxCostUsdPerSubtask: opts.maxBudgetUsdPerItem,
      subtasks: plan.epicPlan.subtasks,
    });
    await ctx.stateStore.saveTicket({ ...epic, milestoneId: milestone.id });
    for (const sub of subtasks) {
      const mergedDeps = Array.from(new Set([...sub.dependsOn, ...deps]));
      const gated = deps.length > 0 && sub.status === "queued";
      const patched: Ticket = {
        ...sub,
        milestoneId: milestone.id,
        dependsOn: mergedDeps,
        status: gated ? "waiting_deps" : sub.status,
        ...(stagingBranch
          ? { targetBranch: stagingBranch, deliveryGatePolicy: "always_auto" as const }
          : {}),
        updatedAt: nowIso(),
      };
      await ctx.stateStore.saveTicket(patched);
    }
    return { ...item, epicId: epic.id, title: plan.title, status: "pending" };
  }

  const single = plan.singleSpec;
  if (!single) throw new Error(`Milestone item ${item.index} has no dispatchable plan`);
  const ticket = await ctx.createDirectTicket({
    repoId: milestone.repoId,
    title: plan.title,
    description: single.description,
    template: opts.template ?? single.template,
    tddMode: single.tddMode,
    allowedPaths: single.allowedPaths,
    acceptanceCriteria: single.acceptanceCriteria,
    preferredEngine: opts.preferredEngine,
    maxCostUsd: opts.maxBudgetUsdPerItem,
    dependsOn: deps,
    milestoneId: milestone.id,
    ...(single.refactorGuard ? { refactorGuard: single.refactorGuard } : {}),
    ...(stagingBranch
      ? {
          targetBranch: stagingBranch,
          startPoint: stagingBranch,
          deliveryGatePolicy: "always_auto" as const,
        }
      : {}),
  });
  return { ...item, ticketId: ticket.id, title: plan.title, status: "pending" };
}

export async function createMilestoneOp(
  ctx: KernelCoordinatorContext,
  input: CreateMilestoneInput,
): Promise<Milestone> {
  const store = requireMilestoneStore(ctx);
  const repo = await ctx.stateStore.getRepo(input.repoId);
  if (!repo) throw new Error(`Repository not found: ${input.repoId}`);
  const name = input.name?.trim();
  if (!name) throw new Error("Milestone name is required");
  const requirements = (input.requirements ?? []).map((r) => String(r).trim()).filter(Boolean);
  if (requirements.length === 0) throw new Error("Milestone requires at least one requirement");
  if (requirements.length > MAX_MILESTONE_ITEMS) {
    throw new Error(`Milestone supports at most ${MAX_MILESTONE_ITEMS} requirements`);
  }

  const opts = {
    template: input.template,
    preferredEngine: input.preferredEngine,
    maxBudgetUsdPerItem: input.maxBudgetUsdPerItem,
  };

  const plans: RequirementIntakePlan[] = [];
  for (const requirement of requirements) {
    plans.push(
      await ctx.previewRequirementIntake({
        repoId: input.repoId,
        requirement,
        template: input.template,
        preferredEngine: input.preferredEngine,
        maxBudgetUsd: input.maxBudgetUsdPerItem,
        preferredRoute: input.preferredRoute,
        previewOnly: true,
      }),
    );
  }

  const planned: PlannedMilestoneItem[] = requirements.map((requirement, index) => ({
    id: newId("msi"),
    index,
    requirement,
    title: plans[index]!.title,
    route: plans[index]!.route,
    allowedPaths: planAllowedPaths(plans[index]!),
    ...(plans[index]!.singleSpec?.refactorGuard
      ? { refactorGuard: plans[index]!.singleSpec!.refactorGuard }
      : {}),
  }));

  const ts = nowIso();
  const milestoneId = newId("mst");
  const integrationMode: MilestoneIntegrationMode =
    input.integrationMode === "milestone_branch" ? "milestone_branch" : "direct_main";
  const stagingBranch =
    integrationMode === "milestone_branch" ? `super-work/milestone/${milestoneId}` : undefined;
  if (stagingBranch) {
    if (ctx.workspace.ensureBranchExists) {
      await ctx.workspace.ensureBranchExists({
        rootRepoPath: repo.rootPath,
        branchName: stagingBranch,
        baseBranch: repo.baseBranch,
      });
    } else {
      await ctx.workspace.ensureBranch(repo.rootPath, stagingBranch, repo.baseBranch);
    }
  }
  let milestone: Milestone = {
    id: milestoneId,
    repoId: input.repoId,
    name,
    targetVersion: input.targetVersion?.trim().replace(/^v/i, "") || undefined,
    integrationMode,
    stagingBranch,
    status: "active",
    items: planMilestoneWaves(planned),
    createdAt: ts,
    updatedAt: ts,
  };
  await store.save(milestone);

  // Dispatch every item whose upstream dependencies are plain tickets/epics now (cross-wave
  // dependsOn gates Wave 1+). Items depending on a goal campaign are dispatched by sync.
  for (const item of milestone.items) {
    const blockedByCampaign = item.dependsOnIndices.some(
      (i) => milestone.items[i]?.route === "goal_campaign",
    );
    if (blockedByCampaign) continue;
    const dispatched = await dispatchItem(ctx, milestone, item, plans[item.index]!, opts);
    milestone = {
      ...milestone,
      items: milestone.items.map((i) => (i.index === item.index ? dispatched : i)),
    };
    await store.save(milestone);
  }

  return persist(ctx, milestone);
}

function mapTicketStatus(ticket: Ticket | null): MilestoneItem["status"] {
  if (!ticket) return "failed";
  switch (ticket.status) {
    case "delivered":
      return "delivered";
    case "failed":
    case "cancelled":
      return "failed";
    case "needs_human":
      return "needs_human";
    case "triaging":
    case "proposed":
    case "queued":
    case "waiting_deps":
      return "pending";
    default:
      return "running";
  }
}

function mapCampaignStatus(campaign: GoalCampaign | null): MilestoneItem["status"] {
  if (!campaign) return "failed";
  switch (campaign.status) {
    case "delivered":
      return "delivered";
    case "failed":
      return "failed";
    case "paused":
      return "needs_human";
    case "idle":
      return "pending";
    default:
      return "running";
  }
}

async function collectMilestoneTickets(
  ctx: KernelCoordinatorContext,
  milestone: Milestone,
): Promise<Ticket[]> {
  const all = await ctx.stateStore.listTickets({ repoId: milestone.repoId });
  const rootIds = new Set(milestone.items.map(upstreamId).filter((id): id is string => !!id));
  return all.filter(
    (t) => t.milestoneId === milestone.id || rootIds.has(t.id) || (t.parentTicketId && rootIds.has(t.parentTicketId)),
  );
}

async function markMilestoneReady(
  ctx: KernelCoordinatorContext,
  milestone: Milestone,
): Promise<Milestone> {
  const tickets = await collectMilestoneTickets(ctx, milestone);
  const stageRuns = (await Promise.all(tickets.map((t) => ctx.stateStore.listStageRuns(t.id)))).flat();
  const flightEvents =
    (await ctx.stateStore.listFlightEvents?.({ repoId: milestone.repoId, limit: 500 })) ?? [];
  const digest = buildRunDigestReport({
    repoId: milestone.repoId,
    windowHours: 0,
    tickets,
    stageRuns,
    flightEvents,
  });
  const notes = synthesizeMilestoneReleaseNotes({ milestone, tickets, digest });
  const ready = await persist(ctx, {
    ...milestone,
    ...notes,
    status: "ready_to_release",
  });

  await ctx.recordFlightEvent?.({
    repoId: ready.repoId,
    kind: "milestone_ready",
    summary: `Milestone ${ready.name}${ready.targetVersion ? ` v${ready.targetVersion}` : ""} ready to release (${notes.digestSummary})`,
    metadata: { milestoneId: ready.id, targetVersion: ready.targetVersion },
  });

  const pending = await ctx.stateStore.listInboxItems({ repoId: ready.repoId, status: "pending" });
  if (!pending.some((i) => i.kind === "milestone_ready" && i.contextPayload?.milestoneId === ready.id)) {
    const ts = nowIso();
    const inboxItem: InboxItem = {
      id: newId("inb"),
      repoId: ready.repoId,
      ticketId: `milestone_${ready.id}`,
      kind: "milestone_ready",
      status: "pending",
      title: `Milestone Ready: ${ready.name}${ready.targetVersion ? ` v${ready.targetVersion}` : ""}`,
      summary: notes.digestSummary,
      contextPayload: {
        milestoneId: ready.id,
        targetVersion: ready.targetVersion,
        releaseNotesEn: ready.releaseNotesEn,
        releaseNotesZh: ready.releaseNotesZh,
      },
      createdAt: ts,
    };
    await ctx.stateStore.saveInboxItem(inboxItem);
    ctx.emitEvent({ type: "inbox_created", item: inboxItem, timestamp: ts });
  }
  return ready;
}

export async function syncMilestonesOp(ctx: KernelCoordinatorContext, repoId: string): Promise<void> {
  if (!ctx.stateStore.listMilestones || !ctx.stateStore.saveMilestone) return;
  const milestones = (await ctx.stateStore.listMilestones(repoId)).filter((m) => m.status === "active");
  for (const original of milestones) {
    let milestone = original;
    const items: MilestoneItem[] = [];
    for (const item of milestone.items) {
      let next = item;
      if (item.campaignId) {
        next = {
          ...item,
          status: mapCampaignStatus((await ctx.stateStore.getCampaign?.(item.campaignId)) ?? null),
        };
      } else if (upstreamId(item)) {
        const ticket = await ctx.stateStore.getTicket(upstreamId(item)!);
        next = {
          ...item,
          status: mapTicketStatus(ticket),
          summary: ticket?.handoverDigest?.summary ?? item.summary,
        };
      }
      items.push(next);
    }

    // Lazily dispatch items that were deferred behind a goal campaign once upstream delivered.
    for (const item of items) {
      if (item.ticketId || item.epicId || item.campaignId) continue;
      const depsDelivered = item.dependsOnIndices.every((i) => items[i]?.status === "delivered");
      if (!depsDelivered) continue;
      try {
        const plan = await ctx.previewRequirementIntake({
          repoId: milestone.repoId,
          requirement: item.requirement,
          previewOnly: true,
        });
        const dispatched = await dispatchItem(ctx, { ...milestone, items }, item, plan, {});
        items[item.index] = dispatched;
      } catch {
        items[item.index] = { ...item, status: "failed" };
      }
    }

    const changed = JSON.stringify(items) !== JSON.stringify(milestone.items);
    milestone = { ...milestone, items };
    if (items.length > 0 && items.every((i) => i.status === "delivered")) {
      await markMilestoneReady(ctx, milestone);
    } else if (changed) {
      await persist(ctx, milestone);
    }
  }
}

/**
 * Explicit release only (REST / CLI / Inbox signoff). Never invoked from the scheduler.
 */
export async function releaseMilestoneOp(
  ctx: KernelCoordinatorContext,
  id: string,
  options: ReleaseMilestoneOptions = {},
): Promise<Milestone> {
  const store = requireMilestoneStore(ctx);
  const milestone = await store.get(id);
  if (!milestone) throw new Error(`Milestone not found: ${id}`);
  if (milestone.status !== "ready_to_release") {
    throw new Error(`Milestone ${id} is ${milestone.status}, expected ready_to_release`);
  }
  const repo = await ctx.stateStore.getRepo(milestone.repoId);
  if (!repo) throw new Error(`Repository not found: ${milestone.repoId}`);
  if (!ctx.workspace.executeMilestoneRelease) {
    throw new Error("Workspace provider does not support milestone release");
  }

  const bumpVersion = Boolean(options.bumpVersion && milestone.targetVersion);
  const createTag = options.createTag === true;
  const pushRemote = options.pushRemote === true;
  const preReleaseSha: string | undefined = ctx.workspace.getHeadCommitSha
    ? await ctx.workspace.getHeadCommitSha(repo.rootPath, repo.baseBranch).catch(() => undefined)
    : undefined;
  const result = await ctx.runWithRepoWorkspaceLock(repo.id, () =>
    ctx.workspace.executeMilestoneRelease!({
      rootRepoPath: repo.rootPath,
      baseBranch: repo.baseBranch,
      targetVersion: milestone.targetVersion,
      bumpVersion,
      createTag,
      pushRemote,
      releaseNotes: milestone.releaseNotesEn,
      stagingBranch: milestone.stagingBranch,
      squashReleaseCommit: options.squashReleaseCommit === true,
      releaseCommitMessage: options.releaseCommitMessage?.trim() || undefined,
      createGithubRelease: options.createGithubRelease === true,
    }),
  );

  const released = await persist(ctx, {
    ...milestone,
    status: "released",
    releasedCommitSha: result.commitSha ?? milestone.releasedCommitSha,
    releasedTag: result.tag ?? milestone.releasedTag,
  });

  await ctx.recordFlightEvent?.({
    repoId: released.repoId,
    kind: "milestone_released",
    summary: `Milestone ${released.name} released${result.tag ? ` as ${result.tag}` : ""}${result.pushed ? " (pushed)" : ""}`,
    metadata: {
      milestoneId: released.id,
      commitSha: result.commitSha,
      tag: result.tag,
      pushed: result.pushed,
      bumpedFiles: result.bumpedFiles,
      githubReleaseUrl: result.githubReleaseUrl,
    },
  });

  const pending = await ctx.stateStore.listInboxItems({ repoId: released.repoId, status: "pending" });
  for (const inbox of pending) {
    if (inbox.kind === "milestone_ready" && inbox.contextPayload?.milestoneId === released.id) {
      const ts = nowIso();
      const resolved: InboxItem = {
        ...inbox,
        status: "approved",
        resolutionNote: "Milestone released",
        resolvedAt: ts,
      };
      await ctx.stateStore.saveInboxItem(resolved);
      ctx.emitEvent({ type: "inbox_resolved", item: resolved, timestamp: ts });
    }
  }

  // Self-host: build + Boot Canary the released commit, then drain & reload (or roll back on failure).
  if (result.commitSha && result.commitSha !== preReleaseSha) {
    await maybeVerifyAndReloadSelfHostMilestoneOp(ctx, repo, {
      milestoneId: released.id,
      milestoneName: released.name,
      commitSha: result.commitSha,
      preReleaseSha,
      targetVersion: released.targetVersion,
    });
  }
  return result.githubReleaseUrl ? { ...released, githubReleaseUrl: result.githubReleaseUrl } : released;
}
