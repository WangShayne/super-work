import type { WorkerDriver, WorkerStreamEvent, WorkerTurnInput } from "@super-work/core";
import { nowIso } from "@super-work/core";
import { wrapCommandWithOsSandbox } from "../sandbox/os-sandbox.ts";
import { relayExtraEnv } from "./relay-env.ts";
import { readLinesFromStream, truncateText } from "./stream-utils.ts";

export interface GeminiStreamParseState {
  assistantDeltaBuffer: string;
  fullAssistantText: string;
  toolNamesById: Map<string, string>;
  sessionEmitted: boolean;
}

export function createGeminiParseState(): GeminiStreamParseState {
  return {
    assistantDeltaBuffer: "",
    fullAssistantText: "",
    toolNamesById: new Map<string, string>(),
    sessionEmitted: false,
  };
}

export function buildGeminiCliArgs(input: WorkerTurnInput): string[] {
  const readOnly = input.stage === "plan" || input.stage === "review";
  const args: string[] = [
    "-p",
    input.prompt,
    "-o",
    "stream-json",
    "--skip-trust",
    "--approval-mode",
    readOnly ? "plan" : "yolo",
  ];

  if (input.model?.trim()) {
    args.push("-m", input.model.trim());
  }

  if (input.nativeSessionId?.trim()) {
    args.push("-r", input.nativeSessionId.trim());
  }

  return args;
}

function flushBufferedText(
  state: GeminiStreamParseState | undefined,
  events: WorkerStreamEvent[],
  ts: string,
): void {
  if (!state || !state.assistantDeltaBuffer) return;
  const text = state.assistantDeltaBuffer;
  state.assistantDeltaBuffer = "";
  events.push({ type: "text", text, timestamp: ts });
}

export function parseGeminiStreamLine(
  line: string,
  state?: GeminiStreamParseState,
): WorkerStreamEvent[] {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }

  const ts = typeof obj.timestamp === "string" && obj.timestamp.trim() ? obj.timestamp : nowIso();
  const events: WorkerStreamEvent[] = [];
  const type = String(obj.type ?? "");

  if (type === "init" && typeof obj.session_id === "string" && obj.session_id.trim()) {
    if (!state || !state.sessionEmitted) {
      if (state) state.sessionEmitted = true;
      events.push({
        type: "session_started",
        nativeSessionId: obj.session_id.trim(),
        timestamp: ts,
      });
    }
    return events;
  }

  if (type === "message") {
    const role = String(obj.role ?? "");
    const content = typeof obj.content === "string" ? obj.content : "";
    if (role === "assistant" && content) {
      if (obj.delta === true && state) {
        state.assistantDeltaBuffer += content;
        state.fullAssistantText += content;
      } else {
        if (state) {
          flushBufferedText(state, events, ts);
          state.fullAssistantText = state.fullAssistantText
            ? `${state.fullAssistantText}\n${content}`
            : content;
        }
        events.push({ type: "text", text: content, timestamp: ts });
      }
    }
    return events;
  }

  if (type === "tool_use") {
    flushBufferedText(state, events, ts);
    const toolName = String(obj.tool_name ?? "tool");
    const toolId = typeof obj.tool_id === "string" ? obj.tool_id : "";
    if (state && toolId) {
      state.toolNamesById.set(toolId, toolName);
    }
    events.push({
      type: "tool_use",
      toolName,
      inputSummary: truncateText(JSON.stringify(obj.parameters ?? {}), 240),
      timestamp: ts,
    });
    return events;
  }

  if (type === "tool_result") {
    flushBufferedText(state, events, ts);
    const toolId = typeof obj.tool_id === "string" ? obj.tool_id : "";
    const toolName = (toolId && state?.toolNamesById.get(toolId)) || toolId || "tool";
    const isError = obj.status === "error";
    const errObj =
      obj.error && typeof obj.error === "object"
        ? (obj.error as Record<string, unknown>)
        : undefined;
    const rawOut = isError
      ? String(errObj?.message ?? obj.output ?? "Gemini tool error")
      : typeof obj.output === "string"
        ? obj.output
        : JSON.stringify(obj.output ?? "ok");
    events.push({
      type: "tool_result",
      toolName,
      isError,
      outputSummary: truncateText(rawOut, 300),
      timestamp: ts,
    });
    return events;
  }

  if (type === "error") {
    flushBufferedText(state, events, ts);
    const severity = String(obj.severity ?? "error").toLowerCase();
    const message = String(obj.message ?? "Gemini CLI execution error");
    if (severity === "warning") {
      events.push({
        type: "thought",
        text: truncateText(message, 400),
        timestamp: ts,
      });
    } else {
      events.push({
        type: "error",
        message: truncateText(message, 500),
        fatal: true,
        timestamp: ts,
      });
    }
    return events;
  }

  if (type === "result") {
    flushBufferedText(state, events, ts);
    const stats = (
      obj.stats && typeof obj.stats === "object" ? obj.stats : {}
    ) as {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    };
    const inputTokens = typeof stats.input_tokens === "number" ? stats.input_tokens : 0;
    const outputTokens = typeof stats.output_tokens === "number" ? stats.output_tokens : 0;
    const estCost = Number(((inputTokens * 1.25 + outputTokens * 5.0) / 1_000_000).toFixed(4));
    if (inputTokens > 0 || outputTokens > 0) {
      events.push({
        type: "usage",
        costUsd: estCost,
        inputTokens,
        outputTokens,
        timestamp: ts,
      });
    }

    if (obj.status === "error") {
      const errObj =
        obj.error && typeof obj.error === "object"
          ? (obj.error as Record<string, unknown>)
          : undefined;
      events.push({
        type: "error",
        message: truncateText(
          String(errObj?.message ?? obj.message ?? "Gemini CLI turn failed"),
          500,
        ),
        fatal: true,
        timestamp: ts,
      });
    } else {
      const rawResponse = typeof obj.response === "string" ? obj.response : "";
      const summarySource = (state?.fullAssistantText || rawResponse).trim();
      events.push({
        type: "completed",
        summary: truncateText(summarySource || "Gemini CLI turn completed", 1500),
        costUsd: estCost,
        timestamp: ts,
      });
    }
  }

  return events;
}

