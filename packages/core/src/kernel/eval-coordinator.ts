import { matchesPathScope } from "../mandate.ts";
import { evaluateTicketRisk } from "../risk.ts";
import type {
  EvalCandidateRun,
  EvalCase,
  EvalRunRecord,
  RepoConfig,
  Ticket,
  WorkerEngineId,
  WorkerStreamEvent,
} from "../types.ts";
import { newId, nowIso } from "../utils.ts";
import type { KernelCoordinatorContext } from "./context.ts";

export async function createEvalCaseFromTicket(
  ctx: KernelCoordinatorContext,
  ticketId: string,
): Promise<EvalCase> {
  if (!ctx.stateStore.saveEvalCase) {
    throw new Error("Configured StateStore does not support Golden Eval Cases.");
  }
  const ticket = await ctx.stateStore.getTicket(ticketId);
  if (!ticket) {
    throw new Error(`Ticket not found: ${ticketId}`);
  }
  const repo = await ctx.stateStore.getRepo(ticket.repoId);
  if (!repo) {
    throw new Error(`Repository not found: ${ticket.repoId}`);
  }

  const [checkpoints, stageRuns, diffs] = await Promise.all([
    ctx.stateStore.listCheckpoints(ticket.id),
    ctx.stateStore.listStageRuns(ticket.id),
    ctx.stateStore.listArtifacts(ticket.id),
  ]);

  const baselineCp = checkpoints.find((c) => c.stage === "baseline");
  let baseCommitSha = baselineCp?.commitSha;
  if (!baseCommitSha && ctx.workspace.getHeadCommitSha) {
    baseCommitSha = await ctx.workspace
      .getHeadCommitSha(repo.rootPath, repo.baseBranch)
      .catch(() => undefined);
  }
  if (!baseCommitSha) {
    throw new Error(
      `Unable to resolve baseCommitSha for ticket ${ticket.id} (no baseline checkpoint or Git HEAD).`,
    );
  }

  const implRuns = stageRuns.filter((r) => r.stage === "implement" && r.status === "completed");
  const totalDurationMs = implRuns.reduce((sum, r) => {
    const start = Date.parse(r.startedAt);
    const end = r.completedAt ? Date.parse(r.completedAt) : start;
    return sum + Math.max(0, end - start);
  }, 0);
  const latestImpl = implRuns[implRuns.length - 1];

  const diffText =
    diffs
      .filter((a) => a.kind === "diff")
      .slice(-1)[0]?.summary ?? "";
  void diffText;

  const ts = nowIso();
  const evalCase: EvalCase = {
    id: newId("evc"),
    repoId: repo.id,
    sourceTicketId: ticket.id,
    title: ticket.title,
    description: ticket.description,
    baseCommitSha,
    allowedPaths: [...ticket.mandate.allowedPaths],
    forbiddenPaths: [...ticket.mandate.forbiddenPaths],
    tddMode: ticket.tddMode,
    lockedTestPaths: ticket.lockedTestPaths ? [...ticket.lockedTestPaths] : undefined,
    verificationCommands: [...(repo.verificationCommands ?? [])],
    smokeCheck: repo.smokeCheck ? structuredClone(repo.smokeCheck) : undefined,
    referenceMetrics: {
      durationMs: totalDurationMs > 0 ? totalDurationMs : undefined,
      costUsd: ticket.costUsd,
      engine: latestImpl?.engine ?? ticket.activeEngine,
    },
    createdAt: ts,
    updatedAt: ts,
  };

  await ctx.stateStore.saveEvalCase(evalCase);
  return evalCase;
}

