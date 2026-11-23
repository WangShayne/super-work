import { createDefaultMandate, mandateScopesOverlap, normalizeScopePattern } from "./mandate.ts";
import type { PlaybookEntry, SharedPlaybookRuleSpec } from "./types.ts";

export function normalizePlaybookRuleText(rule: string): string {
  const collapsed = rule
    .trim()
    .replace(/^[-*•\d.)\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (collapsed.length <= 240) {
    return collapsed;
  }
  return `${collapsed.slice(0, 237)}...`;
}

export function playbookDedupeKey(rule: string): string {
  return normalizePlaybookRuleText(rule)
    .toLowerCase()
    .replace(/[`'".,:;!?()[\]{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isWildcardScope(scopePaths: string[]): boolean {
  return (
    scopePaths.length === 0 ||
    scopePaths.some((p) => {
      const norm = normalizeScopePattern(p);
      return norm === "**" || norm === "*";
    })
  );
}

function scopeSpecificityScore(entry: PlaybookEntry, targetPaths: string[]): {
  matches: boolean;
  score: number;
} {
  const entryWildcard = isWildcardScope(entry.scopePaths);
  const targetWildcard = isWildcardScope(targetPaths);

  if (targetWildcard) {
    return {
      matches: true,
      score: entryWildcard ? 1 : 2,
    };
  }

  if (entryWildcard) {
    return { matches: true, score: 1 };
  }

  const entryMandate = createDefaultMandate({ allowedPaths: entry.scopePaths });
  const targetMandate = createDefaultMandate({ allowedPaths: targetPaths });
  const overlaps = mandateScopesOverlap(entryMandate, targetMandate);

  if (overlaps) {
    return { matches: true, score: 4 };
  }

  // Pinned rules always remain eligible even when scope is disjoint
  return { matches: entry.pinned, score: entry.pinned ? 0 : -1 };
}

export function selectPlaybookRulesForContext(
  entries: PlaybookEntry[],
  targetPaths: string[],
  maxItems = 8,
  maxChars = 1200,
): PlaybookEntry[] {
  const enabled = entries.filter((e) => e.enabled && e.rule.trim().length > 0);
  const scored: Array<{ entry: PlaybookEntry; specScore: number; sourceWeight: number }> = [];

  for (const entry of enabled) {
    const spec = scopeSpecificityScore(entry, targetPaths);
    if (!spec.matches) continue;
    const sourceWeight =
      entry.source === "human" ? 3 : entry.source === "repo_contract" ? 2 : 1;
    scored.push({ entry, specScore: spec.score, sourceWeight });
  }

  scored.sort((a, b) => {
    if (a.entry.pinned !== b.entry.pinned) return a.entry.pinned ? -1 : 1;
    if (a.specScore !== b.specScore) return b.specScore - a.specScore;
    if (a.sourceWeight !== b.sourceWeight) return b.sourceWeight - a.sourceWeight;
    return b.entry.updatedAt.localeCompare(a.entry.updatedAt);
  });

  const selected: PlaybookEntry[] = [];
  let charCount = 0;

  for (const { entry } of scored) {
    if (selected.length >= maxItems) break;
    const formatted = formatSinglePlaybookBullet(entry);
    if (selected.length > 0 && charCount + formatted.length + 1 > maxChars) {
      continue;
    }
    if (charCount + formatted.length > maxChars) {
      // Truncate first line slightly if it alone exceeds maxChars
      if (selected.length === 0 && maxChars > 24) {
        selected.push({
          ...entry,
          rule: `${entry.rule.slice(0, Math.max(12, maxChars - 36))}...`,
        });
      }
      break;
    }
    selected.push(entry);
    charCount += formatted.length + 1;
  }

  return selected;
}

function formatSinglePlaybookBullet(entry: PlaybookEntry): string {
  const scopeLabel =
    entry.scopePaths.length > 0 ? `[${entry.scopePaths.slice(0, 3).join(", ")}]` : "[**]";
  const pinLabel = entry.pinned ? "[PIN] " : "";
  return `- ${pinLabel}${scopeLabel} ${normalizePlaybookRuleText(entry.rule)}`;
}

export function formatPlaybookContext(
  entries: PlaybookEntry[],
  targetPaths: string[],
  maxItems = 8,
  maxChars = 1200,
): string {
  const selected = selectPlaybookRulesForContext(entries, targetPaths, maxItems, maxChars);
  if (selected.length === 0) return "";
  return selected.map(formatSinglePlaybookBullet).join("\n");
}

export function inferScopePathsFromFiles(
  changedFiles: string[],
  fallbackAllowedPaths: string[],
): string[] {
  const cleanFiles = changedFiles.map((f) => f.replace(/^\.\//, "").trim()).filter(Boolean);
  if (cleanFiles.length === 0) {
    return fallbackAllowedPaths.length > 0 ? fallbackAllowedPaths : ["**"];
  }
  const scopes = new Set<string>();
  for (const file of cleanFiles) {
    const parts = file.split("/");
    if (parts.length >= 2) {
      // packages/<pkg> or src/<dir>
      const prefix = parts[0] === "packages" && parts.length >= 3
        ? `${parts[0]}/${parts[1]}/**`
        : `${parts[0]}/**`;
      scopes.add(prefix);
    } else {
      scopes.add(file);
    }
  }
  return Array.from(scopes).slice(0, 4);
}

export function heuristicDistillPlaybookLesson(input: {
  failureKind: "verification" | "smoke" | "review";
  failureSummary: string;
  fixSummary: string;
  changedFiles: string[];
  allowedPaths: string[];
}): { rule: string; scopePaths: string[] } {
  const scopePaths = inferScopePathsFromFiles(input.changedFiles, input.allowedPaths);
  const cleanFailure = input.failureSummary
    .replace(/\s+/g, " ")
    .replace(/VERDICT:\s*REJECTED\s*-?\s*/i, "")
    .trim()
    .slice(0, 120);
  const prefix =
    input.failureKind === "smoke"
      ? "Prevent runtime startup/smoke failure"
      : input.failureKind === "verification"
        ? "Verify and guard against check failure"
        : "Prevent code-review issue";
  const rule = normalizePlaybookRuleText(
    `${prefix} (${cleanFailure || "check prior failure mode"}); apply fix pattern: ${input.fixSummary.slice(0, 90)}`,
  );
  return { rule, scopePaths };
}

export function distillHumanNoteToRule(note?: string): string | null {
  if (!note) return null;
  const normalized = normalizePlaybookRuleText(note);
  if (normalized.length < 6) return null;
  return normalized;
}

export function contractRuleDeterministicId(repoId: string, spec: SharedPlaybookRuleSpec): string {
  if (spec.id?.trim()) {
    return spec.id.trim();
  }
  const hash = new Bun.CryptoHasher("sha256")
    .update(`${repoId}:${playbookDedupeKey(spec.rule)}`)
    .digest("hex")
    .slice(0, 10);
  return `pbk_ctr_${hash}`;
}
