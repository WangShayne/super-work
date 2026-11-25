import type { EngineHealthFailureKind, EngineHealthRecord } from "./types.ts";

export const DEFAULT_ENGINE_COOLDOWN_MS = 30 * 60_000;
/** Cooldown for transient failures (rate limits, timeouts). */
export const TRANSIENT_ENGINE_COOLDOWN_MS = 15 * 60_000;
/** Cooldown for persistent account/model failures that will not self-heal quickly. */
export const PERSISTENT_ENGINE_COOLDOWN_MS = 24 * 60 * 60_000;

export function isPersistentEngineFailure(kind?: EngineHealthFailureKind): boolean {
  return (
    kind === "model_unsupported" ||
    kind === "tier_ineligible" ||
    kind === "auth_invalid" ||
    kind === "quota_exhausted"
  );
}

export function getCooldownMsForFailureKind(kind?: EngineHealthFailureKind): number {
  return isPersistentEngineFailure(kind) ? PERSISTENT_ENGINE_COOLDOWN_MS : TRANSIENT_ENGINE_COOLDOWN_MS;
}

const DETERMINISTIC_RULES: ReadonlyArray<{ kind: EngineHealthFailureKind; re: RegExp }> = [
  { kind: "model_unsupported", re: /model (is )?not supported|unsupported model|model_not_found/i },
  { kind: "tier_ineligible", re: /IneligibleTierError|ineligible tier|not eligible for/i },
  { kind: "auth_invalid", re: /invalid_api_key|invalid api key|unauthorized|not authenticated|authentication (failed|required)|\b401\b/i },
  { kind: "quota_exhausted", re: /quota (exceeded|exhausted)|exceeded your (current )?quota|billing|insufficient_quota|credit balance|free usage limit|subscribe to opencode/i },
];

const TRANSIENT_RE =
  /timed? ?out|timeout|econnreset|econnrefused|enotfound|etimedout|network|socket hang up|rate.?limit|\b429\b|\b50[0-4]\b|overloaded|temporar/i;

/** Classifies a worker error message. Returns null when nothing is recognised. */
export function classifyEngineError(
  message: string,
): { kind: EngineHealthFailureKind; deterministic: boolean } | null {
  if (!message) return null;
  for (const rule of DETERMINISTIC_RULES) {
    if (rule.re.test(message)) return { kind: rule.kind, deterministic: true };
  }
  if (TRANSIENT_RE.test(message)) return { kind: "transient", deterministic: false };
  return null;
}

export function isEngineTripped(
  record: EngineHealthRecord | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!record || record.status !== "tripped" || !record.cooldownUntil) return false;
  const until = Date.parse(record.cooldownUntil);
  return Number.isFinite(until) && until > nowMs;
}
