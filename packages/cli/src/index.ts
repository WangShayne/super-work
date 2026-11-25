#!/usr/bin/env bun
import { SuperWorkHttpClient } from "./client.ts";
import { printHelp } from "./commands/cli-formatters.ts";
import type { CliRunOptions, CommandHandler, ParsedArgs } from "./commands/context.ts";
import { dispatchCommands } from "./commands/dispatch-commands.ts";
import { knowledgeCommands } from "./commands/knowledge-commands.ts";
import { milestoneCommands } from "./commands/milestone-commands.ts";
import { reviewCommands } from "./commands/review-commands.ts";
import { routineCommands } from "./commands/routine-commands.ts";
import { getStringFlag } from "./commands/shared.ts";
import { systemCommands } from "./commands/system-commands.ts";

export { SuperWorkHttpClient, DaemonNotReachableError } from "./client.ts";
export type { CliRunOptions } from "./commands/context.ts";

const COMMAND_HANDLERS: Record<string, CommandHandler> = {
  ...systemCommands,
  ...dispatchCommands,
  ...milestoneCommands,
  ...reviewCommands,
  ...knowledgeCommands,
  ...routineCommands,
};

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
    "integration",
    "message",
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
    const handler = Object.hasOwn(COMMAND_HANDLERS, cmd) ? COMMAND_HANDLERS[cmd] : undefined;
    if (handler) {
      return await handler({
        cmd,
        positionals,
        flags,
        options,
        baseUrl,
        token,
        autoStart,
        asJson,
        client,
        stdout,
        stderr,
      });
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
