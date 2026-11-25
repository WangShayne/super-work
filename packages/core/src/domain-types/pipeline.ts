export type PipelineTemplateId = "fast" | "standard" | "strict";

export type StageKind = "plan" | "spec_test" | "implement" | "review" | "rebase";

export type TicketStatus =
  | "triaging"
  | "proposed"
  | "queued"
  | "waiting_deps"
  | "planning"
  | "spec_testing"
  | "awaiting_plan_approval"
  | "implementing"
  | "reviewing"
  | "rebasing"
  | "watchdog_intervention"
  | "needs_human"
  | "outbox_pending"
  | "delivered"
  | "failed"
  | "cancelled";

export type TriggerSource = "web" | "github_issue" | "github_pr" | "github_ci" | "cli";

export type DeliveryChannel = "auto_pr_or_branch" | "local_merge" | "github_pr";

export type EpicDeliveryMode = "unified" | "per_subtask";
