import { existsSync } from "node:fs";
import { countDiffLines, pickNextFallbackEngine, scoreArenaCandidates } from "../arena.ts";
import { validateChangedFilesAgainstMandate } from "../mandate.ts";
import { getNextStage, selectEngineForStage } from "../pipeline.ts";
import type {
  ArenaCandidateResult,
  InboxItem,
  RepoConfig,
  SpillArtifact,
  StageRun,
  SystemSetupConfig,
  Ticket,
  WorkerEngineId,
  WorkerStreamEvent,
} from "../types.ts";
import { newId, nowIso } from "../utils.ts";
import type { KernelCoordinatorContext } from "./context.ts";
import { resolveTurnWorkerAuthAndModel } from "./stage-engine-helpers.ts";

export async function cleanupArenaCandidateWorktreesOp(
  ctx: KernelCoordinatorContext,
  candidates: ArenaCandidateResult[],
  rootRepoPath?: string,
  keepCandidateId?: string,
): Promise<void> {
  for (const cand of candidates) {
    if (keepCandidateId && cand.candidateId === keepCandidateId) continue;
    if (cand.worktreePath) {
      await ctx.workspace.cleanupWorkspace(cand.worktreePath, rootRepoPath).catch(() => {});
    }
    if (rootRepoPath && cand.branchName) {
      await ctx.workspace.deleteBranch?.(rootRepoPath, cand.branchName).catch(() => {});
    }
  }
}

export async function adoptArenaCandidateWinnerOp(
  ctx: KernelCoordinatorContext,
  ticket: Ticket,
  repo: RepoConfig | undefined,
  winner: ArenaCandidateResult,
  candidates: ArenaCandidateResult[],
  fromTiebreakInbox = false,
): Promise<Ticket> {
  await ctx.previewProvider?.stopPreviewsForTicket(ticket.id).catch(() => {});
  if (repo) {
    await cleanupArenaCandidateWorktreesOp(ctx, candidates, repo.rootPath, winner.candidateId);
  }
  if (winner.worktreePath && existsSync(winner.worktreePath)) {
    await ctx.workspace.commitAll(
      winner.worktreePath,
      `super-work(${ticket.id}/arena:${winner.engine}): ${ticket.title}`,
    );
  }

  const updatedCandidates = candidates.map((c) => ({
    ...c,
    worktreePath: c.candidateId === winner.candidateId ? winner.worktreePath : undefined,
    recommended: c.candidateId === winner.candidateId,
  }));

  const note = {
    stageRunId: winner.stageRunId,
    stage: "implement" as const,
    engine: winner.engine,
    summary: `[Arena Winner: ${winner.engine}, score ${winner.score}] ${winner.summary}`,
    changedFiles: winner.changedFiles,
    verificationPassed: winner.verificationPassed,
    spillArtifactIds: [
      ...(winner.diffArtifactId ? [winner.diffArtifactId] : []),
      ...(winner.screenshotArtifactIds ?? []),
      ...(winner.visualDiffArtifactIds ?? []),
    ],
    createdAt: nowIso(),
  };

  const nextStage = ticket.prNumber
    ? "rebase"
    : getNextStage(ticket.template, "implement", ticket.tddMode);
  const nextMemory = {
    ...ticket.inlineMemory,
    stageNotes: [...ticket.inlineMemory.stageNotes, note],
    ...(fromTiebreakInbox ? {} : { activeHint: undefined }),
  };

  if (!nextStage) {
    const preDelivery: Ticket = {
      ...ticket,
      worktreePath: winner.worktreePath,
      branchName: winner.branchName,
      activeEngine: undefined,
      failedEngines: [],
      arenaWinnerId: winner.candidateId,
      arenaCandidates: updatedCandidates,
      inlineMemory: nextMemory,
      updatedAt: nowIso(),
    };
    await ctx.enqueueDeliveryOutbox(preDelivery, repo);
    return (await ctx.stateStore.getTicket(ticket.id)) ?? preDelivery;
  }

  const nextTicket: Ticket = {
    ...ticket,
    status: "queued",
    currentStage: nextStage,
    stageRetries: 0,
    worktreePath: winner.worktreePath,
    branchName: winner.branchName,
    activeEngine: undefined,
    failedEngines: [],
    arenaWinnerId: winner.candidateId,
    arenaCandidates: updatedCandidates,
    inlineMemory: nextMemory,
    errorMessage: undefined,
    updatedAt: nowIso(),
  };
  await ctx.stateStore.saveTicket(nextTicket);
  ctx.emitEvent({ type: "ticket_updated", ticket: nextTicket, timestamp: nextTicket.updatedAt });
  return nextTicket;
}

