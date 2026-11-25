import type { LiveEventLogEntry, ScopedVerificationInfo, VerificationRunResult } from "../../types.ts";

/**
 * Reads the scoped-gate record of a stage run from the live SSE trail
 * (`verification_completed` carries `{ stageRunId, result }`). Newest event wins.
 */
export function scopedVerificationForRun(
  events: LiveEventLogEntry[],
  stageRunId: string,
): ScopedVerificationInfo | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!ev || ev.kind !== "verification_completed") continue;
    const raw = ev.raw as { stageRunId?: string; result?: VerificationRunResult } | undefined;
    if (raw?.stageRunId === stageRunId) return raw.result?.scopedVerification;
  }
  return undefined;
}
