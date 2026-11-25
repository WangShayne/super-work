import { countDiffLines } from "../arena.ts";
import { selectRelevantCasesForContext } from "../casebook.ts";
import { OutboxProcessor } from "../outbox.ts";
import { getPipelineTemplate } from "../pipeline.ts";
import { formatPlaybookContext } from "../playbook.ts";
import type { DirectTicketInput } from "../ports.ts";
import { evaluateTicketRisk } from "../risk.ts";
import { applyClarificationAnswers, buildHeuristicSpecClarification } from "../spec-studio.ts";
import type {
  CasebookEntry,
  InboxItem,
  OutboxAction,
  OutboxEntry,
  PlaybookEntry,
  RepoConfig,
  RequirementIntakeInput,
  RequirementIntakeResult,
  ReviewReport,
  RoutineSpec,
  SmokeCheckResult,
  SpecClarificationInput,
  SpecClarificationResult,
  StageKind,
  SteerTicketInput,
  Ticket,
  TicketCheckpoint,
  WorkerEngineId,
} from "../types.ts";
import { isTerminalTicketStatus, newId, nowIso } from "../utils.ts";
import { onCampaignTicketSettledOp } from "./campaign-coordinator.ts";
import type { KernelCoordinatorContext } from "./context.ts";
import {
  generateAndSaveHandoverDigestOp,
  maybeDistillClosedLoopLessonOp,
  recordDeliveredCasebookEntryOp,
  syncRepoContractOp,
} from "./contract-playbook-coordinator.ts";
import { maybeEvaluateEpicReplanOp } from "./epic-replan-coordinator.ts";
import { executeLifecycleHookOp } from "./lifecycle-hooks.ts";
import { ensureMergeTrainForOutboxOp, flushMergeTrainOp } from "./merge-train-coordinator.ts";
import { handleSelfHostPostMergeOp } from "./self-host-coordinator.ts";
import { getEffectiveBaseInfoOp } from "./kernel-runtime-ops.ts";

async function createDirectTicketSynced(
  ctx: KernelCoordinatorContext,
  input: DirectTicketInput,
): Promise<Ticket> {
  await syncRepoContractOp(ctx, input.repoId);
  return ctx.createDirectTicket(input);
}

export async function onOutboxTicketDeliveredOp(
  ctx: KernelCoordinatorContext,
  getFreshCtx: () => KernelCoordinatorContext,
  deliveredTicket: Ticket,
  repo: RepoConfig,
  entry: OutboxEntry,
) : Promise<void> {
  let currentTicket = deliveredTicket;
  const payloadPrNumber =
    typeof entry.resultPayload?.prNumber === "number" ? entry.resultPayload.prNumber : undefined;
  const payloadPrUrl =
    typeof entry.resultPayload?.prUrl === "string" ? entry.resultPayload.prUrl : undefined;
  const payloadMergeSha =
    entry.action === "local_merge" && typeof entry.resultPayload?.commitSha === "string"
      ? entry.resultPayload.commitSha
      : undefined;

  if (payloadPrNumber || payloadPrUrl || payloadMergeSha) {
    const prTs = nowIso();
    currentTicket = {
      ...currentTicket,
      prNumber: payloadPrNumber ?? currentTicket.prNumber,
      prUrl: payloadPrUrl ?? currentTicket.prUrl,
      mergedCommitSha: payloadMergeSha ?? currentTicket.mergedCommitSha,
      updatedAt: prTs,
    };
    await ctx.stateStore.saveTicket(currentTicket);
    ctx.emitEvent({ type: "ticket_updated", ticket: currentTicket, timestamp: prTs });

    if (repo.githubRepo && currentTicket.prNumber) {
      const prThreadKey = `gh:${repo.githubRepo}:pr:${currentTicket.prNumber}`;
      const existingPrThread = await ctx.stateStore.getThreadByKey(repo.id, prThreadKey);
      await ctx.stateStore.upsertThread({
        id: existingPrThread?.id ?? newId("thr"),
        repoId: repo.id,
        threadKey: prThreadKey,
        subscribedTicketId: currentTicket.id,
        metadata: {
          ...(existingPrThread?.metadata ?? {}),
          source: "github_pr",
          prNumber: currentTicket.prNumber,
          branchName: currentTicket.branchName,
        },
        createdAt: existingPrThread?.createdAt ?? prTs,
        updatedAt: prTs,
      });
    }
  }

  if (!(currentTicket.barrierGroupId && currentTicket.handoverDigest)) {
    currentTicket = await generateAndSaveHandoverDigestOp(
      ctx,
      currentTicket,
      repo,
    );
  }
  await recordDeliveredCasebookEntryOp(ctx, currentTicket);

  if (currentTicket.routineId) {
    const routine = await ctx.stateStore.getRoutine(currentTicket.routineId);
    if (routine && routine.activeTicketId === currentTicket.id) {
      const cleared: RoutineSpec = {
        ...routine,
        activeTicketId: undefined,
        updatedAt: nowIso(),
      };
      await ctx.stateStore.saveRoutine(cleared);
      ctx.emitEvent({
        type: "routine_updated",
        repoId: routine.repoId,
        routine: cleared,
        timestamp: cleared.updatedAt,
      });
    }
  }

  if (currentTicket.parentTicketId) {
    await maybeEvaluateEpicReplanOp(ctx, currentTicket.parentTicketId, currentTicket);
  }

  if (
    currentTicket.worktreePath &&
    (repo.autoCleanupWorktree !== false || entry.action === "local_merge")
  ) {
    await ctx.cleanupTicketWorktree(currentTicket.id);
  }

  // Best-effort post_deliver lifecycle hook
  await executeLifecycleHookOp(ctx, "post_deliver", currentTicket, repo, {
    cwd: entry.action === "local_merge" ? repo.rootPath : currentTicket.worktreePath || repo.rootPath,
  }).catch(() => {});

  if (currentTicket.campaignId) {
    await onCampaignTicketSettledOp(ctx, currentTicket, repo).catch(() => {});
  }

  await handleSelfHostPostMergeOp(getFreshCtx(), currentTicket, repo, entry).catch(
    () => {},
  );
}

