import type { WorkerDriver, WorkerStreamEvent, WorkerTurnInput } from "@super-work/core";
import { nowIso } from "@super-work/core";
import { createSanitizedClaudeEnv } from "../llm/control-plane-llm.ts";
import { wrapCommandWithOsSandbox } from "../sandbox/os-sandbox.ts";
import { readLinesFromStream, truncateText } from "./stream-utils.ts";

export function buildClaudeCliArgs(input: WorkerTurnInput): string[] {
  const args: string[] = [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--permission-prompts",
    "none",
  ];

  if (input.stage === "plan") {
    args.push("--permission-mode", "plan", "--tools", "Read,Glob,Grep");
  } else if (input.stage === "review") {
    args.push(
      "--permission-mode",
      "acceptEdits",
      "--tools",
      "Read,Glob,Grep,Bash",
      "--allowedTools",
      "Read,Glob,Grep,Bash(git diff*),Bash(git status*),Bash(git log*),Bash(git show*),Bash(bun test*),Bash(bun run typecheck*),Bash(bun run build*),Bash(npm test*),Bash(npm run *),Bash(pnpm *),Bash(npx tsc*)",
      "--disallowedTools",
      "Edit,Write,Bash(git push*),Bash(git commit*),Bash(git checkout*),Bash(git reset*),Bash(gh pr *),Bash(gh issue *)",
    );
  } else {
    args.push(
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Bash,Read,Edit,Write,Glob,Grep",
      "--disallowedTools",
      "Bash(git push*),Bash(gh pr *),Bash(gh issue *)",
    );
  }

  if (input.mandate.maxCostUsd > 0) {
    args.push("--max-budget-usd", String(input.mandate.maxCostUsd));
  }

  if (input.model?.trim()) {
    args.push("--model", input.model.trim());
  }

  if (input.effort) {
    args.push("--effort", input.effort);
  }

  if (input.nativeSessionId) {
    args.push("--resume", input.nativeSessionId);
  }

  args.push(input.prompt);
  return args;
}

export function parseClaudeStreamLine(line: string): WorkerStreamEvent[] {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }

  const ts = nowIso();
  const events: WorkerStreamEvent[] = [];
  const type = String(obj.type ?? "");

  if (type === "system" && typeof obj.session_id === "string") {
    events.push({ type: "session_started", nativeSessionId: obj.session_id, timestamp: ts });
    return events;
  }

  if (type === "assistant" && obj.message && typeof obj.message === "object") {
    const msg = obj.message as { content?: Array<Record<string, unknown>> };
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const block of blocks) {
      const bType = String(block.type ?? "");
      if (bType === "thinking" && typeof block.thinking === "string") {
        events.push({ type: "thought", text: truncateText(block.thinking, 600), timestamp: ts });
      } else if (bType === "text" && typeof block.text === "string") {
        events.push({ type: "text", text: block.text, timestamp: ts });
      } else if (bType === "tool_use") {
        events.push({
          type: "tool_use",
          toolName: String(block.name ?? "tool"),
          inputSummary: truncateText(JSON.stringify(block.input ?? {}), 240),
          timestamp: ts,
        });
      }
    }
    return events;
  }

  if (type === "user" && obj.message && typeof obj.message === "object") {
    const msg = obj.message as { content?: Array<Record<string, unknown>> };
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const block of blocks) {
      if (block.type === "tool_result") {
        const contentStr =
          typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content ?? "");
        events.push({
          type: "tool_result",
          toolName: String(block.tool_use_id ?? "tool"),
          isError: Boolean(block.is_error),
          outputSummary: truncateText(contentStr, 300),
          timestamp: ts,
        });
      }
    }
    return events;
  }

  if (type === "result") {
    const costUsd = typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : undefined;
    if (typeof costUsd === "number") {
      events.push({ type: "usage", costUsd, timestamp: ts });
    }
    if (obj.is_error) {
      events.push({
        type: "error",
        message: truncateText(String(obj.result ?? "Claude execution failed"), 500),
        fatal: true,
        timestamp: ts,
      });
    } else {
      events.push({
        type: "completed",
        summary: truncateText(String(obj.result ?? "Completed"), 1500),
        costUsd,
        timestamp: ts,
      });
    }
  }

  return events;
}

export class ClaudeCodeDriver implements WorkerDriver {
  readonly engine = "claude" as const;

  constructor(private readonly binaryPath = "claude") {}

  async isAvailable(): Promise<boolean> {
    return Boolean(Bun.which(this.binaryPath));
  }

  async *runTurn(input: WorkerTurnInput, signal: AbortSignal): AsyncGenerator<WorkerStreamEvent> {
    const args = buildClaudeCliArgs(input);
    const wrapped = wrapCommandWithOsSandbox({
      commandArgv: [this.binaryPath, ...args],
      worktreePath: input.worktreePath,
      rootRepoPath: input.rootRepoPath,
      mode: input.sandboxMode ?? "balanced",
      forbiddenPaths: input.mandate.forbiddenPaths,
      readOnlyPaths: input.readOnlyPaths,
      allowNetwork: input.mandate.allowNetwork,
      engine: "claude",
      baseEnv: createSanitizedClaudeEnv(),
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

    let sawCompletion = false;
    const stderrPromise = new Response(proc.stderr).text();

    try {
      for await (const line of readLinesFromStream(proc.stdout)) {
        if (signal.aborted) break;
        const parsed = parseClaudeStreamLine(line);
        for (const ev of parsed) {
          if (ev.type === "completed" || ev.type === "error") {
            sawCompletion = true;
          }
          yield ev;
        }
      }

      const [exitCode, stderrText] = await Promise.all([proc.exited, stderrPromise]);
      if (!signal.aborted && !sawCompletion && exitCode !== 0) {
        yield {
          type: "error",
          message: truncateText(stderrText || `claude exited with code ${exitCode}`, 500),
          fatal: true,
          timestamp: nowIso(),
        };
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
