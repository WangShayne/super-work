import { createInterface } from "node:readline";
import type { EngineHealthRecord } from "@super-work/core";
import { ServiceManager, assertSafeHostBinding } from "@super-work/drivers";
import { DaemonNotReachableError } from "../client.ts";
import type { CommandContext, CommandHandler } from "./context.ts";
import { getStringFlag, resolveServerEntryPath, spawnDetachedDaemon, withAutoStart } from "./shared.ts";

async function runUp(ctx: CommandContext): Promise<number> {
  const { flags, baseUrl, token, stdout } = ctx;
  const host = getStringFlag(flags, "host") ?? process.env.HOST ?? "127.0.0.1";
  assertSafeHostBinding(host, token);
  const port = getStringFlag(flags, "port") ?? new URL(baseUrl).port ?? "4318";
  const probeHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const targetUrl =
    getStringFlag(flags, "port") || getStringFlag(flags, "host")
      ? `http://${probeHost}:${port}`
      : baseUrl;
  const dataDir = getStringFlag(flags, "data-dir");
  const detach = Boolean(flags.d || flags.detach);

  if (detach) {
    const pid = await spawnDetachedDaemon(targetUrl, { host, port, dataDir, token });
    stdout(`Daemon running at ${targetUrl} (bound=${host}:${port}, pid=${pid ?? "detached"})`);
    return 0;
  }

  const proc = Bun.spawn(["bun", "run", resolveServerEntryPath()], {
    env: {
      ...process.env,
      HOST: host,
      PORT: String(port),
      ...(dataDir ? { SUPER_WORK_DATA_DIR: dataDir } : {}),
      ...(token ? { SUPER_WORK_TOKEN: token } : {}),
    },
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  const exitCode = await proc.exited;
  return exitCode;
}

async function runService(ctx: CommandContext): Promise<number> {
  const { positionals, flags, token, asJson, stdout, stderr } = ctx;
  const subCmd = positionals[1] ?? "status";
  const host = getStringFlag(flags, "host") ?? process.env.HOST ?? "127.0.0.1";
  const portRaw = getStringFlag(flags, "port") ?? process.env.PORT ?? "4318";
  const dataDir = getStringFlag(flags, "data-dir");
  const manager = new ServiceManager({
    host,
    port: Number(portRaw) || 4318,
    dataDir,
    authToken: token,
    serverEntryPath: resolveServerEntryPath(),
  });
  if (subCmd === "install") {
    const st = await manager.install({ startNow: !flags["no-start"] });
    stdout(
      asJson
        ? JSON.stringify(st, null, 2)
        : `[${st.manager}] installed=${st.installed} running=${st.running} file=${st.serviceFilePath ?? "-"} (${st.detail})`,
    );
    return 0;
  }
  if (subCmd === "uninstall") {
    const st = await manager.uninstall();
    stdout(asJson ? JSON.stringify(st, null, 2) : `Service uninstalled (${st.detail})`);
    return 0;
  }
  if (subCmd === "start") {
    const st = await manager.start();
    stdout(
      asJson
        ? JSON.stringify(st, null, 2)
        : `[${st.manager}] running=${st.running} (${st.detail})`,
    );
    return 0;
  }
  if (subCmd === "stop") {
    const st = await manager.stop();
    stdout(
      asJson
        ? JSON.stringify(st, null, 2)
        : `[${st.manager}] running=${st.running} (${st.detail})`,
    );
    return 0;
  }
  if (subCmd === "logs") {
    const linesRaw = Number(getStringFlag(flags, "lines") ?? 80);
    const logs = manager.readLogs(Number.isFinite(linesRaw) && linesRaw > 0 ? linesRaw : 80);
    if (asJson) {
      stdout(JSON.stringify(logs, null, 2));
    } else if (!logs.exists) {
      stdout(`Daemon log not found yet: ${logs.logFilePath}`);
    } else {
      for (const line of logs.lines) {
        stdout(line);
      }
    }
    return 0;
  }
  if (subCmd === "status") {
    const st = await manager.status();
    stdout(
      asJson
        ? JSON.stringify(st, null, 2)
        : `[${st.manager}] installed=${st.installed} running=${st.running} bind=${st.host}:${st.port} dataDir=${st.dataDir} webUiBuilt=${st.webUiBuilt} (${st.detail})`,
    );
    return 0;
  }
  stderr(`Unknown service subcommand: ${subCmd}`);
  return 1;
}

async function runMcp(ctx: CommandContext): Promise<number> {
  const { flags, options, baseUrl, token, client, stdout, stderr } = ctx;
  const noAutoStart = Boolean(flags["no-auto-start"]);
  const ensureLocalDaemon = async () => {
    try {
      await client.getHealth();
    } catch (err) {
      if (err instanceof DaemonNotReachableError && !noAutoStart) {
        const hostname = new URL(baseUrl).hostname;
        if (hostname === "localhost" || hostname === "127.0.0.1") {
          stderr(`[super-work mcp] Starting daemon at ${baseUrl}...`);
          await spawnDetachedDaemon(baseUrl, { token });
          return;
        }
      }
      throw err;
    }
  };

  await ensureLocalDaemon();

  const lineSource: AsyncIterable<string> =
    options?.mcpInputLines ?? createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const rawLine of lineSource) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      stdout(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }),
      );
      continue;
    }
    try {
      const reply = await client.sendMcpMessage(parsed);
      if (reply !== null) {
        stdout(JSON.stringify(reply));
      }
    } catch (err) {
      const msgId =
        parsed && typeof parsed === "object" && !Array.isArray(parsed) && "id" in parsed
          ? ((parsed as { id?: string | number | null }).id ?? null)
          : null;
      stdout(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msgId,
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : String(err),
          },
        }),
      );
    }
  }
  return 0;
}

