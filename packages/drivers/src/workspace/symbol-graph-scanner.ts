import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, join, posix, resolve } from "node:path";
import type { FileSymbolEntry, SymbolImpactReport } from "@super-work/core";
import { matchesPathScope, normalizeRelPath } from "@super-work/core";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".super-work",
  "dist",
  "build",
  ".next",
  "coverage",
  ".turbo",
  ".cache",
  "target",
  "__pycache__",
  ".venv",
]);

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
]);

export interface SymbolSpan {
  name: string;
  kind: string;
  /** 1-based inclusive start line */
  startLine: number;
  /** 1-based inclusive end line */
  endLine: number;
}

interface CachedParsedFile {
  mtimeMs: number;
  size: number;
  lineCount: number;
  spans: SymbolSpan[];
  rawImports: string[];
  exportedSymbols: string[];
  reExports: string[];
}

const fileParseCache = new Map<string, CachedParsedFile>();

export function clearSymbolGraphCache(): void {
  fileParseCache.clear();
}

function splitLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Brace/paren balanced end-line (0-based) for a top-level declaration starting at `start`. */
function findBalancedEnd(lines: string[], start: number, quotes: string, lineComment: string): number {
  let depth = 0;
  let inBlockComment = false;
  let quote: string | null = null;
  for (let j = start; j < lines.length; j++) {
    const line = lines[j]!;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c]!;
      if (inBlockComment) {
        if (ch === "*" && line[c + 1] === "/") {
          inBlockComment = false;
          c++;
        }
        continue;
      }
      if (quote) {
        if (ch === "\\" && quote !== "`") {
          c++;
        } else if (ch === "\\") {
          c++;
        } else if (ch === quote) {
          quote = null;
        }
        continue;
      }
      if (line.startsWith(lineComment, c)) break;
      if (lineComment === "//" && ch === "/" && line[c + 1] === "*") {
        inBlockComment = true;
        c++;
        continue;
      }
      if (quotes.includes(ch)) {
        quote = ch;
        continue;
      }
      if (ch === "{" || ch === "(" || ch === "[") depth++;
      else if (ch === "}" || ch === ")" || ch === "]") depth--;
    }
    // Plain quotes never span lines (only template literals do)
    if (quote && quote !== "`") quote = null;
    if (depth <= 0 && !inBlockComment && !quote) {
      let k = j + 1;
      while (k < lines.length && lines[k]!.trim() === "") k++;
      if (k >= lines.length) return j;
      const next = lines[k]!;
      if (!/^\s/.test(next) && !next.startsWith("{")) return j;
      // Continuation (e.g. multi-line union type or brace on next line): keep scanning
      if (depth < 0) return j;
    }
  }
  return lines.length - 1;
}

function trimTrailingBlank(lines: string[], from: number, to: number): number {
  let e = to;
  while (e > from && lines[e]!.trim() === "") e--;
  return e;
}

export function extractSymbolSpans(filePath: string, content: string): SymbolSpan[] {
  const ext = extname(filePath).toLowerCase();
  const lines = splitLines(content);
  const starts: Array<{ idx: number; name: string; kind: string }> = [];

  if (ext === ".py") {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i]!.match(/^(?:async\s+)?(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (m?.[2] && !m[2].startsWith("_")) starts.push({ idx: i, name: m[2], kind: m[1]! });
    }
    return starts.map((st) => {
      let k = st.idx + 1;
      while (k < lines.length && (lines[k]!.trim() === "" || /^\s/.test(lines[k]!))) k++;
      const end = trimTrailingBlank(lines, st.idx, k - 1);
      return { name: st.name, kind: st.kind, startLine: st.idx + 1, endLine: end + 1 };
    });
  }

  let quotes = "\"'`";
  let lineComment = "//";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (ext === ".go") {
      const f = line.match(/^func\s+(?:\([^)]*\)\s*)?([A-Z][A-Za-z0-9_]*)/);
      if (f?.[1]) starts.push({ idx: i, name: f[1], kind: "func" });
      const t = line.match(/^type\s+([A-Z][A-Za-z0-9_]*)\s+/);
      if (t?.[1]) starts.push({ idx: i, name: t[1], kind: "type" });
    } else if (ext === ".rs") {
      const m = line.match(/^pub(?:\([^)]+\))?\s+(?:async\s+)?(fn|struct|enum|trait|type)\s+([A-Za-z0-9_]+)/);
      if (m?.[2]) starts.push({ idx: i, name: m[2], kind: m[1]! });
    } else {
      const m = line.match(
        /^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|class|interface|type|enum|const)\s+([A-Za-z0-9_$]+)/,
      );
      if (m?.[2]) starts.push({ idx: i, name: m[2], kind: m[1]!.replace("*", "") });
    }
  }
  if (ext === ".rs") quotes = '"';
  if (ext === ".go") quotes = "\"`'";

  return starts.map((st, n) => {
    let end = findBalancedEnd(lines, st.idx, quotes, lineComment);
    const nextStart = starts[n + 1]?.idx;
    if (nextStart !== undefined && end >= nextStart) end = nextStart - 1;
    end = trimTrailingBlank(lines, st.idx, Math.max(st.idx, end));
    return { name: st.name, kind: st.kind, startLine: st.idx + 1, endLine: end + 1 };
  });
}

