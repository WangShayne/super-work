import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CommandContext, CommandHandler } from "./context.ts";
import { getStringFlag, resolveTargetRepoId, withAutoStart } from "./shared.ts";

async function runPlaybook(ctx: CommandContext): Promise<number> {
  const { positionals, flags, baseUrl, autoStart, asJson, client, stdout, stderr } = ctx;
  const subCmd = positionals[1] ?? "list";
  if (subCmd === "list") {
    const { entries } = await withAutoStart(
      baseUrl,
      autoStart,
      async () => {
        const repoId = await resolveTargetRepoId(client, getStringFlag(flags, "repo"));
        return client.listPlaybook(repoId);
      },
      stdout,
    );
    if (asJson) {
      stdout(JSON.stringify({ entries }, null, 2));
      return 0;
    }
    if (entries.length === 0) {
      stdout("Playbook is empty.");
      return 0;
    }
    for (const e of entries) {
      stdout(
        `[${e.id}] (${e.source}${e.pinned ? " | PIN" : ""}${e.enabled ? "" : " | DISABLED"}${e.healthStatus && e.healthStatus !== "healthy" ? ` | ${e.healthStatus.toUpperCase()}` : ""} | hits=${e.hitCount ?? 0}) [${e.scopePaths.join(",")}] ${e.rule}`,
      );
    }
    return 0;
  }

  if (subCmd === "audit") {
    const repoFlag = getStringFlag(flags, "repo");
    const report = await withAutoStart(baseUrl, autoStart, () => client.auditPlaybookHygiene(repoFlag), stdout);
    if (asJson) {
      stdout(JSON.stringify(report, null, 2));
    } else {
      stdout(
        `Playbook hygiene: total=${report.total} healthy=${report.healthy} noisy=${report.noisyCount}`,
      );
      for (const e of report.noisyEntries) {
        stdout(
          `  ${e.id} (${e.source}${e.enabled ? "" : ", disabled"}) ${e.rule.slice(0, 100)} — ${e.reasons.join("; ")}`,
        );
      }
    }
    return 0;
  }

  if (subCmd === "prune") {
    const mode = flags.delete ? "delete" : "disable";
    const repoFlag = getStringFlag(flags, "repo");
    const res = await withAutoStart(
      baseUrl,
      autoStart,
      async () => {
        const repoId = await resolveTargetRepoId(client, repoFlag);
        const stale = await client.prunePlaybook(repoId);
        const hygiene = await client.pruneNoisyPlaybooks({ repoId, mode });
        return { ...stale, hygiene };
      },
      stdout,
    );
    stdout(
      asJson
        ? JSON.stringify(res, null, 2)
        : `Pruned ${res.prunedIds.length} stale/suspect auto-healed rule(s); ${res.keptCount} rule(s) kept. ` +
            `${res.hygiene.mode === "delete" ? "Deleted" : "Disabled"} ${res.hygiene.affectedIds.length} noisy rule(s).`,
    );
    return 0;
  }

  if (subCmd === "add") {
    const rule = positionals[2];
    if (!rule) {
      stderr('Error: rule text is required. Usage: super-work playbook add "<rule>" [--paths <csv>] [--pin]');
      return 1;
    }
    const pathsRaw = getStringFlag(flags, "paths");
    const scopePaths = pathsRaw
      ? pathsRaw
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean)
      : undefined;
    const { entry } = await withAutoStart(
      baseUrl,
      autoStart,
      async () => {
        const repoId = await resolveTargetRepoId(client, getStringFlag(flags, "repo"));
        return client.addPlaybook(repoId, {
          rule,
          scopePaths,
          pinned: Boolean(flags.pin || flags.pinned),
          enabled: true,
        });
      },
      stdout,
    );
    stdout(
      asJson
        ? JSON.stringify({ entry }, null, 2)
        : `Added playbook rule ${entry.id}: [${entry.scopePaths.join(",")}] ${entry.rule}`,
    );
    return 0;
  }

  if (subCmd === "toggle") {
    const entryId = positionals[2];
    if (!entryId) {
      stderr("Error: entryId is required. Usage: super-work playbook toggle <entryId>");
      return 1;
    }
    const { entry } = await withAutoStart(
      baseUrl,
      autoStart,
      async () => {
        const repoId = await resolveTargetRepoId(client, getStringFlag(flags, "repo"));
        const { entries } = await client.listPlaybook(repoId);
        const target = entries.find((e) => e.id === entryId);
        if (!target) {
          throw new Error(`Playbook entry not found in repo ${repoId}: ${entryId}`);
        }
        return client.patchPlaybook(entryId, { enabled: !target.enabled });
      },
      stdout,
    );
    stdout(
      asJson
        ? JSON.stringify({ entry }, null, 2)
        : `Playbook ${entry.id} is now ${entry.enabled ? "ENABLED" : "DISABLED"}`,
    );
    return 0;
  }

  if (subCmd === "delete") {
    const entryId = positionals[2];
    if (!entryId) {
      stderr("Error: entryId is required. Usage: super-work playbook delete <entryId>");
      return 1;
    }
    const res = await withAutoStart(
      baseUrl,
      autoStart,
      () => client.deletePlaybook(entryId),
      stdout,
    );
    stdout(asJson ? JSON.stringify(res, null, 2) : `Deleted playbook entry ${entryId}`);
    return 0;
  }

  if (subCmd === "sync") {
    const doExport = Boolean(flags.export);
    const res = await withAutoStart(
      baseUrl,
      autoStart,
      async () => {
        const repoId = await resolveTargetRepoId(client, getStringFlag(flags, "repo"));
        return doExport ? client.exportContract(repoId) : client.syncContract(repoId);
      },
      stdout,
    );
    stdout(
      asJson
        ? JSON.stringify(res, null, 2)
        : doExport && "filePath" in res
          ? `Exported super-work.json contract to ${res.filePath}`
          : `Synced super-work.json contract for repo ${res.repo.id}`,
    );
    return 0;
  }

  stderr(`Unknown playbook subcommand: ${subCmd}`);
  return 1;
}

