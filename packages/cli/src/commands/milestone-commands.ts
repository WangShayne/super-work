import type {
  CampaignDeliveryMode,
  CampaignDirection,
  EnginePreference,
  Milestone,
  PipelineTemplateId,
} from "@super-work/core";
import type { CommandContext, CommandHandler } from "./context.ts";
import { getStringFlag, resolveTargetRepoId, withAutoStart } from "./shared.ts";

async function runCampaign(ctx: CommandContext): Promise<number> {
  const { positionals, flags, baseUrl, autoStart, asJson, client, stdout, stderr } = ctx;
  const subCmd = positionals[1] ?? "list";
  if (subCmd === "list") {
    const repoId = getStringFlag(flags, "repo");
    const { campaigns } = await withAutoStart(
      baseUrl,
      autoStart,
      () => client.listCampaigns(repoId),
      stdout,
    );
    if (asJson) {
      stdout(JSON.stringify({ campaigns }, null, 2));
    } else if (campaigns.length === 0) {
      stdout("No Goal Campaigns found.");
    } else {
      for (const c of campaigns) {
        stdout(
          `[${c.id}] (${c.status}) ${c.name} :: ${c.baselineValue ?? "?"} -> ${c.currentValue ?? "?"} / target ${c.targetValue}${c.metricUnit ? ` ${c.metricUnit}` : ""} waves=${c.completedWaves}/${c.maxIterations} cost=$${c.totalCostUsd.toFixed(2)}`,
        );
      }
    }
    return 0;
  }
  if (subCmd === "get") {
    const id = positionals[2];
    if (!id) {
      stderr("Error: campaign id is required. Usage: super-work campaign get <id>");
      return 1;
    }
    const detail = await withAutoStart(baseUrl, autoStart, () => client.getCampaign(id), stdout);
    if (asJson) {
      stdout(JSON.stringify(detail, null, 2));
    } else {
      const c = detail.campaign;
      stdout(
        `Campaign [${c.id}] ${c.name} status=${c.status} current=${c.currentValue ?? "?"} target=${c.targetValue} mode=${c.deliveryMode}`,
      );
      for (const w of detail.waves) {
        stdout(
          `  Wave ${w.waveNumber}: [${w.status}] ${w.beforeValue} -> ${w.measuredValue ?? "?"} ${w.rolledBack ? "(rolled back)" : ""} :: ${w.summary}`,
        );
      }
    }
    return 0;
  }
  if (subCmd === "create") {
    const name = positionals[2];
    const goalPrompt = getStringFlag(flags, "d", "desc", "description");
    const metricCommand = getStringFlag(flags, "metric");
    const targetRaw = getStringFlag(flags, "target");
    if (!name || !goalPrompt || !metricCommand || !targetRaw) {
      stderr(
        "Error: name, -d <prompt>, --metric <cmd>, and --target <num> are required.",
      );
      return 1;
    }
    const targetValue = Number(targetRaw);
    if (!Number.isFinite(targetValue)) {
      stderr("Error: --target must be a finite number.");
      return 1;
    }
    const repoId = await resolveTargetRepoId(client, getStringFlag(flags, "repo"));
    const dirRaw = getStringFlag(flags, "direction");
    const direction: CampaignDirection = dirRaw === "increase" ? "increase" : "decrease";
    const deliveryMode = getStringFlag(flags, "delivery-mode") as
      | CampaignDeliveryMode
      | undefined;
    const allowedPathsRaw = getStringFlag(flags, "paths");
    const maxIterRaw = getStringFlag(flags, "max-iter");
    const budgetRaw = getStringFlag(flags, "budget");
    const { campaign } = await withAutoStart(
      baseUrl,
      autoStart,
      () =>
        client.createCampaign({
          repoId,
          name,
          goalPrompt,
          metricCommand,
          metricRegex: getStringFlag(flags, "regex"),
          metricUnit: getStringFlag(flags, "unit"),
          direction,
          targetValue,
          deliveryMode,
          allowedPaths: allowedPathsRaw
            ? allowedPathsRaw.split(",").map((s) => s.trim()).filter(Boolean)
            : undefined,
          template: getStringFlag(flags, "template") as PipelineTemplateId | undefined,
          preferredEngine: getStringFlag(flags, "engine") as EnginePreference | undefined,
          maxIterations: maxIterRaw ? Number(maxIterRaw) : undefined,
          maxTotalBudgetUsd: budgetRaw ? Number(budgetRaw) : undefined,
          autoStart: Boolean(flags.start),
        }),
      stdout,
    );
    stdout(
      asJson
        ? JSON.stringify({ campaign }, null, 2)
        : `Created campaign ${campaign.id} (${campaign.status}) target=${campaign.targetValue}`,
    );
    return 0;
  }
  if (subCmd === "start") {
    const id = positionals[2];
    if (!id) {
      stderr("Error: campaign id is required.");
      return 1;
    }
    const { campaign } = await withAutoStart(
      baseUrl,
      autoStart,
      () => client.startCampaign(id, getStringFlag(flags, "m", "note")),
      stdout,
    );
    stdout(
      asJson
        ? JSON.stringify({ campaign }, null, 2)
        : `Campaign ${campaign.id} status=${campaign.status} activeTicket=${campaign.activeTicketId ?? "-"}`,
    );
    return 0;
  }
  if (subCmd === "pause") {
    const id = positionals[2];
    if (!id) {
      stderr("Error: campaign id is required.");
      return 1;
    }
    const { campaign } = await withAutoStart(
      baseUrl,
      autoStart,
      () => client.pauseCampaign(id, getStringFlag(flags, "m", "note", "reason")),
      stdout,
    );
    stdout(asJson ? JSON.stringify({ campaign }, null, 2) : `Paused campaign ${campaign.id}`);
    return 0;
  }
  if (subCmd === "deliver") {
    const id = positionals[2];
    if (!id) {
      stderr("Error: campaign id is required.");
      return 1;
    }
    const action =
      getStringFlag(flags, "action") === "push_and_create_pr"
        ? "push_and_create_pr"
        : "local_merge";
    const { campaign } = await withAutoStart(
      baseUrl,
      autoStart,
      () => client.deliverCampaign(id, action),
      stdout,
    );
    stdout(
      asJson
        ? JSON.stringify({ campaign }, null, 2)
        : `Delivered campaign ${campaign.id} (${campaign.deliveredCommitSha ?? campaign.deliveredPrUrl ?? campaign.status})`,
    );
    return 0;
  }
  if (subCmd === "delete") {
    const id = positionals[2];
    if (!id) {
      stderr("Error: campaign id is required.");
      return 1;
    }
    const res = await withAutoStart(baseUrl, autoStart, () => client.deleteCampaign(id), stdout);
    stdout(asJson ? JSON.stringify(res, null, 2) : `Deleted campaign ${res.id}`);
    return 0;
  }
  stderr(`Unknown campaign subcommand: ${subCmd}`);
  return 1;
}

