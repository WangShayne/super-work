import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SymbolImpactReport } from "@super-work/core";
import { matchesPathScope, normalizeRelPath } from "@super-work/core";
import { analyzeRepoSymbolImpact } from "./symbol-graph-scanner.ts";

export interface ImpactScopedVerificationInput {
  rootRepoPath: string;
  worktreePath: string;
  baseBranch: string;
  fullCommands: string[];
  sensitivePaths?: string[];
}

export interface ImpactScopedVerificationPlan {
  useScoped: boolean;
  commands: string[];
  estimatedSavedMs: number;
  reason: string;
}

export type PlannerGitRunner = (
  args: string[],
  cwd: string,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface WorkspacePackageInfo {
  /** Directory name under `packages/`. */
  dir: string;
  /** package.json `name`. */
  name: string;
  /** Every dependency name declared in package.json (planner keeps the workspace-internal ones). */
  dependsOn: string[];
  /** Test files (repo-root relative) found under `packages/<dir>/test`. */
  testFiles: string[];
}

export type ImpactGraphSnapshot = Pick<
  SymbolImpactReport,
  "targetFiles" | "directDependents" | "transitiveDependents"
>;

export interface ImpactPlanInput {
  fullCommands: string[];
  changedFiles: string[];
  sensitivePaths?: string[];
  packages: WorkspacePackageInfo[];
  /** `null` when the symbol graph could not be computed. */
  symbolImpact: ImpactGraphSnapshot | null;
}

const CMD_TYPECHECK = "bun run typecheck";
const CMD_TEST = "bun test";
const CMD_BUILD = "bun run build";

/** Root `build` only builds this package, so it is kept iff this package is affected. */
const BUILD_PACKAGE_DIR = "web";

const FULL_TEST_SAVED_MS = 85_000;
const TYPECHECK_BUILD_SAVED_MS = 3_000;

/**
 * `analyzeRepoSymbolImpact` truncates its dependent lists at 30 / 40 entries
 * (symbol-graph-scanner.ts). A list that reaches the cap may be incomplete,
 * so the graph is then treated as unreliable.
 */
const DIRECT_DEPENDENT_CAP = 30;
const TRANSITIVE_DEPENDENT_CAP = 40;
const MAX_TEST_FILE_TARGETS_PER_PACKAGE = 20;

/**
 * `packages/web` hand-mirrors `@super-work/core` types without declaring the
 * dependency, so package.json edges alone would never mark it as affected.
 */
const MIRRORED_TYPE_DEPENDENTS: ReadonlyArray<{ from: string; to: string }> = [
  { from: "@super-work/core", to: "@super-work/web" },
];

const SOURCE_FILE_RE = /\.[cm]?[jt]sx?$/;
const TEST_FILE_RE = /\.test\.[cm]?[jt]sx?$/;

function normalizeCommand(cmd: string): string {
  return cmd.trim().replace(/\s+/g, " ");
}

function isRootConfigOrScript(rel: string): boolean {
  if (rel.startsWith("scripts/")) return true;
  if (rel.includes("/")) return false;
  return rel === "package.json" || rel.startsWith("bun.lock") || /^tsconfig.*\.json$/.test(rel);
}

function toPackageDir(rel: string): string | null {
  const m = /^packages\/([^/]+)\//.exec(rel);
  return m?.[1] ?? null;
}

function parsePorcelainZ(out: string): string[] {
  const tokens = out.split("\0");
  const files: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry || entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    files.push(entry.slice(3));
    if (xy.includes("R") || xy.includes("C")) {
      // Renames/copies are followed by the original path as a separate NUL token.
      const original = tokens[++i];
      if (original) files.push(original);
    }
  }
  return files;
}

