import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  createDefaultMandate,
  newId,
  normalizeVerificationStrategy,
  nowIso,
  type RepoConfig,
  type SpillArtifact,
  type StageRun,
  type Ticket,
  type VerificationRunResult,
  type WorkspaceProvider,
} from "@super-work/core";
import type { KernelCoordinatorContext } from "../../core/src/kernel/context.ts";
import { runRepoVerificationGateOp } from "../../core/src/kernel/stage-execution-coordinator.ts";
import {
  GitWorktreeProvider,
  SqliteStateStore,
  planImpactScopedVerification,
  runGit,
  type WorkspacePackageInfo,
} from "../src/index.ts";

const FULL_COMMANDS = ["bun run typecheck", "bun test", "bun run build"];
const SANDBOX_SENSITIVE = ["packages/drivers/src/sandbox/**"];

async function put(root: string, rel: string, body: string): Promise<void> {
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, body, "utf8");
}

function pkgJson(
  name: string,
  deps: string[] = [],
  scripts: Record<string, string> = { typecheck: "tsc --noEmit" },
): string {
  return JSON.stringify({
    name: `@super-work/${name}`,
    version: "1.0.0",
    scripts,
    ...(deps.length > 0
      ? { dependencies: Object.fromEntries(deps.map((d) => [`@super-work/${d}`, "workspace:*"])) }
      : {}),
  });
}

/**
 * core <- drivers <- server, cli   (web is standalone: it mirrors core types without declaring the dep)
 */
async function createMonorepoFixture(parent: string): Promise<string> {
  const repoDir = join(parent, "repo");
  await mkdir(repoDir, { recursive: true });
  await runGit(["init", "-b", "main"], repoDir);
  await runGit(["config", "user.name", "Test User"], repoDir);
  await runGit(["config", "user.email", "test@example.com"], repoDir);
  await runGit(["config", "commit.gpgsign", "false"], repoDir);

  await put(repoDir, "package.json", JSON.stringify({ name: "fixture", private: true, workspaces: ["packages/*"] }));
  await put(repoDir, "bun.lock", "{}\n");
  await put(repoDir, "tsconfig.base.json", "{}\n");
  await put(repoDir, "scripts/dev.ts", "export const dev = 1;\n");

  await put(repoDir, "packages/core/package.json", pkgJson("core"));
  await put(repoDir, "packages/core/src/types.ts", "export type Id = string;\n");
  await put(repoDir, "packages/core/src/index.ts", 'export * from "./types.ts";\n');
  await put(repoDir, "packages/core/test/core.test.ts", 'import "../src/index.ts";\n');

  await put(repoDir, "packages/drivers/package.json", pkgJson("drivers", ["core"]));
  await put(
    repoDir,
    "packages/drivers/src/index.ts",
    'import type { Id } from "@super-work/core";\nexport const driverId: Id = "d";\n',
  );
  await put(repoDir, "packages/drivers/src/sandbox/os-sandbox.ts", "export const sandbox = 1;\n");
  await put(repoDir, "packages/drivers/test/drivers.test.ts", 'import "../src/index.ts";\n');

  for (const name of ["server", "cli"]) {
    await put(repoDir, `packages/${name}/package.json`, pkgJson(name, ["core", "drivers"]));
    await put(
      repoDir,
      `packages/${name}/src/index.ts`,
      'import "@super-work/core";\nimport "@super-work/drivers";\nexport const name = 1;\n',
    );
    await put(repoDir, `packages/${name}/test/${name}.test.ts`, 'import "../src/index.ts";\n');
  }

  await put(
    repoDir,
    "packages/web/package.json",
    pkgJson("web", [], { build: "vite build", typecheck: "tsc --noEmit" }),
  );
  await put(repoDir, "packages/web/src/App.tsx", "export const App = 1;\n");

  await runGit(["add", "-A"], repoDir);
  await runGit(["commit", "-m", "init monorepo"], repoDir);
  return repoDir;
}

