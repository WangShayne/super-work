import type {
  CampaignDirection,
  EnginePreference,
  PipelineTemplateId,
  RequirementRouteKind,
  WorkerEngineId,
} from "@super-work/core";
import type { CommandContext, CommandHandler } from "./context.ts";
import { formatEventLine, formatTranscriptLines } from "./cli-formatters.ts";
import {
  getStringFlag,
  isFinalForWait,
  resolveTargetRepoId,
  waitForTicketCompletion,
  withAutoStart,
} from "./shared.ts";

async function runDispatch(ctx: CommandContext): Promise<number> {
  const { positionals, flags, options, baseUrl, autoStart, asJson, client, stdout, stderr } = ctx;
  const title = positionals[1];
  if (!title) {
    stderr("Error: ticket title is required. Usage: super-work dispatch <title> -d <desc>");
    return 1;
  }
  const description = getStringFlag(flags, "d", "desc", "description") ?? title;
  const pathsRaw = getStringFlag(flags, "paths");
  const allowedPaths = pathsRaw
    ? pathsRaw
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
    : undefined;
  const depsRaw = getStringFlag(flags, "depends-on");
  const dependsOn = depsRaw
    ? depsRaw
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean)
    : undefined;
  const template = getStringFlag(flags, "template") as PipelineTemplateId | undefined;
  const blueprintId = getStringFlag(flags, "blueprint");
  const gatePolicyRaw = getStringFlag(flags, "gate-policy");
  const deliveryGatePolicy =
    gatePolicyRaw === "always_auto" ||
    gatePolicyRaw === "risk_gated" ||
    gatePolicyRaw === "always_signoff"
      ? gatePolicyRaw
      : undefined;
  const preferredEngine = getStringFlag(flags, "engine") as EnginePreference | undefined;
  const tddMode = flags.tdd !== undefined ? Boolean(flags.tdd) : undefined;
  const pauseBeforeRun = flags["pause-before-run"] ? true : undefined;
  const budgetStr = getStringFlag(flags, "budget");
  const maxCostUsd = budgetStr ? Number(budgetStr) : undefined;
  const arenaFlag = flags.arena;
  const arenaMode = Boolean(arenaFlag);
  const arenaCompetitorEngine =
    typeof arenaFlag === "string" ? (arenaFlag as WorkerEngineId) : undefined;
  const clarify = Boolean(flags.clarify);
  const clarifyOnly = Boolean(flags["clarify-only"]);
  const wait = Boolean(flags.wait);

  if (clarifyOnly) {
    const { clarification } = await withAutoStart(
      baseUrl,
      autoStart,
      async () => {
        const repoId = await resolveTargetRepoId(client, getStringFlag(flags, "repo"));
        return client.clarifySpec({ repoId, title, description, template });
      },
      stdout,
    );
    if (asJson) {
      stdout(JSON.stringify({ clarification }, null, 2));
      return 0;
    }
    stdout(`Spec Clarification: ${clarification.refinedTitle}`);
    stdout(
      `Recommended: mode=${clarification.recommendedDispatchMode} template=${clarification.recommendedTemplate} paths=${clarification.suggestedAllowedPaths.join(",")}`,
    );
    stdout(`Rationale: ${clarification.rationale}`);
    if (clarification.matchedFiles.length > 0) {
      stdout(`Matched Files: ${clarification.matchedFiles.join(", ")}`);
    }
    for (const q of clarification.questions) {
      stdout(`Question [${q.id}]: ${q.question}`);
      q.options.forEach((opt, i) => stdout(`  ${i === q.recommendedIndex ? "*" : "-"} ${opt}`));
    }
    return 0;
  }

  const { ticket } = await withAutoStart(
    baseUrl,
    autoStart,
    async () => {
      const repoId = await resolveTargetRepoId(client, getStringFlag(flags, "repo"));
      let finalDescription = description;
      let finalPaths = allowedPaths;
      let finalTemplate = template;
      let acceptanceCriteria: string[] | undefined;

      if (clarify) {
        const { clarification } = await client.clarifySpec({
          repoId,
          title,
          description,
          template,
        });
        finalDescription = clarification.refinedDescription;
        finalPaths = allowedPaths ?? clarification.suggestedAllowedPaths;
        finalTemplate = template ?? clarification.recommendedTemplate;
        acceptanceCriteria = clarification.acceptanceCriteria;
      }

      return client.createTicket({
        repoId,
        title,
        description: finalDescription,
        blueprintId,
        deliveryGatePolicy,
        template: finalTemplate,
        tddMode,
        pauseBeforeRun,
        allowedPaths: finalPaths,
        dependsOn,
        preferredEngine,
        arenaMode,
        arenaCompetitorEngine,
        acceptanceCriteria,
        maxCostUsd: Number.isFinite(maxCostUsd) ? maxCostUsd : undefined,
      });
    },
    stdout,
  );

  if (!wait) {
    stdout(
      asJson
        ? JSON.stringify({ ticket }, null, 2)
        : `Dispatched ticket ${ticket.id} (${ticket.status})${
            ticket.dependsOn.length > 0 ? ` deps=[${ticket.dependsOn.join(",")}]` : ""
          } -> ${ticket.title}`,
    );
    return 0;
  }

  stdout(`Dispatched ${ticket.id}; streaming live progress...`);
  const finalTicket = await waitForTicketCompletion(
    client,
    ticket.id,
    stdout,
    options?.waitTimeoutMs,
  );
  stdout(
    asJson
      ? JSON.stringify({ ticket: finalTicket }, null, 2)
      : `Ticket ${finalTicket.id} finished with status=${finalTicket.status} cost=$${finalTicket.costUsd.toFixed(4)}${finalTicket.prUrl ? ` pr=${finalTicket.prUrl}` : ""}`,
  );
  return finalTicket.status === "delivered" ? 0 : 1;
}

