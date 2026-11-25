import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isUiIntentTicket } from "../engine-router.ts";
import { createDefaultMandate } from "../mandate.ts";
import type {
  RepoConfig,
  ScopedVerificationInfo,
  SmokeCheckResult,
  SpillArtifact,
  StageRun,
  StageSpan,
  Ticket,
  VerificationRunResult,
} from "../types.ts";
import { nowIso } from "../utils.ts";
import type { KernelCoordinatorContext } from "./context.ts";
import { SpanRecorder } from "./span-recorder.ts";

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
    if (resolved.useScoped) {
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

async function runHotspotParityGuard(
  ctx: KernelCoordinatorContext,
  ticket: Ticket,
  repo: RepoConfig,
  stageRun: StageRun,
  worktreePath: string,
): Promise<{ result: VerificationRunResult; artifact: SpillArtifact } | undefined> {
  const guard = ticket.refactorGuard;
  if (
    !guard?.targetHotspotPath ||
    !ctx.workspace.verifyHotspotRefactorParity ||
    (stageRun.stage !== "implement" && stageRun.stage !== "rebase")
  ) {
    return undefined;
  }
  let parity: Awaited<ReturnType<NonNullable<typeof ctx.workspace.verifyHotspotRefactorParity>>>;
  try {
    parity = await ctx.workspace.verifyHotspotRefactorParity({
      worktreePath,
      baseBranch: ticket.targetBranch ?? repo.baseBranch,
      targetHotspotPath: guard.targetHotspotPath,
      maxLinesAfter: guard.maxLinesAfter ?? 1200,
      enforceExportParity: guard.enforceExportParity ?? true,
    });
  } catch {
    return undefined;
  }
  if (parity.ok) return undefined;
  const summary = `Hotspot refactor guard failed: ${parity.summary}`;
  const artifact = await ctx.artifactStore.writeSpill(
    {
      ticketId: ticket.id,
      stageRunId: stageRun.id,
      kind: "test_log",
      summary: `FAIL hotspot-parity (${guard.targetHotspotPath})`,
      ext: "log",
    },
    summary,
  );
  await ctx.stateStore.saveArtifact(artifact, summary);
  return {
    artifact,
    result: {
      ok: false,
      summary,
      failedCommand: "hotspot-parity",
      results: [
        {
          command: `hotspot-parity ${guard.targetHotspotPath}`,
          exitCode: 1,
          durationMs: 0,
          output: summary,
        },
      ],
    } as VerificationRunResult,
  };
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

    const parityFail = await runHotspotParityGuard(ctx, ticket, repo, stageRun, worktreePath);
    if (parityFail) {
      artifacts.push(parityFail.artifact);
      ctx.emitEvent({
        type: "verification_completed",
        ticketId: ticket.id,
        stageRunId: stageRun.id,
        result: parityFail.result,
        timestamp: nowIso(),
      });
      return { passed: false, artifacts, result: parityFail.result, spans: spans.toArray() };
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