async function runMilestone(ctx: CommandContext): Promise<number> {
  const { positionals, flags, baseUrl, autoStart, asJson, client, stdout, stderr } = ctx;
  const subCmd = positionals[1] ?? "list";
  const fmt = (m: Milestone): string =>
    `Milestone [${m.id}] ${m.name}${m.targetVersion ? ` v${m.targetVersion}` : ""} status=${m.status} items=${m.items.filter((i) => i.status === "delivered").length}/${m.items.length}`;
  if (subCmd === "list") {
    const repoFlag = getStringFlag(flags, "repo");
    const { milestones } = await withAutoStart(
      baseUrl,
      autoStart,
      () => client.listMilestones(repoFlag),
      stdout,
    );
    if (asJson) stdout(JSON.stringify({ milestones }, null, 2));
    else if (milestones.length === 0) stdout("No milestones.");
    else for (const m of milestones) stdout(fmt(m));
    return 0;
  }
  if (subCmd === "show") {
    const id = positionals[2];
    if (!id) {
      stderr("Error: milestone id is required. Usage: super-work milestone show <id>");
      return 1;
    }
    const { milestone } = await withAutoStart(baseUrl, autoStart, () => client.getMilestone(id), stdout);
    if (asJson) {
      stdout(JSON.stringify({ milestone }, null, 2));
    } else {
      stdout(fmt(milestone));
      for (const i of milestone.items) {
        stdout(
          `  Wave ${i.waveIndex + 1} #${i.index + 1} [${i.status}] ${i.title}${i.dependsOnIndices.length ? ` (after #${i.dependsOnIndices.map((d) => d + 1).join(",#")})` : ""}`,
        );
      }
      if (milestone.releaseNotesEn) stdout(`\n${milestone.releaseNotesEn}`);
    }
    return 0;
  }
  if (subCmd === "create") {
    const name = getStringFlag(flags, "name");
    const requirements = positionals.slice(2).map((r) => r.trim()).filter(Boolean);
    if (!name || requirements.length === 0) {
      stderr(
        "Error: --name <n> and at least one requirement are required. Usage: super-work milestone create --name <n> [--version <v>] [--repo <id>] <req...>",
      );
      return 1;
    }
    const repoId = await resolveTargetRepoId(client, getStringFlag(flags, "repo"));
    const budgetRaw = getStringFlag(flags, "budget");
    const integrationRaw = getStringFlag(flags, "integration");
    if (integrationRaw && integrationRaw !== "direct_main" && integrationRaw !== "milestone_branch") {
      stderr("Error: --integration must be direct_main or milestone_branch");
      return 1;
    }
    const routeRaw = getStringFlag(flags, "route");
    if (routeRaw && routeRaw !== "auto" && routeRaw !== "single_ticket") {
      stderr("Error: --route must be auto or single_ticket");
      return 1;
    }
    const { milestone } = await withAutoStart(
      baseUrl,
      autoStart,
      () =>
        client.createMilestone({
          integrationMode: integrationRaw as "direct_main" | "milestone_branch" | undefined,
          preferredRoute: routeRaw as "auto" | "single_ticket" | undefined,
          repoId,
          name,
          targetVersion: getStringFlag(flags, "version"),
          requirements,
          template: getStringFlag(flags, "template") as PipelineTemplateId | undefined,
          preferredEngine: getStringFlag(flags, "engine") as EnginePreference | undefined,
          maxBudgetUsdPerItem: budgetRaw ? Number(budgetRaw) : undefined,
        }),
      stdout,
    );
    stdout(asJson ? JSON.stringify({ milestone }, null, 2) : `Created ${fmt(milestone)}`);
    return 0;
  }
  if (subCmd === "release") {
    const id = positionals[2];
    if (!id) {
      stderr("Error: milestone id is required. Usage: super-work milestone release <id> [--bump] [--tag] [--push] [--squash] [--github-release]");
      return 1;
    }
    const { milestone } = await withAutoStart(
      baseUrl,
      autoStart,
      () =>
        client.releaseMilestone(id, {
          bumpVersion: Boolean(flags.bump),
          createTag: Boolean(flags.tag),
          pushRemote: Boolean(flags.push),
          squashReleaseCommit: Boolean(flags.squash),
          createGithubRelease: Boolean(flags["github-release"]),
          releaseCommitMessage: getStringFlag(flags, "m") ?? getStringFlag(flags, "message"),
        }),
      stdout,
    );
    stdout(
      asJson
        ? JSON.stringify({ milestone }, null, 2)
        : `Released ${fmt(milestone)}${milestone.releasedTag ? ` tag=${milestone.releasedTag}` : ""}${milestone.releasedCommitSha ? ` commit=${milestone.releasedCommitSha.slice(0, 8)}` : ""}${milestone.githubReleaseUrl ? ` release=${milestone.githubReleaseUrl}` : ""}`,
    );
    return 0;
  }
  stderr(`Unknown milestone subcommand: ${subCmd}`);
  return 1;
}

async function runTrain(ctx: CommandContext): Promise<number> {
  const { positionals, flags, baseUrl, autoStart, asJson, client, stdout, stderr } = ctx;
  const subCmd = positionals[1] ?? "list";
  if (subCmd === "list") {
    const repoId = getStringFlag(flags, "repo");
    const { entries } = await withAutoStart(
      baseUrl,
      autoStart,
      () => client.listMergeTrain(repoId),
      stdout,
    );
    if (asJson) {
      stdout(JSON.stringify({ entries }, null, 2));
    } else if (entries.length === 0) {
      stdout("Merge train queue is empty.");
    } else {
      for (const e of entries) {
        stdout(
          `[${e.id}] #${e.position} (${e.status}) ticket=${e.ticketId} branch=${e.branchName} -> ${e.baseBranch}${e.barrierGroupId ? ` barrier=${e.barrierGroupId}` : ""}${e.bypassedSpeculation ? " [bypass]" : ""}`,
        );
      }
    }
    return 0;
  }
  if (subCmd === "flush") {
    const repoId = getStringFlag(flags, "repo");
    const res = await withAutoStart(
      baseUrl,
      autoStart,
      () => client.flushMergeTrain(repoId),
      stdout,
    );
    stdout(asJson ? JSON.stringify(res, null, 2) : `Flushed merge train: merged=${res.mergedCount}`);
    return 0;
  }
  if (subCmd === "eject") {
    const entryId = positionals[2];
    if (!entryId) {
      stderr("Error: merge train entry id is required. Usage: super-work train eject <entryId>");
      return 1;
    }
    const res = await withAutoStart(
      baseUrl,
      autoStart,
      () =>
        client.ejectMergeTrainEntry(
          entryId,
          getStringFlag(flags, "m", "note", "reason"),
        ),
      stdout,
    );
    stdout(
      asJson
        ? JSON.stringify(res, null, 2)
        : `Ejected ${res.entry.id} (status=${res.entry.status})`,
    );
    return 0;
  }
  stderr(`Unknown train subcommand: ${subCmd}`);
  return 1;
}

export const milestoneCommands: Record<string, CommandHandler> = {
  campaign: runCampaign,
  milestone: runMilestone,
  train: runTrain,
};
