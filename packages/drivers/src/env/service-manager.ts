import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServiceDaemonStatus } from "@super-work/core";

export interface ServiceCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ServiceCommandRunner = (
  argv: string[],
) => Promise<ServiceCommandResult>;

export interface ServiceUnitSpec {
  label: string;
  bunPath: string;
  serverEntryPath: string;
  workingDir: string;
  dataDir: string;
  host: string;
  port: number;
  logFilePath: string;
  authToken?: string;
  defaultRepoPath?: string;
  pathEnv?: string;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

export function assertSafeHostBinding(host: string, authToken?: string): void {
  if (!isLoopbackHost(host) && !authToken?.trim()) {
    throw new Error(
      `Refusing to bind super-work daemon to non-loopback host '${host}' without SUPER_WORK_TOKEN (--token). Set SUPER_WORK_TOKEN before exposing beyond localhost.`,
    );
  }
}

export function resolveSmartDataDir(input?: {
  explicitDataDir?: string;
  cwd?: string;
  homeDir?: string;
}): string {
  if (input?.explicitDataDir?.trim()) {
    return resolve(input.explicitDataDir.trim());
  }
  const cwd = resolve(input?.cwd ?? process.cwd());
  const localDir = join(cwd, ".super-work");
  if (existsSync(localDir)) {
    return localDir;
  }
  const home = resolve(input?.homeDir ?? homedir());
  return join(home, ".super-work");
}

export function rotateDaemonLogIfNeeded(
  logFilePath: string,
  maxBytes = 10 * 1024 * 1024,
): boolean {
  if (!existsSync(logFilePath)) return false;
  try {
    const st = statSync(logFilePath);
    if (st.size >= maxBytes) {
      const backupPath = `${logFilePath}.1`;
      rmSync(backupPath, { force: true });
      renameSync(logFilePath, backupPath);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function escapeXml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeSystemdArg(raw: string): string {
  return `"${raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildLaunchdPlistXml(spec: ServiceUnitSpec): string {
  const envEntries: Array<[string, string]> = [
    ["HOST", spec.host],
    ["PORT", String(spec.port)],
    ["SUPER_WORK_DATA_DIR", spec.dataDir],
    ["SUPER_WORK_LOG_FILE", spec.logFilePath],
    ["SUPER_WORK_SUPERVISED", "1"],
    ["PATH", spec.pathEnv || process.env.PATH || "/usr/local/bin:/usr/bin:/bin"],
  ];
  if (spec.authToken?.trim()) {
    envEntries.push(["SUPER_WORK_TOKEN", spec.authToken.trim()]);
  }
  if (spec.defaultRepoPath?.trim()) {
    envEntries.push(["SUPER_WORK_DEFAULT_REPO", spec.defaultRepoPath.trim()]);
  }

  const envXml = envEntries
    .map(
      ([k, v]) =>
        `    <key>${escapeXml(k)}</key>\n    <string>${escapeXml(v)}</string>`,
    )
    .join("\n");

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${escapeXml(spec.label)}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    `    <string>${escapeXml(spec.bunPath)}</string>`,
    `    <string>run</string>`,
    `    <string>${escapeXml(spec.serverEntryPath)}</string>`,
    `  </array>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${escapeXml(spec.workingDir)}</string>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    envXml,
    `  </dict>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <true/>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${escapeXml(spec.logFilePath)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${escapeXml(spec.logFilePath)}</string>`,
    `</dict>`,
    `</plist>`,
    "",
  ].join("\n");
}

export function buildSystemdUnitText(spec: ServiceUnitSpec): string {
  const envs: string[] = [
    `HOST=${spec.host}`,
    `PORT=${spec.port}`,
    `SUPER_WORK_DATA_DIR=${spec.dataDir}`,
    `SUPER_WORK_LOG_FILE=${spec.logFilePath}`,
    `SUPER_WORK_SUPERVISED=1`,
    `PATH=${spec.pathEnv || process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}`,
  ];
  if (spec.authToken?.trim()) {
    envs.push(`SUPER_WORK_TOKEN=${spec.authToken.trim()}`);
  }
  if (spec.defaultRepoPath?.trim()) {
    envs.push(`SUPER_WORK_DEFAULT_REPO=${spec.defaultRepoPath.trim()}`);
  }

  return [
    `[Unit]`,
    `Description=super-work Autonomous Agent Orchestration Daemon`,
    `After=network.target`,
    ``,
    `[Service]`,
    `Type=simple`,
    `WorkingDirectory=${spec.workingDir}`,
    `ExecStart=${escapeSystemdArg(spec.bunPath)} run ${escapeSystemdArg(spec.serverEntryPath)}`,
    `Restart=on-failure`,
    `RestartSec=3`,
    ...envs.map((e) => `Environment=${escapeSystemdArg(e)}`),
    `StandardOutput=append:${spec.logFilePath}`,
    `StandardError=append:${spec.logFilePath}`,
    ``,
    `[Install]`,
    `WantedBy=default.target`,
    "",
  ].join("\n");
}

async function defaultExecRunner(argv: string[]): Promise<ServiceCommandResult> {
  const proc = Bun.spawn(argv, {
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

export interface ServiceManagerOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  cwd?: string;
  dataDir?: string;
  host?: string;
  port?: number;
  authToken?: string;
  defaultRepoPath?: string;
  bunPath?: string;
  serverEntryPath?: string;
  webDistDir?: string;
  execRunner?: ServiceCommandRunner;
  uid?: number;
}

export class ServiceManager {
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly cwd: string;
  readonly dataDir: string;
  readonly host: string;
  readonly port: number;
  readonly authToken?: string;
  readonly defaultRepoPath?: string;
  readonly bunPath: string;
  readonly serverEntryPath: string;
  readonly webDistDir: string;
  readonly logFilePath: string;
  private readonly execRunner: ServiceCommandRunner;
  private readonly uid: number;

  static readonly LAUNCHD_LABEL = "ai.superwork.daemon";
  static readonly SYSTEMD_UNIT = "super-work.service";

  constructor(options?: ServiceManagerOptions) {
    this.platform = options?.platform ?? process.platform;
    this.homeDir = resolve(options?.homeDir ?? homedir());
    this.cwd = resolve(options?.cwd ?? process.cwd());
    this.dataDir = resolveSmartDataDir({
      explicitDataDir: options?.dataDir ?? process.env.SUPER_WORK_DATA_DIR,
      cwd: this.cwd,
      homeDir: this.homeDir,
    });
    this.host = (options?.host ?? process.env.HOST ?? "127.0.0.1").trim();
    this.port = Number(options?.port ?? process.env.PORT ?? 4318);
    this.authToken = options?.authToken ?? (process.env.SUPER_WORK_TOKEN?.trim() || undefined);
    this.defaultRepoPath = options?.defaultRepoPath;

    const here = dirname(fileURLToPath(import.meta.url));
    this.bunPath = options?.bunPath ?? (Bun.which("bun") || process.execPath);
    this.serverEntryPath =
      options?.serverEntryPath ?? resolve(here, "../../../server/src/index.ts");
    this.webDistDir = options?.webDistDir ?? resolve(here, "../../../web/dist");
    this.logFilePath = join(this.dataDir, "logs", "daemon.log");
    this.execRunner = options?.execRunner ?? defaultExecRunner;
    this.uid = options?.uid ?? (typeof process.getuid === "function" ? process.getuid() : 501);
  }

  getServiceFilePath(): string | undefined {
    if (this.platform === "darwin") {
      return join(this.homeDir, "Library", "LaunchAgents", `${ServiceManager.LAUNCHD_LABEL}.plist`);
    }
    if (this.platform === "linux") {
      return join(this.homeDir, ".config", "systemd", "user", ServiceManager.SYSTEMD_UNIT);
    }
    return undefined;
  }

  private buildUnitSpec(): ServiceUnitSpec {
    return {
      label: ServiceManager.LAUNCHD_LABEL,
      bunPath: this.bunPath,
      serverEntryPath: this.serverEntryPath,
      workingDir: this.cwd,
      dataDir: this.dataDir,
      host: this.host,
      port: this.port,
      logFilePath: this.logFilePath,
      authToken: this.authToken,
      defaultRepoPath: this.defaultRepoPath,
      pathEnv: process.env.PATH,
    };
  }

  private getLaunchdTarget(): string {
    return `gui/${this.uid}/${ServiceManager.LAUNCHD_LABEL}`;
  }

  async install(options?: { startNow?: boolean }): Promise<ServiceDaemonStatus> {
    assertSafeHostBinding(this.host, this.authToken);
    const serviceFile = this.getServiceFilePath();
    if (!serviceFile) {
      throw new Error(`OS service manager not supported on platform: ${this.platform}`);
    }

    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(dirname(this.logFilePath), { recursive: true });
    mkdirSync(dirname(serviceFile), { recursive: true });
    rotateDaemonLogIfNeeded(this.logFilePath);

    const spec = this.buildUnitSpec();
    if (this.platform === "darwin") {
      writeFileSync(serviceFile, buildLaunchdPlistXml(spec), "utf8");
      if (options?.startNow !== false) {
        const target = this.getLaunchdTarget();
        await this.execRunner(["launchctl", "bootout", target]).catch(() => {});
        const res = await this.execRunner([
          "launchctl",
          "bootstrap",
          `gui/${this.uid}`,
          serviceFile,
        ]);
        if (res.exitCode !== 0 && !res.stderr.includes("already")) {
          throw new Error(`launchctl bootstrap failed: ${res.stderr.trim() || res.stdout.trim()}`);
        }
      }
      return this.status();
    }

    writeFileSync(serviceFile, buildSystemdUnitText(spec), "utf8");
    await this.execRunner(["systemctl", "--user", "daemon-reload"]);
    if (options?.startNow !== false) {
      const res = await this.execRunner([
        "systemctl",
        "--user",
        "enable",
        "--now",
        ServiceManager.SYSTEMD_UNIT,
      ]);
      if (res.exitCode !== 0) {
        throw new Error(`systemctl enable --now failed: ${res.stderr.trim() || res.stdout.trim()}`);
      }
    } else {
      await this.execRunner(["systemctl", "--user", "enable", ServiceManager.SYSTEMD_UNIT]);
    }
    return this.status();
  }

  async start(): Promise<ServiceDaemonStatus> {
    assertSafeHostBinding(this.host, this.authToken);
    const serviceFile = this.getServiceFilePath();
    if (!serviceFile || !existsSync(serviceFile)) {
      throw new Error("Service is not installed. Run `super-work service install` first.");
    }
    rotateDaemonLogIfNeeded(this.logFilePath);

    if (this.platform === "darwin") {
      const target = this.getLaunchdTarget();
      const printRes = await this.execRunner(["launchctl", "print", target]);
      if (printRes.exitCode !== 0) {
        const bootRes = await this.execRunner([
          "launchctl",
          "bootstrap",
          `gui/${this.uid}`,
          serviceFile,
        ]);
        if (bootRes.exitCode !== 0) {
          throw new Error(`launchctl bootstrap failed: ${bootRes.stderr.trim() || bootRes.stdout.trim()}`);
        }
      } else {
        const kick = await this.execRunner(["launchctl", "kickstart", "-k", target]);
        if (kick.exitCode !== 0) {
          throw new Error(`launchctl kickstart failed: ${kick.stderr.trim() || kick.stdout.trim()}`);
        }
      }
      return this.status();
    }

    if (this.platform === "linux") {
      const res = await this.execRunner(["systemctl", "--user", "start", ServiceManager.SYSTEMD_UNIT]);
      if (res.exitCode !== 0) {
        throw new Error(`systemctl start failed: ${res.stderr.trim() || res.stdout.trim()}`);
      }
      return this.status();
    }

    throw new Error(`Unsupported platform: ${this.platform}`);
  }

  async stop(): Promise<ServiceDaemonStatus> {
    const serviceFile = this.getServiceFilePath();
    if (!serviceFile) {
      throw new Error(`Unsupported platform: ${this.platform}`);
    }
    if (this.platform === "darwin") {
      await this.execRunner(["launchctl", "bootout", this.getLaunchdTarget()]).catch(() => {});
      return this.status();
    }
    if (this.platform === "linux") {
      await this.execRunner(["systemctl", "--user", "stop", ServiceManager.SYSTEMD_UNIT]).catch(
        () => {},
      );
      return this.status();
    }
    throw new Error(`Unsupported platform: ${this.platform}`);
  }

  async uninstall(): Promise<ServiceDaemonStatus> {
    const serviceFile = this.getServiceFilePath();
    if (!serviceFile) {
      throw new Error(`Unsupported platform: ${this.platform}`);
    }
    await this.stop().catch(() => {});
    if (this.platform === "linux") {
      await this.execRunner([
        "systemctl",
        "--user",
        "disable",
        "--now",
        ServiceManager.SYSTEMD_UNIT,
      ]).catch(() => {});
    }
    rmSync(serviceFile, { force: true });
    if (this.platform === "linux") {
      await this.execRunner(["systemctl", "--user", "daemon-reload"]).catch(() => {});
    }
    return this.status();
  }

  async status(): Promise<ServiceDaemonStatus> {
    const serviceFile = this.getServiceFilePath();
    const webUiBuilt = existsSync(join(this.webDistDir, "index.html"));
    const logByteSize = existsSync(this.logFilePath)
      ? statSync(this.logFilePath).size
      : undefined;

    if (this.platform !== "darwin" && this.platform !== "linux") {
      return {
        platform: "unsupported",
        manager: "none",
        installed: false,
        running: false,
        dataDir: this.dataDir,
        host: this.host,
        port: this.port,
        logFilePath: this.logFilePath,
        logByteSize,
        webUiBuilt,
        detail: `OS background daemon not supported on ${this.platform}`,
      };
    }

    const installed = Boolean(serviceFile && existsSync(serviceFile));
    let running = false;
    let pid: number | undefined;
    let detail = installed ? "Service unit installed (stopped)" : "Not installed";

    if (this.platform === "darwin" && installed) {
      const res = await this.execRunner(["launchctl", "print", this.getLaunchdTarget()]).catch(
        () => ({ exitCode: 1, stdout: "", stderr: "" }),
      );
      if (res.exitCode === 0) {
        const stateMatch = res.stdout.match(/state\s*=\s*(\S+)/i);
        const pidMatch = res.stdout.match(/\bpid\s*=\s*(\d+)/i);
        if (pidMatch && Number(pidMatch[1]) > 0) {
          pid = Number(pidMatch[1]);
        }
        running = stateMatch?.[1]?.toLowerCase() === "running" || Boolean(pid);
        detail = running
          ? `LaunchAgent active (pid=${pid ?? "?"})`
          : `LaunchAgent loaded (${stateMatch?.[1] ?? "idle"})`;
      }
    } else if (this.platform === "linux" && installed) {
      const res = await this.execRunner([
        "systemctl",
        "--user",
        "show",
        ServiceManager.SYSTEMD_UNIT,
        "--property=ActiveState,MainPID",
        "--value",
      ]).catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
      if (res.exitCode === 0) {
        const lines = res.stdout.trim().split("\n").map((l) => l.trim());
        const activeState = lines[0] ?? "";
        const mainPid = Number(lines[1] ?? "0");
        running = activeState === "active";
        pid = Number.isFinite(mainPid) && mainPid > 0 ? mainPid : undefined;
        detail = running
          ? `systemd user service active (pid=${pid ?? "?"})`
          : `systemd user service state=${activeState || "inactive"}`;
      }
    }

    return {
      platform: this.platform,
      manager: this.platform === "darwin" ? "launchd" : "systemd",
      installed,
      running,
      pid,
      serviceFilePath: serviceFile,
      dataDir: this.dataDir,
      host: this.host,
      port: this.port,
      logFilePath: this.logFilePath,
      logByteSize,
      webUiBuilt,
      detail,
    };
  }

  readLogs(tailLines = 80): { logFilePath: string; exists: boolean; lines: string[] } {
    if (!existsSync(this.logFilePath)) {
      return { logFilePath: this.logFilePath, exists: false, lines: [] };
    }
    const content = readFileSync(this.logFilePath, "utf8");
    const allLines = content.split("\n");
    return {
      logFilePath: this.logFilePath,
      exists: true,
      lines: allLines.slice(-Math.max(1, tailLines)),
    };
  }
}