async function runEpic(ctx: CommandContext): Promise<number> {
  const { positionals, flags, options, baseUrl, autoStart, asJson, client, stdout, stderr } = ctx;
  const title = positionals[1];
  if (!title) {
    stderr("Error: Epic title is required. Usage: super-work epic <title> -d <desc>");
    return 1;
  }
  const description = getStringFlag(flags, "d", "desc", "description") ?? title;
  const template = getStringFlag(flags, "template") as PipelineTemplateId | undefined;
  const preferredEngine = getStringFlag(flags, "engine") as EnginePreference | undefined;
  const tddMode = flags.tdd !== undefined ? Boolean(flags.tdd) : undefined;
  const budgetStr = getStringFlag(flags, "budget");
  const maxCostUsdPerSubtask = budgetStr ? Number(budgetStr) : undefined;
  const previewOnly = Boolean(flags["preview-only"]);
  const perSubtask = Boolean(flags["per-subtask"]);
  const wait = Boolean(flags.wait);

  if (previewOnly) {
    const { plan } = await withAutoStart(
      baseUrl,
      autoStart,
      async () => {
        const repoId = await resolveTargetRepoId(client, getStringFlag(flags, "repo"));
        return client.previewEpic({ repoId, title, description, template });
      },
      stdout,
    );
    if (asJson) {
      stdout(JSON.stringify({ plan }, null, 2));
      return 0;
    }
    stdout(`Epic Preview: ${plan.epicTitle} (${plan.subtasks.length} subtasks)`);
    stdout(plan.summary);
    for (const sub of plan.subtasks) {
      const deps = sub.dependsOnKeys.length > 0 ? sub.dependsOnKeys.join(",") : "parallel";
      const repoTag = sub.repoId ? ` repo=${sub.repoId}` : "";
      stdout(
        `  - [${sub.key}] (${sub.template})${repoTag} deps=[${deps}] paths=[${sub.allowedPaths.join(", ")}] :: ${sub.title}`,
      );
    }
    return 0;
  }

  const { epic, subtasks } = await withAutoStart(
    baseUrl,
    autoStart,
    async () => {
      const repoId = await resolveTargetRepoId(client, getStringFlag(flags, "repo"));
      return client.createEpic({
        repoId,
        title,
        description,
        template,
        tddMode,
        epicDeliveryMode: perSubtask ? "per_subtask" : "unified",
        preferredEngine,
        maxCostUsdPerSubtask: Number.isFinite(maxCostUsdPerSubtask)
          ? maxCostUsdPerSubtask
          : undefined,
      });
    },
    stdout,
  );

  if (!wait) {
    stdout(
      asJson
        ? JSON.stringify({ epic, subtasks }, null, 2)
        : `Dispatched Epic ${epic.id} (mode=${epic.epicDeliveryMode}, ${subtasks.length} subtasks)${epic.branchName ? ` branch=${epic.branchName}` : ""}`,
    );
    return 0;
  }

  stdout(`Dispatched Epic ${epic.id}; waiting for completion...`);
  const finalEpic = await waitForTicketCompletion(
    client,
    epic.id,
    stdout,
    options?.waitTimeoutMs,
  );
  stdout(
    asJson
      ? JSON.stringify({ epic: finalEpic, subtasks }, null, 2)
      : `Epic ${finalEpic.id} finished status=${finalEpic.status} cost=$${finalEpic.costUsd.toFixed(4)}`,
  );
  return finalEpic.status === "delivered" ? 0 : 1;
}

