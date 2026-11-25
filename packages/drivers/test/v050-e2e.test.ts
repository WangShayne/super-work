import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  SuperWorkKernel,
  nowIso,
  type RepoConfig,
  type Ticket,
} from "@super-work/core";
import {
  FsArtifactStore,
  GhOutboxExecutor,
  GitWorktreeProvider,
  HeuristicControlLLM,
  MockWorkerDriver,
  NotificationDispatcher,
  SqliteStateStore,
  runGit,
} from "../src/index.ts";

async function createGitRepo(baseDir: string): Promise<string> {
  const repoDir = join(baseDir, "repo");
  await runGit(["init", "-b", "main", repoDir], baseDir);
  await runGit(["config", "user.name", "Test User"], repoDir);
  await runGit(["config", "user.email", "test@example.com"], repoDir);
  await writeFile(join(repoDir, "README.md"), "# V050 Test Repo\n", "utf8");
  await writeFile(join(repoDir, ".gitignore"), ".setup-ok\n", "utf8");
  await runGit(["add", "."], repoDir);
  await runGit(["commit", "-m", "initial commit"], repoDir);
  return repoDir;
}

describe("v0.5.0 End-to-End Capabilities", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("syncs super-work.json contract, runs worktree setupCommands, enforces forbiddenPaths, and exports contract", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v050-contract-"));
    tempDirs.push(dir);
    const repoDir = await createGitRepo(dir);

    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));
    const capturedPrompts: string[] = [];

    const mockDriver = new MockWorkerDriver({
      engine: "mock",
      stepDelayMs: 1,
      scenarioResolver: (input) => {
        capturedPrompts.push(input.prompt);
        return "happy_path";
      },
    });

    const kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm: new HeuristicControlLLM(),
      drivers: [mockDriver],
      outboxExecutor: new GhOutboxExecutor(workspace),
    });

    await writeFile(
      join(repoDir, "super-work.json"),
      JSON.stringify(
        {
          version: 1,
          defaultTemplate: "fast",
          setupCommands: ["node -e \"require('fs').writeFileSync('.setup-ok', 'ready')\""],
          verificationCommands: ["node -e \"if(!require('fs').existsSync('.setup-ok')) process.exit(1)\""],
          forbiddenPaths: ["secrets/**"],
          conventions: "Always validate inputs at module boundary.",
          playbook: [
            {
              rule: "Never mutate global config directly in src modules",
              scopePaths: ["src/**"],
              pinned: true,
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const ts = nowIso();
    await store.upsertRepo({
      id: "repo_ctr",
      name: "ctr-demo",
      rootPath: repoDir,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "standard",
      preferredImplementEngine: "mock",
      preferredReviewEngine: "mock",
      autoCleanupWorktree: false,
      defaultDeliveryChannel: "local_merge",
      createdAt: ts,
      updatedAt: ts,
    });

    const synced = await kernel.syncRepoContract("repo_ctr");
    expect(synced?.defaultTemplate).toBe("fast");
    expect(synced?.setupCommands).toHaveLength(1);
    expect(synced?.forbiddenPaths).toEqual(["secrets/**"]);
    expect(synced?.conventions).toContain("validate inputs");

    const ticket = await kernel.createDirectTicket({
      repoId: "repo_ctr",
      title: "Create src service",
      description: "Build src service",
      allowedPaths: ["src/**"],
      preferredEngine: "mock",
    });
    expect(ticket.template).toBe("fast");
    expect(ticket.mandate.forbiddenPaths).toContain("secrets/**");

    await kernel.runUntilIdle();
    const after = await store.getTicket(ticket.id);
    expect(after?.status).toBe("delivered");
    expect(capturedPrompts[0]).toContain("Repository Engineering Conventions");
    expect(capturedPrompts[0]).toContain("Repository Playbook");
    expect(capturedPrompts[0]).toContain("Never mutate global config directly");

    // Verify export updates super-work.json cleanly
    await kernel.addOrUpdatePlaybookRule({
      repoId: "repo_ctr",
      rule: "Exported human rule for tests",
      scopePaths: ["src/**"],
      source: "human",
    });
    const exported = await kernel.exportRepoContract("repo_ctr");
    const rawExported = await readFile(exported.filePath, "utf8");
    expect(rawExported).toContain("Exported human rule for tests");

    // Verify failing setupCommands cleans up fresh worktree & escalates to needs_human
    await store.upsertRepo({
      ...(await store.getRepo("repo_ctr"))!,
      setupCommands: ["exit 1"],
      updatedAt: nowIso(),
    });
    const failTicket = await kernel.createDirectTicket({
      repoId: "repo_ctr",
      title: "Setup failure test",
      description: "Should fail setup",
      allowedPaths: ["src/**"],
      preferredEngine: "mock",
    });
    await kernel.runUntilIdle();
    const failAfter = await store.getTicket(failTicket.id);
    expect(failAfter?.status).toBe("needs_human");
    expect(failAfter?.errorMessage).toContain("Worktree setup failed");
    expect(existsSync(join(dir, "worktrees", failTicket.id))).toBe(false);

    store.close();
  });

  it("distills Playbook rules on closed-loop recovery + human Inbox note, and supports nit-only & major-finding structured reviews", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v050-playbook-"));
    tempDirs.push(dir);
    const repoDir = await createGitRepo(dir);

    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));

    const mockDriver = new MockWorkerDriver({
      engine: "mock",
      stepDelayMs: 1,
      scenarioResolver: (input) => {
        if (input.ticketId.includes("nit")) return "review_nit_only";
        return "review_reject_once";
      },
    });

    const kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm: new HeuristicControlLLM(),
      drivers: [mockDriver],
      outboxExecutor: new GhOutboxExecutor(workspace),
    });

    const ts = nowIso();
    await store.upsertRepo({
      id: "repo_pbk",
      name: "pbk-demo",
      rootPath: repoDir,
      baseBranch: "main",
      mode: "observe",
      defaultTemplate: "standard",
      preferredImplementEngine: "mock",
      preferredReviewEngine: "mock",
      defaultDeliveryChannel: "local_merge",
      createdAt: ts,
      updatedAt: ts,
    });

    // 1. Observe trigger -> approve with guidance note -> should capture human rule
    const ingest = await kernel.ingestTrigger({
      repoId: "repo_pbk",
      source: "web",
      threadKey: "obs:1",
      title: "Fix module edge case",
      rawText: "Handle empty array in scope:src/**",
    });
    expect(ingest.action).toBe("proposed");
    if (ingest.action === "proposed") {
      await kernel.resolveInboxItem(
        ingest.inboxItem.id,
        "approved",
        "Always check empty input arrays before slicing",
        { saveToPlaybook: true },
      );
    }

    await kernel.runUntilIdle();

    const tkt = await store.getTicket((ingest as { ticket: Ticket }).ticket.id);
    expect(tkt?.status).toBe("delivered");

    // Rework happened via review_reject_once, so both human rule AND auto_healed rule should exist
    const rules = await store.listPlaybookEntries("repo_pbk");
    expect(rules.some((r) => r.source === "human" && r.rule.includes("Always check empty input arrays"))).toBe(true);
    expect(rules.some((r) => r.source === "auto_healed" && r.sourceTicketId === tkt!.id)).toBe(true);

    // Structured review_report artifact was written
    const arts = await store.listArtifacts(tkt!.id);
    const reviewReports = arts.filter((a) => a.kind === "review_report");
    expect(reviewReports.length).toBeGreaterThanOrEqual(2);
    const firstReport = JSON.parse(await artifacts.readSpill(reviewReports[0]!.storageUri)) as {
      verdict: string;
      findings: Array<{ severity: string }>;
    };
    expect(firstReport.verdict).toBe("changes_requested");
    expect(firstReport.findings[0]!.severity).toBe("major");

    // 2. Verify nit-only review passes on first pass without burning an extra implement run
    const nitDriver = new MockWorkerDriver({
      engine: "mock",
      stepDelayMs: 1,
      scenarioResolver: () => "review_nit_only",
    });
    const kernel2 = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm: new HeuristicControlLLM(),
      drivers: [nitDriver],
      outboxExecutor: new GhOutboxExecutor(workspace),
    });

    const nitTicket = await kernel2.createDirectTicket({
      repoId: "repo_pbk",
      title: "Nit-only test ticket",
      description: "Should pass review with nit advisory only",
      template: "standard",
      allowedPaths: ["docs/**"],
      preferredEngine: "mock",
    });
    await kernel2.runUntilIdle();

    const nitAfter = await store.getTicket(nitTicket.id);
    expect(nitAfter?.status).toBe("delivered");
    const nitRuns = await store.listStageRuns(nitTicket.id);
    expect(nitRuns.filter((r) => r.stage === "implement")).toHaveLength(1);
    const nitNote = nitAfter?.inlineMemory.stageNotes.find((n) => n.stage === "review");
    expect(nitNote?.reviewApproved).toBe(true);
    expect(nitNote?.reviewFindings?.[0]?.severity).toBe("nit");

    store.close();
  });

  it("delivers local_merge via --no-ff and executes non-destructive git revert -m 1 cleanly (including conflict abort)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v050-revert-"));
    tempDirs.push(dir);
    const repoDir = await createGitRepo(dir);

    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));

    const kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm: new HeuristicControlLLM(),
      drivers: [new MockWorkerDriver({ engine: "mock", stepDelayMs: 1 })],
      outboxExecutor: new GhOutboxExecutor(workspace),
    });

    const ts = nowIso();
    await store.upsertRepo({
      id: "repo_rev",
      name: "rev-demo",
      rootPath: repoDir,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "fast",
      preferredImplementEngine: "mock",
      preferredReviewEngine: "mock",
      defaultDeliveryChannel: "local_merge",
      createdAt: ts,
      updatedAt: ts,
    });

    const t1 = await kernel.createDirectTicket({
      repoId: "repo_rev",
      title: "Feature A to revert",
      description: "Add src feature A",
      allowedPaths: ["src/a.ts"],
      preferredEngine: "mock",
    });
    await kernel.runUntilIdle();

    const delivered = await store.getTicket(t1.id);
    expect(delivered?.status).toBe("delivered");
    expect(delivered?.mergedCommitSha).toBeTruthy();
    expect(existsSync(join(repoDir, "src/a.ts"))).toBe(true);

    // Confirm --no-ff produced a 2-parent merge commit on main
    const parents = await runGit(["rev-list", "--parents", "-n", "1", delivered!.mergedCommitSha!], repoDir);
    expect(parents.stdout.trim().split(/\s+/).length).toBeGreaterThanOrEqual(3);

    // Add a later unrelated commit on main; reverting Feature A must leave unrelated commit intact!
    await writeFile(join(repoDir, "UNRELATED.md"), "Keep me\n", "utf8");
    await runGit(["add", "UNRELATED.md"], repoDir);
    await runGit(["commit", "-m", "unrelated commit after merge"], repoDir);

    const revRes = await kernel.revertTicketDelivery(t1.id);
    expect(revRes.revertCommitSha).toBeTruthy();
    expect(revRes.ticket.revertedAt).toBeTruthy();
    expect(existsSync(join(repoDir, "src/a.ts"))).toBe(false);
    expect(existsSync(join(repoDir, "UNRELATED.md"))).toBe(true);

    // Verify conflict case aborts cleanly without leaving dirty state
    const t2 = await kernel.createDirectTicket({
      repoId: "repo_rev",
      title: "Feature B conflicting revert",
      description: "Add src feature B",
      allowedPaths: ["src/b.ts"],
      preferredEngine: "mock",
    });
    await kernel.runUntilIdle();
    const delivered2 = await store.getTicket(t2.id);
    await writeFile(join(repoDir, "src/b.ts"), "// conflicting manual override\n", "utf8");
    await runGit(["add", "src/b.ts"], repoDir);
    await runGit(["commit", "-m", "override src/b.ts"], repoDir);

    await expect(kernel.revertTicketDelivery(delivered2!.id)).rejects.toThrow("Revert conflicted on");
    const statusAfter = await runGit(["status", "--porcelain"], repoDir);
    expect(statusAfter.stdout.trim()).toBe("");

    store.close();
  });

  it("dispatches high-signal macOS & adaptive Feishu/Slack/Discord/JSON HMAC notifications", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v050-notif-"));
    tempDirs.push(dir);
    const store = new SqliteStateStore(join(dir, "state.db"));

    const macosCalls: Array<{ title: string; message: string }> = [];
    const webhookCalls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];

    const dispatcher = new NotificationDispatcher(store, {
      macosSender: async (title, message) => {
        macosCalls.push({ title, message });
      },
      fetchImpl: async (url, init) => {
        webhookCalls.push({
          url,
          headers: (init?.headers as Record<string, string>) ?? {},
          body: String(init?.body ?? ""),
        });
        return { ok: true, status: 200, text: async () => "ok" };
      },
    });

    await store.setSystemSetting("setup_config", {
      initialized: true,
      llmPreset: "heuristic",
      llmBaseUrl: "",
      llmModel: "heuristic",
      preferredImplementEngine: "mock",
      preferredReviewEngine: "mock",
      notifications: {
        macosEnabled: true,
        webhookEnabled: true,
        webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/abc",
        webhookSecret: "topsecret",
        notifyOnInbox: true,
        notifyOnDelivery: true,
        notifyOnFailure: true,
      },
      updatedAt: nowIso(),
    });

    // Low-signal ticket_created must be ignored!
    const ignoredRes = await dispatcher.handleKernelEvent({
      type: "ticket_created",
      ticket: { id: "t1" } as Ticket,
      timestamp: nowIso(),
    });
    expect(ignoredRes).toHaveLength(0);
    expect(macosCalls).toHaveLength(0);

    // High-signal inbox_created must trigger macOS + Feishu payload + HMAC signature
    const res = await dispatcher.handleKernelEvent({
      type: "inbox_created",
      item: {
        id: "inb_1",
        repoId: "repo_1",
        ticketId: "tkt_1",
        kind: "mandate_violation",
        status: "pending",
        title: "Out-of-scope modification",
        summary: "Edited packages/web/foo.ts",
        createdAt: nowIso(),
      },
      timestamp: nowIso(),
    } as Parameters<typeof dispatcher.handleKernelEvent>[0]);

    expect(res).toHaveLength(2);
    expect(macosCalls).toHaveLength(1);
    expect(webhookCalls).toHaveLength(1);
    const parsedFeishu = JSON.parse(webhookCalls[0]!.body) as {
      msg_type: string;
      content: { text: string };
    };
    expect(parsedFeishu.msg_type).toBe("text");
    expect(parsedFeishu.content.text).toContain("Out-of-scope modification");
    expect(webhookCalls[0]!.headers["X-Super-Work-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);

    // Subtask ticket_updated failure must not spam; root ticket failed DOES notify
    const subFail = await dispatcher.handleKernelEvent({
      type: "ticket_updated",
      ticket: { id: "t_sub", parentTicketId: "epc_1", status: "failed", title: "Sub", repoId: "repo_1" } as Ticket,
      timestamp: nowIso(),
    });
    expect(subFail).toHaveLength(0);

    // Send test with Slack URL
    const slackRes = await dispatcher.sendTestNotification({
      macosEnabled: false,
      webhookEnabled: true,
      webhookUrl: "https://hooks.slack.com/services/T000/B000/XXX",
    });
    expect(slackRes[0]!.detail).toContain("slack");
    const parsedSlack = JSON.parse(webhookCalls[1]!.body) as { text: string };
    expect(parsedSlack.text).toContain("Super-Work Test Notification");

    store.close();
  });
});
