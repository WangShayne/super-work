#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type {
  CampaignDeliveryMode,
  CampaignDirection,
  DagNodeMutationInput,
  EnginePreference,
  PipelineTemplateId,
  RequirementRouteKind,
  StageKind,
  Ticket,
  WorkerEngineId,
} from "@super-work/core";
import { ServiceManager, assertSafeHostBinding } from "@super-work/drivers";
import { DaemonNotReachableError, SuperWorkHttpClient, type ParsedSseEvent } from "./client.ts";

export { SuperWorkHttpClient, DaemonNotReachableError } from "./client.ts";

export interface CliRunOptions {
  baseUrl?: string;
  token?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  waitTimeoutMs?: number;
  mcpInputLines?: AsyncIterable<string>;
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
    "depends-on",
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
    "token",
    "ticket",
    "timeout-ms",
    "winner",
    "cron",
    "every",
    "window",
    "routine",
    "candidate",
    "base",
    "mode",
    "prompt",
    "stage",
    "decision",
    "ids",
    "engines",
    "o",
    "out",
    "host",
    "metric",
    "regex",
    "unit",
    "direction",
    "target",
    "max-iter",
    "action",
    "lines",
    "reason",
    "delivery-mode",
    "title",
    "route",
    "gate-policy",
    "blueprint",
  ]);
  const optionalEngineFlags = new Set(["arena"]);
  const engineValues = new Set(["claude", "codex", "opencode", "gemini", "mock"]);

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
        } else if (
          optionalEngineFlags.has(key) &&
          next !== undefined &&
          engineValues.has(next.trim().toLowerCase())
        ) {
          flags[key] = next.trim().toLowerCase();
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

async function waitForHealth(
  baseUrl: string,
  timeoutMs = 10_000,
  token?: string,
): Promise<boolean> {
  const client = new SuperWorkHttpClient(baseUrl, token);
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

async function spawnDetachedDaemon(
  baseUrl: string,
  options?: { host?: string; port?: string; dataDir?: string; token?: string },
): Promise<number | undefined> {
  const parsedUrl = new URL(baseUrl);
  const port = options?.port ?? (parsedUrl.port || "4318");
  const serverEntry = resolveServerEntryPath();
  const proc = Bun.spawn(["bun", "run", serverEntry], {
    env: {
      ...process.env,
      HOST: options?.host ?? process.env.HOST ?? "127.0.0.1",
      PORT: String(port),
      ...(options?.dataDir ? { SUPER_WORK_DATA_DIR: options.dataDir } : {}),
      ...(options?.token ? { SUPER_WORK_TOKEN: options.token } : {}),
    },
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  proc.unref?.();
  const ready = await waitForHealth(baseUrl, 10_000, options?.token);
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
  token?: string,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DaemonNotReachableError && autoStart) {
      stdout(`Daemon offline at ${baseUrl}; starting background daemon...`);
      await spawnDetachedDaemon(baseUrl, { token });
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

function extractEventTicketId(data: Record<string, unknown>): string | undefined {
  return (
    (data.ticketId as string | undefined) ??
    ((data.ticket as { id?: string } | undefined)?.id) ??
    ((data.checkpoint as { ticketId?: string } | undefined)?.ticketId) ??
    ((data.item as { ticketId?: string } | undefined)?.ticketId) ??
    ((data.entry as { ticketId?: string } | undefined)?.ticketId) ??
    ((data.signal as { ticketId?: string } | undefined)?.ticketId)
  );
}

function formatEventLine(ev: ParsedSseEvent, watchedTicketId?: string): string {
  const data = ev.data;
  const evTicketId = extractEventTicketId(data);
  const childPrefix =
    watchedTicketId && evTicketId && evTicketId !== watchedTicketId ? `[${evTicketId}] ` : "";

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
    return `${childPrefix}[${engine}:${type}] ${detail}`.trim();
  }
  if (ev.event === "ticket_updated" || ev.event === "ticket_created") {
    const t = data.ticket as { id?: string; status?: string; currentStage?: string; title?: string } | undefined;
    return `${childPrefix}[${ev.event}] status=${t?.status ?? "?"} stage=${t?.currentStage ?? "?"}`;
  }
  if (ev.event === "stage_started" || ev.event === "stage_completed") {
    const run = data.stageRun as { stage?: string; engine?: string; status?: string; summary?: string } | undefined;
    return `${childPrefix}[${ev.event}] ${run?.stage ?? "?"} (${run?.engine ?? "?"}) status=${run?.status ?? "?"}${run?.summary ? `: ${run.summary.slice(0, 120)}` : ""}`;
  }
  if (ev.event === "verification_completed") {
    const res = data.result as { ok?: boolean; summary?: string } | undefined;
    return `${childPrefix}[verification] ${res?.ok ? "PASS" : "FAIL"}: ${res?.summary ?? ""}`;
  }
  if (ev.event === "playbook_updated") {
    const entry = data.entry as { id?: string; source?: string; rule?: string } | undefined;
    return entry
      ? `[playbook_updated] (${entry.source}) ${entry.rule ?? entry.id}`
      : `[playbook_updated] deleted=${String(data.deletedId ?? "")}`;
  }
  if (ev.event === "routine_run_updated") {
    const run = data.run as { routineId?: string; status?: string; summary?: string } | undefined;
    return `[routine_run] ${run?.routineId ?? "?"} status=${run?.status ?? "?"}${run?.summary ? `: ${run.summary.slice(0, 100)}` : ""}`;
  }
  if (ev.event === "epic_replanned") {
    const prop = data.proposal as { summary?: string } | undefined;
    return `[epic_replanned] epic=${String(data.epicId ?? "?")} auto=${String(Boolean(data.autoApplied))} :: ${prop?.summary ?? ""}`;
  }
  if (ev.event === "preview_updated") {
    const p = data.preview as { id?: string; ticketId?: string; status?: string; url?: string } | undefined;
    return `[preview_updated] ${p?.id ?? "?"} (${p?.ticketId ?? "?"}) status=${p?.status ?? "?"} ${p?.url ?? ""}`.trim();
  }
  if (ev.event === "campaign_updated") {
    const cmp = data.campaign as { id?: string; status?: string; currentValue?: number } | undefined;
    return cmp
      ? `[campaign] ${cmp.id ?? "?"} status=${cmp.status ?? "?"} value=${cmp.currentValue ?? "?"}`
      : `[campaign] deleted=${String(data.deletedId ?? "")}`;
  }
  if (ev.event === "merge_train_updated") {
    const entries = (data.entries as Array<{ id: string; status: string }> | undefined) ?? [];
    return `[merge_train] repo=${String(data.repoId ?? "?")} entries=${entries.length}`;
  }
  if (ev.event === "checkpoint_created") {
    const cp = data.checkpoint as
      | { id?: string; ticketId?: string; stage?: string; commitSha?: string; label?: string }
      | undefined;
    return `[checkpoint_created] ${cp?.id ?? "?"} ticket=${cp?.ticketId ?? "?"} stage=${cp?.stage ?? "?"} sha=${cp?.commitSha?.slice(0, 8) ?? "?"} :: ${cp?.label ?? ""}`.trim();
  }
  return `${childPrefix}[${ev.event}] ${JSON.stringify(data).slice(0, 140)}`;
}

function formatTranscriptLines(rawJsonl: string, limit = 40): string[] {
  const lines = rawJsonl
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      const ev = JSON.parse(line) as Record<string, unknown>;
      const type = String(ev.type ?? "event");
      if (type === "thought") {
        out.push(`    [thought] ${String(ev.text ?? "").slice(0, 120)}`);
      } else if (type === "tool_use") {
        out.push(`    [tool_use] ${String(ev.toolName ?? "tool")}(${String(ev.inputSummary ?? "").slice(0, 80)})`);
      } else if (type === "tool_result") {
        out.push(
          `    [tool_result] ${String(ev.toolName ?? "tool")} ${ev.isError ? "ERR" : "ok"}: ${String(ev.outputSummary ?? "").slice(0, 90)}`,
        );
      } else if (type === "text") {
        out.push(`    [text] ${String(ev.text ?? "").slice(0, 140)}`);
      } else if (type === "completed") {
        out.push(`    [completed] ${String(ev.summary ?? "").slice(0, 140)}`);
      } else if (type === "error") {
        out.push(`    [error] ${String(ev.message ?? "").slice(0, 140)}`);
      }
    } catch {
      // Ignore malformed transcript line
    }
  }
  return out;
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
    .streamEvents(
      (ev) => {
        if (ev.event === "ping" || ev.event === "connected") return;
        const evTicketId = extractEventTicketId(ev.data);
        stdout(formatEventLine(ev, ticketId));
        if (ev.event === "ticket_updated" && evTicketId === ticketId) {
          const updated = ev.data.ticket as Ticket | undefined;
          if (updated && isFinalForWait(updated.status)) {
            latestTicket = updated;
            ac.abort("terminal");
          }
        }
      },
      ac.signal,
      { ticketId, reconnect: true, reconnectDelayMs: 500 },
    )
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
  stdout(`super-work v1.3.0 CLI

Usage:
  super-work up [-d|--detach] [--host 127.0.0.1] [--port 4318] [--data-dir path] [--token <token>]
  super-work service [install [--no-start] | uninstall | start | stop | status | logs [--lines 80]] [--host <addr>] [--port <n>] [--data-dir <path>] [--token <token>] [--json]
  super-work reload [--force] [--skip-canary] [--auto-start] [--json]
  super-work mcp [--url http://localhost:4318] [--token <token>] [--no-auto-start]
  super-work status [--repo <id>] [--auto-start] [--json]
  super-work intake <requirement> [--title <title>] [--repo <id>] [--route auto|single_ticket|epic_dag|goal_campaign]
                    [--template fast|standard|strict] [--engine auto|claude|codex|opencode|gemini|mock] [--tdd]
                    [--gate-policy always_auto|risk_gated|always_signoff] [--budget <usd>]
                    [--metric <cmd> --target <num> [--direction increase|decrease] [--unit <u>]]
                    [--preview-only] [--wait] [--timeout-ms <ms>] [--auto-start] [--json]
  super-work wait <ticketOrEpicId> [--timeout-ms <ms>] [--auto-start] [--json]
  super-work ask <question> [--repo <id>] [--auto-start] [--json]
  super-work steer <ticketId> <instruction> [--engine auto|claude|codex|opencode|gemini|mock] [--auto-start] [--json]
  super-work dispatch <title> [-d|--desc <text>] [--repo <id>] [--blueprint <id>] [--gate-policy <policy>] [--paths <csv>] [--depends-on <csv>]
                      [--template fast|standard|strict] [--engine auto|claude|codex|opencode|gemini|mock]
                      [--tdd] [--pause-before-run] [--arena [engine]] [--clarify] [--clarify-only]
                      [--budget <usd>] [--wait] [--auto-start] [--json]
  super-work epic <title> [-d|--desc <text>] [--repo <id>] [--template fast|standard|strict] [--tdd]
                  [--engine auto|...] [--preview-only] [--per-subtask] [--wait] [--auto-start] [--json]
  super-work campaign [list | get <id> | create <name> -d <prompt> --metric <cmd> --target <num> [--direction increase|decrease] [--unit <u>] [--regex <re>] [--delivery-mode staging_branch|per_wave_merge] [--max-iter 5] [--budget 5] [--paths <csv>] [--start] | start <id> [-m <note>] | pause <id> [-m <reason>] | deliver <id> [--action local_merge|push_and_create_pr] | delete <id>] [--repo <id>] [--auto-start] [--json]
  super-work train [list | flush | eject <entryId> [-m <reason>]] [--repo <id>] [--auto-start] [--json]
  super-work blueprints [--repo <id>] [--auto-start] [--json]
  super-work doctor [--fix] [--auto-start] [--json]
  super-work backup [list | create | restore <backupId> [--force]] [--auto-start] [--json]
  super-work bundle [export <repoId> [-o <path>] | import <repoId> <path>] [--auto-start] [--json]
  super-work eval [list [--repo <id>] | save <ticketId> | run <evalCaseId> [--engines <csv>] [--budget <usd>] | runs [--repo <id>]] [--auto-start] [--json]
  super-work impact [--repo <id>] [--paths <csv>] [--auto-start] [--json]
  super-work checkpoint [list <ticketId> | diff <ticketId> <cpId> [--base <cpId>] |
                         restore <ticketId> <cpId> [--mode in_place|fork] [-m <prompt>] [--stage <stage>] [--engine <eng>]]
  super-work dag [pause <ticketId> | resume <ticketId> | rerun <ticketId> |
                  set <ticketId> [--engine auto|...] [--paths <csv>] [--depends-on <csv>] [-d <desc>] [--tdd|--no-tdd] [--breakpoint]]
  super-work inbox [list | approve <id> [--expand-mandate] [--local-merge] [--budget-add <usd>] [--winner <candId>] [-m <note>] | reject <id> [-m <note>] |
                    batch --decision <approved|rejected> [--repo <id>] [--low-risk] [--ids <csv>] [-m <note>]]
  super-work preview [list | start <ticketId> [--candidate <candId>] | stop <previewId>] [--repo <id>] [--json]
  super-work routine [list | add <name> -d <prompt> [--cron <expr> | --every <min>] [--window HH:MM-HH:MM] [--paths <csv>] [--budget <usd>] | run <id> | toggle <id> | runs [--routine <id>] | delete <id>]
  super-work casebook [list | search <query>] [--repo <id>] [--auto-start] [--json]
  super-work playbook [list | add <rule> [--paths <csv>] [--pin] | toggle <entryId> | delete <entryId> | prune | sync [--export]] [--repo <id>] [--auto-start] [--json]
  super-work logs <ticketId> [-f|--follow] [--auto-start] [--json]
  super-work watch [--repo <id>] [--ticket <id>] [--timeout-ms <ms>] [--auto-start] [--json]
  super-work revert <ticketId> [--auto-start] [--json]

Env / Flags:
  SUPER_WORK_URL     Daemon base URL (default: http://localhost:4318) or --url
  SUPER_WORK_TOKEN   Optional Bearer token for remote access or --token`);
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
  const token =
    options?.token ??
    getStringFlag(flags, "token") ??
    (process.env.SUPER_WORK_TOKEN?.trim() || undefined);
  const autoStart = Boolean(flags["auto-start"]);
  const asJson = Boolean(flags.json);
  const client = new SuperWorkHttpClient(baseUrl, token);

  try {
    if (cmd === "up") {
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

    if (cmd === "service") {
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

    if (cmd === "mcp") {
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

    if (cmd === "epic") {
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

    if (cmd === "watch") {
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

    if (cmd === "revert") {
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

    if (cmd === "playbook") {
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

      if (subCmd === "prune") {
        const res = await withAutoStart(
          baseUrl,
          autoStart,
          async () => {
            const repoId = await resolveTargetRepoId(client, getStringFlag(flags, "repo"));
            return client.prunePlaybook(repoId);
          },
          stdout,
        );
        stdout(
          asJson
            ? JSON.stringify(res, null, 2)
            : `Pruned ${res.prunedIds.length} stale/suspect auto-healed rule(s); ${res.keptCount} rule(s) kept.`,
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

    if (cmd === "routine") {
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

    if (cmd === "casebook") {
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

    if (cmd === "preview") {
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

    if (cmd === "impact") {
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

    if (cmd === "checkpoint") {
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

    if (cmd === "dag") {
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

    if (cmd === "blueprints") {
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

    if (cmd === "doctor") {
      const fix = Boolean(flags.fix);
      const report = await withAutoStart(
        baseUrl,
        autoStart,
        () => client.runDoctor(fix),
        stdout,
      );
      if (asJson) {
        stdout(JSON.stringify(report, null, 2));
      } else {
        stdout(
          `System Doctor: healthy=${report.healthy} fixesApplied=${report.fixesApplied} checkedAt=${report.checkedAt}`,
        );
        for (const item of report.items) {
          stdout(`  [${item.status.toUpperCase()}] (${item.category}) ${item.title}: ${item.detail}`);
        }
      }
      return 0;
    }

    if (cmd === "backup") {
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

    if (cmd === "steer") {
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

    if (cmd === "ask") {
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

    if (cmd === "eval") {
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

    if (cmd === "bundle") {
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

    if (cmd === "campaign") {
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

    if (cmd === "train") {
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

    if (cmd === "intake") {
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

    if (cmd === "wait") {
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

    if (cmd === "reload") {
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
