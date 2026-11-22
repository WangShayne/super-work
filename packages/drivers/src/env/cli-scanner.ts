import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  CliScanReport,
  CliToolId,
  DetectedCliTool,
  WorkerEngineId,
} from "@super-work/core";
import { nowIso } from "@super-work/core";

export interface CliCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CliCommandRunner = (
  cmd: string[],
  timeoutMs?: number,
) => Promise<CliCommandResult>;

export type WhichResolver = (bin: string) => string | null;

const DEFAULT_TIMEOUT_MS = 3_000;

async function defaultCommandRunner(
  cmd: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CliCommandResult> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // Ignore already exited
      }
      reject(new Error(`CLI probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]),
      timeoutPromise,
    ]);
    return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    return {
      exitCode: -1,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function firstLine(text: string): string | undefined {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  return line ? line.slice(0, 120) : undefined;
}

export class CliEnvironmentScanner {
  private readonly runCmd: CliCommandRunner;
  private readonly which: WhichResolver;
  private readonly homeDir: string;

  constructor(deps?: { runCmd?: CliCommandRunner; which?: WhichResolver; homeDir?: string }) {
    this.runCmd = deps?.runCmd ?? defaultCommandRunner;
    this.which = deps?.which ?? ((bin) => Bun.which(bin));
    this.homeDir = deps?.homeDir ?? homedir();
  }

  async scanAll(): Promise<CliScanReport> {
    const tools = await Promise.all([
      this.probeClaude(),
      this.probeCodex(),
      this.probeOpenCode(),
      this.probeGh(),
      this.probeGit(),
      this.probeBun(),
    ]);

    const { recommendedImplementEngine, recommendedReviewEngine } =
      computeRecommendedEngines(tools);

    return {
      scannedAt: nowIso(),
      tools,
      recommendedImplementEngine,
      recommendedReviewEngine,
    };
  }

  private async probeClaude(): Promise<DetectedCliTool> {
    const binaryPath = this.which("claude") ?? undefined;
    if (!binaryPath) {
      return this.notInstalled("claude", "Claude Code", true);
    }

    const [verRes, authRes] = await Promise.all([
      this.runCmd([binaryPath, "--version"]),
      this.runCmd([binaryPath, "auth", "status", "--json"]),
    ]);

    let authenticated: boolean | null = false;
    let authSummary: string | undefined;

    if (authRes.stdout) {
      try {
        const parsed = JSON.parse(authRes.stdout) as {
          loggedIn?: boolean;
          authMethod?: string;
          apiProvider?: string;
        };
        authenticated = Boolean(parsed.loggedIn);
        authSummary = parsed.loggedIn
          ? [parsed.authMethod, parsed.apiProvider].filter(Boolean).join(" / ") || "logged in"
          : "not logged in";
      } catch {
        authenticated = authRes.exitCode === 0;
        authSummary = authRes.exitCode === 0 ? "authenticated" : "not logged in";
      }
    } else {
      authenticated = authRes.exitCode === 0;
      authSummary = authenticated ? "authenticated" : "not logged in";
    }

    const { localDefaultModel, localDefaultEffort } = await this.readClaudeLocalDefaults();

    return {
      id: "claude",
      name: "Claude Code",
      installed: true,
      binaryPath,
      version: firstLine(verRes.stdout || verRes.stderr),
      authenticated,
      authSummary,
      localDefaultModel,
      localDefaultEffort,
      workerSupported: true,
    };
  }

  private async probeCodex(): Promise<DetectedCliTool> {
    const binaryPath = this.which("codex") ?? undefined;
    if (!binaryPath) {
      return this.notInstalled("codex", "OpenAI Codex CLI", true);
    }

    const [verRes, authRes, localDefaults] = await Promise.all([
      this.runCmd([binaryPath, "--version"]),
      this.runCmd([binaryPath, "login", "status"]),
      this.readCodexLocalDefaults(),
    ]);

    const authenticated = authRes.exitCode === 0;
    const rawAuth = firstLine(authRes.stdout || authRes.stderr);

    return {
      id: "codex",
      name: "OpenAI Codex CLI",
      installed: true,
      binaryPath,
      version: firstLine(verRes.stdout || verRes.stderr),
      authenticated,
      authSummary: authenticated ? rawAuth || "logged in" : rawAuth || "not logged in",
      localDefaultModel: localDefaults.localDefaultModel,
      localDefaultEffort: localDefaults.localDefaultEffort,
      workerSupported: true,
    };
  }

  private async readClaudeLocalDefaults(): Promise<{
    localDefaultModel?: string;
    localDefaultEffort?: string;
  }> {
    try {
      const raw = await readFile(join(this.homeDir, ".claude", "settings.json"), "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        localDefaultModel: typeof parsed.model === "string" ? parsed.model : undefined,
        localDefaultEffort:
          typeof parsed.effortLevel === "string" ? parsed.effortLevel : undefined,
      };
    } catch {
      return {};
    }
  }

  private async readCodexLocalDefaults(): Promise<{
    localDefaultModel?: string;
    localDefaultEffort?: string;
  }> {
    try {
      const raw = await readFile(join(this.homeDir, ".codex", "config.toml"), "utf8");
      // Only match top-level keys (before any [section] header)
      const topSection = raw.split(/\r?\n\s*\[/, 1)[0] ?? raw;
      const modelMatch = topSection.match(/^model\s*=\s*"([^"]+)"/m);
      const effortMatch = topSection.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m);
      return {
        localDefaultModel: modelMatch?.[1],
        localDefaultEffort: effortMatch?.[1],
      };
    } catch {
      return {};
    }
  }

  private async probeOpenCode(): Promise<DetectedCliTool> {
    const binaryPath = this.which("opencode") ?? undefined;
    if (!binaryPath) {
      return this.notInstalled("opencode", "OpenCode CLI", false);
    }

    const verRes = await this.runCmd([binaryPath, "--version"]);
    return {
      id: "opencode",
      name: "OpenCode CLI",
      installed: true,
      binaryPath,
      version: firstLine(verRes.stdout || verRes.stderr),
      authenticated: null,
      authSummary: "detected (driver planned v0.2)",
      workerSupported: false,
    };
  }

  private async probeGh(): Promise<DetectedCliTool> {
    const binaryPath = this.which("gh") ?? undefined;
    if (!binaryPath) {
      return this.notInstalled("gh", "GitHub CLI", false);
    }

    const [verRes, authRes] = await Promise.all([
      this.runCmd([binaryPath, "--version"]),
      this.runCmd([binaryPath, "auth", "status"]),
    ]);

    const combined = `${authRes.stdout}\n${authRes.stderr}`;
    const authenticated = authRes.exitCode === 0;
    const accountMatch = combined.match(/account\s+([^\s(]+)/i);
    const authSummary = authenticated
      ? accountMatch
        ? `account ${accountMatch[1]}`
        : "logged in"
      : "not logged in";

    return {
      id: "gh",
      name: "GitHub CLI",
      installed: true,
      binaryPath,
      version: firstLine(verRes.stdout || verRes.stderr),
      authenticated,
      authSummary,
      workerSupported: false,
    };
  }

  private async probeGit(): Promise<DetectedCliTool> {
    const binaryPath = this.which("git") ?? undefined;
    if (!binaryPath) {
      return this.notInstalled("git", "Git", false);
    }

    const [verRes, userRes] = await Promise.all([
      this.runCmd([binaryPath, "--version"]),
      this.runCmd([binaryPath, "config", "user.name"]),
    ]);

    const userName = userRes.stdout.trim();
    return {
      id: "git",
      name: "Git",
      installed: true,
      binaryPath,
      version: firstLine(verRes.stdout || verRes.stderr),
      authenticated: Boolean(userName),
      authSummary: userName ? `user.name=${userName}` : "user.name unset",
      workerSupported: false,
    };
  }

  private async probeBun(): Promise<DetectedCliTool> {
    const binaryPath = this.which("bun") ?? undefined;
    if (!binaryPath) {
      return this.notInstalled("bun", "Bun Runtime", false);
    }

    const verRes = await this.runCmd([binaryPath, "--version"]);
    return {
      id: "bun",
      name: "Bun Runtime",
      installed: true,
      binaryPath,
      version: firstLine(verRes.stdout || verRes.stderr),
      authenticated: null,
      workerSupported: false,
    };
  }

  private notInstalled(
    id: CliToolId,
    name: string,
    workerSupported: boolean,
  ): DetectedCliTool {
    return {
      id,
      name,
      installed: false,
      authenticated: null,
      workerSupported,
    };
  }
}

export function computeRecommendedEngines(tools: DetectedCliTool[]): {
  recommendedImplementEngine: WorkerEngineId;
  recommendedReviewEngine: WorkerEngineId;
} {
  const byId = new Map(tools.map((t) => [t.id, t]));
  const claude = byId.get("claude");
  const codex = byId.get("codex");

  let recommendedImplementEngine: WorkerEngineId = "mock";
  if (claude?.installed && claude.authenticated) {
    recommendedImplementEngine = "claude";
  } else if (codex?.installed && codex.authenticated) {
    recommendedImplementEngine = "codex";
  } else if (claude?.installed) {
    recommendedImplementEngine = "claude";
  } else if (codex?.installed) {
    recommendedImplementEngine = "codex";
  }

  let recommendedReviewEngine: WorkerEngineId = "mock";
  if (codex?.installed && codex.authenticated) {
    recommendedReviewEngine = "codex";
  } else if (claude?.installed && claude.authenticated) {
    recommendedReviewEngine = "claude";
  } else if (codex?.installed) {
    recommendedReviewEngine = "codex";
  } else if (claude?.installed) {
    recommendedReviewEngine = "claude";
  }

  return { recommendedImplementEngine, recommendedReviewEngine };
}