async function collectChangedFiles(
  worktreePath: string,
  baseBranch: string,
  runGit: PlannerGitRunner,
): Promise<{ ok: true; files: string[] } | { ok: false; error: string }> {
  if (!baseBranch.trim() || baseBranch.startsWith("-")) {
    return { ok: false, error: `invalid base branch '${baseBranch}'` };
  }
  const [diff, status] = await Promise.all([
    runGit(["diff", "--name-only", "-z", `${baseBranch}...HEAD`], worktreePath),
    runGit(["status", "--porcelain", "-z", "-uall"], worktreePath),
  ]);
  if (diff.exitCode !== 0) {
    return { ok: false, error: `git diff ${baseBranch}...HEAD failed: ${diff.stderr.trim().slice(0, 160)}` };
  }
  if (status.exitCode !== 0) {
    return { ok: false, error: `git status failed: ${status.stderr.trim().slice(0, 160)}` };
  }
  const files = new Set<string>();
  for (const p of diff.stdout.split("\0")) {
    const n = normalizeRelPath(p);
    if (n) files.add(n);
  }
  for (const p of parsePorcelainZ(status.stdout)) {
    const n = normalizeRelPath(p);
    if (n) files.add(n);
  }
  return { ok: true, files: Array.from(files).sort() };
}

export async function loadWorkspacePackages(worktreePath: string): Promise<WorkspacePackageInfo[]> {
  const packagesDir = join(worktreePath, "packages");
  const entries = await readdir(packagesDir, { withFileTypes: true }).catch(() => []);
  const result: WorkspacePackageInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }
    let name = `@super-work/${entry.name}`;
    const dependsOn = new Set<string>();
    try {
      const pkg = JSON.parse(await readFile(join(packagesDir, entry.name, "package.json"), "utf8")) as {
        name?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      };
      if (pkg.name) name = pkg.name;
      for (const group of [
        pkg.dependencies,
        pkg.devDependencies,
        pkg.peerDependencies,
        pkg.optionalDependencies,
      ]) {
        for (const dep of Object.keys(group ?? {})) dependsOn.add(dep);
      }
    } catch {
      // Missing/invalid package.json: keep the directory as an edge-less package.
    }
    const testRel = `packages/${entry.name}/test`;
    const testEntries = await readdir(join(worktreePath, testRel), { recursive: true }).catch(
      () => [] as string[],
    );
    const testFiles = testEntries
      .map((f) => String(f).replace(/\\/g, "/"))
      .filter((f) => TEST_FILE_RE.test(f))
      .map((f) => `${testRel}/${f}`)
      .sort();
    result.push({ dir: entry.name, name, dependsOn: Array.from(dependsOn).sort(), testFiles });
  }
  return result.sort((a, b) => a.dir.localeCompare(b.dir));
}

function buildDependentsIndex(packages: WorkspacePackageInfo[]): Map<string, Set<string>> {
  const nameToDir = new Map(packages.map((p) => [p.name, p.dir]));
  const dependents = new Map<string, Set<string>>();
  const addEdge = (dependencyDir: string, dependentDir: string): void => {
    const set = dependents.get(dependencyDir) ?? new Set<string>();
    set.add(dependentDir);
    dependents.set(dependencyDir, set);
  };
  for (const pkg of packages) {
    for (const dep of pkg.dependsOn) {
      const depDir = nameToDir.get(dep);
      if (depDir && depDir !== pkg.dir) addEdge(depDir, pkg.dir);
    }
  }
  for (const edge of MIRRORED_TYPE_DEPENDENTS) {
    const fromDir = nameToDir.get(edge.from);
    const toDir = nameToDir.get(edge.to);
    if (fromDir && toDir && fromDir !== toDir) addEdge(fromDir, toDir);
  }
  return dependents;
}

function closeOverDependents(seeds: Iterable<string>, dependents: Map<string, Set<string>>): Set<string> {
  const affected = new Set<string>(seeds);
  const queue = Array.from(affected);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of dependents.get(cur) ?? []) {
      if (!affected.has(next)) {
        affected.add(next);
        queue.push(next);
      }
    }
  }
  return affected;
}

/**
 * Pure planner: rewrites the repo's full verification commands so they only
 * cover packages/tests the diff can affect. Any doubt falls back to the
 * unchanged full command list (`useScoped: false`).
 */
