#!/usr/bin/env bun
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PipelineTemplateId, Ticket, WorkerEngineId } from "@super-work/core";
import { DaemonNotReachableError, SuperWorkHttpClient, type ParsedSseEvent } from "./client.ts";

export { SuperWorkHttpClient, DaemonNotReachableError } from "./client.ts";

export interface CliRunOptions {
  baseUrl?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  waitTimeoutMs?: number;
}

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseCliArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const valueFlags = new Set([
    "repo",
    "d",
    "desc",
    "description",
    "paths",
    "template",
    "engine",
    "budget",
    "port",
    "data-dir",
    "m",
    "note",
    "budget-add",
    "status",
    "url",
  ]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (valueFlags.has(key) && next !== undefined && !next.startsWith("-")) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      const short = arg.slice(1);
      const next = argv[i + 1];
      if (valueFlags.has(short) && next !== undefined && !next.startsWith("-")) {
        flags[short] = next;
        i += 1;
      } else {
        flags[short] = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function getStringFlag(flags: Record<string, string | boolean>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const val = flags[k];
    if (typeof val === "string" && val.trim().length > 0) {
      return val.trim();
    }
  }
  return undefined;
}

function resolveServerEntryPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../server/src/index.ts");
}

async function waitForHealth(baseUrl: string, timeoutMs = 10_000): Promise<boolean> {
  const client = new SuperWorkHttpClient(baseUrl);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const h = await client.getHealth();
      if (h.ok) return true;
    } catch {
      // Daemon still booting
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function spawnDetachedDaemon(baseUrl: string, options?: { port?: string; dataDir?: string }): Promise<number | undefined> {
  const parsedUrl = new URL(baseUrl);
  const port = options?.port ?? (parsedUrl.port || "4318");
  const serverEntry = resolveServerEntryPath();
  const proc = Bun.spawn(["bun", "run", serverEntry], {
    env: {
      ...process.env,
      PORT: String(port),
      ...(options?.dataDir ? { SUPER_WORK_DATA_DIR: options.dataDir } : {}),
    },
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  proc.unref?.();
  const ready = await waitForHealth(baseUrl, 10_000);
  if (!ready) {
    throw new Error(`Timed out waiting for daemon health at ${baseUrl}`);
  }
  return proc.pid;
}

async function withAutoStart<T>(
  baseUrl: string,
  autoStart: boolean,
  fn: () => Promise<T>,
  stdout: (line: string) => void,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DaemonNotReachableError && autoStart) {
      stdout(`Daemon offline at ${baseUrl}; starting background daemon...`);
      await spawnDetachedDaemon(baseUrl);
      return fn();
    }
    throw err;
  }
}

async function resolveTargetRepoId(client: SuperWorkHttpClient, requested?: string): Promise<string> {
  if (requested) return requested;
  const { repos } = await client.listRepos();
  if (repos.length === 0) {
    throw new Error("No repositories registered in super-work. Register a repo first via the Web UI or POST /api/repos.");
  }
  return repos[0]!.id;
}

function isFinalForWait(status: Ticket["status"]): boolean {
  return status === "delivered" || status === "failed" || status === "cancelled" || status === "needs_human";
}

function formatEventLine(ev: ParsedSseEvent): string {
  const data = ev.data;
  if (ev.event === "worker_event") {
    const engine = String(data.engine ?? "worker");
    const inner = (data.event ?? {}) as Record<string, unknown>;
    const type = String(inner.type ?? "event");
    const detail =
      (inner.toolName ? `${inner.toolName}(${String(inner.inputSummary ?? "").slice(0, 80)})` : undefined) ??
      (inner.text as string | undefined) ??
      (inner.summary as string | undefined) ??
      (inner.message as string | undefined) ??
      "";
    return `[${engine}:${type}] ${detail}`.trim();
  }
  if (ev.event === "ticket_updated") {
    const t = data.ticket as { status?: string; currentStage?: string } | undefined;
    return `[ticket] status=${t?.status ?? "?"} stage=${t?.currentStage ?? "?"}`;
  }
  if (ev.event === "stage_started" || ev.event === "stage_completed") {
    const run = data.stageRun as { stage?: string; engine?: string; status?: string; summary?: string } | undefined;
    return `[${ev.event}] ${run?.stage ?? "?"} (${run?.engine ?? "?"}) status=${run?.status ?? "?"}${run?.summary ? `: ${run.summary.slice(0, 120)}` : ""}`;
  }
  if (ev.event === "verification_completed") {
    const res = data.result as { ok?: boolean; summary?: string } | undefined;
    return `[verification] ${res?.ok ? "PASS" : "FAIL"}: ${res?.summary ?? ""}`;
  }
  return `[${ev.event}] ${JSON.stringify(data).slice(0, 140)}`;
}

async function waitForTicketCompletion(
  client: SuperWorkHttpClient,
  ticketId: string,
  stdout: (line: string) => void,
  timeoutMs = 300_000,
): Promise<Ticket> {
  const ac = new AbortController();
  const timeoutTimer = setTimeout(() => ac.abort("wait_timeout"), timeoutMs);

  let latestTicket = (await client.getTicketDetail(ticketId)).ticket;
  if (isFinalForWait(latestTicket.status)) {
    clearTimeout(timeoutTimer);
    return latestTicket;
  }

  const ssePromise = client
    .streamEvents((ev) => {
      const evTicketId =
        (ev.data.ticketId as string | undefined) ??
        ((ev.data.ticket as { id?: string } | undefined)?.id);
      if (evTicketId !== ticketId) return;
      stdout(formatEventLine(ev));
      if (ev.event === "ticket_updated") {
        const updated = ev.data.ticket as Ticket | undefined;
        if (updated && isFinalForWait(updated.status)) {
          latestTicket = updated;
          ac.abort("terminal");
        }
      }
    }, ac.signal)
    .catch(() => {});

  const pollTimer = setInterval(() => {
    void client
      .getTicketDetail(ticketId)
      .then((detail) => {
        latestTicket = detail.ticket;
        if (isFinalForWait(detail.ticket.status)) {
          ac.abort("terminal");
        }
      })
      .catch(() => {});
  }, 600);

  try {
    await ssePromise;
    return (await client.getTicketDetail(ticketId)).ticket;
  } finally {
    clearTimeout(timeoutTimer);
    clearInterval(pollTimer);
  }
}

function printHelp(stdout: (line: string) => void): void {
  stdout(`super-work v0.4.0 CLI

Usage:
  super-work up [-d|--detach] [--port 4318] [--data-dir path]
  super-work status [--repo <id>] [--auto-start] [--json]
  super-work dispatch <title> [-d|--desc <text>] [--repo <id>] [--paths <csv>]
                      [--template fast|standard|strict] [--engine claude|codex|opencode|mock]
                      [--budget <usd>] [--wait] [--auto-start] [--json]
  super-work epic <title> [-d|--desc <text>] [--repo <id>] [--template fast|standard|strict]
                  [--engine ...] [--preview-only] [--per-subtask] [--wait] [--auto-start] [--json]
  super-work inbox [list | approve <id> [--expand-mandate] [--local-merge] [--budget-add <usd>] [-m <note>] | reject <id> [-m <note>]]
  super-work logs <ticketId> [-f|--follow] [--auto-start]

Env:
  SUPER_WORK_URL   Daemon base URL (default: http://localhost:4318)`);
}

export async function runCli(argv: string[], options?: CliRunOptions): Promise<number> {
  const stdout = options?.stdout ?? ((line: string) => console.log(line));
  const stderr = options?.stderr ?? ((line: string) => console.error(line));

  const { positionals, flags } = parseCliArgs(argv);
  const cmd = positionals[0];

  if (!cmd || cmd === "help" || flags.help || flags.h) {
    printHelp(stdout);
    return 0;
  }

  const baseUrl =
    options?.baseUrl ??
    getStringFlag(flags, "url") ??
    process.env.SUPER_WORK_URL ??
    "http://localhost:4318";
  const autoStart = Boolean(flags["auto-start"]);
  const asJson = Boolean(flags.json);
  const client = new SuperWorkHttpClient(baseUrl);

  try {
    if (cmd === "up") {
      const port = getStringFlag(flags, "port") ?? new URL(baseUrl).port ?? "4318";
      const targetUrl = getStringFlag(flags, "port")
        ? `http://localhost:${port}`
        : baseUrl;
      const dataDir = getStringFlag(flags, "data-dir");
      const detach = Boolean(flags.d || flags.detach);

      if (detach) {
        const pid = await spawnDetachedDaemon(targetUrl, { port, dataDir });
        stdout(`Daemon running at ${targetUrl} (pid=${pid ?? "detached"})`);
        return 0;
      }

      const proc = Bun.spawn(["bun", "run", resolveServerEntryPath()], {
        env: {
          ...process.env,
          PORT: String(port),
          ...(dataDir ? { SUPER_WORK_DATA_DIR: dataDir } : {}),
        },
        stdout: "inherit",
        stderr: "inherit",
        stdin: "inherit",
      });
      const exitCode = await proc.exited;
      return exitCode;
    }

    if (cmd === "status") {
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
        stdout(`Repo: ${repo.name} (${repo.id}) · mode=${repo.mode} · base=${repo.baseBranch}`);
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

    if (cmd === "dispatch") {
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
      const template = getStringFlag(flags, "template") as PipelineTemplateId | undefined;
      const preferredEngine = getStringFlag(flags, "engine") as WorkerEngineId | undefined;
      const budgetStr = getStringFlag(flags, "budget");
      const maxCostUsd = budgetStr ? Number(budgetStr) : undefined;
      const wait = Boolean(flags.wait);

      const { ticket } = await withAutoStart(
        baseUrl,
        autoStart,
        async () => {
          const repoId = await resolveTargetRepoId(client, getStringFlag(flags, "repo"));
          return client.createTicket({
            repoId,
            title,
            description,
            template,
            allowedPaths,
            preferredEngine,
            maxCostUsd: Number.isFinite(maxCostUsd) ? maxCostUsd : undefined,
          });
        },
        stdout,
      );

      if (!wait) {
        stdout(
          asJson
            ? JSON.stringify({ ticket }, null, 2)
            : `Dispatched ticket ${ticket.id} (${ticket.status}) -> ${ticket.title}`,
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

    if (cmd === "epic") {
      const title = positionals[1];
      if (!title) {
        stderr("Error: Epic title is required. Usage: super-work epic <title> -d <desc>");
        return 1;
      }
      const description = getStringFlag(flags, "d", "desc", "description") ?? title;
      const template = getStringFlag(flags, "template") as PipelineTemplateId | undefined;
      const preferredEngine = getStringFlag(flags, "engine") as WorkerEngineId | undefined;
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
          stdout(
            `  - [${sub.key}] (${sub.template}) deps=[${deps}] paths=[${sub.allowedPaths.join(", ")}] :: ${sub.title}`,
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

    if (cmd === "inbox") {
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

      stderr(`Unknown inbox subcommand: ${subCmd}`);
      return 1;
    }

    if (cmd === "logs") {
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
      for (const run of detail.stageRuns) {
        stdout(
          `  - ${run.stage} (${run.engine}) [${run.status}] $${run.costUsd.toFixed(4)}${run.summary ? ` :: ${run.summary.split("\n")[0]}` : ""}`,
        );
      }
      if (flags.f || flags.follow) {
        if (isFinalForWait(detail.ticket.status)) {
          return 0;
        }
        await waitForTicketCompletion(client, ticketId, stdout, options?.waitTimeoutMs);
      }
      return 0;
    }

    stderr(`Unknown command: ${cmd}`);
    printHelp(stdout);
    return 1;
  } catch (err) {
    stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}