function buildEvalImplementPrompt(evalCase: EvalCase, repo: RepoConfig): string {
  return [
    `# Golden Benchmark Evaluation Task`,
    `Repository: ${repo.name} (${repo.baseBranch})`,
    `Title: ${evalCase.title}`,
    `Goal:\n${evalCase.description}`,
    `Allowed paths (STRICT Mandate): ${evalCase.allowedPaths.join(", ")}`,
    `Forbidden paths: ${evalCase.forbiddenPaths.join(", ")}`,
    evalCase.lockedTestPaths?.length
      ? `Locked read-only spec tests (DO NOT MODIFY): ${evalCase.lockedTestPaths.join(", ")}`
      : "",
    evalCase.verificationCommands.length > 0
      ? `Verification commands to satisfy: ${evalCase.verificationCommands.join(" && ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function runEvalCase(
  ctx: KernelCoordinatorContext,
  input: {
    evalCaseId: string;
    engines?: WorkerEngineId[];
    maxBudgetUsd?: number;
  },
): Promise<EvalRunRecord> {
  if (!ctx.stateStore.getEvalCase || !ctx.stateStore.saveEvalRun) {
    throw new Error("Configured StateStore does not support Golden Eval Runs.");
  }
  const evalCase = await ctx.stateStore.getEvalCase(input.evalCaseId);
  if (!evalCase) {
    throw new Error(`Eval case not found: ${input.evalCaseId}`);
  }
  const repo = await ctx.stateStore.getRepo(evalCase.repoId);
  if (!repo) {
    throw new Error(`Repository not found: ${evalCase.repoId}`);
  }
  if (!ctx.workspace.prepareDetachedWorktree) {
    throw new Error("WorkspaceProvider does not support detached eval worktrees.");
  }

  const available = await ctx.getAvailableEngines();
  const requestedEngines = (
    input.engines && input.engines.length > 0
      ? input.engines
      : available.slice(0, 2)
  ).filter((eng) => ctx.drivers.has(eng));

  if (requestedEngines.length === 0) {
    throw new Error("No available worker driver engines found to run Golden Eval.");
  }

  const maxBudgetUsd = Math.max(0.25, input.maxBudgetUsd ?? 2.0);
  const runId = newId("evr");
  const initialRecord: EvalRunRecord = {
    id: runId,
    evalCaseId: evalCase.id,
    repoId: repo.id,
    status: "running",
    engines: requestedEngines,
    results: [],
    maxBudgetUsd,
    totalCostUsd: 0,
    startedAt: nowIso(),
  };
  await ctx.stateStore.saveEvalRun(initialRecord);
  ctx.emitEvent({
    type: "eval_run_updated",
    repoId: repo.id,
    evalRun: initialRecord,
    timestamp: initialRecord.startedAt,
  });

  const results: EvalCandidateRun[] = [];
  let totalCostUsd = 0;

  for (const engine of requestedEngines) {
    const driver = ctx.drivers.get(engine);
    if (!driver) continue;

    const candidateStarted = Date.now();
    let candidateCost = 0;
    let worktreePath: string | undefined;

    try {
      const wt = await ctx.workspace.prepareDetachedWorktree(
        repo.rootPath,
        evalCase.baseCommitSha,
        `${runId}-${engine}`,
      );
      worktreePath = wt.worktreePath;

      const syntheticTicketId = `eval_${runId}_${engine}`;
      const abortCtrl = new AbortController();
      const timeoutHandle = setTimeout(() => abortCtrl.abort("eval_timeout"), 300_000);
      let completedEvent: Extract<WorkerStreamEvent, { type: "completed" }> | undefined;
      let errMsg: string | undefined;

      try {
        const stream = driver.runTurn(
          {
            ticketId: syntheticTicketId,
            stageRunId: `${syntheticTicketId}_impl`,
            stage: "implement",
            worktreePath,
            prompt: buildEvalImplementPrompt(evalCase, repo),
            mandate: {
              allowedPaths: evalCase.allowedPaths,
              forbiddenPaths: evalCase.forbiddenPaths,
              allowNetwork: false,
              allowExternalSideEffects: false,
              maxCostUsd: maxBudgetUsd,
              maxDurationSec: 300,
              maxStageRetries: 0,
            },
            isResume: false,
            sandboxMode: repo.sandboxMode ?? "balanced",
            rootRepoPath: repo.rootPath,
            readOnlyPaths: evalCase.lockedTestPaths,
          },
          abortCtrl.signal,
        );
        for await (const ev of stream) {
          if (ev.type === "usage") {
            candidateCost = Math.max(candidateCost, ev.costUsd);
          } else if (ev.type === "completed") {
            completedEvent = ev;
            if (typeof ev.costUsd === "number") {
              candidateCost = Math.max(candidateCost, ev.costUsd);
            }
          } else if (ev.type === "error" && ev.fatal) {
            errMsg = ev.message;
          }
        }
      } finally {
        clearTimeout(timeoutHandle);
      }

      const numstat = ctx.workspace.getWorktreeNumstat
        ? await ctx.workspace
            .getWorktreeNumstat(worktreePath, evalCase.baseCommitSha)
            .catch(() => null)
        : null;
      const changedFiles =
        numstat?.changedFiles ??
        (await ctx.workspace.getChangedFiles(worktreePath, evalCase.baseCommitSha).catch(() => []));
      const addedLines = numstat?.addedLines ?? 0;
      const deletedLines = numstat?.deletedLines ?? 0;

      // Enforce mandate & locked tests deterministically
      const forbiddenHits = changedFiles.filter((f) => matchesPathScope(f, evalCase.forbiddenPaths));
      const lockedHits = evalCase.lockedTestPaths?.length
        ? changedFiles.filter((f) => matchesPathScope(f, evalCase.lockedTestPaths!))
        : [];
      const outOfScopeHits =
        evalCase.allowedPaths.includes("**")
          ? []
          : changedFiles.filter((f) => !matchesPathScope(f, evalCase.allowedPaths));

      let verificationPassed = Boolean(completedEvent) && !errMsg;
      let verificationSummary = errMsg
        ? `Worker failed: ${errMsg}`
        : "Worker turn completed";
      let smokeOk = true;
      let maxVisualDiffRatio: number | undefined;

      if (forbiddenHits.length > 0 || lockedHits.length > 0 || outOfScopeHits.length > 0) {
        verificationPassed = false;
        const bad = [...forbiddenHits, ...lockedHits, ...outOfScopeHits];
        verificationSummary = `Scope/test lock violation on: ${bad.slice(0, 4).join(", ")}`;
      } else if (verificationPassed && evalCase.verificationCommands.length > 0) {
        const verRes = await ctx.workspace.runVerificationCommands(
          worktreePath,
          evalCase.verificationCommands,
          180,
          {
            sandboxMode: repo.sandboxMode ?? "balanced",
            forbiddenPaths: evalCase.forbiddenPaths,
            readOnlyPaths: evalCase.lockedTestPaths,
            rootRepoPath: repo.rootPath,
          },
        );
        verificationPassed = verRes.ok;
        verificationSummary = verRes.summary;
      }

      if (verificationPassed && evalCase.smokeCheck?.enabled && ctx.workspace.runSmokeCheck) {
        const smokeRes = await ctx.workspace.runSmokeCheck(worktreePath, evalCase.smokeCheck);
        smokeOk = smokeRes.ok;
        verificationPassed = smokeRes.ok;
        verificationSummary = `${verificationSummary} | Smoke: ${smokeRes.summary}`;
        const ratios = smokeRes.rawVisualDiffs?.map((d) => d.diffRatio) ?? [];
        if (ratios.length > 0) {
          maxVisualDiffRatio = Math.max(...ratios);
        }
      }

      const transientTicket: Ticket = {
        id: syntheticTicketId,
        repoId: repo.id,
        threadId: "eval",
        sourceTriggerId: "eval",
        title: evalCase.title,
        description: evalCase.description,
        status: verificationPassed ? "outbox_pending" : "failed",
        template: "standard",
        currentStage: "implement",
        stageRetries: 0,
        mandate: {
          allowedPaths: evalCase.allowedPaths,
          forbiddenPaths: evalCase.forbiddenPaths,
          allowNetwork: false,
          allowExternalSideEffects: false,
          maxCostUsd: maxBudgetUsd,
          maxDurationSec: 300,
          maxStageRetries: 0,
        },
        dependsOn: [],
        tddMode: evalCase.tddMode,
        lockedTestPaths: evalCase.lockedTestPaths,
        nativeSessions: {},
        inlineMemory: {
          goal: evalCase.title,
          acceptanceCriteria: [],
          stageNotes: [],
          threadUpdates: [],
        },
        costUsd: candidateCost,
        priority: 1,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };

      const risk = evaluateTicketRisk({
        ticket: transientTicket,
        repo,
        changedFiles,
        addedLines,
        deletedLines,
        maxVisualDiffRatio,
        staticVerificationPassed: verificationPassed,
        smokeResult: evalCase.smokeCheck?.enabled
          ? {
              ok: smokeOk,
              port: 0,
              readyUrl: "",
              startupDurationMs: 0,
              checkResults: [],
              serverOutputTail: "",
              summary: verificationSummary,
            }
          : undefined,
      });

      results.push({
        engine,
        passed: verificationPassed,
        verificationSummary,
        durationMs: Math.max(1, Date.now() - candidateStarted),
        costUsd: Number(candidateCost.toFixed(4)),
        changedFiles,
        addedLines,
        deletedLines,
        riskScore: risk.score,
        error: verificationPassed ? undefined : errMsg ?? verificationSummary,
      });
    } catch (err) {
      results.push({
        engine,
        passed: false,
        verificationSummary: err instanceof Error ? err.message : String(err),
        durationMs: Math.max(1, Date.now() - candidateStarted),
        costUsd: Number(candidateCost.toFixed(4)),
        changedFiles: [],
        addedLines: 0,
        deletedLines: 0,
        riskScore: 100,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      totalCostUsd += candidateCost;
      if (worktreePath) {
        await ctx.workspace.cleanupWorkspace(worktreePath, repo.rootPath).catch(() => {});
      }
    }
  }

  const finalRecord: EvalRunRecord = {
    ...initialRecord,
    status: results.length > 0 ? "completed" : "failed",
    results,
    totalCostUsd: Number(totalCostUsd.toFixed(4)),
    completedAt: nowIso(),
  };
  await ctx.stateStore.saveEvalRun(finalRecord);
  ctx.emitEvent({
    type: "eval_run_updated",
    repoId: repo.id,
    evalRun: finalRecord,
    timestamp: finalRecord.completedAt!,
  });
  return finalRecord;
}