function parseSourceFileContent(filePath: string, content: string): Omit<CachedParsedFile, "mtimeMs" | "size" | "lineCount" | "spans"> {
  const ext = extname(filePath).toLowerCase();
  const rawImports: string[] = [];
  const exportedSymbols: string[] = [];
  const reExports: string[] = [];

  if (ext === ".py") {
    for (const line of content.split("\n")) {
      const t = line.trim();
      const fromMatch = t.match(/^from\s+([.\w]+)\s+import\s+/);
      if (fromMatch?.[1]) rawImports.push(fromMatch[1]);
      const impMatch = t.match(/^import\s+([\w.]+)/);
      if (impMatch?.[1]) rawImports.push(impMatch[1]);
      const defMatch = t.match(/^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
      if (defMatch?.[1] && !defMatch[1].startsWith("_")) exportedSymbols.push(`def ${defMatch[1]}`);
      const clsMatch = t.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (clsMatch?.[1] && !clsMatch[1].startsWith("_")) exportedSymbols.push(`class ${clsMatch[1]}`);
    }
    return { rawImports, exportedSymbols: Array.from(new Set(exportedSymbols)).slice(0, 20), reExports };
  }

  if (ext === ".go") {
    const impMatches = content.matchAll(/import\s+(?:\([^)]*\)|"([^"]+)")/g);
    for (const m of impMatches) {
      if (m[1]) rawImports.push(m[1]);
    }
    for (const line of content.split("\n")) {
      const t = line.trim();
      const funcMatch = t.match(/^func\s+(?:\([^)]+\)\s*)?([A-Z][A-Za-z0-9_]*)\s*\(/);
      if (funcMatch?.[1]) exportedSymbols.push(`func ${funcMatch[1]}`);
      const typeMatch = t.match(/^type\s+([A-Z][A-Za-z0-9_]*)\s+/);
      if (typeMatch?.[1]) exportedSymbols.push(`type ${typeMatch[1]}`);
    }
    return { rawImports, exportedSymbols: Array.from(new Set(exportedSymbols)).slice(0, 20), reExports };
  }

  if (ext === ".rs") {
    for (const line of content.split("\n")) {
      const t = line.trim();
      const modMatch = t.match(/^(?:pub\s+)?mod\s+([A-Za-z0-9_]+)\s*;/);
      if (modMatch?.[1]) rawImports.push(`./${modMatch[1]}`);
      const pubMatch = t.match(
        /^pub(?:\([^)]+\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|type)\s+([A-Za-z0-9_]+)/,
      );
      if (pubMatch?.[1]) exportedSymbols.push(pubMatch[1]);
    }
    return { rawImports, exportedSymbols: Array.from(new Set(exportedSymbols)).slice(0, 20), reExports };
  }

  // TS / JS modules
  const staticImportRe = /(?:import|export)\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?["']([^"']+)["']/g;
  for (const m of content.matchAll(staticImportRe)) {
    const spec = m[1]?.trim();
    if (!spec) continue;
    rawImports.push(spec);
    if (m[0].startsWith("export")) {
      reExports.push(spec);
    }
  }
  const reqRe = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of content.matchAll(reqRe)) {
    if (m[1]) rawImports.push(m[1].trim());
  }

  for (const line of content.split("\n")) {
    const t = line.trim();
    const decl = t.match(
      /^export\s+(?:default\s+)?(?:async\s+)?(function|class|interface|type|const|let|enum)\s+([A-Za-z0-9_$]+)/,
    );
    if (decl?.[1] && decl[2]) {
      exportedSymbols.push(`${decl[1]} ${decl[2]}`);
      continue;
    }
    const namedList = t.match(/^export\s+\{([^}]+)\}/);
    if (namedList?.[1]) {
      for (const item of namedList[1].split(",")) {
        const clean = item.trim().split(/\s+as\s+/)[0]?.trim();
        if (clean) exportedSymbols.push(clean);
      }
    }
  }

  return {
    rawImports: Array.from(new Set(rawImports)),
    exportedSymbols: Array.from(new Set(exportedSymbols)).slice(0, 20),
    reExports: Array.from(new Set(reExports)),
  };
}

