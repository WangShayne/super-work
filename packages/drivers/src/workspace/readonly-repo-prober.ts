import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  DEFAULT_FORBIDDEN_PATHS,
  matchesPathScope,
  normalizeRelPath,
  type ControlProbeRequest,
  type ControlProbeStep,
  type RepoProbeContextPack,
} from "@super-work/core";
import { scanRepoSymbolGraph } from "./symbol-graph-scanner.ts";

const INTERNAL_BLOCKED_PATTERNS = [
  ".git",
  ".git/**",
  "node_modules",
  "node_modules/**",
  ".super-work",
  ".super-work/**",
];

const PROBE_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "into",
  "that",
  "this",
  "when",
  "where",
  "what",
  "which",
  "should",
  "could",
  "would",
  "ticket",
  "issue",
  "error",
  "check",
  "update",
  "add",
  "fix",
  "make",
  "run",
  "test",
]);

function combinedBlockedPatterns(forbiddenPaths?: string[]): string[] {
  return [
    ...DEFAULT_FORBIDDEN_PATHS,
    ...INTERNAL_BLOCKED_PATTERNS,
    ...(forbiddenPaths ?? []).map((p) => p.trim()).filter(Boolean),
  ];
}

export function isProbePathAllowed(relPath: string, forbiddenPaths?: string[]): boolean {
  const norm = normalizeRelPath(relPath);
  if (!norm || norm === "." || norm.startsWith("..") || norm.includes("\0")) {
    return false;
  }
  const blocked = combinedBlockedPatterns(forbiddenPaths);
  return !matchesPathScope(norm, blocked);
}

async function resolveSafeFileInsideRepo(
  absRoot: string,
  relPath: string,
  forbiddenPaths?: string[],
): Promise<{ normRel: string; absFile: string } | null> {
  const clean = normalizeRelPath(relPath);
  if (!isProbePathAllowed(clean, forbiddenPaths)) {
    return null;
  }
  const candidate = resolve(absRoot, clean);
  if (!candidate.startsWith(absRoot)) {
    return null;
  }
  if (!existsSync(candidate)) {
    return null;
  }
  try {
    const [realRoot, realTarget] = await Promise.all([realpath(absRoot), realpath(candidate)]);
    const rel = relative(realRoot, realTarget);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      return null;
    }
    const realNorm = normalizeRelPath(rel);
    if (!isProbePathAllowed(realNorm, forbiddenPaths)) {
      return null;
    }
    return { normRel: realNorm, absFile: realTarget };
  } catch {
    return null;
  }
}

function extractProbeTokens(queryText: string): string[] {
  const explicitPaths =
    queryText.match(/(?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.*-]+/g)?.map((p) =>
      normalizeRelPath(p),
    ) ?? [];
  const words = queryText
    .split(/[^a-zA-Z0-9_./-]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !PROBE_STOPWORDS.has(w.toLowerCase()));
  return Array.from(new Set([...explicitPaths, ...words])).slice(0, 16);
}

async function runGitQuickLog(
  absRoot: string,
  limit: number,
  relPath?: string,
): Promise<string[]> {
  if (!existsSync(join(absRoot, ".git"))) {
    return [];
  }
  const safeLimit = Math.max(1, Math.min(10, limit));
  const args = ["log", `-n`, String(safeLimit), "--oneline"];
  if (relPath) {
    args.push("--", relPath);
  }
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd: absRoot,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) return [];
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, safeLimit);
  } catch {
    return [];
  }
}

