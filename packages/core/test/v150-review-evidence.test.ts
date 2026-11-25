import { describe, expect, it } from "bun:test";
import {
  MemoryManager,
  createDefaultMandate,
  type ReviewEvidencePacket,
  type Ticket,
} from "../src/index.ts";

const HEADER = "## Authoritative Review Diff & Gate Evidence";

function makeTicket(): Ticket {
  return {
    id: "tkt_v150",
    repoId: "repo_v150",
    threadId: "thr_v150",
    sourceTriggerId: "trg_v150",
    title: "Review evidence",
    description: "desc",
    status: "reviewing",
    template: "standard",
    currentStage: "review",
    stageRetries: 0,
    mandate: createDefaultMandate({ allowedPaths: ["src/**"], maxCostUsd: 3 }),
    dependsOn: [],
    nativeSessions: {},
    inlineMemory: { goal: "goal", acceptanceCriteria: [], stageNotes: [], threadUpdates: [] },
    costUsd: 0,
    priority: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function packet(over: Partial<ReviewEvidencePacket> = {}): ReviewEvidencePacket {
  return {
    baseBranch: "main",
    diffStat: " src/a.ts | 10 +++++-----\n 1 file changed, 5 insertions(+), 5 deletions(-)",
    changedFiles: ["src/a.ts"],
    gatePassed: true,
    gateCommands: ["bun run typecheck", "bun test"],
    gateDurationMs: 4321,
    gateSummary: "All checks passed",
    ...over,
  };
}

function section(prompt: string): string {
  const start = prompt.indexOf(HEADER);
  const rest = prompt.slice(start);
  return rest.split("\n## ").length > 1 ? rest.split("\n## ")[0]! : rest;
}

describe("v1.5.0 review evidence packet (core)", () => {
  const mm = new MemoryManager({} as never, {} as never);

  it("renders PASS evidence with base...HEAD guidance, files, commands and duration", () => {
    const prompt = mm.buildWorkerPromptContext(makeTicket(), "review", [], {
      reviewEvidence: packet(),
    });
    const sec = section(prompt);
    expect(prompt).toContain(HEADER);
    expect(sec).toContain("git diff main...HEAD");
    expect(sec).toContain("clean working tree");
    expect(sec).toContain("src/a.ts");
    expect(sec).toContain("1 file changed");
    expect(sec).toContain("PASS");
    expect(sec).toContain("bun run typecheck && bun test");
    expect(sec).toContain("4321ms");
    expect(sec).toContain("All checks passed");
  });

  it("renders FAIL gate status and summary", () => {
    const prompt = mm.buildWorkerPromptContext(makeTicket(), "review", [], {
      reviewEvidence: packet({ gatePassed: false, gateSummary: "typecheck failed: TS2304" }),
    });
    const sec = section(prompt);
    expect(sec).toContain("Preceding gate: FAIL");
    expect(sec).not.toContain("Preceding gate: PASS");
    expect(sec).toContain("typecheck failed: TS2304");
  });

  it("is omitted for non-review stages or when no packet is given", () => {
    const impl = mm.buildWorkerPromptContext(makeTicket(), "implement", [], {
      reviewEvidence: packet(),
    });
    expect(impl).not.toContain(HEADER);
    const none = mm.buildWorkerPromptContext(makeTicket(), "review", [], {});
    expect(none).not.toContain(HEADER);
  });

  it("caps the section at 2800 chars with oversized diffStat and file lists", () => {
    const prompt = mm.buildWorkerPromptContext(makeTicket(), "review", [], {
      reviewEvidence: packet({
        diffStat: Array.from({ length: 400 }, (_, i) => ` src/file${i}.ts | 9 ++++++---`).join("\n"),
        changedFiles: Array.from({ length: 400 }, (_, i) => `src/file${i}.ts`),
        gateSummary: "z".repeat(5000),
      }),
    });
    const sec = section(prompt);
    expect(sec.length).toBeLessThanOrEqual(2800);
    expect(sec).toContain("git diff main...HEAD");
    expect(sec).toContain("more)");
  });
});