export async function intakeRequirementOp(
  ctx: KernelCoordinatorContext,
  input: RequirementIntakeInput,
) : Promise<RequirementIntakeResult> {
  const plan = await ctx.previewRequirementIntake(input);
  if (input.previewOnly) {
    return { route: plan.route, plan };
  }

  if (plan.route === "goal_campaign" && plan.campaignSpec) {
    const cmpSpec = plan.campaignSpec;
    const campaign = await ctx.createCampaign({
      repoId: input.repoId,
      name: cmpSpec.name,
      goalPrompt: cmpSpec.goalPrompt,
      metricCommand: cmpSpec.metricCommand,
      metricRegex: cmpSpec.metricRegex,
      metricUnit: cmpSpec.metricUnit,
      direction: cmpSpec.direction,
      targetValue: cmpSpec.targetValue,
      deliveryMode: cmpSpec.deliveryMode,
      allowedPaths: cmpSpec.allowedPaths,
      template: input.template ?? "standard",
      preferredEngine: input.preferredEngine,
      maxIterations: cmpSpec.maxIterations,
      maxTotalBudgetUsd: input.maxBudgetUsd ?? cmpSpec.maxTotalBudgetUsd,
      autoStart: true,
    });
    return { route: "goal_campaign", plan, campaign };
  }

  if (plan.route === "epic_dag" && plan.epicPlan) {
    const { epic, subtasks } = await ctx.createEpic({
      repoId: input.repoId,
      title: plan.title,
      description: input.requirement.trim(),
      template: input.template,
      tddMode: input.tddMode,
      epicDeliveryMode: plan.epicPlan.epicDeliveryMode,
      releaseBarrier: plan.epicPlan.releaseBarrier,
      preferredEngine: input.preferredEngine,
      modelOverride: input.modelOverride,
      effortOverride: input.effortOverride,
      maxCostUsdPerSubtask: input.maxBudgetUsd,
      subtasks: plan.epicPlan.subtasks,
    });
    return { route: "epic_dag", plan, epic, subtasks };
  }

  const single = plan.singleSpec!;
  const ticket = await createDirectTicketSynced(ctx, {
    repoId: input.repoId,
    title: plan.title,
    description: single.description,
    template: input.template ?? single.template,
    tddMode: input.tddMode ?? single.tddMode,
    deliveryGatePolicy: input.deliveryGatePolicy,
    allowedPaths: single.allowedPaths,
    acceptanceCriteria: single.acceptanceCriteria,
    preferredEngine: input.preferredEngine,
    modelOverride: input.modelOverride,
    effortOverride: input.effortOverride,
    maxCostUsd: input.maxBudgetUsd,
    ...(single.refactorGuard ? { refactorGuard: single.refactorGuard } : {}),
  });
  return { route: "single_ticket", plan, ticket };
}