async function collectWorkspacePackageEntries(absRoot: string): Promise<Map<string, string>> {
  const pkgEntries = new Map<string, string>();
  for (const container of ["packages", "apps"]) {
    const containerDir = join(absRoot, container);
    if (!existsSync(containerDir)) continue;
    const dirs = await readdir(containerDir, { withFileTypes: true }).catch(() => []);
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const pkgJsonPath = join(containerDir, dir.name, "package.json");
      try {
        const pkg = JSON.parse(await readFile(pkgJsonPath, "utf8")) as {
          name?: string;
          main?: string;
          exports?: Record<string, unknown> | string;
        };
        if (!pkg.name) continue;
        let entryRel = `${container}/${dir.name}/src/index.ts`;
        const dotExp =
          typeof pkg.exports === "string"
            ? pkg.exports
            : pkg.exports && typeof pkg.exports === "object"
              ? (pkg.exports["."] as string | undefined)
              : undefined;
        const candidateRel = dotExp || pkg.main;
        if (typeof candidateRel === "string" && candidateRel.trim()) {
          entryRel = normalizeRelPath(`${container}/${dir.name}/${candidateRel}`);
        }
        pkgEntries.set(pkg.name, entryRel);
      } catch {
        // ignore invalid package.json
      }
    }
  }
  return pkgEntries;
}

function resolveSpecifier(
  fromRelFile: string,
  spec: string,
  fileSet: Set<string>,
  pkgEntries: Map<string, string>,
): string | null {
  const resolveCandidateBase = (relBase: string): string | null => {
    const clean = normalizeRelPath(relBase);
    if (!clean) return null;
    if (fileSet.has(clean)) return clean;

    const exts = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".py", ".rs"];
    // Handle `.js` -> `.ts` TS ESM import specifiers
    const strippedJs = clean.replace(/\.(?:js|mjs|jsx)$/i, "");
    for (const ext of exts) {
      if (fileSet.has(`${clean}${ext}`)) return `${clean}${ext}`;
      if (strippedJs !== clean && fileSet.has(`${strippedJs}${ext}`)) {
        return `${strippedJs}${ext}`;
      }
    }
    for (const idx of ["index.ts", "index.tsx", "index.js", "mod.rs", "__init__.py"]) {
      const joined = `${clean}/${idx}`;
      if (fileSet.has(joined)) return joined;
    }
    return null;
  };

  if (spec.startsWith(".")) {
    const dir = posix.dirname(fromRelFile);
    const combined = dir === "." ? spec : posix.join(dir, spec);
    return resolveCandidateBase(combined);
  }

  const pkgEntry = pkgEntries.get(spec);
  if (pkgEntry && fileSet.has(pkgEntry)) {
    return pkgEntry;
  }
  return null;
}

