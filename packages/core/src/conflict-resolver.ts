import type { ConflictSemanticContext, Ticket } from "./types.ts";

export function buildConflictResolutionPrompt(
  ticket: Ticket,
  ctx: ConflictSemanticContext,
): string {
  const sections: string[] = [
    `## 3-Way Semantic Rebase Conflict Resolution`,
    `Ticket \`${ticket.id}\`: ${ticket.title}`,
    `Your branch changes conflicted while rebasing onto updated \`${ctx.baseBranch}\` (merge-base \`${ctx.mergeBaseSha.slice(0, 8)}\`).`,
    `The worktree has been cleanly reset onto the latest \`${ctx.baseBranch}\` with non-conflicting changes applied and conflict regions highlighted below.`,
    ``,
    `### Ticket Goal (Theirs / Your Intent)`,
    ticket.inlineMemory.goal || ticket.description,
  ];

  if (ticket.inlineMemory.acceptanceCriteria.length > 0) {
    sections.push(
      ``,
      `### Acceptance Criteria`,
      ...ticket.inlineMemory.acceptanceCriteria.map((c) => `- ${c}`),
    );
  }

  if (ctx.upstreamCommitSummaries.length > 0) {
    sections.push(
      ``,
      `### Recent Upstream Commits on \`${ctx.baseBranch}\` (Ours)`,
      ...ctx.upstreamCommitSummaries.slice(0, 8).map((line) => `- ${line}`),
    );
  }

  if (ctx.fileHunks.length > 0) {
    sections.push(``, `### Conflicting File Diff Context`);
    for (const h of ctx.fileHunks.slice(0, 8)) {
      sections.push(
        `#### \`${h.filePath}\``,
        `**Upstream (\`${ctx.baseBranch}\`) changes:**`,
        "```diff",
        h.oursSummary || "(no diff excerpt)",
        "```",
        `**Ticket (\`${ticket.id}\`) changes:**`,
        "```diff",
        h.theirsSummary || "(no diff excerpt)",
        "```",
      );
    }
  }

  sections.push(
    ``,
    `### Resolution Instructions`,
    `- Preserve ALL new upstream behavior on \`${ctx.baseBranch}\` while cleanly integrating this ticket's goal within Mandate allowedPaths (\`${ticket.mandate.allowedPaths.join(", ")}\`).`,
    `- Do NOT leave any conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`).`,
    ...(ticket.lockedTestPaths && ticket.lockedTestPaths.length > 0
      ? [`- Read-only locked spec test files MUST remain intact: \`${ticket.lockedTestPaths.join(", ")}\`.`]
      : []),
    `- After editing conflicting files, verify the codebase passes all static and runtime checks.`,
  );

  return sections.join("\n");
}

export function formatConflictCardSummary(ctx: ConflictSemanticContext): string {
  const commits =
    ctx.upstreamCommitSummaries.length > 0
      ? `Upstream commits:\n${ctx.upstreamCommitSummaries.slice(0, 4).map((c) => `  • ${c}`).join("\n")}`
      : "";
  const files = `Conflicting files (${ctx.conflictFiles.length}): ${ctx.conflictFiles.join(", ")}`;
  return [files, commits, ctx.resolutionSummary].filter(Boolean).join("\n\n");
}