export async function revertTicketDeliveryOp(
  ctx: KernelCoordinatorContext,
  ticketId: string,
) : Promise<{ ticket: Ticket; revertCommitSha: string }> {
  const ticket = await ctx.stateStore.getTicket(ticketId);
  if (!ticket) {
    throw new Error(`Ticket not found: ${ticketId}`);
  }
  if (ticket.revertedAt) {
    throw new Error(
      `Ticket ${ticketId} was already reverted (${ticket.revertCommitSha ?? ticket.revertedAt})`,
    );
  }
  const repo = await ctx.stateStore.getRepo(ticket.repoId);
  if (!repo) {
    throw new Error(`Repository not found: ${ticket.repoId}`);
  }

  let commitSha = ticket.mergedCommitSha;
  if (!commitSha) {
    const entries = await ctx.stateStore.listOutboxEntries({ ticketId: ticket.id });
    const mergedEntry = [...entries]
      .reverse()
      .find((e) => e.action === "local_merge" && e.status === "sent");
    const shaFromEntry = mergedEntry?.resultPayload?.commitSha;
    if (typeof shaFromEntry === "string" && shaFromEntry.trim()) {
      commitSha = shaFromEntry.trim();
    }
  }

  if (!commitSha) {
    throw new Error(
      `Ticket ${ticketId} has no recorded local merge commit SHA to revert.`,
    );
  }

  const res = await ctx.workspace.revertMergedCommit({
    rootRepoPath: repo.rootPath,
    baseBranch: repo.baseBranch,
    commitSha,
  });
  if (!res.ok || !res.revertCommitSha) {
    const detail =
      res.conflictFiles && res.conflictFiles.length > 0
        ? `Revert conflicted on: ${res.conflictFiles.join(", ")}`
        : res.error || "Git revert failed";
    throw new Error(detail);
  }

  const ts = nowIso();
  const updated: Ticket = {
    ...ticket,
    mergedCommitSha: commitSha,
    revertedAt: ts,
    revertCommitSha: res.revertCommitSha,
    updatedAt: ts,
  };
  await ctx.stateStore.saveTicket(updated);
  ctx.emitEvent({ type: "ticket_updated", ticket: updated, timestamp: ts });
  await ctx.previewProvider?.stopPreviewsForTicket(ticket.id).catch(() => {});

  const existingCase = await ctx.stateStore.getCasebookEntryByTicket(ticket.id);
  if (existingCase && !existingCase.reverted) {
    const flaggedCase: CasebookEntry = {
      ...existingCase,
      reverted: true,
      updatedAt: ts,
    };
    await ctx.stateStore.saveCasebookEntry(flaggedCase);
    ctx.emitEvent({
      type: "casebook_updated",
      repoId: updated.repoId,
      entry: flaggedCase,
      timestamp: ts,
    });
  }
  const repoPlaybook = await ctx.stateStore.listPlaybookEntries(ticket.repoId);
  for (const pb of repoPlaybook) {
    if (pb.source === "auto_healed" && pb.sourceTicketId === ticket.id && !pb.suspect) {
      const suspectEntry: PlaybookEntry = {
        ...pb,
        suspect: true,
        updatedAt: ts,
      };
      await ctx.stateStore.savePlaybookEntry(suspectEntry);
      ctx.emitEvent({
        type: "playbook_updated",
        repoId: ticket.repoId,
        entry: suspectEntry,
        timestamp: ts,
      });
    }
  }

  return { ticket: updated, revertCommitSha: res.revertCommitSha };
}

