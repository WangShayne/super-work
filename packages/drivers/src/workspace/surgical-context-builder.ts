import { basename, extname, posix } from "node:path";
import type { CodeHotspotItem } from "@super-work/core";
import { matchesPathScope } from "@super-work/core";
import { scanRepoSymbolGraph } from "./symbol-graph-scanner.ts";

const TEST_FILE_RE = /(?:\.(?:test|spec)\.[cm]?[tj]sx?$|(?:^|\/)test_[^/]+\.py$|_test\.(?:py|go)$)/;

export const SURGICAL_PACK_MAX_FILES = 8;
export const SURGICAL_PACK_MAX_CHARS = 2400;
export const HOTSPOT_DEFAULT_THRESHOLD = 1500;

function isTestFile(rel: string): boolean {
  return TEST_FILE_RE.test(rel);
}

function sourceStem(rel: string): string {
  const base = basename(rel, extname(rel));
  return base
    .replace(/\.(?:test|spec)$/, "")
    .replace(/^test_/, "")
    .replace(/_test$/, "");
}

function packageDirOf(rel: string): string {
  const parts = rel.split("/");
  if ((parts[0] === "packages" || parts[0] === "apps") && parts.length > 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts.length > 1 ? parts[0]! : ".";
}

export async function buildSurgicalContextPackImpl(input: {
  worktreePath: string;
  allowedPaths: string[];
  maxFiles?: number;
  maxChars?: number;
}): Promise<string | undefined> {
  const maxFiles = Math.max(1, input.maxFiles ?? SURGICAL_PACK_MAX_FILES);
  const maxChars = Math.max(80, input.maxChars ?? SURGICAL_PACK_MAX_CHARS);
  const graph = await scanRepoSymbolGraph(input.worktreePath);

  const testsByStem = new Map<string, string[]>();
  for (const f of graph.files) {
    if (!isTestFile(f.filePath)) continue;
    const stem = sourceStem(f.filePath);
    const list = testsByStem.get(stem) ?? [];
    list.push(f.filePath);
    testsByStem.set(stem, list);
  }

  const scope = input.allowedPaths.length > 0 ? input.allowedPaths : ["**"];
  const candidates = graph.files
    .map((f) => f.filePath)
    .filter((rel) => !isTestFile(rel) && matchesPathScope(rel, scope))
    .map((rel) => {
      const spans = graph.spansByFile.get(rel) ?? [];
      const dependents = (graph.importersByFile.get(rel) ?? []).filter((d) => !isTestFile(d));
      return { rel, spans, dependents, score: Math.min(spans.length, 5) + dependents.length * 2 };
    })
    .filter((c) => c.spans.length > 0 || c.dependents.length > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (graph.lineCountByFile.get(b.rel) ?? 0) - (graph.lineCountByFile.get(a.rel) ?? 0) ||
        a.rel.localeCompare(b.rel),
    )
    .slice(0, maxFiles);

  if (candidates.length === 0) return undefined;

  const blocks: string[] = [];
  let used = 0;
  for (const c of candidates) {
    const lines = [`- ${c.rel} (${graph.lineCountByFile.get(c.rel) ?? 0} lines)`];
    if (c.spans.length > 0) {
      lines.push(
        `  symbols: ${c.spans
          .slice(0, 5)
          .map((sp) => `${sp.kind} ${sp.name} L${sp.startLine}-L${sp.endLine}`)
          .join("; ")}`,
      );
    }
    const tests = (testsByStem.get(sourceStem(c.rel)) ?? []).slice(0, 2);
    if (tests.length > 0) lines.push(`  tests: ${tests.join(", ")}`);
    if (c.dependents.length > 0) {
      const shown = c.dependents.slice(0, 4).join(", ");
      lines.push(`  dependents: ${shown}${c.dependents.length > 4 ? ` (+${c.dependents.length - 4})` : ""}`);
    }
    const block = lines.join("\n");
    const cost = block.length + (blocks.length > 0 ? 1 : 0);
    if (used + cost > maxChars) {
      if (blocks.length === 0) blocks.push(block.slice(0, maxChars));
      break;
    }
    blocks.push(block);
    used += cost;
  }
  return blocks.join("\n").slice(0, maxChars);
}

export async function scanCodeHotspotsImpl(
  rootRepoPath: string,
  thresholdLines = HOTSPOT_DEFAULT_THRESHOLD,
): Promise<CodeHotspotItem[]> {
  const graph = await scanRepoSymbolGraph(rootRepoPath);
  const out: CodeHotspotItem[] = [];
  for (const f of graph.files) {
    if (isTestFile(f.filePath)) continue;
    const lineCount = graph.lineCountByFile.get(f.filePath) ?? 0;
    if (lineCount <= thresholdLines) continue;
    out.push({
      filePath: posix.normalize(f.filePath),
      lineCount,
      exportedSymbolCount: (graph.spansByFile.get(f.filePath) ?? []).length,
      dependentCount: (graph.importersByFile.get(f.filePath) ?? []).length,
      packageDir: packageDirOf(f.filePath),
    });
  }
  return out.sort((a, b) => b.lineCount - a.lineCount || a.filePath.localeCompare(b.filePath));
}
