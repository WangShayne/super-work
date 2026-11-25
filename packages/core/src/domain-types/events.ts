import type { GoalCampaign, GoalCampaignWave, RoutineRun, RoutineSpec } from "./autonomy.ts";
import type { InboxItem, MergeTrainEntry, OutboxEntry } from "./delivery.ts";
import type { WorkerEngineId } from "./engine.ts";
import type { EpicReplanProposal } from "./epic.ts";
import type { CasebookEntry, PlaybookEntry } from "./memory.ts";
import type { Milestone } from "./milestone.ts";
import type { EvalRunRecord } from "./observability.ts";
import type { RepoConfig } from "./repo.ts";
import type { TicketReviewComment } from "./review.ts";
import type { PreviewSession, SelfReloadState, WorktreeGcResult } from "./system.ts";
import type { InlineStageNote, StageRun, Ticket, TicketCheckpoint, Trigger } from "./ticket.ts";
import type { HookExecutionRecord, VerificationRunResult } from "./verification.ts";
import type { WatchdogDecision, WatchdogSignal, WorkerStreamEvent } from "./worker.ts";

export type KernelEvent =
  | { type: "repo_updated"; repo: RepoConfig; timestamp: string }
  | { type: "trigger_ingested"; trigger: Trigger; timestamp: string }
  | { type: "thread_routed"; ticketId: string; triggerId: string; message: string; timestamp: string }
  | { type: "ticket_created"; ticket: Ticket; timestamp: string }
  | { type: "ticket_updated"; ticket: Ticket; timestamp: string }
  | { type: "stage_started"; ticketId: string; stageRun: StageRun; timestamp: string }
  | { type: "worker_event"; ticketId: string; stageRunId: string; engine: WorkerEngineId; event: WorkerStreamEvent; timestamp: string }
  | { type: "stage_completed"; ticketId: string; stageRun: StageRun; note: InlineStageNote; timestamp: string }
  | { type: "watchdog_signal"; signal: WatchdogSignal; timestamp: string }
  | { type: "watchdog_decision"; ticketId: string; stageRunId: string; decision: WatchdogDecision; timestamp: string }
  | { type: "inbox_created"; item: InboxItem; timestamp: string }
  | { type: "inbox_resolved"; item: InboxItem; timestamp: string }
  | { type: "outbox_queued"; entry: OutboxEntry; timestamp: string }
  | { type: "outbox_sent"; entry: OutboxEntry; timestamp: string }
  | { type: "outbox_failed"; entry: OutboxEntry; timestamp: string }
  | { type: "worktrees_gc"; result: WorktreeGcResult; timestamp: string }
  | {
      type: "verification_completed";
      ticketId: string;
      stageRunId: string;
      result: VerificationRunResult;
      timestamp: string;
    }
  | {
      type: "playbook_updated";
      repoId: string;
      entry?: PlaybookEntry;
      deletedId?: string;
      timestamp: string;
    }
  | {
      type: "routine_updated";
      repoId: string;
      routine?: RoutineSpec;
      deletedId?: string;
      timestamp: string;
    }
  | {
      type: "routine_run_updated";
      repoId: string;
      routineId: string;
      run: RoutineRun;
      timestamp: string;
    }
  | {
      type: "casebook_updated";
      repoId: string;
      entry: CasebookEntry;
      timestamp: string;
    }
  | {
      type: "epic_replanned";
      repoId: string;
      epicId: string;
      proposal: EpicReplanProposal;
      autoApplied: boolean;
      timestamp: string;
    }
  | {
      type: "preview_updated";
      preview: PreviewSession;
      timestamp: string;
    }
  | {
      type: "checkpoint_created";
      checkpoint: TicketCheckpoint;
      timestamp: string;
    }
  | {
      type: "review_comment_updated";
      ticketId: string;
      comments: TicketReviewComment[];
      timestamp: string;
    }
  | {
      type: "eval_run_updated";
      repoId: string;
      evalRun: EvalRunRecord;
      timestamp: string;
    }
  | {
      type: "campaign_updated";
      repoId: string;
      campaign?: GoalCampaign;
      wave?: GoalCampaignWave;
      deletedId?: string;
      timestamp: string;
    }
  | {
      type: "milestone_updated";
      repoId: string;
      milestone?: Milestone;
      deletedId?: string;
      timestamp: string;
    }
  | {
      type: "merge_train_updated";
      repoId: string;
      entries: MergeTrainEntry[];
      timestamp: string;
    }
  | {
      type: "lifecycle_hook_executed";
      repoId: string;
      ticketId: string;
      record: HookExecutionRecord;
      timestamp: string;
    }
  | {
      type: "self_reload_updated";
      state: SelfReloadState;
      timestamp: string;
    };