export async function steerTicketOp(
  ctx: KernelCoordinatorContext,
  ticketId: string,
  input: SteerTicketInput,
) : Promise<Ticket> {
  const instruction = input.instruction?.trim();
  if (!instruction) {
    throw new Error("Live steer instruction is required.");
  }
  const existing = await ctx.stateStore.getTicket(ticketId);
  if (!existing) {
    throw new Error(`Ticket not found: ${ticketId}`);
  }
  if (isTerminalTicketStatus(existing.status)) {
    throw new Error(`Cannot steer terminal ticket ${ticketId} (${existing.status}).`);
  }

  const activeCtrl = ctx.abortControllers.get(ticketId);
  if (activeCtrl) {
    ctx.pendingSteers.set(ticketId, {
      instruction,
      preferredEngine: input.preferredEngine,
    });
    activeCtrl.abort("live_steer");
    const activeRun = ctx.activeTicketRuns.get(ticketId);
    if (activeRun) {
      await Promise.race([activeRun, new Promise((r) => setTimeout(r, 600))]).catch(() => {});
    }
    return (await ctx.stateStore.getTicket(ticketId)) ?? existing;
  }

  const ts = nowIso();
  const overrideEngine =
    input.preferredEngine && input.preferredEngine !== "auto"
      ? input.preferredEngine
      : existing.activeEngine;
  const updated: Ticket = {
    ...existing,
    status: existing.status === "waiting_deps" ? "waiting_deps" : "queued",
    pauseBeforeRun: false,
    errorMessage: undefined,
    steerCount: (existing.steerCount ?? 0) + 1,
    preferredEngine: input.preferredEngine ?? existing.preferredEngine,
    activeEngine: overrideEngine,
    inlineMemory: {
      ...existing.inlineMemory,
      threadUpdates: [
        ...existing.inlineMemory.threadUpdates,
        {
          triggerId: newId("str"),
          message: `[Live Steer]: ${instruction}`,
          createdAt: ts,
        },
      ],
      activeHint: `[LIVE STEER]: ${instruction}`,
    },
    updatedAt: ts,
  };
  await ctx.stateStore.saveTicket(updated);
  ctx.emitEvent({ type: "ticket_updated", ticket: updated, timestamp: ts });
  return updated;
}

export async function cancelTicketOp(
  ctx: KernelCoordinatorContext,
  ticketId: string,
  reason = "Cancelled by user",
) : Promise<Ticket> {
  const ctrl = ctx.abortControllers.get(ticketId);
  if (ctrl) {
    ctrl.abort("cancelled_by_user");
  }
  const activeRun = ctx.activeTicketRuns.get(ticketId);
  if (activeRun) {
    await Promise.race([activeRun, new Promise((r) => setTimeout(r, 500))]).catch(() => {});
  }
  const ticket = await ctx.stateStore.getTicket(ticketId);
  if (!ticket) throw new Error(`Ticket not found: ${ticketId}`);

  const updated: Ticket = {
    ...ticket,
    status: "cancelled",
    errorMessage: reason,
    updatedAt: nowIso(),
  };
  await ctx.stateStore.saveTicket(updated);
  ctx.emitEvent({ type: "ticket_updated", ticket: updated, timestamp: updated.updatedAt });
  await ctx.previewProvider?.stopPreviewsForTicket(ticketId).catch(() => {});

  const repo = await ctx.stateStore.getRepo(updated.repoId);
  if (repo?.autoCleanupWorktree !== false && updated.worktreePath) {
    return (await ctx.cleanupTicketWorktree(ticketId)) ?? updated;
  }
  if (repo && updated.campaignId) {
    await onCampaignTicketSettledOp(ctx, updated, repo).catch(() => {});
  }
  return updated;
}

