import type { EnginePreference } from "@super-work/core";
import type { CommandContext } from "./context.ts";
import { getStringFlag, resolveTargetRepoId, waitForTicketCompletion, withAutoStart } from "./shared.ts";

const USAGE =
  'Usage: super-work do "<requirement>" [--preview] [--milestone <vX.Y.Z>] [--repo <id>] [--engine <e>] [--budget <usd>] [--wait] [--json]';

/** `super-work do "<自然语言需求>"` — Super-Agent 首要动词：一句话交给系统。 */
export async function runDo(ctx: CommandContext): Promise<number> {
  const { positionals, flags, options, baseUrl, autoStart, asJson, client, stdout, stderr } = ctx;
  const requirement = positionals.slice(1).join(" ").trim();
  if (!requirement) {
    stderr(`Error: requirement text is required. ${USAGE}`);
    return 1;
  }
  const preferredEngine = getStringFlag(flags, "engine") as EnginePreference | undefined;
  const budgetRaw = getStringFlag(flags, "budget");
  const budget = budgetRaw !== undefined ? Number(budgetRaw) : undefined;
  const maxBudgetUsd = budget !== undefined && Number.isFinite(budget) ? budget : undefined;
  const preview = Boolean(flags.preview || flags["preview-only"]);
  const wait = Boolean(flags.wait);
  const milestone = getStringFlag(flags, "milestone");
  const timeoutMs = Number(getStringFlag(flags, "timeout-ms") ?? options?.waitTimeoutMs ?? 300_000);

  if (milestone) {
    const { milestone: created } = await withAutoStart(
      baseUrl,
      autoStart,
      async () =>
        client.createMilestone({
          repoId: await resolveTargetRepoId(client, getStringFlag(flags, "repo")),
          name: milestone,
          targetVersion: milestone,
          requirements: [requirement],
          preferredEngine,
          maxBudgetUsdPerItem: maxBudgetUsd,
        }),
      stdout,
    );
    stdout(
      asJson
        ? JSON.stringify({ milestone: created }, null, 2)
        : `Milestone ${created.id} (${created.targetVersion ?? milestone}) created: ${requirement}`,
    );
    return 0;
  }

  const input = async () => ({
    repoId: await resolveTargetRepoId(client, getStringFlag(flags, "repo")),
    requirement,
    preferredRoute: "auto" as const,
    preferredEngine,
    maxBudgetUsd,
  });

  if (preview) {
    const { plan } = await withAutoStart(
      baseUrl,
      autoStart,
      async () => client.previewIntake(await input()),
      stdout,
    );
    if (asJson) {
      stdout(JSON.stringify({ plan }, null, 2));
      return 0;
    }
    stdout(`Route: ${plan.route} (confidence=${Math.round(plan.confidence * 100)}%)`);
    stdout(`Title: ${plan.title}`);
    stdout(`Summary: ${plan.summary}`);
    return 0;
  }

  const res = await withAutoStart(
    baseUrl,
    autoStart,
    async () => client.submitIntake(await input()),
    stdout,
  );

  const watchId = res.ticket?.id ?? res.epic?.id;
  if (!wait || !watchId) {
    if (asJson) {
      stdout(JSON.stringify(res, null, 2));
    } else if (res.ticket) {
      stdout(`do -> Ticket ${res.ticket.id} (${res.ticket.status}): ${res.ticket.title}`);
    } else if (res.epic) {
      stdout(`do -> Epic ${res.epic.id} (${res.subtasks?.length ?? 0} subtasks): ${res.epic.title}`);
    } else if (res.campaign) {
      stdout(`do -> GoalCampaign ${res.campaign.id} (${res.campaign.status}): ${res.campaign.name}`);
    }
    return 0;
  }

  stdout(`do -> ${watchId} (${res.route}); streaming live progress...`);
  const finalTicket = await waitForTicketCompletion(client, watchId, stdout, timeoutMs);
  stdout(
    asJson
      ? JSON.stringify({ ...res, finalTicket }, null, 2)
      : `${watchId} finished with status=${finalTicket.status} cost=$${finalTicket.costUsd.toFixed(4)}`,
  );
  return finalTicket.status === "delivered" ? 0 : 1;
}
