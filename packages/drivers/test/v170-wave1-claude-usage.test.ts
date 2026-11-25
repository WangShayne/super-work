import { describe, expect, it } from "bun:test";
import {
  estimateClaudeUsageCostUsd,
  parseClaudeStreamLine,
  type ClaudeStreamParseState,
} from "../src/workers/claude-code-driver.ts";

function assistantLine(id: string, usage: Record<string, number>): string {
  return JSON.stringify({
    type: "assistant",
    message: { id, content: [{ type: "text", text: "hi" }], usage },
  });
}

type UsageEvent = { type: "usage"; costUsd: number; inputTokens?: number; outputTokens?: number };

function usageOf(events: ReturnType<typeof parseClaudeStreamLine>): UsageEvent[] {
  return events.filter((e): e is UsageEvent & (typeof events)[number] => e.type === "usage") as UsageEvent[];
}

describe("v1.7.0 Claude streaming usage cost estimation", () => {
  it("estimates cost from all four token classes", () => {
    const cost = estimateClaudeUsageCostUsd({
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(3 + 15 + 0.3 + 3.75, 6);
    expect(estimateClaudeUsageCostUsd({})).toBe(0);
  });

  it("emits cumulative usage events for assistant messages when state is provided", () => {
    const state: ClaudeStreamParseState = { cumulativeEstimatedCostUsd: 0 };
    const first = usageOf(
      parseClaudeStreamLine(assistantLine("m1", { input_tokens: 1000, output_tokens: 500 }), state),
    );
    expect(first).toHaveLength(1);
    expect(first[0]!.costUsd).toBeCloseTo((1000 * 3 + 500 * 15) / 1e6, 8);
    expect(first[0]!.inputTokens).toBe(1000);
    expect(first[0]!.outputTokens).toBe(500);

    const second = usageOf(
      parseClaudeStreamLine(
        assistantLine("m2", { input_tokens: 2000, output_tokens: 100, cache_read_input_tokens: 10_000 }),
        state,
      ),
    );
    expect(second[0]!.costUsd).toBeGreaterThan(first[0]!.costUsd);
    expect(second[0]!.inputTokens).toBe(1000 + 2000 + 10_000);
    expect(second[0]!.outputTokens).toBe(600);
  });

  it("does not double-bill the same assistant message id", () => {
    const state: ClaudeStreamParseState = {};
    const line = assistantLine("dup", { input_tokens: 1000, output_tokens: 1000 });
    expect(usageOf(parseClaudeStreamLine(line, state))).toHaveLength(1);
    expect(usageOf(parseClaudeStreamLine(line, state))).toHaveLength(0);
  });

  it("keeps legacy behavior (no usage events) when no state is passed", () => {
    const events = parseClaudeStreamLine(assistantLine("m1", { input_tokens: 1000, output_tokens: 500 }));
    expect(usageOf(events)).toHaveLength(0);
    expect(events.some((e) => e.type === "text")).toBe(true);
  });

  it("reconciles with the authoritative result.total_cost_usd", () => {
    const state: ClaudeStreamParseState = {};
    parseClaudeStreamLine(assistantLine("m1", { input_tokens: 5000, output_tokens: 2000 }), state);
    const events = parseClaudeStreamLine(
      JSON.stringify({ type: "result", result: "done", total_cost_usd: 0.0123 }),
      state,
    );
    const usage = usageOf(events);
    expect(usage).toHaveLength(1);
    expect(usage[0]!.costUsd).toBe(0.0123);
    const completed = events.find((e) => e.type === "completed") as { costUsd?: number } | undefined;
    expect(completed?.costUsd).toBe(0.0123);
    expect(state.cumulativeEstimatedCostUsd).toBe(0.0123);
  });
});
