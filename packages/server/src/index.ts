import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SuperWorkKernel, type CliScanReport, type SystemSetupConfig, nowIso } from "@super-work/core";
import {
  ClaudeCodeDriver,
  CliEnvironmentScanner,
  CodexDriver,
  FsArtifactStore,
  GhCliPollingSource,
  GhOutboxExecutor,
  GitWorktreeProvider,
  MockWorkerDriver,
  MutableControlPlaneLLM,
  SqliteStateStore,
  buildControlPlaneLLMFromSetup,
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
  stop: () => Promise<void>;
}

export async function startDaemon(options?: {
  port?: number;
  dataDir?: string;
  defaultRepoPath?: string;
  enableMockFallback?: boolean;
}): Promise<StartedDaemon> {
  const port = options?.port ?? Number(process.env.PORT ?? 4318);
  const dataDir = resolve(options?.dataDir ?? process.env.SUPER_WORK_DATA_DIR ?? join(process.cwd(), ".super-work"));
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
    new MockWorkerDriver(),
  ];

  const kernel = new SuperWorkKernel({
    stateStore,
    artifactStore,
    workspace,
    llm: mutableLlm,
    drivers,
    outboxExecutor: new GhOutboxExecutor(),
  });

  // Auto-register workspace repository if none registered yet
  const existingRepos = await stateStore.listRepos();
  if (existingRepos.length === 0) {
    const candidateRoot = resolve(options?.defaultRepoPath ?? process.cwd());
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
        createdAt: ts,
        updatedAt: ts,
      });
    }
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const webDistDir = resolve(here, "../../web/dist");

  const app = createServerApp({
    kernel,
    stateStore,
    artifactStore,
    mutableLlm,
    cliScanner,
    webDistDir,
  });

  const ghPoller = new GhCliPollingSource(kernel);
  kernel.start();
  ghPoller.start();

  const server = Bun.serve({
    port,
    fetch: app.fetch,
    idleTimeout: 120,
  });

  const stop = async () => {
    ghPoller.stop();
    await kernel.stop();
    server.stop(true);
    stateStore.close();
  };

  return { server, kernel, stateStore, ghPoller, stop };
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