async function runCasebook(ctx: CommandContext): Promise<number> {
  const { positionals, flags, baseUrl, autoStart, asJson, client, stdout } = ctx;
  const subCmd = positionals[1];
  const q =
    subCmd === "search"
      ? positionals.slice(2).join(" ")
      : subCmd && subCmd !== "list"
        ? positionals.slice(1).join(" ")
        : undefined;
  const { entries } = await withAutoStart(
    baseUrl,
    autoStart,
    async () => {
      const repoId = await resolveTargetRepoId(client, getStringFlag(flags, "repo"));
      return client.listCasebook(repoId, q);
    },
    stdout,
  );
  if (asJson) {
    stdout(JSON.stringify({ entries }, null, 2));
    return 0;
  }
  if (entries.length === 0) {
    stdout("Casebook is empty.");
    return 0;
  }
  for (const c of entries) {
    stdout(
      `[${c.id}] (${c.reverted ? "REVERTED WARNING" : "VERIFIED"} | hits=${c.hitCount} | ${c.scopePaths.join(",")}) ${c.title} :: ${c.solutionSummary.slice(0, 100)}`,
    );
  }
  return 0;
}

async function runBlueprints(ctx: CommandContext): Promise<number> {
  const { flags, baseUrl, autoStart, asJson, client, stdout } = ctx;
  const data = await withAutoStart(
    baseUrl,
    autoStart,
    async () => {
      const repoId = await resolveTargetRepoId(client, getStringFlag(flags, "repo"));
      return client.listBlueprints(repoId);
    },
    stdout,
  );
  if (asJson) {
    stdout(JSON.stringify(data, null, 2));
  } else {
    for (const bp of data.blueprints) {
      stdout(
        `${bp.id} (${bp.template}, gate=${bp.deliveryGatePolicy ?? "repo"}${bp.tddMode ? ", tdd" : ""}) - ${bp.name}: ${bp.description}`,
      );
    }
  }
  return 0;
}

async function runBundle(ctx: CommandContext): Promise<number> {
  const { positionals, flags, baseUrl, autoStart, asJson, client, stdout, stderr } = ctx;
  const subCmd = positionals[1] ?? "export";
  if (subCmd === "export") {
    const repoId = await resolveTargetRepoId(
      client,
      positionals[2] ?? getStringFlag(flags, "repo"),
    );
    const { bundle } = await withAutoStart(
      baseUrl,
      autoStart,
      () => client.exportKnowledgeBundle(repoId),
      stdout,
    );
    const outPath = getStringFlag(flags, "o", "out");
    const jsonText = JSON.stringify(bundle, null, 2);
    if (outPath) {
      writeFileSync(resolve(outPath), jsonText, "utf8");
      stdout(
        `Exported knowledge bundle (${bundle.playbook.length} playbook, ${bundle.casebook.length} casebook, ${bundle.blueprints.length} blueprints) -> ${outPath}`,
      );
    } else {
      stdout(jsonText);
    }
    return 0;
  }
  if (subCmd === "import") {
    const repoId = await resolveTargetRepoId(
      client,
      positionals[2] ?? getStringFlag(flags, "repo"),
    );
    const filePath = positionals[3];
    if (!filePath) {
      stderr("Error: bundle path is required. Usage: super-work bundle import <repoId> <path>");
      return 1;
    }
    const parsed = JSON.parse(readFileSync(resolve(filePath), "utf8"));
    const res = await withAutoStart(
      baseUrl,
      autoStart,
      () => client.importKnowledgeBundle(repoId, parsed),
      stdout,
    );
    stdout(
      asJson
        ? JSON.stringify(res, null, 2)
        : `Imported playbook=${res.importedPlaybook}, casebook=${res.importedCasebook}, blueprints=${res.importedBlueprints}, skipped=${res.skippedDuplicates}`,
    );
    return 0;
  }
  stderr(`Unknown bundle subcommand: ${subCmd}`);
  return 1;
}

export const knowledgeCommands: Record<string, CommandHandler> = {
  playbook: runPlaybook,
  casebook: runCasebook,
  blueprints: runBlueprints,
  bundle: runBundle,
};