export async function scanRepoSymbolGraph(rootRepoPath: string): Promise<{
  files: FileSymbolEntry[];
  importersByFile: Map<string, string[]>;
  importsByFile: Map<string, string[]>;
  signaturesByFile: Map<string, string[]>;
  spansByFile: Map<string, SymbolSpan[]>;
  lineCountByFile: Map<string, number>;
}> {
  const absRoot = resolve(rootRepoPath);
  if (!existsSync(absRoot)) {
    return {
      files: [],
      importersByFile: new Map(),
      importsByFile: new Map(),
      signaturesByFile: new Map(),
      spansByFile: new Map(),
      lineCountByFile: new Map(),
    };
  }

  const allFiles: string[] = [];
  const walk = async (relDir: string): Promise<void> => {
    if (allFiles.length >= 1500) return;
    const fullDir = relDir ? join(absRoot, relDir) : absRoot;
    const entries = await readdir(fullDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (allFiles.length >= 1500) break;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await walk(relDir ? `${relDir}/${entry.name}` : entry.name);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (SOURCE_EXTENSIONS.has(ext)) {
          allFiles.push(relDir ? `${relDir}/${entry.name}` : entry.name);
        }
      }
    }
  };
  await walk("");

  const fileSet = new Set(allFiles);
  const pkgEntries = await collectWorkspacePackageEntries(absRoot);

  const parsedByFile = new Map<string, CachedParsedFile>();
  for (const rel of allFiles) {
    const full = join(absRoot, rel);
    try {
      const st = await stat(full);
      const cacheKey = `${absRoot}::${rel}`;
      const cached = fileParseCache.get(cacheKey);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        parsedByFile.set(rel, cached);
        continue;
      }
      const text = await readFile(full, "utf8");
      const parsed = parseSourceFileContent(rel, text);
      const entry: CachedParsedFile = {
        mtimeMs: st.mtimeMs,
        size: st.size,
        lineCount: splitLines(text).length,
        spans: extractSymbolSpans(rel, text),
        ...parsed,
      };
      fileParseCache.set(cacheKey, entry);
      parsedByFile.set(rel, entry);
    } catch {
      // Skip unreadable file
    }
  }

  const importsByFile = new Map<string, string[]>();
  const importersByFile = new Map<string, string[]>();
  const signaturesByFile = new Map<string, string[]>();
  const reExportsByFile = new Map<string, string[]>();

  for (const rel of allFiles) {
    importsByFile.set(rel, []);
    importersByFile.set(rel, []);
    signaturesByFile.set(rel, parsedByFile.get(rel)?.exportedSymbols ?? []);
    reExportsByFile.set(rel, []);
  }

  for (const rel of allFiles) {
    const parsed = parsedByFile.get(rel);
    if (!parsed) continue;
    const resolvedImports: string[] = [];
    for (const raw of parsed.rawImports) {
      const target = resolveSpecifier(rel, raw, fileSet, pkgEntries);
      if (target && target !== rel && !resolvedImports.includes(target)) {
        resolvedImports.push(target);
        importersByFile.get(target)?.push(rel);
      }
    }
    const resolvedReExports: string[] = [];
    for (const rawRe of parsed.reExports) {
      const target = resolveSpecifier(rel, rawRe, fileSet, pkgEntries);
      if (target && target !== rel && !resolvedReExports.includes(target)) {
        resolvedReExports.push(target);
      }
    }
    importsByFile.set(rel, resolvedImports);
    reExportsByFile.set(rel, resolvedReExports);
  }

  // Propagate barrel index re-exports one hop so importing `pkg/src/index.ts` links to leaf modules too
  for (const [barrelFile, targets] of reExportsByFile.entries()) {
    const barrelImporters = importersByFile.get(barrelFile) ?? [];
    if (barrelImporters.length === 0 || targets.length === 0) continue;
    for (const leaf of targets) {
      const leafImporters = importersByFile.get(leaf);
      if (!leafImporters) continue;
      for (const imp of barrelImporters) {
        if (imp !== leaf && !leafImporters.includes(imp)) {
          leafImporters.push(imp);
        }
      }
    }
  }

  const files: FileSymbolEntry[] = allFiles.map((rel) => ({
    filePath: rel,
    imports: importsByFile.get(rel) ?? [],
    exportedSymbols: signaturesByFile.get(rel) ?? [],
  }));

  const spansByFile = new Map<string, SymbolSpan[]>();
  const lineCountByFile = new Map<string, number>();
  for (const rel of allFiles) {
    const parsed = parsedByFile.get(rel);
    spansByFile.set(rel, parsed?.spans ?? []);
    lineCountByFile.set(rel, parsed?.lineCount ?? 0);
  }

  return { files, importersByFile, importsByFile, signaturesByFile, spansByFile, lineCountByFile };
}