export async function runDeterministicRepoPreProbe(
  rootRepoPath: string,
  queryText: string,
  forbiddenPaths?: string[],
): Promise<RepoProbeContextPack> {
  const absRoot = resolve(rootRepoPath);
  if (!existsSync(absRoot)) {
    return {
      deterministicSummary: "",
      matchedFiles: [],
      recentCommits: [],
      probeSteps: [],
    };
  }

  const probeSteps: ControlProbeStep[] = [];
  const t0 = Date.now();
  const tokens = extractProbeTokens(queryText);
  const graph = await scanRepoSymbolGraph(absRoot).catch(() => ({
    files: [],
    importersByFile: new Map(),
    importsByFile: new Map(),
    signaturesByFile: new Map(),
  }));

  const scored: Array<{ filePath: string; score: number; symbols: string[] }> = [];
  for (const entry of graph.files) {
    if (!isProbePathAllowed(entry.filePath, forbiddenPaths)) continue;
    const pLower = entry.filePath.toLowerCase();
    const symsLower = entry.exportedSymbols.join(" ").toLowerCase();
    let score = 0;
    for (const tok of tokens) {
      const tl = tok.toLowerCase();
      if (pLower === tl || pLower.endsWith(`/${tl}`)) score += 6;
      else if (pLower.includes(tl)) score += 3;
      if (symsLower.includes(tl)) score += 3;
    }
    if (score > 0) {
      scored.push({
        filePath: entry.filePath,
        score,
        symbols: entry.exportedSymbols.slice(0, 6),
      });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath));
  const topMatched = scored.slice(0, 6);
  const matchedFiles = topMatched.map((s) => s.filePath);

  if (topMatched.length > 0) {
    probeSteps.push({
      step: 0,
      tool: "search_symbols",
      inputSummary: `tokens=[${tokens.slice(0, 6).join(", ")}]`,
      outputSummary: `Matched ${topMatched.length} file(s): ${matchedFiles.join(", ")}`,
      matchedPaths: matchedFiles,
      durationMs: Math.max(1, Date.now() - t0),
    });
  }

  const sliceSnippets: string[] = [];
  for (const item of topMatched.slice(0, 3)) {
    const tRead = Date.now();
    const resolvedFile = await resolveSafeFileInsideRepo(absRoot, item.filePath, forbiddenPaths);
    if (!resolvedFile) continue;
    try {
      const content = await readFile(resolvedFile.absFile, "utf8");
      const lines = content.split("\n").slice(0, 35);
      const excerpt = lines.join("\n").slice(0, 600);
      sliceSnippets.push(`### ${resolvedFile.normRel} (lines 1-${lines.length})\n${excerpt}`);
      probeSteps.push({
        step: 0,
        tool: "read_file_slice",
        inputSummary: `${resolvedFile.normRel}:1-${lines.length}`,
        outputSummary: `Read ${lines.length} lines (${excerpt.length} chars)`,
        matchedPaths: [resolvedFile.normRel],
        durationMs: Math.max(1, Date.now() - tRead),
      });
    } catch {
      // Ignore unreadable slice
    }
  }

  const tGit = Date.now();
  const recentCommits = await runGitQuickLog(absRoot, 5);
  if (recentCommits.length > 0) {
    probeSteps.push({
      step: 0,
      tool: "git_recent_commits",
      inputSummary: "limit=5",
      outputSummary: recentCommits.slice(0, 3).join(" | "),
      matchedPaths: [],
      durationMs: Math.max(1, Date.now() - tGit),
    });
  }

  const parts: string[] = [];
  if (topMatched.length > 0) {
    parts.push(
      `Matched symbols & files:\n${topMatched
        .map(
          (m) =>
            `- ${m.filePath}${m.symbols.length ? ` [exports: ${m.symbols.join(", ")}]` : ""}`,
        )
        .join("\n")}`,
    );
  }
  if (sliceSnippets.length > 0) {
    parts.push(`Code slices:\n${sliceSnippets.join("\n\n")}`);
  }
  if (recentCommits.length > 0) {
    parts.push(`Recent commits:\n${recentCommits.map((c) => `- ${c}`).join("\n")}`);
  }

  let deterministicSummary = parts.join("\n\n");
  if (deterministicSummary.length > 2600) {
    deterministicSummary = `${deterministicSummary.slice(0, 2584)}\n...(truncated)`;
  }

  return {
    deterministicSummary,
    matchedFiles,
    recentCommits,
    probeSteps,
  };
}

