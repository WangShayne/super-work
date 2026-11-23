import { describe, expect, it } from "bun:test";
import {
  formatPlaybookContext,
  parseReviewReport,
  selectPlaybookRulesForContext,
  selectReviewEngine,
  type PlaybookEntry,
  type RepoConfig,
} from "../src/index.ts";

function makeRepo(overrides?: Partial<RepoConfig>): RepoConfig {
  const ts = "2026-11-23T00:00:00.000Z";
  return {
    id: "repo_1",
    name: "demo",
    rootPath: "/tmp/demo",
    baseBranch: "main",
    mode: "auto",
    defaultTemplate: "standard",
    preferredImplementEngine: "claude",
    preferredReviewEngine: "codex",
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

describe("Structured Adversarial Review (v0.5.0)", () => {
  it("parses fenced JSON reviewFindings and blocks on blocker/major", () => {
    const rawText = [
      "Audited the patch.",
      "```json",
      JSON.stringify({
        verdict: "approved",
        findings: [
          {
            severity: "major",
            file: "./src/auth/jwt.ts",
            line: 42,
            message: "Missing exp claim check",
            suggestion: "Verify exp > now before returning payload",
          },
        ],
      }),
      "```",
    ].join("\n");

    const report = parseReviewReport({
      summary: "Review complete",
      textChunks: rawText,
      engine: "codex",
    });

    expect(report.verdict).toBe("changes_requested");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.file).toBe("src/auth/jwt.ts");
    expect(report.findings[0]!.line).toBe(42);
    expect(report.findings[0]!.severity).toBe("major");
  });

  it("approves automatically when only nit findings exist", () => {
    const report = parseReviewReport({
      summary: "Minor style suggestions only",
      structuredOutput: {
        reviewFindings: [
          { severity: "nit", file: "src/app.ts", line: 10, message: "Rename helper variable" },
        ],
      },
      engine: "codex",
    });

    expect(report.verdict).toBe("approved");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.severity).toBe("nit");
  });

  it("falls back to markdown [BLOCKER]/[NIT] tags and synthesizes finding on unstructured rejection", () => {
    const tagged = parseReviewReport({
      summary: "- [BLOCKER] src/db.ts:18 - Unparameterized SQL query",
      engine: "claude",
    });
    expect(tagged.verdict).toBe("changes_requested");
    expect(tagged.findings[0]!.severity).toBe("blocker");
    expect(tagged.findings[0]!.file).toBe("src/db.ts");
    expect(tagged.findings[0]!.line).toBe(18);

    const legacyRejected = parseReviewReport({
      summary: "VERDICT: REJECTED - Missing null guard",
      engine: "claude",
    });
    expect(legacyRejected.verdict).toBe("changes_requested");
    expect(legacyRejected.findings).toHaveLength(1);
    expect(legacyRejected.findings[0]!.severity).toBe("major");
  });
});

describe("Heterogeneous Real-Engine Review Routing (v0.5.0)", () => {
  it("never falls back to mock when real engines implemented the code", () => {
    const repo = makeRepo({
      preferredImplementEngine: "claude",
      preferredReviewEngine: "mock",
    });

    // When both claude & codex are available, pick codex over mock
    expect(
      selectReviewEngine({
        repo,
        implementEngine: "claude",
        availableEngines: ["claude", "codex", "mock"],
      }),
    ).toBe("codex");

    // When only claude + mock exist, stay on claude for isolated blind review rather than mock
    expect(
      selectReviewEngine({
        repo,
        implementEngine: "claude",
        availableEngines: ["claude", "mock"],
      }),
    ).toBe("claude");

    // When mock explicitly ran implementation (test/demo), allow mock review
    expect(
      selectReviewEngine({
        repo,
        implementEngine: "mock",
        availableEngines: ["mock"],
      }),
    ).toBe("mock");
  });
});

describe("Self-Evolving Playbook Context Selection (v0.5.0)", () => {
  it("prioritizes pinned + matching-scope rules and enforces <= 8 items & <= 1200 chars", () => {
    const baseTs = "2026-11-23T00:00:00.000Z";
    const entries: PlaybookEntry[] = [
      {
        id: "pbk_disjoint",
        repoId: "repo_1",
        rule: "Only applies to frontend CSS",
        scopePaths: ["packages/web/**"],
        source: "human",
        enabled: true,
        pinned: false,
        createdAt: baseTs,
        updatedAt: baseTs,
      },
      {
        id: "pbk_pinned",
        repoId: "repo_1",
        rule: "Pinned global invariant",
        scopePaths: ["**"],
        source: "auto_healed",
        enabled: true,
        pinned: true,
        createdAt: baseTs,
        updatedAt: baseTs,
      },
      {
        id: "pbk_disabled",
        repoId: "repo_1",
        rule: "Disabled rule must not appear",
        scopePaths: ["packages/core/**"],
        source: "human",
        enabled: false,
        pinned: true,
        createdAt: baseTs,
        updatedAt: baseTs,
      },
      ...Array.from({ length: 12 }, (_, idx) => ({
        id: `pbk_core_${idx}`,
        repoId: "repo_1",
        rule: `Core rule #${idx}: keep functions deterministic and preserve backward compatibility across callers `.repeat(2).trim(),
        scopePaths: ["packages/core/**"],
        source: (idx % 2 === 0 ? "human" : "auto_healed") as PlaybookEntry["source"],
        enabled: true,
        pinned: false,
        createdAt: baseTs,
        updatedAt: `2026-11-23T00:${String(idx).padStart(2, "0")}:00.000Z`,
      })),
    ];

    const selected = selectPlaybookRulesForContext(entries, ["packages/core/**"], 8, 1200);
    expect(selected.length).toBeLessThanOrEqual(8);
    expect(selected[0]!.id).toBe("pbk_pinned");
    expect(selected.some((e) => e.id === "pbk_disjoint")).toBe(false);
    expect(selected.some((e) => e.id === "pbk_disabled")).toBe(false);

    const formatted = formatPlaybookContext(entries, ["packages/core/**"], 8, 1200);
    expect(formatted.length).toBeLessThanOrEqual(1200);
    expect(formatted).toContain("[PIN]");
  });
});
