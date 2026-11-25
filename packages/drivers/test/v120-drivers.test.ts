import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  createDefaultMandate,
  newId,
  nowIso,
  type GoalCampaign,
  type MergeTrainEntry,
  type RepoConfig,
  type Ticket,
} from "@super-work/core";
import {
  GitWorktreeProvider,
  ServiceManager,
  SqliteStateStore,
  assertSafeHostBinding,
  buildLaunchdPlistXml,
  buildMacosSeatbeltProfile,
  buildSystemdUnitText,
  resolveSmartDataDir,
  rotateDaemonLogIfNeeded,
  runGit,
} from "../src/index.ts";

async function initGitRepo(baseDir: string, name: string): Promise<string> {
  const dir = join(baseDir, name);
  await runGit(["init", "-b", "main", dir], baseDir);
  await runGit(["config", "user.name", "Test User"], dir);
  await runGit(["config", "user.email", "test@example.com"], dir);
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "README.md"), `# ${name}\n`, "utf8");
  await writeFile(join(dir, "metric.txt"), "10\n", "utf8");
  await writeFile(join(dir, "super-work.json"), '{"defaultTemplate":"fast"}\n', "utf8");
  await runGit(["add", "README.md", "metric.txt", "super-work.json"], dir);
  await runGit(["commit", "-m", "initial commit"], dir);
  return dir;
}

