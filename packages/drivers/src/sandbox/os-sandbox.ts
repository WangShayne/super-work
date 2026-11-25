import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { IMMUTABLE_REPO_PATHS, type SandboxMode, type WorkerEngineId } from "@super-work/core";

export interface SanitizedEnvOptions {
  baseEnv?: NodeJS.ProcessEnv;
  engine: WorkerEngineId | "verification";
  extraEnv?: NodeJS.ProcessEnv;
}

const BASE_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "PWD",
  "SHLVL",
  "CI",
  "NODE_ENV",
  "BUN_INSTALL",
  "GOPATH",
  "GOROOT",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "PYENV_ROOT",
  "NVM_DIR",
  "VOLTA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "SSH_AUTH_SOCK",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SUPER_WORK_IN_OS_SANDBOX",
];

const ENGINE_ALLOWED_PREFIXES: Record<SanitizedEnvOptions["engine"], string[]> = {
  claude: ["ANTHROPIC_", "CLAUDE_CODE_", "CLAUDE_", "VERTEX_", "CLOUD_ML_REGION"],
  codex: ["OPENAI_", "CODEX_"],
  opencode: [
    "OPENAI_",
    "ANTHROPIC_",
    "DEEPSEEK_",
    "OPENROUTER_",
    "GEMINI_",
    "GOOGLE_GENERATIVE_AI_",
    "OPENCODE_",
  ],
  gemini: ["GEMINI_", "GOOGLE_", "VERTEX_", "CLOUD_ML_REGION"],
  mock: [],
  verification: [
    "PORT",
    "SUPER_WORK_SMOKE_",
    "SUPER_WORK_PREVIEW_",
    "NODE_OPTIONS",
    "BUN_",
    "VITEST_",
    "JEST_",
  ],
};

const ALWAYS_STRIPPED_KEYS = new Set([
  "SUPER_WORK_TOKEN",
  "SUPER_WORK_LLM_API_KEY",
  "SUPER_WORK_WEBHOOK_SECRET",
  "SUPER_WORK_ACTION_SECRET",
  "GITHUB_WEBHOOK_SECRET",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
]);

export function buildSanitizedWorkerEnv(options: SanitizedEnvOptions): NodeJS.ProcessEnv {
  const source = options.baseEnv ?? process.env;
  const result: NodeJS.ProcessEnv = {};

  for (const key of BASE_ENV_KEYS) {
    const val = source[key];
    if (val !== undefined) {
      result[key] = val;
    }
  }

  const allowedPrefixes = ENGINE_ALLOWED_PREFIXES[options.engine] ?? [];
  for (const [key, val] of Object.entries(source)) {
    if (val === undefined || ALWAYS_STRIPPED_KEYS.has(key)) continue;
    if (allowedPrefixes.some((prefix) => key === prefix || key.startsWith(prefix))) {
      result[key] = val;
    }
  }

  if (options.extraEnv) {
    for (const [key, val] of Object.entries(options.extraEnv)) {
      if (ALWAYS_STRIPPED_KEYS.has(key)) continue;
      if (val === undefined) {
        delete result[key];
      } else {
        result[key] = val;
      }
    }
  }

  return result;
}

function safeRealpathVariants(targetPath: string): string[] {
  const out = new Set<string>();
  const resolved = resolve(targetPath);
  out.add(resolved);
  try {
    out.add(realpathSync(resolved));
  } catch {
    const parent = dirname(resolved);
    try {
      const parentReal = realpathSync(parent);
      out.add(join(parentReal, resolved.slice(parent.length + 1)));
    } catch {
      // Keep lexical resolved path
    }
  }
  return Array.from(out);
}