function makeRepo(rootPath: string, overrides: Partial<RepoConfig> = {}): RepoConfig {
  const ts = nowIso();
  return {
    id: "repo_impact",
    name: "impact",
    rootPath,
    baseBranch: "main",
    mode: "auto",
    defaultTemplate: "fast",
    preferredImplementEngine: "claude",
    preferredReviewEngine: "claude",
    verificationCommands: FULL_COMMANDS,
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  const ts = nowIso();
  return {
    id: "tkt_impact",
    repoId: "repo_impact",
    threadId: "thr_1",
    sourceTriggerId: "trg_1",
    title: "impact gate",
    description: "desc",
    status: "implementing",
    template: "fast",
    currentStage: "implement",
    stageRetries: 0,
    mandate: createDefaultMandate({ allowedPaths: ["packages/**"], maxCostUsd: 1 }),
    dependsOn: [],
    nativeSessions: {},
    inlineMemory: { goal: "goal", acceptanceCriteria: [], stageNotes: [], threadUpdates: [] },
    costUsd: 0,
    priority: 1,
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

function makeStageRun(): StageRun {
  return {
    id: "sr_impact",
    ticketId: "tkt_impact",
    stage: "implement",
    engine: "mock",
    status: "running",
    costUsd: 0,
    startedAt: nowIso(),
  };
}

type ScopedPlanner = NonNullable<WorkspaceProvider["resolveScopedVerification"]>;

function createGateHarness(planner?: ScopedPlanner) {
  const executed: string[][] = [];
  const plannerCalls: Array<Parameters<ScopedPlanner>[0]> = [];
  const events: Array<{ type: string; result?: VerificationRunResult }> = [];

  const workspace: Partial<WorkspaceProvider> = {
    runVerificationCommands: async (_worktreePath, commands) => {
      executed.push(commands);
      return {
        ok: true,
        results: commands.map((command) => ({ command, exitCode: 0, durationMs: 1, output: "" })),
        summary: `All ${commands.length} verification command(s) passed`,
      };
    },
    ...(planner
      ? {
          resolveScopedVerification: async (input: Parameters<ScopedPlanner>[0]) => {
            plannerCalls.push(input);
            return planner(input);
          },
        }
      : {}),
  };

  const ctx = {
    workspace,
    artifactStore: {
      writeSpill: async (
        meta: { ticketId: string; stageRunId?: string; kind: SpillArtifact["kind"]; summary: string },
        content: string,
      ): Promise<SpillArtifact> => ({
        id: newId("art"),
        ticketId: meta.ticketId,
        stageRunId: meta.stageRunId,
        kind: meta.kind,
        summary: meta.summary,
        storageUri: "memory://spill",
        byteSize: content.length,
        createdAt: nowIso(),
      }),
    },
    stateStore: { saveArtifact: async () => {} },
    emitEvent: (ev: { type: string; result?: VerificationRunResult }) => {
      events.push(ev);
    },
  } as unknown as KernelCoordinatorContext;

  return { ctx, executed, plannerCalls, events };
}

describe("v1.4.0 Impact-Scoped Verification Gate", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const d of tempDirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  async function newFixture(): Promise<{ repoDir: string; provider: GitWorktreeProvider }> {
    const dir = await mkdtemp(join(tmpdir(), "sw-v140-"));
    tempDirs.push(dir);
    const repoDir = await createMonorepoFixture(dir);
    return { repoDir, provider: new GitWorktreeProvider(join(dir, "worktrees")) };
  }

  describe("(a) scoped change in packages/cli", () => {
    it("narrows typecheck & bun test to packages/cli and skips bun run build (uncommitted + committed)", async () => {
      const { repoDir, provider } = await newFixture();
      expect(typeof provider.resolveScopedVerification).toBe("function");

      await put(repoDir, "packages/cli/src/index.ts", 'import "@super-work/core";\nexport const name = 2;\n');

      const input = {
        rootRepoPath: repoDir,
        worktreePath: repoDir,
        baseBranch: "main",
        fullCommands: FULL_COMMANDS,
      };
      const uncommitted = await provider.resolveScopedVerification(input);
      expect(uncommitted.useScoped).toBe(true);
      expect(uncommitted.commands).toEqual([
        "bun run --cwd packages/cli typecheck",
        "bun test packages/cli/test",
      ]);
      expect(uncommitted.commands.some((c) => c.includes("bun run build"))).toBe(false);
      expect(uncommitted.estimatedSavedMs).toBe(85_000);

      await runGit(["checkout", "-b", "feat/cli"], repoDir);
      await runGit(["add", "-A"], repoDir);
      await runGit(["commit", "-m", "cli change"], repoDir);
      const committed = await provider.resolveScopedVerification(input);
      expect(committed.useScoped).toBe(true);
      expect(committed.commands).toEqual(uncommitted.commands);
    });

    it("keeps unrecognised custom commands as-is and in their original position", async () => {
      const { repoDir, provider } = await newFixture();
      await put(repoDir, "packages/cli/src/index.ts", 'import "@super-work/core";\nexport const name = 3;\n');

      const res = await provider.resolveScopedVerification({
        rootRepoPath: repoDir,
        worktreePath: repoDir,
        baseBranch: "main",
        fullCommands: ["bun run typecheck", "bun run lint", "bun test"],
      });
      expect(res.useScoped).toBe(true);
      expect(res.commands).toEqual([
        "bun run --cwd packages/cli typecheck",
        "bun run lint",
        "bun test packages/cli/test",
      ]);
    });

    it("includes untracked new files in the change set", async () => {
      const { repoDir, provider } = await newFixture();
      await put(repoDir, "packages/cli/src/extra.ts", "export const extra = 1;\n");

      const res = await provider.resolveScopedVerification({
        rootRepoPath: repoDir,
        worktreePath: repoDir,
        baseBranch: "main",
        fullCommands: FULL_COMMANDS,
      });
      expect(res.useScoped).toBe(true);
      expect(res.commands[0]).toBe("bun run --cwd packages/cli typecheck");
    });
  });

  describe("(b) core change propagates to dependents", () => {
    it("typechecks core, drivers, server, cli and web; keeps the web build; covers dependent tests", async () => {
      const { repoDir, provider } = await newFixture();
      await put(repoDir, "packages/core/src/types.ts", "export type Id = string;\nexport type Name = string;\n");

      const res = await provider.resolveScopedVerification({
        rootRepoPath: repoDir,
        worktreePath: repoDir,
        baseBranch: "main",
        fullCommands: FULL_COMMANDS,
      });

      expect(res.useScoped).toBe(true);
      const typechecks = res.commands.filter((c) => c.endsWith(" typecheck"));
      expect(typechecks).toEqual([
        "bun run --cwd packages/cli typecheck",
        "bun run --cwd packages/core typecheck",
        "bun run --cwd packages/drivers typecheck",
        "bun run --cwd packages/server typecheck",
        "bun run --cwd packages/web typecheck",
      ]);
      expect(res.commands).toContain("bun run build");

      const testCmd = res.commands.find((c) => c.startsWith("bun test"));
      expect(testCmd).toBeDefined();
      for (const pkg of ["core", "drivers", "server", "cli"]) {
        expect(testCmd).toContain(`packages/${pkg}/test`);
      }
      expect(testCmd).not.toContain("packages/web");
      expect(res.estimatedSavedMs).toBeGreaterThan(0);
    });

    it("web-only change typechecks and builds web and omits bun test entirely", async () => {
      const { repoDir, provider } = await newFixture();
      await put(repoDir, "packages/web/src/App.tsx", "export const App = 2;\n");

      const res = await provider.resolveScopedVerification({
        rootRepoPath: repoDir,
        worktreePath: repoDir,
        baseBranch: "main",
        fullCommands: FULL_COMMANDS,
      });
      expect(res.useScoped).toBe(true);
      expect(res.commands).toEqual(["bun run --cwd packages/web typecheck", "bun run build"]);
      expect(res.estimatedSavedMs).toBe(85_000);
    });

    it("falls back to package-level test dirs when the symbol graph is capped (pure planner)", () => {
      const pkg = (dir: string, dependsOn: string[] = [], withTests = true): WorkspacePackageInfo => ({
        dir,
        name: `@super-work/${dir}`,
        dependsOn,
        testFiles: withTests ? [`packages/${dir}/test/${dir}.test.ts`] : [],
      });
      const plan = planImpactScopedVerification({
        fullCommands: FULL_COMMANDS,
        changedFiles: ["packages/core/src/types.ts"],
        packages: [
          pkg("core"),
          pkg("drivers", ["@super-work/core"]),
          pkg("server", ["@super-work/core", "@super-work/drivers"]),
          pkg("cli", ["@super-work/core", "@super-work/drivers"]),
          pkg("web", [], false),
        ],
        symbolImpact: {
          targetFiles: ["packages/core/src/types.ts"],
          directDependents: Array.from({ length: 30 }, (_, i) => `packages/drivers/src/f${i}.ts`),
          transitiveDependents: [],
        },
      });
      expect(plan.useScoped).toBe(true);
      expect(plan.commands).toContain(
        "bun test packages/cli/test packages/core/test packages/drivers/test packages/server/test",
      );
    });
  });

  describe("(c) full-verification fallbacks", () => {
    async function expectFullFallback(
      mutate: (repoDir: string) => Promise<void>,
      opts: { sensitivePaths?: string[]; reason?: RegExp } = {},
    ): Promise<void> {
      const { repoDir, provider } = await newFixture();
      await mutate(repoDir);
      const res = await provider.resolveScopedVerification({
        rootRepoPath: repoDir,
        worktreePath: repoDir,
        baseBranch: "main",
        fullCommands: FULL_COMMANDS,
        sensitivePaths: opts.sensitivePaths,
      });
      expect(res.useScoped).toBe(false);
      expect(res.commands).toEqual(FULL_COMMANDS);
      expect(res.estimatedSavedMs).toBe(0);
      if (opts.reason) expect(res.reason).toMatch(opts.reason);
    }

    it("root package.json", async () => {
      await expectFullFallback(
        (r) => put(r, "package.json", JSON.stringify({ name: "fixture", private: true, version: "2" })),
        { reason: /package\.json/ },
      );
    });

    it("scripts/dev.ts", async () => {
      await expectFullFallback((r) => put(r, "scripts/dev.ts", "export const dev = 2;\n"), {
        reason: /scripts\/dev\.ts/,
      });
    });

    it("bun.lock and tsconfig*.json", async () => {
      await expectFullFallback((r) => put(r, "bun.lock", '{ "lockfileVersion": 1 }\n'));
      await expectFullFallback((r) => put(r, "tsconfig.base.json", '{ "compilerOptions": {} }\n'));
    });

    it("sensitivePaths (packages/drivers/src/sandbox/**)", async () => {
      await expectFullFallback(
        (r) => put(r, "packages/drivers/src/sandbox/os-sandbox.ts", "export const sandbox = 2;\n"),
        { sensitivePaths: SANDBOX_SENSITIVE, reason: /sensitive path/ },
      );
    });

    it("without sensitivePaths the same sandbox change is scoped (control)", async () => {
      const { repoDir, provider } = await newFixture();
      await put(repoDir, "packages/drivers/src/sandbox/os-sandbox.ts", "export const sandbox = 2;\n");
      const res = await provider.resolveScopedVerification({
        rootRepoPath: repoDir,
        worktreePath: repoDir,
        baseBranch: "main",
        fullCommands: FULL_COMMANDS,
      });
      expect(res.useScoped).toBe(true);
    });

    it("empty diff, files outside packages/, and unresolvable base branch", async () => {
      await expectFullFallback(async () => {}, { reason: /no changed files/ });
      await expectFullFallback((r) => put(r, "README.md", "# docs\n"), { reason: /outside known workspace/ });

      const { repoDir, provider } = await newFixture();
      await put(repoDir, "packages/cli/src/index.ts", "export const name = 9;\n");
      const res = await provider.resolveScopedVerification({
        rootRepoPath: repoDir,
        worktreePath: repoDir,
        baseBranch: "does-not-exist",
        fullCommands: FULL_COMMANDS,
      });
      expect(res.useScoped).toBe(false);
      expect(res.commands).toEqual(FULL_COMMANDS);
      expect(res.reason).toMatch(/git diff/);
    });
  });

  describe("(d) runRepoVerificationGateOp", () => {
    const SCOPED_COMMANDS = ["bun run --cwd packages/cli typecheck", "bun test packages/cli/test"];
    const scopedPlanner: ScopedPlanner = async () => ({
      useScoped: true,
      commands: SCOPED_COMMANDS,
      estimatedSavedMs: 85_000,
      reason: "cli only",
    });

    it("isFinalDeliveryGate: true ALWAYS runs the full commands under impact_scoped and never calls the planner", async () => {
      const h = createGateHarness(scopedPlanner);
      const repo = makeRepo("/tmp/root", { verificationStrategy: "impact_scoped" });

      const res = await runRepoVerificationGateOp(h.ctx, makeTicket(), repo, makeStageRun(), "/tmp/wt", {
        isFinalDeliveryGate: true,
      });

      expect(res.passed).toBe(true);
      expect(h.executed).toEqual([FULL_COMMANDS]);
      expect(h.plannerCalls).toHaveLength(0);
      expect(res.result?.scopedVerification).toEqual({
        usedScoped: false,
        commandsRun: FULL_COMMANDS,
        reason: "final delivery gate enforces full verification",
      });
    });

    it("non-final gate executes the scoped commands and records the scoped metadata", async () => {
      const h = createGateHarness(scopedPlanner);
      const repo = makeRepo("/tmp/root", {
        verificationStrategy: "impact_scoped",
        sensitivePaths: SANDBOX_SENSITIVE,
      });

      const res = await runRepoVerificationGateOp(h.ctx, makeTicket(), repo, makeStageRun(), "/tmp/wt", {
        isFinalDeliveryGate: false,
      });

      expect(h.executed).toEqual([SCOPED_COMMANDS]);
      expect(h.plannerCalls).toEqual([
        {
          rootRepoPath: "/tmp/root",
          worktreePath: "/tmp/wt",
          baseBranch: "main",
          fullCommands: FULL_COMMANDS,
          sensitivePaths: SANDBOX_SENSITIVE,
        },
      ]);
      expect(res.result?.scopedVerification).toEqual({
        usedScoped: true,
        commandsRun: SCOPED_COMMANDS,
        skippedFullCommands: FULL_COMMANDS,
        estimatedSavedMs: 85_000,
        reason: "cli only",
      });
      expect(h.events.find((e) => e.type === "verification_completed")?.result?.scopedVerification?.usedScoped).toBe(
        true,
      );
    });

    it("resolves the diff against ticket.targetBranch when set", async () => {
      const h = createGateHarness(scopedPlanner);
      const repo = makeRepo("/tmp/root", { verificationStrategy: "impact_scoped" });

      await runRepoVerificationGateOp(
        h.ctx,
        makeTicket({ targetBranch: "epic/staging" }),
        repo,
        makeStageRun(),
        "/tmp/wt",
        {},
      );
      expect(h.plannerCalls[0]?.baseBranch).toBe("epic/staging");
    });

    it("always_full (or unset) never consults the planner and leaves the result shape untouched", async () => {
      for (const strategy of ["always_full", undefined] as const) {
        const h = createGateHarness(scopedPlanner);
        const repo = makeRepo("/tmp/root", { verificationStrategy: strategy });

        const res = await runRepoVerificationGateOp(h.ctx, makeTicket(), repo, makeStageRun(), "/tmp/wt");

        expect(h.executed).toEqual([FULL_COMMANDS]);
        expect(h.plannerCalls).toHaveLength(0);
        expect(res.result).toBeDefined();
        expect("scopedVerification" in (res.result ?? {})).toBe(false);
      }
    });

    it("falls back to the full commands when the planner declines, throws, or returns an empty plan", async () => {
      const cases: Array<{ name: string; planner: ScopedPlanner; reason: RegExp }> = [
        {
          name: "declines",
          planner: async () => ({ useScoped: false, commands: FULL_COMMANDS, estimatedSavedMs: 0, reason: "root config changed" }),
          reason: /root config changed/,
        },
        {
          name: "throws",
          planner: async () => {
            throw new Error("boom");
          },
          reason: /scoped planner failed \(boom\)/,
        },
        {
          name: "empty",
          planner: async () => ({ useScoped: true, commands: [], estimatedSavedMs: 5, reason: "empty plan" }),
          reason: /empty plan/,
        },
      ];
      for (const c of cases) {
        const h = createGateHarness(c.planner);
        const repo = makeRepo("/tmp/root", { verificationStrategy: "impact_scoped" });
        const res = await runRepoVerificationGateOp(h.ctx, makeTicket(), repo, makeStageRun(), "/tmp/wt");
        expect(h.executed).toEqual([FULL_COMMANDS]);
        expect(res.result?.scopedVerification?.usedScoped).toBe(false);
        expect(res.result?.scopedVerification?.commandsRun).toEqual(FULL_COMMANDS);
        expect(res.result?.scopedVerification?.reason).toMatch(c.reason);
      }
    });

    it("runs the full commands when the workspace provider has no resolveScopedVerification", async () => {
      const h = createGateHarness();
      const repo = makeRepo("/tmp/root", { verificationStrategy: "impact_scoped" });
      const res = await runRepoVerificationGateOp(h.ctx, makeTicket(), repo, makeStageRun(), "/tmp/wt");
      expect(h.executed).toEqual([FULL_COMMANDS]);
      expect(res.result?.scopedVerification?.usedScoped).toBe(false);
    });
  });

  describe("(e) persistence of verificationStrategy", () => {
    it("normalizeVerificationStrategy only accepts the two known values", () => {
      expect(normalizeVerificationStrategy("always_full")).toBe("always_full");
      expect(normalizeVerificationStrategy("impact_scoped")).toBe("impact_scoped");
      expect(normalizeVerificationStrategy("bogus")).toBeUndefined();
      expect(normalizeVerificationStrategy(null)).toBeUndefined();
      expect(normalizeVerificationStrategy(undefined)).toBeUndefined();
    });

    it("SqliteStateStore round-trips the strategy and re-opening the DB (idempotent migration) keeps it", async () => {
      const dir = await mkdtemp(join(tmpdir(), "sw-v140-db-"));
      tempDirs.push(dir);
      const dbPath = join(dir, "state.db");

      const first = new SqliteStateStore(dbPath);
      await first.upsertRepo(makeRepo("/tmp/root", { verificationStrategy: "impact_scoped" }));
      expect((await first.getRepo("repo_impact"))?.verificationStrategy).toBe("impact_scoped");
      first.close();

      const reopened = new SqliteStateStore(dbPath);
      expect((await reopened.getRepo("repo_impact"))?.verificationStrategy).toBe("impact_scoped");

      await reopened.upsertRepo(makeRepo("/tmp/root", { verificationStrategy: undefined }));
      expect((await reopened.getRepo("repo_impact"))?.verificationStrategy).toBeUndefined();
      reopened.close();
    });
  });
});