async function runInbox(ctx: CommandContext): Promise<number> {
  const { positionals, flags, baseUrl, autoStart, asJson, client, stdout, stderr } = ctx;
  const subCmd = positionals[1] ?? "list";
  if (subCmd === "list") {
    const statusFilter = (getStringFlag(flags, "status") ?? "pending") as
      | "pending"
      | "approved"
      | "rejected";
    const { items } = await withAutoStart(
      baseUrl,
      autoStart,
      () => client.listInbox(getStringFlag(flags, "repo"), statusFilter),
      stdout,
    );
    if (asJson) {
      stdout(JSON.stringify({ items }, null, 2));
      return 0;
    }
    if (items.length === 0) {
      stdout(`Inbox (${statusFilter}): empty.`);
      return 0;
    }
    for (const item of items) {
      stdout(`[${item.id}] (${item.kind} | ${item.status}) ticket=${item.ticketId} :: ${item.title}`);
    }
    return 0;
  }

  if (subCmd === "approve" || subCmd === "reject") {
    const inboxId = positionals[2];
    if (!inboxId) {
      stderr(`Error: Inbox ID required. Usage: super-work inbox ${subCmd} <inboxId>`);
      return 1;
    }
    const note = getStringFlag(flags, "m", "note");
    const budgetAddRaw = getStringFlag(flags, "budget-add");
    const budgetIncreaseUsd = budgetAddRaw ? Number(budgetAddRaw) : undefined;
    const arenaWinnerId = getStringFlag(flags, "winner");
    const result = await withAutoStart(
      baseUrl,
      autoStart,
      () =>
        client.resolveInbox(inboxId, {
          decision: subCmd === "approve" ? "approved" : "rejected",
          note,
          expandMandate: Boolean(flags["expand-mandate"]),
          deliveryAction: flags["local-merge"] ? "local_merge" : undefined,
          budgetIncreaseUsd: Number.isFinite(budgetIncreaseUsd) ? budgetIncreaseUsd : undefined,
          arenaWinnerId,
        }),
      stdout,
    );
    stdout(
      asJson
        ? JSON.stringify(result, null, 2)
        : `Inbox ${result.item.id} ${result.item.status}; ticket ${result.ticket.id} -> ${result.ticket.status}`,
    );
    return 0;
  }

  if (subCmd === "batch") {
    const rawDecision = getStringFlag(flags, "decision") ?? "approved";
    const decision: "approved" | "rejected" =
      rawDecision === "rejected" ? "rejected" : "approved";
    const idsRaw = getStringFlag(flags, "ids");
    const inboxIds = idsRaw
      ? idsRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    const result = await withAutoStart(
      baseUrl,
      autoStart,
      () =>
        client.batchResolveInbox({
          inboxIds,
          repoId: getStringFlag(flags, "repo"),
          onlyLowRisk: Boolean(flags["low-risk"]),
          decision,
          note: getStringFlag(flags, "m", "note"),
        }),
      stdout,
    );
    stdout(
      asJson
        ? JSON.stringify(result, null, 2)
        : `Batch ${decision}: resolved=${result.resolvedCount}, skipped=${result.skippedCount}`,
    );
    return 0;
  }

  stderr(`Unknown inbox subcommand: ${subCmd}`);
  return 1;
}

