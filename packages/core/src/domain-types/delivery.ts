export type InboxItemKind =
  | "observe_proposal"
  | "plan_approval"
  | "watchdog_escalation"
  | "mandate_violation"
  | "merge_conflict"
  | "outbox_signoff"
  | "budget_cap"
  | "pr_followup"
  | "arena_tiebreak"
  | "epic_replan"
  | "clarification_request"
  | "campaign_paused"
  | "milestone_ready";

export type InboxItemStatus = "pending" | "approved" | "rejected";

export interface InboxItem {
  id: string;
  repoId: string;
  ticketId: string;
  kind: InboxItemKind;
  status: InboxItemStatus;
  title: string;
  summary: string;
  contextPayload: Record<string, unknown>;
  resolutionNote?: string;
  createdAt: string;
  resolvedAt?: string;
}

export type OutboxAction = "push_and_create_pr" | "local_merge" | "comment_issue" | "comment_pr";

export type OutboxStatus = "awaiting_approval" | "pending" | "processing" | "sent" | "failed" | "cancelled";

export interface OutboxEntry {
  id: string;
  repoId: string;
  ticketId: string;
  action: OutboxAction;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
  resultPayload?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface BatchResolveInboxInput {
  inboxIds?: string[];
  repoId?: string;
  kinds?: InboxItemKind[];
  onlyLowRisk?: boolean;
  decision: "approved" | "rejected";
  note?: string;
  deliveryAction?: "local_merge" | "push_and_create_pr";
}

export interface BatchResolveInboxResult {
  resolvedCount: number;
  skippedCount: number;
  results: Array<{ inboxId: string; ticketId: string; status: InboxItemStatus }>;
}

export type MergeTrainEntryStatus =
  | "queued"
  | "barrier_waiting"
  | "validating"
  | "merged"
  | "ejected"
  | "barrier_blocked";

export interface MergeTrainEntry {
  id: string;
  repoId: string;
  ticketId: string;
  outboxId: string;
  branchName: string;
  baseBranch: string;
  barrierGroupId?: string;
  position: number;
  status: MergeTrainEntryStatus;
  bypassedSpeculation?: boolean;
  speculativeCommitSha?: string;
  mergedCommitSha?: string;
  errorSummary?: string;
  createdAt: string;
  updatedAt: string;
}
