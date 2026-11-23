import { createDefaultMandate, mandateScopesOverlap, normalizeScopePattern } from "./mandate.ts";
import { inferScopePathsFromFiles } from "./playbook.ts";
import type { CasebookEntry, HandoverDigest, Ticket } from "./types.ts";
import { newId, nowIso } from "./utils.ts";

function tokenize(text: string): Set<string> {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}_./-]{3,}/gu) ?? [];
  return new Set(matches);
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

export function buildCasebookEntryFromTicket(input: {
  ticket: Ticket;
  digest?: HandoverDigest;
  priorCase?: CasebookEntry | null;
}): CasebookEntry {
  const { ticket, digest, priorCase } = input;
  const ts = nowIso();

  const changedFiles = Array.from(
    new Set([
      ...(digest?.changedFiles ?? []),
      ...ticket.inlineMemory.stageNotes.flatMap((n) => n.changedFiles),
    ]),
  ).slice(0, 20);

  const scopePaths = inferScopePathsFromFiles(changedFiles, ticket.mandate.allowedPaths);
  const exportedSymbols = (digest?.exportedSymbols ?? []).slice(0, 20);

  const failedNotes = ticket.inlineMemory.stageNotes
    .filter((n) => !n.verificationPassed || n.reviewApproved === false)
    .map((n) => `[${n.stage}] ${n.summary.slice(0, 140)}`);

  const pitfallsAndFixes =
    failedNotes.length > 0
      ? failedNotes.slice(-2).join(" | ").slice(0, 320)
      : undefined;

  const latestImplSummary =
    digest?.summary ||
    [...ticket.inlineMemory.stageNotes]
      .reverse()
      .find((n) => n.verificationPassed && (n.stage === "implement" || n.stage === "rebase"))
      ?.summary ||
    ticket.inlineMemory.stageNotes.at(-1)?.summary ||
    ticket.title;

  return {
    id: priorCase?.id ?? newId("cas"),
    repoId: ticket.repoId,
    ticketId: ticket.id,
    title: ticket.title.slice(0, 160),
    goalSummary: (ticket.inlineMemory.goal || ticket.description || ticket.title).slice(0, 260),
    solutionSummary: latestImplSummary.slice(0, 340),
    pitfallsAndFixes,
    changedFiles,
    scopePaths,
    exportedSymbols,
    reverted: Boolean(ticket.revertedAt),
    hitCount: priorCase?.hitCount ?? 0,
    lastMatchedAt: priorCase?.lastMatchedAt,
    createdAt: priorCase?.createdAt ?? ts,
    updatedAt: ts,
  };
}

export function selectRelevantCasesForContext(input: {
  cases: CasebookEntry[];
  ftsTicketIds?: Set<string>;
  targetPaths: string[];
  queryText: string;
  maxPositive?: number;
  maxChars?: number;
  nowMs?: number;
}): {
  positiveCases: CasebookEntry[];
  revertedWarnings: CasebookEntry[];
  formattedMarkdown: string;
} {
  const maxPositive = input.maxPositive ?? 2;
  const maxChars = input.maxChars ?? 900;
  const nowMs = input.nowMs ?? Date.now();
  const queryTokens = tokenize(input.queryText);
  const targetMandate = createDefaultMandate({
    allowedPaths: input.targetPaths.length > 0 ? input.targetPaths : ["**"],
  });
  const targetWildcard = isWildcardScope(input.targetPaths);

  const positiveScored: Array<{ entry: CasebookEntry; score: number }> = [];
  const revertedScored: Array<{ entry: CasebookEntry; score: number }> = [];

  for (const c of input.cases) {
    const caseWildcard = isWildcardScope(c.scopePaths);
    const caseMandate = createDefaultMandate({ allowedPaths: c.scopePaths });
    const overlaps = mandateScopesOverlap(caseMandate, targetMandate);
    const nonWildcardOverlap = !caseWildcard && !targetWildcard && overlaps;

    let score = 0;
    if (nonWildcardOverlap) {
      score += 5;
    } else if (overlaps) {
      score += 1;
    }

    if (input.ftsTicketIds?.has(c.ticketId)) {
      score += 3;
    }

    const caseTokens = tokenize(
      `${c.title} ${c.goalSummary} ${c.exportedSymbols.join(" ")} ${c.changedFiles.join(" ")}`,
    );
    let overlapTokens = 0;
    for (const tok of queryTokens) {
      if (caseTokens.has(tok)) overlapTokens += 1;
    }
    if (overlapTokens > 0) {
      score += Math.min(4, overlapTokens);
    }

    const updatedMs = Date.parse(c.updatedAt);
    if (Number.isFinite(updatedMs)) {
      const ageDays = Math.max(0, (nowMs - updatedMs) / (1000 * 60 * 60 * 24));
      if (ageDays <= 14) score += 2;
      else if (ageDays <= 45) score += 1;
    }

    if (c.reverted) {
      // Only surface reverted warnings when non-wildcard paths overlap or query directly matches
      if (nonWildcardOverlap || overlapTokens >= 2) {
        revertedScored.push({ entry: c, score });
      }
    } else if (score >= 2) {
      positiveScored.push({ entry: c, score });
    }
  }

  positiveScored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return b.entry.updatedAt.localeCompare(a.entry.updatedAt);
  });
  revertedScored.sort((a, b) => b.score - a.score);

  const positiveCases: CasebookEntry[] = [];
  const revertedWarnings = revertedScored.slice(0, 1).map((r) => r.entry);
  const lines: string[] = [];
  let charCount = 0;

  for (const { entry } of positiveScored) {
    if (positiveCases.length >= maxPositive) break;
    const filesPart =
      entry.changedFiles.length > 0 ? `Files: ${entry.changedFiles.slice(0, 3).join(", ")}` : "";
    const pitfallPart = entry.pitfallsAndFixes ? ` | Avoid pitfall: ${entry.pitfallsAndFixes.slice(0, 120)}` : "";
    const bullet = `- [Case ${entry.ticketId} · ${entry.scopePaths.slice(0, 2).join(", ")}] ${entry.title}: ${entry.solutionSummary.slice(0, 150)}${filesPart ? ` (${filesPart})` : ""}${pitfallPart}`;
    if (lines.length > 0 && charCount + bullet.length + 1 > maxChars) {
      continue;
    }
    positiveCases.push(entry);
    lines.push(bullet);
    charCount += bullet.length + 1;
  }

  for (const warn of revertedWarnings) {
    const warnLine = `- [REVERTED PITFALL WARNING · ${warn.ticketId}] "${warn.title}" was reverted after merge (${warn.scopePaths.slice(0, 2).join(", ")}). Do NOT repeat naive changes in: ${warn.changedFiles.slice(0, 3).join(", ")}.`;
    if (lines.length === 0 || charCount + warnLine.length + 1 <= maxChars) {
      lines.push(warnLine);
      charCount += warnLine.length + 1;
    }
  }

  return {
    positiveCases,
    revertedWarnings,
    formattedMarkdown: lines.join("\n"),
  };
}
