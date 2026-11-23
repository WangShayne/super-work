import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

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

const CACHE_TTL_MS = 60_000;
const MAX_SUMMARY_CHARS = 2_000;

interface CacheEntry {
  summary: string;
  expiresAt: number;
}

const structureCache = new Map<string, CacheEntry>();

export function clearRepoStructureCache(): void {
  structureCache.clear();
}

async function readJsonSafe(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function scanRepoStructureSummary(rootRepoPath: string): Promise<string> {
  const absRoot = resolve(rootRepoPath);
  const now = Date.now();
  const cached = structureCache.get(absRoot);
  if (cached && cached.expiresAt > now) {
    return cached.summary;
  }

  if (!existsSync(absRoot)) {
    return "";
  }

  const lines: string[] = [];
  const rootPkg = await readJsonSafe(join(absRoot, "package.json"));
  const rootPkgName = typeof rootPkg?.name === "string" ? ` (${rootPkg.name})` : "";
  lines.push(`Root: ${absRoot}${rootPkgName}`);

  if (rootPkg?.workspaces) {
    const wsDesc = Array.isArray(rootPkg.workspaces)
      ? rootPkg.workspaces.join(", ")
      : JSON.stringify(rootPkg.workspaces);
    lines.push(`Workspaces: ${wsDesc}`);
  }

  const rootEntries = await readdir(absRoot, { withFileTypes: true }).catch(() => []);
  const rootFiles = rootEntries
    .filter((e) => e.isFile() && !e.name.startsWith(".DS_Store"))
    .map((e) => e.name)
    .sort()
    .slice(0, 20);
  if (rootFiles.length > 0) {
    lines.push(`Root files: ${rootFiles.join(", ")}`);
  }

  const topDirs = rootEntries
    .filter((e) => e.isDirectory() && !IGNORED_DIRS.has(e.name) && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort()
    .slice(0, 25);

  if (topDirs.length > 0) {
    lines.push("Modules & directories:");
    for (const topDir of topDirs) {
      const topPath = join(absRoot, topDir);
      const subEntries = await readdir(topPath, { withFileTypes: true }).catch(() => []);
      const subDirs = subEntries
        .filter((e) => e.isDirectory() && !IGNORED_DIRS.has(e.name) && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort()
        .slice(0, 15);
      const subFiles = subEntries
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .sort()
        .slice(0, 8);

      if (topDir === "packages" || topDir === "apps" || topDir === "services") {
        if (subDirs.length === 0) {
          lines.push(`- ${topDir}/`);
        }
        for (const sub of subDirs) {
          const pkgDir = join(topPath, sub);
          const subPkg = await readJsonSafe(join(pkgDir, "package.json"));
          const pkgLabel = typeof subPkg?.name === "string" ? ` (${subPkg.name})` : "";
          const srcDir = join(pkgDir, "src");
          let srcPreview = "";
          if (existsSync(srcDir)) {
            const srcEntries = await readdir(srcDir, { withFileTypes: true }).catch(() => []);
            const srcNames = srcEntries
              .filter((e) => !IGNORED_DIRS.has(e.name))
              .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
              .sort()
              .slice(0, 10);
            if (srcNames.length > 0) {
              srcPreview = ` -> src: [${srcNames.join(", ")}]`;
            }
          }
          lines.push(`- ${topDir}/${sub}${pkgLabel}${srcPreview}`);
        }
      } else {
        const preview = [
          ...subDirs.map((d) => `${d}/`),
          ...(subDirs.length < 6 ? subFiles : []),
        ].slice(0, 12);
        lines.push(`- ${topDir}/${preview.length > 0 ? ` [${preview.join(", ")}]` : ""}`);
      }
    }
  }

  let summary = lines.join("\n");
  if (summary.length > MAX_SUMMARY_CHARS) {
    summary = `${summary.slice(0, MAX_SUMMARY_CHARS - 16)}\n...(truncated)`;
  }

  structureCache.set(absRoot, {
    summary,
    expiresAt: now + CACHE_TTL_MS,
  });
  return summary;
}
