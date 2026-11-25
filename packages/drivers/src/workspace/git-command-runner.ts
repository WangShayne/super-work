import { spawn } from "node:child_process";
import { createServer } from "node:net";

export async function allocateFreeLocalPort(): Promise<number> {
  return new Promise<number>((resolvePort, rejectPort) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rejectPort);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close(() => rejectPort(new Error("Failed to allocate ephemeral TCP port")));
        return;
      }
      const { port } = addr;
      srv.close((err) => {
        if (err) rejectPort(err);
        else resolvePort(port);
      });
    });
  });
}

export interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runGit(
  args: string[],
  cwd: string,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<GitCommandResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export async function runGh(args: string[], cwd: string): Promise<GitCommandResult> {
  try {
    const proc = Bun.spawn(["gh", ...args], {
      cwd,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } catch (err) {
    return { exitCode: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
}

export interface PorcelainEntry {
  xy: string;
  path: string;
}

export async function readPorcelainEntries(cwd: string): Promise<PorcelainEntry[]> {
  const res = await runGit(["status", "--porcelain", "-uall", "-z"], cwd);
  if (res.exitCode !== 0) return [];
  const tokens = res.stdout.split("\0");
  const out: PorcelainEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t || t.length < 4) continue;
    const xy = t.slice(0, 2);
    out.push({ xy, path: t.slice(3) });
    if (xy.includes("R") || xy.includes("C")) i++; // skip the rename/copy origin token
  }
  return out;
}
