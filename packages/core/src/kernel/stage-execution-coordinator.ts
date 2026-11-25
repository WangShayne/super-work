import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pickNextFallbackEngine, resolveFallbackChain } from "../arena.ts";
import { buildConflictResolutionPrompt } from "../conflict-resolver.ts";
import {
  computeEngineRoutingDecision,
  isSpecTestFilePath,
  isUiIntentTicket,
  parseSpecTestChallenge,
} from "../engine-router.ts";
import { createDefaultMandate, validateChangedFilesAgainstMandate } from "../mandate.ts";
import {
  getAlternateEngine,
  getFirstStage,
  getNextStage,
  getPipelineTemplate,
  selectEngineForStage,
  selectReviewEngine,
  statusForStage,
} from "../pipeline.ts";
import {
  formatBlockingFindingsForRework,
  formatNitSummary,
  parseReviewReport,
} from "../review.ts";
import { buildStageToolProfile, extractWorkerClarificationRequest } from "../tool-profiler.ts";
import type {
  ConflictSemanticContext,
  InboxItem,
  RepoConfig,
  ReviewReport,
  ScopedVerificationInfo,
  SmokeCheckResult,
  SpillArtifact,
  StageKind,
  StageRun,
  StageSpan,
  SystemSetupConfig,
  Ticket,
  TicketCheckpoint,
  VerificationRunResult,
  WatchdogDecision,
  WatchdogSignal,
  WorkerEngineId,
  WorkerStreamEvent,
} from "../types.ts";
import { newId, nowIso } from "../utils.ts";
import { runArenaImplementStageOp } from "./arena-coordinator.ts";
import type { KernelCoordinatorContext } from "./context.ts";
import {
  autoResolveModifiedReviewComments,
  syncAiFindingsToReviewComments,
} from "./review-comments-coordinator.ts";
import { SpanRecorder } from "./span-recorder.ts";

function utcTodayString(): string {
  return new Date().toISOString().slice(0, 10);
}

async function mergeWaveToTargetStagingBranch(
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
      commitMessage: `campaign(${ticket.campaignId}/w${ticket.campaignWave ?? 1}): ${ticket.title}`,
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
  await ctx.onCampaignTicketSettled(deliveredWave, repo);
}

async function failCampaignWaveTicket(
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

export async function ensureVisualBaselineDirOp(
  ctx: KernelCoordinatorContext,
  repo: RepoConfig,
  smokeCfg: NonNullable<RepoConfig["smokeCheck"]>,
): Promise<string | undefined> {
  if (!smokeCfg.browserCheck?.enabled) return undefined;
  const diffMode = smokeCfg.browserCheck.visualDiffMode ?? "auto";
  if (diffMode === "off") return undefined;
  if (!ctx.workspace.getHeadCommitSha || !ctx.workspace.runSmokeCheck) return undefined;

  const baseSha = await ctx.workspace
    .getHeadCommitSha(repo.rootPath, repo.baseBranch)
    .catch(() => "");
  if (!baseSha) return undefined;

  const cacheDir = resolve(ctx.dataDir, "visual-baselines", repo.id, baseSha);
  if (existsSync(join(cacheDir, "route_0.png"))) {
    return cacheDir;
  }
  if (existsSync(join(cacheDir, ".skip"))) {
    return undefined;
  }

  const tempId = `vbase_${repo.id.slice(-6)}_${baseSha.slice(0, 8)}_${Date.now().toString(36)}`;
  const tempBranch = `super-work/${tempId}`;
  const syntheticTicket: Ticket = {
    id: tempId,
    repoId: repo.id,
    threadId: `thr_${tempId}`,
    sourceTriggerId: `trg_${tempId}`,
    title: `[Visual Baseline] ${baseSha.slice(0, 8)}`,
    description: "Lazy visual diff baseline capture",
    status: "implementing",
    template: "fast",
    currentStage: "implement",
    stageRetries: 0,
    mandate: createDefaultMandate(),
    dependsOn: [],
    branchName: tempBranch,
    nativeSessions: {},
    inlineMemory: {
      goal: "Baseline screenshot capture",
      acceptanceCriteria: [],
      stageNotes: [],
      threadUpdates: [],
    },
    costUsd: 0,
    priority: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  let ws: { worktreePath: string; branchName: string };
  try {
    ws = await ctx.runWithRepoWorkspaceLock(repo.id, () =>
      ctx.workspace.prepareWorkspace(syntheticTicket, repo, { startPoint: baseSha }),
    );
  } catch {
    return undefined;
  }

  try {
    if (existsSync(join(cacheDir, "route_0.png"))) {
      return cacheDir;
    }
    if (existsSync(join(cacheDir, ".skip"))) {
      return undefined;
    }
    const baseSmoke = await ctx.workspace.runSmokeCheck(ws.worktreePath, smokeCfg);
    mkdirSync(cacheDir, { recursive: true });
    if (baseSmoke.ok && baseSmoke.rawScreenshots && baseSmoke.rawScreenshots.length > 0) {
      for (const shot of baseSmoke.rawScreenshots) {
        writeFileSync(join(cacheDir, `route_${shot.routeIndex}.png`), shot.bytes);
      }
      return cacheDir;
    }
    writeFileSync(join(cacheDir, ".skip"), baseSmoke.summary || "no baseline screenshot");
    return undefined;
  } catch {
    try {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, ".skip"), "baseline capture error");
    } catch {
      // Ignore cache write errors
    }
    return undefined;
  } finally {
    await ctx.runWithRepoWorkspaceLock(repo.id, async () => {
      await ctx.workspace.cleanupWorkspace(ws.worktreePath, repo.rootPath).catch(() => {});
      await ctx.workspace.deleteBranch?.(repo.rootPath, ws.branchName).catch(() => {});
    });
  }
}

const FINAL_GATE_FULL_REASON = "final delivery gate enforces full verification";

/**
 * Decides which commands the static gate executes. Only repos opted into
 * `impact_scoped` ever get a `scopedVerification` record; the default
 * (`always_full`) path returns the configured commands untouched.
 * Final delivery gates (rebase, unified-epic final, merge train) never narrow.
 */
async function resolveGateCommands(
  ctx: KernelCoordinatorContext,
  ticket: Ticket,
  repo: RepoConfig,
  worktreePath: string,
  commands: string[],
  options?: { isFinalDeliveryGate?: boolean },
): Promise<{ commandsToRun: string[]; scopedVerification?: ScopedVerificationInfo }> {
  if (repo.verificationStrategy !== "impact_scoped") {
    return { commandsToRun: commands };
  }

  const full = (reason: string) => ({
    commandsToRun: commands,
    scopedVerification: { usedScoped: false, commandsRun: commands, reason },
  });

  if (options?.isFinalDeliveryGate === true) {
    return full(FINAL_GATE_FULL_REASON);
  }
  if (!ctx.workspace.resolveScopedVerification) {
    return full("workspace provider does not support scoped verification");
  }

  try {
    const resolved = await ctx.workspace.resolveScopedVerification({
      rootRepoPath: repo.rootPath,
      worktreePath,
      baseBranch: ticket.targetBranch ?? repo.baseBranch,
      fullCommands: commands,
      sensitivePaths: repo.sensitivePaths,
    });
    if (resolved.useScoped && resolved.commands.length > 0) {
      return {
        commandsToRun: resolved.commands,
        scopedVerification: {
          usedScoped: true,
          commandsRun: resolved.commands,
          skippedFullCommands: commands,
          estimatedSavedMs: resolved.estimatedSavedMs,
          reason: resolved.reason,
        },
      };
    }
    return full(resolved.reason);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return full(`scoped planner failed (${msg.slice(0, 160)}); ran full verification`);
  }
}

