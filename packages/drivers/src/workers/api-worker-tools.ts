import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { StageKind, WorkerTurnInput } from "@super-work/core";
import { wrapCommandWithOsSandbox } from "../sandbox/os-sandbox.ts";

export const API_WORKER_MAX_ITERATIONS = 28;
const MAX_OUTPUT_CHARS = 20_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_LIST_ENTRIES = 300;
const MAX_GREP_MATCHES = 100;
const DEFAULT_COMMAND_TIMEOUT_SEC = 120;
const MAX_COMMAND_TIMEOUT_SEC = 600;
const SKIP_DIRS = new Set([".git", "node_modules", ".super-work"]);
const BLOCKED_COMMAND_RE = /\bgit\b[^;&|\n]*\bpush\b|\bgh\b\s+(?:-\S+\s+)*pr\b/;

export interface ApiToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ApiToolContext {
  worktreePath: string;
  stage: StageKind;
  readOnlyPaths?: string[];
  sandboxMode?: WorkerTurnInput["sandboxMode"];
  rootRepoPath?: string;
  forbiddenPaths?: string[];
  signal: AbortSignal;
}

export interface ApiToolResult {
  isError: boolean;
  output: string;
}

const str = (description: string) => ({ type: "string", description });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const TOOL_SPECS: Record<string, ApiToolSpec> = {
  read_file: {
    name: "read_file",
    description: "Read a UTF-8 text file inside the worktree. Optional 1-based line offset and limit.",
    parameters: obj(
      { path: str("File path relative to the worktree"), offset: { type: "integer" }, limit: { type: "integer" } },
      ["path"],
    ),
  },
  list_files: {
    name: "list_files",
    description: "List files under a directory (default: worktree root).",
    parameters: obj({ path: str("Directory path"), recursive: { type: "boolean" } }),
  },
  grep_files: {
    name: "grep_files",
    description: "Search file contents with a JavaScript regular expression.",
    parameters: obj(
      { pattern: str("Regex pattern"), path: str("Directory or file to search"), glob: str("Optional filename glob, e.g. **/*.ts") },
      ["pattern"],
    ),
  },
  git_diff: {
    name: "git_diff",
    description: "Read-only git inspection: mode 'diff' (default), 'stat' or 'status'. Optional base ref and path.",
    parameters: obj(
      { mode: { type: "string", enum: ["diff", "stat", "status"] }, base: str("Base ref, default HEAD"), path: str("Limit to path") },
    ),
  },
  write_file: {
    name: "write_file",
    description: "Create or overwrite a file inside the worktree (parent directories are created).",
    parameters: obj({ path: str("File path"), content: str("Full file content") }, ["path", "content"]),
  },
  edit_file: {
    name: "edit_file",
    description: "Replace old_string with new_string in a file. old_string must be unique unless replace_all is true.",
    parameters: obj(
      { path: str("File path"), old_string: str("Exact text to replace"), new_string: str("Replacement"), replace_all: { type: "boolean" } },
      ["path", "old_string", "new_string"],
    ),
  },
  run_command: {
    name: "run_command",
    description: "Run a shell command in the worktree inside the OS sandbox. git push and gh pr are blocked.",
    parameters: obj({ command: str("Shell command"), timeout_sec: { type: "integer" } }, ["command"]),
  },
};

const READ_ONLY_TOOLS = ["read_file", "list_files", "grep_files"];

/** Stage-scoped tool allowlist: plan is read-only, review adds git_diff, implement/spec_test can mutate. */
export function toolsForStage(stage: StageKind): ApiToolSpec[] {
  const names =
    stage === "implement" || stage === "spec_test"
      ? ["read_file", "write_file", "edit_file", "list_files", "grep_files", "run_command"]
      : stage === "review"
        ? [...READ_ONLY_TOOLS, "git_diff"]
        : READ_ONLY_TOOLS;
  return names.map((n) => TOOL_SPECS[n]!);
}

function clip(text: string, max = MAX_OUTPUT_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

const isEscape = (rel: string): boolean => rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);

