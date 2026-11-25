import { describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultMandate, type RepoConfig, type WorkerTurnInput } from "@super-work/core";
import {
  CliFallbackControlLLM,
  CompositeControlPlaneLLM,
  HeuristicControlLLM,
  buildClaudeCliArgs,
  buildClaudeControlPlaneArgs,
  buildCodexCliArgs,
  buildOpenCodeCliArgs,
  formatOpenCodeModelArg,
  parseClaudeStreamLine,
  parseCodexStreamLine,
  parseOpenCodeStreamLine,
  sanitizeCliModelName,
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

  it("builds valid claude 2.1.318 flags with stage-specific tool permissions and no --max-turns", () => {
    const planArgs = buildClaudeCliArgs({ ...baseInput, stage: "plan" });
    expect(planArgs).not.toContain("--max-turns");
    expect(planArgs).toContain("--verbose");
    expect(planArgs).toContain("stream-json");
    expect(planArgs).toContain("--permission-mode");
    expect(planArgs).toContain("plan");
    expect(planArgs).toContain("--tools");
    expect(planArgs).toContain("Read,Glob,Grep");
    expect(planArgs).not.toContain("Bash");

    const implArgs = buildClaudeCliArgs({
      ...baseInput,
      stage: "implement",
      nativeSessionId: "sess_abc",
      isResume: true,
      model: "opus",
      effort: "high",
    });
    expect(implArgs).toContain("acceptEdits");
    expect(implArgs).toContain("--allowedTools");
    expect(implArgs).toContain("Bash,Read,Edit,Write,Glob,Grep");
    expect(implArgs).toContain("--disallowedTools");
    expect(implArgs).toContain("Bash(git push*),Bash(gh pr *),Bash(gh issue *)");
    expect(implArgs).toContain("--max-budget-usd");
    expect(implArgs).toContain("1.5");
    expect(implArgs).toContain("--model");
    expect(implArgs).toContain("opus");
    expect(implArgs).toContain("--effort");
    expect(implArgs).toContain("high");
    expect(implArgs).toContain("--resume");
    expect(implArgs).toContain("sess_abc");

    const reviewArgs = buildClaudeCliArgs({ ...baseInput, stage: "review" });
    expect(reviewArgs).toContain("acceptEdits");
    expect(reviewArgs).toContain("--tools");
    expect(reviewArgs).toContain("Read,Glob,Grep,Bash");
    expect(reviewArgs).toContain("--allowedTools");
    const reviewAllowedIdx = reviewArgs.indexOf("--allowedTools");
    expect(reviewArgs[reviewAllowedIdx + 1]).toContain("Bash(git diff*)");
    expect(reviewArgs[reviewAllowedIdx + 1]).toContain("Bash(bun test*)");
    const reviewDisallowedIdx = reviewArgs.indexOf("--disallowedTools");
    expect(reviewArgs[reviewDisallowedIdx + 1]).toContain("Edit,Write");
    expect(reviewArgs[reviewDisallowedIdx + 1]).toContain("Bash(git push*)");
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
      "Implement feature X",
    ]);
    expect(freshReview).not.toContain("--approve-for-me");

    const freshImplement = buildCodexCliArgs({ ...baseInput, stage: "implement" });
    expect(freshImplement).toEqual(["exec", "--json", "--approve-for-me", "Implement feature X"]);
    expect(freshImplement).not.toContain("-s");

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

  it("builds valid opencode run flags and safely skips variant without a model", () => {
    expect(formatOpenCodeModelArg(undefined, "high")).toBeUndefined();
    expect(formatOpenCodeModelArg("openai/gpt-5.6-sol", "xhigh")).toBe(
      "openai/gpt-5.6-sol#xhigh",
    );
    expect(formatOpenCodeModelArg("anthropic/claude-opus-5#max", "low")).toBe(
      "anthropic/claude-opus-5#max",
    );

    const planArgs = buildOpenCodeCliArgs({
      ...baseInput,
      stage: "plan",
      effort: "high",
    });
    expect(planArgs).toEqual(["run", "--format", "json", "--thinking", "--agent", "plan"]);
    expect(planArgs).not.toContain("--auto");
    expect(planArgs).not.toContain("--model");

    const buildArgs = buildOpenCodeCliArgs({
      ...baseInput,
      stage: "implement",
      model: "openai/gpt-5.6-sol",
      effort: "xhigh",
      nativeSessionId: "ses_opencode_123",
      isResume: true,
    });
    expect(buildArgs).toEqual([
      "run",
      "--format",
      "json",
      "--thinking",
      "--agent",
      "build",
      "--auto",
      "--model",
      "openai/gpt-5.6-sol#xhigh",
      "--session",
      "ses_opencode_123",
    ]);
  });

  it("normalizes opencode --format json events", () => {
    const state = { sessionEmitted: false };
    const start = parseOpenCodeStreamLine(
      JSON.stringify({ type: "step_start", sessionID: "ses_1", part: { type: "step-start" } }),
      state,
    );
    expect(start).toHaveLength(1);
    expect(start[0]).toMatchObject({ type: "session_started", nativeSessionId: "ses_1" });

    const thought = parseOpenCodeStreamLine(
      JSON.stringify({
        type: "reasoning",
        sessionID: "ses_1",
        part: { type: "reasoning", text: "Inspecting codegraph" },
      }),
      state,
    );
    expect(thought).toHaveLength(1);
    expect(thought[0]).toMatchObject({ type: "thought", text: "Inspecting codegraph" });

    const toolOk = parseOpenCodeStreamLine(
      JSON.stringify({
        type: "tool_use",
        sessionID: "ses_1",
        part: {
          type: "tool",
          tool: "bash",
          state: { status: "completed", input: { command: "bun test" }, output: "23 pass" },
        },
      }),
      state,
    );
    expect(toolOk.map((e) => e.type)).toEqual(["tool_use", "tool_result"]);
    expect(toolOk[1]).toMatchObject({ isError: false, outputSummary: "23 pass" });

    const toolErr = parseOpenCodeStreamLine(
      JSON.stringify({
        type: "tool_use",
        sessionID: "ses_1",
        part: {
          type: "tool",
          tool: "edit",
          state: { status: "error", input: { filePath: "a.ts" }, error: "Permission denied" },
        },
      }),
      state,
    );
    expect(toolErr[1]).toMatchObject({ isError: true, outputSummary: "Permission denied" });

    const usage = parseOpenCodeStreamLine(
      JSON.stringify({
        type: "step_finish",
        sessionID: "ses_1",
        part: { type: "step-finish", cost: 0.04, tokens: { input: 200, output: 50 } },
      }),
      state,
    );
    expect(usage[0]).toMatchObject({
      type: "usage",
      costUsd: 0.04,
      inputTokens: 200,
      outputTokens: 50,
    });

    const err = parseOpenCodeStreamLine(
      JSON.stringify({
        type: "error",
        sessionID: "ses_1",
        error: { type: "unknown", message: "Provider rate limited" },
      }),
      state,
    );
    expect(err[0]).toMatchObject({
      type: "error",
      fatal: true,
      message: "Provider rate limited",
    });
  });
});