export async function runRepoVerificationGateOp(
  ctx: KernelCoordinatorContext,
  ticket: Ticket,
  repo: RepoConfig,
  stageRun: StageRun,
  worktreePath: string,
  options?: { isFinalDeliveryGate?: boolean },
): Promise<{
  passed: boolean;
  artifacts: SpillArtifact[];
  result?: VerificationRunResult;
  spans?: StageSpan[];
}> {
  const spans = new SpanRecorder();
  const artifacts: SpillArtifact[] = [];
  const commands = (repo.verificationCommands ?? []).map((c) => c.trim()).filter(Boolean);
  let staticResult: VerificationRunResult | undefined;

  if (commands.length > 0) {
    const { commandsToRun, scopedVerification } = await resolveGateCommands(
      ctx,
      ticket,
      repo,
      worktreePath,
      commands,
      options,
    );
    const usedScoped = scopedVerification?.usedScoped === true;
    const staticSpan = spans.start(
      "static_verify",
      `Static verify (${commandsToRun.length} cmd${usedScoped ? ", scoped" : ""})`,
    );
    const rawResult = await ctx.workspace.runVerificationCommands(
      worktreePath,
      commandsToRun,
      ticket.mandate.maxDurationSec,
      {
        sandboxMode: repo.sandboxMode ?? "balanced",
        forbiddenPaths: ticket.mandate.forbiddenPaths,
        readOnlyPaths: stageRun.stage === "implement" ? ticket.lockedTestPaths : undefined,
        allowNetwork: ticket.mandate.allowNetwork,
        rootRepoPath: repo.rootPath,
      },
    );
    staticResult = scopedVerification ? { ...rawResult, scopedVerification } : rawResult;
    if (scopedVerification?.usedScoped) {
      await ctx.recordFlightEvent?.({
        repoId: repo.id,
        ticketId: ticket.id,
        kind: "scoped_gate_run",
        summary: `Impact-scoped gate ran ${commandsToRun.length} cmd(s); ${scopedVerification.reason}`,
        savedMs: scopedVerification.estimatedSavedMs,
        metadata: {
          stage: stageRun.stage,
          ok: rawResult.ok,
          commandsRun: scopedVerification.commandsRun,
          skippedFullCommands: scopedVerification.skippedFullCommands,
        },
      });
    }
    spans.end(staticSpan, staticResult.ok ? "ok" : "failed", staticResult.failedCommand);

    const commandLogBody = staticResult.results
      .map(
        (r) =>
          `$ ${r.command}\n[exit=${r.exitCode}, duration=${r.durationMs}ms]\n${r.output || "(no output)"}\n`,
      )
      .join("\n---\n");
    const scopedHeader =
      scopedVerification && usedScoped
        ? `[scoped gate] ${scopedVerification.reason}\n[skipped full commands] ${(scopedVerification.skippedFullCommands ?? []).join(" && ")}\n\n`
        : "";
    const logBody = commandLogBody ? `${scopedHeader}${commandLogBody}` : "";

    const testArtifact = await ctx.artifactStore.writeSpill(
      {
        ticketId: ticket.id,
        stageRunId: stageRun.id,
        kind: "test_log",
        summary: `${staticResult.ok ? "PASS" : "FAIL"} verification${usedScoped ? " [scoped]" : ""} (${commandsToRun.join(" && ")})`,
        ext: "log",
      },
      logBody || staticResult.summary,
    );
    await ctx.stateStore.saveArtifact(testArtifact, `${staticResult.summary}\n${logBody}`);
    artifacts.push(testArtifact);

    if (!staticResult.ok) {
      ctx.emitEvent({
        type: "verification_completed",
        ticketId: ticket.id,
        stageRunId: stageRun.id,
        result: staticResult,
        timestamp: nowIso(),
      });
      return { passed: false, artifacts, result: staticResult, spans: spans.toArray() };
    }
  }

  const smokeCfg = repo.smokeCheck;
  const smokeTriggerMode = smokeCfg?.triggerMode ?? "every_gate";
  const shouldRunSmoke = Boolean(
    smokeCfg?.enabled &&
      smokeCfg.startCommand?.trim() &&
      ctx.workspace.runSmokeCheck &&
      (smokeTriggerMode === "every_gate" || options?.isFinalDeliveryGate),
  );

  if (!shouldRunSmoke) {
    if (staticResult) {
      ctx.emitEvent({
        type: "verification_completed",
        ticketId: ticket.id,
        stageRunId: stageRun.id,
        result: staticResult,
        timestamp: nowIso(),
      });
    }
    return { passed: true, artifacts, result: staticResult, spans: spans.toArray() };
  }

  const smokeSpan = spans.start(
    "smoke_cdp",
    smokeCfg?.browserCheck?.enabled ? "Smoke server & CDP check" : "Smoke server check",
  );
  const smokeRes = await ctx.workspace.runSmokeCheck!(worktreePath, smokeCfg!, {
    resolveBaselineScreenshotsDir: () =>
      ensureVisualBaselineDirOp(ctx, repo, smokeCfg!).catch(() => undefined),
  });
  spans.end(smokeSpan, smokeRes.ok ? "ok" : "failed", smokeRes.failedStep ?? smokeRes.readyUrl);

  if (
    smokeRes.rawScreenshots &&
    smokeRes.rawScreenshots.length > 0 &&
    ctx.artifactStore.writeBinarySpill
  ) {
    for (const shot of smokeRes.rawScreenshots) {
      try {
        const shotArt = await ctx.artifactStore.writeBinarySpill(
          {
            ticketId: ticket.id,
            stageRunId: stageRun.id,
            kind: "screenshot",
            summary: `Browser gate screenshot (${shot.path})`,
            ext: "png",
          },
          shot.bytes,
        );
        await ctx.stateStore.saveArtifact(
          shotArt,
          `screenshot ${shot.path} ${smokeRes.browserResult?.summary ?? ""}`,
        );
        artifacts.push(shotArt);
        const routeObj = smokeRes.browserResult?.routes?.[shot.routeIndex];
        if (routeObj) {
          routeObj.screenshotArtifactId = shotArt.id;
        }
      } catch {
        // Non-fatal
      }
    }
  }

  if (
    smokeRes.rawVisualDiffs &&
    smokeRes.rawVisualDiffs.length > 0 &&
    ctx.artifactStore.writeBinarySpill
  ) {
    for (const vd of smokeRes.rawVisualDiffs) {
      try {
        const vdArt = await ctx.artifactStore.writeBinarySpill(
          {
            ticketId: ticket.id,
            stageRunId: stageRun.id,
            kind: "visual_diff",
            summary: `Visual diff (${vd.path}, ${(vd.diffRatio * 100).toFixed(2)}% changed)`,
            ext: "png",
          },
          vd.bytes,
        );
        await ctx.stateStore.saveArtifact(
          vdArt,
          `visual_diff ${vd.path} diffRatio=${vd.diffRatio.toFixed(6)}`,
        );
        artifacts.push(vdArt);
        const routeObj = smokeRes.browserResult?.routes?.[vd.routeIndex];
        if (routeObj) {
          routeObj.visualDiffArtifactId = vdArt.id;
        }
      } catch {
        // Non-fatal
      }
    }
  }

  const sanitizedSmokeRes: SmokeCheckResult = {
    ...smokeRes,
    rawScreenshots: undefined,
    rawVisualDiffs: undefined,
  };
  delete sanitizedSmokeRes.rawScreenshots;
  delete sanitizedSmokeRes.rawVisualDiffs;

  const visualSpan = sanitizedSmokeRes.browserResult?.routes?.some(
    (r) => typeof r.diffRatio === "number",
  )
    ? spans.start("visual_diff", "Visual pixel diff evaluation")
    : null;

  const visualDiffMode = smokeCfg!.browserCheck?.visualDiffMode ?? "auto";
  const maxDiffRatio = smokeCfg!.browserCheck?.maxVisualDiffRatio ?? 0.02;
  if (
    sanitizedSmokeRes.ok &&
    visualDiffMode !== "off" &&
    visualDiffMode !== "informational" &&
    sanitizedSmokeRes.browserResult?.routes
  ) {
    const exceededRoute = sanitizedSmokeRes.browserResult.routes.find(
      (r) => typeof r.diffRatio === "number" && r.diffRatio > maxDiffRatio,
    );
    if (exceededRoute) {
      const shouldBlock =
        visualDiffMode === "enforce" ||
        (visualDiffMode === "auto" &&
          !isUiIntentTicket({
            title: ticket.title,
            description: ticket.description,
          }));
      if (shouldBlock) {
        exceededRoute.ok = false;
        sanitizedSmokeRes.ok = false;
        sanitizedSmokeRes.failedStep = "smoke:visualDiff";
        sanitizedSmokeRes.summary = `Visual regression on ${exceededRoute.path} (${(exceededRoute.diffRatio! * 100).toFixed(2)}% > ${(maxDiffRatio * 100).toFixed(2)}% threshold in '${visualDiffMode}' mode)`;
        if (sanitizedSmokeRes.browserResult) {
          sanitizedSmokeRes.browserResult.ok = false;
          sanitizedSmokeRes.browserResult.summary = sanitizedSmokeRes.summary;
        }
      }
    }
  }
  if (visualSpan) {
    const visualBlocked = sanitizedSmokeRes.failedStep === "smoke:visualDiff";
    spans.end(
      visualSpan,
      visualBlocked ? "failed" : "ok",
      visualBlocked ? sanitizedSmokeRes.summary : undefined,
    );
  }

  const smokeLogLines = [
    `Start Command: ${smokeCfg!.startCommand}`,
    `Ready URL: ${sanitizedSmokeRes.readyUrl}`,
    `Port: ${sanitizedSmokeRes.port}`,
    `Startup Duration: ${sanitizedSmokeRes.startupDurationMs}ms`,
    sanitizedSmokeRes.probeStatus !== undefined ? `Probe Status: ${sanitizedSmokeRes.probeStatus}` : "",
    `Result: ${sanitizedSmokeRes.ok ? "PASS" : "FAIL"} — ${sanitizedSmokeRes.summary}`,
    sanitizedSmokeRes.browserResult
      ? `Browser Check: ${sanitizedSmokeRes.browserResult.summary}`
      : "",
    sanitizedSmokeRes.checkResults.length > 0
      ? "\nCheck Commands:\n" +
        sanitizedSmokeRes.checkResults
          .map(
            (r) =>
              `$ ${r.command}\n[exit=${r.exitCode}, duration=${r.durationMs}ms]\n${r.output || "(no output)"}`,
          )
          .join("\n---\n")
      : "",
    sanitizedSmokeRes.serverOutputTail ? `\nServer Output Tail:\n${sanitizedSmokeRes.serverOutputTail}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const smokeArtifact = await ctx.artifactStore.writeSpill(
    {
      ticketId: ticket.id,
      stageRunId: stageRun.id,
      kind: "smoke_log",
      summary: `${sanitizedSmokeRes.ok ? "PASS" : "FAIL"} smoke check (${sanitizedSmokeRes.readyUrl})`,
      ext: "log",
    },
    smokeLogLines,
  );
  await ctx.stateStore.saveArtifact(smokeArtifact, smokeLogLines);
  artifacts.push(smokeArtifact);

  const combinedResult: VerificationRunResult = {
    ok: sanitizedSmokeRes.ok,
    results: [...(staticResult?.results ?? []), ...sanitizedSmokeRes.checkResults],
    failedCommand: sanitizedSmokeRes.ok
      ? undefined
      : (sanitizedSmokeRes.failedStep ?? `smoke:${smokeCfg!.startCommand}`),
    summary: sanitizedSmokeRes.ok
      ? [staticResult?.summary, sanitizedSmokeRes.summary].filter(Boolean).join("\n")
      : `Smoke check failed (${sanitizedSmokeRes.failedStep ?? smokeCfg!.startCommand}): ${sanitizedSmokeRes.summary}`,
    smokeResult: sanitizedSmokeRes,
    ...(staticResult?.scopedVerification
      ? { scopedVerification: staticResult.scopedVerification }
      : {}),
  };

  ctx.emitEvent({
    type: "verification_completed",
    ticketId: ticket.id,
    stageRunId: stageRun.id,
    result: combinedResult,
    timestamp: nowIso(),
  });

  return { passed: sanitizedSmokeRes.ok, artifacts, result: combinedResult, spans: spans.toArray() };
}

export async function runTicketStageOp(
  ctx: KernelCoordinatorContext,
  ticketId: string,
): Promise<void> {
  let ticket = await ctx.stateStore.getTicket(ticketId);
  if (!ticket || ticket.status !== "queued") return;

  const repo = await ctx.stateStore.getRepo(ticket.repoId);
  if (!repo) return;

  const stage = ticket.currentStage || getFirstStage(ticket.template, ticket.tddMode);

  if (ticket.pauseBeforeRun) {
    const pauseTs = nowIso();
    const paused: Ticket = {
      ...ticket,
      pauseBeforeRun: false,
      status: "needs_human",
      errorMessage: `Paused at DAG breakpoint before '${stage}' stage`,
      updatedAt: pauseTs,
    };
    await ctx.stateStore.saveTicket(paused);
    ctx.emitEvent({ type: "ticket_updated", ticket: paused, timestamp: pauseTs });
    const bpInbox: InboxItem = {
      id: newId("inb"),
      repoId: repo.id,
      ticketId: ticket.id,
      kind: "plan_approval",
      status: "pending",
      title: `DAG Breakpoint: ${ticket.title}`,
      summary: `Execution paused before '${stage}' stage per DAG breakpoint. Approve to resume (optionally include steering guidance).`,
      contextPayload: { isDagBreakpoint: true, stage },
      createdAt: pauseTs,
    };
    await ctx.stateStore.saveInboxItem(bpInbox);
    ctx.emitEvent({ type: "inbox_created", item: bpInbox, timestamp: pauseTs });
    return;
  }

  const availableEngines = await ctx.getAvailableEngines();

  const wantsAutoRouting =
    ticket.preferredEngine === "auto" ||
    (!ticket.preferredEngine && repo.preferredImplementEngine === "auto");
  if (wantsAutoRouting && !ticket.activeEngine && (stage === "spec_test" || stage === "implement")) {
    const currentTicket = ticket;
    const failedSet = currentTicket.failedEngines ?? [];
    const eligibleEngines = availableEngines.filter((e) => !failedSet.includes(e));
    const [repoTickets, casebookEntries] = await Promise.all([
      ctx.stateStore.listTickets({ repoId: repo.id }),
      ctx.stateStore.listCasebookEntries(repo.id, { includeReverted: true }),
    ]);
    const historicalTickets = repoTickets.filter((t) => t.id !== currentTicket.id);
    const runsLists = await Promise.all(
      historicalTickets.map((t) => ctx.stateStore.listStageRuns(t.id)),
    );
    const oneHourAgoMs = Date.now() - 3_600_000;
    const recentAutoArenaCountLastHour = historicalTickets.filter(
      (t) => t.autoArenaEscalated && Date.parse(t.createdAt) >= oneHourAgoMs,
    ).length;
    const today = utcTodayString();
    const effectiveDailyBudgetUsd = ctx.getEffectiveDailyBudget(repo, today);
    const todaySpendUsd =
      effectiveDailyBudgetUsd !== undefined
        ? await ctx.stateStore.getDailyRepoSpendUsd(repo.id, today)
        : 0;
    const routing = computeEngineRoutingDecision({
      repo,
      ticket,
      availableEngines: eligibleEngines.length > 0 ? eligibleEngines : availableEngines,
      historicalTickets,
      historicalStageRuns: runsLists.flat(),
      casebookEntries,
      todaySpendUsd,
      effectiveDailyBudgetUsd,
      recentAutoArenaCountLastHour,
    });
    ticket = {
      ...ticket,
      activeEngine: routing.chosenEngine,
      taskCategory: routing.category,
      routingRationale: routing.rationale,
      ...(stage === "implement" && routing.autoUpgradeArena && !ticket.arenaMode
        ? {
            arenaMode: true,
            arenaCompetitorEngine: routing.competitorEngine,
            autoArenaEscalated: true,
          }
        : {}),
      updatedAt: nowIso(),
    };
    await ctx.stateStore.saveTicket(ticket);
    ctx.emitEvent({ type: "ticket_updated", ticket, timestamp: ticket.updatedAt });
  }

  if (ticket.arenaMode && stage === "implement" && !ticket.arenaWinnerId) {
    const arenaHandled = await runArenaImplementStageOp(ctx, ticket, repo, availableEngines);
    if (arenaHandled) {
      return;
    }
  }

  let chosenEngine: WorkerEngineId;
  if (stage === "review") {
    const priorRuns = await ctx.stateStore.listStageRuns(ticket.id);
    const lastImplRun = [...priorRuns]
      .reverse()
      .find((r) => r.stage === "implement" && r.status === "completed");
    const rawImplPref =
      lastImplRun?.engine ?? ticket.preferredEngine ?? repo.preferredImplementEngine;
    const implementEngine: WorkerEngineId =
      rawImplPref === "auto" ? selectEngineForStage(repo, "implement") : rawImplPref;
    chosenEngine = selectReviewEngine({
      repo,
      implementEngine,
      availableEngines,
      explicitWatchdogEngine: ticket.activeEngine,
    });
  } else {
    const explicitEngine = ticket.activeEngine ?? ticket.preferredEngine;
    chosenEngine = selectEngineForStage(repo, stage, explicitEngine);
    if (!ticket.activeEngine && (ticket.failedEngines ?? []).includes(chosenEngine)) {
      chosenEngine =
        pickNextFallbackEngine({
          currentEngine: chosenEngine,
          failedEngines: ticket.failedEngines,
          repo,
          availableEngines,
        }) ?? chosenEngine;
    }
  }

  let driver = ctx.drivers.get(chosenEngine);
  if (!driver) {
    const chain = resolveFallbackChain({
      primaryEngine: chosenEngine,
      repo,
      availableEngines,
      failedEngines: ticket.failedEngines,
    });
    const alt = chain[0] ?? availableEngines[0];
    driver = alt ? ctx.drivers.get(alt) : undefined;
  }

  if (!driver) {
    await ctx.escalateTicket(
      ticket,
      "watchdog_escalation",
      `No WorkerDriver available for engine '${chosenEngine}'`,
      { chosenEngine },
    );
    return;
  }

  const spans = new SpanRecorder();
  const prepSpan = spans.start("workspace_prep", `Prepare worktree (${stage})`);
  const { effectiveBaseBranch } = await ctx.getEffectiveBaseInfo(ticket, repo);
  const hadWorktree = Boolean(ticket.worktreePath);
  const threadObj = !hadWorktree ? await ctx.stateStore.getThread(ticket.threadId) : null;
  const forkStartPoint =
    typeof threadObj?.metadata?.forkStartPoint === "string"
      ? threadObj.metadata.forkStartPoint
      : undefined;
  const lockedTicket = ticket;
  let ws: { worktreePath: string; branchName: string };
  try {
    ws = await ctx.runWithRepoWorkspaceLock(repo.id, () =>
      ctx.workspace.prepareWorkspace(lockedTicket, repo, {
        startPoint: forkStartPoint ?? effectiveBaseBranch,
      }),
    );
  } catch (err) {
    spans.end(prepSpan, "failed", err instanceof Error ? err.message : String(err));
    await ctx.escalateTicket(
      ticket,
      "watchdog_escalation",
      err instanceof Error ? err.message : String(err),
      { stage, phase: "prepare_workspace" },
    );
    return;
  }
  if (!hadWorktree && ticket.dependsOn.length > 0) {
    const depBranches: string[] = [];
    for (const depId of ticket.dependsOn) {
      const dep = await ctx.stateStore.getTicket(depId);
      if (dep?.branchName && dep.repoId === ticket.repoId) {
        depBranches.push(dep.branchName);
      }
    }
    if (depBranches.length > 0) {
      await ctx.workspace.integrateDependencyBranches(ws.worktreePath, depBranches);
    }
  }
  spans.end(prepSpan, "ok", ws.branchName);
  const existingSessionId =
    stage === "review" ? undefined : ticket.nativeSessions[driver.engine];
  const stageRun: StageRun = {
    id: newId("run"),
    ticketId: ticket.id,
    stage,
    engine: driver.engine,
    status: "running",
    nativeSessionId: existingSessionId,
    costUsd: 0,
    startedAt: nowIso(),
  };

  ticket = {
    ...ticket,
    status: statusForStage(stage),
    currentStage: stage,
    activeEngine: driver.engine,
    worktreePath: ws.worktreePath,
    branchName: ws.branchName,
    updatedAt: nowIso(),
  };
  await ctx.stateStore.saveTicket(ticket);
  await ctx.stateStore.saveStageRun(stageRun);
  ctx.emitEvent({ type: "ticket_updated", ticket, timestamp: ticket.updatedAt });
  ctx.emitEvent({ type: "stage_started", ticketId: ticket.id, stageRun, timestamp: stageRun.startedAt });

  if (!hadWorktree) {
    await ctx.captureTicketCheckpoint(ticket, repo, ws.worktreePath, {
      stage: "baseline",
      label: forkStartPoint
        ? `Forked baseline (${forkStartPoint.slice(0, 8)})`
        : `Initial baseline (${effectiveBaseBranch})`,
      changedFiles: [],
    });
  }

  if (stage === "rebase") {
    await handleRebaseStageOp(ctx, ticket, repo, stageRun);
    return;
  }

  const prompt = await ctx.buildEnrichedWorkerPrompt(ticket, repo, stage);

  const setupConfig = await ctx.stateStore.getSystemSetting<SystemSetupConfig>("setup_config");
  const engineProfile =
    driver.engine === "claude"
      ? setupConfig?.claudeProfile
      : driver.engine === "codex"
        ? setupConfig?.codexProfile
        : driver.engine === "opencode"
          ? setupConfig?.opencodeProfile
          : driver.engine === "gemini"
            ? setupConfig?.geminiProfile
            : undefined;
  const canApplyModelOverride = Boolean(
    ticket.modelOverride &&
      stage !== "review" &&
      (!ticket.preferredEngine || ticket.preferredEngine === driver.engine),
  );
  const effectiveModel = canApplyModelOverride ? ticket.modelOverride : engineProfile?.model;
  const effectiveEffort =
    stage !== "review" && ticket.effortOverride
      ? ticket.effortOverride
      : engineProfile?.effort;

  const abortController = new AbortController();
  ctx.abortControllers.set(ticket.id, abortController);

  const tracker = ctx.watchdog.createTracker(stageRun, ticket.mandate);
  const collectedEvents: WorkerStreamEvent[] = [];
  let completedEvent: Extract<WorkerStreamEvent, { type: "completed" }> | null = null;
  let watchdogDecision: WatchdogDecision | null = null;
  let watchdogSignal: WatchdogSignal | null = null;
  let discoveredSessionId = existingSessionId;
  let stageCostUsd = 0;

  const triggerWatchdogCheck = async (): Promise<boolean> => {
    if (abortController.signal.aborted || watchdogDecision) return false;
    const sig = ctx.watchdog.evaluateL1(tracker);
    if (!sig) return false;

    watchdogSignal = sig;
    ctx.emitEvent({ type: "watchdog_signal", signal: sig, timestamp: nowIso() });

    const probeContext = ctx.workspace.runRepoPreProbe
      ? await ctx.workspace
          .runRepoPreProbe(
            repo.rootPath,
            `${ticket.title}\n${sig.details}\n${ticket.mandate.allowedPaths.join(" ")}`,
            repo.forbiddenPaths,
          )
          .catch(() => undefined)
      : undefined;
    const decision = await ctx.watchdog.evaluateAndDecide({
      ticket,
      stageRun,
      signal: sig,
      recentEvents: tracker.recentEvents,
      availableEngines,
      probeContext,
      probeExecutor: ctx.createRepoProbeExecutor(repo),
    });
    ctx.emitEvent({
      type: "watchdog_decision",
      ticketId: ticket.id,
      stageRunId: stageRun.id,
      decision,
      timestamp: nowIso(),
    });

    if (decision.action === "CONTINUE") {
      tracker.lastEventAtMs = Date.now();
      tracker.consecutiveErrorCount = 0;
      return false;
    }

    watchdogDecision = decision;
    abortController.abort(`watchdog_${decision.action}`);
    return true;
  };

  const l1Timer = setInterval(() => {
    void triggerWatchdogCheck();
  }, ctx.watchdog.config.pollIntervalMs);

  const workerSpan = spans.start("worker_turn", `${driver.engine} ${stage}`);
  try {
    const stream = driver.runTurn(
      {
        ticketId: ticket.id,
        stageRunId: stageRun.id,
        stage,
        worktreePath: ws.worktreePath,
        prompt,
        mandate: ticket.mandate,
        nativeSessionId: existingSessionId,
        isResume: Boolean(existingSessionId),
        model: effectiveModel,
        effort: effectiveEffort,
        sandboxMode: repo.sandboxMode ?? "balanced",
        rootRepoPath: repo.rootPath,
        readOnlyPaths: stage === "implement" ? ticket.lockedTestPaths : undefined,
      },
      abortController.signal,
    );

    for await (const event of stream) {
      collectedEvents.push(event);
      ctx.emitEvent({
        type: "worker_event",
        ticketId: ticket.id,
        stageRunId: stageRun.id,
        engine: driver.engine,
        event,
        timestamp: event.timestamp,
      });

      ctx.watchdog.recordEvent(tracker, event);

      if (event.type === "session_started") {
        discoveredSessionId = event.nativeSessionId;
      } else if (event.type === "usage") {
        stageCostUsd = Math.max(stageCostUsd, event.costUsd);
      } else if (event.type === "completed") {
        completedEvent = event;
        if (typeof event.costUsd === "number") {
          stageCostUsd = Math.max(stageCostUsd, event.costUsd);
        }
      } else if (event.type === "tool_result" && stage === "implement") {
        try {
          const diffText = await ctx.workspace.getDiff(ws.worktreePath, effectiveBaseBranch);
          const changed = await ctx.workspace.getChangedFiles(ws.worktreePath, effectiveBaseBranch);
          const hash = new Bun.CryptoHasher("sha256").update(diffText).digest("hex").slice(0, 12);
          ctx.watchdog.recordDiffCheckpoint(tracker, hash, changed.length > 0);
        } catch {
          // Non-fatal
        }
      }

      if (await triggerWatchdogCheck()) {
        break;
      }
    }
  } catch (err) {
    if (!abortController.signal.aborted) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errEvent: WorkerStreamEvent = {
        type: "error",
        message: errMsg,
        fatal: true,
        timestamp: nowIso(),
      };
      collectedEvents.push(errEvent);
      ctx.watchdog.recordEvent(tracker, errEvent);
      await triggerWatchdogCheck();
    }
  } finally {
    clearInterval(l1Timer);
  }

  const toolProfile = buildStageToolProfile(collectedEvents);
  const turnSpanStatus: StageSpan["status"] =
    ctx.pendingSteers.has(ticket.id)
      ? "ok"
      : watchdogDecision
        ? "failed"
        : !completedEvent && collectedEvents.some((e) => e.type === "error")
          ? "failed"
          : "ok";
  spans.end(workerSpan, turnSpanStatus, `$${stageCostUsd.toFixed(3)}`);

  const latestTicket = await ctx.stateStore.getTicket(ticket.id);
  if (latestTicket && latestTicket.status === "cancelled") {
    ctx.pendingSteers.delete(ticket.id);
    await ctx.stateStore.saveStageRun({
      ...stageRun,
      status: "aborted",
      nativeSessionId: discoveredSessionId,
      costUsd: stageCostUsd,
      spans: spans.toArray(),
      toolProfile,
      completedAt: nowIso(),
      summary: "Cancelled by user",
    });
    return;
  }

  if (ctx.isStopped()) {
    ctx.pendingSteers.delete(ticket.id);
    await ctx.stateStore.saveStageRun({
      ...stageRun,
      status: "aborted",
      nativeSessionId: discoveredSessionId,
      costUsd: stageCostUsd,
      spans: spans.toArray(),
      toolProfile,
      completedAt: nowIso(),
      summary: "Aborted on kernel shutdown",
    });
    await ctx.stateStore.saveTicket({
      ...ticket,
      status: "queued",
      costUsd: ticket.costUsd + stageCostUsd,
      updatedAt: nowIso(),
    });
    return;
  }

  const pendingSteer = ctx.pendingSteers.get(ticket.id);
  if (pendingSteer && abortController.signal.aborted) {
    ctx.pendingSteers.delete(ticket.id);
    const ts = nowIso();
    const steeredRun: StageRun = {
      ...stageRun,
      status: "aborted",
      nativeSessionId: discoveredSessionId,
      costUsd: stageCostUsd,
      spans: spans.toArray(),
      toolProfile,
      steered: true,
      completedAt: ts,
      summary: `Live steer applied: ${pendingSteer.instruction.slice(0, 140)}`,
    };
    const { note: steerNote } = await ctx.memory.recordStageSpillAndNote({
      ticket,
      stageRun: steeredRun,
      events: collectedEvents,
      changedFiles: [],
      summary: steeredRun.summary!,
      verificationPassed: false,
    });
    steeredRun.spillTranscriptId = steerNote.spillArtifactIds[0];
    await ctx.stateStore.saveStageRun(steeredRun);
    ctx.emitEvent({
      type: "stage_completed",
      ticketId: ticket.id,
      stageRun: steeredRun,
      note: steerNote,
      timestamp: ts,
    });

    const preservedSessions =
      discoveredSessionId && stage !== "review"
        ? { ...ticket.nativeSessions, [driver.engine]: discoveredSessionId }
        : ticket.nativeSessions;
    const switchedEngine =
      pendingSteer.preferredEngine && pendingSteer.preferredEngine !== "auto"
        ? pendingSteer.preferredEngine
        : driver.engine;

    const steeredTicket: Ticket = {
      ...ticket,
      status: "queued",
      steerCount: (ticket.steerCount ?? 0) + 1,
      costUsd: ticket.costUsd + stageCostUsd,
      nativeSessions: preservedSessions,
      preferredEngine: pendingSteer.preferredEngine ?? ticket.preferredEngine,
      activeEngine: switchedEngine,
      inlineMemory: {
        ...ticket.inlineMemory,
        stageNotes: [...ticket.inlineMemory.stageNotes, steerNote],
        threadUpdates: [
          ...ticket.inlineMemory.threadUpdates,
          {
            triggerId: newId("str"),
            message: `[Live Steer]: ${pendingSteer.instruction}`,
            createdAt: ts,
          },
        ],
        activeHint: `[LIVE STEER]: ${pendingSteer.instruction}`,
      },
      updatedAt: ts,
    };
    await ctx.stateStore.saveTicket(steeredTicket);
    ctx.emitEvent({ type: "ticket_updated", ticket: steeredTicket, timestamp: ts });
    return;
  }

  if (watchdogDecision) {
    const dec: WatchdogDecision = watchdogDecision;
    const sig: WatchdogSignal | null = watchdogSignal;
    const abortedRun: StageRun = {
      ...stageRun,
      status: "aborted",
      nativeSessionId: discoveredSessionId,
      costUsd: stageCostUsd,
      spans: spans.toArray(),
      toolProfile,
      completedAt: nowIso(),
      summary: `Watchdog ${dec.action}: ${dec.reason}`,
    };
    await ctx.memory.recordStageSpillAndNote({
      ticket,
      stageRun: abortedRun,
      events: collectedEvents,
      changedFiles: [],
      summary: abortedRun.summary!,
      verificationPassed: false,
    });

    if (dec.action === "INJECT_HINT") {
      const nextTicket: Ticket = {
        ...ticket,
        status: "queued",
        stageRetries: ticket.stageRetries + 1,
        costUsd: ticket.costUsd + stageCostUsd,
        nativeSessions: discoveredSessionId
          ? { ...ticket.nativeSessions, [driver.engine]: discoveredSessionId }
          : ticket.nativeSessions,
        inlineMemory: {
          ...ticket.inlineMemory,
          activeHint: dec.hint ?? dec.reason,
        },
        updatedAt: nowIso(),
      };
      await ctx.stateStore.saveStageRun(abortedRun);
      await ctx.stateStore.saveTicket(nextTicket);
      ctx.emitEvent({ type: "ticket_updated", ticket: nextTicket, timestamp: nextTicket.updatedAt });
      return;
    }

    if (dec.action === "SWITCH_ENGINE") {
      const nextFailed = Array.from(new Set([...(ticket.failedEngines ?? []), driver.engine]));
      const altEngine =
        dec.targetEngine &&
        dec.targetEngine !== driver.engine &&
        !nextFailed.includes(dec.targetEngine) &&
        availableEngines.includes(dec.targetEngine)
          ? dec.targetEngine
          : pickNextFallbackEngine({
              currentEngine: driver.engine,
              failedEngines: nextFailed,
              repo,
              availableEngines,
            }) ?? getAlternateEngine(driver.engine, availableEngines);
      if (altEngine && altEngine !== driver.engine && !nextFailed.includes(altEngine)) {
        const nextTicket: Ticket = {
          ...ticket,
          status: "queued",
          activeEngine: altEngine,
          failedEngines: nextFailed,
          stageRetries: ticket.stageRetries + 1,
          costUsd: ticket.costUsd + stageCostUsd,
          inlineMemory: {
            ...ticket.inlineMemory,
            activeHint:
              dec.hint ??
              `[Fallback Engine: ${driver.engine} -> ${altEngine}] Switched due to: ${dec.reason}`,
          },
          updatedAt: nowIso(),
        };
        await ctx.stateStore.saveStageRun(abortedRun);
        await ctx.stateStore.saveTicket(nextTicket);
        await ctx.recordFlightEvent?.({
          repoId: repo.id,
          ticketId: ticket.id,
          kind: "watchdog_switch",
          engine: altEngine,
          summary: `Watchdog switched engine ${driver.engine} -> ${altEngine}: ${dec.reason}`,
          metadata: { fromEngine: driver.engine, toEngine: altEngine, stage: stageRun.stage },
        });
        ctx.emitEvent({ type: "ticket_updated", ticket: nextTicket, timestamp: nextTicket.updatedAt });
        return;
      }
    }

    await ctx.stateStore.saveStageRun(abortedRun);
    if (ticket.campaignId) {
      await failCampaignWaveTicket(ctx, { ...ticket, costUsd: ticket.costUsd + stageCostUsd }, repo, dec.reason);
    } else {
      await ctx.escalateTicket(
        { ...ticket, costUsd: ticket.costUsd + stageCostUsd },
        "watchdog_escalation",
        dec.reason,
        { signal: sig, decision: dec },
      );
    }
    return;
  }

  const lastErrorEvent = [...collectedEvents].reverse().find((e) => e.type === "error");
  if (!completedEvent && lastErrorEvent && lastErrorEvent.type === "error") {
    const failedRun: StageRun = {
      ...stageRun,
      status: "failed",
      nativeSessionId: discoveredSessionId,
      costUsd: stageCostUsd,
      spans: spans.toArray(),
      toolProfile,
      completedAt: nowIso(),
      summary: lastErrorEvent.message,
    };
    await ctx.stateStore.saveStageRun(failedRun);
    await ctx.memory.recordStageSpillAndNote({
      ticket,
      stageRun: failedRun,
      events: collectedEvents,
      changedFiles: [],
      summary: lastErrorEvent.message,
      verificationPassed: false,
    });

    const nextFailed = Array.from(new Set([...(ticket.failedEngines ?? []), driver.engine]));
    const fallbackEngine = pickNextFallbackEngine({
      currentEngine: driver.engine,
      failedEngines: nextFailed,
      repo,
      availableEngines,
    });

    if (fallbackEngine) {
      const handedOff: Ticket = {
        ...ticket,
        status: "queued",
        activeEngine: fallbackEngine,
        failedEngines: nextFailed,
        stageRetries: 0,
        costUsd: ticket.costUsd + stageCostUsd,
        inlineMemory: {
          ...ticket.inlineMemory,
          activeHint: `[Engine Fallback: ${driver.engine} -> ${fallbackEngine}] Previous engine errored (${lastErrorEvent.message}). Existing worktree state is preserved; continue and finish cleanly.`,
        },
        updatedAt: nowIso(),
      };
      await ctx.stateStore.saveTicket(handedOff);
      ctx.emitEvent({ type: "ticket_updated", ticket: handedOff, timestamp: handedOff.updatedAt });
    } else if (ticket.stageRetries < ticket.mandate.maxStageRetries) {
      const retried: Ticket = {
        ...ticket,
        status: "queued",
        stageRetries: ticket.stageRetries + 1,
        costUsd: ticket.costUsd + stageCostUsd,
        inlineMemory: {
          ...ticket.inlineMemory,
          activeHint: `Previous ${stage} attempt errored (${lastErrorEvent.message}). Fix and retry.`,
        },
        updatedAt: nowIso(),
      };
      await ctx.stateStore.saveTicket(retried);
      ctx.emitEvent({ type: "ticket_updated", ticket: retried, timestamp: retried.updatedAt });
    } else if (ticket.campaignId) {
      await failCampaignWaveTicket(
        ctx,
        { ...ticket, costUsd: ticket.costUsd + stageCostUsd },
        repo,
        `Stage ${stage} failed: ${lastErrorEvent.message}`,
      );
    } else {
      await ctx.escalateTicket(
        { ...ticket, costUsd: ticket.costUsd + stageCostUsd },
        "watchdog_escalation",
        `Stage ${stage} failed: ${lastErrorEvent.message}`,
        { stageRunId: stageRun.id, failedEngines: nextFailed },
      );
    }
    return;
  }

  if (stage === "spec_test") {
    await handleSpecTestPostTurnOp(ctx, {
      ticket,
      repo,
      stageRun,
      worktreePath: ws.worktreePath,
      effectiveBaseBranch,
      driverEngine: driver.engine,
      collectedEvents,
      completedEvent,
      discoveredSessionId,
      stageCostUsd,
    });
    return;
  }

  const changedFiles = await ctx.workspace.getChangedFiles(ws.worktreePath, effectiveBaseBranch);
  const diffText = await ctx.workspace.getDiff(ws.worktreePath, effectiveBaseBranch);
  const textChunks = collectedEvents
    .filter((e): e is Extract<WorkerStreamEvent, { type: "text" }> => e.type === "text")
    .map((e) => e.text)
    .join("\n");
  const summary = completedEvent?.summary || textChunks || `${stage} completed`;

  let tamperedLockedTests: string[] = [];
  if (
    stage === "implement" &&
    ticket.lockedTestPaths &&
    ticket.lockedTestPaths.length > 0 &&
    ticket.specTestCommitSha &&
    ctx.workspace.getChangedFilesSince
  ) {
    const changedSinceSpec = await ctx.workspace.getChangedFilesSince(
      ws.worktreePath,
      ticket.specTestCommitSha,
    );
    tamperedLockedTests = changedSinceSpec.filter((f) => ticket.lockedTestPaths!.includes(f));
    if (tamperedLockedTests.length > 0) {
      await ctx.workspace.revertPathsToCommit?.(
        ws.worktreePath,
        ticket.specTestCommitSha,
        tamperedLockedTests,
      );
    }
  }

  const challengeReason =
    stage === "implement" && ticket.tddMode
      ? parseSpecTestChallenge(`${summary}\n${textChunks}`)
      : null;

  if (tamperedLockedTests.length > 0 && !challengeReason) {
    const tamperSummary = `Locked spec_test file(s) modified during implement and reverted: ${tamperedLockedTests.join(", ")}`;
    const failedRun: StageRun = {
      ...stageRun,
      status: "failed",
      nativeSessionId: discoveredSessionId,
      costUsd: stageCostUsd,
      completedAt: nowIso(),
      summary: tamperSummary,
    };
    await ctx.stateStore.saveStageRun(failedRun);
    const { note: tNote } = await ctx.memory.recordStageSpillAndNote({
      ticket,
      stageRun: failedRun,
      events: collectedEvents,
      changedFiles: tamperedLockedTests,
      diffText,
      summary: tamperSummary,
      verificationPassed: false,
    });
    const updatedTamperSessions = discoveredSessionId
      ? { ...ticket.nativeSessions, [driver.engine]: discoveredSessionId }
      : ticket.nativeSessions;

    if (ticket.stageRetries < ticket.mandate.maxStageRetries) {
      const retrying: Ticket = {
        ...ticket,
        status: "queued",
        stageRetries: ticket.stageRetries + 1,
        costUsd: ticket.costUsd + stageCostUsd,
        nativeSessions: updatedTamperSessions,
        inlineMemory: {
          ...ticket.inlineMemory,
          stageNotes: [...ticket.inlineMemory.stageNotes, tNote],
          activeHint: `${tamperSummary}. Locked test files are read-only; fix production code or emit SPEC_TEST_CHALLENGE: <reason> if the spec test itself is flawed.`,
        },
        updatedAt: nowIso(),
      };
      await ctx.stateStore.saveTicket(retrying);
      ctx.emitEvent({ type: "ticket_updated", ticket: retrying, timestamp: retrying.updatedAt });
    } else {
      await ctx.escalateTicket(
        {
          ...ticket,
          costUsd: ticket.costUsd + stageCostUsd,
          nativeSessions: updatedTamperSessions,
          inlineMemory: {
            ...ticket.inlineMemory,
            stageNotes: [...ticket.inlineMemory.stageNotes, tNote],
          },
        },
        "mandate_violation",
        tamperSummary,
        { tamperedLockedTests, interruptedStage: stage },
      );
    }
    return;
  }

  const filesForMandate =
    ticket.lockedTestPaths && ticket.lockedTestPaths.length > 0
      ? changedFiles.filter((f) => !ticket.lockedTestPaths!.includes(f))
      : changedFiles;
  const mandateCheck = validateChangedFilesAgainstMandate(filesForMandate, ticket.mandate);

  if (!mandateCheck.ok) {
    const hasForbidden = mandateCheck.forbiddenViolations.length > 0;
    if (hasForbidden) {
      await ctx.workspace.revertPaths(ws.worktreePath, mandateCheck.violations);
    }

    const abortedRun: StageRun = {
      ...stageRun,
      status: "failed",
      nativeSessionId: discoveredSessionId,
      costUsd: stageCostUsd,
      completedAt: nowIso(),
      summary: `Mandate violation on paths: ${mandateCheck.violations.join(", ")}`,
    };
    await ctx.stateStore.saveStageRun(abortedRun);
    const { note: vNote } = await ctx.memory.recordStageSpillAndNote({
      ticket,
      stageRun: abortedRun,
      events: collectedEvents,
      changedFiles: mandateCheck.violations,
      diffText,
      summary: abortedRun.summary!,
      verificationPassed: false,
    });

    const updatedSessionsOnViolation =
      discoveredSessionId && stage !== "review"
        ? { ...ticket.nativeSessions, [driver.engine]: discoveredSessionId }
        : ticket.nativeSessions;

    const reason = hasForbidden
      ? `Worker attempted to modify forbidden paths (${mandateCheck.forbiddenViolations.join(", ")}) or out-of-scope paths: ${mandateCheck.violations.join(", ")} (changes reverted)`
      : `Worker modified files outside authorized allowedPaths: ${mandateCheck.scopeViolations.join(", ")} (preserved in worktree pending approval or revert)`;

    await ctx.escalateTicket(
      {
        ...ticket,
        costUsd: ticket.costUsd + stageCostUsd,
        nativeSessions: updatedSessionsOnViolation,
        pendingViolationPaths: hasForbidden ? undefined : mandateCheck.scopeViolations,
        inlineMemory: {
          ...ticket.inlineMemory,
          stageNotes: [...ticket.inlineMemory.stageNotes, vNote],
        },
      },
      "mandate_violation",
      reason,
      {
        violations: mandateCheck.violations,
        forbiddenViolations: mandateCheck.forbiddenViolations,
        scopeViolations: mandateCheck.scopeViolations,
        canExpandMandate: !hasForbidden && mandateCheck.scopeViolations.length > 0,
        interruptedStage: stage,
      },
    );
    return;
  }

  if (challengeReason) {
    const canRewind = (ticket.specTestChallengeCount ?? 0) < 1;
    const chRun: StageRun = {
      ...stageRun,
      status: canRewind ? "completed" : "failed",
      nativeSessionId: discoveredSessionId,
      costUsd: stageCostUsd,
      spans: spans.toArray(),
      toolProfile,
      completedAt: nowIso(),
      summary: `SPEC_TEST_CHALLENGE: ${challengeReason}`,
    };
    const { note: chNote } = await ctx.memory.recordStageSpillAndNote({
      ticket,
      stageRun: chRun,
      events: collectedEvents,
      changedFiles,
      diffText,
      summary: chRun.summary!,
      verificationPassed: false,
    });
    chRun.spillTranscriptId = chNote.spillArtifactIds[0];
    await ctx.stateStore.saveStageRun(chRun);
    ctx.emitEvent({
      type: "stage_completed",
      ticketId: ticket.id,
      stageRun: chRun,
      note: chNote,
      timestamp: chRun.completedAt!,
    });

    const updatedChallengeSessions = discoveredSessionId
      ? { ...ticket.nativeSessions, [driver.engine]: discoveredSessionId }
      : ticket.nativeSessions;

    if (canRewind) {
      const rewound: Ticket = {
        ...ticket,
        status: "queued",
        currentStage: "spec_test",
        stageRetries: 0,
        specTestChallengeCount: (ticket.specTestChallengeCount ?? 0) + 1,
        lockedTestPaths: undefined,
        activeEngine: undefined,
        failedEngines: [],
        costUsd: ticket.costUsd + stageCostUsd,
        nativeSessions: updatedChallengeSessions,
        inlineMemory: {
          ...ticket.inlineMemory,
          stageNotes: [...ticket.inlineMemory.stageNotes, chNote],
          activeHint: `[SPEC_TEST_CHALLENGE from implement] Review and repair the specification tests if justified: ${challengeReason}`,
        },
        updatedAt: nowIso(),
      };
      await ctx.stateStore.saveTicket(rewound);
      ctx.emitEvent({ type: "ticket_updated", ticket: rewound, timestamp: rewound.updatedAt });
      return;
    }

    await ctx.escalateTicket(
      {
        ...ticket,
        costUsd: ticket.costUsd + stageCostUsd,
        nativeSessions: updatedChallengeSessions,
        inlineMemory: {
          ...ticket.inlineMemory,
          stageNotes: [...ticket.inlineMemory.stageNotes, chNote],
        },
      },
      "watchdog_escalation",
      `SPEC_TEST_CHALLENGE raised again after max 1 rewind: ${challengeReason}`,
      { stageRunId: chRun.id, challengeReason },
    );
    return;
  }

  const workerClarification =
    (stage === "plan" || stage === "implement") && (ticket.clarificationCount ?? 0) < 1
      ? extractWorkerClarificationRequest(
          collectedEvents,
          completedEvent?.structuredOutput?.clarificationRequest,
        )
      : null;
  if (workerClarification) {
    const clarTs = nowIso();
    const clarRun: StageRun = {
      ...stageRun,
      status: "completed",
      nativeSessionId: discoveredSessionId,
      costUsd: stageCostUsd,
      spans: spans.toArray(),
      toolProfile,
      completedAt: clarTs,
      summary: `Clarification requested: ${workerClarification.question}`,
    };
    const { note: clarNote } = await ctx.memory.recordStageSpillAndNote({
      ticket,
      stageRun: clarRun,
      events: collectedEvents,
      changedFiles,
      diffText,
      summary: clarRun.summary!,
      verificationPassed: false,
    });
    clarRun.spillTranscriptId = clarNote.spillArtifactIds[0];
    await ctx.stateStore.saveStageRun(clarRun);
    ctx.emitEvent({
      type: "stage_completed",
      ticketId: ticket.id,
      stageRun: clarRun,
      note: clarNote,
      timestamp: clarTs,
    });

    const updatedClarSessions = discoveredSessionId
      ? { ...ticket.nativeSessions, [driver.engine]: discoveredSessionId }
      : ticket.nativeSessions;
    const effectiveGatePolicy =
      ticket.deliveryGatePolicy ?? repo.deliveryGatePolicy ?? "always_auto";
    const shouldPauseForHuman =
      repo.mode === "observe" ||
      ticket.template === "strict" ||
      effectiveGatePolicy === "risk_gated" ||
      effectiveGatePolicy === "always_signoff";

    if (shouldPauseForHuman) {
      await ctx.escalateTicket(
        {
          ...ticket,
          clarificationCount: (ticket.clarificationCount ?? 0) + 1,
          costUsd: ticket.costUsd + stageCostUsd,
          nativeSessions: updatedClarSessions,
          inlineMemory: {
            ...ticket.inlineMemory,
            stageNotes: [...ticket.inlineMemory.stageNotes, clarNote],
          },
        },
        "clarification_request",
        workerClarification.question,
        {
          clarification: workerClarification,
          stage,
          stageRunId: clarRun.id,
        },
      );
      return;
    }

    const autoLine = `[AUTO-CLARIFIED] Q: ${workerClarification.question} -> Adopted recommended option: ${workerClarification.recommendedOption}`;
    const autoResumed: Ticket = {
      ...ticket,
      status: "queued",
      clarificationCount: (ticket.clarificationCount ?? 0) + 1,
      costUsd: ticket.costUsd + stageCostUsd,
      nativeSessions: updatedClarSessions,
      activeEngine: driver.engine,
      inlineMemory: {
        ...ticket.inlineMemory,
        stageNotes: [...ticket.inlineMemory.stageNotes, clarNote],
        threadUpdates: [
          ...ticket.inlineMemory.threadUpdates,
          {
            triggerId: newId("clr"),
            message: autoLine,
            createdAt: clarTs,
          },
        ],
        activeHint: autoLine,
      },
      updatedAt: clarTs,
    };
    await ctx.stateStore.saveTicket(autoResumed);
    ctx.emitEvent({
      type: "ticket_updated",
      ticket: autoResumed,
      timestamp: clarTs,
    });
    return;
  }

  let reviewApproved =
    stage === "review" ? (completedEvent?.structuredOutput?.approved ?? true) : undefined;
  let reviewReport: ReviewReport | undefined;
  let reviewReportArtifact: SpillArtifact | undefined;
  if (stage === "review") {
    reviewReport = parseReviewReport({
      summary,
      textChunks,
      structuredOutput: completedEvent?.structuredOutput,
      engine: driver.engine,
    });
    reviewApproved = reviewReport.verdict === "approved";

    reviewReportArtifact = await ctx.artifactStore.writeSpill(
      {
        ticketId: ticket.id,
        stageRunId: stageRun.id,
        kind: "review_report",
        summary: `Review ${reviewReport.verdict} (${reviewReport.findings.length} finding(s))`,
        ext: "json",
      },
      JSON.stringify(reviewReport, null, 2),
    );
    await ctx.stateStore.saveArtifact(
      reviewReportArtifact,
      [
        reviewReport.verdict,
        ...reviewReport.findings.map((f) => `${f.severity} ${f.file ?? ""} ${f.message}`),
      ].join("\n"),
    );
    if (reviewReport.findings.length > 0) {
      await syncAiFindingsToReviewComments(ctx, ticket, reviewReport.findings);
    }
  }

  let verificationArtifacts: SpillArtifact[] = [];
  let verificationPassed = completedEvent?.structuredOutput?.verificationPassed ?? true;
  if (stage === "implement") {
    const gate = await runRepoVerificationGateOp(ctx, ticket, repo, stageRun, ws.worktreePath, {
      isFinalDeliveryGate: false,
    });
    spans.addExisting(gate.spans);
    verificationArtifacts = gate.artifacts;
    verificationPassed = gate.passed;
    if (!gate.passed) {
      const failedSummary = gate.result?.summary ?? "Deterministic verification gate failed";
      const failedRun: StageRun = {
        ...stageRun,
        status: "failed",
        nativeSessionId: discoveredSessionId,
        costUsd: stageCostUsd,
        spans: spans.toArray(),
        toolProfile,
        completedAt: nowIso(),
        summary: failedSummary,
      };
      const { note: failNote } = await ctx.memory.recordStageSpillAndNote({
        ticket,
        stageRun: failedRun,
        events: collectedEvents,
        changedFiles,
        diffText,
        summary: failedSummary,
        verificationPassed: false,
        extraArtifacts: verificationArtifacts.length > 0 ? verificationArtifacts : undefined,
      });
      failedRun.spillTranscriptId = failNote.spillArtifactIds[0];
      await ctx.stateStore.saveStageRun(failedRun);
      await ctx.captureTicketCheckpoint(ticket, repo, ws.worktreePath, {
        stage: "implement",
        stageRunId: failedRun.id,
        engine: driver.engine,
        label: `Implement attempt #${ticket.stageRetries + 1} (failed gate)`,
        changedFiles,
        verificationPassed: false,
      });
      ctx.emitEvent({
        type: "stage_completed",
        ticketId: ticket.id,
        stageRun: failedRun,
        note: failNote,
        timestamp: failedRun.completedAt!,
      });

      const updatedFailSessions = discoveredSessionId
        ? { ...ticket.nativeSessions, [driver.engine]: discoveredSessionId }
        : ticket.nativeSessions;
      const updatedFailMemory = {
        ...ticket.inlineMemory,
        stageNotes: [...ticket.inlineMemory.stageNotes, failNote],
        activeHint: `Deterministic verification failed (${gate.result?.failedCommand ?? "checks"}). Fix the errors and verify locally:\n${failedSummary}`,
      };

      if (ticket.stageRetries < ticket.mandate.maxStageRetries) {
        const retrying: Ticket = {
          ...ticket,
          status: "queued",
          stageRetries: ticket.stageRetries + 1,
          costUsd: ticket.costUsd + stageCostUsd,
          nativeSessions: updatedFailSessions,
          activeEngine: driver.engine,
          inlineMemory: updatedFailMemory,
          updatedAt: nowIso(),
        };
        await ctx.stateStore.saveTicket(retrying);
        ctx.emitEvent({ type: "ticket_updated", ticket: retrying, timestamp: retrying.updatedAt });
      } else {
        const nextFailed = Array.from(new Set([...(ticket.failedEngines ?? []), driver.engine]));
        const fallbackEngine = pickNextFallbackEngine({
          currentEngine: driver.engine,
          failedEngines: nextFailed,
          repo,
          availableEngines,
        });
        if (fallbackEngine) {
          const handedOff: Ticket = {
            ...ticket,
            status: "queued",
            stageRetries: 0,
            costUsd: ticket.costUsd + stageCostUsd,
            nativeSessions: updatedFailSessions,
            failedEngines: nextFailed,
            activeEngine: fallbackEngine,
            inlineMemory: {
              ...updatedFailMemory,
              activeHint: `[Engine Fallback: ${driver.engine} -> ${fallbackEngine}] ${driver.engine} exhausted retries on verification gate (${gate.result?.failedCommand ?? "checks"}). Preserved worktree changes; fix and pass verification:\n${failedSummary}`,
            },
            updatedAt: nowIso(),
          };
          await ctx.stateStore.saveTicket(handedOff);
          ctx.emitEvent({ type: "ticket_updated", ticket: handedOff, timestamp: handedOff.updatedAt });
        } else if (ticket.campaignId) {
          await failCampaignWaveTicket(
            ctx,
            {
              ...ticket,
              costUsd: ticket.costUsd + stageCostUsd,
              nativeSessions: updatedFailSessions,
              failedEngines: nextFailed,
              inlineMemory: updatedFailMemory,
            },
            repo,
            `Verification failed: ${gate.result?.failedCommand ?? failedSummary}`,
          );
        } else {
          await ctx.escalateTicket(
            {
              ...ticket,
              costUsd: ticket.costUsd + stageCostUsd,
              nativeSessions: updatedFailSessions,
              failedEngines: nextFailed,
              inlineMemory: updatedFailMemory,
            },
            "watchdog_escalation",
            `Deterministic verification failed after ${ticket.mandate.maxStageRetries} retries: ${gate.result?.failedCommand ?? failedSummary}`,
            { stageRunId: failedRun.id, failedCommand: gate.result?.failedCommand, failedEngines: nextFailed },
          );
        }
      }
      return;
    }
  }

  const extraArtifacts: SpillArtifact[] = [...verificationArtifacts];
  if (reviewReportArtifact) extraArtifacts.push(reviewReportArtifact);

  const nitText =
    reviewApproved && reviewReport && reviewReport.findings.length > 0
      ? formatNitSummary(reviewReport.findings)
      : "";
  const noteSummary = nitText ? `${summary}\nAdvisory nits: ${nitText}` : summary;

  const finishedRun: StageRun = {
    ...stageRun,
    status: "completed",
    nativeSessionId: discoveredSessionId,
    costUsd: stageCostUsd,
    spans: spans.toArray(),
    toolProfile,
    completedAt: nowIso(),
    summary: noteSummary,
  };

  const { note } = await ctx.memory.recordStageSpillAndNote({
    ticket,
    stageRun: finishedRun,
    events: collectedEvents,
    changedFiles,
    diffText,
    summary: noteSummary,
    verificationPassed,
    reviewApproved,
    reviewFindings: reviewReport?.findings,
    extraArtifacts: extraArtifacts.length > 0 ? extraArtifacts : undefined,
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

  const updatedSessions =
    discoveredSessionId && stage !== "review"
      ? { ...ticket.nativeSessions, [driver.engine]: discoveredSessionId }
      : ticket.nativeSessions;

  const updatedMemory = {
    ...ticket.inlineMemory,
    planSummary:
      stage === "plan"
        ? completedEvent?.structuredOutput?.planSummary || summary
        : ticket.inlineMemory.planSummary,
    stageNotes: [...ticket.inlineMemory.stageNotes, note],
    activeHint: undefined,
  };

  const template = getPipelineTemplate(ticket.template);

  if (stage === "plan") {
    if (template.requirePlanApproval) {
      const awaitingTicket: Ticket = {
        ...ticket,
        status: "awaiting_plan_approval",
        costUsd: ticket.costUsd + stageCostUsd,
        nativeSessions: updatedSessions,
        activeEngine: undefined,
        inlineMemory: updatedMemory,
        updatedAt: nowIso(),
      };
      await ctx.stateStore.saveTicket(awaitingTicket);
      ctx.emitEvent({ type: "ticket_updated", ticket: awaitingTicket, timestamp: awaitingTicket.updatedAt });

      const inboxItem: InboxItem = {
        id: newId("inb"),
        repoId: repo.id,
        ticketId: ticket.id,
        kind: "plan_approval",
        status: "pending",
        title: `Approve Plan: ${ticket.title}`,
        summary: updatedMemory.planSummary ?? summary,
        contextPayload: { stageRunId: finishedRun.id, spillArtifactIds: note.spillArtifactIds },
        createdAt: nowIso(),
      };
      await ctx.stateStore.saveInboxItem(inboxItem);
      ctx.emitEvent({ type: "inbox_created", item: inboxItem, timestamp: inboxItem.createdAt });
      return;
    }
  }

  if (stage === "implement") {
    await autoResolveModifiedReviewComments(ctx, ticket.id, changedFiles);
    await ctx.workspace.commitAll(ws.worktreePath, `super-work(${ticket.id}): ${ticket.title}`);
    await ctx.captureTicketCheckpoint(ticket, repo, ws.worktreePath, {
      stage: "implement",
      stageRunId: finishedRun.id,
      engine: driver.engine,
      label: "Implement verified & committed",
      changedFiles,
      verificationPassed: true,
    });
  }

  if (stage === "review" && reviewApproved === false) {
    const feedback =
      reviewReport && reviewReport.findings.length > 0
        ? formatBlockingFindingsForRework(reviewReport.findings)
        : completedEvent?.structuredOutput?.feedback || summary;
    if (ticket.stageRetries < ticket.mandate.maxStageRetries) {
      const sentBack: Ticket = {
        ...ticket,
        status: "queued",
        currentStage: "implement",
        stageRetries: ticket.stageRetries + 1,
        costUsd: ticket.costUsd + stageCostUsd,
        nativeSessions: updatedSessions,
        activeEngine: undefined,
        inlineMemory: {
          ...updatedMemory,
          activeHint: `Review requested changes. Address blocking findings:\n${feedback}`,
        },
        updatedAt: nowIso(),
      };
      await ctx.stateStore.saveTicket(sentBack);
      ctx.emitEvent({ type: "ticket_updated", ticket: sentBack, timestamp: sentBack.updatedAt });
      return;
    }
    if (ticket.campaignId) {
      await failCampaignWaveTicket(
        ctx,
        {
          ...ticket,
          costUsd: ticket.costUsd + stageCostUsd,
          nativeSessions: updatedSessions,
          inlineMemory: updatedMemory,
        },
        repo,
        `Code review rejected: ${feedback}`,
      );
    } else {
      await ctx.escalateTicket(
        {
          ...ticket,
          costUsd: ticket.costUsd + stageCostUsd,
          nativeSessions: updatedSessions,
          inlineMemory: updatedMemory,
        },
        "watchdog_escalation",
        `Code review rejected after ${ticket.mandate.maxStageRetries} revisions:\n${feedback}`,
        { stageRunId: finishedRun.id, findings: reviewReport?.findings ?? [] },
      );
    }
    return;
  }

  const nextStage: StageKind | null =
    stage === "implement" && ticket.prNumber
      ? "rebase"
      : getNextStage(ticket.template, stage, ticket.tddMode);
  if (!nextStage) {
    const readyTicket: Ticket = {
      ...ticket,
      costUsd: ticket.costUsd + stageCostUsd,
      nativeSessions: updatedSessions,
      activeEngine: undefined,
      inlineMemory: updatedMemory,
    };

    if (ticket.campaignId && ticket.targetBranch && ticket.targetBranch !== repo.baseBranch) {
      await mergeWaveToTargetStagingBranch(
        ctx,
        readyTicket,
        repo,
        ws.worktreePath,
        ticket.targetBranch,
        changedFiles,
        diffText,
      );
      return;
    }

    const baseHeadAtRebase = ctx.workspace.getHeadCommitSha
      ? await ctx.workspace.getHeadCommitSha(repo.rootPath, effectiveBaseBranch).catch(() => undefined)
      : undefined;
    await ctx.enqueueDeliveryOutbox({ ...readyTicket, baseHeadAtRebase }, repo);
    return;
  }

  const advancing: Ticket = {
    ...ticket,
    status: "queued",
    currentStage: nextStage,
    stageRetries: 0,
    costUsd: ticket.costUsd + stageCostUsd,
    nativeSessions: updatedSessions,
    activeEngine: undefined,
    failedEngines: [],
    inlineMemory: updatedMemory,
    updatedAt: nowIso(),
  };
  await ctx.stateStore.saveTicket(advancing);
  ctx.emitEvent({ type: "ticket_updated", ticket: advancing, timestamp: advancing.updatedAt });
}

export async function handleSpecTestPostTurnOp(
  ctx: KernelCoordinatorContext,
  input: {
    ticket: Ticket;
    repo: RepoConfig;
    stageRun: StageRun;
    worktreePath: string;
    effectiveBaseBranch: string;
    driverEngine: WorkerEngineId;
    collectedEvents: WorkerStreamEvent[];
    completedEvent: Extract<WorkerStreamEvent, { type: "completed" }> | null;
    discoveredSessionId?: string;
    stageCostUsd: number;
  },
): Promise<void> {
  const {
    ticket,
    repo,
    stageRun,
    worktreePath,
    effectiveBaseBranch,
    driverEngine,
    collectedEvents,
    completedEvent,
    discoveredSessionId,
    stageCostUsd,
  } = input;

  const changedFiles = await ctx.workspace.getChangedFiles(worktreePath, effectiveBaseBranch);
  const diffText = await ctx.workspace.getDiff(worktreePath, effectiveBaseBranch);
  const textChunks = collectedEvents
    .filter((e): e is Extract<WorkerStreamEvent, { type: "text" }> => e.type === "text")
    .map((e) => e.text)
    .join("\n");
  const summary = completedEvent?.summary || textChunks || "spec_test completed";

  const forbiddenViolations = validateChangedFilesAgainstMandate(changedFiles, {
    ...ticket.mandate,
    allowedPaths: ["**"],
  }).forbiddenViolations;
  const nonTestFiles = changedFiles.filter((f) => !isSpecTestFilePath(f));
  const updatedSessions = discoveredSessionId
    ? { ...ticket.nativeSessions, [driverEngine]: discoveredSessionId }
    : ticket.nativeSessions;

  if (forbiddenViolations.length > 0 || nonTestFiles.length > 0) {
    const toRevert = Array.from(new Set([...forbiddenViolations, ...nonTestFiles]));
    await ctx.workspace.revertPaths(worktreePath, toRevert);
    const failSummary = `spec_test may only create/modify test files; reverted: ${toRevert.join(", ")}`;
    const failedRun: StageRun = {
      ...stageRun,
      status: "failed",
      nativeSessionId: discoveredSessionId,
      costUsd: stageCostUsd,
      completedAt: nowIso(),
      summary: failSummary,
    };
    await ctx.stateStore.saveStageRun(failedRun);
    const { note: errNote } = await ctx.memory.recordStageSpillAndNote({
      ticket,
      stageRun: failedRun,
      events: collectedEvents,
      changedFiles: toRevert,
      diffText,
      summary: failSummary,
      verificationPassed: false,
    });

    if (forbiddenViolations.length === 0 && ticket.stageRetries < ticket.mandate.maxStageRetries) {
      const retrying: Ticket = {
        ...ticket,
        status: "queued",
        stageRetries: ticket.stageRetries + 1,
        costUsd: ticket.costUsd + stageCostUsd,
        nativeSessions: updatedSessions,
        inlineMemory: {
          ...ticket.inlineMemory,
          stageNotes: [...ticket.inlineMemory.stageNotes, errNote],
          activeHint: `spec_test stage may ONLY write test files (*.test.*, *.spec.*, test/**, tests/**, __tests__/**). Reverted non-test files: ${nonTestFiles.join(", ")}. Write failing tests only.`,
        },
        updatedAt: nowIso(),
      };
      await ctx.stateStore.saveTicket(retrying);
      ctx.emitEvent({ type: "ticket_updated", ticket: retrying, timestamp: retrying.updatedAt });
    } else {
      await ctx.escalateTicket(
        {
          ...ticket,
          costUsd: ticket.costUsd + stageCostUsd,
          nativeSessions: updatedSessions,
          inlineMemory: {
            ...ticket.inlineMemory,
            stageNotes: [...ticket.inlineMemory.stageNotes, errNote],
          },
        },
        "mandate_violation",
        failSummary,
        { violations: toRevert, forbiddenViolations, nonTestFiles, interruptedStage: "spec_test" },
      );
    }
    return;
  }

  const testFiles = changedFiles.filter((f) => isSpecTestFilePath(f));
  if (testFiles.length === 0) {
    const emptySummary = "spec_test produced no test files to lock.";
    const failedRun: StageRun = {
      ...stageRun,
      status: "failed",
      nativeSessionId: discoveredSessionId,
      costUsd: stageCostUsd,
      completedAt: nowIso(),
      summary: emptySummary,
    };
    await ctx.stateStore.saveStageRun(failedRun);
    const { note: emptyNote } = await ctx.memory.recordStageSpillAndNote({
      ticket,
      stageRun: failedRun,
      events: collectedEvents,
      changedFiles: [],
      diffText,
      summary: emptySummary,
      verificationPassed: false,
    });

    if (ticket.stageRetries < ticket.mandate.maxStageRetries) {
      const retrying: Ticket = {
        ...ticket,
        status: "queued",
        stageRetries: ticket.stageRetries + 1,
        costUsd: ticket.costUsd + stageCostUsd,
        nativeSessions: updatedSessions,
        inlineMemory: {
          ...ticket.inlineMemory,
          stageNotes: [...ticket.inlineMemory.stageNotes, emptyNote],
          activeHint:
            "spec_test stage created zero test files. Write at least one failing test file encoding the acceptance criteria.",
        },
        updatedAt: nowIso(),
      };
      await ctx.stateStore.saveTicket(retrying);
      ctx.emitEvent({ type: "ticket_updated", ticket: retrying, timestamp: retrying.updatedAt });
    } else {
      await ctx.escalateTicket(
        {
          ...ticket,
          costUsd: ticket.costUsd + stageCostUsd,
          nativeSessions: updatedSessions,
          inlineMemory: {
            ...ticket.inlineMemory,
            stageNotes: [...ticket.inlineMemory.stageNotes, emptyNote],
          },
        },
        "watchdog_escalation",
        emptySummary,
        { stageRunId: failedRun.id },
      );
    }
    return;
  }

  const extraArtifacts: SpillArtifact[] = [];
  let redProbeHint = `Locked spec_test file(s): ${testFiles.join(", ")}. Implement ONLY production code to pass these tests.`;
  const commands = (repo.verificationCommands ?? []).map((c) => c.trim()).filter(Boolean);
  if (commands.length > 0) {
    const redRes = await ctx.workspace.runVerificationCommands(
      worktreePath,
      commands,
      ticket.mandate.maxDurationSec,
      {
        sandboxMode: repo.sandboxMode ?? "balanced",
        forbiddenPaths: ticket.mandate.forbiddenPaths,
        allowNetwork: ticket.mandate.allowNetwork,
        rootRepoPath: repo.rootPath,
      },
    );
    const logBody = redRes.results
      .map(
        (r) =>
          `$ ${r.command}\n[exit=${r.exitCode}, duration=${r.durationMs}ms]\n${r.output || "(no output)"}\n`,
      )
      .join("\n---\n");
    const probeArtifact = await ctx.artifactStore.writeSpill(
      {
        ticketId: ticket.id,
        stageRunId: stageRun.id,
        kind: "test_log",
        summary: `Red-first probe (${redRes.ok ? "GREEN advisory" : "RED expected fail"})`,
        ext: "log",
      },
      logBody || redRes.summary,
    );
    await ctx.stateStore.saveArtifact(probeArtifact, `${redRes.summary}\n${logBody}`);
    extraArtifacts.push(probeArtifact);
    redProbeHint = redRes.ok
      ? `Red-first probe passed early (advisory). Implement remaining behavior cleanly without modifying locked tests: ${testFiles.join(", ")}.`
      : `Red-first probe failed as expected (RED phase) on ${redRes.failedCommand ?? "tests"}. Locked read-only spec tests: ${testFiles.join(", ")}. Implement code until checks pass.`;
  }

  await ctx.workspace.commitAll(worktreePath, `super-work(${ticket.id}/spec_test): lock spec tests`);
  const specTestCommitSha = ctx.workspace.getHeadCommitSha
    ? await ctx.workspace.getHeadCommitSha(worktreePath).catch(() => undefined)
    : undefined;

  const finishedRun: StageRun = {
    ...stageRun,
    status: "completed",
    nativeSessionId: discoveredSessionId,
    costUsd: stageCostUsd,
    toolProfile: buildStageToolProfile(collectedEvents),
    completedAt: nowIso(),
    summary: `${summary}\nLocked ${testFiles.length} spec test file(s).`,
  };
  const { note } = await ctx.memory.recordStageSpillAndNote({
    ticket,
    stageRun: finishedRun,
    events: collectedEvents,
    changedFiles: testFiles,
    diffText,
    summary: finishedRun.summary!,
    verificationPassed: true,
    extraArtifacts: extraArtifacts.length > 0 ? extraArtifacts : undefined,
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

  await ctx.captureTicketCheckpoint(ticket, repo, worktreePath, {
    stage: "spec_test",
    stageRunId: finishedRun.id,
    engine: driverEngine,
    label: `Locked ${testFiles.length} spec test file(s)`,
    changedFiles: testFiles,
    verificationPassed: true,
  });

  const nextStage = getNextStage(ticket.template, "spec_test", ticket.tddMode) ?? "implement";
  const nextTicket: Ticket = {
    ...ticket,
    status: "queued",
    currentStage: nextStage,
    stageRetries: 0,
    lockedTestPaths: testFiles,
    specTestCommitSha,
    costUsd: ticket.costUsd + stageCostUsd,
    nativeSessions: updatedSessions,
    activeEngine: undefined,
    failedEngines: [],
    inlineMemory: {
      ...ticket.inlineMemory,
      stageNotes: [...ticket.inlineMemory.stageNotes, note],
      activeHint: redProbeHint,
    },
    updatedAt: nowIso(),
  };
  await ctx.stateStore.saveTicket(nextTicket);
  ctx.emitEvent({ type: "ticket_updated", ticket: nextTicket, timestamp: nextTicket.updatedAt });
}

export async function handleRebaseStageOp(
  ctx: KernelCoordinatorContext,
  ticket: Ticket,
  repo: RepoConfig,
  stageRun: StageRun,
): Promise<void> {
  const worktreePath = ticket.worktreePath!;
  const { effectiveBaseBranch, parentEpic } = await ctx.getEffectiveBaseInfo(ticket, repo);
  const spans = new SpanRecorder();
  let workingTicket = ticket;
  let preConflictCp: TicketCheckpoint | null = null;
  let attemptConflictCtx: ConflictSemanticContext | undefined;
  let autoResolvedConflict = false;
  let resolveCostUsd = 0;

  const commitSpan = spans.start("git_ops", `Commit & rebase onto ${effectiveBaseBranch}`);
  await ctx.workspace.commitAll(worktreePath, `super-work(${ticket.id}): ${ticket.title}`);
  const rebaseRes = await ctx.workspace.rebaseOntoBase(worktreePath, effectiveBaseBranch);
  spans.end(commitSpan, rebaseRes.ok ? "ok" : "failed", rebaseRes.conflictSummary);

  if (!rebaseRes.ok) {
    const canAttemptSemanticResolve =
      (ticket.conflictResolutionCount ?? 0) < 1 &&
      Boolean(ctx.workspace.prepareThreeWayConflictWorkspace);

    if (!canAttemptSemanticResolve) {
      const failedRun: StageRun = {
        ...stageRun,
        status: "failed",
        spans: spans.toArray(),
        completedAt: nowIso(),
        summary: rebaseRes.conflictSummary ?? "Rebase conflict",
      };
      await ctx.stateStore.saveStageRun(failedRun);

      if (ticket.stageRetries < ticket.mandate.maxStageRetries) {
        const retryTicket: Ticket = {
          ...ticket,
          status: "queued",
          currentStage: "implement",
          stageRetries: ticket.stageRetries + 1,
          inlineMemory: {
            ...ticket.inlineMemory,
            activeHint: `Rebase onto ${effectiveBaseBranch} failed with conflicts: ${rebaseRes.conflictSummary}. Update code to stay compatible and re-test.`,
          },
          updatedAt: nowIso(),
        };
        await ctx.stateStore.saveTicket(retryTicket);
        ctx.emitEvent({ type: "ticket_updated", ticket: retryTicket, timestamp: retryTicket.updatedAt });
      } else if (ticket.campaignId) {
        await failCampaignWaveTicket(
          ctx,
          ticket,
          repo,
          `Rebase conflict: ${rebaseRes.conflictSummary}`,
        );
      } else {
        await ctx.escalateTicket(
          ticket,
          "merge_conflict",
          `Rebase onto ${effectiveBaseBranch} conflicted: ${rebaseRes.conflictSummary}`,
          { branchName: ticket.branchName, conflictContext: ticket.conflictContext },
        );
      }
      return;
    }

    preConflictCp = await ctx.captureTicketCheckpoint(ticket, repo, worktreePath, {
      stage: "rebase",
      stageRunId: stageRun.id,
      label: `Pre-rebase conflict snapshot (${effectiveBaseBranch})`,
      changedFiles: [],
    });

    const prepSpan = spans.start("git_ops", "Prepare 3-way semantic conflict workspace");
    const prep = await ctx.workspace.prepareThreeWayConflictWorkspace!({
      worktreePath,
      rootRepoPath: repo.rootPath,
      baseBranch: effectiveBaseBranch,
    });
    attemptConflictCtx = {
      baseBranch: effectiveBaseBranch,
      mergeBaseSha: prep.mergeBaseSha,
      upstreamCommitSummaries: prep.upstreamCommitSummaries,
      conflictFiles: prep.conflictFiles,
      fileHunks: prep.fileHunks,
    };
    spans.end(
      prepSpan,
      prep.conflictFiles.length > 0 ? "ok" : "failed",
      `${prep.conflictFiles.length} file(s)`,
    );

    const availableEngines = await ctx.getAvailableEngines();
    let chosenEngine = selectEngineForStage(repo, "implement", ticket.preferredEngine);
    if (!ctx.drivers.has(chosenEngine) && availableEngines[0]) {
      chosenEngine = availableEngines[0];
    }
    const driver = ctx.drivers.get(chosenEngine);

    const failConflictEscalation = async (
      reason: string,
      collectedEvents: WorkerStreamEvent[] = [],
    ): Promise<void> => {
      if (preConflictCp && ctx.workspace.restoreWorktreeCheckpoint) {
        await ctx.workspace
          .restoreWorktreeCheckpoint({
            worktreePath,
            rootRepoPath: repo.rootPath,
            commitSha: preConflictCp.commitSha,
          })
          .catch(() => {});
      }
      const failedCtx: ConflictSemanticContext = {
        ...attemptConflictCtx!,
        resolvedAutomatically: false,
        resolutionSummary: reason,
      };
      const failedRun: StageRun = {
        ...stageRun,
        status: "failed",
        costUsd: resolveCostUsd,
        spans: spans.toArray(),
        completedAt: nowIso(),
        summary: reason,
      };
      const { note: failNote } = await ctx.memory.recordStageSpillAndNote({
        ticket,
        stageRun: failedRun,
        events: collectedEvents,
        changedFiles: attemptConflictCtx?.conflictFiles ?? [],
        summary: reason,
        verificationPassed: false,
      });
      failedRun.spillTranscriptId = failNote.spillArtifactIds[0];
      await ctx.stateStore.saveStageRun(failedRun);
      await ctx.escalateTicket(
        {
          ...ticket,
          costUsd: ticket.costUsd + resolveCostUsd,
          conflictResolutionCount: (ticket.conflictResolutionCount ?? 0) + 1,
          conflictContext: failedCtx,
          inlineMemory: {
            ...ticket.inlineMemory,
            stageNotes: [...ticket.inlineMemory.stageNotes, failNote],
          },
        },
        "merge_conflict",
        reason,
        {
          branchName: ticket.branchName,
          conflictContext: failedCtx,
          stageRunId: stageRun.id,
        },
      );
    };

    if (!driver || prep.conflictFiles.length === 0) {
      await failConflictEscalation(
        `Rebase onto ${effectiveBaseBranch} conflicted (${prep.conflictFiles.join(", ") || rebaseRes.conflictSummary}); automatic 3-way resolution unavailable.`,
      );
      return;
    }

    const conflictPrompt = buildConflictResolutionPrompt(ticket, attemptConflictCtx);
    const resolveSpan = spans.start(
      "worker_turn",
      `3-way conflict resolve (${prep.conflictFiles.length} file(s), ${driver.engine})`,
    );
    const collectedEvents: WorkerStreamEvent[] = [];
    let completedEvent: Extract<WorkerStreamEvent, { type: "completed" }> | undefined;
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(
      () => abortController.abort("conflict_resolve_timeout"),
      Math.max(30_000, ticket.mandate.maxDurationSec * 1000),
    );
    try {
      const stream = driver.runTurn(
        {
          ticketId: ticket.id,
          stageRunId: stageRun.id,
          stage: "implement",
          worktreePath,
          prompt: conflictPrompt,
          mandate: ticket.mandate,
          isResume: false,
          sandboxMode: repo.sandboxMode ?? "balanced",
          rootRepoPath: repo.rootPath,
          readOnlyPaths: ticket.lockedTestPaths,
        },
        abortController.signal,
      );
      for await (const ev of stream) {
        collectedEvents.push(ev);
        ctx.emitEvent({
          type: "worker_event",
          ticketId: ticket.id,
          stageRunId: stageRun.id,
          engine: driver.engine,
          event: ev,
          timestamp: ev.timestamp,
        });
        if (ev.type === "usage") {
          resolveCostUsd = Math.max(resolveCostUsd, ev.costUsd);
        } else if (ev.type === "completed") {
          completedEvent = ev;
          if (typeof ev.costUsd === "number") {
            resolveCostUsd = Math.max(resolveCostUsd, ev.costUsd);
          }
        }
      }
    } catch (err) {
      spans.end(resolveSpan, "failed", err instanceof Error ? err.message : String(err));
      await failConflictEscalation(
        `3-way conflict resolver errored: ${err instanceof Error ? err.message : String(err)}`,
        collectedEvents,
      );
      return;
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (!completedEvent) {
      const errMsg =
        [...collectedEvents].reverse().find((e) => e.type === "error")?.message ??
        "Conflict resolution worker did not complete";
      spans.end(resolveSpan, "failed", errMsg);
      await failConflictEscalation(`3-way conflict resolution failed: ${errMsg}`, collectedEvents);
      return;
    }

    const leftoverMarkers = prep.conflictFiles.filter((relPath) => {
      const abs = join(worktreePath, relPath);
      if (!existsSync(abs)) return false;
      const content = readFileSync(abs, "utf8");
      return /^(<{7}|={7}|>{7})/m.test(content);
    });
    if (leftoverMarkers.length > 0) {
      spans.end(resolveSpan, "failed", `Leftover conflict markers in ${leftoverMarkers.join(", ")}`);
      await failConflictEscalation(
        `3-way conflict resolution left unresolved markers in: ${leftoverMarkers.join(", ")}`,
        collectedEvents,
      );
      return;
    }

    if (
      ticket.lockedTestPaths &&
      ticket.lockedTestPaths.length > 0 &&
      ticket.specTestCommitSha &&
      ctx.workspace.getChangedFilesSince
    ) {
      const changedSinceSpec = await ctx.workspace.getChangedFilesSince(
        worktreePath,
        ticket.specTestCommitSha,
      );
      const tampered = changedSinceSpec.filter((f) => ticket.lockedTestPaths!.includes(f));
      if (tampered.length > 0) {
        await ctx.workspace.revertPathsToCommit?.(worktreePath, ticket.specTestCommitSha, tampered);
        spans.end(resolveSpan, "failed", `Tampered locked tests: ${tampered.join(", ")}`);
        await failConflictEscalation(
          `3-way conflict resolution modified locked spec tests (${tampered.join(", ")})`,
          collectedEvents,
        );
        return;
      }
    }

    const postResolveFiles = await ctx.workspace.getChangedFiles(worktreePath, effectiveBaseBranch);
    const mandateFiles = ticket.lockedTestPaths?.length
      ? postResolveFiles.filter((f) => !ticket.lockedTestPaths!.includes(f))
      : postResolveFiles;
    const mandateRes = validateChangedFilesAgainstMandate(mandateFiles, ticket.mandate);
    if (!mandateRes.ok) {
      spans.end(resolveSpan, "failed", `Mandate violation: ${mandateRes.violations.join(", ")}`);
      await failConflictEscalation(
        `3-way conflict resolution violated Mandate paths: ${mandateRes.violations.join(", ")}`,
        collectedEvents,
      );
      return;
    }

    const resolveSummary = completedEvent.summary || "3-way semantic conflict resolved";
    spans.end(resolveSpan, "ok", `$${resolveCostUsd.toFixed(3)}`);
    autoResolvedConflict = true;
    attemptConflictCtx = {
      ...attemptConflictCtx,
      resolvedAutomatically: true,
      resolutionSummary: resolveSummary.slice(0, 400),
    };
    workingTicket = {
      ...ticket,
      costUsd: ticket.costUsd + resolveCostUsd,
      conflictResolutionCount: (ticket.conflictResolutionCount ?? 0) + 1,
      conflictContext: attemptConflictCtx,
    };
  }

  const gate = await runRepoVerificationGateOp(ctx, workingTicket, repo, stageRun, worktreePath, {
    isFinalDeliveryGate: !parentEpic,
  });
  spans.addExisting(gate.spans);
  if (!gate.passed) {
    if (autoResolvedConflict && preConflictCp && ctx.workspace.restoreWorktreeCheckpoint) {
      await ctx.workspace
        .restoreWorktreeCheckpoint({
          worktreePath,
          rootRepoPath: repo.rootPath,
          commitSha: preConflictCp.commitSha,
        })
        .catch(() => {});
    }
    const failedSummary = gate.result?.summary ?? "Post-rebase verification gate failed";
    const failedCtx =
      autoResolvedConflict && attemptConflictCtx
        ? { ...attemptConflictCtx, resolvedAutomatically: false, resolutionSummary: failedSummary }
        : attemptConflictCtx;
    const failedRun: StageRun = {
      ...stageRun,
      status: "failed",
      costUsd: resolveCostUsd,
      spans: spans.toArray(),
      completedAt: nowIso(),
      summary: failedSummary,
    };
    const changedFiles = await ctx.workspace.getChangedFiles(worktreePath, effectiveBaseBranch);
    const { note: failNote } = await ctx.memory.recordStageSpillAndNote({
      ticket: workingTicket,
      stageRun: failedRun,
      events: [],
      changedFiles,
      summary: failedSummary,
      verificationPassed: false,
      extraArtifacts: gate.artifacts.length > 0 ? gate.artifacts : undefined,
    });
    await ctx.stateStore.saveStageRun(failedRun);

    if (!autoResolvedConflict && ticket.stageRetries < ticket.mandate.maxStageRetries) {
      const retryTicket: Ticket = {
        ...workingTicket,
        status: "queued",
        currentStage: "implement",
        stageRetries: ticket.stageRetries + 1,
        inlineMemory: {
          ...ticket.inlineMemory,
          stageNotes: [...ticket.inlineMemory.stageNotes, failNote],
          activeHint: `Post-rebase verification failed (${gate.result?.failedCommand ?? "checks"}). Fix the issue and ensure checks pass:\n${failedSummary}`,
        },
        updatedAt: nowIso(),
      };
      await ctx.stateStore.saveTicket(retryTicket);
      ctx.emitEvent({
        type: "ticket_updated",
        ticket: retryTicket,
        timestamp: retryTicket.updatedAt,
      });
    } else if (workingTicket.campaignId) {
      await failCampaignWaveTicket(ctx, workingTicket, repo, failedSummary);
    } else {
      await ctx.escalateTicket(
        {
          ...workingTicket,
          conflictContext: failedCtx,
          inlineMemory: {
            ...workingTicket.inlineMemory,
            stageNotes: [...workingTicket.inlineMemory.stageNotes, failNote],
          },
        },
        autoResolvedConflict ? "merge_conflict" : "watchdog_escalation",
        autoResolvedConflict
          ? `3-way conflict resolved edits failed verification gate: ${failedSummary}`
          : `Post-rebase verification failed: ${failedSummary}`,
        {
          stageRunId: stageRun.id,
          branchName: ticket.branchName,
          ...(failedCtx ? { conflictContext: failedCtx } : {}),
        },
      );
    }
    return;
  }

  if (autoResolvedConflict) {
    const commitResolvedSpan = spans.start("git_ops", "Commit resolved rebase tree");
    await ctx.workspace.commitAll(
      worktreePath,
      `super-work(${ticket.id}): 3-way conflict resolved onto ${effectiveBaseBranch}`,
    );
    spans.end(commitResolvedSpan, "ok");
  }

  const baseHeadAtRebase = ctx.workspace.getHeadCommitSha
    ? await ctx.workspace.getHeadCommitSha(repo.rootPath, effectiveBaseBranch).catch(() => undefined)
    : undefined;

  const finishedRun: StageRun = {
    ...stageRun,
    status: "completed",
    costUsd: resolveCostUsd,
    spans: spans.toArray(),
    completedAt: nowIso(),
    summary: autoResolvedConflict
      ? `3-way conflict auto-resolved onto ${effectiveBaseBranch}${gate.result?.summary ? `; ${gate.result.summary}` : ""}`
      : gate.artifacts.length > 0
        ? `Rebased cleanly onto ${effectiveBaseBranch}; ${gate.result?.summary ?? "verification passed"}`
        : `Rebased cleanly onto ${effectiveBaseBranch}`,
  };
  const changedFiles = await ctx.workspace.getChangedFiles(worktreePath, effectiveBaseBranch);
  const diffText = await ctx.workspace.getDiff(worktreePath, effectiveBaseBranch);
  const { note } = await ctx.memory.recordStageSpillAndNote({
    ticket: workingTicket,
    stageRun: finishedRun,
    events: [],
    changedFiles,
    diffText,
    summary: finishedRun.summary!,
    verificationPassed: true,
    extraArtifacts: gate.artifacts.length > 0 ? gate.artifacts : undefined,
  });
  finishedRun.spillTranscriptId = note.spillArtifactIds[0];
  await ctx.stateStore.saveStageRun(finishedRun);
  await ctx.captureTicketCheckpoint(workingTicket, repo, worktreePath, {
    stage: "rebase",
    stageRunId: finishedRun.id,
    engine: stageRun.engine,
    label: autoResolvedConflict
      ? `3-way conflict resolved onto ${effectiveBaseBranch}`
      : `Rebased cleanly onto ${effectiveBaseBranch}`,
    changedFiles,
    verificationPassed: true,
  });
  ctx.emitEvent({
    type: "stage_completed",
    ticketId: ticket.id,
    stageRun: finishedRun,
    note,
    timestamp: finishedRun.completedAt!,
  });

  if (parentEpic && parentEpic.branchName) {
    await ctx.runWithEpicLock(parentEpic.id, () =>
      ctx.workspace.mergeBranchToBase({
        rootRepoPath: repo.rootPath,
        baseBranch: parentEpic.branchName!,
        branchName: ticket.branchName!,
        worktreePath,
        commitMessage: `epic(${parentEpic.id}/${ticket.subtaskKey ?? ticket.id}): ${ticket.title}`,
        deleteBranch: true,
      }),
    );
    const deliveredTs = nowIso();
    await ctx.workspace.cleanupTicketCheckpoints?.(repo.rootPath, ticket.id).catch(() => {});
    await ctx.stateStore.markCheckpointsCleaned(ticket.id, deliveredTs).catch(() => {});
    let deliveredSubtask: Ticket = {
      ...workingTicket,
      status: "delivered",
      activeEngine: undefined,
      worktreePath: undefined,
      worktreeCleanedAt: deliveredTs,
      inlineMemory: {
        ...workingTicket.inlineMemory,
        stageNotes: [...workingTicket.inlineMemory.stageNotes, note],
      },
      updatedAt: deliveredTs,
    };
    await ctx.maybeDistillClosedLoopLesson(deliveredSubtask, repo);
    await ctx.stateStore.saveTicket(deliveredSubtask);
    deliveredSubtask = await ctx.generateAndSaveHandoverDigest(deliveredSubtask, repo, {
      changedFiles,
      diffText,
    });
    await ctx.recordDeliveredCasebookEntry(deliveredSubtask, repo);
    await ctx.maybeEvaluateEpicReplan(parentEpic.id, deliveredSubtask);
    return;
  }

  if (ticket.campaignId && ticket.targetBranch && ticket.targetBranch !== repo.baseBranch) {
    await mergeWaveToTargetStagingBranch(
      ctx,
      {
        ...workingTicket,
        inlineMemory: {
          ...workingTicket.inlineMemory,
          stageNotes: [...workingTicket.inlineMemory.stageNotes, note],
        },
      },
      repo,
      worktreePath,
      ticket.targetBranch,
      changedFiles,
      diffText,
    );
    return;
  }

  await ctx.enqueueDeliveryOutbox(
    {
      ...workingTicket,
      baseHeadAtRebase,
      inlineMemory: {
        ...workingTicket.inlineMemory,
        stageNotes: [...workingTicket.inlineMemory.stageNotes, note],
      },
    },
    repo,
  );
}