async function runLogs(ctx: CommandContext): Promise<number> {
  const { positionals, flags, options, baseUrl, autoStart, asJson, client, stdout, stderr } = ctx;
  const ticketId = positionals[1];
  if (!ticketId) {
    stderr("Error: ticketId is required. Usage: super-work logs <ticketId> [-f]");
    return 1;
  }
  const detail = await withAutoStart(
    baseUrl,
    autoStart,
    () => client.getTicketDetail(ticketId),
    stdout,
  );
  if (asJson && !flags.f && !flags.follow) {
    stdout(JSON.stringify(detail, null, 2));
    return 0;
  }
  stdout(
    `Ticket ${detail.ticket.id}: ${detail.ticket.title} [${detail.ticket.status} | stage=${detail.ticket.currentStage}]`,
  );
  if (detail.ticket.handoverDigest) {
    stdout(
      `Handover Digest (v${detail.ticket.handoverDigest.version}): ${detail.ticket.handoverDigest.summary}`,
    );
    if (detail.ticket.handoverDigest.exportedSymbols.length > 0) {
      stdout(`  Exports: ${detail.ticket.handoverDigest.exportedSymbols.join(" | ")}`);
    }
  }
  for (const run of detail.stageRuns) {
    stdout(
      `  - ${run.stage} (${run.engine}) [${run.status}] $${run.costUsd.toFixed(4)}${run.summary ? ` :: ${run.summary.split("\n")[0]}` : ""}`,
    );
    if (run.spillTranscriptId) {
      try {
        const { content } = await client.getArtifact(run.spillTranscriptId);
        for (const line of formatTranscriptLines(content)) {
          stdout(line);
        }
      } catch {
        // Non-fatal if transcript artifact was removed
      }
    }
  }
  if (flags.f || flags.follow) {
    if (isFinalForWait(detail.ticket.status)) {
      return 0;
    }
    await waitForTicketCompletion(client, ticketId, stdout, options?.waitTimeoutMs);
  }
  return 0;
}

async function runWatch(ctx: CommandContext): Promise<number> {
  const { flags, options, baseUrl, autoStart, asJson, client, stdout } = ctx;
  const watchRepo = getStringFlag(flags, "repo");
  const watchTicket = getStringFlag(flags, "ticket");
  const timeoutStr = getStringFlag(flags, "timeout-ms");
  const timeoutMs = timeoutStr ? Number(timeoutStr) : options?.waitTimeoutMs;
  const ac = new AbortController();
  const onSig = () => ac.abort("signal");
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => ac.abort("timeout"), timeoutMs);
  }

  try {
    await withAutoStart(baseUrl, autoStart, () => client.getHealth(), stdout);
    if (!asJson) {
      stdout(
        `Watching live SSE stream (${baseUrl})${watchRepo ? ` repo=${watchRepo}` : ""}${watchTicket ? ` ticket=${watchTicket}` : ""}...`,
      );
    }
    await client.streamEvents(
      (ev) => {
        if (ev.event === "ping") return;
        if (asJson) {
          stdout(JSON.stringify(ev));
        } else {
          stdout(formatEventLine(ev, watchTicket));
        }
      },
      ac.signal,
      { repoId: watchRepo, ticketId: watchTicket, reconnect: true, reconnectDelayMs: 800 },
    );
  } finally {
    if (timer) clearTimeout(timer);
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
  }
  return 0;
}

async function runRevert(ctx: CommandContext): Promise<number> {
  const { positionals, baseUrl, autoStart, asJson, client, stdout, stderr } = ctx;
  const ticketId = positionals[1];
  if (!ticketId) {
    stderr("Error: ticketId is required. Usage: super-work revert <ticketId>");
    return 1;
  }
  const res = await withAutoStart(
    baseUrl,
    autoStart,
    () => client.revertTicket(ticketId),
    stdout,
  );
  stdout(
    asJson
      ? JSON.stringify(res, null, 2)
      : `Reverted ticket ${res.ticket.id} cleanly on base branch (revert commit: ${res.revertCommitSha})`,
  );
  return 0;
}