function escapeSbplString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapePosixRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globPatternToWorktreeRegexes(worktreeVariant: string, rawPattern: string): string[] {
  const clean = rawPattern.trim().replace(/^\.?\//, "").replace(/\/+$/, "");
  if (!clean) return [];
  const escapedRoot = escapePosixRegexLiteral(worktreeVariant);

  let body = "";
  let i = 0;
  while (i < clean.length) {
    if (clean[i] === "*" && clean[i + 1] === "*") {
      if (clean[i + 2] === "/") {
        body += "(.*/)?";
        i += 3;
      } else {
        body += ".*";
        i += 2;
      }
    } else if (clean[i] === "*") {
      body += "[^/]*";
      i += 1;
    } else if (clean[i] === "?") {
      body += "[^/]";
      i += 1;
    } else {
      body += escapePosixRegexLiteral(clean[i]!);
      i += 1;
    }
  }

  const patterns = [`^${escapedRoot}/${body}(/.*)?$`];
  // If pattern has no slash (like ".env*" or "*.pem"), also deny matches in subdirectories
  if (!clean.includes("/")) {
    patterns.push(`^${escapedRoot}/.+/+${body}(/.*)?$`);
  }
  return patterns;
}

export function resolveGitWorktreeAdminDirs(worktreePath: string, rootRepoPath?: string): string[] {
  const dirs = new Set<string>();
  const dotGitPath = join(worktreePath, ".git");
  try {
    const content = readFileSync(dotGitPath, "utf8");
    const match = content.match(/^gitdir:\s*(.+)$/m);
    if (match && match[1]) {
      const gitdir = isAbsolute(match[1].trim())
        ? match[1].trim()
        : resolve(worktreePath, match[1].trim());
      for (const v of safeRealpathVariants(gitdir)) {
        dirs.add(v);
      }
      // Sibling common .git directory (e.g. <rootRepo>/.git) needed for git objects/refs
      if (gitdir.includes(`${join(".git", "worktrees")}`)) {
        const commonGit = dirname(dirname(gitdir));
        for (const v of safeRealpathVariants(commonGit)) {
          dirs.add(v);
        }
      }
    } else {
      for (const v of safeRealpathVariants(dotGitPath)) {
        dirs.add(v);
      }
    }
  } catch {
    // Not a git worktree or missing .git
  }

  if (rootRepoPath) {
    const rootDotGit = join(rootRepoPath, ".git");
    if (existsSync(rootDotGit)) {
      for (const v of safeRealpathVariants(rootDotGit)) {
        dirs.add(v);
      }
    }
  }

  return Array.from(dirs);
}

export interface SeatbeltProfileInput {
  worktreePath: string;
  rootRepoPath?: string;
  sandboxTempDir: string;
  /** Host temp dirs (defaults to $TMPDIR and os.tmpdir()) that CLI-internal sandboxes write into. */
  hostTempDirs?: string[];
  gitAdminDirs?: string[];
  forbiddenPaths?: string[];
  readOnlyPaths?: string[];
  allowNetwork?: boolean;
  mode: Exclude<SandboxMode, "off">;
  homeDir?: string;
}

export function buildMacosSeatbeltProfile(input: SeatbeltProfileInput): string {
  const home = input.homeDir ?? homedir();
  const lines: string[] = [
    "(version 1)",
    "(allow default)",
  ];

  // 1. Deny broad user/system mutable areas first (Seatbelt uses last-match wins)
  const denyWritePrefixes = new Set<string>([
    ...safeRealpathVariants(home),
    "/Users",
    "/Volumes",
    "/opt",
    "/usr/local",
    "/var",
    "/private/var",
    "/tmp",
    "/private/tmp",
  ]);
  if (input.rootRepoPath && resolve(input.rootRepoPath) !== resolve(input.worktreePath)) {
    for (const v of safeRealpathVariants(input.rootRepoPath)) {
      denyWritePrefixes.add(v);
    }
  }
  lines.push(
    `(deny file-write* ${Array.from(denyWritePrefixes)
      .map((p) => `(subpath "${escapeSbplString(p)}")`)
      .join(" ")})`,
  );

  // 2. Allow writes strictly within active worktree, git admin dirs, sandbox temp dir, and tool caches
  const allowWritePrefixes = new Set<string>([
    ...safeRealpathVariants(input.worktreePath),
    ...safeRealpathVariants(input.sandboxTempDir),
    "/dev",
  ]);
  const hostTempDirs = (input.hostTempDirs ?? [process.env.TMPDIR, tmpdir()]).filter(
    (d): d is string => typeof d === "string" && d.trim().length > 0 && resolve(d) !== "/",
  );
  for (const tmp of hostTempDirs) {
    for (const v of safeRealpathVariants(tmp)) {
      allowWritePrefixes.add(v);
    }
  }
  for (const adminDir of input.gitAdminDirs ?? []) {
    for (const v of safeRealpathVariants(adminDir)) {
      allowWritePrefixes.add(v);
    }
  }
  const cacheSubdirs = [
    ".claude",
    ".claude.json",
    ".codex",
    ".opencode",
    ".gemini",
    ".config",
    ".cache",
    ".local",
    ".bun",
    ".npm",
    "Library/Caches",
    "Library/Application Support/Claude",
  ];
  for (const sub of cacheSubdirs) {
    for (const h of safeRealpathVariants(home)) {
      allowWritePrefixes.add(join(h, sub));
    }
  }

  lines.push(
    `(allow file-write* ${Array.from(allowWritePrefixes)
      .map((p) => `(subpath "${escapeSbplString(p)}")`)
      .join(" ")})`,
  );

  // 3. Final secret wall (last match wins): block reading & writing host credentials and forbidden files
  // Note: deny `file-read-data` + `file-write*` (not metadata) so lstat/readdir/git-status still work cleanly.
  const secretDirs = [".ssh", ".aws", ".gnupg", ".kube", ".netrc", ".npmrc", ".pypirc"];
  const secretSubpaths: string[] = [];
  for (const s of secretDirs) {
    for (const h of safeRealpathVariants(home)) {
      secretSubpaths.push(join(h, s));
    }
  }

  const forbidden =
    input.forbiddenPaths && input.forbiddenPaths.length > 0
      ? input.forbiddenPaths
      : [".env", ".env.*", "*.pem", "*.key"];
  const worktreeVariants = safeRealpathVariants(input.worktreePath);
  const secretRegexes: string[] = [];

  for (const rawPattern of forbidden) {
    const pat = rawPattern.trim();
    if (!pat) continue;
    if (pat.includes("*") || pat.includes("?")) {
      for (const wt of worktreeVariants) {
        secretRegexes.push(...globPatternToWorktreeRegexes(wt, pat));
      }
    } else {
      for (const wt of worktreeVariants) {
        secretSubpaths.push(resolve(wt, pat));
      }
    }
  }

  if (secretSubpaths.length > 0) {
    lines.push(
      `(deny file-read-data file-write* ${Array.from(new Set(secretSubpaths))
        .map((p) => `(subpath "${escapeSbplString(p)}")`)
        .join(" ")})`,
    );
  }
  if (secretRegexes.length > 0) {
    lines.push(
      `(deny file-read-data file-write* ${Array.from(new Set(secretRegexes))
        .map((rx) => `(regex #"${rx.replace(/"/g, '\\"')}")`)
        .join(" ")})`,
    );
  }

  // 3b. Read-only protected paths (e.g. locked A.1 spec_test files & immutable super-work.json): readable & runnable, never writable
  const roSubpaths: string[] = [];
  const roRegexes: string[] = [];
  const combinedReadOnly = Array.from(
    new Set([...(input.readOnlyPaths ?? []), ...IMMUTABLE_REPO_PATHS]),
  );
  for (const rawPat of combinedReadOnly) {
    const pat = rawPat.trim();
    if (!pat) continue;
    if (pat.includes("*") || pat.includes("?")) {
      for (const wt of worktreeVariants) {
        roRegexes.push(...globPatternToWorktreeRegexes(wt, pat));
      }
    } else {
      for (const wt of worktreeVariants) {
        roSubpaths.push(resolve(wt, pat));
      }
    }
  }
  if (roSubpaths.length > 0) {
    lines.push(
      `(deny file-write* ${Array.from(new Set(roSubpaths))
        .map((p) => `(subpath "${escapeSbplString(p)}")`)
        .join(" ")})`,
    );
  }
  if (roRegexes.length > 0) {
    lines.push(
      `(deny file-write* ${Array.from(new Set(roRegexes))
        .map((rx) => `(regex #"${rx.replace(/"/g, '\\"')}")`)
        .join(" ")})`,
    );
  }

  // 4. Network isolation:
  //    - strict mode denies all network traffic (including loopback).
  //    - balanced mode with allowNetwork === false denies external internet while preserving localhost loopback/unix sockets for local test servers.
  if (input.mode === "strict") {
    lines.push("(deny network*)");
  } else if (input.allowNetwork === false) {
    lines.push("(deny network*)");
    lines.push('(allow network-bind (local ip "localhost:*"))');
    lines.push('(allow network-inbound (local ip "localhost:*"))');
    lines.push('(allow network-outbound (remote ip "localhost:*"))');
    lines.push("(allow network* (local unix-socket) (remote unix-socket))");
  }

  return lines.join("\n");
}

export interface WrapSandboxOptions {
  commandArgv: string[];
  worktreePath: string;
  rootRepoPath?: string;
  mode?: SandboxMode;
  forbiddenPaths?: string[];
  readOnlyPaths?: string[];
  allowNetwork?: boolean;
  engine: SanitizedEnvOptions["engine"];
  baseEnv?: NodeJS.ProcessEnv;
  extraEnv?: NodeJS.ProcessEnv;
  skipOuterSandbox?: boolean;
}

export interface WrappedSandboxCommand {
  argv: string[];
  env: NodeJS.ProcessEnv;
  appliedBackend: "seatbelt" | "bwrap" | "env_only" | "off";
  profileText?: string;
}

function getSharedSandboxTempDir(): string {
  const dir = join(tmpdir(), "super-work-sandbox-tmp");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
  return dir;
}

export function wrapCommandWithOsSandbox(options: WrapSandboxOptions): WrappedSandboxCommand {
  const mode: SandboxMode = options.mode ?? "balanced";
  if (mode === "off") {
    const env = options.extraEnv
      ? { ...(options.baseEnv ?? process.env), ...options.extraEnv }
      : { ...(options.baseEnv ?? process.env) };
    return {
      argv: options.commandArgv,
      env,
      appliedBackend: "off",
    };
  }

  const sandboxTempDir = getSharedSandboxTempDir();
  const env = buildSanitizedWorkerEnv({
    baseEnv: options.baseEnv,
    engine: options.engine,
    extraEnv: {
      TMPDIR: sandboxTempDir,
      TMP: sandboxTempDir,
      TEMP: sandboxTempDir,
      ...(options.extraEnv ?? {}),
    },
  });

  // Already inside our own Seatbelt profile: the child inherits that confinement, and a nested
  // sandbox_init fails with "Operation not permitted" (exit 71). Explicit skipOuterSandbox:false forces wrapping.
  const nestedInSandbox =
    process.platform === "darwin" &&
    options.skipOuterSandbox !== false &&
    (options.baseEnv ?? process.env).SUPER_WORK_IN_OS_SANDBOX === "1";

  if (options.skipOuterSandbox || nestedInSandbox) {
    return {
      argv: options.commandArgv,
      env,
      appliedBackend: "env_only",
    };
  }

  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
    const gitAdminDirs = resolveGitWorktreeAdminDirs(options.worktreePath, options.rootRepoPath);
    const profileText = buildMacosSeatbeltProfile({
      worktreePath: options.worktreePath,
      rootRepoPath: options.rootRepoPath,
      sandboxTempDir,
      gitAdminDirs,
      forbiddenPaths: options.forbiddenPaths,
      readOnlyPaths: options.readOnlyPaths,
      allowNetwork: options.allowNetwork,
      mode,
    });
    env.SUPER_WORK_IN_OS_SANDBOX = "1";
    return {
      argv: ["/usr/bin/sandbox-exec", "-p", profileText, ...options.commandArgv],
      env,
      appliedBackend: "seatbelt",
      profileText,
    };
  }

  const bwrapBin = process.platform === "linux" ? Bun.which("bwrap") : null;
  if (bwrapBin) {
    const wt = resolve(options.worktreePath);
    const gitDirs = resolveGitWorktreeAdminDirs(wt, options.rootRepoPath);
    const args: string[] = [
      bwrapBin,
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--bind",
      wt,
      wt,
      "--bind",
      sandboxTempDir,
      sandboxTempDir,
    ];
    for (const gd of gitDirs) {
      if (existsSync(gd)) {
        args.push("--bind", gd, gd);
      }
    }
    const bwrapReadOnly = Array.from(
      new Set([...(options.readOnlyPaths ?? []), ...IMMUTABLE_REPO_PATHS]),
    );
    for (const roPat of bwrapReadOnly) {
      const clean = roPat.trim();
      if (!clean || clean.includes("*") || clean.includes("?")) continue;
      const absRo = resolve(wt, clean);
      if (existsSync(absRo)) {
        args.push("--ro-bind", absRo, absRo);
      }
    }
    if (mode === "strict") {
      args.push("--unshare-net");
    }
    args.push(...options.commandArgv);
    return {
      argv: args,
      env,
      appliedBackend: "bwrap",
    };
  }

  return {
    argv: options.commandArgv,
    env,
    appliedBackend: "env_only",
  };
}