export class GeminiCliDriver implements WorkerDriver {
  readonly engine = "gemini" as const;

  constructor(private readonly binaryPath = "gemini") {}

  async isAvailable(): Promise<boolean> {
    return Boolean(Bun.which(this.binaryPath));
  }

  async *runTurn(input: WorkerTurnInput, signal: AbortSignal): AsyncGenerator<WorkerStreamEvent> {
    const args = buildGeminiCliArgs(input);
    const wrapped = wrapCommandWithOsSandbox({
      commandArgv: [this.binaryPath, ...args],
      worktreePath: input.worktreePath,
      rootRepoPath: input.rootRepoPath,
      mode: input.sandboxMode ?? "balanced",
      forbiddenPaths: input.mandate.forbiddenPaths,
      readOnlyPaths: input.readOnlyPaths,
      allowNetwork: (input.sandboxMode ?? "balanced") === "strict" ? false : true,
      engine: "gemini",
      ...relayExtraEnv("gemini", input),
    });
    const proc = Bun.spawn(wrapped.argv, {
      cwd: input.worktreePath,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: wrapped.env,
    });

    const onAbort = () => {
      try {
        proc.kill();
      } catch {
        // Ignore already exited
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const parseState = createGeminiParseState();
    let sawCompletion = false;
    const stderrPromise = new Response(proc.stderr).text();

    try {
      for await (const line of readLinesFromStream(proc.stdout)) {
        if (signal.aborted) break;
        const parsed = parseGeminiStreamLine(line, parseState);
        for (const ev of parsed) {
          if (ev.type === "completed" || ev.type === "error") {
            sawCompletion = true;
          }
          yield ev;
        }
      }

      if (!signal.aborted && parseState.assistantDeltaBuffer) {
        const trailing: WorkerStreamEvent[] = [];
        flushBufferedText(parseState, trailing, nowIso());
        for (const ev of trailing) {
          yield ev;
        }
      }

      const [exitCode, stderrText] = await Promise.all([proc.exited, stderrPromise]);
      if (!signal.aborted && !sawCompletion) {
        if (exitCode !== 0) {
          yield {
            type: "error",
            message: truncateText(stderrText.trim() || `gemini exited with code ${exitCode}`, 500),
            fatal: true,
            timestamp: nowIso(),
          };
        } else if (parseState.fullAssistantText.trim()) {
          yield {
            type: "completed",
            summary: truncateText(parseState.fullAssistantText.trim(), 1500),
            timestamp: nowIso(),
          };
        }
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