/** Resolves a path and guarantees it stays inside the worktree, following symlinks (incl. dangling ones). */
export async function resolveInside(worktreePath: string, p: string): Promise<{ abs: string; rel: string }> {
  if (typeof p !== "string" || p.includes("\0")) throw new Error("Invalid path");
  const realRoot = await realpath(worktreePath);
  const requested = isAbsolute(p) ? resolve(p) : resolve(realRoot, p);
  let cur = requested;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await realpath(cur);
      const abs = tail.length ? join(real, ...tail.reverse()) : real;
      const rel = relative(realRoot, abs);
      if (isEscape(rel)) throw new Error(`Path escapes worktree: ${p}`);
      return { abs, rel };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" && (err as NodeJS.ErrnoException).code !== "ENOTDIR") throw err;
      // A dangling symlink would let a later write land outside the jail.
      if (await lstat(cur).then(() => true, () => false)) throw new Error(`Refusing dangling symlink: ${p}`);
      const parent = dirname(cur);
      if (parent === cur) throw new Error(`Path escapes worktree: ${p}`);
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

function isReadOnlyTarget(rel: string, readOnlyPaths: string[] | undefined, worktreePath: string): boolean {
  for (const entry of readOnlyPaths ?? []) {
    const entryAbs = isAbsolute(entry) ? resolve(entry) : resolve(worktreePath, entry);
    const entryRel = relative(worktreePath, entryAbs);
    if (isEscape(entryRel)) continue;
    if (rel === entryRel || rel.startsWith(`${entryRel}${sep}`)) return true;
  }
  return false;
}

async function assertWritable(ctx: ApiToolContext, path: string): Promise<string> {
  const { abs, rel } = await resolveInside(ctx.worktreePath, path);
  if (ctx.stage === "implement" && isReadOnlyTarget(rel, ctx.readOnlyPaths, ctx.worktreePath)) {
    throw new Error(`Path is read-only (locked spec test): ${rel}`);
  }
  const realRoot = await realpath(ctx.worktreePath);
  if (isReadOnlyTarget(rel, ctx.readOnlyPaths, realRoot) && ctx.stage === "implement") {
    throw new Error(`Path is read-only (locked spec test): ${rel}`);
  }
  return abs;
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

async function* walk(dir: string, signal: AbortSignal): AsyncGenerator<string> {
  if (signal.aborted) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.isSymbolicLink()) continue; // never traverse links: keeps the jail airtight
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(full, signal);
    } else if (e.isFile()) yield full;
  }
}

async function readFileTool(ctx: ApiToolContext, a: Record<string, unknown>): Promise<string> {
  const { abs } = await resolveInside(ctx.worktreePath, String(a.path ?? ""));
  const st = await stat(abs);
  if (!st.isFile()) throw new Error("Not a file");
  if (st.size > MAX_FILE_BYTES * 5) throw new Error(`File too large (${st.size} bytes)`);
  const lines = (await readFile(abs, "utf8")).split("\n");
  const offset = Math.max(1, Number(a.offset) || 1);
  const limit = Number(a.limit) > 0 ? Number(a.limit) : lines.length;
  return clip(lines.slice(offset - 1, offset - 1 + limit).join("\n"));
}

async function listFilesTool(ctx: ApiToolContext, a: Record<string, unknown>): Promise<string> {
  const { abs } = await resolveInside(ctx.worktreePath, String(a.path ?? "."));
  const root = await realpath(ctx.worktreePath);
  const out: string[] = [];
  if (a.recursive) {
    for await (const f of walk(abs, ctx.signal)) {
      out.push(relative(root, f));
      if (out.length >= MAX_LIST_ENTRIES) break;
    }
  } else {
    for (const e of await readdir(abs, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push(relative(root, join(abs, e.name)) + (e.isDirectory() ? "/" : ""));
      if (out.length >= MAX_LIST_ENTRIES) break;
    }
  }
  return out.join("\n") || "(empty)";
}

async function grepFilesTool(ctx: ApiToolContext, a: Record<string, unknown>): Promise<string> {
  let re: RegExp;
  try {
    re = new RegExp(String(a.pattern ?? ""));
  } catch (err) {
    throw new Error(`Invalid regex: ${(err as Error).message}`);
  }
  const { abs } = await resolveInside(ctx.worktreePath, String(a.path ?? "."));
  const root = await realpath(ctx.worktreePath);
  const globRe = typeof a.glob === "string" && a.glob ? globToRegExp(a.glob) : undefined;
  const hits: string[] = [];
  const targets = (await stat(abs)).isFile() ? [abs] : walk(abs, ctx.signal);
  for await (const file of targets) {
    const rel = relative(root, file);
    if (globRe && !globRe.test(rel) && !globRe.test(basename(rel))) continue;
    if ((await stat(file)).size > MAX_FILE_BYTES) continue;
    const text = await readFile(file, "utf8").catch(() => "");
    if (text.includes("\0")) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && hits.length < MAX_GREP_MATCHES; i++) {
      if (re.test(lines[i]!)) hits.push(`${rel}:${i + 1}: ${lines[i]!.slice(0, 240)}`);
    }
    if (hits.length >= MAX_GREP_MATCHES) break;
  }
  return hits.join("\n") || "No matches";
}

async function execCapture(argv: string[], cwd: string, env: NodeJS.ProcessEnv | undefined, ctx: ApiToolContext, timeoutSec: number) {
  const proc = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const kill = () => {
    try {
      proc.kill();
    } catch {
      // already exited
    }
  };
  ctx.signal.addEventListener("abort", kill, { once: true });
  const timer = setTimeout(kill, timeoutSec * 1000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code, timedOut: false };
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", kill);
  }
}

