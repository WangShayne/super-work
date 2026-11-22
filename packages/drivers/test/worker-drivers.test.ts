import { describe, expect, it } from "bun:test";
import { createDefaultMandate, type WorkerTurnInput } from "@super-work/core";
import {
  buildClaudeCliArgs,
  buildCodexCliArgs,
  parseClaudeStreamLine,
  parseCodexStreamLine,
} from "../src/index.ts";

describe("Worker CLI flag mapping and JSONL stream parsers", () => {
  const baseInput: WorkerTurnInput = {
    ticketId: "tkt_1",
    stageRunId: "run_1",
    stage: "implement",
    worktreePath: "/tmp/wt",
    prompt: "Implement feature X",
    mandate: createDefaultMandate({ maxCostUsd: 1.5 }),
    isResume: false,
  };

  it("builds valid claude 2.1.318 flags without unsupported --max-turns", () => {
    const planArgs = buildClaudeCliArgs({ ...baseInput, stage: "plan" });
    expect(planArgs).not.toContain("--max-turns");
    expect(planArgs).toContain("--verbose");
    expect(planArgs).toContain("stream-json");
    expect(planArgs).toContain("--permission-mode");
    expect(planArgs).toContain("plan");
    expect(planArgs).toContain("--tools");

    const implArgs = buildClaudeCliArgs({
      ...baseInput,
      stage: "implement",
      nativeSessionId: "sess_abc",
      isResume: true,
      model: "opus",
      effort: "high",
    });
    expect(implArgs).toContain("acceptEdits");
    expect(implArgs).toContain("--disallowedTools");
    expect(implArgs).toContain("--max-budget-usd");
    expect(implArgs).toContain("1.5");
    expect(implArgs).toContain("--model");
    expect(implArgs).toContain("opus");
    expect(implArgs).toContain("--effort");
    expect(implArgs).toContain("high");
    expect(implArgs).toContain("--resume");
    expect(implArgs).toContain("sess_abc");
  });

  it("builds valid codex 0.166.0 fresh and resume flags without -s/-C on resume", () => {
    const freshReview = buildCodexCliArgs({
      ...baseInput,
      stage: "review",
      model: "gpt-5.6-sol",
      effort: "max",
    });
    expect(freshReview).toEqual([
      "exec",
      "--json",
      "-m",
      "gpt-5.6-sol",
      "-c",
      'model_reasoning_effort="xhigh"',
      "-s",
      "read-only",
      "--approve-for-me",
      "Implement feature X",
    ]);

    const resumeArgs = buildCodexCliArgs({
      ...baseInput,
      nativeSessionId: "019d-thread-uuid",
      isResume: true,
      model: "gpt-5.6-sol",
      effort: "medium",
    });
    expect(resumeArgs).toEqual([
      "exec",
      "resume",
      "--json",
      "-m",
      "gpt-5.6-sol",
      "-c",
      'model_reasoning_effort="medium"',
      "019d-thread-uuid",
      "Implement feature X",
    ]);
    expect(resumeArgs).not.toContain("-s");
    expect(resumeArgs).not.toContain("-C");
  });

  it("normalizes Claude stream-json events", () => {
    const init = parseClaudeStreamLine(JSON.stringify({ type: "system", session_id: "c_sess_1" }));
    expect(init[0]).toMatchObject({ type: "session_started", nativeSessionId: "c_sess_1" });

    const assistant = parseClaudeStreamLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "Checking files" },
            { type: "tool_use", name: "Edit", input: { file_path: "a.ts" } },
            { type: "text", text: "Updated a.ts" },
          ],
        },
      }),
    );
    expect(assistant.map((e) => e.type)).toEqual(["thought", "tool_use", "text"]);

    const done = parseClaudeStreamLine(
      JSON.stringify({ type: "result", is_error: false, total_cost_usd: 0.12, result: "All green" }),
    );
    expect(done.map((e) => e.type)).toEqual(["usage", "completed"]);
  });

  it("normalizes Codex JSONL events", () => {
    const started = parseCodexStreamLine(JSON.stringify({ type: "thread.started", thread_id: "cdx_1" }));
    expect(started[0]).toMatchObject({ type: "session_started", nativeSessionId: "cdx_1" });

    const cmd = parseCodexStreamLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", command: "bun test", exit_code: 1, aggregated_output: "fail" },
      }),
    );
    expect(cmd).toHaveLength(2);
    expect(cmd[1]).toMatchObject({ type: "tool_result", isError: true });

    const completed = parseCodexStreamLine(
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000, output_tokens: 500 } }),
    );
    expect(completed.map((e) => e.type)).toEqual(["usage", "completed"]);
  });
});
