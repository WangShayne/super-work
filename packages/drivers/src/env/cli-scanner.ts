import { existsSync } from "node:fs";
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
      this.probeGemini(),
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
      return this.notInstalled("opencode", "OpenCode CLI", true);
    }

    const [verRes, authRes, localDefaults] = await Promise.all([
      this.runCmd([binaryPath, "--version"]),
      this.runCmd([binaryPath, "auth", "list", "--format", "json"]),
      this.readOpenCodeLocalDefaults(),
    ]);

    let hasCliIntegration = false;
    let integrationSummary: string | undefined;
    const rawAuth = authRes.stdout.trim();
    if (authRes.exitCode === 0 && rawAuth.startsWith("[")) {
      try {
        const list = JSON.parse(rawAuth) as Array<{ id?: string; name?: string }>;
        if (Array.isArray(list) && list.length > 0) {
          hasCliIntegration = true;
          integrationSummary = `integrations: ${list
            .map((item) => item.name ?? item.id)
            .filter(Boolean)
            .slice(0, 3)
            .join(", ")}`;
        }
      } catch {
        // Fallback below
      }
    } else if (
      authRes.exitCode === 0 &&
      rawAuth &&
      !/no authenticated integrations/i.test(rawAuth) &&
      !/^\d+\.\d+\.\d+/.test(rawAuth)
    ) {
      hasCliIntegration = true;
      integrationSummary = firstLine(rawAuth) ?? "authenticated";
    }

    const hasProviders = localDefaults.providerKeys.length > 0;
    const authenticated = hasCliIntegration || hasProviders;
    const authSummary = hasCliIntegration
      ? integrationSummary
      : hasProviders
        ? `providers: ${localDefaults.providerKeys.slice(0, 3).join(", ")}`
        : "no providers configured";

    return {
      id: "opencode",
      name: "OpenCode CLI",
      installed: true,
      binaryPath,
      version: firstLine(verRes.stdout || verRes.stderr),
      authenticated,
      authSummary,
      localDefaultModel: localDefaults.localDefaultModel,
      localDefaultEffort: localDefaults.localDefaultEffort,
      workerSupported: true,
    };
  }

  private async readOpenCodeLocalDefaults(): Promise<{
    providerKeys: string[];
    localDefaultModel?: string;
    localDefaultEffort?: string;
  }> {
    let providerKeys: string[] = [];
    let configModel: string | undefined;

    try {
      const raw = await readFile(join(this.homeDir, ".config", "opencode", "opencode.json"), "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed.provider && typeof parsed.provider === "object") {
        providerKeys = Object.keys(parsed.provider as Record<string, unknown>);
      }
      const agent = parsed.agent as Record<string, Record<string, unknown>> | undefined;
      if (typeof parsed.model === "string" && parsed.model.trim()) {
        configModel = parsed.model.trim();
      } else if (typeof agent?.build?.model === "string" && agent.build.model.trim()) {
        configModel = agent.build.model.trim();
      }
    } catch {
      // Ignore missing or unreadable config
    }

    let stateModel: string | undefined;
    let stateVariant: string | undefined;
    try {
      const rawState = await readFile(
        join(this.homeDir, ".local", "state", "opencode", "model.json"),
        "utf8",
      );
      const parsedState = JSON.parse(rawState) as {
        recent?: Array<string | { providerID?: string; modelID?: string }>;
        variant?: Record<string, string>;
      };
      const firstRecent = Array.isArray(parsedState.recent) ? parsedState.recent[0] : undefined;
      if (typeof firstRecent === "string" && firstRecent.trim()) {
        stateModel = firstRecent.trim();
      } else if (
        firstRecent &&
        typeof firstRecent === "object" &&
        firstRecent.providerID &&
        firstRecent.modelID
      ) {
        stateModel = `${firstRecent.providerID}/${firstRecent.modelID}`;
      }
      const variants =
        parsedState.variant && typeof parsedState.variant === "object"
          ? parsedState.variant
          : undefined;
      const lookupModel = configModel ?? stateModel;
      if (variants) {
        const directVariant = lookupModel ? variants[lookupModel] : undefined;
        if (directVariant && directVariant !== "default") {
          stateVariant = directVariant;
        }
      }
    } catch {
      // Ignore missing or unreadable state
    }

    return {
      providerKeys,
      localDefaultModel: configModel ?? stateModel,
      localDefaultEffort: stateVariant,
    };
  }

  private async probeGemini(): Promise<DetectedCliTool> {
    const binaryPath = this.which("gemini") ?? undefined;
    if (!binaryPath) {
      return this.notInstalled("gemini", "Gemini CLI", true);
    }

    const [verRes, localDefaults] = await Promise.all([
      this.runCmd([binaryPath, "--version"]),
      this.readGeminiLocalDefaults(),
    ]);

    const hasApiKey = Boolean(
      process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim(),
    );
    const hasOAuthCreds = existsSync(join(this.homeDir, ".gemini", "oauth_creds.json"));
    const hasGoogleAccounts = existsSync(join(this.homeDir, ".gemini", "google_accounts.json"));
    const authenticated =
      hasApiKey || hasOAuthCreds || hasGoogleAccounts || Boolean(localDefaults.selectedAuthType);
    const authSummary = hasApiKey
      ? "API Key"
      : localDefaults.selectedAuthType
        ? localDefaults.selectedAuthType
        : hasOAuthCreds || hasGoogleAccounts
          ? "oauth-personal"
          : "not logged in";

    return {
      id: "gemini",
      name: "Gemini CLI",
      installed: true,
      binaryPath,
      version: firstLine(verRes.stdout || verRes.stderr),
      authenticated,
      authSummary,
      localDefaultModel: localDefaults.localDefaultModel,
      workerSupported: true,
    };
  }

  private async readGeminiLocalDefaults(): Promise<{
    localDefaultModel?: string;
    selectedAuthType?: string;
  }> {
    try {
      const raw = await readFile(join(this.homeDir, ".gemini", "settings.json"), "utf8");
      const parsed = JSON.parse(raw) as {
        model?: { name?: string } | string;
        security?: { auth?: { selectedType?: string } };
        selectedAuthType?: string;
      };
      const localDefaultModel =
        typeof parsed.model === "string"
          ? parsed.model
          : typeof parsed.model?.name === "string"
            ? parsed.model.name
            : undefined;
      const selectedAuthType =
        parsed.security?.auth?.selectedType ??
        (typeof parsed.selectedAuthType === "string" ? parsed.selectedAuthType : undefined);
      return { localDefaultModel, selectedAuthType };
    } catch {
      return {};
    }
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
  type CliWorkerId = "claude" | "codex" | "opencode" | "gemini";
  const implOrder: CliWorkerId[] = ["claude", "codex", "gemini", "opencode"];
  const reviewOrder: CliWorkerId[] = ["codex", "gemini", "claude", "opencode"];

  const isAuth = (id: CliWorkerId) => {
    const t = byId.get(id);
    return Boolean(t?.installed && t.authenticated);
  };
  const isInstalled = (id: CliWorkerId) => Boolean(byId.get(id)?.installed);

  const recommendedImplementEngine: WorkerEngineId =
    implOrder.find(isAuth) ?? implOrder.find(isInstalled) ?? "mock";

  const recommendedReviewEngine: WorkerEngineId =
    reviewOrder.find((id) => id !== recommendedImplementEngine && isAuth(id)) ??
    reviewOrder.find(isAuth) ??
    reviewOrder.find((id) => id !== recommendedImplementEngine && isInstalled(id)) ??
    reviewOrder.find(isInstalled) ??
    "mock";

  return { recommendedImplementEngine, recommendedReviewEngine };
}
