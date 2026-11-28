import { randomUUID } from "node:crypto";
import type {
  ApiWorkerPreset,
  ApiWorkerProfile,
  WorkerDriver,
  WorkerEngineId,
  WorkerStreamEvent,
  WorkerTurnInput,
} from "@super-work/core";
import { nowIso } from "@super-work/core";
import {
  API_WORKER_MAX_ITERATIONS,
  type ApiToolContext,
  executeApiTool,
  toolsForStage,
} from "./api-worker-tools.ts";
import {
  ApiRequestError,
  createProtocolSession,
  isApiConfigUsable,
  type ModelReply,
  pingApi,
  type ResolvedApiConfig,
  redactSecret,
  type ToolOutcome,
} from "./api-worker-protocols.ts";
import { truncateText } from "./stream-utils.ts";

export type ApiWorkerConfigProvider = () => Promise<ApiWorkerProfile | undefined> | ApiWorkerProfile | undefined;

/** Rough USD per 1M tokens (input, output). Estimates only: used for budget guarding, not billing. */
function pricePerMillion(model: string): [number, number] {
  const m = model.toLowerCase();
  if (m.includes("deepseek")) return [0.3, 1.2];
  if (/(mini|haiku|flash|nano)/.test(m)) return [0.5, 2];
  if (/(opus|gpt-5|o1|o3)/.test(m)) return [10, 40];
  return [3, 15];
}

export function estimateApiCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const [inP, outP] = pricePerMillion(model);
  return Number(((inputTokens * inP + outputTokens * outP) / 1_000_000).toFixed(6));
}

function systemPromptFor(input: WorkerTurnInput): string {
  const base =
    "You are an autonomous software engineering agent operating inside an isolated git worktree. " +
    "Use the provided tools to inspect the repository; paths are relative to the worktree root. " +
    "When you are finished, reply with a final plain-text summary and NO tool calls. " +
    "Never run git commit, git push or open pull requests: delivery is handled by the host.";
  if (input.stage === "plan") return `${base} This is a read-only planning stage: do not modify files; output the full plan as text.`;
  if (input.stage === "review") return `${base} This is a read-only review stage: inspect the diff and report findings and a verdict as text.`;
  return base;
}

/** Merges the saved profile with per-turn overrides carried on WorkerTurnInput. */
function resolveConfig(profile: ApiWorkerProfile | undefined, input?: Partial<WorkerTurnInput>): ResolvedApiConfig {
  const apiKey = input?.apiKey?.trim() || profile?.apiKey?.trim();
  return {
    preset: input?.apiPreset ?? profile?.preset ?? "custom",
    baseUrl: input?.baseUrl?.trim() || profile?.baseUrl?.trim() || "",
    model: input?.model?.trim() || profile?.model?.trim() || "",
    ...(apiKey ? { apiKey } : {}),
  };
}

export class ApiWorkerDriver implements WorkerDriver {
  readonly engine = "api" as const;

  constructor(private readonly getProfile: ApiWorkerConfigProvider = () => undefined) {}

  async isAvailable(): Promise<boolean> {
    try {
      return isApiConfigUsable(await this.getProfile());
    } catch {
      return false;
    }
  }

