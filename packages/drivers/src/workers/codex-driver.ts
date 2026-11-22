import type { WorkerDriver, WorkerStreamEvent, WorkerTurnInput } from "@super-work/core";
import { nowIso } from "@super-work/core";
import { readLinesFromStream, truncateText } from "./stream-utils.ts";

export function buildCodexCliArgs(input: WorkerTurnInput): string[] {
  if (input.nativeSessionId) {
    // codex exec resume does NOT accept -s or -C; cwd is passed to Bun.spawn
    return ["exec", "resume", "--json", input.nativeSessionId, input.prompt];
  }

  const readOnly = input.stage === "plan" || input.stage === "review";
  const sandboxMode = readOnly ? "read-only" : "workspace-write";
  return [
    "exec",
    "--json",
    "-s",
    sandboxMode,
    "--approve-for-me",
    input.prompt,
  ];
}

export function parseCodexStreamLine(line: string): WorkerStreamEvent[] {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }

  const ts = nowIso();
  const events: WorkerStreamEvent[] = [];
  const type = String(obj.type ?? "");

  if (type === "thread.started" && typeof obj.thread_id === "string") {
    events.push({ type: "session_started", nativeSessionId: obj.thread_id, timestamp: ts });
    return events;
  }

  if (type === "item.completed" && obj.item && typeof obj.item === "object") {
    const item = obj.item as Record<string, unknown>;
    const itemType = String(item.type ?? "");

    if (itemType === "reasoning" && typeof item.text === "string") {
      events.push({ type: "thought", text: truncateText(item.text, 600), timestamp: ts });
    } else if (itemType === "agent_message" && typeof item.text === "string") {
      events.push({ type: "text", text: item.text, timestamp: ts });
    } else if (itemType === "command_execution") {
      const cmd = String(item.command ?? "shell");
      const exitCode = typeof item.exit_code === "number" ? item.exit_code : 0;
      const out = String(item.aggregated_output ?? "");
      events.push({
        type: "tool_use",
        toolName: "Bash",
        inputSummary: truncateText(cmd, 200),
        timestamp: ts,
      });
      events.push({
        type: "tool_result",
        toolName: "Bash",
        isError: exitCode !== 0,
        outputSummary: truncateText(out || `exit_code=${exitCode}`, 300),
        timestamp: ts,
      });
    } else if (itemType === "file_change") {
      events.push({
        type: "tool_use",
        toolName: "Edit",
        inputSummary: truncateText(JSON.stringify(item.changes ?? item), 200),
        timestamp: ts,
      });
      events.push({
        type: "tool_result",
        toolName: "Edit",
        isError: false,
        outputSummary: "File changes applied",
        timestamp: ts,
      });
    }
    return events;
  }

  if (type === "turn.completed") {
    const usage = (obj.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
    const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
    const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
    const estCost = Number(((inputTokens * 2 + outputTokens * 8) / 1_000_000).toFixed(4));
    events.push({
      type: "usage",
      costUsd: estCost,
      inputTokens,
      outputTokens,
      timestamp: ts,
    });
    events.push({
      type: "completed",
      summary: typeof obj.summary === "string" ? obj.summary : "Codex turn completed",
      costUsd: estCost,
      timestamp: ts,
    });
    return events;
  }

  if (type === "error" || type === "turn.failed") {
    const msg =
      typeof obj.message === "string"
        ? obj.message
        : obj.error && typeof obj.error === "object"
          ? String((obj.error as Record<string, unknown>).message ?? "Codex turn failed")
          : "Codex turn failed";
    events.push({ type: "error", message: truncateText(msg, 500), fatal: true, timestamp: ts });
  }

  return events;
}

export class CodexDriver implements WorkerDriver {
  readonly engine = "codex" as const;

  constructor(private readonly binaryPath = "codex") {}

  async isAvailable(): Promise<boolean> {
    return Boolean(Bun.which(this.binaryPath));
  }

  async *runTurn(input: WorkerTurnInput, signal: AbortSignal): AsyncGenerator<WorkerStreamEvent> {
    const args = buildCodexCliArgs(input);
    const proc = Bun.spawn([this.binaryPath, ...args], {
      cwd: input.worktreePath,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });

    const onAbort = () => {
      try {
        proc.kill();
      } catch {
        // Ignore already exited
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });

    let sawCompletion = false;
    let lastAgentText = "";
    const stderrPromise = new Response(proc.stderr).text();

    try {
      for await (const line of readLinesFromStream(proc.stdout)) {
        if (signal.aborted) break;
        const parsed = parseCodexStreamLine(line);
        for (const ev of parsed) {
          if (ev.type === "text") {
            lastAgentText = ev.text;
          }
          if (ev.type === "completed") {
            sawCompletion = true;
            yield {
              ...ev,
              summary: lastAgentText ? truncateText(lastAgentText, 1500) : ev.summary,
            };
            continue;
          }
          if (ev.type === "error") {
            sawCompletion = true;
          }
          yield ev;
        }
      }

      const [exitCode, stderrText] = await Promise.all([proc.exited, stderrPromise]);
      if (!signal.aborted && !sawCompletion && exitCode !== 0) {
        yield {
          type: "error",
          message: truncateText(stderrText || `codex exited with code ${exitCode}`, 500),
          fatal: true,
          timestamp: nowIso(),
        };
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
