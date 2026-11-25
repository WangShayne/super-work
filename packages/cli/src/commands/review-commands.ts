import type {
  DagNodeMutationInput,
  EnginePreference,
  StageKind,
  WorkerEngineId,
} from "@super-work/core";
import type { CommandContext, CommandHandler } from "./context.ts";
import { getStringFlag, resolveTargetRepoId, withAutoStart } from "./shared.ts";

async function runPreview(ctx: CommandContext): Promise<number> {
  const { positionals, flags, baseUrl, autoStart, asJson, client, stdout, stderr } = ctx;
  const subCmd = positionals[1] ?? "list";
  if (subCmd === "list") {
    const { previews } = await withAutoStart(
      baseUrl,
      autoStart,
      () => client.listPreviews(getStringFlag(flags, "repo")),
      stdout,
    );
    if (asJson) {
      stdout(JSON.stringify({ previews }, null, 2));
      return 0;
    }
    if (previews.length === 0) {
      stdout("No active live previews running.");
      return 0;
    }
    for (const p of previews) {
      stdout(
        `[${p.id}] (${p.status}) ${p.url} ticket=${p.ticketId}${p.candidateId ? ` cand=${p.candidateId}` : ""} expires=${p.expiresAt}`,
      );
    }
    return 0;
  }

  if (subCmd === "start") {
    const ticketId = positionals[2];
    if (!ticketId) {
      stderr("Error: ticketId is required. Usage: super-work preview start <ticketId>");
      return 1;
    }
    const candidateId = getStringFlag(flags, "candidate");
    const { preview } = await withAutoStart(
      baseUrl,
      autoStart,
      () => client.startPreview({ ticketId, candidateId }),
      stdout,
    );
    stdout(
      asJson
        ? JSON.stringify({ preview }, null, 2)
        : `Started preview ${preview.id} (${preview.status}) at ${preview.url} [expires ${preview.expiresAt}]`,
    );
    return 0;
  }

  if (subCmd === "stop") {
    const previewId = positionals[2];
    if (!previewId) {
      stderr("Error: previewId is required. Usage: super-work preview stop <previewId>");
      return 1;
    }
    const { preview } = await withAutoStart(
      baseUrl,
      autoStart,
      () => client.stopPreview(previewId),
      stdout,
    );
    stdout(
      asJson
        ? JSON.stringify({ preview }, null, 2)
        : `Stopped preview ${preview.id}`,
    );
    return 0;
  }

  stderr(`Unknown preview subcommand: ${subCmd}`);
  return 1;
}

async function runImpact(ctx: CommandContext): Promise<number> {
  const { flags, baseUrl, autoStart, asJson, client, stdout } = ctx;
  const pathsRaw = getStringFlag(flags, "paths");
  const paths = pathsRaw
    ? pathsRaw
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
    : ["**"];
  const { report } = await withAutoStart(
    baseUrl,
    autoStart,
    async () => {
      const repoId = await resolveTargetRepoId(client, getStringFlag(flags, "repo"));
      return client.analyzeRepoImpact(repoId, paths);
    },
    stdout,
  );
  if (asJson) {
    stdout(JSON.stringify({ report }, null, 2));
    return 0;
  }
  stdout(
    `Symbol Impact Analysis: targets=${report.targetFiles.length}, direct=${report.directDependents.length}, transitive=${report.transitiveDependents.length}`,
  );
  if (report.directDependents.length > 0) {
    stdout(`Direct Dependents (1-hop): ${report.directDependents.join(", ")}`);
  }
  if (report.transitiveDependents.length > 0) {
    stdout(`Transitive Dependents (2+ hop): ${report.transitiveDependents.join(", ")}`);
  }
  if (report.contextPackMarkdown) {
    stdout(report.contextPackMarkdown);
  }
  return 0;
}

