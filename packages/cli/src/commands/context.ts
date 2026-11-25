import type { SuperWorkHttpClient } from "../client.ts";

export interface CliRunOptions {
  baseUrl?: string;
  token?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  waitTimeoutMs?: number;
  mcpInputLines?: AsyncIterable<string>;
}

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export type CliFlags = ParsedArgs["flags"];

/** Shared state handed explicitly to every command handler. */
export interface CommandContext {
  cmd: string;
  positionals: string[];
  flags: CliFlags;
  options: CliRunOptions | undefined;
  baseUrl: string;
  token: string | undefined;
  autoStart: boolean;
  asJson: boolean;
  client: SuperWorkHttpClient;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export type CommandHandler = (ctx: CommandContext) => Promise<number>;
