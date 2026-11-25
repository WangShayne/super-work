import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  GitWorktreeProvider,
  SqliteStateStore,
  buildMacosSeatbeltProfile,
  planImpactScopedVerification,
  runGit,
  wrapCommandWithOsSandbox,
  type WorkspacePackageInfo,
} from "../src/index.ts";

const cleanup: string[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    await rm(cleanup.pop()!, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "sw-v150-"));
  cleanup.push(d);
  return d;
}

async function put(root: string, rel: string, body: string): Promise<void> {
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, body, "utf8");
}

describe("v1.5.0 SQLite engine_health", () => {
  it("round-trips, overwrites and lists engine health records", async () => {
    const dir = await tempDir();
    const store = new SqliteStateStore(join(dir, "state.db"));
    expect(await store.getEngineHealth("claude")).toBeNull();
    await store.saveEngineHealth({
      engine: "claude",
      status: "tripped",
      failureKind: "model_unsupported",
      reason: "model is not supported",
      trippedAt: "2026-11-25T00:00:00.000Z",
      cooldownUntil: "2026-11-25T00:30:00.000Z",
      consecutiveFailures: 2,
      updatedAt: "2026-11-25T00:00:00.000Z",
    });
    await store.saveEngineHealth({
      engine: "codex",
      status: "healthy",
      consecutiveFailures: 0,
      updatedAt: "2026-11-25T00:00:00.000Z",
    });
    const claude = await store.getEngineHealth("claude");
    expect(claude?.status).toBe("tripped");
    expect(claude?.failureKind).toBe("model_unsupported");
    expect(claude?.consecutiveFailures).toBe(2);
    expect(claude?.cooldownUntil).toBe("2026-11-25T00:30:00.000Z");

    await store.saveEngineHealth({
      engine: "claude",
      status: "healthy",
      consecutiveFailures: 0,
      updatedAt: "2026-11-25T01:00:00.000Z",
    });
    const all = await store.listEngineHealth();
    expect(all.map((r) => r.engine)).toEqual(["claude", "codex"]);
    expect(all[0]?.status).toBe("healthy");
    expect(all[0]?.failureKind).toBeUndefined();
  });
});

describe("v1.5.0 root repo spillover shield", () => {
  it("quarantines new spillover while preserving pre-existing dirty paths", async () => {
    const parent = await tempDir();
    const repo = join(parent, "repo");
    await mkdir(repo, { recursive: true });
    await runGit(["init", "-b", "main"], repo);
    await runGit(["config", "user.name", "T"], repo);
    await runGit(["config", "user.email", "t@example.com"], repo);
    await runGit(["config", "commit.gpgsign", "false"], repo);
    await put(repo, "a.txt", "a0\n");
    await put(repo, "b.txt", "b0\n");
    await runGit(["add", "-A"], repo);
    await runGit(["commit", "-m", "init"], repo);

    // Pre-existing dirt (user's own work)
    await put(repo, "a.txt", "a-user-edit\n");
    await put(repo, "user-notes.txt", "keep me\n");

    const provider = new GitWorktreeProvider(join(parent, "wt"));
    const pre = await provider.snapshotRepoDirtyPaths(repo);
    expect(pre).toEqual(["a.txt", "user-notes.txt"]);

    // Worker spillover
    await put(repo, "b.txt", "b-spill\n");
    await put(repo, "leak/new.ts", "export const leak = 1;\n");

    const res = await provider.quarantineRepoSpillover({ rootRepoPath: repo, preTurnDirtyPaths: pre });
    expect(res.quarantinedPaths).toEqual(["b.txt", "leak/new.ts"]);
    expect(res.diffSummary).toContain("b-spill");
    expect(res.diffSummary).toContain("leak/new.ts");

    expect(await readFile(join(repo, "b.txt"), "utf8")).toBe("b0\n");
    expect(existsSync(join(repo, "leak/new.ts"))).toBe(false);
    expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("a-user-edit\n");
    expect(await readFile(join(repo, "user-notes.txt"), "utf8")).toBe("keep me\n");

    const again = await provider.quarantineRepoSpillover({ rootRepoPath: repo, preTurnDirtyPaths: pre });
    expect(again.quarantinedPaths).toEqual([]);
  });
});