async function runSteer(ctx: CommandContext): Promise<number> {
  const { positionals, flags, baseUrl, autoStart, asJson, client, stdout, stderr } = ctx;
  const ticketId = positionals[1];
  const instruction = positionals[2] ?? getStringFlag(flags, "m", "note", "d", "desc");
  if (!ticketId || !instruction) {
    stderr('Error: usage: super-work steer <ticketId> "<instruction>" [--engine <eng>]');
    return 1;
  }
  const preferredEngine = getStringFlag(flags, "engine") as EnginePreference | undefined;
  const res = await withAutoStart(
    baseUrl,
    autoStart,
    () => client.steerTicket(ticketId, { instruction, preferredEngine }),
    stdout,
  );
  stdout(
    asJson
      ? JSON.stringify(res, null, 2)
      : `Steered ticket ${res.ticket.id} -> status=${res.ticket.status} steerCount=${res.ticket.steerCount ?? 1}`,
  );
  return 0;
}

async function runAsk(ctx: CommandContext): Promise<number> {
  const { positionals, flags, baseUrl, autoStart, asJson, client, stdout, stderr } = ctx;
  const question = positionals.slice(1).join(" ").trim();
  if (!question) {
    stderr('Error: question is required. Usage: super-work ask "<question>" [--repo <id>]');
    return 1;
  }
  const repoId = getStringFlag(flags, "repo");
  const res = await withAutoStart(
    baseUrl,
    autoStart,
    () => client.askChief({ repoId, question }),
    stdout,
  );
  if (asJson) {
    stdout(JSON.stringify(res, null, 2));
  } else {
    stdout(res.answer);
    if (res.suggestedActions.length > 0) {
      stdout("\nSuggested Actions:");
      for (const act of res.suggestedActions) {
        stdout(`  - [${act.kind}] ${act.label}: ${act.description}`);
      }
    }
  }
  return 0;
}