describe("v1.2.0 Drivers (SQLite Split, Hooks/Train Git Ops, ReadOnly super-work.json, ServiceManager)", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const d of tempDirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("SQLite Store persists hooks_json, GoalCampaign + Waves, and MergeTrainEntry queue order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v120-db-"));
    tempDirs.push(dir);
    const store = new SqliteStateStore(join(dir, "state.db"));

    const ts = nowIso();
    const repo: RepoConfig = {
      id: "repo_v120",
      name: "v120-repo",
      rootPath: dir,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "fast",
      preferredImplementEngine: "mock",
      preferredReviewEngine: "mock",
      hooks: {
        preDeliver: ["bun run typecheck"],
        postDeliver: ["echo shipped"],
        onEscalate: ["echo alert"],
        timeoutSec: 45,
      },
      createdAt: ts,
      updatedAt: ts,
    };
    await store.upsertRepo(repo);
    const loadedRepo = await store.getRepo("repo_v120");
    expect(loadedRepo?.hooks).toEqual(repo.hooks);

    const cmp: GoalCampaign = {
      id: "cmp_db_1",
      repoId: repo.id,
      name: "Bench boost",
      goalPrompt: "Increase metric",
      metricCommand: "cat metric.txt",
      direction: "increase",
      baselineValue: 10,
      currentValue: 20,
      targetValue: 30,
      deliveryMode: "staging_branch",
      stagingBranch: "super-work/campaign/cmp_db_1",
      allowedPaths: ["**"],
      template: "fast",
      maxIterations: 4,
      completedWaves: 1,
      maxTotalBudgetUsd: 5,
      totalCostUsd: 0.1,
      consecutiveNoImproveCount: 0,
      status: "running",
      createdAt: ts,
      updatedAt: ts,
    };
    await store.saveCampaign(cmp);
    await store.saveCampaignWave({
      id: "wav_1",
      campaignId: cmp.id,
      repoId: repo.id,
      waveNumber: 1,
      status: "improved",
      beforeValue: 10,
      measuredValue: 20,
      delta: 10,
      costUsd: 0.1,
      summary: "Doubled score",
      startedAt: ts,
      completedAt: ts,
    });

    expect((await store.getCampaign(cmp.id))?.name).toBe("Bench boost");
    expect(await store.listCampaignWaves(cmp.id)).toHaveLength(1);
    expect(await store.listCampaigns(repo.id)).toHaveLength(1);

    const pos1 = await store.nextMergeTrainPosition(repo.id);
    const entry1: MergeTrainEntry = {
      id: "trn_1",
      repoId: repo.id,
      ticketId: "tkt_1",
      outboxId: "obx_1",
      branchName: "super-work/tkt_1",
      baseBranch: "main",
      position: pos1,
      status: "queued",
      createdAt: ts,
      updatedAt: ts,
    };
    await store.saveMergeTrainEntry(entry1);
    const pos2 = await store.nextMergeTrainPosition(repo.id);
    expect(pos2).toBe(2);
    expect(await store.listMergeTrainEntries({ repoId: repo.id })).toHaveLength(1);

    await store.deleteCampaign(cmp.id);
    expect(await store.getCampaign(cmp.id)).toBeNull();
    expect(await store.listCampaignWaves(cmp.id)).toHaveLength(0);
    store.close();
  });

  it("GitWorktreeProvider runs sanitized lifecycle hooks, detached metric probes, branch reset, speculative slots & independent revert", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v120-git-"));
    tempDirs.push(dir);
    const repoDir = await initGitRepo(dir, "train-repo");
    const wtRoot = join(dir, "data", "worktrees");
    const provider = new GitWorktreeProvider(wtRoot);

    // 1. Lifecycle hook strips secrets & passes SUPER_WORK_HOOK_*
    const prevKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-secret-must-not-leak";
    try {
      const hookOutFile = join(dir, "hook-env.txt");
      const hookRes = await provider.runLifecycleHooks({
        cwd: repoDir,
        commands: [
          `node -e 'const fs=require("fs"); fs.writeFileSync(${JSON.stringify(hookOutFile)}, JSON.stringify({ ev: process.env.SUPER_WORK_HOOK_EVENT, api: process.env.OPENAI_API_KEY ?? null }))'`,
        ],
        hookEnv: { SUPER_WORK_HOOK_EVENT: "post_deliver", SUPER_WORK_HOOK_TICKET_ID: "tkt_h" },
      });
      expect(hookRes.ok).toBe(true);
      const written = JSON.parse(await Bun.file(hookOutFile).text()) as {
        ev: string;
        api: string | null;
      };
      expect(written.ev).toBe("post_deliver");
      expect(written.api).toBeNull();
    } finally {
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevKey;
    }

    // 2. Detached metric measurement + staging branch reset
    await provider.ensureBranch(repoDir, "super-work/cmp-test", "main");
    const goodSha = await provider.getHeadCommitSha(repoDir, "super-work/cmp-test");
    const metricRes = await provider.measureMetricAtRef({
      rootRepoPath: repoDir,
      gitRef: "super-work/cmp-test",
      metricCommand: "cat metric.txt",
      sandboxMode: "off",
    });
    expect(metricRes.ok).toBe(true);
    expect(metricRes.rawOutput.trim()).toBe("10");

    // Mutate staging branch via worktree and reset back to goodSha
    const stubRepo: RepoConfig = {
      id: "repo_stub",
      name: "train-repo",
      rootPath: repoDir,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "fast",
      preferredImplementEngine: "mock",
      preferredReviewEngine: "mock",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    const mkTicket = (id: string, branchName: string): Ticket => ({
      id,
      repoId: "repo_stub",
      threadId: `thr_${id}`,
      sourceTriggerId: `trg_${id}`,
      title: id,
      description: id,
      status: "queued",
      template: "fast",
      currentStage: "implement",
      stageRetries: 0,
      mandate: createDefaultMandate(),
      dependsOn: [],
      branchName,
      nativeSessions: {},
      inlineMemory: { goal: id, acceptanceCriteria: [], stageNotes: [], threadUpdates: [] },
      costUsd: 0,
      priority: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });

    const wsStage = await provider.prepareWorkspace(
      mkTicket("cmp_mut", "super-work/cmp-mut"),
      stubRepo,
      { startPoint: "super-work/cmp-test" },
    );
    await writeFile(join(wsStage.worktreePath, "metric.txt"), "99\n", "utf8");
    await provider.commitAll(wsStage.worktreePath, "mut");
    const mutSha = await provider.getHeadCommitSha(wsStage.worktreePath);
    await provider.fastForwardBranchToCommit({
      rootRepoPath: repoDir,
      baseBranch: "super-work/cmp-test",
      targetCommitSha: mutSha,
      cleanupWorktrees: [wsStage.worktreePath],
      deleteBranches: ["super-work/cmp-mut"],
    });
    await provider.resetBranchRef(repoDir, "super-work/cmp-test", goodSha);
    expect(await provider.getHeadCommitSha(repoDir, "super-work/cmp-test")).toBe(goodSha);

    // 3. Speculative Merge Train stack (slot A + slot B) -> fast-forward main -> single-ticket git revert -m 1!
    const wsA = await provider.prepareWorkspace(mkTicket("trn_a", "feat/a"), stubRepo, {
      startPoint: "main",
    });
    await writeFile(join(wsA.worktreePath, "a.txt"), "A\n", "utf8");
    await provider.commitAll(wsA.worktreePath, "feat: add a.txt");

    const wsB = await provider.prepareWorkspace(mkTicket("trn_b", "feat/b"), stubRepo, {
      startPoint: "main",
    });
    await writeFile(join(wsB.worktreePath, "b.txt"), "B\n", "utf8");
    await provider.commitAll(wsB.worktreePath, "feat: add b.txt");

    const baseSha = await provider.getHeadCommitSha(repoDir, "main");
    const slotA = await provider.prepareSpeculativeMergeSlot({
      rootRepoPath: repoDir,
      baseCommitSha: baseSha,
      branchName: "feat/a",
      commitMessage: "merge feat/a",
      slotLabel: "slot_a",
    });
    expect(slotA.ok).toBe(true);

    const slotB = await provider.prepareSpeculativeMergeSlot({
      rootRepoPath: repoDir,
      baseCommitSha: slotA.mergedCommitSha!,
      branchName: "feat/b",
      commitMessage: "merge feat/b",
      slotLabel: "slot_b",
    });
    expect(slotB.ok).toBe(true);

    await provider.fastForwardBranchToCommit({
      rootRepoPath: repoDir,
      baseBranch: "main",
      targetCommitSha: slotB.mergedCommitSha!,
      cleanupWorktrees: [slotA.worktreePath, slotB.worktreePath, wsA.worktreePath, wsB.worktreePath],
      deleteBranches: ["feat/a", "feat/b"],
    });

    expect(existsSync(join(repoDir, "a.txt"))).toBe(true);
    expect(existsSync(join(repoDir, "b.txt"))).toBe(true);

    // Independent single-ticket revert of slotA leaves b.txt intact!
    await provider.revertMergedCommit({
      rootRepoPath: repoDir,
      baseBranch: "main",
      commitSha: slotA.mergedCommitSha!,
    });
    expect(existsSync(join(repoDir, "a.txt"))).toBe(false);
    expect(existsSync(join(repoDir, "b.txt"))).toBe(true);
  });

  it("OS Sandbox keeps super-work.json readable while blocking writes", () => {
    const profile = buildMacosSeatbeltProfile({
      worktreePath: "/tmp/wt-test",
      rootRepoPath: "/tmp/repo-test",
      sandboxTempDir: "/tmp/sw-tmp",
      // Hermetic: host $TMPDIR/home may legitimately contain "super-work" in their paths.
      hostTempDirs: ["/tmp/sw-host-tmp"],
      homeDir: "/tmp/sw-home",
      mode: "balanced",
      allowNetwork: false,
      forbiddenPaths: [".env", "**/.env.*"],
      readOnlyPaths: ["super-work.json", "**/super-work.json", "test/spec.test.ts"],
    });
    expect(profile).toContain("/tmp/wt-test/super-work.json");
    expect(profile).toContain("file-write*");
    const contractRules = profile
      .split("\n")
      .filter((line) => line.includes("super-work"));
    expect(contractRules.length).toBeGreaterThanOrEqual(2);
    for (const rule of contractRules) {
      expect(rule.startsWith("(deny file-write*")).toBe(true);
      expect(rule).not.toContain("file-read-data");
    }
  });

  it("ServiceManager generates launchd/systemd units, guards non-loopback host, resolves dataDir, and rotates 10MB logs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v120-svc-"));
    tempDirs.push(dir);

    // Non-loopback host guard
    expect(() => assertSafeHostBinding("0.0.0.0")).toThrow(/SUPER_WORK_TOKEN/);
    expect(() => assertSafeHostBinding("0.0.0.0", "secret-tok")).not.toThrow();
    expect(() => assertSafeHostBinding("127.0.0.1")).not.toThrow();

    // Smart dataDir resolution
    const cwdWithLocal = join(dir, "proj-a");
    await mkdir(join(cwdWithLocal, ".super-work"), { recursive: true });
    expect(resolveSmartDataDir({ cwd: cwdWithLocal, homeDir: dir })).toBe(
      join(cwdWithLocal, ".super-work"),
    );
    const cwdWithoutLocal = join(dir, "proj-b");
    await mkdir(cwdWithoutLocal, { recursive: true });
    expect(resolveSmartDataDir({ cwd: cwdWithoutLocal, homeDir: dir })).toBe(
      join(dir, ".super-work"),
    );

    // Log rotation
    const logPath = join(dir, "daemon.log");
    await writeFile(logPath, "x".repeat(256), "utf8");
    expect(rotateDaemonLogIfNeeded(logPath, 1024)).toBe(false);
    expect(rotateDaemonLogIfNeeded(logPath, 200)).toBe(true);
    expect(existsSync(logPath)).toBe(false);
    expect(existsSync(`${logPath}.1`)).toBe(true);

    // Unit file generation
    const unitSpec = {
      label: ServiceManager.LAUNCHD_LABEL,
      bunPath: "/usr/local/bin/bun",
      serverEntryPath: "/app/packages/server/src/index.ts",
      workingDir: "/app",
      dataDir: "/app/.super-work",
      host: "127.0.0.1",
      port: 4318,
      logFilePath: "/app/.super-work/logs/daemon.log",
      authToken: "tok_123",
    };
    const plist = buildLaunchdPlistXml(unitSpec);
    expect(plist).toContain("ai.superwork.daemon");
    expect(plist).toContain("SUPER_WORK_TOKEN");
    expect(plist).toContain("<true/>");

    const unitText = buildSystemdUnitText(unitSpec);
    expect(unitText).toContain("Restart=on-failure");
    expect(unitText).toContain("HOST=127.0.0.1");
    expect(unitText).toContain("SUPER_WORK_TOKEN=tok_123");

    // Mocked install / status / start / stop / uninstall lifecycle
    const calls: string[][] = [];
    const mgr = new ServiceManager({
      platform: "darwin",
      homeDir: dir,
      cwd: cwdWithLocal,
      host: "127.0.0.1",
      port: 4319,
      execRunner: async (argv) => {
        calls.push(argv);
        if (argv[1] === "print") {
          return { exitCode: 0, stdout: "state = running\npid = 4242\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const stInstalled = await mgr.install({ startNow: true });
    expect(stInstalled.installed).toBe(true);
    expect(stInstalled.running).toBe(true);
    expect(stInstalled.pid).toBe(4242);
    expect(existsSync(mgr.getServiceFilePath()!)).toBe(true);

    await mkdir(join(cwdWithLocal, ".super-work", "logs"), { recursive: true });
    await writeFile(mgr.logFilePath, "line1\nline2\n", "utf8");
    const logs = mgr.readLogs(10);
    expect(logs.exists).toBe(true);
    expect(logs.lines).toContain("line2");

    await mgr.stop();
    await mgr.uninstall();
    expect(existsSync(mgr.getServiceFilePath()!)).toBe(false);
    expect(calls.some((c) => c[1] === "bootstrap")).toBe(true);
    expect(calls.some((c) => c[1] === "bootout")).toBe(true);
  });
});