describe("v1.5.0 impact planner (2nd gen)", () => {
  const FULL = ["bun run typecheck", "bun test", "bun run build"];
  const pkg = (dir: string, dependsOn: string[] = [], tests: string[] = []): WorkspacePackageInfo => ({
    dir,
    name: `@super-work/${dir}`,
    dependsOn,
    testFiles: tests.map((t) => `packages/${dir}/test/${t}`),
  });
  const packages = [
    pkg("core", [], ["core.test.ts"]),
    pkg("drivers", ["@super-work/core"], ["drivers.test.ts"]),
    pkg("server", ["@super-work/core", "@super-work/drivers"], ["server.test.ts"]),
    pkg("cli", ["@super-work/core", "@super-work/drivers"], ["cli.test.ts"]),
    pkg("web", [], []),
  ];

  it("fast-passes docs-only diffs on intermediate gates but not on the final gate", () => {
    const changedFiles = ["README.md", "USAGE.md", "docs/guide.md", "CHANGELOG.md", "LICENSE"];
    const plan = planImpactScopedVerification({ fullCommands: FULL, changedFiles, packages, symbolImpact: null });
    expect(plan.useScoped).toBe(true);
    expect(plan.commands).toEqual([]);
    expect(plan.estimatedSavedMs).toBe(88_000);
    expect(plan.reason).toBe("docs-only changes; skipping code test/build on intermediate gate");

    const final = planImpactScopedVerification({
      fullCommands: FULL,
      changedFiles,
      packages,
      symbolImpact: null,
      isFinalDeliveryGate: true,
    });
    expect(final.useScoped).toBe(false);
    expect(final.commands).toEqual(FULL);
  });

  it("does not fast-pass docs mixed with code or package.json", () => {
    const mixed = planImpactScopedVerification({
      fullCommands: FULL,
      changedFiles: ["README.md", "packages/core/src/types.ts"],
      packages,
      symbolImpact: { targetFiles: ["packages/core/src/types.ts"], directDependents: [], transitiveDependents: [] },
    });
    expect(mixed.commands.length).toBeGreaterThan(0);
    const pkgJson = planImpactScopedVerification({
      fullCommands: FULL,
      changedFiles: ["README.md", "package.json"],
      packages,
      symbolImpact: null,
    });
    expect(pkgJson.useScoped).toBe(false);
  });

  it("prunes tests to impacted files (<=20) even when every package is affected", () => {
    const plan = planImpactScopedVerification({
      fullCommands: FULL,
      changedFiles: ["packages/core/src/pipeline.ts"],
      packages,
      symbolImpact: {
        targetFiles: ["packages/core/src/pipeline.ts"],
        directDependents: ["packages/core/test/core.test.ts", "packages/drivers/src/x.ts"],
        transitiveDependents: ["packages/server/test/server.test.ts"],
      },
    });
    expect(plan.useScoped).toBe(true);
    const testCmd = plan.commands.find((c) => c.startsWith("bun test"));
    expect(testCmd).toBe("bun test packages/core/test/core.test.ts packages/server/test/server.test.ts");
  });

  it("keeps full test fallback for capped graphs, sensitive paths and the final gate", () => {
    const targetFiles = ["packages/core/src/pipeline.ts"];
    const capped = planImpactScopedVerification({
      fullCommands: FULL,
      changedFiles: targetFiles,
      packages,
      symbolImpact: {
        targetFiles,
        directDependents: Array.from({ length: 30 }, (_, i) => `packages/drivers/test/t${i}.test.ts`),
        transitiveDependents: [],
      },
    });
    expect(capped.commands).toContain("bun test packages/cli/test packages/core/test packages/drivers/test packages/server/test");

    const sensitive = planImpactScopedVerification({
      fullCommands: FULL,
      changedFiles: targetFiles,
      sensitivePaths: ["packages/core/**"],
      packages,
      symbolImpact: { targetFiles, directDependents: [], transitiveDependents: [] },
    });
    expect(sensitive.useScoped).toBe(false);

    const final = planImpactScopedVerification({
      fullCommands: FULL,
      changedFiles: targetFiles,
      packages,
      isFinalDeliveryGate: true,
      symbolImpact: { targetFiles, directDependents: ["packages/core/test/core.test.ts"], transitiveDependents: [] },
    });
    expect(final.useScoped).toBe(false);
    expect(final.commands).toEqual(FULL);
  });
});

describe("v1.5.0 seatbelt temp dirs & balanced verification", () => {
  it("allows file-write* inside host temp dirs", () => {
    const profile = buildMacosSeatbeltProfile({
      worktreePath: "/tmp/sw-wt",
      sandboxTempDir: "/tmp/sw-sandbox-tmp",
      hostTempDirs: ["/var/folders/zz/abc123/T"],
      mode: "balanced",
    });
    expect(profile).toContain('(subpath "/var/folders/zz/abc123/T")');
    const allowLine = profile.split("\n").find((l) => l.startsWith("(allow file-write*")) ?? "";
    expect(allowLine).toContain("/var/folders/zz/abc123/T");

    const defaulted = buildMacosSeatbeltProfile({
      worktreePath: "/tmp/sw-wt",
      sandboxTempDir: "/tmp/sw-sandbox-tmp",
      mode: "balanced",
    });
    expect(defaulted).toContain(tmpdir());
  });

  it("balanced verification skips the outer sandbox but keeps env scrubbing; strict wraps", () => {
    const base = {
      commandArgv: ["sh", "-lc", "true"],
      worktreePath: "/tmp/sw-wt",
      engine: "verification" as const,
      baseEnv: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "secret" } as NodeJS.ProcessEnv,
    };
    const balanced = wrapCommandWithOsSandbox({ ...base, mode: "balanced", skipOuterSandbox: true });
    expect(balanced.appliedBackend).toBe("env_only");
    expect(balanced.argv).toEqual(base.commandArgv);
    expect(balanced.env.ANTHROPIC_API_KEY).toBeUndefined();

    if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
      const strict = wrapCommandWithOsSandbox({ ...base, mode: "strict" });
      expect(strict.appliedBackend).toBe("seatbelt");
    }
  });
});