async function runIntake(ctx: CommandContext): Promise<number> {
  const { positionals, flags, options, baseUrl, autoStart, asJson, client, stdout, stderr } = ctx;
  const requirement = positionals.slice(1).join(" ").trim() || getStringFlag(flags, "d", "desc", "description");
  if (!requirement) {
    stderr("Error: requirement text is required. Usage: super-work intake <requirement> [--wait] [--preview-only]");
    return 1;
  }
  const title = getStringFlag(flags, "title");
  const routeRaw = getStringFlag(flags, "route");
  const preferredRoute =
    routeRaw === "single_ticket" || routeRaw === "epic_dag" || routeRaw === "goal_campaign"
      ? (routeRaw as RequirementRouteKind)
      : "auto";
  const template = getStringFlag(flags, "template") as PipelineTemplateId | undefined;
  const preferredEngine = getStringFlag(flags, "engine") as EnginePreference | undefined;
  const tddMode = flags.tdd !== undefined ? Boolean(flags.tdd) : undefined;
  const gatePolicyRaw = getStringFlag(flags, "gate-policy");
  const deliveryGatePolicy =
    gatePolicyRaw === "always_auto" ||
    gatePolicyRaw === "risk_gated" ||
    gatePolicyRaw === "always_signoff"
      ? gatePolicyRaw
      : undefined;
  const budgetStr = getStringFlag(flags, "budget");
  const maxBudgetUsd = budgetStr ? Number(budgetStr) : undefined;
  const metricCommand = getStringFlag(flags, "metric");
  const metricRegex = getStringFlag(flags, "regex");
  const metricUnit = getStringFlag(flags, "unit");
  const dirRaw = getStringFlag(flags, "direction");
  const direction =
    dirRaw === "increase" || dirRaw === "decrease"
      ? (dirRaw as CampaignDirection)
      : undefined;
  const targetStr = getStringFlag(flags, "target");
  const targetValue = targetStr !== undefined ? Number(targetStr) : undefined;
  const previewOnly = Boolean(flags["preview-only"]);
  const wait = Boolean(flags.wait);

  const res = await withAutoStart(
    baseUrl,
    autoStart,
    async () => {
      const repoId = await resolveTargetRepoId(client, getStringFlag(flags, "repo"));
      return client.submitIntake({
        repoId,
        requirement,
        title,
        preferredRoute,
        preferredEngine,
        template,
        tddMode,
        deliveryGatePolicy,
        maxBudgetUsd: Number.isFinite(maxBudgetUsd) ? maxBudgetUsd : undefined,
        previewOnly,
        metricCommand,
        metricRegex,
        metricUnit,
        direction,
        targetValue: Number.isFinite(targetValue) ? targetValue : undefined,
      });
    },
    stdout,
  );

  if (previewOnly) {
    if (asJson) {
      stdout(JSON.stringify(res, null, 2));
      return 0;
    }
    stdout(`Intake Route: ${res.route} (confidence=${Math.round(res.plan.confidence * 100)}%)`);
    stdout(`Title: ${res.plan.title}`);
    stdout(`Rationale: ${res.plan.rationale}`);
    stdout(`Summary: ${res.plan.summary}`);
    return 0;
  }

  const watchId = res.ticket?.id ?? res.epic?.id;
  if (!wait || !watchId) {
    if (asJson) {
      stdout(JSON.stringify(res, null, 2));
    } else if (res.ticket) {
      stdout(`Intake -> Ticket ${res.ticket.id} (${res.ticket.status}): ${res.ticket.title}`);
    } else if (res.epic) {
      stdout(
        `Intake -> Epic ${res.epic.id} (${res.subtasks?.length ?? 0} subtasks): ${res.epic.title}`,
      );
    } else if (res.campaign) {
      stdout(`Intake -> GoalCampaign ${res.campaign.id} (${res.campaign.status}): ${res.campaign.name}`);
    }
    return 0;
  }

  const timeoutMsRaw = Number(getStringFlag(flags, "timeout-ms") ?? options?.waitTimeoutMs ?? 300_000);
  stdout(`Intake -> ${watchId} (${res.route}); streaming live progress...`);
  const finalTicket = await waitForTicketCompletion(client, watchId, stdout, timeoutMsRaw);
  stdout(
    asJson
      ? JSON.stringify({ ...res, finalTicket }, null, 2)
      : `${watchId} finished with status=${finalTicket.status} cost=$${finalTicket.costUsd.toFixed(4)}${finalTicket.mergedCommitSha ? ` sha=${finalTicket.mergedCommitSha}` : ""}`,
  );
  return finalTicket.status === "delivered" ? 0 : 1;
}

async function runWait(ctx: CommandContext): Promise<number> {
  const { positionals, flags, options, baseUrl, autoStart, asJson, client, stdout, stderr } = ctx;
  const targetId = positionals[1];
  if (!targetId) {
    stderr("Error: ticket or epic id is required. Usage: super-work wait <ticketOrEpicId>");
    return 1;
  }
  const timeoutMsRaw = Number(getStringFlag(flags, "timeout-ms") ?? options?.waitTimeoutMs ?? 300_000);
  const finalTicket = await withAutoStart(
    baseUrl,
    autoStart,
    () => waitForTicketCompletion(client, targetId, stdout, timeoutMsRaw),
    stdout,
  );
  stdout(
    asJson
      ? JSON.stringify({ ticket: finalTicket }, null, 2)
      : `${finalTicket.id} finished with status=${finalTicket.status} cost=$${finalTicket.costUsd.toFixed(4)}`,
  );
  return finalTicket.status === "delivered" ? 0 : 1;
}

export const dispatchCommands: Record<string, CommandHandler> = {
  dispatch: runDispatch,
  epic: runEpic,
  inbox: runInbox,
  logs: runLogs,
  watch: runWatch,
  revert: runRevert,
  steer: runSteer,
  ask: runAsk,
  intake: runIntake,
  wait: runWait,
};
