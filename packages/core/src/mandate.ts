import type { Mandate } from "./types.ts";
import { normalizeRelPath } from "./utils.ts";

export const DEFAULT_FORBIDDEN_PATHS: readonly string[] = [
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
];

const GLOB_META_RE = /[*?[{]/;

export function createDefaultMandate(overrides?: Partial<Mandate>): Mandate {
  const forbidden = new Set<string>([
    ...DEFAULT_FORBIDDEN_PATHS,
    ...(overrides?.forbiddenPaths ?? []),
  ]);
  return {
    allowedPaths: (overrides?.allowedPaths ?? ["**"]).map(normalizeScopePattern).filter(Boolean),
    forbiddenPaths: Array.from(forbidden).map(normalizeScopePattern).filter(Boolean),
    allowNetwork: overrides?.allowNetwork ?? false,
    allowExternalSideEffects: false,
    maxCostUsd: overrides?.maxCostUsd ?? 2.0,
    maxDurationSec: overrides?.maxDurationSec ?? 600,
    maxStageRetries: overrides?.maxStageRetries ?? 2,
  };
}

export function normalizeScopePattern(pattern: string): string {
  const cleaned = normalizeRelPath(pattern);
  if (!cleaned || cleaned === ".") {
    return "**";
  }
  return cleaned;
}

function expandScopePatterns(pattern: string): string[] {
  const norm = normalizeScopePattern(pattern);
  if (!GLOB_META_RE.test(norm)) {
    return [norm, `${norm}/**`];
  }
  return [norm];
}

export function matchesPathScope(filePath: string, patterns: string[]): boolean {
  const normalizedFile = normalizeRelPath(filePath);
  if (!normalizedFile) return false;

  for (const rawPattern of patterns) {
    const candidates = expandScopePatterns(rawPattern);
    for (const pat of candidates) {
      if (pat === "**") return true;
      const glob = new Bun.Glob(pat);
      if (glob.match(normalizedFile)) {
        return true;
      }
    }
  }
  return false;
}

export interface MandateValidationResult {
  ok: boolean;
  violations: string[];
  forbiddenViolations: string[];
  scopeViolations: string[];
}

export function validateChangedFilesAgainstMandate(
  changedFiles: string[],
  mandate: Mandate,
): MandateValidationResult {
  const forbidden = Array.from(new Set([...DEFAULT_FORBIDDEN_PATHS, ...mandate.forbiddenPaths]));
  const allowed = mandate.allowedPaths.length > 0 ? mandate.allowedPaths : ["**"];
  const violations: string[] = [];
  const forbiddenViolations: string[] = [];
  const scopeViolations: string[] = [];

  for (const file of changedFiles) {
    const rel = normalizeRelPath(file);
    if (!rel) continue;
    if (matchesPathScope(rel, forbidden)) {
      violations.push(rel);
      forbiddenViolations.push(rel);
      continue;
    }
    if (!matchesPathScope(rel, allowed)) {
      violations.push(rel);
      scopeViolations.push(rel);
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    forbiddenViolations,
    scopeViolations,
  };
}

function staticPrefixSegments(pattern: string): { segments: string[]; hasGlob: boolean } {
  const norm = normalizeScopePattern(pattern);
  const parts = norm.split("/");
  const staticSegs: string[] = [];
  for (const part of parts) {
    if (GLOB_META_RE.test(part)) {
      return { segments: staticSegs, hasGlob: true };
    }
    staticSegs.push(part);
  }
  return { segments: staticSegs, hasGlob: false };
}

function segmentsAreNested(a: string[], b: string[]): boolean {
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function singlePatternOverlaps(rawA: string, rawB: string): boolean {
  const a = normalizeScopePattern(rawA);
  const b = normalizeScopePattern(rawB);
  if (a === "**" || b === "**" || a === "*" || b === "*") {
    return true;
  }

  const parsedA = staticPrefixSegments(a);
  const parsedB = staticPrefixSegments(b);

  if (parsedA.segments.length === 0 || parsedB.segments.length === 0) {
    return true;
  }

  // Exact or directory-prefix check when static prefixes differ at some shared index
  if (!segmentsAreNested(parsedA.segments, parsedB.segments)) {
    return false;
  }

  // If neither has globs, segmentsAreNested already means equal file or parent/child directory
  if (!parsedA.hasGlob && !parsedB.hasGlob) {
    return true;
  }

  // If one has no glob, verify against the glob pattern or directory containment
  if (!parsedA.hasGlob && parsedB.hasGlob) {
    if (matchesPathScope(a, [b])) return true;
    // Also check if `a` is a parent directory containing `b` (e.g. `packages/core` vs `packages/core/*.ts`)
    return parsedB.segments.length >= parsedA.segments.length;
  }
  if (parsedA.hasGlob && !parsedB.hasGlob) {
    if (matchesPathScope(b, [a])) return true;
    return parsedA.segments.length >= parsedB.segments.length;
  }

  // Both have globs and nested static prefixes.
  // Check a narrow case where `packages/*.ts` (no `**`, prefix=["packages"], 2 segs)
  // vs `packages/core/**` (prefix=["packages","core"]): `packages/*.ts` only matches depth 2!
  const aHasDoubleStar = a.includes("**");
  const bHasDoubleStar = b.includes("**");
  if (!aHasDoubleStar && parsedA.segments.length < parsedB.segments.length) {
    const aSegCount = a.split("/").length;
    if (aSegCount <= parsedB.segments.length && !a.split("/").slice(0, parsedB.segments.length).every((s, idx) => {
      if (idx < parsedA.segments.length) return s === parsedB.segments[idx];
      return GLOB_META_RE.test(s) ? new Bun.Glob(s).match(parsedB.segments[idx]!) : s === parsedB.segments[idx];
    })) {
      return false;
    }
    if (aSegCount < parsedB.segments.length) return false;
  }
  if (!bHasDoubleStar && parsedB.segments.length < parsedA.segments.length) {
    const bSegCount = b.split("/").length;
    if (bSegCount < parsedA.segments.length) return false;
  }

  return true;
}

export function mandateScopesOverlap(a: Mandate, b: Mandate): boolean {
  const pathsA = a.allowedPaths.length > 0 ? a.allowedPaths : ["**"];
  const pathsB = b.allowedPaths.length > 0 ? b.allowedPaths : ["**"];

  for (const pa of pathsA) {
    for (const pb of pathsB) {
      if (singlePatternOverlaps(pa, pb)) {
        return true;
      }
    }
  }
  return false;
}
