import { describe, expect, it } from "bun:test";
import {
  MemoryManager,
  createDefaultMandate,
  evaluateTicketRisk,
  type CodeHotspotItem,
  type RepoConfig,
  type Ticket,
} from "../src/index.ts";
import { runSystemDoctor } from "../src/kernel/doctor-backup-coordinator.ts";

function makeRepo(id = "repo_v140"): RepoConfig {
  return {
    id,
    name: id,
    rootPath: `/tmp/${id}`,
    baseBranch: "main",
    mode: "auto",
    defaultTemplate: "standard",
    defaultTddMode: false,
    forbiddenPaths: [".env*"],
    preferredImplementEngine: "claude",
    preferredReviewEngine: "codex",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeTicket(): Ticket {
  return {
    id: "tkt_v140",
    repoId: "repo_v140",
    threadId: "thr_v140",
    sourceTriggerId: "trg_v140",
    title: "Surgical",
    description: "desc",
    status: "implementing",
    template: "standard",
    currentStage: "implement",
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

function makeDoctorCtx(scan?: (root: string, threshold?: number) => Promise<CodeHotspotItem[]>) {
  return {
    stateStore: {
      listRepos: async () => [makeRepo("repo_a"), makeRepo("repo_b")],
      listTickets: async () => [],
    },
    workspace: scan ? { scanCodeHotspots: scan } : {},
    inspectWorktrees: async () => [],
    gcWorktrees: async () => null,
  } as never;
}

describe("v1.4.0 Surgical context pack + hotspot radar (core)", () => {
  it("MemoryManager renders the Surgical Symbol & Line Map section capped at 2400 chars", () => {
    const mm = new MemoryManager({} as never, {} as never);
    const pack = `- src/a.ts (10 lines)\n  symbols: function foo L1-L5\n${"x".repeat(5000)}`;
    const prompt = mm.buildWorkerPromptContext(makeTicket(), "implement", [], {
      surgicalContextPack: pack,
    });
    const marker = "## Surgical Symbol & Line Map\n";
    expect(prompt).toContain(marker);
    const body = prompt.slice(prompt.indexOf(marker) + marker.length);
    const section = body.split("\n## ")[0]!;
    expect(section.trim().length).toBeLessThanOrEqual(2400);
    expect(section).toContain("function foo L1-L5");

    const without = mm.buildWorkerPromptContext(makeTicket(), "implement", [], {});
    expect(without).not.toContain("Surgical Symbol & Line Map");
  });

  it("evaluateTicketRisk adds a bounded +8 hotspot_complexity factor", () => {
    const base = evaluateTicketRisk({ ticket: makeTicket(), changedFiles: ["src/big.ts"] });
    const hot = evaluateTicketRisk({
      ticket: makeTicket(),
      changedFiles: ["src/big.ts"],
      hotspotFiles: [
        { filePath: "src/big.ts", lineCount: 2000 },
        { filePath: "src/big2.ts", lineCount: 1800 },
      ],
    });
    const factor = hot.factors.find((f) => f.key === "hotspot_complexity");
    expect(factor?.delta).toBe(8);
    expect(factor?.detail).toContain("src/big.ts (2000 lines)");
    expect(hot.score - base.score).toBe(8);
    expect(base.factors.find((f) => f.key === "hotspot_complexity")).toBeUndefined();

    const empty = evaluateTicketRisk({ ticket: makeTicket(), changedFiles: [], hotspotFiles: [] });
    expect(empty.factors.find((f) => f.key === "hotspot_complexity")).toBeUndefined();
    expect(hot.score).toBeLessThanOrEqual(100);
  });

  it("runSystemDoctor surfaces sorted hotspots as a non-fatal warn check", async () => {
    const scan = async (root: string, threshold?: number): Promise<CodeHotspotItem[]> => {
      expect(threshold).toBe(1500);
      return root.endsWith("repo_a")
        ? [{ filePath: "packages/a/src/x.ts", lineCount: 1600, exportedSymbolCount: 3, dependentCount: 1, packageDir: "packages/a" }]
        : [{ filePath: "packages/b/src/y.ts", lineCount: 2400, exportedSymbolCount: 9, dependentCount: 4, packageDir: "packages/b" }];
    };
    const report = await runSystemDoctor(makeDoctorCtx(scan));
    expect(report.hotspots?.map((h) => h.filePath)).toEqual([
      "packages/b/src/y.ts",
      "packages/a/src/x.ts",
    ]);
    expect(report.hotspots?.[0]?.repoId).toBe("repo_b");
    const item = report.items.find((i) => i.id === "code_hotspots");
    expect(item?.status).toBe("warn");
    expect(item?.fixable).toBe(false);
    expect(report.healthy).toBe(true);
  });

  it("runSystemDoctor omits hotspots when the workspace cannot scan or finds none", async () => {
    const none = await runSystemDoctor(makeDoctorCtx());
    expect(none.hotspots).toBeUndefined();
    const empty = await runSystemDoctor(makeDoctorCtx(async () => []));
    expect(empty.hotspots).toEqual([]);
    expect(empty.items.some((i) => i.id === "code_hotspots")).toBe(false);
  });
});
