import { matchesPathScope } from "../mandate.ts";
import type {
  InboxItem,
  ReviewCommentStatus,
  ReviewFinding,
  SubmitReviewCommentsInput,
  Ticket,
  TicketReviewComment,
} from "../types.ts";
import { newId, nowIso } from "../utils.ts";
import type { KernelCoordinatorContext } from "./context.ts";

export async function syncAiFindingsToReviewComments(
  ctx: KernelCoordinatorContext,
  ticket: Ticket,
  findings: ReviewFinding[],
): Promise<TicketReviewComment[]> {
  if (!findings.length) {
    return ctx.stateStore.listReviewComments(ticket.id);
  }
  const existing = await ctx.stateStore.listReviewComments(ticket.id);
  const ts = nowIso();
  let changed = false;

  for (const f of findings) {
    if (!f.file?.trim()) continue;
    const filePath = f.file.trim();
    const line = f.line && f.line > 0 ? f.line : 1;
    const body = f.suggestion ? `${f.message}\nSuggestion: ${f.suggestion}` : f.message;
    const dup = existing.find(
      (c) =>
        c.filePath === filePath &&
        c.line === line &&
        c.body === body &&
        c.status === "open",
    );
    if (dup) continue;

    const comment: TicketReviewComment = {
      id: newId("rvc"),
      ticketId: ticket.id,
      repoId: ticket.repoId,
      filePath,
      line,
      side: "new",
      author: "ai",
      severity: f.severity,
      body,
      status: "open",
      createdAt: ts,
      updatedAt: ts,
    };
    await ctx.stateStore.saveReviewComment(comment);
    existing.push(comment);
    changed = true;
  }

  if (changed) {
    ctx.emitEvent({
      type: "review_comment_updated",
      ticketId: ticket.id,
      comments: existing,
      timestamp: ts,
    });
  }
  return existing;
}

export async function autoResolveModifiedReviewComments(
  ctx: KernelCoordinatorContext,
  ticketId: string,
  changedFiles: string[],
): Promise<void> {
  if (changedFiles.length === 0) return;
  const comments = await ctx.stateStore.listReviewComments(ticketId);
  const openComments = comments.filter((c) => c.status === "open");
  if (openComments.length === 0) return;

  const ts = nowIso();
  let changed = false;
  for (const comment of openComments) {
    if (matchesPathScope(comment.filePath, changedFiles) || changedFiles.includes(comment.filePath)) {
      await ctx.stateStore.updateReviewCommentStatus(comment.id, "resolved", ts);
      comment.status = "resolved";
      comment.updatedAt = ts;
      changed = true;
    }
  }
  if (changed) {
    ctx.emitEvent({
      type: "review_comment_updated",
      ticketId,
      comments,
      timestamp: ts,
    });
  }
}

export async function submitTicketReviewComments(
  ctx: KernelCoordinatorContext,
  ticketId: string,
  input: SubmitReviewCommentsInput,
): Promise<{ comments: TicketReviewComment[]; ticket: Ticket }> {
  let ticket = await ctx.stateStore.getTicket(ticketId);
  if (!ticket) {
    throw new Error(`Ticket not found: ${ticketId}`);
  }
  const ts = nowIso();

  for (const draft of input.comments ?? []) {
    const body = draft.body?.trim();
    const filePath = draft.filePath?.trim();
    if (!body || !filePath) continue;
    const comment: TicketReviewComment = {
      id: newId("rvc"),
      ticketId: ticket.id,
      repoId: ticket.repoId,
      filePath,
      line: Math.max(1, Math.floor(draft.line || 1)),
      side: draft.side ?? "new",
      codeSnippet: draft.codeSnippet?.trim() || undefined,
      author: "human",
      severity: draft.severity ?? "major",
      body,
      status: "open",
      createdAt: ts,
      updatedAt: ts,
    };
    await ctx.stateStore.saveReviewComment(comment);
  }

  for (const upd of input.statusUpdates ?? []) {
    await ctx.stateStore.updateReviewCommentStatus(upd.id, upd.status, ts);
  }

  const allComments = await ctx.stateStore.listReviewComments(ticket.id);
  ctx.emitEvent({
    type: "review_comment_updated",
    ticketId: ticket.id,
    comments: allComments,
    timestamp: ts,
  });

  if (input.mode === "request_changes") {
    const openComments = allComments.filter((c) => c.status === "open");
    if (openComments.length === 0 && !input.summaryNote?.trim()) {
      throw new Error("Cannot request changes without at least one open review comment or summaryNote.");
    }

    const activeCtrl = ctx.abortControllers.get(ticket.id);
    if (activeCtrl) {
      activeCtrl.abort("human_line_review");
    }

    const pendingOutbox = await ctx.stateStore.listOutboxEntries({ ticketId: ticket.id });
    for (const entry of pendingOutbox) {
      if (entry.status === "pending" || entry.status === "awaiting_approval") {
        await ctx.stateStore.updateOutboxEntry({
          ...entry,
          status: "failed",
          lastError: "Cancelled by human line-level review request_changes",
          updatedAt: ts,
        });
      }
    }

    const pendingInbox = await ctx.stateStore.listInboxItems({
      ticketId: ticket.id,
      status: "pending",
    });
    for (const item of pendingInbox) {
      if (item.kind === "outbox_signoff") {
        const rejected: InboxItem = {
          ...item,
          status: "rejected",
          resolutionNote: "Superseded by human line-level DiffStudio review",
          resolvedAt: ts,
        };
        await ctx.stateStore.saveInboxItem(rejected);
        ctx.emitEvent({ type: "inbox_resolved", item: rejected, timestamp: ts });
      }
    }

    const formattedLines = openComments.map((c) => {
      const snippet = c.codeSnippet ? `\n  Code: \`${c.codeSnippet}\`` : "";
      return `- [${c.filePath}:${c.line}] (${c.severity ?? c.author}): ${c.body}${snippet}`;
    });
    const guidance = [
      input.summaryNote?.trim() ? `Reviewer Summary: ${input.summaryNote.trim()}` : "",
      formattedLines.length > 0
        ? `Address these exact line-anchored review comments:\n${formattedLines.join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    ticket = {
      ...ticket,
      status: "queued",
      currentStage: "implement",
      stageRetries: 0,
      activeEngine: undefined,
      riskAssessment: undefined,
      errorMessage: undefined,
      inlineMemory: {
        ...ticket.inlineMemory,
        activeHint: guidance,
      },
      updatedAt: ts,
    };
    await ctx.stateStore.saveTicket(ticket);
    ctx.emitEvent({ type: "ticket_updated", ticket, timestamp: ts });
  }

  return { comments: allComments, ticket };
}

export async function updateReviewCommentStatusOp(
  ctx: KernelCoordinatorContext,
  commentId: string,
  status: ReviewCommentStatus,
): Promise<TicketReviewComment | null> {
  const ts = nowIso();
  const updated = await ctx.stateStore.updateReviewCommentStatus(commentId, status, ts);
  if (updated) {
    const comments = await ctx.stateStore.listReviewComments(updated.ticketId);
    ctx.emitEvent({
      type: "review_comment_updated",
      ticketId: updated.ticketId,
      comments,
      timestamp: ts,
    });
  }
  return updated;
}
