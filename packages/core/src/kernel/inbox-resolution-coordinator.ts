import { existsSync } from "node:fs";
import { getFirstStage, getNextStage, selectEngineForStage } from "../pipeline.ts";
import { distillHumanNoteToRule } from "../playbook.ts";
import { evaluatePlaybookRuleHygiene } from "../playbook-hygiene.ts";
import type {
  BatchResolveInboxInput,
  BatchResolveInboxResult,
  EpicReplanProposal,
  InboxItem,
  InboxItemStatus,
  OutboxEntry,
  RepoConfig,
  SpillArtifact,
  StageKind,
  StageRun,
  Ticket,
  WorkerClarificationRequest,
  WorkerEngineId,
} from "../types.ts";
import { nowIso } from "../utils.ts";
import { adoptArenaCandidateWinnerOp, cleanupArenaCandidateWorktreesOp } from "./arena-coordinator.ts";
import { deliverCampaignOp, startCampaignOp } from "./campaign-coordinator.ts";
import type { KernelCoordinatorContext } from "./context.ts";
import { applyEpicReplanProposalOp } from "./epic-replan-coordinator.ts";
import { releaseMilestoneOp } from "./milestone-coordinator.ts";

function utcTodayString(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function resolveInboxItemOp(
  ctx: KernelCoordinatorContext,
  inboxId: string,
  decision: "approved" | "rejected",
  note?: string,
  options?: {
    deliveryAction?: "local_merge" | "push_and_create_pr";
    expandMandate?: boolean;
    budgetIncreaseUsd?: number;
    saveToPlaybook?: boolean;
    arenaWinnerId?: string;
    selectedOption?: string;
  },
): Promise<{ item: InboxItem; ticket: Ticket }> {
  const item = await ctx.stateStore.getInboxItem(inboxId);
  if (!item) throw new Error(`Inbox item not found: ${inboxId}`);
  if (item.status !== "pending") {
    throw new Error(`Inbox item ${inboxId} is already ${item.status}`);
  }

  let ticket = await ctx.stateStore.getTicket(item.ticketId);
  if (!ticket && item.kind !== "campaign_paused" && item.kind !== "milestone_ready") {
    throw new Error(`Ticket not found for inbox item: ${item.ticketId}`);
  }

  const ts = nowIso();
  const resolvedItem: InboxItem = {
    ...item,
    status: decision,
    resolutionNote: note,
    resolvedAt: ts,
  };
  await ctx.stateStore.saveInboxItem(resolvedItem);
  ctx.emitEvent({ type: "inbox_resolved", item: resolvedItem, timestamp: ts });

  if (item.kind === "milestone_ready") {
    const milestoneId = item.contextPayload?.milestoneId as string | undefined;
    if (decision === "approved" && milestoneId) {
      try {
        // Explicit human signoff: bump version only; never tag/push implicitly.
        await releaseMilestoneOp(ctx, milestoneId, {
          bumpVersion: true,
          createTag: false,
          pushRemote: false,
        });
      } catch (err) {
        // Re-open the card so the human can retry after fixing the repo state.
        await ctx.stateStore.saveInboxItem(item);
        ctx.emitEvent({ type: "inbox_created", item, timestamp: nowIso() });
        throw err;
      }
    }
    return {
      item: resolvedItem,
      ticket: {
        id: item.ticketId,
        repoId: item.repoId,
        threadId: `thr_${item.id}`,
        sourceTriggerId: `trg_${item.id}`,
        title: item.title,
        description: item.summary,
        status: "delivered",
        template: "fast",
        currentStage: "implement",
        stageRetries: 0,
        mandate: {
          allowedPaths: ["**"],
          forbiddenPaths: [],
          allowNetwork: false,
          allowExternalSideEffects: false,
          maxCostUsd: 2,
          maxDurationSec: 600,
          maxStageRetries: 2,
        },
        dependsOn: [],
        nativeSessions: {},
        inlineMemory: {
          goal: item.summary,
          acceptanceCriteria: [],
          stageNotes: [],
          threadUpdates: [],
        },
        costUsd: 0,
        priority: 1,
        createdAt: ts,
        updatedAt: ts,
      },
    };
  }

  if (item.kind === "campaign_paused") {
    const campaignId = item.contextPayload?.campaignId as string | undefined;
    if (campaignId && ctx.stateStore.getCampaign && ctx.stateStore.saveCampaign) {
      const campaign = await ctx.stateStore.getCampaign(campaignId);
      if (campaign) {
        if (decision === "approved" && options?.deliveryAction) {
          await deliverCampaignOp(ctx, campaign.id, options.deliveryAction);
        } else if (decision === "approved") {
          const bumpIter = campaign.completedWaves >= campaign.maxIterations ? 3 : 0;
          const bumpBudget =
            options?.budgetIncreaseUsd ??
            (campaign.totalCostUsd >= campaign.maxTotalBudgetUsd ? 3.0 : 0);
          const refreshed = {
            ...campaign,
            maxIterations: campaign.maxIterations + bumpIter,
            maxTotalBudgetUsd: Number((campaign.maxTotalBudgetUsd + bumpBudget).toFixed(4)),
            consecutiveNoImproveCount: 0,
            pauseReason: undefined,
            updatedAt: ts,
          };
          await ctx.stateStore.saveCampaign(refreshed);
          const resumed = await startCampaignOp(ctx, campaign.id, { note });
          if (resumed.activeTicketId) {
            ticket = (await ctx.stateStore.getTicket(resumed.activeTicketId)) ?? ticket;
          }
        }
      }
    }
    const fallbackTicket: Ticket = ticket ?? {
      id: item.ticketId,
      repoId: item.repoId,
      threadId: `thr_${item.id}`,
      sourceTriggerId: `trg_${item.id}`,
      title: item.title,
      description: item.summary,
      status: "delivered",
      template: "fast",
      currentStage: "implement",
      stageRetries: 0,
      mandate: {
        allowedPaths: ["**"],
        forbiddenPaths: [],
        allowNetwork: false,
        allowExternalSideEffects: false,
        maxCostUsd: 2,
        maxDurationSec: 600,
        maxStageRetries: 2,
      },
      dependsOn: [],
      nativeSessions: {},
      inlineMemory: {
        goal: item.summary,
        acceptanceCriteria: [],
        stageNotes: [],
        threadUpdates: [],
      },
      costUsd: 0,
      priority: 1,
      createdAt: ts,
      updatedAt: ts,
    };
    return { item: resolvedItem, ticket: fallbackTicket };
  }

  const baseTicket = ticket!;

  if (options?.saveToPlaybook === true && item.kind !== "budget_cap") {
    const rule = distillHumanNoteToRule(note);
    // Hygiene guard: one-off approval/continuation notes never pollute the Playbook.
    if (rule && evaluatePlaybookRuleHygiene(rule, "human").clean) {
      await ctx.addOrUpdatePlaybookRule({
        repoId: baseTicket.repoId,
        rule,
        scopePaths: baseTicket.mandate.allowedPaths,
        source: "human",
        sourceTicketId: baseTicket.id,
        enabled: true,
        pinned: false,
      });
    }
  }

  let nextTicket: Ticket = { ...baseTicket, updatedAt: ts };

  if (item.kind === "observe_proposal") {
    if (decision === "approved") {
      const hasPendingDeps = await ctx.hasUnfinishedDependencies(baseTicket);
      nextTicket = {
        ...nextTicket,
        status: hasPendingDeps ? "waiting_deps" : "queued",
        currentStage: getFirstStage(baseTicket.template, baseTicket.tddMode),
        inlineMemory: {
          ...nextTicket.inlineMemory,
          activeHint: note || nextTicket.inlineMemory.activeHint,
        },
      };
    } else {
      nextTicket = { ...nextTicket, status: "cancelled", errorMessage: note ?? "Proposal rejected" };
    }
  } else if (item.kind === "plan_approval") {
    const isDagBreakpoint = item.contextPayload.isDagBreakpoint === true;
    if (decision === "approved") {
      nextTicket = {
        ...nextTicket,
        status: "queued",
        pauseBeforeRun: false,
        currentStage: isDagBreakpoint
          ? baseTicket.currentStage
          : (getNextStage(baseTicket.template, "plan", baseTicket.tddMode) ?? "implement"),
        errorMessage: undefined,
        inlineMemory: {
          ...nextTicket.inlineMemory,
          activeHint: note || nextTicket.inlineMemory.activeHint,
        },
      };
    } else if (note) {
      nextTicket = {
        ...nextTicket,
        status: "queued",
        pauseBeforeRun: false,
        currentStage: isDagBreakpoint ? baseTicket.currentStage : "plan",
        errorMessage: undefined,
        inlineMemory: {
          ...nextTicket.inlineMemory,
          activeHint: isDagBreakpoint ? note : `Plan rejected with feedback: ${note}`,
        },
      };
    } else {
      nextTicket = {
        ...nextTicket,
        pauseBeforeRun: false,
        status: "cancelled",
        errorMessage: isDagBreakpoint ? "DAG breakpoint rejected" : "Plan rejected",
      };
    }
  } else if (item.kind === "outbox_signoff") {
    const outboxId = item.contextPayload.outboxId as string | undefined;
    const entries = outboxId
      ? [await ctx.stateStore.getOutboxEntry(outboxId)].filter((x): x is OutboxEntry => x !== null)
      : await ctx.stateStore.listOutboxEntries({
          ticketId: baseTicket.id,
          status: "awaiting_approval",
        });

    const repo = await ctx.stateStore.getRepo(baseTicket.repoId);
    for (const entry of entries) {
      const updatedEntry: OutboxEntry = {
        ...entry,
        action:
          decision === "approved" && options?.deliveryAction
            ? options.deliveryAction
            : entry.action,
        status: decision === "approved" ? "pending" : "cancelled",
        nextAttemptAt: ts,
        updatedAt: ts,
      };
      await ctx.stateStore.updateOutboxEntry(updatedEntry);
      if (decision === "approved") {
        ctx.emitEvent({ type: "outbox_queued", entry: updatedEntry, timestamp: ts });
        if (updatedEntry.action === "local_merge" && repo) {
          await ctx.ensureMergeTrainForOutbox(updatedEntry, baseTicket, repo);
        }
      }
    }
    if (decision === "rejected") {
      nextTicket = {
        ...nextTicket,
        status: "cancelled",
        errorMessage: note ?? "PR sign-off rejected",
      };
    }
  } else if (item.kind === "mandate_violation") {
    const pendingPaths =
      baseTicket.pendingViolationPaths ??
      (Array.isArray(item.contextPayload.scopeViolations)
        ? (item.contextPayload.scopeViolations as string[])
        : []);
    const canExpand =
      Boolean(options?.expandMandate) &&
      item.contextPayload.canExpandMandate === true &&
      pendingPaths.length > 0;

    if (decision === "approved" && canExpand) {
      const mergedAllowed = Array.from(
        new Set([...baseTicket.mandate.allowedPaths, ...pendingPaths]),
      );
      const expandedMandate = { ...baseTicket.mandate, allowedPaths: mergedAllowed };
      const interruptedStage =
        (item.contextPayload.interruptedStage as StageKind | undefined) ?? baseTicket.currentStage;

      nextTicket = {
        ...nextTicket,
        mandate: expandedMandate,
        pendingViolationPaths: undefined,
        stageRetries: 0,
        errorMessage: undefined,
      };

      if (
        interruptedStage === "implement" &&
        baseTicket.worktreePath &&
        existsSync(baseTicket.worktreePath)
      ) {
        const repo = await ctx.stateStore.getRepo(baseTicket.repoId);
        const resolvedEngine: WorkerEngineId =
          baseTicket.activeEngine ??
          (repo
            ? selectEngineForStage(repo, "implement", baseTicket.preferredEngine)
            : baseTicket.preferredEngine && baseTicket.preferredEngine !== "auto"
              ? baseTicket.preferredEngine
              : "mock");
        const syntheticRun: StageRun = {
          id: `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          ticketId: baseTicket.id,
          stage: "implement",
          engine: resolvedEngine,
          status: "running",
          costUsd: 0,
          startedAt: ts,
        };
        await ctx.stateStore.saveStageRun(syntheticRun);
        const gate = repo
          ? await ctx.runRepoVerificationGate(
              nextTicket,
              repo,
              syntheticRun,
              baseTicket.worktreePath,
            )
          : { passed: true, artifacts: [] as SpillArtifact[], result: undefined };

        if (gate.passed) {
          await ctx.workspace.commitAll(
            baseTicket.worktreePath,
            `super-work(${baseTicket.id}): ${baseTicket.title}`,
          );
          const effectiveBaseBranch = repo
            ? (await ctx.getEffectiveBaseInfo(nextTicket, repo)).effectiveBaseBranch
            : "main";
          const changedFiles = await ctx.workspace.getChangedFiles(
            baseTicket.worktreePath,
            effectiveBaseBranch,
          );
          const diffText = await ctx.workspace.getDiff(
            baseTicket.worktreePath,
            effectiveBaseBranch,
          );
          const finishedRun: StageRun = {
            ...syntheticRun,
            status: "completed",
            completedAt: nowIso(),
            summary: `Mandate expanded to [${pendingPaths.join(", ")}] and verification passed`,
          };
          const { note: expNote } = await ctx.memory.recordStageSpillAndNote({
            ticket: nextTicket,
            stageRun: finishedRun,
            events: [],
            changedFiles,
            diffText,
            summary: finishedRun.summary!,
            verificationPassed: true,
            extraArtifacts: gate.artifacts.length > 0 ? gate.artifacts : undefined,
          });
          finishedRun.spillTranscriptId = expNote.spillArtifactIds[0];
          await ctx.stateStore.saveStageRun(finishedRun);

          const afterStage = baseTicket.prNumber
            ? "rebase"
            : getNextStage(baseTicket.template, "implement", baseTicket.tddMode);
          const withNote: Ticket = {
            ...nextTicket,
            inlineMemory: {
              ...nextTicket.inlineMemory,
              stageNotes: [...nextTicket.inlineMemory.stageNotes, expNote],
              activeHint: note || undefined,
            },
          };
          if (!afterStage) {
            const baseHeadAtRebase =
              repo && ctx.workspace.getHeadCommitSha
                ? await ctx.workspace
                    .getHeadCommitSha(repo.rootPath, effectiveBaseBranch)
                    .catch(() => undefined)
                : undefined;
            await ctx.enqueueDeliveryOutbox({ ...withNote, baseHeadAtRebase }, repo ?? undefined);
            return {
              item: resolvedItem,
              ticket: (await ctx.stateStore.getTicket(baseTicket.id)) ?? withNote,
            };
          }
          nextTicket = {
            ...withNote,
            status: "queued",
            currentStage: afterStage,
            updatedAt: nowIso(),
          };
        } else {
          const failRun: StageRun = {
            ...syntheticRun,
            status: "failed",
            completedAt: nowIso(),
            summary: gate.result?.summary ?? "Verification failed after Mandate expansion",
          };
          await ctx.stateStore.saveStageRun(failRun);
          nextTicket = {
            ...nextTicket,
            status: "queued",
            currentStage: "implement",
            inlineMemory: {
              ...nextTicket.inlineMemory,
              activeHint: `Mandate expanded to include ${pendingPaths.join(", ")}, but verification failed (${gate.result?.failedCommand ?? "checks"}):\n${gate.result?.summary ?? ""}`,
            },
          };
        }
      } else {
        nextTicket = {
          ...nextTicket,
          status: "queued",
          inlineMemory: {
            ...nextTicket.inlineMemory,
            activeHint:
              note ??
              `Mandate expanded to include ${pendingPaths.join(", ")}; continue carefully within Mandate.`,
          },
        };
      }
    } else {
      if (baseTicket.worktreePath && existsSync(baseTicket.worktreePath) && pendingPaths.length > 0) {
        await ctx.workspace.revertPaths(baseTicket.worktreePath, pendingPaths);
      }
      nextTicket = {
        ...nextTicket,
        pendingViolationPaths: undefined,
        ...(decision === "approved"
          ? {
              status: "queued" as const,
              stageRetries: 0,
              errorMessage: undefined,
              inlineMemory: {
                ...nextTicket.inlineMemory,
                activeHint:
                  note ??
                  `Out-of-scope edits (${pendingPaths.join(", ")}) were reverted; stay strictly within ${nextTicket.mandate.allowedPaths.join(", ")}.`,
              },
            }
          : {
              status: "cancelled" as const,
              errorMessage: note ?? "Mandate violation rejected",
            }),
      };
    }
  } else if (item.kind === "budget_cap") {
    const repo = await ctx.stateStore.getRepo(item.repoId);
    if (decision === "approved" && repo) {
      const today = utcTodayString();
      const todaySpend = await ctx.stateStore.getDailyRepoSpendUsd(repo.id, today);
      const currentEffective = ctx.getEffectiveDailyBudget(repo, today) ?? todaySpend;
      const baseCap = Math.max(todaySpend, currentEffective);
      const increase = options?.budgetIncreaseUsd ?? 5.0;
      const updatedRepo: RepoConfig = {
        ...repo,
        dailyBudgetOverrideDate: today,
        dailyBudgetOverrideUsd: Number((baseCap + increase).toFixed(4)),
        updatedAt: ts,
      };
      await ctx.stateStore.upsertRepo(updatedRepo);
      ctx.emitEvent({ type: "repo_updated", repo: updatedRepo, timestamp: ts });
    } else if (decision === "rejected") {
      nextTicket = {
        ...nextTicket,
        status: "cancelled",
        errorMessage: note ?? "Daily budget cap increase rejected",
      };
    }
  } else if (item.kind === "pr_followup") {
    if (decision === "approved") {
      nextTicket = {
        ...nextTicket,
        status: "queued",
        currentStage: "implement",
        stageRetries: 0,
        prAutoFollowupCount: 0,
        errorMessage: undefined,
        inlineMemory: {
          ...nextTicket.inlineMemory,
          activeHint:
            note ??
            `Address PR feedback on branch ${nextTicket.branchName ?? ""}: ${item.summary}`,
        },
      };
    } else {
      nextTicket = {
        ...nextTicket,
        status: "delivered",
        errorMessage: undefined,
      };
    }
  } else if (item.kind === "arena_tiebreak") {
    const repo = await ctx.stateStore.getRepo(baseTicket.repoId);
    const candidates = baseTicket.arenaCandidates ?? [];
    if (decision === "approved" && candidates.length > 0) {
      const chosenId =
        options?.arenaWinnerId ??
        (item.contextPayload.recommendedCandidateId as string | undefined) ??
        candidates.find((c) => c.recommended)?.candidateId ??
        candidates[0]!.candidateId;
      const winner = candidates.find((c) => c.candidateId === chosenId) ?? candidates[0]!;
      const adopted = await adoptArenaCandidateWinnerOp(
        ctx,
        {
          ...nextTicket,
          inlineMemory: {
            ...nextTicket.inlineMemory,
            activeHint: note || nextTicket.inlineMemory.activeHint,
          },
        },
        repo ?? undefined,
        winner,
        candidates,
        true,
      );
      return { item: resolvedItem, ticket: adopted };
    } else {
      await ctx.previewProvider?.stopPreviewsForTicket(nextTicket.id).catch(() => {});
      await cleanupArenaCandidateWorktreesOp(ctx, candidates, repo?.rootPath);
      nextTicket = {
        ...nextTicket,
        worktreePath: undefined,
        status: "cancelled",
        errorMessage: note ?? "Arena duel rejected by human reviewer",
      };
    }
  } else if (item.kind === "epic_replan") {
    const proposal =
      baseTicket.pendingEpicReplan ??
      (item.contextPayload.proposal as EpicReplanProposal | undefined);
    if (decision === "approved" && proposal) {
      const appliedEpic = await applyEpicReplanProposalOp(ctx, baseTicket, proposal, {
        humanApproved: true,
      });
      return { item: resolvedItem, ticket: appliedEpic };
    } else {
      nextTicket = {
        ...nextTicket,
        pendingEpicReplan: undefined,
        status: baseTicket.isEpic ? "implementing" : baseTicket.status,
        errorMessage: undefined,
      };
    }
  } else if (item.kind === "clarification_request") {
    if (decision === "approved") {
      const clarificationPayload = item.contextPayload.clarification as
        | WorkerClarificationRequest
        | undefined;
      const chosenAnswer =
        options?.selectedOption?.trim() ||
        note?.trim() ||
        clarificationPayload?.recommendedOption ||
        "Proceed with the recommended engineering approach.";
      const clarificationLine = `[HUMAN CLARIFICATION] Q: ${clarificationPayload?.question ?? item.summary} -> Answer: ${chosenAnswer}${note && options?.selectedOption && note.trim() !== chosenAnswer ? ` (${note.trim()})` : ""}`;
      nextTicket = {
        ...nextTicket,
        status: "queued",
        stageRetries: 0,
        errorMessage: undefined,
        inlineMemory: {
          ...nextTicket.inlineMemory,
          threadUpdates: [
            ...nextTicket.inlineMemory.threadUpdates,
            {
              triggerId: item.id,
              message: clarificationLine,
              createdAt: ts,
            },
          ],
          activeHint: clarificationLine,
        },
      };
    } else {
      nextTicket = {
        ...nextTicket,
        status: "cancelled",
        errorMessage: note ?? "Worker clarification rejected by reviewer",
      };
    }
  } else {
    if (decision === "approved") {
      nextTicket = {
        ...nextTicket,
        status: "queued",
        stageRetries: 0,
        errorMessage: undefined,
        inlineMemory: {
          ...nextTicket.inlineMemory,
          activeHint: note ?? "Human approved continuation; proceed carefully within Mandate.",
        },
      };
    } else {
      nextTicket = {
        ...nextTicket,
        status: "cancelled",
        errorMessage: note ?? "Escalation rejected",
      };
    }
  }

  await ctx.stateStore.saveTicket(nextTicket);
  ctx.emitEvent({ type: "ticket_updated", ticket: nextTicket, timestamp: ts });
  return { item: resolvedItem, ticket: nextTicket };
}

export async function batchResolveInboxOp(
  ctx: KernelCoordinatorContext,
  input: BatchResolveInboxInput,
): Promise<BatchResolveInboxResult> {
  const pendingItems = await ctx.stateStore.listInboxItems({
    repoId: input.repoId,
    status: "pending",
  });
  const wantedIds = input.inboxIds?.length ? new Set(input.inboxIds) : null;
  const wantedKinds = input.kinds?.length ? new Set(input.kinds) : null;
  const lowRiskKinds = new Set([
    "observe_proposal",
    "outbox_signoff",
    "clarification_request",
  ]);

  const candidates = pendingItems.filter((item) => {
    if (wantedIds && !wantedIds.has(item.id)) return false;
    if (wantedKinds && !wantedKinds.has(item.kind)) return false;
    return true;
  });

  const tickets = await ctx.stateStore.listTickets({ repoId: input.repoId });
  const ticketsById = new Map(tickets.map((t) => [t.id, t]));

  let resolvedCount = 0;
  let skippedCount = 0;
  const results: BatchResolveInboxResult["results"] = [];

  for (const item of candidates) {
    if (input.onlyLowRisk) {
      const tkt = ticketsById.get(item.ticketId);
      if (!lowRiskKinds.has(item.kind) || tkt?.riskAssessment?.level === "high") {
        skippedCount += 1;
        continue;
      }
    }
    try {
      const resolved = await resolveInboxItemOp(ctx, item.id, input.decision, input.note, {
        deliveryAction: input.deliveryAction,
        saveToPlaybook: false,
      });
      resolvedCount += 1;
      results.push({
        inboxId: item.id,
        ticketId: resolved.ticket.id,
        status: resolved.item.status,
      });
    } catch {
      skippedCount += 1;
    }
  }

  return { resolvedCount, skippedCount, results };
}