  async *runTurn(input: WorkerTurnInput, signal: AbortSignal): AsyncGenerator<WorkerStreamEvent> {
    const cfg = resolveConfig(await this.getProfile(), input);
    if (!isApiConfigUsable(cfg)) {
      yield {
        type: "error",
        message: "API worker is not configured: baseUrl, model and apiKey are required (apiKey optional for localhost)",
        fatal: true,
        timestamp: nowIso(),
      };
      return;
    }

    yield { type: "session_started", nativeSessionId: input.nativeSessionId ?? `api-${randomUUID()}`, timestamp: nowIso() };

    const tools = toolsForStage(input.stage);
    const toolCtx: ApiToolContext = {
      worktreePath: input.worktreePath,
      stage: input.stage,
      readOnlyPaths: input.readOnlyPaths,
      sandboxMode: input.sandboxMode,
      rootRepoPath: input.rootRepoPath,
      forbiddenPaths: input.mandate.forbiddenPaths,
      signal,
    };
    const session = createProtocolSession(cfg, systemPromptFor(input), input.prompt, tools);
    const maxCost = input.mandate.maxCostUsd;
    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let lastText = "";

    for (let iteration = 1; iteration <= API_WORKER_MAX_ITERATIONS; iteration++) {
      if (signal.aborted) return;
      let reply: ModelReply;
      try {
        reply = await session.send(signal);
      } catch (err) {
        if (signal.aborted) return;
        const msg = redactSecret(err instanceof ApiRequestError ? err.message : String(err), cfg.apiKey);
        yield { type: "error", message: truncateText(msg, 500), fatal: true, timestamp: nowIso() };
        return;
      }

      inputTokens += reply.inputTokens;
      outputTokens += reply.outputTokens;
      costUsd = estimateApiCostUsd(cfg.model, inputTokens, outputTokens);
      if (reply.thinking) yield { type: "thought", text: truncateText(reply.thinking, 2000), timestamp: nowIso() };
      if (reply.text) {
        lastText = reply.text;
        yield { type: "text", text: reply.text, timestamp: nowIso() };
      }
      yield { type: "usage", costUsd, inputTokens, outputTokens, timestamp: nowIso() };

      if (reply.toolCalls.length === 0) {
        yield { type: "completed", summary: truncateText(lastText || "Completed", 1500), costUsd, timestamp: nowIso() };
        return;
      }
      if (maxCost > 0 && costUsd > maxCost) {
        yield {
          type: "error",
          message: `API worker stopped: estimated cost $${costUsd.toFixed(4)} exceeded mandate budget $${maxCost}`,
          fatal: true,
          timestamp: nowIso(),
        };
        return;
      }

      const outcomes: ToolOutcome[] = [];
      for (const call of reply.toolCalls) {
        if (signal.aborted) return;
        yield {
          type: "tool_use",
          toolName: call.name,
          inputSummary: truncateText(JSON.stringify(call.args ?? {}), 300),
          timestamp: nowIso(),
        };
        const result = call.argsError
          ? { isError: true, output: call.argsError }
          : await executeApiTool(call.name, call.args, toolCtx);
        outcomes.push({ id: call.id, name: call.name, ...result });
        yield {
          type: "tool_result",
          toolName: call.name,
          isError: result.isError,
          outputSummary: truncateText(result.output, 300),
          timestamp: nowIso(),
        };
      }
      session.addToolResults(outcomes);
    }

    yield {
      type: "completed",
      summary: truncateText(
        `[iteration limit ${API_WORKER_MAX_ITERATIONS} reached] ${lastText || "Stopped before producing a final summary"}`,
        1500,
      ),
      costUsd,
      timestamp: nowIso(),
    };
  }
}

export interface TestWorkerConnectionInput {
  engine: WorkerEngineId;
  preset?: ApiWorkerPreset;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

export interface TestWorkerConnectionResult {
  ok: boolean;
  latencyMs: number;
  message: string;
}

const CLI_BINARIES: Partial<Record<WorkerEngineId, string>> = {
  claude: "claude",
  codex: "codex",
  opencode: "opencode",
  gemini: "gemini",
};

/**
 * Connectivity test. `api`: sends a `max_tokens: 16` ping through the configured protocol.
 * CLI engines: checks the binary is installed and the relay baseUrl is well-formed and reachable
 * (the relay key itself is not validated, since each CLI speaks its own protocol).
 */
export async function testWorkerConnection(input: TestWorkerConnectionInput): Promise<TestWorkerConnectionResult> {
  const started = Date.now();
  const done = (ok: boolean, message: string): TestWorkerConnectionResult => ({
    ok,
    latencyMs: Date.now() - started,
    message: redactSecret(message, input.apiKey),
  });
  const baseUrl = input.baseUrl?.trim();

  if (input.engine === "api") {
    const cfg = resolveConfig(undefined, { ...input, model: input.model, apiPreset: input.preset });
    if (!cfg.baseUrl) return done(false, "baseUrl is required");
    if (!cfg.model) return done(false, "model is required");
    try {
      new URL(cfg.baseUrl);
    } catch {
      return done(false, "baseUrl is not a valid URL");
    }
    if (!isApiConfigUsable(cfg)) return done(false, "apiKey is required for non-local endpoints");
    try {
      await pingApi(cfg, new AbortController().signal);
      return done(true, `Connected to ${new URL(cfg.baseUrl).host} (${cfg.preset}, model ${cfg.model})`);
    } catch (err) {
      return done(false, err instanceof Error ? err.message : String(err));
    }
  }

  const binary = CLI_BINARIES[input.engine];
  if (!binary) return done(false, `Engine '${input.engine}' does not support connection tests`);
  const resolved = Bun.which(binary);
  if (!resolved) return done(false, `${binary} CLI not found in PATH`);
  if (!baseUrl) {
    return done(true, `${binary} CLI found at ${resolved}${input.apiKey ? "; custom key set (not validated)" : "; using the CLI's own auth"}`);
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("bad protocol");
  } catch {
    return done(false, "baseUrl must be a valid http(s) URL");
  }
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(8000) });
    await res.body?.cancel().catch(() => undefined);
    return done(true, `${binary} CLI found; relay ${url.host} reachable (HTTP ${res.status}; credentials not validated)`);
  } catch (err) {
    return done(false, `${binary} CLI found, but relay ${url.host} is unreachable: ${(err as Error).message}`);
  }
}