describe("ControlPlaneLLM CLI flags, model sanitization, and timeout fallback", () => {
  it("strips placeholder CLI models while preserving real model identifiers", () => {
    expect(sanitizeCliModelName(undefined)).toBeUndefined();
    expect(sanitizeCliModelName("   ")).toBeUndefined();
    expect(sanitizeCliModelName("claude-cli")).toBeUndefined();
    expect(sanitizeCliModelName("Codex-CLI")).toBeUndefined();
    expect(sanitizeCliModelName("default")).toBeUndefined();
    expect(sanitizeCliModelName("heuristic")).toBeUndefined();
    expect(sanitizeCliModelName(" sonnet ")).toBe("sonnet");
    expect(sanitizeCliModelName("gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });

  it("isolates control-plane Claude CLI calls from MCP/skills and skips placeholder --model", () => {
    const schema = { type: "object", properties: {} };
    const cleanArgs = buildClaudeControlPlaneArgs({
      prompt: "Plan Epic",
      schema,
      model: "claude-cli",
      effort: "low",
    });
    expect(cleanArgs).toContain("--strict-mcp-config");
    expect(cleanArgs).toContain("--disable-slash-commands");
    expect(cleanArgs).toContain("--no-session-persistence");
    expect(cleanArgs).not.toContain("--model");
    expect(cleanArgs.at(-1)).toBe("Plan Epic");

    const pinnedArgs = buildClaudeControlPlaneArgs({
      prompt: "Plan Epic",
      schema,
      model: "sonnet",
      effort: "medium",
    });
    const modelIdx = pinnedArgs.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(pinnedArgs[modelIdx + 1]).toBe("sonnet");
  });

  it("times out a stalled CLI subprocess cleanly and falls back to HeuristicControlLLM", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-fake-cli-"));
    const scriptPath = join(dir, "fake-claude.sh");
    await writeFile(scriptPath, "#!/bin/sh\nsleep 5\n", "utf8");
    await chmod(scriptPath, 0o755);

    const repo: RepoConfig = {
      id: "repo_test",
      name: "super-work",
      rootPath: "/tmp/repo",
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "standard",
      preferredImplementEngine: "claude",
      preferredReviewEngine: "codex",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };

    try {
      const cliLlm = new CliFallbackControlLLM({
        claudeBin: scriptPath,
        model: "claude-cli",
        effort: "low",
        timeoutMs: 80,
      });
      expect(cliLlm.providerName).toBe("cli:claude(default,low)");

      const composite = new CompositeControlPlaneLLM([cliLlm, new HeuristicControlLLM()]);
      const startedAt = Date.now();
      const plan = await composite.planEpicDecomposition({
        repo,
        title: "Refactor plugin architecture",
        description: "1. packages/core define plugin contracts\n2. packages/drivers implement loader",
        defaultTemplate: "standard",
      });
      const elapsedMs = Date.now() - startedAt;

      expect(elapsedMs).toBeLessThan(1500);
      expect(plan.subtasks.length).toBeGreaterThanOrEqual(2);
      const paths = plan.subtasks.flatMap((s) => s.allowedPaths);
      expect(paths).toContain("packages/core/**");
      expect(paths).toContain("packages/drivers/**");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