export async function clarifySpecOp(
  ctx: KernelCoordinatorContext,
  input: SpecClarificationInput,
) : Promise<SpecClarificationResult> {
  const repo =
    (await syncRepoContractOp(ctx, input.repoId).catch(() => null)) ??
    (await ctx.stateStore.getRepo(input.repoId));
  if (!repo) {
    throw new Error(`Repository not found: ${input.repoId}`);
  }
  const [repoStructure, playbookEntries, casebookEntries, probeContext] = await Promise.all([
    ctx.workspace.getRepoStructureSummary
      ? ctx.workspace.getRepoStructureSummary(repo.rootPath).catch(() => undefined)
      : Promise.resolve(undefined),
    ctx.stateStore.listPlaybookEntries(repo.id, { onlyEnabled: true }),
    ctx.stateStore.listCasebookEntries(repo.id),
    ctx.workspace.runRepoPreProbe
      ? ctx.workspace
          .runRepoPreProbe(
            repo.rootPath,
            `${input.title}\n${input.description}`,
            repo.forbiddenPaths,
          )
          .catch(() => undefined)
      : Promise.resolve(undefined),
  ]);

  const playbookText = formatPlaybookContext(playbookEntries, ["**"], 8, 1200);
  const caseSelection = selectRelevantCasesForContext({
    cases: casebookEntries,
    targetPaths: ["**"],
    queryText: `${input.title} ${input.description}`,
  });
  const caseText = caseSelection.formattedMarkdown;

  let spec: SpecClarificationResult;
  if (ctx.llm.clarifySpec) {
    spec = await ctx.llm.clarifySpec({
      repo,
      title: input.title,
      description: input.description,
      defaultTemplate: input.template ?? repo.defaultTemplate,
      repoStructure,
      playbookRules: playbookText || undefined,
      casebookContext: caseText || undefined,
      conventions: repo.conventions,
      probeContext,
      probeExecutor: ctx.createRepoProbeExecutor(repo),
    });
    spec = {
      ...spec,
      matchedCaseTitles:
        spec.matchedCaseTitles.length > 0
          ? spec.matchedCaseTitles
          : caseSelection.positiveCases.map((c) => c.title),
      probeSteps:
        spec.probeSteps && spec.probeSteps.length > 0
          ? spec.probeSteps
          : probeContext?.probeSteps,
    };
  } else {
    spec = buildHeuristicSpecClarification({
      repo,
      title: input.title,
      description: input.description,
      defaultTemplate: input.template ?? repo.defaultTemplate,
      repoStructure,
      casebookEntries,
      playbookEntries,
      probeContext,
    });
  }

  if (
    ctx.workspace.analyzeSymbolImpact &&
    spec.suggestedAllowedPaths.length > 0 &&
    !spec.suggestedAllowedPaths.includes("**")
  ) {
    const symbolImpact = await ctx.workspace
      .analyzeSymbolImpact(repo.rootPath, spec.suggestedAllowedPaths)
      .catch(() => undefined);
    if (symbolImpact) {
      spec = {
        ...spec,
        ...(symbolImpact.directDependents.length > 0
          ? { directDependents: symbolImpact.directDependents.slice(0, 12) }
          : {}),
        ...(symbolImpact.transitiveDependents.length > 0
          ? { transitiveDependents: symbolImpact.transitiveDependents.slice(0, 12) }
          : {}),
        recommendedTddMode:
          spec.recommendedTddMode || symbolImpact.directDependents.length >= 3,
      };
    }
  }

  return applyClarificationAnswers(spec, input.answers);
}

export async function captureTicketCheckpointOp(
  ctx: KernelCoordinatorContext,
  ticket: Ticket,
  repo: RepoConfig,
  worktreePath: string,
  opts: { stage: StageKind | "baseline"; stageRunId?: string; engine?: WorkerEngineId; label: string; changedFiles: string[]; verificationPassed?: boolean; },
) : Promise<TicketCheckpoint | null> {
  if (!ctx.workspace.captureWorktreeCheckpoint) return null;
  try {
    const cpId = newId("cp");
    const snap = await ctx.workspace.captureWorktreeCheckpoint({
      worktreePath,
      ticketId: ticket.id,
      checkpointId: cpId,
      label: opts.label,
    });
    const checkpoint: TicketCheckpoint = {
      id: cpId,
      ticketId: ticket.id,
      repoId: repo.id,
      stageRunId: opts.stageRunId,
      stage: opts.stage,
      engine: opts.engine,
      label: opts.label,
      gitRef: snap.gitRef,
      commitSha: snap.commitSha,
      changedFiles: opts.changedFiles,
      verificationPassed: opts.verificationPassed,
      createdAt: nowIso(),
    };
    await ctx.stateStore.saveCheckpoint(checkpoint);
    ctx.emitEvent({
      type: "checkpoint_created",
      checkpoint,
      timestamp: checkpoint.createdAt,
    });
    return checkpoint;
  } catch {
    return null;
  }
}

