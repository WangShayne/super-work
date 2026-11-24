import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { createDefaultMandate, type RepoConfig, type Ticket } from "@super-work/core";
import { GitWorktreeProvider, SqliteStateStore, runGit } from "../src/index.ts";

async function initGitRepo(baseDir: string, name: string): Promise<string> {
  const dir = join(baseDir, name);
  await runGit(["init", "-b", "main", dir], baseDir);
  await runGit(["config", "user.name", "Test User"], dir);
  await runGit(["config", "user.email", "test@example.com"], dir);
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src/app.ts"), "export const version = 1;\nexport const flag = false;\n", "utf8");
  await runGit(["add", "."], dir);
  await runGit(["commit", "-m", "init"], dir);
  return dir;
}

describe("v1.0.0 Drivers (B.1 Review Comments DB + C.1 Integrity/VACUUM INTO + B.2 3-Way Git Conflict)", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const d of tempDirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("C.1 & B.1: persists review_comments, spans, riskAssessment, checks SQLite integrity, and creates VACUUM INTO hot backups", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v100-db-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "state.db");
    const store = new SqliteStateStore(dbPath);

    const repo: RepoConfig = {
      id: "repo_db",
      name: "db-app",
      rootPath: dir,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "standard",
      deliveryGatePolicy: "risk_gated",
      riskThreshold: 40,
      sensitivePaths: ["src/auth/**"],
      blueprints: [
        { id: "bp_custom", name: "Custom BP", description: "Test", template: "strict" },
      ],
      preferredImplementEngine: "claude",
      preferredReviewEngine: "codex",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await store.upsertRepo(repo);
    const loadedRepo = await store.getRepo("repo_db");
    expect(loadedRepo?.deliveryGatePolicy).toBe("risk_gated");
    expect(loadedRepo?.riskThreshold).toBe(40);
    expect(loadedRepo?.sensitivePaths).toEqual(["src/auth/**"]);
    expect(loadedRepo?.blueprints?.[0]?.id).toBe("bp_custom");

    const ticket: Ticket = {
      id: "tkt_db",
      repoId: "repo_db",
      threadId: "thr_db",
      sourceTriggerId: "trg_db",
      title: "Test ticket",
      description: "Desc",
      status: "queued",
      template: "standard",
      currentStage: "implement",
      stageRetries: 0,
      mandate: createDefaultMandate({ allowedPaths: ["src/**"], maxCostUsd: 3 }),
      dependsOn: [],
      nativeSessions: {},
      blueprintId: "bp_custom",
      deliveryGatePolicy: "risk_gated",
      riskThreshold: 30,
      riskAssessment: {
        score: 52,
        level: "medium",
        requiresSignoff: true,
        threshold: 30,
        policy: "risk_gated",
        factors: [{ key: "diff_size", label: "Medium diff", delta: 15 }],
        evaluatedAt: "2026-01-01T00:00:00.000Z",
      },
      conflictResolutionCount: 1,
      inlineMemory: { goal: "Desc", acceptanceCriteria: [], stageNotes: [], threadUpdates: [] },
      costUsd: 0,
      priority: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await store.saveTicket(ticket);
    const loadedTkt = await store.getTicket("tkt_db");
    expect(loadedTkt?.blueprintId).toBe("bp_custom");
    expect(loadedTkt?.riskAssessment?.score).toBe(52);
    expect(loadedTkt?.conflictResolutionCount).toBe(1);

    await store.saveStageRun({
      id: "run_spans",
      ticketId: "tkt_db",
      stage: "implement",
      engine: "mock",
      status: "completed",
      costUsd: 0.01,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:02.000Z",
      spans: [
        {
          kind: "worker_turn",
          label: "mock implement",
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: "2026-01-01T00:00:01.000Z",
          durationMs: 1000,
          status: "ok",
        },
      ],
    });
    const runs = await store.listStageRuns("tkt_db");
    expect(runs[0]?.spans).toHaveLength(1);
    expect(runs[0]?.spans?.[0]?.kind).toBe("worker_turn");

    await store.saveReviewComment({
      id: "rvc_1",
      ticketId: "tkt_db",
      repoId: "repo_db",
      filePath: "src/app.ts",
      line: 2,
      side: "new",
      author: "human",
      severity: "major",
      body: "Use strict equality",
      status: "open",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(await store.listReviewComments("tkt_db")).toHaveLength(1);
    const resolved = await store.updateReviewCommentStatus(
      "rvc_1",
      "resolved",
      "2026-01-01T00:01:00.000Z",
    );
    expect(resolved?.status).toBe("resolved");

    const integrity = await store.checkDatabaseIntegrity();
    expect(integrity.ok).toBe(true);

    const backupFile = join(dir, "hot-backup.sqlite");
    await store.vacuumIntoBackup(backupFile);
    expect(existsSync(backupFile)).toBe(true);

    const backupStore = new SqliteStateStore(backupFile);
    expect((await backupStore.getTicket("tkt_db"))?.title).toBe("Test ticket");
    expect(await backupStore.listReviewComments("tkt_db")).toHaveLength(1);
  });

  it("B.2 & C.1: prepares lockfile-free 3-way conflict workspace and enumerates/prunes checkpoint refs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v100-git-"));
    tempDirs.push(dir);
    const repoPath = await initGitRepo(dir, "conflict-repo");
    const provider = new GitWorktreeProvider(join(dir, "worktrees"));

    const repo: RepoConfig = {
      id: "repo_git",
      name: "conflict-repo",
      rootPath: repoPath,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "fast",
      forbiddenPaths: [],
      preferredImplementEngine: "mock",
      preferredReviewEngine: "mock",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const ticket: Ticket = {
      id: "tkt_conflict",
      repoId: "repo_git",
      threadId: "thr_c",
      sourceTriggerId: "trg_c",
      title: "Update version",
      description: "Bump version to 2",
      status: "implementing",
      template: "fast",
      currentStage: "rebase",
      stageRetries: 0,
      mandate: createDefaultMandate({ allowedPaths: ["src/**"], maxCostUsd: 3 }),
      dependsOn: [],
      nativeSessions: {},
      inlineMemory: { goal: "Bump", acceptanceCriteria: [], stageNotes: [], threadUpdates: [] },
      costUsd: 0,
      priority: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const ws = await provider.prepareWorkspace(ticket, repo);
    await writeFile(join(ws.worktreePath, "src/app.ts"), "export const version = 2;\nexport const flag = true;\n", "utf8");
    await provider.commitAll(ws.worktreePath, "ticket change");

    const cp = await provider.captureWorktreeCheckpoint({
      worktreePath: ws.worktreePath,
      ticketId: ticket.id,
      checkpointId: "cp_pre",
      label: "Pre-rebase",
    });
    const refsBefore = await provider.listCheckpointRefs(repoPath);
    expect(refsBefore.some((r) => r.ref === cp.gitRef && r.ticketId === ticket.id)).toBe(true);

    // Divergent upstream commit on main
    await writeFile(join(repoPath, "src/app.ts"), "export const version = 99;\nexport const flag = false;\n", "utf8");
    await runGit(["add", "src/app.ts"], repoPath);
    await runGit(["commit", "-m", "upstream hotfix"], repoPath);

    const rebaseRes = await provider.rebaseOntoBase(ws.worktreePath, "main");
    expect(rebaseRes.ok).toBe(false);

    const prep = await provider.prepareThreeWayConflictWorkspace({
      worktreePath: ws.worktreePath,
      rootRepoPath: repoPath,
      baseBranch: "main",
    });
    expect(prep.conflictFiles).toContain("src/app.ts");
    expect(prep.upstreamCommitSummaries.some((s) => s.includes("upstream hotfix"))).toBe(true);
    expect(prep.fileHunks[0]?.oursSummary).toContain("99");
    expect(prep.fileHunks[0]?.theirsSummary).toContain("version = 2");

    const workingContent = await readFile(join(ws.worktreePath, "src/app.ts"), "utf8");
    expect(workingContent).toContain("<<<<<<<");

    // Verify clean git state without lingering MERGE_HEAD or rebase-merge lockfiles
    const gitDir = (await runGit(["rev-parse", "--git-dir"], ws.worktreePath)).stdout.trim();
    expect(existsSync(join(gitDir, "MERGE_HEAD"))).toBe(false);
    expect(existsSync(join(gitDir, "rebase-merge"))).toBe(false);

    expect(await provider.deleteGitRef(repoPath, cp.gitRef)).toBe(true);
    expect(await provider.listCheckpointRefs(repoPath)).toHaveLength(0);
  });
});
