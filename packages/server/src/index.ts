import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SuperWorkKernel, type CliScanReport, type SystemSetupConfig, nowIso } from "@super-work/core";
import {
  BunSelfHostRunner,
  ClaudeCodeDriver,
  CliEnvironmentScanner,
  CodexDriver,
  FsArtifactStore,
  GeminiCliDriver,
  GhCliPollingSource,
  GhOutboxExecutor,
  GitWorktreeProvider,
  MockWorkerDriver,
  MutableControlPlaneLLM,
  NotificationDispatcher,
  OpenCodeDriver,
  RELOAD_EXIT_CODE,
  SqliteStateStore,
  WorktreePreviewManager,
  assertSafeHostBinding,
  buildControlPlaneLLMFromSetup,
  resolveSmartDataDir,
  rotateDaemonLogIfNeeded,
  runGit,
} from "@super-work/drivers";
import { createServerApp } from "./app.ts";

export { createServerApp };

export function parseGithubRepoFromRemote(url: string): string | undefined {
  const trimmed = url.trim();
  const match = trimmed.match(/github\.com[:/]([^/]+\/[^/\s]+?)(?:\.git)?$/i);
  return match?.[1];
}

export interface StartedDaemon {
  server: ReturnType<typeof Bun.serve>;
  kernel: SuperWorkKernel;
  stateStore: SqliteStateStore;
  ghPoller: GhCliPollingSource;
  notificationDispatcher: NotificationDispatcher;
  stop: () => Promise<void>;
}