async function runStatus(ctx: CommandContext): Promise<number> {
  const { flags, baseUrl, autoStart, asJson, client, stdout } = ctx;
  const requestedRepo = getStringFlag(flags, "repo");
  const result = await withAutoStart(
    baseUrl,
    autoStart,
    async () => {
      const [health, reposRes, ticketsRes] = await Promise.all([
        client.getHealth(),
        client.listRepos(),
        client.listTickets(requestedRepo),
      ]);
      const repoId = requestedRepo ?? reposRes.repos[0]?.id;
      const { metrics } = await client.getMetrics(repoId);
      return { health, repos: reposRes.repos, tickets: ticketsRes.tickets, metrics };
    },
    stdout,
  );

  if (asJson) {
    stdout(JSON.stringify(result, null, 2));
    return 0;
  }

  const repo = result.repos.find((r) => r.id === result.metrics.repoId) ?? result.repos[0];
  stdout(`super-work daemon: ${baseUrl} (LLM: ${result.health.llmProvider})`);
  stdout(`Engines: ${result.health.availableEngines.join(", ") || "none"}`);
  if (repo) {
    stdout(
      `Repo: ${repo.name} (${repo.id}) · mode=${repo.mode} · base=${repo.baseBranch}` +
        (repo.verificationStrategy ? ` · verify=${repo.verificationStrategy}` : ""),
    );
  }
  stdout(
    `Tickets: total=${result.metrics.ticketCounts.total}, active=${result.metrics.ticketCounts.active}, delivered=${result.metrics.ticketCounts.delivered}, needs_human=${result.metrics.ticketCounts.needsHuman}`,
  );
  stdout(
    `Inbox pending: ${result.health.counts.pendingInbox} · Outbox pending: ${result.health.counts.pendingOutbox}`,
  );
  stdout(
    `Spend today: $${result.metrics.todayCostUsd.toFixed(4)}` +
      (result.metrics.effectiveDailyBudgetUsd
        ? ` / $${result.metrics.effectiveDailyBudgetUsd.toFixed(2)} (${result.metrics.budgetExceeded ? "CAP REACHED" : "ok"})`
        : " (unlimited)"),
  );
  return 0;
}

async function runDoctor(ctx: CommandContext): Promise<number> {
  const { flags, baseUrl, autoStart, asJson, client, stdout } = ctx;
  const fix = Boolean(flags.fix);
  const report = await withAutoStart(
    baseUrl,
    autoStart,
    () => client.runDoctor(fix),
    stdout,
  );
  let playbookPrune: Awaited<ReturnType<typeof client.pruneNoisyPlaybooks>> | undefined;
  if (flags["prune-playbooks"]) {
    playbookPrune = await withAutoStart(
      baseUrl,
      autoStart,
      () => client.pruneNoisyPlaybooks({ mode: "disable" }),
      stdout,
    );
  }
  if (asJson) {
    stdout(JSON.stringify(playbookPrune ? { ...report, playbookPrune } : report, null, 2));
  } else {
    if (playbookPrune) {
      stdout(`Playbook hygiene: disabled ${playbookPrune.affectedIds.length} noisy rule(s)`);
    }
    stdout(
      `System Doctor: healthy=${report.healthy} fixesApplied=${report.fixesApplied} checkedAt=${report.checkedAt}`,
    );
    for (const item of report.items) {
      stdout(`  [${item.status.toUpperCase()}] (${item.category}) ${item.title}: ${item.detail}`);
    }
    if (report.hotspots && report.hotspots.length > 0) {
      stdout(`Hotspots (>1500 lines): ${report.hotspots.length}`);
      for (const h of report.hotspots) {
        stdout(
          `  ${String(h.lineCount).padStart(6)} lines  ${String(h.exportedSymbolCount).padStart(3)} exports  ${String(h.dependentCount).padStart(3)} dependents  ${h.filePath}`,
        );
      }
    }
  }
  return 0;
}