async function gitDiffTool(ctx: ApiToolContext, a: Record<string, unknown>): Promise<string> {
  const mode = a.mode === "stat" || a.mode === "status" ? a.mode : "diff";
  const argv = ["git", "-C", ctx.worktreePath, "--no-pager"];
  if (mode === "status") argv.push("status", "--short", "--branch");
  else {
    const base = typeof a.base === "string" && a.base ? a.base : "HEAD";
    if (!/^[\w./~^@-]+$/.test(base) || base.startsWith("-")) throw new Error("Invalid base ref");
    argv.push("diff", "--no-ext-diff", "--no-color", ...(mode === "stat" ? ["--stat"] : []), base);
    if (typeof a.path === "string" && a.path) argv.push("--", (await resolveInside(ctx.worktreePath, a.path)).rel);
  }
  const r = await execCapture(argv, ctx.worktreePath, { PATH: process.env.PATH, HOME: process.env.HOME, GIT_OPTIONAL_LOCKS: "0" }, ctx, 60);
  if (r.code !== 0) throw new Error(clip(r.stderr || `git exited ${r.code}`, 2000));
  return clip(r.stdout) || "(no changes)";
}

async function runCommandTool(ctx: ApiToolContext, a: Record<string, unknown>): Promise<string> {
  const command = String(a.command ?? "").trim();
  if (!command) throw new Error("command is required");
  if (BLOCKED_COMMAND_RE.test(command)) throw new Error("Blocked: git push / gh pr are handled by super-work delivery");
  const timeoutSec = Math.min(MAX_COMMAND_TIMEOUT_SEC, Math.max(1, Number(a.timeout_sec) || DEFAULT_COMMAND_TIMEOUT_SEC));
  const mode = ctx.sandboxMode ?? "balanced";
  const wrapped = wrapCommandWithOsSandbox({
    commandArgv: ["/bin/sh", "-c", command],
    worktreePath: ctx.worktreePath,
    rootRepoPath: ctx.rootRepoPath,
    mode,
    forbiddenPaths: ctx.forbiddenPaths,
    readOnlyPaths: ctx.readOnlyPaths,
    allowNetwork: mode !== "strict",
    engine: "verification",
  });
  const r = await execCapture(wrapped.argv, ctx.worktreePath, wrapped.env, ctx, timeoutSec);
  const body = clip([r.stdout, r.stderr].filter(Boolean).join("\n"));
  if (ctx.signal.aborted) throw new Error("Command aborted");
  return `exit code ${r.code}\n${body}`;
}

async function writeFileTool(ctx: ApiToolContext, a: Record<string, unknown>): Promise<string> {
  const abs = await assertWritable(ctx, String(a.path ?? ""));
  const content = String(a.content ?? "");
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
  return `Wrote ${Buffer.byteLength(content)} bytes to ${relative(await realpath(ctx.worktreePath), abs)}`;
}

async function editFileTool(ctx: ApiToolContext, a: Record<string, unknown>): Promise<string> {
  const abs = await assertWritable(ctx, String(a.path ?? ""));
  const oldStr = String(a.old_string ?? "");
  const newStr = String(a.new_string ?? "");
  if (!oldStr) throw new Error("old_string must not be empty");
  const text = await readFile(abs, "utf8");
  const count = text.split(oldStr).length - 1;
  if (count === 0) throw new Error("old_string not found");
  if (count > 1 && !a.replace_all) throw new Error(`old_string matches ${count} places; add context or set replace_all`);
  await writeFile(abs, a.replace_all ? text.split(oldStr).join(newStr) : text.replace(oldStr, () => newStr), "utf8");
  return `Edited ${relative(await realpath(ctx.worktreePath), abs)} (${a.replace_all ? count : 1} replacement(s))`;
}

const HANDLERS: Record<string, (ctx: ApiToolContext, a: Record<string, unknown>) => Promise<string>> = {
  read_file: readFileTool,
  list_files: listFilesTool,
  grep_files: grepFilesTool,
  git_diff: gitDiffTool,
  write_file: writeFileTool,
  edit_file: editFileTool,
  run_command: runCommandTool,
};

/** Executes a model-requested tool; never throws — failures come back as isError results. */
export async function executeApiTool(name: string, args: unknown, ctx: ApiToolContext): Promise<ApiToolResult> {
  try {
    if (!toolsForStage(ctx.stage).some((t) => t.name === name)) {
      return { isError: true, output: `Tool '${name}' is not available in the ${ctx.stage} stage` };
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return { isError: true, output: "Tool arguments must be a JSON object" };
    }
    return { isError: false, output: await HANDLERS[name]!(ctx, args as Record<string, unknown>) };
  } catch (err) {
    return { isError: true, output: clip(err instanceof Error ? err.message : String(err), 2000) };
  }
}