async function runCheckpoint(ctx: CommandContext): Promise<number> {
  const { positionals, flags, baseUrl, autoStart, asJson, client, stdout, stderr } = ctx;
  const subCmd = positionals[1] ?? "list";
  const ticketId = positionals[2];
  if (!ticketId) {
    stderr("Error: ticketId is required. Usage: super-work checkpoint <list|diff|restore> <ticketId> [cpId]");
    return 1;
  }

  if (subCmd === "list") {
    const { checkpoints } = await withAutoStart(
      baseUrl,
      autoStart,
      () => client.listCheckpoints(ticketId),
      stdout,
    );
    if (asJson) {
      stdout(JSON.stringify({ checkpoints }, null, 2));
      return 0;
    }
    if (checkpoints.length === 0) {
      stdout(`No checkpoints recorded for ticket ${ticketId}.`);
      return 0;
    }
    for (const cp of checkpoints) {
      stdout(
        `[${cp.id}] (${cp.stage}${cp.cleanedAt ? " | CLEANED" : ""}) ${cp.commitSha.slice(0, 8)} ${cp.label}`,
      );
    }
    return 0;
  }

  if (subCmd === "diff") {
    const cpId = positionals[3];
    if (!cpId) {
      stderr("Error: cpId is required. Usage: super-work checkpoint diff <ticketId> <cpId> [--base <cpId>]");
      return 1;
    }
    const baseCp = getStringFlag(flags, "base");
    const res = await withAutoStart(
      baseUrl,
      autoStart,
      () => client.getCheckpointDiff(ticketId, cpId, baseCp),
      stdout,
    );
    if (asJson) {
      stdout(JSON.stringify(res, null, 2));
      return 0;
    }
    stdout(`Diff ${res.fromSha.slice(0, 8)}..${res.toSha.slice(0, 8)}:`);
    stdout(res.diff || "(empty diff)");
    return 0;
  }

  if (subCmd === "restore") {
    const cpId = positionals[3];
    if (!cpId) {
      stderr("Error: cpId is required. Usage: super-work checkpoint restore <ticketId> <cpId>");
      return 1;
    }
    const rawMode = getStringFlag(flags, "mode");
    const mode = rawMode === "fork" ? "fork" : "in_place";
    const prompt = getStringFlag(flags, "prompt", "m", "note");
    const targetStage = getStringFlag(flags, "stage") as StageKind | undefined;
    const preferredEngine = getStringFlag(flags, "engine") as EnginePreference | undefined;
    const res = await withAutoStart(
      baseUrl,
      autoStart,
      () =>
        client.restoreCheckpoint(ticketId, cpId, {
          mode,
          prompt,
          targetStage,
          preferredEngine,
        }),
      stdout,
    );
    stdout(
      asJson
        ? JSON.stringify(res, null, 2)
        : `Restored checkpoint ${cpId} (${res.mode}) -> ticket ${res.ticket.id} [${res.ticket.status} stage=${res.ticket.currentStage}]`,
    );
    return 0;
  }

  stderr(`Unknown checkpoint subcommand: ${subCmd}`);
  return 1;
}

async function runDag(ctx: CommandContext): Promise<number> {
  const { positionals, flags, baseUrl, autoStart, asJson, client, stdout, stderr } = ctx;
  const subCmd = positionals[1];
  const ticketId = positionals[2];
  if (!subCmd || !ticketId) {
    stderr("Error: usage: super-work dag <pause|resume|rerun|set> <ticketId> [flags]");
    return 1;
  }

  let payload: DagNodeMutationInput;
  if (subCmd === "pause" || subCmd === "resume" || subCmd === "rerun") {
    payload = { action: subCmd };
  } else if (subCmd === "set") {
    const pathsRaw = getStringFlag(flags, "paths");
    const depsRaw = getStringFlag(flags, "depends-on");
    payload = {
      action: "update",
      description: getStringFlag(flags, "d", "desc", "description"),
      preferredEngine: getStringFlag(flags, "engine") as EnginePreference | undefined,
      allowedPaths: pathsRaw
        ? pathsRaw
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean)
        : undefined,
      dependsOn: depsRaw !== undefined
        ? depsRaw
            .split(",")
            .map((d) => d.trim())
            .filter(Boolean)
        : undefined,
      tddMode: flags["no-tdd"] ? false : flags.tdd ? true : undefined,
      pauseBeforeRun: flags.breakpoint !== undefined ? Boolean(flags.breakpoint) : undefined,
    };
  } else {
    stderr(`Unknown dag subcommand: ${subCmd}`);
    return 1;
  }

  const { ticket } = await withAutoStart(
    baseUrl,
    autoStart,
    () => client.mutateDagNode(ticketId, payload),
    stdout,
  );
  stdout(
    asJson
      ? JSON.stringify({ ticket }, null, 2)
      : `Updated DAG node ${ticket.id}: status=${ticket.status} stage=${ticket.currentStage} deps=[${ticket.dependsOn.join(",")}]`,
  );
  return 0;
}