export async function enqueueDeliveryOutboxOp(
  ctx: KernelCoordinatorContext,
  ticket: Ticket,
  repoArg?: RepoConfig,
) : Promise<void> {
  const repo = repoArg ?? (await ctx.stateStore.getRepo(ticket.repoId));
  await maybeDistillClosedLoopLessonOp(ctx, ticket, repo ?? undefined);
  const template = getPipelineTemplate(ticket.template);
  const ts = nowIso();

  let changedFiles: string[] = Array.from(
    new Set(ticket.inlineMemory.stageNotes.flatMap((n) => n.changedFiles ?? [])),
  );
  let addedLines = 0;
  let deletedLines = 0;
  if (ticket.worktreePath && repo) {
    try {
      const { effectiveBaseBranch } = await getEffectiveBaseInfoOp(ctx, ticket, repo);
      const wsChanged = await ctx.workspace.getChangedFiles(ticket.worktreePath, effectiveBaseBranch);
      if (wsChanged.length > 0) changedFiles = wsChanged;
      const diffText = await ctx.workspace.getDiff(ticket.worktreePath, effectiveBaseBranch);
      const counts = countDiffLines(diffText);
      addedLines = counts.addedLines;
      deletedLines = counts.deletedLines;
    } catch {
      // Fallback cleanly to recorded stageNote metadata
    }
  }

  let reviewReport: ReviewReport | undefined;
  let maxVisualDiffRatio: number | undefined;
  let smokeResult: SmokeCheckResult | undefined;
  try {
    const artifacts = await ctx.stateStore.listArtifacts(ticket.id);
    const latestReviewArt = [...artifacts].reverse().find((a) => a.kind === "review_report");
    if (latestReviewArt) {
      const raw = await ctx.artifactStore.readSpill(latestReviewArt.storageUri).catch(() => "");
      if (raw) {
        reviewReport = JSON.parse(raw) as ReviewReport;
      }
    }
    for (const art of artifacts) {
      if (art.kind === "visual_diff") {
        const match = /([0-9]+(?:\.[0-9]+)?)%\s*changed/i.exec(art.summary);
        if (match) {
          const ratio = Number(match[1]) / 100;
          if (Number.isFinite(ratio)) {
            maxVisualDiffRatio = Math.max(maxVisualDiffRatio ?? 0, ratio);
          }
        }
      }
    }
    const latestSmokeArt = [...artifacts].reverse().find((a) => a.kind === "smoke_log");
    if (latestSmokeArt) {
      smokeResult = {
        ok: /^PASS\b/i.test(latestSmokeArt.summary),
        readyUrl: "",
        port: 0,
        startupDurationMs: 0,
        checkResults: [],
        serverOutputTail: "",
        summary: latestSmokeArt.summary,
      };
    }
  } catch {
    // Non-fatal
  }

  if (!reviewReport) {
    const reviewNote = [...ticket.inlineMemory.stageNotes]
      .reverse()
      .find((n) => n.stage === "review");
    if (reviewNote && reviewNote.reviewApproved !== undefined) {
      reviewReport = {
        verdict: reviewNote.reviewApproved ? "approved" : "changes_requested",
        reviewedByEngine: reviewNote.engine ?? "codex",
        summary: reviewNote.summary,
        findings: reviewNote.reviewFindings ?? [],
        createdAt: reviewNote.createdAt,
      };
    }
  }

  const staticVerificationPassed = Boolean(
    [...ticket.inlineMemory.stageNotes]
      .reverse()
      .find((n) => (n.stage === "implement" || n.stage === "rebase") && n.verificationPassed !== undefined)
      ?.verificationPassed,
  );

  let hotspotFiles: Array<{ filePath: string; lineCount: number }> | undefined;
  if (repo && ctx.workspace.scanCodeHotspots && changedFiles.length > 0) {
    const changedSet = new Set(changedFiles);
    const all = await ctx.workspace.scanCodeHotspots(repo.rootPath, 1500).catch(() => []);
    const touched = all
      .filter((h) => changedSet.has(h.filePath))
      .map((h) => ({ filePath: h.filePath, lineCount: h.lineCount }));
    if (touched.length > 0) hotspotFiles = touched;
  }

  const riskAssessment = evaluateTicketRisk({
    ticket,
    hotspotFiles,
    repo: repo ?? undefined,
    changedFiles,
    addedLines,
    deletedLines,
    maxVisualDiffRatio,
    reviewReport,
    smokeResult,
    staticVerificationPassed,
  });

  const needsSignoff =
    template.requireOutboxSignoff ||
    (Boolean(ticket.routineId) && repo?.mode === "observe") ||
    riskAssessment.requiresSignoff;
  const defaultChannel = repo?.defaultDeliveryChannel ?? "auto_pr_or_branch";
  const action: OutboxAction =
    defaultChannel === "local_merge" ? "local_merge" : "push_and_create_pr";

  const updatedTicket: Ticket = {
    ...ticket,
    status: "outbox_pending",
    activeEngine: undefined,
    riskAssessment,
    updatedAt: ts,
  };
  await ctx.stateStore.saveTicket(updatedTicket);
  ctx.emitEvent({ type: "ticket_updated", ticket: updatedTicket, timestamp: ts });

  const outboxEntry: OutboxEntry = {
    id: newId("obx"),
    repoId: ticket.repoId,
    ticketId: ticket.id,
    action,
    idempotencyKey: `deliver:${action}:${ticket.id}:${ticket.branchName ?? "branch"}:n${ticket.inlineMemory.stageNotes.length}`,
    payload: {
      title: ticket.title,
      branchName: ticket.branchName,
      worktreePath: ticket.worktreePath,
      forceGithubPr: defaultChannel === "github_pr",
      summary: ticket.inlineMemory.stageNotes.map((n) => `[${n.stage}] ${n.summary}`).join("\n"),
      riskAssessment,
    },
    status: needsSignoff ? "awaiting_approval" : "pending",
    attempts: 0,
    nextAttemptAt: ts,
    createdAt: ts,
    updatedAt: ts,
  };
  await ctx.stateStore.enqueueOutbox(outboxEntry);
  ctx.emitEvent({ type: "outbox_queued", entry: outboxEntry, timestamp: ts });

  if (!needsSignoff && action === "local_merge" && repo) {
    await ensureMergeTrainForOutboxOp(ctx, outboxEntry, updatedTicket, repo);
  }

  if (needsSignoff) {
    const riskNote = riskAssessment.requiresSignoff
      ? ` [Risk ${riskAssessment.score}/100 (${riskAssessment.level}), policy=${riskAssessment.policy}]`
      : "";
    const inboxItem: InboxItem = {
      id: newId("inb"),
      repoId: ticket.repoId,
      ticketId: ticket.id,
      kind: "outbox_signoff",
      status: "pending",
      title:
        action === "local_merge"
          ? `Sign off Local Merge: ${ticket.title}`
          : `Sign off PR Delivery: ${ticket.title}`,
      summary:
        (action === "local_merge"
          ? `Ready to merge branch ${ticket.branchName} into ${repo?.baseBranch ?? "main"}. Approve Outbox execution to merge & cleanup.`
          : `Ready to deliver branch ${ticket.branchName}. Approve Outbox execution to push / create PR.`) +
        riskNote,
      contextPayload: {
        outboxId: outboxEntry.id,
        branchName: ticket.branchName,
        action,
        riskAssessment,
      },
      createdAt: ts,
    };
    await ctx.stateStore.saveInboxItem(inboxItem);
    ctx.emitEvent({ type: "inbox_created", item: inboxItem, timestamp: ts });
  }
}

