import type {
  ReasoningEffort,
  WorkerDriver,
  WorkerStreamEvent,
  WorkerTurnInput,
} from "@super-work/core";
import { nowIso } from "@super-work/core";
import { readLinesFromStream, truncateText } from "./stream-utils.ts";

export function formatOpenCodeModelArg(
  model?: string,
  effort?: ReasoningEffort,
): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) {
    // OpenCode rejects selecting a variant without an explicit provider/model
    return undefined;
  }
  if (effort && !trimmed.includes("#")) {
    return `${trimmed}#${effort}`;
  }
  return trimmed;
}

export function buildOpenCodeCliArgs(input: WorkerTurnInput): string[] {
  const args: string[] = ["run", "--format", "json", "--thinking"];
  const readOnly = input.stage === "plan" || input.stage === "review";
  args.push("--agent", readOnly ? "plan" : "build");

  if (!readOnly) {
    args.push("--auto");
  }

  const modelArg = formatOpenCodeModelArg(input.model, input.effort);
  if (modelArg) {
    args.push("--model", modelArg);
  }

  if (input.nativeSessionId) {
    args.push("--session", input.nativeSessionId);
  }

  return args;
}

export function parseOpenCodeStreamLine(
  line: string,
  state?: { sessionEmitted?: boolean },
): WorkerStreamEvent[] {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }

  const ts = nowIso();
  const events: WorkerStreamEvent[] = [];
  const type = String(obj.type ?? "");
  const sessionId =
    typeof obj.sessionID === "string" && obj.sessionID.trim()
      ? obj.sessionID.trim()
      : undefined;

  if (sessionId) {
    if (state) {
      if (!state.sessionEmitted) {
        state.sessionEmitted = true;
        events.push({ type: "session_started", nativeSessionId: sessionId, timestamp: ts });
      }
    } else if (type === "step_start") {
      events.push({ type: "session_started", nativeSessionId: sessionId, timestamp: ts });
    }
  }

  const part = (obj.part && typeof obj.part === "object" ? obj.part : {}) as Record<
    string,
    unknown
  >;

  if (type === "reasoning") {
    if (typeof part.text === "string" && part.text.trim()) {
      events.push({ type: "thought", text: truncateText(part.text, 600), timestamp: ts });
    }
    return events;
  }

  if (type === "text") {
    if (typeof part.text === "string") {
      events.push({ type: "text", text: part.text, timestamp: ts });
    }
    return events;
  }

  if (type === "tool_use") {
    const toolName = String(part.tool ?? "tool");
    const toolState = (
      part.state && typeof part.state === "object" ? part.state : {}
    ) as Record<string, unknown>;
    events.push({
      type: "tool_use",
      toolName,
      inputSummary: truncateText(JSON.stringify(toolState.input ?? {}), 240),
      timestamp: ts,
    });

    const isError = toolState.status === "error";
    const errObj =
      toolState.error && typeof toolState.error === "object"
        ? (toolState.error as Record<string, unknown>)
        : undefined;
    const rawOut = isError
      ? typeof toolState.error === "string"
        ? toolState.error
        : String(errObj?.message ?? "Tool failed")
      : String(toolState.output ?? "completed");

    events.push({
      type: "tool_result",
      toolName,
      isError,
      outputSummary: truncateText(rawOut, 300),
      timestamp: ts,
    });
    return events;
  }

  if (type === "step_finish") {
    const cost = typeof part.cost === "number" ? part.cost : 0;
    const tokens = (
      part.tokens && typeof part.tokens === "object" ? part.tokens : {}
    ) as { input?: number; output?: number };
    events.push({
      type: "usage",
      costUsd: cost,
      inputTokens: typeof tokens.input === "number" ? tokens.input : undefined,
      outputTokens: typeof tokens.output === "number" ? tokens.output : undefined,
      timestamp: ts,
    });
    return events;
  }

  if (type === "error") {
    const errField = obj.error;
    const msg =
      typeof errField === "string"
        ? errField
        : errField && typeof errField === "object"
          ? String((errField as Record<string, unknown>).message ?? "OpenCode execution failed")
          : String(obj.message ?? "OpenCode execution failed");
    events.push({
      type: "error",
      message: truncateText(msg, 500),
      fatal: true,
      timestamp: ts,
    });
  }

  return events;
}

export class OpenCodeDriver implements WorkerDriver {
  readonly engine = "opencode" as const;

  constructor(private readonly binary = "opencode") {}

  async isAvailable(): Promise<boolean> {
    return Boolean(Bun.which(this.binary));
  }

  async *runTurn(input: WorkerTurnInput, signal: AbortSignal): AsyncGenerator<WorkerStreamEvent> {
    const args = buildOpenCodeCliArgs(input);
    const proc = Bun.spawn([this.binary, ...args], {
      cwd: input.worktreePath,
      stdin: new TextEncoder().encode(input.prompt),
      stdout: "pipe",
      stderr: "pipe",
    });

    const onAbort = () => {
      try {
        proc.kill();
      } catch {
        // Ignore already exited
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const parseState = { sessionEmitted: false };
    let cumulativeCostUsd = 0;
    let lastText = "";
    let sawFatalError = false;
    const stderrPromise = new Response(proc.stderr).text();

    try {
      for await (const line of readLinesFromStream(proc.stdout)) {
        if (signal.aborted) break;
        const parsed = parseOpenCodeStreamLine(line, parseState);
        for (const ev of parsed) {
          if (ev.type === "usage") {
            cumulativeCostUsd = Number((cumulativeCostUsd + ev.costUsd).toFixed(6));
            yield { ...ev, costUsd: cumulativeCostUsd };
            continue;
          }
          if (ev.type === "text") {
            lastText = ev.text;
          }
          if (ev.type === "error" && ev.fatal) {
            sawFatalError = true;
          }
          yield ev;
        }
      }

      const [exitCode, stderrText] = await Promise.all([proc.exited, stderrPromise]);
      if (signal.aborted) return;

      if (exitCode !== 0 && !sawFatalError) {
        yield {
          type: "error",
          message: truncateText(stderrText.trim() || `opencode exited with code ${exitCode}`, 500),
          fatal: true,
          timestamp: nowIso(),
        };
      } else if (exitCode === 0 && !sawFatalError) {
        yield {
          type: "completed",
          summary: truncateText(lastText.trim() || "OpenCode turn completed", 1500),
          costUsd: cumulativeCostUsd,
          timestamp: nowIso(),
        };
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
