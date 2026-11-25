import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SandboxMode, SmokeCheckConfig, SmokeCheckResult, VerificationCommandOutput, VerificationRunResult } from "@super-work/core";
import type { BrowserCheckExecutionResult } from "../browser/cdp-browser-check.ts";
import { comparePngVisualDiff } from "../browser/png-visual-diff.ts";
import { wrapCommandWithOsSandbox } from "../sandbox/os-sandbox.ts";
import { allocateFreeLocalPort } from "./git-command-runner.ts";
import type { GitWorkspaceContext } from "./git-workspace-context.ts";

export async function runVerificationCommandsImpl(
  worktreePath: string,
  commands: string[],
  timeoutSec = 120,
  options?: {
    env?: NodeJS.ProcessEnv;
    sandboxMode?: SandboxMode;
    forbiddenPaths?: string[];
    readOnlyPaths?: string[];
    allowNetwork?: boolean;
    rootRepoPath?: string;
  },
): Promise<VerificationRunResult> {
  const cleanCmds = commands.map((c) => c.trim()).filter(Boolean);
  if (cleanCmds.length === 0) {
    return {
      ok: true,
      results: [],
      summary: "No verification commands configured",
    };
  }

  const timeoutMs = Math.max(5, Math.min(timeoutSec, 300)) * 1_000;
  const results: VerificationCommandOutput[] = [];
  const sandboxMode: SandboxMode = options?.sandboxMode ?? "off";

  for (const command of cleanCmds) {
    const started = Date.now();
    const baseArgv = ["sh", "-lc", command];
    const wrapped =
      sandboxMode !== "off"
        ? wrapCommandWithOsSandbox({
            commandArgv: baseArgv,
            worktreePath,
            rootRepoPath: options?.rootRepoPath,
            mode: sandboxMode,
            forbiddenPaths: options?.forbiddenPaths,
            readOnlyPaths: options?.readOnlyPaths,
            allowNetwork: options?.allowNetwork,
            engine: "verification",
            baseEnv: options?.env ?? process.env,
            // Balanced: keep env secret scrubbing but skip the outer sandbox-exec so test suites that
            // launch headless Chrome (own sandbox_init) are not denied by a nested Seatbelt.
            skipOuterSandbox: sandboxMode === "balanced" ? true : undefined,
          })
        : {
            argv: baseArgv,
            env: options?.env ?? process.env,
            appliedBackend: "off" as const,
          };

    const proc = Bun.spawn(wrapped.argv, {
      cwd: worktreePath,
      env: wrapped.env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        // Ignore already exited
      }
    }, timeoutMs);

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);

    const durationMs = Date.now() - started;
    const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    const finalExit = timedOut ? 124 : exitCode;
    results.push({
      command,
      exitCode: finalExit,
      durationMs,
      output: timedOut ? `${combined}\n[timed out after ${timeoutMs}ms]`.trim() : combined,
    });

    if (finalExit !== 0) {
      return {
        ok: false,
        results,
        failedCommand: command,
        summary: `Verification failed on command: ${command} (exit ${finalExit})\n${combined.slice(-1500)}`,
      };
    }
  }

  return {
    ok: true,
    results,
    summary: `All ${results.length} verification command(s) passed (${cleanCmds.join(", ")})`,
  };
}