export async function startDaemon(options?: {
  host?: string;
  port?: number;
  dataDir?: string;
  defaultRepoPath?: string;
  authToken?: string;
  enableMockFallback?: boolean;
  disableSelfHostRunner?: boolean;
}): Promise<StartedDaemon> {
  const host = (options?.host ?? process.env.HOST ?? "127.0.0.1").trim();
  const port = options?.port ?? Number(process.env.PORT ?? 4318);
  const authToken = options?.authToken ?? (process.env.SUPER_WORK_TOKEN?.trim() || undefined);
  assertSafeHostBinding(host, authToken);

  const logFileEnv = process.env.SUPER_WORK_LOG_FILE?.trim();
  if (logFileEnv) {
    rotateDaemonLogIfNeeded(logFileEnv);
  }

  const dataDir = resolveSmartDataDir({
    explicitDataDir: options?.dataDir ?? process.env.SUPER_WORK_DATA_DIR,
    cwd: process.cwd(),
  });
  await mkdir(dataDir, { recursive: true });

  const stateStore = new SqliteStateStore(join(dataDir, "super-work.db"));
  const artifactStore = new FsArtifactStore(join(dataDir, "artifacts"));
  const workspace = new GitWorktreeProvider(join(dataDir, "worktrees"));
  const cliScanner = new CliEnvironmentScanner();

  const savedSetup = await stateStore.getSystemSetting<SystemSetupConfig>("setup_config");
  const mutableLlm = new MutableControlPlaneLLM(buildControlPlaneLLMFromSetup(savedSetup));

  const scanReport: CliScanReport = await cliScanner.scanAll();
  await stateStore.setSystemSetting("last_cli_scan", scanReport);
  const summary = scanReport.tools
    .map(
      (t) =>
        `${t.id}=${!t.installed ? "missing" : t.authenticated === false ? "unauth" : "ready"}`,
    )
    .join(", ");
  console.log(
    `[super-work] CLI scan (${summary}) | recommended: impl=${scanReport.recommendedImplementEngine}, review=${scanReport.recommendedReviewEngine}`,
  );

  const drivers = [
    new ClaudeCodeDriver(),
    new CodexDriver(),
    new OpenCodeDriver(),
    new GeminiCliDriver(),
    new MockWorkerDriver(),
  ];

  const previewProvider = new WorktreePreviewManager();
  const here = dirname(fileURLToPath(import.meta.url));
  const selfRepoRoot = resolve(here, "../../..");
  const isCanaryMode = process.env.SUPER_WORK_CANARY_MODE === "1";

  let kernel!: SuperWorkKernel;
  let stopDaemonFn: (() => Promise<void>) | null = null;

  const selfHostRunner =
    options?.disableSelfHostRunner || isCanaryMode
      ? undefined
      : new BunSelfHostRunner({
          selfRepoRoot,
          bunPath: process.execPath,
          serverEntryPath: fileURLToPath(import.meta.url),
          onTriggerReload: async (reason) => {
            console.log(`[super-work] Reloading daemon: ${reason}`);
            if (stopDaemonFn) {
              await stopDaemonFn().catch(() => {});
            }
            if (process.env.SUPER_WORK_SUPERVISED === "1") {
              process.exit(RELOAD_EXIT_CODE);
            } else {
              Bun.spawn([process.execPath, ...process.argv.slice(1)], {
                stdio: ["ignore", "inherit", "inherit"],
                env: process.env,
              });
              process.exit(0);
            }
          },
        });

  kernel = new SuperWorkKernel({
    stateStore,
    artifactStore,
    workspace,
    llm: mutableLlm,
    drivers,
    outboxExecutor: new GhOutboxExecutor(workspace),
    previewProvider,
    selfHostRunner,
    dataDir,
  });

  const candidateRepoRoot = resolve(
    options?.defaultRepoPath ?? process.env.SUPER_WORK_DEFAULT_REPO ?? process.cwd(),
  );
  // Auto-register workspace repository if none registered yet
  const existingRepos = await stateStore.listRepos();
  if (existingRepos.length === 0) {
    const candidateRoot = candidateRepoRoot;
    if (existsSync(join(candidateRoot, ".git"))) {
      const branchRes = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], candidateRoot);
      const baseBranch =
        branchRes.exitCode === 0 && branchRes.stdout.trim() && branchRes.stdout.trim() !== "HEAD"
          ? branchRes.stdout.trim()
          : "main";
      const remoteRes = await runGit(["remote", "get-url", "origin"], candidateRoot);
      const githubRepo =
        remoteRes.exitCode === 0 ? parseGithubRepoFromRemote(remoteRes.stdout) : undefined;
      const ts = nowIso();
      await stateStore.upsertRepo({
        id: "repo_default",
        name: basename(candidateRoot),
        rootPath: candidateRoot,
        baseBranch,
        mode: "observe",
        githubRepo,
        defaultTemplate: "standard",
        preferredImplementEngine:
          savedSetup?.preferredImplementEngine ?? scanReport.recommendedImplementEngine,
        preferredReviewEngine:
          savedSetup?.preferredReviewEngine ?? scanReport.recommendedReviewEngine,
        autoCleanupWorktree: true,
        createdAt: ts,
        updatedAt: ts,
      });
    }
  }

  const webDistDir = resolve(here, "../../web/dist");
  const notificationDispatcher = new NotificationDispatcher(stateStore);
  const detachNotifications = notificationDispatcher.attachToKernel(kernel);

  // Sync super-work.json contracts across all registered repos at daemon boot
  const registeredRepos = await stateStore.listRepos();
  for (const regRepo of registeredRepos) {
    await kernel.syncRepoContract(regRepo.id).catch(() => {});
  }

  const app = createServerApp({
    kernel,
    stateStore,
    artifactStore,
    mutableLlm,
    cliScanner,
    notificationDispatcher,
    authToken,
    webDistDir,
  });

  const ghPoller = new GhCliPollingSource(kernel);
  const recovery = await kernel.recoverInterruptedRuns();
  if (recovery.recoveredTickets > 0 || recovery.requeuedOutbox > 0) {
    console.log(
      `[super-work] Crash recovery: resumed ${recovery.recoveredTickets} ticket(s), requeued ${recovery.requeuedOutbox} outbox entry/entries`,
    );
  }
  kernel.start();
  if (!isCanaryMode) {
    ghPoller.start();
  }

  const server = Bun.serve({
    hostname: host,
    port,
    fetch: app.fetch,
    idleTimeout: 120,
  });

  const stop = async () => {
    detachNotifications();
    ghPoller.stop();
    await kernel.stop();
    server.stop(true);
    stateStore.close();
  };
  stopDaemonFn = stop;

  return { server, kernel, stateStore, ghPoller, notificationDispatcher, stop };
}

if (import.meta.main) {
  const daemon = await startDaemon();
  console.log(`super-work daemon listening on http://localhost:${daemon.server.port}`);

  const handleSignal = async () => {
    console.log("\nShutting down super-work daemon...");
    await daemon.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void handleSignal());
  process.on("SIGTERM", () => void handleSignal());
}