export async function analyzeRepoSymbolImpact(
  rootRepoPath: string,
  scopePatterns: string[],
): Promise<SymbolImpactReport> {
  const cleanScopes = scopePatterns.map((s) => s.trim()).filter(Boolean);
  if (cleanScopes.length === 0 || cleanScopes.includes("**")) {
    return {
      targetFiles: [],
      directDependents: [],
      transitiveDependents: [],
      neighborSignatures: [],
      contextPackMarkdown: "",
    };
  }

  const graph = await scanRepoSymbolGraph(rootRepoPath);
  const allFilePaths = graph.files.map((f) => f.filePath);
  const targetFiles = allFilePaths.filter((rel) => matchesPathScope(rel, cleanScopes));
  const targetSet = new Set(targetFiles);

  const directSet = new Set<string>();
  for (const tf of targetFiles) {
    for (const importer of graph.importersByFile.get(tf) ?? []) {
      if (!targetSet.has(importer)) {
        directSet.add(importer);
      }
    }
  }

  const directDependents = Array.from(directSet).sort().slice(0, 30);

  const transitiveSet = new Set<string>();
  const queue = [...directDependents];
  while (queue.length > 0 && transitiveSet.size < 40) {
    const cur = queue.shift()!;
    for (const upstream of graph.importersByFile.get(cur) ?? []) {
      if (!targetSet.has(upstream) && !directSet.has(upstream) && !transitiveSet.has(upstream)) {
        transitiveSet.add(upstream);
        queue.push(upstream);
      }
    }
  }
  const transitiveDependents = Array.from(transitiveSet).sort();

  const neighborSignatures: SymbolImpactReport["neighborSignatures"] = [];
  for (const tf of targetFiles.slice(0, 6)) {
    const syms = graph.signaturesByFile.get(tf) ?? [];
    if (syms.length > 0) {
      neighborSignatures.push({ filePath: tf, relation: "target", symbols: syms.slice(0, 10) });
    }
    for (const imp of (graph.importsByFile.get(tf) ?? []).slice(0, 4)) {
      if (targetSet.has(imp) || neighborSignatures.some((n) => n.filePath === imp)) continue;
      const impSyms = graph.signaturesByFile.get(imp) ?? [];
      if (impSyms.length > 0) {
        neighborSignatures.push({
          filePath: imp,
          relation: "direct_import",
          symbols: impSyms.slice(0, 10),
        });
      }
    }
  }
  for (const dd of directDependents.slice(0, 6)) {
    if (neighborSignatures.some((n) => n.filePath === dd)) continue;
    const syms = graph.signaturesByFile.get(dd) ?? [];
    if (syms.length > 0) {
      neighborSignatures.push({
        filePath: dd,
        relation: "direct_dependent",
        symbols: syms.slice(0, 8),
      });
    }
  }

  const lines: string[] = [];
  if (directDependents.length > 0) {
    lines.push(`- **1-Hop Direct Callers / Importers**: ${directDependents.slice(0, 10).join(", ")}`);
  }
  if (transitiveDependents.length > 0) {
    lines.push(
      `- **Transitive Downstream Files (2+ hops)**: ${transitiveDependents.slice(0, 8).join(", ")}`,
    );
  }
  for (const n of neighborSignatures.slice(0, 10)) {
    lines.push(`- \`${n.filePath}\` (${n.relation}): ${n.symbols.join(", ")}`);
  }

  let contextPackMarkdown = "";
  if (lines.length > 0) {
    contextPackMarkdown = `## Symbol Impact Radius & Neighbor Exports\n${lines.join("\n")}`;
    if (contextPackMarkdown.length > 1550) {
      contextPackMarkdown = `${contextPackMarkdown.slice(0, 1547)}...`;
    }
  }

  return {
    targetFiles,
    directDependents,
    transitiveDependents,
    neighborSignatures,
    contextPackMarkdown,
  };
}