export async function executeReadOnlyProbeTool(
  rootRepoPath: string,
  req: ControlProbeRequest,
  forbiddenPaths?: string[],
  stepIndex = 1,
): Promise<ControlProbeStep> {
  const started = Date.now();
  const absRoot = resolve(rootRepoPath);

  if (req.tool === "read_file_slice") {
    const rawPath = req.path?.trim() ?? "";
    if (!rawPath) {
      return {
        step: stepIndex,
        tool: req.tool,
        inputSummary: "(missing path)",
        outputSummary: "Rejected: path parameter is required.",
        matchedPaths: [],
        durationMs: Math.max(1, Date.now() - started),
      };
    }
    if (!isProbePathAllowed(rawPath, forbiddenPaths)) {
      return {
        step: stepIndex,
        tool: req.tool,
        inputSummary: rawPath,
        outputSummary: `Blocked: '${rawPath}' is forbidden or outside repository root.`,
        matchedPaths: [],
        durationMs: Math.max(1, Date.now() - started),
      };
    }
    const resolvedFile = await resolveSafeFileInsideRepo(absRoot, rawPath, forbiddenPaths);
    if (!resolvedFile) {
      return {
        step: stepIndex,
        tool: req.tool,
        inputSummary: rawPath,
        outputSummary: `File not found or unreadable within repo: ${rawPath}`,
        matchedPaths: [],
        durationMs: Math.max(1, Date.now() - started),
      };
    }
    const rawText = await readFile(resolvedFile.absFile, "utf8");
    const lines = rawText.split("\n");
    const startLine = Math.max(1, Math.floor(req.startLine ?? 1));
    const endLine = Math.min(lines.length, Math.max(startLine, Math.floor(req.endLine ?? startLine + 79)));
    const boundedEnd = Math.min(endLine, startLine + 79);
    const sliceText = lines
      .slice(startLine - 1, boundedEnd)
      .map((line, i) => `${startLine + i}: ${line}`)
      .join("\n")
      .slice(0, 3200);

    return {
      step: stepIndex,
      tool: req.tool,
      inputSummary: `${resolvedFile.normRel}:${startLine}-${boundedEnd}`,
      outputSummary: sliceText || "(empty slice)",
      matchedPaths: [resolvedFile.normRel],
      durationMs: Math.max(1, Date.now() - started),
    };
  }

  if (req.tool === "search_symbols") {
    const query = (req.query ?? "").trim();
    const tokens = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length >= 2);
    const graph = await scanRepoSymbolGraph(absRoot);
    const hits = graph.files
      .filter((f) => isProbePathAllowed(f.filePath, forbiddenPaths))
      .map((f) => {
        const hay = `${f.filePath} ${f.exportedSymbols.join(" ")}`.toLowerCase();
        const score = tokens.reduce((acc, tok) => (hay.includes(tok) ? acc + 1 : acc), 0);
        return { f, score };
      })
      .filter((x) => (tokens.length === 0 ? true : x.score > 0))
      .sort((a, b) => b.score - a.score || a.f.filePath.localeCompare(b.f.filePath))
      .slice(0, Math.max(1, Math.min(12, req.limit ?? 8)));

    const matchedPaths = hits.map((h) => h.f.filePath);
    const summaryLines = hits.map(
      (h) => `${h.f.filePath}: [${h.f.exportedSymbols.slice(0, 6).join(", ")}]`,
    );
    return {
      step: stepIndex,
      tool: req.tool,
      inputSummary: `query="${query.slice(0, 80)}"`,
      outputSummary: summaryLines.length > 0 ? summaryLines.join("\n") : "No matching symbols.",
      matchedPaths,
      durationMs: Math.max(1, Date.now() - started),
    };
  }

  if (req.tool === "grep_literals") {
    const query = (req.query ?? "").trim();
    if (query.length < 2) {
      return {
        step: stepIndex,
        tool: req.tool,
        inputSummary: `query="${query}"`,
        outputSummary: "Query must be at least 2 characters.",
        matchedPaths: [],
        durationMs: Math.max(1, Date.now() - started),
      };
    }
    const qLower = query.toLowerCase();
    const maxHits = Math.max(1, Math.min(15, req.limit ?? 10));
    const graph = await scanRepoSymbolGraph(absRoot);
    const matchedLines: string[] = [];
    const matchedPathsSet = new Set<string>();

    for (const f of graph.files) {
      if (matchedLines.length >= maxHits) break;
      if (!isProbePathAllowed(f.filePath, forbiddenPaths)) continue;
      if (req.path?.trim() && !matchesPathScope(f.filePath, [req.path.trim()])) continue;
      const resolvedFile = await resolveSafeFileInsideRepo(absRoot, f.filePath, forbiddenPaths);
      if (!resolvedFile) continue;
      const text = await readFile(resolvedFile.absFile, "utf8").catch(() => "");
      if (!text || !text.toLowerCase().includes(qLower)) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i]!.toLowerCase().includes(qLower)) {
          matchedPathsSet.add(resolvedFile.normRel);
          matchedLines.push(`${resolvedFile.normRel}:${i + 1}: ${lines[i]!.trim().slice(0, 140)}`);
          if (matchedLines.length >= maxHits) break;
        }
      }
    }

    return {
      step: stepIndex,
      tool: req.tool,
      inputSummary: `query="${query.slice(0, 60)}"${req.path ? ` path=${req.path}` : ""}`,
      outputSummary:
        matchedLines.length > 0 ? matchedLines.join("\n").slice(0, 2400) : "No literal matches.",
      matchedPaths: Array.from(matchedPathsSet),
      durationMs: Math.max(1, Date.now() - started),
    };
  }

  // git_recent_commits
  const relFilter =
    req.path?.trim() && isProbePathAllowed(req.path.trim(), forbiddenPaths)
      ? normalizeRelPath(req.path.trim())
      : undefined;
  const commits = await runGitQuickLog(absRoot, req.limit ?? 8, relFilter);
  return {
    step: stepIndex,
    tool: "git_recent_commits",
    inputSummary: `limit=${Math.min(10, req.limit ?? 8)}${relFilter ? ` path=${relFilter}` : ""}`,
    outputSummary: commits.length > 0 ? commits.join("\n") : "No commits found.",
    matchedPaths: relFilter ? [relFilter] : [],
    durationMs: Math.max(1, Date.now() - started),
  };
}