async function runDigest(ctx: CommandContext): Promise<number> {
  const { flags, baseUrl, autoStart, asJson, client, stdout } = ctx;
  const hoursRaw = getStringFlag(flags, "hours");
  const hours = hoursRaw !== undefined && hoursRaw !== "" ? Number(hoursRaw) : 24;
  if (!Number.isFinite(hours) || hours < 0) {
    stdout("Error: --hours must be a non-negative number (0 = all time)");
    return 1;
  }
  const repoId = getStringFlag(flags, "repo");
  const { digest } = await withAutoStart(
    baseUrl,
    autoStart,
    () => client.getRunDigest({ repoId, hours }),
    stdout,
  );
  if (asJson) {
    stdout(JSON.stringify(digest, null, 2));
  } else if (flags.markdown) {
    stdout(digest.markdownEn);
    stdout("");
    stdout(digest.markdownZh);
  } else {
    const s = digest.ticketSummary;
    stdout(
      `Run Digest (${digest.windowHours > 0 ? `last ${digest.windowHours}h` : "all time"}): tickets=${s.total} delivered=${s.delivered} reverted=${s.reverted} escalated=${s.escalated} active=${s.active} cost=$${s.totalCostUsd.toFixed(2)}`,
    );
    stdout(
      `  Scoped gate: ${digest.gateSavings.scopedRuns} run(s), saved ${Math.round(digest.gateSavings.totalSavedMs / 1000)}s`,
    );
    stdout(
      `  Self-host: canary=${digest.selfHost.canaryPassed} reloads=${digest.selfHost.reloadsCompleted} rollbacks=${digest.selfHost.canaryRolledBack} watchdogSwitches=${digest.selfHost.watchdogSwitches}`,
    );
    for (const e of digest.engines) {
      stdout(
        `  ${e.engine.padEnd(9)} tickets=${e.tickets} delivered=${e.delivered} failed/reverted=${e.failedOrReverted} pass=${(e.passRate * 100).toFixed(0)}% cost=$${e.totalCostUsd.toFixed(2)}`,
      );
    }
    for (const ev of digest.events.slice(0, 10)) {
      stdout(`  ${ev.createdAt} [${ev.kind}] ${ev.summary}`);
    }
  }
  return 0;
}

async function runEval(ctx: CommandContext): Promise<number> {
  const { positionals, flags, baseUrl, autoStart, asJson, client, stdout, stderr } = ctx;
  const subCmd = positionals[1] ?? "list";
  if (subCmd === "save") {
    const ticketId = positionals[2];
    if (!ticketId) {
      stderr("Error: ticketId is required. Usage: super-work eval save <ticketId>");
      return 1;
    }
    const res = await withAutoStart(
      baseUrl,
      autoStart,
      () => client.saveEvalCaseFromTicket(ticketId),
      stdout,
    );
    stdout(
      asJson
        ? JSON.stringify(res, null, 2)
        : `Saved Golden Eval Case ${res.evalCase.id} (${res.evalCase.title}) baseSha=${res.evalCase.baseCommitSha.slice(0, 8)}`,
    );
    return 0;
  }
  if (subCmd === "run") {
    const evalCaseId = positionals[2];
    if (!evalCaseId) {
      stderr("Error: evalCaseId is required. Usage: super-work eval run <evalCaseId>");
      return 1;
    }
    const enginesRaw = getStringFlag(flags, "engines");
    const engines = enginesRaw
      ? (enginesRaw.split(",").map((s) => s.trim()).filter(Boolean) as WorkerEngineId[])
      : undefined;
    const budgetStr = getStringFlag(flags, "budget");
    const maxBudgetUsd = budgetStr ? Number(budgetStr) : undefined;
    const res = await withAutoStart(
      baseUrl,
      autoStart,
      () => client.runEval({ evalCaseId, engines, maxBudgetUsd }),
      stdout,
    );
    if (asJson) {
      stdout(JSON.stringify(res, null, 2));
    } else {
      stdout(`Eval Run ${res.evalRun.id} (${res.evalRun.status}, cost=$${res.evalRun.totalCostUsd}):`);
      for (const cand of res.evalRun.results) {
        stdout(
          `  - [${cand.passed ? "PASS" : "FAIL"}] ${cand.engine}: ${cand.durationMs}ms, $${cand.costUsd.toFixed(4)}, risk=${cand.riskScore} | ${cand.verificationSummary}`,
        );
      }
    }
    return 0;
  }
  if (subCmd === "runs") {
    const repoId = getStringFlag(flags, "repo");
    const res = await withAutoStart(
      baseUrl,
      autoStart,
      () => client.listEvalRuns(repoId),
      stdout,
    );
    if (asJson) {
      stdout(JSON.stringify(res, null, 2));
    } else if (res.runs.length === 0) {
      stdout("No Golden Eval runs recorded yet.");
    } else {
      for (const run of res.runs) {
        stdout(`[${run.id}] case=${run.evalCaseId} status=${run.status} engines=[${run.engines.join(",")}] cost=$${run.totalCostUsd}`);
      }
    }
    return 0;
  }
  const repoId = getStringFlag(flags, "repo");
  const res = await withAutoStart(
    baseUrl,
    autoStart,
    () => client.listEvalCases(repoId),
    stdout,
  );
  if (asJson) {
    stdout(JSON.stringify(res, null, 2));
  } else if (res.cases.length === 0) {
    stdout("No Golden Eval cases saved yet.");
  } else {
    for (const c of res.cases) {
      stdout(`[${c.id}] ${c.title} base=${c.baseCommitSha.slice(0, 8)} checks=${c.verificationCommands.length}`);
    }
  }
  return 0;
}

export const reviewCommands: Record<string, CommandHandler> = {
  preview: runPreview,
  impact: runImpact,
  checkpoint: runCheckpoint,
  dag: runDag,
  digest: runDigest,
  eval: runEval,
};
