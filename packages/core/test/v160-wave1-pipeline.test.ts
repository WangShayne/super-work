import { describe, expect, it } from "bun:test";
import { MemoryManager, formatReviewEvidence } from "../src/memory.ts";
import {
  canReuseImplementGate,
  captureLastFullVerification,
} from "../src/kernel/stage-verification-helpers.ts";
import type {
  LastFullVerificationSnapshot,
  RepoConfig,
  ReviewEvidencePacket,
  StageRun,
  Ticket,
} from "../src/types.ts";

const COMMANDS = ["bun run typecheck", "bun test", "bun run build"];

const snapshot: LastFullVerificationSnapshot = {
  treeSha: "tree-1",
  baseHeadSha: "base-1",
  commands: COMMANDS,
  durationMs: 4242,
  stageRunId: "sr_1",
  verifiedAt: "2026-11-25T00:00:00.000Z",
};

function makeTicket(lfv?: LastFullVerificationSnapshot): Ticket {
  return {
    id: "tkt_x",
    title: "T",
    description: "d",
    template: "standard",
    clarificationCount: 0,
    mandate: { allowedPaths: ["packages/core/**"], forbiddenPaths: [".env"] },
    inlineMemory: {
      goal: "goal",
      acceptanceCriteria: [],
      stageNotes: [],
      threadUpdates: [],
      ...(lfv ? { lastFullVerification: lfv } : {}),
    },
  } as unknown as Ticket;
}

function makeRepo(over: Partial<RepoConfig> = {}): RepoConfig {
  return { id: "repo_1", rootPath: "/repo", baseBranch: "main", verificationCommands: COMMANDS, ...over } as RepoConfig;
}

function makeCtx(shas: { base?: string; tree?: string; throwTree?: boolean } = {}) {
  return {
    workspace: {
      getHeadCommitSha: async () => shas.base ?? "base-1",
      getTreeSha: async () => {
        if (shas.throwTree) throw new Error("boom");
        return shas.tree ?? "tree-1";
      },
    },
  } as never;
}

describe("v1.6.0 rebase gate reuse (fast-forward parity)", () => {
  it("reuses when all four parity conditions hold", async () => {
    const res = await canReuseImplementGate(makeCtx(), makeTicket(snapshot), makeRepo(), "/wt", "main");
    expect(res?.durationMs).toBe(4242);
  });

  it("normalizes whitespace when comparing commands", async () => {
    const repo = makeRepo({ verificationCommands: ["bun  run typecheck ", "bun test", " bun run build"] });
    expect(await canReuseImplementGate(makeCtx(), makeTicket(snapshot), repo, "/wt", "main")).toBeDefined();
  });

  it("falls back to the full gate on any mismatch or missing data", async () => {
    const t = makeTicket(snapshot);
    const repo = makeRepo();
    expect(await canReuseImplementGate(makeCtx({ base: "base-2" }), t, repo, "/wt", "main")).toBeUndefined();
    expect(await canReuseImplementGate(makeCtx({ tree: "tree-2" }), t, repo, "/wt", "main")).toBeUndefined();
    expect(
      await canReuseImplementGate(makeCtx(), t, makeRepo({ verificationCommands: ["bun test"] }), "/wt", "main"),
    ).toBeUndefined();
    expect(
      await canReuseImplementGate(makeCtx(), t, makeRepo({ smokeCheck: { enabled: true } as never }), "/wt", "main"),
    ).toBeUndefined();
    expect(await canReuseImplementGate(makeCtx({ throwTree: true }), t, repo, "/wt", "main")).toBeUndefined();
    // no snapshot (e.g. implement ran impact_scoped)
    expect(await canReuseImplementGate(makeCtx(), makeTicket(), repo, "/wt", "main")).toBeUndefined();
  });
});

describe("v1.6.0 lastFullVerification capture", () => {
  const stageRun = { id: "sr_9" } as StageRun;
  const passed = { passed: true, result: { results: [{ durationMs: 100 }, { durationMs: 50 }] } } as never;

  it("captures a snapshot for a full passing gate", async () => {
    const snap = await captureLastFullVerification(makeCtx(), makeRepo(), stageRun, passed, "/wt", "main");
    expect(snap).toMatchObject({ treeSha: "tree-1", baseHeadSha: "base-1", durationMs: 150, stageRunId: "sr_9" });
    expect(snap?.commands).toEqual(COMMANDS);
  });

  it("skips scoped or failed gates", async () => {
    const scoped = { passed: true, result: { results: [], scopedVerification: { usedScoped: true } } } as never;
    expect(await captureLastFullVerification(makeCtx(), makeRepo(), stageRun, scoped, "/wt", "main")).toBeUndefined();
    const failed = { passed: false } as never;
    expect(await captureLastFullVerification(makeCtx(), makeRepo(), stageRun, failed, "/wt", "main")).toBeUndefined();
  });
});

describe("v1.6.0 safe-refactor review evidence", () => {
  const packet = (over: Partial<ReviewEvidencePacket> = {}): ReviewEvidencePacket => ({
    baseBranch: "main",
    diffStat: "x | 10 +\n".repeat(400),
    changedFiles: Array.from({ length: 80 }, (_, i) => `packages/core/src/module-${i}.ts`),
    gatePassed: true,
    gateCommands: COMMANDS,
    gateSummary: "PASS",
    refactorParity: {
      targetFile: "packages/core/src/big.ts",
      lineCountBefore: 2000,
      lineCountAfter: 900,
      maxLines: 1200,
      exportsPreserved: true,
      migratedSymbolsCount: 40,
      newModuleFiles: Array.from({ length: 12 }, (_, i) => `packages/core/src/big-${i}.ts`),
      symbolMigrationSummary: `Moved: ${Array.from({ length: 12 }, (_, i) => `sym${i}→big-${i}.ts`).join(", ")}`,
    },
    ...over,
  });

  it("formats the migration summary within 3200 chars and keeps gate lines", () => {
    const text = formatReviewEvidence(packet());
    expect(text.length).toBeLessThanOrEqual(3200);
    expect(text).toContain("Safe-Refactor Symbol Migration Summary");
    expect(text).toContain("Preceding gate: PASS");
  });

  it("injects the fast-review hint only when exports are preserved and the gate passed", () => {
    const mm = new MemoryManager({} as never, {} as never);
    const build = (p: ReviewEvidencePacket) =>
      mm.buildWorkerPromptContext(makeTicket(), "review", [], { reviewEvidence: p, worktreePath: "/wt/x" });
    const fast = build(packet());
    expect(fast).toContain("SAFE-REFACTOR FAST REVIEW");
    expect(fast).toContain("<180s");
    expect(fast).toContain("WORKTREE_CWD=/wt/x");
    expect(build(packet({ gatePassed: false }))).not.toContain("SAFE-REFACTOR FAST REVIEW");
    expect(build(packet({ refactorParity: undefined }))).not.toContain("SAFE-REFACTOR FAST REVIEW");
  });

  it("plan prompt forbids writing plan files", () => {
    const mm = new MemoryManager({} as never, {} as never);
    const prompt = mm.buildWorkerPromptContext(makeTicket(), "plan", [], { worktreePath: "/wt/x" });
    expect(prompt).toContain("~/.claude/plans");
    expect(prompt).toContain("WORKTREE_CWD=/wt/x");
  });
});
