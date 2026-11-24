import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CanaryBootResult, SelfHostRunner } from "@super-work/core";
import { allocateFreeLocalPort } from "../workspace/git-worktree-provider.ts";

export const RELOAD_EXIT_CODE = 75;

export interface BunSelfHostRunnerOptions {
  selfRepoRoot: string;
  serverEntryPath?: string;
  bunPath?: string;
  buildCommand?: string[];
  canaryTimeoutMs?: number;
  buildTimeoutMs?: number;
  onTriggerReload: (reason: string) => Promise<void>;
}

async function runCommandWithTimeout(
  argv: string[],
  cwd: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(argv, {
    cwd,
    env: env ?? process.env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGTERM");
    } catch {
      // Ignore already exited
    }
  }, timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text().catch(() => ""),
    new Response(proc.stderr).text().catch(() => ""),
    proc.exited,
  ]);
  clearTimeout(timer);

  const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  return {
    exitCode: timedOut ? 124 : exitCode,
    output: timedOut ? `${combined}\n[timed out after ${timeoutMs}ms]`.trim() : combined,
  };
}

export class BunSelfHostRunner implements SelfHostRunner {
  readonly selfRepoRoot: string;
  private readonly serverEntryPath: string;
  private readonly bunPath: string;
  private readonly buildCommand: string[];
  private readonly canaryTimeoutMs: number;
  private readonly buildTimeoutMs: number;
  private readonly onTriggerReload: (reason: string) => Promise<void>;

  constructor(options: BunSelfHostRunnerOptions) {
    this.selfRepoRoot = resolve(options.selfRepoRoot);
    this.bunPath = options.bunPath ?? process.execPath ?? "bun";
    this.serverEntryPath =
      options.serverEntryPath ?? join(this.selfRepoRoot, "packages/server/src/index.ts");
    this.buildCommand = options.buildCommand ?? [this.bunPath, "run", "build"];
    this.canaryTimeoutMs = options.canaryTimeoutMs ?? 15_000;
    this.buildTimeoutMs = options.buildTimeoutMs ?? 90_000;
    this.onTriggerReload = options.onTriggerReload;
  }

  async verifyBuildAndCanaryBoot(options?: {
    commitSha?: string;
    timeoutMs?: number;
  }): Promise<CanaryBootResult> {
    const started = Date.now();

    if (this.buildCommand.length > 0) {
      const buildRes = await runCommandWithTimeout(
        this.buildCommand,
        this.selfRepoRoot,
        this.buildTimeoutMs,
      );
      if (buildRes.exitCode !== 0) {
        return {
          ok: false,
          buildOk: false,
          durationMs: Date.now() - started,
          summary: `Self-host build failed (exit ${buildRes.exitCode})`,
          errorOutput: buildRes.output.slice(-2000),
        };
      }
    }

    const port = await allocateFreeLocalPort();
    const canaryDataDir = await mkdtemp(join(tmpdir(), "sw-canary-"));
    const canaryProc = Bun.spawn([this.bunPath, "run", this.serverEntryPath], {
      cwd: this.selfRepoRoot,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        SUPER_WORK_DATA_DIR: canaryDataDir,
        SUPER_WORK_CANARY_MODE: "1",
        SUPER_WORK_SUPERVISED: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const pump = (stream: ReadableStream<Uint8Array> | null, target: string[]) => {
      if (!stream) return;
      void (async () => {
        const reader = stream.getReader();
        const dec = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) target.push(dec.decode(value, { stream: true }));
          }
        } catch {
          // Ignore stream close
        }
      })();
    };
    pump(canaryProc.stdout, stdoutChunks);
    pump(canaryProc.stderr, stderrChunks);

    let exitedCode: number | null = null;
    void canaryProc.exited.then((c) => {
      exitedCode = c;
    });

    const timeoutMs = options?.timeoutMs ?? this.canaryTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    const healthUrl = `http://127.0.0.1:${port}/api/health`;
    let healthy = false;
    let lastError = "";

    try {
      while (Date.now() < deadline && exitedCode === null) {
        try {
          const res = await fetch(healthUrl, { signal: AbortSignal.timeout(1_500) });
          if (res.ok) {
            const payload = (await res.json().catch(() => ({}))) as { ok?: boolean };
            if (payload.ok) {
              healthy = true;
              break;
            }
          }
          lastError = `HTTP ${res.status}`;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
        await new Promise((r) => setTimeout(r, 150));
      }

      const durationMs = Date.now() - started;
      const tailOutput = [...stdoutChunks, ...stderrChunks].join("").trim().slice(-2000);
      if (!healthy) {
        return {
          ok: false,
          buildOk: true,
          canaryPort: port,
          durationMs,
          summary:
            exitedCode !== null
              ? `Boot Canary exited early (code=${exitedCode}) on port ${port}`
              : `Boot Canary timed out waiting for ${healthUrl} (${lastError || "unreachable"})`,
          errorOutput: tailOutput || lastError,
        };
      }

      return {
        ok: true,
        buildOk: true,
        canaryPort: port,
        durationMs,
        summary: `Build & Boot Canary passed on 127.0.0.1:${port} in ${durationMs}ms${options?.commitSha ? ` (${options.commitSha})` : ""}`,
      };
    } finally {
      try {
        canaryProc.kill("SIGTERM");
        await Promise.race([
          canaryProc.exited,
          new Promise((r) => setTimeout(r, 1_000)),
        ]);
      } catch {
        // Ignore already exited
      }
      await rm(canaryDataDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async triggerProcessReload(reason: string): Promise<void> {
    await this.onTriggerReload(reason);
  }
}