export function planImpactScopedVerification(input: ImpactPlanInput): ImpactScopedVerificationPlan {
  const { fullCommands } = input;
  const full = (reason: string): ImpactScopedVerificationPlan => ({
    useScoped: false,
    commands: fullCommands,
    estimatedSavedMs: 0,
    reason,
  });

  const changed = Array.from(new Set(input.changedFiles.map(normalizeRelPath).filter(Boolean))).sort();
  if (changed.length === 0) {
    return full("no changed files detected; running full verification");
  }

  const rootHit = changed.find(isRootConfigOrScript);
  if (rootHit) {
    return full(`root config/script changed (${rootHit}); running full verification`);
  }

  const sensitive = input.sensitivePaths ?? [];
  const sensitiveHit =
    sensitive.length > 0 ? changed.find((f) => matchesPathScope(f, sensitive)) : undefined;
  if (sensitiveHit) {
    return full(`sensitive path touched (${sensitiveHit}); running full verification`);
  }

  const pkgByDir = new Map(input.packages.map((p) => [p.dir, p]));
  const changedDirs = new Set<string>();
  for (const f of changed) {
    const dir = toPackageDir(f);
    if (!dir || !pkgByDir.has(dir)) {
      return full(`changed file outside known workspace packages (${f}); running full verification`);
    }
    changedDirs.add(dir);
  }

  // --- Symbol graph reliability -------------------------------------------------
  const graph = input.symbolImpact;
  const changedSources = changed.filter((f) => SOURCE_FILE_RE.test(f));
  const hasNonSourceChange = changedSources.length !== changed.length;
  let graphReliable = false;
  if (graph && !hasNonSourceChange) {
    const targetSet = new Set(graph.targetFiles);
    const allChangedResolved = changedSources.every((f) => targetSet.has(f));
    const capped =
      graph.directDependents.length >= DIRECT_DEPENDENT_CAP ||
      graph.transitiveDependents.length >= TRANSITIVE_DEPENDENT_CAP;
    // A non-test source file nobody statically imports is likely an entry point or
    // dynamically imported; the graph cannot see who depends on it.
    const orphanSource =
      changedSources.some((f) => !TEST_FILE_RE.test(f)) && graph.directDependents.length === 0;
    graphReliable = allChangedResolved && !capped && !orphanSource;
  }

  // --- Affected packages --------------------------------------------------------
  const dependentsIndex = buildDependentsIndex(input.packages);
  const seeds = new Set(changedDirs);
  if (graph) {
    for (const f of [...graph.directDependents, ...graph.transitiveDependents]) {
      const dir = toPackageDir(f);
      if (dir && pkgByDir.has(dir)) seeds.add(dir);
    }
  }
  const affected = closeOverDependents(seeds, dependentsIndex);
  const affectedSorted = Array.from(affected).sort();

  // --- Test targets -------------------------------------------------------------
  // Changed packages always run their whole test dir; downstream packages are
  // narrowed to impacted files only when the symbol graph is trustworthy.
  const dirTargets = new Set<string>();
  for (const dir of affectedSorted) {
    const pkg = pkgByDir.get(dir);
    if (!pkg || pkg.testFiles.length === 0) continue;
    if (changedDirs.has(dir) || !graphReliable) dirTargets.add(`packages/${dir}/test`);
  }
  const fileTargets = new Set<string>();
  if (graphReliable && graph) {
    const impactedTests = new Set(
      [...graph.targetFiles, ...graph.directDependents, ...graph.transitiveDependents].filter((f) =>
        TEST_FILE_RE.test(f),
      ),
    );
    const byPackage = new Map<string, string[]>();
    for (const t of impactedTests) {
      if (Array.from(dirTargets).some((d) => t.startsWith(`${d}/`))) continue;
      const dir = toPackageDir(t);
      if (!dir) continue;
      byPackage.set(dir, [...(byPackage.get(dir) ?? []), t]);
    }
    for (const [dir, files] of byPackage) {
      const pkg = pkgByDir.get(dir);
      if (pkg && pkg.testFiles.length > 0 && files.length > MAX_TEST_FILE_TARGETS_PER_PACKAGE) {
        dirTargets.add(`packages/${dir}/test`);
      } else {
        for (const f of files) fileTargets.add(f);
      }
    }
  }
  const testTargets = [...Array.from(dirTargets), ...Array.from(fileTargets)].sort();

  // --- Command rewrite ----------------------------------------------------------
  const rewritten: string[] = [];
  for (const cmd of fullCommands) {
    switch (normalizeCommand(cmd)) {
      case CMD_TYPECHECK:
        for (const dir of affectedSorted) rewritten.push(`bun run --cwd packages/${dir} typecheck`);
        break;
      case CMD_TEST:
        if (testTargets.length > 0) rewritten.push(`${CMD_TEST} ${testTargets.join(" ")}`);
        break;
      case CMD_BUILD:
        if (affected.has(BUILD_PACKAGE_DIR)) rewritten.push(cmd);
        break;
      default:
        rewritten.push(cmd);
    }
  }

  if (rewritten.length === 0) {
    return full("scoped plan would run nothing; running full verification");
  }
  if (rewritten.length === fullCommands.length && rewritten.every((c, i) => c === fullCommands[i])) {
    return full("no rewritable verification commands; running full verification");
  }

  // --- Savings estimate ---------------------------------------------------------
  const has = (target: string): boolean => fullCommands.some((c) => normalizeCommand(c) === target);
  const packagesWithTests = input.packages.filter((p) => p.testFiles.length > 0);
  const testCoversEverything = packagesWithTests.every((p) => dirTargets.has(`packages/${p.dir}/test`));
  const testNarrowed = has(CMD_TEST) && (testTargets.length === 0 || !testCoversEverything);
  const typecheckNarrowed = has(CMD_TYPECHECK) && affected.size < input.packages.length;
  const buildOmitted = has(CMD_BUILD) && !affected.has(BUILD_PACKAGE_DIR);
  const estimatedSavedMs = testNarrowed
    ? FULL_TEST_SAVED_MS
    : typecheckNarrowed || buildOmitted
      ? TYPECHECK_BUILD_SAVED_MS
      : 0;

  const reasonParts = [
    `changed: ${Array.from(changedDirs).sort().join(", ")}`,
    `affected: ${affectedSorted.join(", ")}`,
  ];
  if (has(CMD_TEST)) {
    reasonParts.push(
      testTargets.length === 0
        ? "tests skipped (no affected package has tests)"
        : graphReliable
          ? `tests narrowed to ${testTargets.length} target(s)`
          : "tests scoped to package dirs (symbol graph unreliable)",
    );
  }
  if (has(CMD_BUILD)) {
    reasonParts.push(buildOmitted ? "build skipped" : "build kept");
  }

  return {
    useScoped: true,
    commands: rewritten,
    estimatedSavedMs,
    reason: `impact-scoped verification — ${reasonParts.join("; ")}`,
  };
}

