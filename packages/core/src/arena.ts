import type { ArenaCandidateResult, RepoConfig, WorkerEngineId } from "./types.ts";

export function countDiffLines(diffText: string): { addedLines: number; deletedLines: number } {
  if (!diffText) return { addedLines: 0, deletedLines: 0 };
  let addedLines = 0;
  let deletedLines = 0;
  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) {
      addedLines += 1;
    } else if (line.startsWith("-")) {
      deletedLines += 1;
    }
  }
  return { addedLines, deletedLines };
}

export function resolveFallbackChain(input: {
  primaryEngine: WorkerEngineId;
  repo: RepoConfig;
  availableEngines: WorkerEngineId[];
  failedEngines?: WorkerEngineId[];
  trippedEngines?: WorkerEngineId[];
}): WorkerEngineId[] {
  const tripped = new Set<WorkerEngineId>(input.trippedEngines ?? []);
  const failed = new Set<WorkerEngineId>([
    input.primaryEngine,
    ...(input.failedEngines ?? []),
  ]);
  const explicit = input.repo.fallbackEngines ?? [];
  const allowMock =
    input.primaryEngine === "mock" || explicit.includes("mock");

  const available = input.availableEngines.filter(
    (e) => (allowMock ? true : e !== "mock") && (e === "mock" || !tripped.has(e)),
  );

  const ordered: WorkerEngineId[] = [];
  for (const candidate of explicit) {
    if (!failed.has(candidate) && available.includes(candidate) && !ordered.includes(candidate)) {
      ordered.push(candidate);
    }
  }

  const defaultOrder: WorkerEngineId[] =
    input.primaryEngine === "claude"
      ? ["codex", "gemini", "opencode", "mock"]
      : input.primaryEngine === "codex"
        ? ["claude", "gemini", "opencode", "mock"]
        : input.primaryEngine === "gemini"
          ? ["claude", "codex", "opencode", "mock"]
          : input.primaryEngine === "opencode"
            ? ["claude", "codex", "gemini", "mock"]
            : ["claude", "codex", "gemini", "opencode"];

  for (const candidate of defaultOrder) {
    if (!failed.has(candidate) && available.includes(candidate) && !ordered.includes(candidate)) {
      ordered.push(candidate);
    }
  }

  for (const candidate of available) {
    if (!failed.has(candidate) && !ordered.includes(candidate)) {
      ordered.push(candidate);
    }
  }

  return ordered;
}

export function pickNextFallbackEngine(input: {
  currentEngine: WorkerEngineId;
  failedEngines?: WorkerEngineId[];
  repo: RepoConfig;
  availableEngines: WorkerEngineId[];
  trippedEngines?: WorkerEngineId[];
}): WorkerEngineId | undefined {
  const chain = (trippedEngines?: WorkerEngineId[]) =>
    resolveFallbackChain({
      primaryEngine: input.currentEngine,
      repo: input.repo,
      availableEngines: input.availableEngines,
      failedEngines: input.failedEngines,
      trippedEngines,
    })[0];
  // Prefer healthy engines; if every candidate is tripped, fall back to the unfiltered chain.
  return chain(input.trippedEngines) ?? chain(undefined);
}

export type UnscoredArenaCandidate = Omit<ArenaCandidateResult, "score" | "recommended">;

export function computeSingleArenaScore(
  cand: UnscoredArenaCandidate,
  peer?: UnscoredArenaCandidate,
): number {
  let score = 0;

  if (cand.verificationPassed) {
    score += 60;
  }

  if (cand.changedFiles.length > 0 || cand.addedLines > 0 || cand.deletedLines > 0) {
    score += 15;
  }

  // Diff conciseness up to 15 points (prefer minimal clean patch among passing runs)
  const totalChurn = cand.addedLines + cand.deletedLines;
  const peerChurn = peer ? peer.addedLines + peer.deletedLines : totalChurn;
  if (totalChurn === 0 && cand.changedFiles.length === 0) {
    score += 0;
  } else if (!peer || totalChurn <= peerChurn) {
    score += 15;
  } else {
    const ratio = peerChurn / Math.max(1, totalChurn);
    score += Math.round(Math.max(4, Math.min(14, ratio * 15)));
  }

  // Cost & speed efficiency up to 10 points
  const peerCost = peer && peer.costUsd > 0 ? peer.costUsd : Math.max(cand.costUsd, 0.01);
  const costRatio = cand.costUsd <= 0 ? 1 : Math.min(1, peerCost / Math.max(cand.costUsd, 0.001));
  const peerDuration = peer && peer.durationMs > 0 ? peer.durationMs : Math.max(cand.durationMs, 1);
  const durRatio =
    cand.durationMs <= 0 ? 1 : Math.min(1, peerDuration / Math.max(cand.durationMs, 1));
  score += Math.round(costRatio * 5 + durRatio * 5);

  return Math.max(0, Math.min(100, score));
}

export function scoreArenaCandidates(
  candA: UnscoredArenaCandidate,
  candB: UnscoredArenaCandidate,
): [ArenaCandidateResult, ArenaCandidateResult] {
  const scoreA = computeSingleArenaScore(candA, candB);
  const scoreB = computeSingleArenaScore(candB, candA);

  let winnerIsA = true;
  if (candA.verificationPassed !== candB.verificationPassed) {
    winnerIsA = candA.verificationPassed;
  } else if (scoreA !== scoreB) {
    winnerIsA = scoreA > scoreB;
  } else if (candA.costUsd !== candB.costUsd) {
    winnerIsA = candA.costUsd <= candB.costUsd;
  }

  const rationaleA =
    candA.rationale ??
    (candA.verificationPassed
      ? `Verification passed (+60), ${candA.changedFiles.length} file(s), +${candA.addedLines}/-${candA.deletedLines} lines, $${candA.costUsd.toFixed(3)}`
      : `Verification failed: ${candA.verificationSummary}`);
  const rationaleB =
    candB.rationale ??
    (candB.verificationPassed
      ? `Verification passed (+60), ${candB.changedFiles.length} file(s), +${candB.addedLines}/-${candB.deletedLines} lines, $${candB.costUsd.toFixed(3)}`
      : `Verification failed: ${candB.verificationSummary}`);

  return [
    {
      ...candA,
      score: scoreA,
      recommended: winnerIsA,
      rationale: rationaleA,
    },
    {
      ...candB,
      score: scoreB,
      recommended: !winnerIsA,
      rationale: rationaleB,
    },
  ];
}