async function runEngines(ctx: CommandContext): Promise<number> {
  const { positionals, baseUrl, autoStart, asJson, client, stdout, stderr } = ctx;
  const sub = positionals[1] ?? "status";
  const printEngines = (engines: EngineHealthRecord[]): void => {
    if (engines.length === 0) {
      stdout("Engine circuit breaker: all engines healthy (no records)");
      return;
    }
    for (const e of engines) {
      stdout(
        `  ${e.engine.padEnd(9)} ${e.status.padEnd(8)} failures=${e.consecutiveFailures}${e.failureKind ? ` kind=${e.failureKind}` : ""}${e.cooldownUntil ? ` cooldownUntil=${e.cooldownUntil}` : ""}${e.reason ? ` reason=${e.reason.slice(0, 120)}` : ""}`,
      );
    }
  };
  if (sub === "reset") {
    const engine = positionals[2];
    if (!engine) {
      stderr("Error: engine is required. Usage: super-work engines reset <engine>");
      return 1;
    }
    const res = await withAutoStart(baseUrl, autoStart, () => client.resetEngineHealth(engine), stdout);
    if (asJson) stdout(JSON.stringify(res, null, 2));
    else stdout(`Engine ${res.engine.engine} reset to healthy`);
    return 0;
  }
  if (sub === "probe") {
    const res = await withAutoStart(
      baseUrl,
      autoStart,
      () => client.probeEngineHealth(positionals[2]),
      stdout,
    );
    if (asJson) stdout(JSON.stringify(res, null, 2));
    else {
      stdout(`Re-probed ${res.probed.length} tripped engine(s); next stage will verify them`);
      printEngines(res.engines);
    }
    return 0;
  }
  if (sub !== "status") {
    stderr("Usage: super-work engines [status | reset <engine> | probe [engine]]");
    return 1;
  }
  const res = await withAutoStart(baseUrl, autoStart, () => client.listEngineHealth(), stdout);
  if (asJson) stdout(JSON.stringify(res, null, 2));
  else printEngines(res.engines);
  return 0;
}

async function runBackup(ctx: CommandContext): Promise<number> {
  const { positionals, flags, baseUrl, autoStart, asJson, client, stdout, stderr } = ctx;
  const subCmd = positionals[1] ?? "list";
  if (subCmd === "create") {
    const res = await withAutoStart(
      baseUrl,
      autoStart,
      () => client.createBackup(),
      stdout,
    );
    if (asJson) {
      stdout(JSON.stringify(res, null, 2));
    } else {
      stdout(
        `Created backup ${res.backup.filename} (${res.backup.byteSize} bytes, integrity=${res.backup.dbIntegrityOk ?? true}) -> ${res.backup.filePath}`,
      );
    }
    return 0;
  }
  if (subCmd === "restore") {
    const backupId = positionals[2];
    if (!backupId) {
      stderr("Error: backupId or filename is required. Usage: super-work backup restore <backupId> [--force]");
      return 1;
    }
    const res = await withAutoStart(
      baseUrl,
      autoStart,
      () => client.restoreBackup(backupId, Boolean(flags.force)),
      stdout,
    );
    if (asJson) {
      stdout(JSON.stringify(res, null, 2));
    } else {
      stdout(
        `Restored ${res.restoredBackup.filename} (ok=${res.ok}; ${res.integrityDetail})${res.preRestoreSafetyBackup ? ` | Safety snapshot: ${res.preRestoreSafetyBackup.filename}` : ""}`,
      );
    }
    return 0;
  }
  const res = await withAutoStart(
    baseUrl,
    autoStart,
    () => client.listBackups(),
    stdout,
  );
  if (asJson) {
    stdout(JSON.stringify(res, null, 2));
  } else if (res.backups.length === 0) {
    stdout("No SQLite hot backups created yet.");
  } else {
    for (const b of res.backups) {
      stdout(`${b.id} :: ${b.filename} (${b.byteSize} bytes) createdAt=${b.createdAt}`);
    }
  }
  return 0;
}

async function runReload(ctx: CommandContext): Promise<number> {
  const { flags, baseUrl, autoStart, asJson, client, stdout } = ctx;
  const force = Boolean(flags.force);
  const skipCanary = Boolean(flags["skip-canary"]);
  const { reload } = await withAutoStart(
    baseUrl,
    autoStart,
    () => client.triggerReload({ force, skipCanary }),
    stdout,
  );
  stdout(
    asJson
      ? JSON.stringify({ reload }, null, 2)
      : `Self-host reload state: phase=${reload.phase}${reload.summary ? ` — ${reload.summary}` : ""}`,
  );
  return reload.phase === "failed" ? 1 : 0;
}

export const systemCommands: Record<string, CommandHandler> = {
  up: runUp,
  service: runService,
  mcp: runMcp,
  status: runStatus,
  doctor: runDoctor,
  engines: runEngines,
  backup: runBackup,
  reload: runReload,
};
