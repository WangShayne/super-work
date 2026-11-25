import type { PipelineTemplateId, WorkerEngineId } from "@super-work/core";
import type { CommandContext, CommandHandler } from "./context.ts";
import { getStringFlag, resolveTargetRepoId, withAutoStart } from "./shared.ts";

async function runRoutine(ctx: CommandContext): Promise<number> {
  const { positionals, flags, baseUrl, autoStart, asJson, client, stdout, stderr } = ctx;
  const subCmd = positionals[1] ?? "list";
  if (subCmd === "list") {
    const requestedRepo = getStringFlag(flags, "repo");
    const res = await withAutoStart(
      baseUrl,
      autoStart,
      () => client.listRoutines(requestedRepo),
      stdout,
    );
    if (asJson) {
      stdout(JSON.stringify(res, null, 2));
      return 0;
    }
    if (res.routines.length === 0) {
      stdout("No scheduled routines configured.");
      return 0;
    }
    for (const r of res.routines) {
      const sched =
        r.scheduleKind === "cron" ? `cron="${r.cronExpr}"` : `every=${r.intervalMinutes}m`;
      const win =
        r.activeHoursStart && r.activeHoursEnd
          ? ` window=${r.activeHoursStart}-${r.activeHoursEnd}`
          : "";
      stdout(
        `[${r.id}] (${r.enabled ? "ON" : "PAUSED"} | ${sched}${win} | last=${r.lastRunStatus ?? "never"}) ${r.name}`,
      );
    }
    return 0;
  }

  if (subCmd === "add") {
    const name = positionals[2];
    if (!name) {
      stderr('Error: routine name is required. Usage: super-work routine add "<name>" -d "<prompt>"');
      return 1;
    }
    const prompt = getStringFlag(flags, "d", "desc", "description") ?? name;
    const cronExpr = getStringFlag(flags, "cron");
    const everyStr = getStringFlag(flags, "every");
    const windowStr = getStringFlag(flags, "window");
    const [winStart, winEnd] = windowStr ? windowStr.split("-").map((s) => s.trim()) : [];
    const pathsRaw = getStringFlag(flags, "paths");
    const allowedPaths = pathsRaw
      ? pathsRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    const template = getStringFlag(flags, "template") as PipelineTemplateId | undefined;
    const preferredEngine = getStringFlag(flags, "engine") as WorkerEngineId | undefined;
    const budgetStr = getStringFlag(flags, "budget");
    const maxBudgetUsd = budgetStr ? Number(budgetStr) : undefined;

    const { routine } = await withAutoStart(
      baseUrl,
      autoStart,
      async () => {
        const repoId = await resolveTargetRepoId(client, getStringFlag(flags, "repo"));
        return client.createRoutine({
          repoId,
          name,
          prompt,
          scheduleKind: cronExpr ? "cron" : "interval",
          cronExpr,
          intervalMinutes: everyStr ? Number(everyStr) : undefined,
          activeHoursStart: winStart,
          activeHoursEnd: winEnd,
          allowedPaths,
          template,
          preferredEngine,
          maxBudgetUsd: Number.isFinite(maxBudgetUsd) ? maxBudgetUsd : undefined,
        });
      },
      stdout,
    );
    stdout(
      asJson
        ? JSON.stringify({ routine }, null, 2)
        : `Created routine ${routine.id}: ${routine.name} (nextRun=${routine.nextRunAt ?? "soon"})`,
    );
    return 0;
  }

  if (subCmd === "run") {
    const routineId = positionals[2];
    if (!routineId) {
      stderr("Error: routineId is required. Usage: super-work routine run <routineId>");
      return 1;
    }
    const { run } = await withAutoStart(
      baseUrl,
      autoStart,
      () => client.runRoutineNow(routineId),
      stdout,
    );
    stdout(
      asJson
        ? JSON.stringify({ run }, null, 2)
        : `Routine run ${run.id} finished [${run.status}]${run.promotedTicketId ? ` -> ticket ${run.promotedTicketId}` : ""}: ${run.summary}`,
    );
    return 0;
  }

  if (subCmd === "toggle") {
    const routineId = positionals[2];
    if (!routineId) {
      stderr("Error: routineId is required. Usage: super-work routine toggle <routineId>");
      return 1;
    }
    const { routine } = await withAutoStart(
      baseUrl,
      autoStart,
      async () => {
        const { routines } = await client.listRoutines();
        const target = routines.find((r) => r.id === routineId);
        if (!target) throw new Error(`Routine not found: ${routineId}`);
        return client.patchRoutine(routineId, { enabled: !target.enabled });
      },
      stdout,
    );
    stdout(
      asJson
        ? JSON.stringify({ routine }, null, 2)
        : `Routine ${routine.id} is now ${routine.enabled ? "ENABLED" : "PAUSED"}`,
    );
    return 0;
  }

  if (subCmd === "runs") {
    const routineId = getStringFlag(flags, "routine") ?? positionals[2];
    const { runs } = await withAutoStart(
      baseUrl,
      autoStart,
      () => client.listRoutineRuns({ repoId: getStringFlag(flags, "repo"), routineId }),
      stdout,
    );
    if (asJson) {
      stdout(JSON.stringify({ runs }, null, 2));
      return 0;
    }
    if (runs.length === 0) {
      stdout("No routine runs recorded.");
      return 0;
    }
    for (const run of runs) {
      stdout(
        `[${run.id}] (${run.status}) routine=${run.routineId}${run.promotedTicketId ? ` ticket=${run.promotedTicketId}` : ""} :: ${run.summary.slice(0, 120)}`,
      );
    }
    return 0;
  }

  if (subCmd === "delete") {
    const routineId = positionals[2];
    if (!routineId) {
      stderr("Error: routineId is required. Usage: super-work routine delete <routineId>");
      return 1;
    }
    const res = await withAutoStart(
      baseUrl,
      autoStart,
      () => client.deleteRoutine(routineId),
      stdout,
    );
    stdout(asJson ? JSON.stringify(res, null, 2) : `Deleted routine ${routineId}`);
    return 0;
  }

  stderr(`Unknown routine subcommand: ${subCmd}`);
  return 1;
}

export const routineCommands: Record<string, CommandHandler> = {
  routine: runRoutine,
};
