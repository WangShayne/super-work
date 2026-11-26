import type { InboxItem } from "./domain-types/delivery.ts";

/** v1.8.0: 人类只需面对三个动词。 */
export type InboxHumanAction = "approve" | "answer" | "unblock";

export function classifyInboxHumanAction(kind: InboxItem["kind"]): InboxHumanAction {
  switch (kind) {
    case "outbox_signoff":
    case "plan_approval":
    case "observe_proposal":
    case "milestone_ready":
    case "arena_tiebreak":
      return "approve";
    case "clarification_request":
    case "epic_replan":
      return "answer";
    case "mandate_violation":
    case "watchdog_escalation":
    case "merge_conflict":
    case "budget_cap":
    case "pr_followup":
    case "campaign_paused":
      return "unblock";
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      return "unblock";
    }
  }
}
