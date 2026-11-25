import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { createDefaultMandate, type RepoConfig, type Ticket } from "@super-work/core";
import {
  GitWorktreeProvider,
  buildSanitizedWorkerEnv,
  detectLocalBrowserBinary,
  runCdpBrowserCheck,
  runGit,
  wrapCommandWithOsSandbox,
} from "../src/index.ts";

const ONE_BY_ONE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function createTempGitRepo(baseDir: string, name: string): Promise<string> {
  const repoDir = join(baseDir, name);
  await runGit(["init", "-b", "main", repoDir], baseDir);
  await runGit(["config", "user.name", "Test User"], repoDir);
  await runGit(["config", "user.email", "test@example.com"], repoDir);
  await writeFile(join(repoDir, "README.md"), `# ${name}\n`, "utf8");
  await runGit(["add", "."], repoDir);
  await runGit(["commit", "-m", "initial commit"], repoDir);
  return repoDir;
}

describe("v0.8.0 Drivers (C.1 OS Sandbox & Env Scrubbing + B.1 CDP Browser Gate)", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("C.1: scrubs control-plane secrets and isolates engine credentials per worker", () => {
    const fakeEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      SUPER_WORK_TOKEN: "secret-bearer-token",
      SUPER_WORK_LLM_API_KEY: "secret-llm-key",
      SUPER_WORK_WEBHOOK_SECRET: "secret-webhook",
      SUPER_WORK_ACTION_SECRET: "secret-action",
      GITHUB_WEBHOOK_SECRET: "secret-gh",
      CLAUDECODE: "1",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      ANTHROPIC_API_KEY: "ant-key",
      OPENAI_API_KEY: "oai-key",
      DEEPSEEK_API_KEY: "ds-key",
    };

    const claudeEnv = buildSanitizedWorkerEnv({ baseEnv: fakeEnv, engine: "claude" });
    expect(claudeEnv.SUPER_WORK_TOKEN).toBeUndefined();
    expect(claudeEnv.SUPER_WORK_LLM_API_KEY).toBeUndefined();
    expect(claudeEnv.SUPER_WORK_ACTION_SECRET).toBeUndefined();
    expect(claudeEnv.GITHUB_WEBHOOK_SECRET).toBeUndefined();
    expect(claudeEnv.CLAUDECODE).toBeUndefined();
    expect(claudeEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(claudeEnv.ANTHROPIC_API_KEY).toBe("ant-key");
    expect(claudeEnv.OPENAI_API_KEY).toBeUndefined();
    expect(claudeEnv.DEEPSEEK_API_KEY).toBeUndefined();

    const codexEnv = buildSanitizedWorkerEnv({ baseEnv: fakeEnv, engine: "codex" });
    expect(codexEnv.OPENAI_API_KEY).toBe("oai-key");
    expect(codexEnv.ANTHROPIC_API_KEY).toBeUndefined();

    const verifyEnv = buildSanitizedWorkerEnv({
      baseEnv: fakeEnv,
      engine: "verification",
      extraEnv: { PORT: "4567", SUPER_WORK_TOKEN: "must-stay-stripped" },
    });
    expect(verifyEnv.PORT).toBe("4567");
    expect(verifyEnv.SUPER_WORK_TOKEN).toBeUndefined();
    expect(verifyEnv.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("C.1: supports skipOuterSandbox, off mode, and real macOS Seatbelt worktree/forbidden/strict isolation", async () => {
    const offWrapped = wrapCommandWithOsSandbox({
      commandArgv: ["echo", "ok"],
      worktreePath: "/tmp/wt-off",
      mode: "off",
      engine: "mock",
    });
    expect(offWrapped.appliedBackend).toBe("off");

    const skipWrapped = wrapCommandWithOsSandbox({
      commandArgv: ["codex", "exec"],
      worktreePath: "/tmp/wt-codex",
      mode: "balanced",
      engine: "codex",
      skipOuterSandbox: true,
      baseEnv: { ...process.env, SUPER_WORK_TOKEN: "strip-me", OPENAI_API_KEY: "oai-ok" },
    });
    expect(skipWrapped.appliedBackend).toBe("env_only");
    expect(skipWrapped.env.SUPER_WORK_TOKEN).toBeUndefined();
    expect(skipWrapped.env.OPENAI_API_KEY).toBe("oai-ok");

    // Already inside an outer Seatbelt sandbox: nested sandbox-exec is intentionally skipped (exit 71 otherwise).
    if (process.platform !== "darwin" || process.env.SUPER_WORK_IN_OS_SANDBOX === "1") {
      return;
    }

    const dir = await mkdtemp(join(tmpdir(), "sw-v080-drv-"));
    tempDirs.push(dir);
    const repoPath = await createTempGitRepo(dir, "sandbox-repo");
    const worktreeBase = join(dir, "worktrees");
    // Host temp dirs are intentionally writable (v1.5.0), so probe a denied area: the user home.
    const outsideFile = join(homedir(), `.sw-v080-outside-${Date.now()}.txt`);

    const workspace = new GitWorktreeProvider(worktreeBase);
    const repo: RepoConfig = {
      id: "repo_sbx",
      name: "sandbox-repo",
      rootPath: repoPath,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "fast",
      preferredImplementEngine: "claude",
      preferredReviewEngine: "claude",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const ticket: Ticket = {
      id: "tkt_sbx",
      repoId: repo.id,
      threadId: "thr_sbx",
      sourceTriggerId: "trg_sbx",
      title: "Sandbox check",
      description: "Verify sandbox boundaries",
      status: "implementing",
      template: "fast",
      currentStage: "implement",
      stageRetries: 0,
      mandate: createDefaultMandate(),
      dependsOn: [],
      nativeSessions: {},
      inlineMemory: {
        goal: "Verify sandbox boundaries",
        acceptanceCriteria: [],
        stageNotes: [],
        threadUpdates: [],
      },
      costUsd: 0,
      priority: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const { worktreePath } = await workspace.prepareWorkspace(ticket, repo);
    await writeFile(join(worktreePath, ".env"), "SECRET=123\n", "utf8");

    // 1. Inside worktree write + git status succeeds under balanced Seatbelt
    const insideWrapped = wrapCommandWithOsSandbox({
      commandArgv: ["sh", "-lc", "echo 'ok' > inside.txt && git status --porcelain"],
      worktreePath,
      rootRepoPath: repoPath,
      mode: "balanced",
      forbiddenPaths: [".env*"],
      engine: "claude",
    });
    expect(insideWrapped.appliedBackend).toBe("seatbelt");
    const insideProc = Bun.spawn(insideWrapped.argv, {
      cwd: worktreePath,
      env: insideWrapped.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const insideExit = await insideProc.exited;
    expect(insideExit).toBe(0);

    // 2. Outside write is denied by Seatbelt
    const outsideWrapped = wrapCommandWithOsSandbox({
      commandArgv: ["sh", "-lc", `echo blocked > ${JSON.stringify(outsideFile)}`],
      worktreePath,
      rootRepoPath: repoPath,
      mode: "balanced",
      forbiddenPaths: [".env*"],
      engine: "claude",
    });
    const outsideProc = Bun.spawn(outsideWrapped.argv, {
      cwd: worktreePath,
      env: outsideWrapped.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await outsideProc.exited).not.toBe(0);

    // 3. Forbidden .env read & write fail, while lstat metadata check (`test -e .env`) still succeeds
    const readEnvWrapped = wrapCommandWithOsSandbox({
      commandArgv: ["sh", "-lc", "cat .env"],
      worktreePath,
      rootRepoPath: repoPath,
      mode: "balanced",
      forbiddenPaths: [".env*"],
      engine: "claude",
    });
    const readEnvProc = Bun.spawn(readEnvWrapped.argv, {
      cwd: worktreePath,
      env: readEnvWrapped.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await readEnvProc.exited).not.toBe(0);

    const writeEnvWrapped = wrapCommandWithOsSandbox({
      commandArgv: ["sh", "-lc", "echo LEAK >> .env"],
      worktreePath,
      rootRepoPath: repoPath,
      mode: "balanced",
      forbiddenPaths: [".env*"],
      engine: "claude",
    });
    const writeEnvProc = Bun.spawn(writeEnvWrapped.argv, {
      cwd: worktreePath,
      env: writeEnvWrapped.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await writeEnvProc.exited).not.toBe(0);

    const statEnvWrapped = wrapCommandWithOsSandbox({
      commandArgv: ["sh", "-lc", "test -e .env"],
      worktreePath,
      rootRepoPath: repoPath,
      mode: "balanced",
      forbiddenPaths: [".env*"],
      engine: "claude",
    });
    const statEnvProc = Bun.spawn(statEnvWrapped.argv, {
      cwd: worktreePath,
      env: statEnvWrapped.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await statEnvProc.exited).toBe(0);

    // 4. Strict mode blocks outbound network requests
    const localHttp = Bun.serve({ port: 0, fetch: () => new Response("pong") });
    try {
      const netWrapped = wrapCommandWithOsSandbox({
        commandArgv: [
          process.execPath,
          "-e",
          `fetch("http://127.0.0.1:${localHttp.port}").then(() => process.exit(0)).catch(() => process.exit(42))`,
        ],
        worktreePath,
        rootRepoPath: repoPath,
        mode: "strict",
        engine: "claude",
      });
      const netProc = Bun.spawn(netWrapped.argv, {
        cwd: worktreePath,
        env: netWrapped.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await netProc.exited).not.toBe(0);
    } finally {
      localHttp.stop(true);
    }
  });

  it("B.1: executes CDP browser gate checks and captures PNG screenshots over WebSocket", async () => {
    const detected = detectLocalBrowserBinary();
    expect(detected === null || typeof detected === "string").toBe(true);

    let scenario: "pass" | "page_error" | "missing_selector" = "pass";
    const mockCdpServer = Bun.serve({
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req)) return undefined;
        return new Response("upgrade required", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          const msg = JSON.parse(String(raw)) as {
            id: number;
            method: string;
            params?: Record<string, unknown>;
          };
          if (msg.method === "Page.navigate") {
            const url = String(msg.params?.url ?? "");
            ws.send(JSON.stringify({ id: msg.id, result: { frameId: "f1" } }));
            ws.send(
              JSON.stringify({
                method: "Network.responseReceived",
                params: { response: { status: 200, url } },
              }),
            );
            if (scenario === "page_error") {
              ws.send(
                JSON.stringify({
                  method: "Runtime.exceptionThrown",
                  params: {
                    exceptionDetails: {
                      text: "Uncaught Error",
                      exception: { description: "ReferenceError: brokenWidget is not defined" },
                    },
                  },
                }),
              );
            }
            ws.send(JSON.stringify({ method: "Page.loadEventFired", params: {} }));
            return;
          }
          if (msg.method === "Runtime.evaluate") {
            ws.send(
              JSON.stringify({
                id: msg.id,
                result: { result: { value: scenario !== "missing_selector" } },
              }),
            );
            return;
          }
          if (msg.method === "Page.captureScreenshot") {
            ws.send(
              JSON.stringify({
                id: msg.id,
                result: { data: ONE_BY_ONE_PNG_B64 },
              }),
            );
            return;
          }
          ws.send(JSON.stringify({ id: msg.id, result: {} }));
        },
      },
    });

    const cdpWsUrlOverride = `ws://127.0.0.1:${mockCdpServer.port}/devtools/page/mock-1`;
    try {
      // (a) Clean pass + valid PNG bytes
      scenario = "pass";
      const passRes = await runCdpBrowserCheck(
        "http://127.0.0.1:4000",
        { enabled: true, paths: ["/", "/settings"], waitForSelector: "#app" },
        { cdpWsUrlOverride },
      );
      expect(passRes.summary.executed).toBe(true);
      expect(passRes.summary.ok).toBe(true);
      expect(passRes.summary.routes).toHaveLength(2);
      expect(passRes.rawScreenshots).toHaveLength(2);
      expect(passRes.rawScreenshots[0]!.bytes.length).toBeGreaterThan(20);
      expect(passRes.rawScreenshots[0]!.bytes[0]).toBe(0x89);
      expect(passRes.rawScreenshots[0]!.bytes[1]).toBe(0x50);

      // (b) Runtime page exception fails gate
      scenario = "page_error";
      const errRes = await runCdpBrowserCheck(
        "http://127.0.0.1:4000",
        { enabled: true, paths: ["/"] },
        { cdpWsUrlOverride },
      );
      expect(errRes.summary.ok).toBe(false);
      expect(errRes.summary.routes[0]!.pageErrors).toHaveLength(1);
      expect(errRes.summary.routes[0]!.pageErrors[0]).toContain("brokenWidget");

      // (c) Missing waitForSelector fails gate
      scenario = "missing_selector";
      const selRes = await runCdpBrowserCheck(
        "http://127.0.0.1:4000",
        { enabled: true, paths: ["/"], waitForSelector: "#app" },
        { cdpWsUrlOverride },
      );
      expect(selRes.summary.ok).toBe(false);
      expect(selRes.summary.routes[0]!.missingSelector).toBe("#app");
    } finally {
      mockCdpServer.stop(true);
    }
  });
});
