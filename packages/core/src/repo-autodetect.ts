import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { EnginePreference } from "./domain-types/engine.ts";
import type { AutonomyPreset } from "./domain-types/repo.ts";
import type { VerificationStrategy } from "./domain-types/verification.ts";

export interface RepoAutoDetectResult {
  name: string;
  baseBranch: string;
  stackLabel: string;
  verificationCommands: string[];
  verificationStrategy: VerificationStrategy;
  autonomyPreset: AutonomyPreset;
  preferredImplementEngine: EnginePreference;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function branchFromHeadFile(headPath: string): string | null {
  const m = readText(headPath)?.trim().match(/^ref:\s*refs\/heads\/(.+)$/);
  return m?.[1]?.trim() || null;
}

function detectBaseBranch(root: string): string {
  const dotGit = join(root, ".git");
  try {
    let gitDir = dotGit;
    if (existsSync(dotGit) && statSync(dotGit).isFile()) {
      const m = readText(dotGit)?.match(/^gitdir:\s*(.+)$/m);
      if (m?.[1]) gitDir = isAbsolute(m[1].trim()) ? m[1].trim() : resolve(root, m[1].trim());
    }
    const fromHead = branchFromHeadFile(join(gitDir, "HEAD"));
    if (fromHead) return fromHead;
  } catch {
    // fall through
  }
  try {
    const r = spawnSync("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
      cwd: root,
      encoding: "utf8",
      timeout: 3000,
    });
    const out = r.status === 0 ? r.stdout.trim().replace(/^origin\//, "") : "";
    if (out) return out;
  } catch {
    // fall through
  }
  return "main";
}

interface StackInfo {
  label: string;
  commands: string[];
}

function detectStack(root: string): StackInfo & { pkgName?: string } {
  const pkgRaw = readText(join(root, "package.json"));
  if (pkgRaw !== null) {
    let scripts: Record<string, unknown> = {};
    let pkgName: string | undefined;
    try {
      const pkg = JSON.parse(pkgRaw) as { name?: unknown; scripts?: Record<string, unknown> };
      if (pkg.scripts && typeof pkg.scripts === "object") scripts = pkg.scripts;
      if (typeof pkg.name === "string" && pkg.name.trim()) pkgName = pkg.name.trim();
    } catch {
      // malformed package.json: treat as no scripts
    }
    const bun = existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"));
    const runner = bun ? "bun run" : "npm run";
    const commands = ["typecheck", "test", "build"]
      .filter((s) => typeof scripts[s] === "string")
      .map((s) => `${runner} ${s}`);
    return { label: bun ? "bun" : "node", commands, pkgName };
  }
  if (existsSync(join(root, "Cargo.toml"))) {
    return { label: "rust", commands: ["cargo check", "cargo test"] };
  }
  if (existsSync(join(root, "pyproject.toml"))) {
    return { label: "python", commands: ["pytest"] };
  }
  if (existsSync(join(root, "go.mod"))) {
    return { label: "go", commands: ["go vet ./...", "go test ./..."] };
  }
  return { label: "unknown", commands: [] };
}

/** 零配置检测：只读检查目录，永不抛错（除非路径本身无法解析）。 */
export function detectRepoDefaults(rootPath: string): RepoAutoDetectResult {
  const root = resolve(rootPath);
  const stack = detectStack(root);
  return {
    name: stack.pkgName?.replace(/^@[^/]+\//, "") || basename(root),
    baseBranch: detectBaseBranch(root),
    stackLabel: stack.label,
    verificationCommands: stack.commands,
    verificationStrategy: "smart_tiered",
    autonomyPreset: "smart",
    preferredImplementEngine: "auto",
  };
}