export async function runArenaImplementStageOp(
  ctx: KernelCoordinatorContext,
  ticket: Ticket,
  repo: RepoConfig,
  availableEngines: WorkerEngineId[],
): Promise<boolean> {
  const engineA =
    ticket.activeEngine ?? selectEngineForStage(repo, "implement", ticket.preferredEngine);
  const preferredOpponent = ticket.arenaCompetitorEngine;
  const engineB =
    preferredOpponent &&
    preferredOpponent !== engineA &&
    availableEngines.includes(preferredOpponent) &&
    ctx.drivers.has(preferredOpponent)
      ? preferredOpponent
      : pickNextFallbackEngine({
          currentEngine: engineA,
          repo,
          availableEngines,
        });

  const driverA = ctx.drivers.get(engineA);
  const driverB = engineB ? ctx.drivers.get(engineB) : undefined;
  if (!driverA || !driverB || engineA === engineB) {
    return false;
  }

  const { effectiveBaseBranch } = await ctx.getEffectiveBaseInfo(ticket, repo);
  const arenaStartPoint = ticket.specTestCommitSha ?? effectiveBaseBranch;
  const sameRepoDepBranches: string[] = [];
  for (const depId of ticket.dependsOn) {
    const dep = await ctx.stateStore.getTicket(depId);
    if (dep?.branchName && dep.repoId === ticket.repoId) {
      sameRepoDepBranches.push(dep.branchName);
    }
  }

  const arenaSetupConfig = await ctx.stateStore
    .getSystemSetting<SystemSetupConfig>("setup_config")
    .catch(() => null);
  const candSpec = [
    { id: "cand_a", engine: driverA.engine, driver: driverA, branch: `super-work/${ticket.id}-cand-a` },
    { id: "cand_b", engine: driverB.engine, driver: driverB, branch: `super-work/${ticket.id}-cand-b` },
  ];

  const workspaces: Array<{ worktreePath: string; branchName: string }> = [];
  for (const spec of candSpec) {
    const ws = await ctx.runWithRepoWorkspaceLock(repo.id, async () => {
      const prepared = await ctx.workspace.prepareWorkspace(
        { ...ticket, id: `${ticket.id}_${spec.id}`, worktreePath: undefined, branchName: spec.branch },
        repo,
        { startPoint: arenaStartPoint },
      );
      if (sameRepoDepBranches.length > 0) {
        await ctx.workspace.integrateDependencyBranches(prepared.worktreePath, sameRepoDepBranches);
      }
      return prepared;
    });
    workspaces.push(ws);
  }

  const prompt = await ctx.buildEnrichedWorkerPrompt(ticket, repo, "implement");
  const implementingTicket: Ticket = {
    ...ticket,
    status: "implementing",
    currentStage: "implement",
    activeEngine: engineA,
    updatedAt: nowIso(),
  };
  await ctx.stateStore.saveTicket(implementingTicket);
  ctx.emitEvent({ type: "ticket_updated", ticket: implementingTicket, timestamp: implementingTicket.updatedAt });

  const abortController = new AbortController();
  ctx.abortControllers.set(ticket.id, abortController);

  const runSingleCandidate = async (
    idx: number,
  ): Promise<Omit<ArenaCandidateResult, "score" | "recommended">> => {
    const spec = candSpec[idx]!;
    const ws = workspaces[idx]!;
    const startedMs = Date.now();
    const stageRun: StageRun = {
      id: newId("run"),
      ticketId: ticket.id,
      stage: "implement",
      engine: spec.engine,
      status: "running",
      costUsd: 0,
      startedAt: nowIso(),
    };
    await ctx.stateStore.saveStageRun(stageRun);
    ctx.emitEvent({
      type: "stage_started",
      ticketId: ticket.id,
      stageRun,
      timestamp: stageRun.startedAt,
    });

    const events: WorkerStreamEvent[] = [];
    let completed: Extract<WorkerStreamEvent, { type: "completed" }> | null = null;
    let costUsd = 0;

    try {
      for await (const ev of spec.driver.runTurn(
        {
          ticketId: ticket.id,
          stageRunId: stageRun.id,
          stage: "implement",
          worktreePath: ws.worktreePath,
          prompt,
          mandate: ticket.mandate,
          isResume: false,
          ...resolveTurnWorkerAuthAndModel(spec.engine, ticket, arenaSetupConfig, "implement"),
          sandboxMode: repo.sandboxMode ?? "balanced",
          rootRepoPath: repo.rootPath,
          readOnlyPaths: ticket.lockedTestPaths,
        },
        abortController.signal,
      )) {
        events.push(ev);
        ctx.emitEvent({
          type: "worker_event",
          ticketId: ticket.id,
          stageRunId: stageRun.id,
          engine: spec.engine,
          event: ev,
          timestamp: ev.timestamp,
        });
        if (ev.type === "usage") costUsd = Math.max(costUsd, ev.costUsd);
        if (ev.type === "completed") {
          completed = ev;
          if (typeof ev.costUsd === "number") costUsd = Math.max(costUsd, ev.costUsd);
        }
      }
    } catch (err) {
      events.push({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
        fatal: true,
        timestamp: nowIso(),
      });
    }

    const rawChanged = await ctx.workspace.getChangedFiles(ws.worktreePath, effectiveBaseBranch);
    if (
      ticket.lockedTestPaths &&
      ticket.lockedTestPaths.length > 0 &&
      ticket.specTestCommitSha &&
      ctx.workspace.getChangedFilesSince
    ) {
      const sinceSpec = await ctx.workspace.getChangedFilesSince(
        ws.worktreePath,
        ticket.specTestCommitSha,
      );
      const tampered = sinceSpec.filter((f) => ticket.lockedTestPaths!.includes(f));
      if (tampered.length > 0) {
        await ctx.workspace.revertPathsToCommit?.(
          ws.worktreePath,
          ticket.specTestCommitSha,
          tampered,
        );
      }
    }
    const filesForArenaMandate =
      ticket.lockedTestPaths && ticket.lockedTestPaths.length > 0
        ? rawChanged.filter((f) => !ticket.lockedTestPaths!.includes(f))
        : rawChanged;
    const mandateCheck = validateChangedFilesAgainstMandate(filesForArenaMandate, ticket.mandate);
    if (!mandateCheck.ok) {
      await ctx.workspace.revertPaths(ws.worktreePath, mandateCheck.violations);
    }

    const changedFiles = await ctx.workspace.getChangedFiles(ws.worktreePath, effectiveBaseBranch);
    const diffText = await ctx.workspace.getDiff(ws.worktreePath, effectiveBaseBranch);
    const { addedLines, deletedLines } = countDiffLines(diffText);

    const gate = mandateCheck.ok
      ? await ctx.runRepoVerificationGate(ticket, repo, stageRun, ws.worktreePath, {
          isFinalDeliveryGate: false,
        })
      : { passed: false, artifacts: [] as SpillArtifact[], result: undefined, spans: undefined };

    const lastErr = [...events].reverse().find((e) => e.type === "error");
    const verificationPassed = mandateCheck.ok && !lastErr && gate.passed;
    const verificationSummary = !mandateCheck.ok
      ? `Mandate violation: ${mandateCheck.violations.join(", ")}`
      : lastErr && lastErr.type === "error"
        ? `Turn error: ${lastErr.message}`
        : gate.result?.summary ?? (gate.passed ? "Verification passed" : "Verification failed");

    const textSummary =
      completed?.summary ||
      events
        .filter((e): e is Extract<WorkerStreamEvent, { type: "text" }> => e.type === "text")
        .map((e) => e.text)
        .join("\n") ||
      `${spec.engine} candidate`;

    const finishedRun: StageRun = {
      ...stageRun,
      status: verificationPassed ? "completed" : "failed",
      costUsd,
      completedAt: nowIso(),
      summary: `[Arena ${spec.id}] ${verificationSummary}`,
      ...(gate.spans ? { spans: gate.spans } : {}),
    };

    const { note } = await ctx.memory.recordStageSpillAndNote({
      ticket,
      stageRun: finishedRun,
      events,
      changedFiles,
      diffText,
      summary: textSummary,
      verificationPassed,
      extraArtifacts: gate.artifacts.length > 0 ? gate.artifacts : undefined,
    });
    finishedRun.spillTranscriptId = note.spillArtifactIds[0];
    await ctx.stateStore.saveStageRun(finishedRun);
    ctx.emitEvent({
      type: "stage_completed",
      ticketId: ticket.id,
      stageRun: finishedRun,
      note,
      timestamp: finishedRun.completedAt!,
    });

    const diffArtifactId = note.spillArtifactIds.find((aid, i) => i > 0 && aid);
    let recordedDiffId = diffArtifactId;
    if (!recordedDiffId && diffText.trim()) {
      const diffArt = await ctx.artifactStore.writeSpill(
        {
          ticketId: ticket.id,
          stageRunId: stageRun.id,
          kind: "diff",
          summary: `Arena ${spec.engine} candidate diff`,
          ext: "patch",
        },
        diffText,
      );
      await ctx.stateStore.saveArtifact(diffArt, changedFiles.join(" "));
      recordedDiffId = diffArt.id;
    }

    const screenshotArtifactIds = gate.artifacts
      .filter((a) => a.kind === "screenshot")
      .map((a) => a.id);
    const visualDiffArtifactIds = gate.artifacts
      .filter((a) => a.kind === "visual_diff")
      .map((a) => a.id);

    return {
      candidateId: spec.id,
      engine: spec.engine,
      branchName: ws.branchName,
      worktreePath: ws.worktreePath,
      stageRunId: stageRun.id,
      verificationPassed,
      verificationSummary,
      changedFiles,
      addedLines,
      deletedLines,
      durationMs: Math.max(1, Date.now() - startedMs),
      costUsd,
      summary: textSummary.slice(0, 400),
      diffArtifactId: recordedDiffId,
      ...(screenshotArtifactIds.length > 0 ? { screenshotArtifactIds } : {}),
      ...(visualDiffArtifactIds.length > 0 ? { visualDiffArtifactIds } : {}),
    };
  };

  const [rawA, rawB] = await Promise.all([runSingleCandidate(0), runSingleCandidate(1)]);
  const totalArenaCost = rawA.costUsd + rawB.costUsd;
  let scored = scoreArenaCandidates(rawA, rawB);

  if (scored[0].verificationPassed && scored[1].verificationPassed && ctx.llm.judgeArenaCandidates) {
    try {
      const judgment = await ctx.llm.judgeArenaCandidates({
        repo,
        ticket: implementingTicket,
        candidates: scored,
      });
      if (judgment && (judgment.winnerCandidateId === "cand_a" || judgment.winnerCandidateId === "cand_b")) {
        scored = scored.map((c) => ({
          ...c,
          recommended: c.candidateId === judgment.winnerCandidateId,
          rationale:
            c.candidateId === judgment.winnerCandidateId
              ? `${judgment.rationale} (${c.rationale ?? ""})`.trim()
              : c.rationale,
        })) as [ArenaCandidateResult, ArenaCandidateResult];
      }
    } catch {
      // Keep deterministic score winner
    }
  }

  const updatedWithCost: Ticket = {
    ...implementingTicket,
    costUsd: ticket.costUsd + totalArenaCost,
    arenaCandidates: scored,
    updatedAt: nowIso(),
  };

  const passCount = scored.filter((c) => c.verificationPassed).length;
  const recommended = scored.find((c) => c.recommended) ?? scored[0];

  if (passCount === 1 || (passCount === 2 && repo.mode === "auto")) {
    await adoptArenaCandidateWinnerOp(ctx, updatedWithCost, repo, recommended, scored, false);
    return true;
  }

  if (passCount === 2 && repo.mode === "observe") {
    await ctx.stateStore.saveTicket({
      ...updatedWithCost,
      status: "needs_human",
      activeEngine: undefined,
      errorMessage: "Arena duel finished with two passing candidates; choose winner in Inbox.",
    });
    ctx.emitEvent({
      type: "ticket_updated",
      ticket: { ...updatedWithCost, status: "needs_human", activeEngine: undefined },
      timestamp: nowIso(),
    });
    const inboxItem: InboxItem = {
      id: newId("inb"),
      repoId: repo.id,
      ticketId: ticket.id,
      kind: "arena_tiebreak",
      status: "pending",
      title: `Arena Duel Ready: ${ticket.title}`,
      summary: `Both ${scored[0].engine} (score ${scored[0].score}) and ${scored[1].engine} (score ${scored[1].score}) passed all verification gates. Compare diffs and adopt the winning branch.`,
      contextPayload: {
        recommendedCandidateId: recommended.candidateId,
        candidates: scored,
      },
      createdAt: nowIso(),
    };
    await ctx.stateStore.saveInboxItem(inboxItem);
    ctx.emitEvent({ type: "inbox_created", item: inboxItem, timestamp: inboxItem.createdAt });
    return true;
  }

  await cleanupArenaCandidateWorktreesOp(ctx, scored, repo.rootPath, recommended.candidateId);
  await ctx.escalateTicket(
    {
      ...updatedWithCost,
      worktreePath: recommended.worktreePath,
      branchName: recommended.branchName,
    },
    "watchdog_escalation",
    `Both Arena candidates failed verification:\n- ${scored[0].engine}: ${scored[0].verificationSummary}\n- ${scored[1].engine}: ${scored[1].verificationSummary}`,
    { candidates: scored },
  );
  return true;
}