export async function triggerTicketDeliveryOp(
  ctx: KernelCoordinatorContext,
  outbox: OutboxProcessor,
  ticketId: string,
  action: "local_merge" | "push_and_create_pr",
) : Promise<{ ticket: Ticket; entry: OutboxEntry }> {
  const ticket = await ctx.stateStore.getTicket(ticketId);
  if (!ticket) {
    throw new Error(`Ticket not found: ${ticketId}`);
  }
  if (ticket.isEpic && ticket.epicDeliveryMode === "per_subtask") {
    throw new Error("Per-subtask Epic umbrella tickets are delivered via their subtasks.");
  }
  if (!ticket.branchName) {
    throw new Error(`Ticket ${ticketId} has no branchName to deliver.`);
  }
  if (ticket.parentTicketId) {
    const parentEpic = await ctx.stateStore.getTicket(ticket.parentTicketId);
    if (parentEpic?.isEpic && parentEpic.epicDeliveryMode !== "per_subtask") {
      throw new Error(
        `Subtask ${ticketId} was integrated into unified Epic branch '${parentEpic.branchName}'; trigger delivery on parent Epic ${parentEpic.id} instead.`,
      );
    }
  }
  if (ticket.status !== "delivered" && ticket.status !== "outbox_pending") {
    throw new Error(
      `Ticket ${ticketId} must be delivered or outbox_pending before triggering ${action} (status=${ticket.status})`,
    );
  }

  const existingEntries = await ctx.stateStore.listOutboxEntries({ ticketId: ticket.id });
  const alreadySent = existingEntries.find((e) => e.action === action && e.status === "sent");
  if (alreadySent) {
    return { ticket, entry: alreadySent };
  }

  const ts = nowIso();
  const idempotencyKey = `deliver:${action}:${ticket.id}:${ticket.branchName}`;
  const existingByKey = existingEntries.find((e) => e.idempotencyKey === idempotencyKey);
  let entry: OutboxEntry;
  if (existingByKey) {
    entry = {
      ...existingByKey,
      status: "pending",
      attempts: 0,
      lastError: undefined,
      nextAttemptAt: ts,
      updatedAt: ts,
    };
    await ctx.stateStore.updateOutboxEntry(entry);
  } else {
    entry = {
      id: newId("obx"),
      repoId: ticket.repoId,
      ticketId: ticket.id,
      action,
      idempotencyKey,
      payload: {
        title: ticket.title,
        branchName: ticket.branchName,
        worktreePath: ticket.worktreePath,
        forceGithubPr: action === "push_and_create_pr",
        summary: ticket.inlineMemory.stageNotes
          .map((n) => `[${n.stage}] ${n.summary}`)
          .join("\n"),
      },
      status: "pending",
      attempts: 0,
      nextAttemptAt: ts,
      createdAt: ts,
      updatedAt: ts,
    };
    await ctx.stateStore.enqueueOutbox(entry);
  }
  ctx.emitEvent({ type: "outbox_queued", entry, timestamp: ts });

  if (action === "local_merge") {
    const repo = await ctx.stateStore.getRepo(ticket.repoId);
    if (repo) {
      await ensureMergeTrainForOutboxOp(ctx, entry, ticket, repo);
      await flushMergeTrainOp(ctx, repo.id);
    }
  } else {
    await outbox.processDueEntries(10);
  }

  let refreshedTicket = (await ctx.stateStore.getTicket(ticket.id)) ?? ticket;
  const refreshedEntry = (await ctx.stateStore.getOutboxEntry(entry.id)) ?? entry;
  if (action === "local_merge" && refreshedEntry.status === "sent" && refreshedTicket.worktreePath) {
    refreshedTicket = {
      ...refreshedTicket,
      worktreePath: undefined,
      worktreeCleanedAt: refreshedTicket.worktreeCleanedAt ?? nowIso(),
      updatedAt: nowIso(),
    };
    await ctx.stateStore.saveTicket(refreshedTicket);
    ctx.emitEvent({
      type: "ticket_updated",
      ticket: refreshedTicket,
      timestamp: refreshedTicket.updatedAt,
    });
  }

  return { ticket: refreshedTicket, entry: refreshedEntry };
}

export async function escalateTicketOp(
  ctx: KernelCoordinatorContext,
  ticket: Ticket,
  kind: InboxItem["kind"],
  reason: string,
  contextPayload: Record<string, unknown>,
) : Promise<void> {
  const ts = nowIso();
  const updated: Ticket = {
    ...ticket,
    status: "needs_human",
    activeEngine: undefined,
    errorMessage: reason,
    updatedAt: ts,
  };
  await ctx.stateStore.saveTicket(updated);
  ctx.emitEvent({ type: "ticket_updated", ticket: updated, timestamp: ts });

  const inboxItem: InboxItem = {
    id: newId("inb"),
    repoId: ticket.repoId,
    ticketId: ticket.id,
    kind,
    status: "pending",
    title: `Action Needed: ${ticket.title}`,
    summary: reason,
    contextPayload,
    createdAt: ts,
  };
  await ctx.stateStore.saveInboxItem(inboxItem);
  ctx.emitEvent({ type: "inbox_created", item: inboxItem, timestamp: ts });

  const repo = await ctx.stateStore.getRepo(ticket.repoId);
  if (repo) {
    await executeLifecycleHookOp(ctx, "on_escalate", updated, repo).catch(
      () => {},
    );
  }
}
