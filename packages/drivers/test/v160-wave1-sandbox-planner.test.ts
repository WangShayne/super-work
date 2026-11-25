import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  buildClaudeCliArgs,
  buildMacosSeatbeltProfile,
  planImpactScopedVerification,
  verifyHotspotParityImpl,
  type WorkspacePackageInfo,
} from "../src/index.ts";

const cleanup: string[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    await rm(cleanup.pop()!, { recursive: true, force: true });
  }
});

async function put(root: string, rel: string, body: string): Promise<void> {
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, body, "utf8");
}

describe("v1.6.0 seatbelt claude engine temp allowlist", () => {
  const base = {
    worktreePath: "/Users/someone/wt/tkt",
    rootRepoPath: "/Users/someone/repo",
    sandboxTempDir: "/Users/someone/wt/tkt/.sw-tmp",
    hostTempDirs: ["/var/folders/zz/abc/T"],
  };
  const allowLine = (profile: string): string =>
    profile.split("\n").find((l) => l.startsWith("(allow file-write*")) ?? "";
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;

  it("allows only uid-scoped claude temp paths for claude + balanced", () => {
    if (uid === undefined) return;
    const profile = buildMacosSeatbeltProfile({ ...base, mode: "balanced", engine: "claude" });
    const allow = allowLine(profile);
    expect(allow).toContain(`(subpath "/private/tmp/claude-${uid}")`);
    expect(allow).toContain(`(subpath "/tmp/claude-${uid}")`);
    // broad temp roots stay denied and are never allowed
    expect(allow).not.toContain('(subpath "/private/tmp")');
    expect(allow).not.toContain('(subpath "/tmp")');
    const deny = profile.split("\n").find((l) => l.startsWith("(deny file-write*")) ?? "";
    expect(deny).toContain('(subpath "/private/tmp")');
    expect(deny).toContain('(subpath "/tmp")');
    expect(deny).toContain('(subpath "/Users/someone/repo")');
    // secret wall remains and comes after the allow rule
    expect(profile).toContain(".ssh");
    expect(profile).toContain(".env");
    expect(profile.lastIndexOf(".ssh")).toBeGreaterThan(profile.indexOf(allow));
  });

  it("does not inject claude-<uid> for other engines or strict mode", () => {
    const codex = buildMacosSeatbeltProfile({ ...base, mode: "balanced", engine: "codex" });
    const none = buildMacosSeatbeltProfile({ ...base, mode: "balanced" });
    const strict = buildMacosSeatbeltProfile({ ...base, mode: "strict", engine: "claude" });
    for (const p of [codex, none, strict]) {
      expect(allowLine(p)).not.toContain("claude-");
    }
  });
});

describe("v1.6.0 claude plan stdout-only contract", () => {
  it("appends the no-Write directive to the plan prompt only", () => {
    const input = {
      stage: "plan",
      prompt: "PROMPT",
      mandate: { maxCostUsd: 0 },
    } as unknown as Parameters<typeof buildClaudeCliArgs>[0];
    const plan = buildClaudeCliArgs(input);
    expect(plan[plan.length - 1]).toContain("PROMPT");
    expect(plan[plan.length - 1]).toContain("~/.claude/plans");
    const impl = buildClaudeCliArgs({ ...input, stage: "implement" });
    expect(impl[impl.length - 1]).toBe("PROMPT");
  });
});

