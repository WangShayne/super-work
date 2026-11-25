import type { PlaybookEntry } from "./types.ts";

export interface PlaybookHygieneResult {
  clean: boolean;
  reasons: string[];
  severity: "ok" | "noise";
}

export interface PlaybookHygieneReport {
  repoId?: string;
  total: number;
  healthy: number;
  noisyCount: number;
  noisyEntries: Array<{
    id: string;
    rule: string;
    source: PlaybookEntry["source"];
    hitCount: number;
    enabled: boolean;
    reasons: string[];
  }>;
}

const NOISE_PATTERNS: ReadonlyArray<{ re: RegExp; reason: string }> = [
  { re: /human approved continuation/i, reason: "one-off continuation approval" },
  { re: /approve\s+local_merge/i, reason: "one-off delivery approval (local_merge)" },
  { re: /keep this review fast/i, reason: "run-specific review instruction" },
  { re: /already verified/i, reason: "run-specific status report (already verified)" },
  { re: /already passing in your worktree/i, reason: "run-specific status report (worktree)" },
  { re: /preserved in your worktree/i, reason: "run-specific status report (worktree)" },
  { re: /reviewed \d+-file/i, reason: "run-specific review summary" },
  { re: /\b(?:tkt|mst|inb|obx|epc)_[a-z0-9]+\b/i, reason: "references a specific ticket/entity id" },
];

const BOOT_CANARY_TAIL_RE = /and boot canary\.?$/i;
const APPROVAL_WORD_RE = /\bapprov(?:e|ed|al)\b|\blgtm\b/i;
const STATUS_WORD_RE = /\b(?:passing|passed|verified|reviewed|done|finished|preserved)\b/i;
// Reusable engineering constraints carry an imperative/constraint verb.
const CONSTRAINT_RE =
  /\b(?:must|never|always|avoid|ensure|should|do not|don't|require[sd]?|prefer|forbid|only|keep every)\b/i;
const SHORT_NOTE_MAX_LEN = 140;

const CLEAN: PlaybookHygieneResult = { clean: true, reasons: [], severity: "ok" };

export function evaluatePlaybookRuleHygiene(
  rule: string,
  source?: PlaybookEntry["source"],
  options?: { pinned?: boolean },
): PlaybookHygieneResult {
  if (source === "repo_contract" || options?.pinned === true) {
    return { ...CLEAN, reasons: [] };
  }
  const text = (rule ?? "").trim();
  const reasons: string[] = [];
  for (const p of NOISE_PATTERNS) {
    if (p.re.test(text)) reasons.push(p.reason);
  }
  if (BOOT_CANARY_TAIL_RE.test(text) && APPROVAL_WORD_RE.test(text)) {
    reasons.push("one-off approval note (boot canary)");
  }
  if (
    reasons.length === 0 &&
    text.length > 0 &&
    text.length <= SHORT_NOTE_MAX_LEN &&
    APPROVAL_WORD_RE.test(text) &&
    STATUS_WORD_RE.test(text) &&
    !CONSTRAINT_RE.test(text)
  ) {
    reasons.push("short status-report approval note, not a reusable constraint");
  }
  if (reasons.length === 0) return { ...CLEAN, reasons: [] };
  return { clean: false, reasons, severity: "noise" };
}

export function auditPlaybookEntries(
  entries: PlaybookEntry[],
  repoId?: string,
): PlaybookHygieneReport {
  const noisyEntries: PlaybookHygieneReport["noisyEntries"] = [];
  for (const entry of entries) {
    const res = evaluatePlaybookRuleHygiene(entry.rule, entry.source, { pinned: entry.pinned });
    if (!res.clean) {
      noisyEntries.push({
        id: entry.id,
        rule: entry.rule,
        source: entry.source,
        hitCount: entry.hitCount ?? 0,
        enabled: entry.enabled,
        reasons: res.reasons,
      });
    }
  }
  return {
    ...(repoId !== undefined ? { repoId } : {}),
    total: entries.length,
    healthy: entries.length - noisyEntries.length,
    noisyCount: noisyEntries.length,
    noisyEntries,
  };
}