/** I/O orchestrator: collects the diff + workspace metadata, then delegates to the pure planner. */
export async function resolveImpactScopedVerification(
  input: ImpactScopedVerificationInput,
  deps: { runGit: PlannerGitRunner },
): Promise<ImpactScopedVerificationPlan> {
  const fullFallback = (reason: string): ImpactScopedVerificationPlan => ({
    useScoped: false,
    commands: input.fullCommands,
    estimatedSavedMs: 0,
    reason,
  });

  const changed = await collectChangedFiles(input.worktreePath, input.baseBranch, deps.runGit);
  if (!changed.ok) {
    return fullFallback(`${changed.error}; running full verification`);
  }

  const packages = await loadWorkspacePackages(input.worktreePath);

  let symbolImpact: ImpactGraphSnapshot | null = null;
  const sourceFiles = changed.files.filter((f) => f.startsWith("packages/") && SOURCE_FILE_RE.test(f));
  if (sourceFiles.length > 0) {
    try {
      // Scan the worktree (not the root checkout) so freshly added import edges are visible.
      symbolImpact = await analyzeRepoSymbolImpact(input.worktreePath, sourceFiles);
    } catch {
      symbolImpact = null;
    }
  }

  return planImpactScopedVerification({
    fullCommands: input.fullCommands,
    changedFiles: changed.files,
    sensitivePaths: input.sensitivePaths,
    packages,
    symbolImpact,
  });
}