export async function runSmokeCheckImpl(ctx: GitWorkspaceContext, 
  worktreePath: string,
  config: SmokeCheckConfig,
  options?: {
    baselineScreenshotsDir?: string;
    resolveBaselineScreenshotsDir?: () => Promise<string | undefined>;
  },
): Promise<SmokeCheckResult> {
  const startCommand = config.startCommand.trim();
  if (!startCommand) {
    return {
      ok: true,
      port: 0,
      readyUrl: "",
      startupDurationMs: 0,
      checkResults: [],
      serverOutputTail: "",
      summary: "No smoke startCommand configured",
    };
  }

  const port = await allocateFreeLocalPort();
  const smokeUrl = `http://127.0.0.1:${port}`;
  const rawReadyUrl = config.readyUrl?.trim() || smokeUrl;
  const normalizedRawReadyUrl = rawReadyUrl.startsWith("/")
    ? `${smokeUrl}${rawReadyUrl}`
    : rawReadyUrl;
  const readyUrl = normalizedRawReadyUrl
    .replace(/\$\{SUPER_WORK_SMOKE_URL\}|\$SUPER_WORK_SMOKE_URL/g, smokeUrl)
    .replace(/\$\{SUPER_WORK_SMOKE_PORT\}|\$SUPER_WORK_SMOKE_PORT/g, String(port))
    .replace(/\$\{PORT\}|\$PORT/g, String(port));

  const smokeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    SUPER_WORK_SMOKE_PORT: String(port),
    SUPER_WORK_SMOKE_URL: smokeUrl,
  };

  const timeoutMs = Math.max(2, Math.min(120, config.startupTimeoutSec ?? 20)) * 1_000;
  const startedAt = Date.now();
  let outputTail = "";
  const appendOutput = (chunk: Buffer | string) => {
    outputTail = `${outputTail}${String(chunk)}`;
    if (outputTail.length > 4000) {
      outputTail = outputTail.slice(-4000);
    }
  };

  const child = spawn("sh", ["-lc", startCommand], {
    cwd: worktreePath,
    env: smokeEnv,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", appendOutput);
  child.stderr?.on("data", appendOutput);

  let exited = false;
  let earlyExit: { code: number | null; signal: string | null } | null = null;
  const exitedPromise = new Promise<void>((res) => {
    const finish = (code: number | null, signal: string | null) => {
      if (!exited) {
        exited = true;
        earlyExit = { code, signal };
      }
      res();
    };
    child.once("exit", finish);
    child.once("error", (err) => {
      appendOutput(`\n[spawn error] ${err.message}`);
      finish(1, null);
    });
  });

  const killProcessGroup = async () => {
    const pid = child.pid;
    if (!pid || exited) return;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore already exited
      }
    }
    await Promise.race([exitedPromise, new Promise((r) => setTimeout(r, 1_200))]);
    if (!exited) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // Ignore already exited
        }
      }
      await Promise.race([exitedPromise, new Promise((r) => setTimeout(r, 400))]);
    }
  };

  try {
    const deadline = startedAt + timeoutMs;
    let ready = false;
    let probeStatus: number | undefined;
    let lastProbeErr = "";

    while (Date.now() < deadline) {
      if (earlyExit) {
        await new Promise((r) => setTimeout(r, 25));
        break;
      }
      try {
        const res = await fetch(readyUrl, {
          signal: AbortSignal.timeout(Math.min(1_500, Math.max(250, deadline - Date.now()))),
        });
        probeStatus = res.status;
        if (res.status >= 200 && res.status < 300) {
          ready = true;
          break;
        }
        lastProbeErr = `HTTP ${res.status}`;
      } catch (err) {
        lastProbeErr = err instanceof Error ? err.message : String(err);
      }
      if (earlyExit) break;
      await new Promise((r) => setTimeout(r, 150));
    }

    const startupDurationMs = Date.now() - startedAt;
    if (!ready) {
      const tail = outputTail.trim();
      const reason = earlyExit
        ? `Smoke server exited early (code=${(earlyExit as { code: number | null }).code ?? "null"})`
        : `Timed out waiting ${timeoutMs}ms for HTTP 2xx from ${readyUrl} (${lastProbeErr || "unreachable"})`;
      return {
        ok: false,
        port,
        readyUrl,
        startupDurationMs,
        probeStatus,
        checkResults: [],
        serverOutputTail: tail,
        failedStep: earlyExit ? "smoke:server_exited_early" : `smoke:readyUrl(${readyUrl})`,
        summary: tail ? `${reason}\n${tail.slice(-1000)}` : reason,
      };
    }

    const checkCmds = (config.checkCommands ?? []).map((c) => c.trim()).filter(Boolean);
    const checkRes = await runVerificationCommandsImpl(worktreePath, checkCmds, 60, {
      env: smokeEnv,
    });
    if (!checkRes.ok) {
      const tail = outputTail.trim();
      return {
        ok: false,
        port,
        readyUrl,
        startupDurationMs,
        probeStatus,
        checkResults: checkRes.results,
        serverOutputTail: tail,
        failedStep: checkRes.failedCommand ? `smoke:${checkRes.failedCommand}` : "smoke:checkCommands",
        summary: tail ? `${checkRes.summary}\nServer tail:\n${tail.slice(-800)}` : checkRes.summary,
      };
    }

    let browserExec: BrowserCheckExecutionResult | undefined;
    let rawVisualDiffs: SmokeCheckResult["rawVisualDiffs"];
    if (config.browserCheck?.enabled) {
      let browserBaseUrl = smokeUrl;
      try {
        browserBaseUrl = new URL(readyUrl).origin;
      } catch {
        browserBaseUrl = smokeUrl;
      }
      browserExec = await ctx.browserRunner(browserBaseUrl, config.browserCheck);

      if (browserExec.summary.executed && !browserExec.summary.ok) {
        const tail = outputTail.trim();
        return {
          ok: false,
          port,
          readyUrl,
          startupDurationMs,
          probeStatus,
          checkResults: checkRes.results,
          serverOutputTail: tail,
          failedStep: "smoke:browserCheck",
          summary: `${browserExec.summary.summary}${tail ? `\nServer tail:\n${tail.slice(-600)}` : ""}`,
          browserResult: browserExec.summary,
          rawScreenshots: browserExec.rawScreenshots,
        };
      }

      const baselineDir =
        options?.baselineScreenshotsDir ??
        (browserExec.rawScreenshots.length > 0 && options?.resolveBaselineScreenshotsDir
          ? await options.resolveBaselineScreenshotsDir()
          : undefined);
      if (baselineDir && existsSync(baselineDir) && browserExec.rawScreenshots.length > 0) {
        const diffs: NonNullable<SmokeCheckResult["rawVisualDiffs"]> = [];
        for (const shot of browserExec.rawScreenshots) {
          const baseFile = join(baselineDir, `route_${shot.routeIndex}.png`);
          if (!existsSync(baseFile)) continue;
          try {
            const baseBytes = new Uint8Array(await readFile(baseFile));
            const diff = comparePngVisualDiff(baseBytes, shot.bytes);
            const routeObj = browserExec.summary.routes[shot.routeIndex];
            if (routeObj) {
              routeObj.diffRatio = Number(diff.diffRatio.toFixed(6));
              routeObj.baselineMatched = true;
            }
            diffs.push({
              routeIndex: shot.routeIndex,
              path: shot.path,
              diffRatio: diff.diffRatio,
              bytes: diff.diffPngBytes,
            });
          } catch {
            // Ignore non-PNG or decode failures gracefully
          }
        }
        if (diffs.length > 0) {
          rawVisualDiffs = diffs;
        }
      }
    }

    return {
      ok: true,
      port,
      readyUrl,
      startupDurationMs,
      probeStatus,
      checkResults: checkRes.results,
      serverOutputTail: outputTail.trim(),
      summary: [
        `Smoke check passed (${readyUrl} ready in ${startupDurationMs}ms${
          checkRes.results.length > 0 ? `, ${checkRes.results.length} check(s) ok` : ""
        })`,
        browserExec ? browserExec.summary.summary : "",
      ]
        .filter(Boolean)
        .join(" · "),
      ...(browserExec
        ? {
            browserResult: browserExec.summary,
            rawScreenshots: browserExec.rawScreenshots,
            ...(rawVisualDiffs ? { rawVisualDiffs } : {}),
          }
        : {}),
    };
  } finally {
    await killProcessGroup();
  }
}
