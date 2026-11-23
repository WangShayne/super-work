import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  WorkerDriver,
  WorkerEngineId,
  WorkerStreamEvent,
  WorkerTurnInput,
} from "@super-work/core";
import { newId, nowIso } from "@super-work/core";

export type MockScenarioKind =
  | "happy_path"
  | "violate_mandate"
  | "infinite_error_loop"
  | "diff_oscillation"
  | "review_reject_once"
  | "review_nit_only";

export interface MockDriverOptions {
  engine?: WorkerEngineId;
  scenarioResolver?: (input: WorkerTurnInput) => MockScenarioKind;
  stepDelayMs?: number;
}

export class MockWorkerDriver implements WorkerDriver {
  readonly engine: WorkerEngineId;
  private readonly scenarioResolver: (input: WorkerTurnInput) => MockScenarioKind;
  private readonly stepDelayMs: number;
  private readonly reviewAttempts = new Map<string, number>();

  constructor(options?: MockDriverOptions) {
    this.engine = options?.engine ?? "mock";
    this.scenarioResolver = options?.scenarioResolver ?? (() => "happy_path");
    this.stepDelayMs = options?.stepDelayMs ?? 10;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  private async waitStep(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      throw new Error("Aborted");
    }
    if (this.stepDelayMs <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, this.stepDelayMs);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async *runTurn(input: WorkerTurnInput, signal: AbortSignal): AsyncGenerator<WorkerStreamEvent> {
    const scenario = this.scenarioResolver(input);
    const sessionId = input.nativeSessionId ?? newId("mock_sess");
    yield { type: "session_started", nativeSessionId: sessionId, timestamp: nowIso() };
    await this.waitStep(signal);

    yield {
      type: "thought",
      text: `[${this.engine}] Executing ${input.stage} (${scenario}) in ${input.worktreePath}`,
      timestamp: nowIso(),
    };
    await this.waitStep(signal);

    if (scenario === "infinite_error_loop") {
      for (let i = 1; i <= 4; i++) {
        if (signal.aborted) return;
        yield {
          type: "tool_use",
          toolName: "Bash",
          inputSummary: "bun test failing_spec.ts",
          timestamp: nowIso(),
        };
        await this.waitStep(signal);
        yield {
          type: "tool_result",
          toolName: "Bash",
          isError: true,
          outputSummary: `Command failed with exit code 1: TypeError cannot read property 'id' of undefined at line ${i + 10}`,
          timestamp: nowIso(),
        };
        await this.waitStep(signal);
      }
      return;
    }

    if (scenario === "diff_oscillation" && input.stage === "implement") {
      const targetRel = pickTargetFile(input.mandate.allowedPaths, input.ticketId);
      const targetFull = join(input.worktreePath, targetRel);
      await mkdir(dirname(targetFull), { recursive: true });
      const states = ["export const version = 1;\n", "export const version = 2;\n", "export const version = 1;\n"];
      for (const content of states) {
        if (signal.aborted) return;
        await writeFile(targetFull, content, "utf8");
        yield {
          type: "tool_use",
          toolName: "Edit",
          inputSummary: targetRel,
          timestamp: nowIso(),
        };
        yield {
          type: "tool_result",
          toolName: "Edit",
          isError: false,
          outputSummary: `Updated ${targetRel}`,
          timestamp: nowIso(),
        };
        await this.waitStep(signal);
      }
      return;
    }

    if (scenario === "violate_mandate" && input.stage === "implement") {
      const forbiddenPath = join(input.worktreePath, ".env.local");
      await writeFile(forbiddenPath, "LEAKED_SECRET=123\n", "utf8");
      yield {
        type: "tool_use",
        toolName: "Write",
        inputSummary: ".env.local",
        timestamp: nowIso(),
      };
      yield {
        type: "tool_result",
        toolName: "Write",
        isError: false,
        outputSummary: "Wrote .env.local",
        timestamp: nowIso(),
      };
      yield {
        type: "usage",
        costUsd: 0.04,
        timestamp: nowIso(),
      };
      yield {
        type: "completed",
        summary: "Wrote config file",
        costUsd: 0.04,
        timestamp: nowIso(),
      };
      return;
    }

    if (input.stage === "plan") {
      const planSummary = `Plan for ${input.ticketId}: modify scoped modules (${input.mandate.allowedPaths.join(", ")}) and verify tests.`;
      yield { type: "text", text: planSummary, timestamp: nowIso() };
      yield { type: "usage", costUsd: 0.02, timestamp: nowIso() };
      yield {
        type: "completed",
        summary: planSummary,
        costUsd: 0.02,
        structuredOutput: { planSummary },
        timestamp: nowIso(),
      };
      return;
    }

    if (input.stage === "implement") {
      const relFile = pickTargetFile(input.mandate.allowedPaths, input.ticketId);
      const absFile = join(input.worktreePath, relFile);
      await mkdir(dirname(absFile), { recursive: true });
      const body = [
        `// Implemented by ${this.engine} for ${input.ticketId}`,
        `export const ticketId = ${JSON.stringify(input.ticketId)};`,
        `export const engine = ${JSON.stringify(this.engine)};`,
        input.prompt.includes("Active Guidance")
          ? "// Applied follow-up guidance / review feedback"
          : "// Initial implementation",
        "",
      ].join("\n");
      await writeFile(absFile, body, "utf8");

      yield {
        type: "tool_use",
        toolName: "Write",
        inputSummary: relFile,
        timestamp: nowIso(),
      };
      yield {
        type: "tool_result",
        toolName: "Write",
        isError: false,
        outputSummary: `Wrote ${relFile}`,
        timestamp: nowIso(),
      };
      yield {
        type: "text",
        text: `Implemented changes in ${relFile} and verified locally.`,
        timestamp: nowIso(),
      };
      yield { type: "usage", costUsd: 0.08, timestamp: nowIso() };
      yield {
        type: "completed",
        summary: `Implemented ${relFile} via ${this.engine}`,
        costUsd: 0.08,
        structuredOutput: { changedFiles: [relFile], verificationPassed: true },
        timestamp: nowIso(),
      };
      return;
    }

    if (input.stage === "review") {
      const count = (this.reviewAttempts.get(input.ticketId) ?? 0) + 1;
      this.reviewAttempts.set(input.ticketId, count);
      const targetFile = pickTargetFile(input.mandate.allowedPaths, input.ticketId);
      const rejectOnce = scenario === "review_reject_once" && count === 1;
      const nitOnly = scenario === "review_nit_only";
      const approved = !rejectOnce;

      const reviewFindings = rejectOnce
        ? [
            {
              severity: "major" as const,
              file: targetFile,
              line: 2,
              message: "Missing edge-case validation",
              suggestion: "Guard empty or invalid input before returning",
            },
          ]
        : nitOnly
          ? [
              {
                severity: "nit" as const,
                file: targetFile,
                line: 1,
                message: "Consider adding brief JSDoc comment for clarity",
                suggestion: "Add a 1-line module doc comment",
              },
            ]
          : [];

      const text = approved
        ? `Code review passed via ${this.engine}.${nitOnly ? " (1 advisory nit)" : ""} VERDICT: APPROVED`
        : `Missing edge-case assertion via ${this.engine}. VERDICT: REJECTED - add extra validation`;

      yield { type: "text", text, timestamp: nowIso() };
      yield { type: "usage", costUsd: 0.03, timestamp: nowIso() };
      yield {
        type: "completed",
        summary: text,
        costUsd: 0.03,
        structuredOutput: {
          approved,
          feedback: approved ? undefined : "Add edge-case validation",
          reviewFindings,
        },
        timestamp: nowIso(),
      };
      return;
    }

    yield { type: "usage", costUsd: 0.01, timestamp: nowIso() };
    yield {
      type: "completed",
      summary: `${input.stage} finished via ${this.engine}`,
      costUsd: 0.01,
      timestamp: nowIso(),
    };
  }
}

function pickTargetFile(allowedPaths: string[], ticketId: string): string {
  const first = allowedPaths[0];
  if (!first || first === "**" || first === "*") {
    return `.super-work-generated/${ticketId}.ts`;
  }
  const clean = first
    .replace(/\/\*\*$/, "")
    .replace(/\/\*$/, "")
    .replace(/^\.\//, "");
  if (clean.endsWith(".ts") || clean.endsWith(".md") || clean.endsWith(".txt") || clean.endsWith(".json")) {
    return clean;
  }
  return `${clean}/${ticketId}.ts`;
}
