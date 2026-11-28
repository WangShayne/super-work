import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  SuperWorkKernel,
  isPureReleaseHousekeepingRequirement,
  nowIso,
  synthesizeMilestoneReleaseNotes,
  type Milestone,
} from "@super-work/core";
import {
  FsArtifactStore,
  GhOutboxExecutor,
  GitWorktreeProvider,
  HeuristicControlLLM,
  SqliteStateStore,
  runGit,
} from "../src/index.ts";

const REPO_ID = "repo_v183";

interface Fixture {
  dir: string;
  repoPath: string;
  originPath: string;
  store: SqliteStateStore;
  kernel: SuperWorkKernel;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const res = await runGit(args, cwd);
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  return res.stdout.trim();
}

async function commitFile(repoPath: string, rel: string, content: string, msg: string): Promise<void> {
  const abs = join(repoPath, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf8");
  await git(repoPath, "add", rel);
  await git(repoPath, "commit", "-m", msg);
}

describe("v1.8.3 direct release milestones", () => {
  const tempDirs: string[] = [];

  const stores: SqliteStateStore[] = [];

  afterEach(async () => {
    for (const s of stores.splice(0)) s.close();
    for (const d of tempDirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function setup(): Promise<Fixture> {
    const dir = await mkdtemp(join(tmpdir(), "sw-v183-"));
    tempDirs.push(dir);
    const originPath = join(dir, "origin.git");
    const repoPath = join(dir, "app");
    await git(dir, "init", "--bare", "-b", "main", originPath);
    await git(dir, "init", "-b", "main", repoPath);
    await git(repoPath, "config", "user.name", "Test User");
    await git(repoPath, "config", "user.email", "test@example.com");
    await commitFile(
      repoPath,
      "package.json",
      `${JSON.stringify({ name: "app", version: "1.8.2" }, null, 2)}\n`,
      "initial commit",
    );
    await git(repoPath, "remote", "add", "origin", originPath);
    await git(repoPath, "push", "-u", "origin", "main");

    const store = new SqliteStateStore(join(dir, "state.db"));
    stores.push(store);
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));
    const kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: new FsArtifactStore(join(dir, "artifacts")),
      workspace,
      llm: new HeuristicControlLLM(),
      drivers: [],
      outboxExecutor: new GhOutboxExecutor(workspace),
      dataDir: dir,
    });
    const ts = nowIso();
    await store.upsertRepo({
      id: REPO_ID,
      name: "app",
      rootPath: repoPath,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "fast",
      defaultDeliveryChannel: "local_merge",
      preferredImplementEngine: "claude",
      preferredReviewEngine: "claude",
      createdAt: ts,
      updatedAt: ts,
    });
    return { dir, repoPath, originPath, store, kernel };
  }

  async function pendingReadyItem(fx: Fixture, milestoneId: string) {
    const pending = await fx.store.listInboxItems({ repoId: REPO_ID, status: "pending" });
    return pending.find((i) => i.kind === "milestone_ready" && i.contextPayload?.milestoneId === milestoneId);
  }

  it("isPureReleaseHousekeepingRequirement classifies housekeeping vs code changes", () => {
    expect(isPureReleaseHousekeepingRequirement("整合当前工作区修改,并添加v1.8.3tag,推送到远端")).toBe(true);
    expect(isPureReleaseHousekeepingRequirement("squash commits, tag v1.8.3 and git push")).toBe(true);
    expect(isPureReleaseHousekeepingRequirement("release v1.8.3")).toBe(true);
    expect(isPureReleaseHousekeepingRequirement("打 tag 并整理合并提交")).toBe(true);
    expect(isPureReleaseHousekeepingRequirement("")).toBe(false);
    expect(isPureReleaseHousekeepingRequirement("add export endpoint in packages/server/src/app.ts")).toBe(false);
    expect(isPureReleaseHousekeepingRequirement("修复登录超时并推送")).toBe(false);
    expect(isPureReleaseHousekeepingRequirement("refactor the router, then git push")).toBe(false);
    expect(isPureReleaseHousekeepingRequirement("add a push button to the header")).toBe(false);
    expect(isPureReleaseHousekeepingRequirement("整理合并 v1.8.3 提交、打 tag 并推送远端")).toBe(true);
  });

  it("direct release notes are clean (no 0/0 delivered)", () => {
    const milestone = { name: "Rel", targetVersion: "1.8.3", items: [] } as unknown as Milestone;
    const notes = synthesizeMilestoneReleaseNotes({ milestone, tickets: [] });
    expect(notes.releaseNotesEn).toContain("Direct release of base-branch changes");
    expect(notes.releaseNotesZh).toContain("直接发布主干就绪变更");
    expect(notes.digestSummary).not.toContain("0/0");
  });

  it("createMilestoneOp: empty requirements need a version; both empty still throws", async () => {
    const fx = await setup();
    await expect(
      fx.kernel.createMilestone({ repoId: REPO_ID, name: "x", requirements: [] }),
    ).rejects.toThrow("Milestone requires at least one requirement");

    const empty = await fx.kernel.createMilestone({
      repoId: REPO_ID,
      name: "Release 1.8.3",
      targetVersion: "1.8.3",
      requirements: [],
    });
    expect(empty.status).toBe("ready_to_release");
    expect(empty.items).toHaveLength(0);
    expect(await pendingReadyItem(fx, empty.id)).toBeDefined();

    const housekeeping = await fx.kernel.createMilestone({
      repoId: REPO_ID,
      name: "Release 1.8.4",
      targetVersion: "1.8.4",
      requirements: ["整合当前工作区修改,并添加v1.8.4tag,推送到远端"],
    });
    expect(housekeeping.status).toBe("ready_to_release");
    expect(housekeeping.items).toHaveLength(0);
    expect(await store(fx).listTickets({ repoId: REPO_ID })).toHaveLength(0);
    expect(await pendingReadyItem(fx, housekeeping.id)).toBeDefined();
  });

  it("approving milestone_ready squashes unpushed direct_main commits onto origin/main, tags and pushes", async () => {
    const fx = await setup();
    await commitFile(fx.repoPath, "a.txt", "a\n", "wip 1");
    await commitFile(fx.repoPath, "b.txt", "b\n", "wip 2");
    const originBefore = await git(fx.repoPath, "rev-parse", "refs/remotes/origin/main");

    const ms = await fx.kernel.createMilestone({
      repoId: REPO_ID,
      name: "Release 1.8.3",
      targetVersion: "1.8.3",
      requirements: [],
    });
    const item = (await pendingReadyItem(fx, ms.id))!;
    await fx.kernel.resolveInboxItem(item.id, "approved", undefined, {
      milestoneRelease: {
        bumpVersion: true,
        squashReleaseCommit: true,
        createTag: true,
        pushRemote: true,
        releaseCommitMessage: "feat: release v1.8.3",
      },
    });

    const released = await fx.kernel.getMilestone(ms.id);
    expect(released?.status).toBe("released");
    expect(released?.releasedTag).toBe("v1.8.3");

    const count = await git(fx.repoPath, "rev-list", "--count", `${originBefore}..HEAD`);
    expect(count).toBe("1");
    expect(await git(fx.repoPath, "log", "-1", "--format=%s")).toBe("feat: release v1.8.3");
    expect(await git(fx.repoPath, "cat-file", "-t", "refs/tags/v1.8.3")).toBe("tag");
    expect(await git(fx.originPath, "rev-parse", "refs/heads/main")).toBe(
      await git(fx.repoPath, "rev-parse", "HEAD"),
    );
    expect(await git(fx.originPath, "rev-parse", "--verify", "refs/tags/v1.8.3^{commit}")).toBe(
      await git(fx.repoPath, "rev-parse", "HEAD"),
    );
    expect(await git(fx.repoPath, "show", "HEAD:a.txt")).toBe("a");
    expect(await git(fx.repoPath, "show", "HEAD:package.json")).toContain('"version": "1.8.3"');
  });

  it("release fails fast when the tag already exists locally and leaves history untouched", async () => {
    const fx = await setup();
    await commitFile(fx.repoPath, "a.txt", "a\n", "wip 1");
    await git(fx.repoPath, "tag", "v1.8.3");
    const head = await git(fx.repoPath, "rev-parse", "HEAD");

    const ms = await fx.kernel.createMilestone({
      repoId: REPO_ID,
      name: "Release 1.8.3",
      targetVersion: "1.8.3",
      requirements: [],
    });
    await expect(
      fx.kernel.releaseMilestone(ms.id, {
        bumpVersion: true,
        squashReleaseCommit: true,
        createTag: true,
      }),
    ).rejects.toThrow("Tag v1.8.3 already exists locally");
    expect(await git(fx.repoPath, "rev-parse", "HEAD")).toBe(head);
  });

  it("omitted milestoneRelease keeps the bump-only default (no tag, no push)", async () => {
    const fx = await setup();
    const ms = await fx.kernel.createMilestone({
      repoId: REPO_ID,
      name: "Release 1.8.3",
      targetVersion: "1.8.3",
      requirements: [],
    });
    const item = (await pendingReadyItem(fx, ms.id))!;
    await fx.kernel.resolveInboxItem(item.id, "approved");
    expect((await fx.kernel.getMilestone(ms.id))?.status).toBe("released");
    expect(await git(fx.repoPath, "tag", "--list", "v1.8.3")).toBe("");
    expect(await git(fx.repoPath, "rev-parse", "HEAD")).not.toBe(
      await git(fx.originPath, "rev-parse", "refs/heads/main"),
    );
  });

  it("rejecting milestone_ready cancels the milestone; cancelling again throws", async () => {
    const fx = await setup();
    const ms = await fx.kernel.createMilestone({
      repoId: REPO_ID,
      name: "Release 1.8.3",
      targetVersion: "1.8.3",
      requirements: [],
    });
    const item = (await pendingReadyItem(fx, ms.id))!;
    await fx.kernel.resolveInboxItem(item.id, "rejected", "not now");
    expect((await fx.kernel.getMilestone(ms.id))?.status).toBe("cancelled");
    expect(await pendingReadyItem(fx, ms.id)).toBeUndefined();
    await expect(fx.kernel.cancelMilestone(ms.id)).rejects.toThrow("cancelled");
  });

  it("cancelMilestone rejects the pending inbox item and marks the milestone cancelled", async () => {
    const fx = await setup();
    const ms = await fx.kernel.createMilestone({
      repoId: REPO_ID,
      name: "Release 1.8.3",
      targetVersion: "1.8.3",
      requirements: [],
    });
    const cancelled = await fx.kernel.cancelMilestone(ms.id, "changed plans");
    expect(cancelled.status).toBe("cancelled");
    const rejected = await fx.store.listInboxItems({ repoId: REPO_ID, status: "rejected" });
    expect(rejected.some((i) => i.contextPayload?.milestoneId === ms.id)).toBe(true);
    await expect(fx.kernel.cancelMilestone("mst_missing")).rejects.toThrow("Milestone not found");
  });
});

function store(fx: Fixture): SqliteStateStore {
  return fx.store;
}
