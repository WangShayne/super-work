import type { MergeTrainEntryStatus, TicketStatus } from "./types.ts";

export interface SpeculativePrefixEvaluation {
  passingPrefixCount: number;
  culpritIndex: number | null;
  requeueIndices: number[];
}

/**
 * Computes the maximal contiguous passing prefix in a speculative merge stack
 * (`S1`, `S2 = S1+T2`, `S3 = S2+T3`). When slot `k` (`0`-based) is the first
 * failing slot, commits `0..k-1` are clean and fast-forwardable; slot `k` is
 * isolated as the culprit to eject, and slots `k+1..end` must be re-queued
 * onto the new base.
 */
export function evaluateSpeculativePrefix(
  slotResults: Array<{ passed: boolean; errorSummary?: string }>,
): SpeculativePrefixEvaluation {
  let passingPrefixCount = 0;
  for (let i = 0; i < slotResults.length; i++) {
    if (!slotResults[i]!.passed) {
      const requeueIndices: number[] = [];
      for (let j = i + 1; j < slotResults.length; j++) {
        requeueIndices.push(j);
      }
      return {
        passingPrefixCount,
        culpritIndex: i,
        requeueIndices,
      };
    }
    passingPrefixCount += 1;
  }

  return {
    passingPrefixCount,
    culpritIndex: null,
    requeueIndices: [],
  };
}

export function evaluateBarrierGroupState(
  siblings: Array<{
    ticketId: string;
    ticketStatus: TicketStatus;
    trainStatus?: MergeTrainEntryStatus;
  }>,
): "all_ready" | "waiting" | "blocked" {
  if (siblings.length === 0) return "all_ready";

  for (const sib of siblings) {
    if (
      sib.ticketStatus === "failed" ||
      sib.ticketStatus === "cancelled" ||
      sib.ticketStatus === "needs_human" ||
      sib.trainStatus === "ejected" ||
      sib.trainStatus === "barrier_blocked"
    ) {
      return "blocked";
    }
  }

  const allReady = siblings.every(
    (sib) =>
      sib.ticketStatus === "delivered" ||
      sib.trainStatus === "barrier_waiting" ||
      sib.trainStatus === "queued" ||
      sib.trainStatus === "merged",
  );
  return allReady ? "all_ready" : "waiting";
}