describe("v1.6.0 hotspot parity symbol migration", () => {
  it("reports where moved exports live and which modules are new", async () => {
    const root = await mkdtemp(join(tmpdir(), "sw-v160-"));
    cleanup.push(root);
    const baseFiles: Record<string, string> = {
      "packages/core/src/big.ts": "export function alpha() {}\nexport const beta = 1;\nexport interface Gamma {}\n",
    };
    await put(
      root,
      "packages/core/src/big.ts",
      'export * from "./big-helpers.ts";\nexport { beta } from "./big-consts.ts";\n',
    );
    await put(root, "packages/core/src/big-helpers.ts", "export function alpha() {}\nexport interface Gamma {}\n");
    await put(root, "packages/core/src/big-consts.ts", "export const beta = 1;\n");

    const res = await verifyHotspotParityImpl({
      worktreePath: root,
      baseBranch: "main",
      targetHotspotPath: "packages/core/src/big.ts",
      maxLinesAfter: 50,
      enforceExportParity: true,
      readBase: async (rel) => baseFiles[rel] ?? null,
      listChangedFiles: async () => [
        "packages/core/src/big.ts",
        "packages/core/src/big-helpers.ts",
        "packages/core/src/big-consts.ts",
        "packages/core/README.md",
      ],
    });
    expect(res.ok).toBe(true);
    expect(res.newModuleFiles).toEqual([
      "packages/core/src/big-consts.ts",
      "packages/core/src/big-helpers.ts",
    ]);
    expect(res.symbolMigrationMap).toEqual([
      { symbol: "alpha", targetFile: "packages/core/src/big-helpers.ts" },
      { symbol: "beta", targetFile: "packages/core/src/big-consts.ts" },
      { symbol: "Gamma", targetFile: "packages/core/src/big-helpers.ts" },
    ]);
  });
});

describe("v1.6.0 cross-package impact pruning", () => {
  const FULL = ["bun run typecheck", "bun test", "bun run build"];
  const pkg = (dir: string, dependsOn: string[] = [], tests: string[] = []): WorkspacePackageInfo => ({
    dir,
    name: `@super-work/${dir}`,
    dependsOn,
    testFiles: tests.map((t) => `packages/${dir}/test/${t}`),
  });
  const packages = [
    pkg("core", [], ["core.test.ts", "other.test.ts"]),
    pkg("drivers", ["@super-work/core"], ["drivers.test.ts", "extra.test.ts"]),
    pkg("server", ["@super-work/core", "@super-work/drivers"], ["server.test.ts"]),
    pkg("cli", ["@super-work/core", "@super-work/drivers"], ["cli.test.ts"]),
    pkg("web", [], []),
  ];

  it("narrows tests across changed packages and skips build when web is unaffected", () => {
    const changedFiles = ["packages/drivers/src/b.ts", "packages/cli/src/c.ts"];
    const plan = planImpactScopedVerification({
      fullCommands: FULL,
      changedFiles,
      packages,
      symbolImpact: {
        targetFiles: changedFiles,
        directDependents: ["packages/drivers/test/drivers.test.ts", "packages/cli/test/cli.test.ts"],
        transitiveDependents: [],
      },
    });
    expect(plan.useScoped).toBe(true);
    expect(plan.commands).toContain(
      "bun test packages/cli/test/cli.test.ts packages/drivers/test/drivers.test.ts",
    );
    expect(plan.commands).not.toContain("bun run build");
  });

  it("keeps the package test dir when a changed package has no mapped tests", () => {
    const changedFiles = ["packages/drivers/src/b.ts", "packages/cli/src/c.ts"];
    const plan = planImpactScopedVerification({
      fullCommands: FULL,
      changedFiles,
      packages,
      symbolImpact: {
        targetFiles: changedFiles,
        directDependents: ["packages/drivers/test/drivers.test.ts"],
        transitiveDependents: [],
      },
    });
    const testCmd = plan.commands.find((c) => c.startsWith("bun test")) ?? "";
    expect(testCmd).toContain("packages/cli/test");
    expect(testCmd).toContain("packages/drivers/test/drivers.test.ts");
  });

  it("stays full on the final delivery gate", () => {
    const changedFiles = ["packages/core/src/a.ts", "packages/drivers/src/b.ts"];
    const plan = planImpactScopedVerification({
      fullCommands: FULL,
      changedFiles,
      packages,
      isFinalDeliveryGate: true,
      symbolImpact: { targetFiles: changedFiles, directDependents: [], transitiveDependents: [] },
    });
    expect(plan.useScoped).toBe(false);
    expect(plan.commands).toEqual(FULL);
  });
});
