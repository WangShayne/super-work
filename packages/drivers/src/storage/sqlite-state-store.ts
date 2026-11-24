import { copyFileSync, existsSync, rmSync } from "node:fs";
import { Database } from "bun:sqlite";
import type {
  CasebookEntry,
  ChainOfRecall,
  EngineMetricRow,
  EvalCase,
  EvalRunRecord,
  GoalCampaign,
  GoalCampaignWave,
  InboxItem,
  InboxItemStatus,
  MemorySearchHit,
  MergeTrainEntry,
  MergeTrainEntryStatus,
  OutboxAction,
  OutboxEntry,
  OutboxStatus,
  PlaybookEntry,
  RepoConfig,
  RepoMetricsSummary,
  ReviewCommentStatus,
  RoutineRun,
  RoutineSpec,
  SpillArtifact,
  StageRun,
  StateStore,
  Thread,
  Ticket,
  TicketCheckpoint,
  TicketReviewComment,
  TicketStatus,
  Trigger,
  WorkerEngineId,
} from "@super-work/core";
import { TERMINAL_TICKET_STATUSES, buildEngineCategoryMatrix } from "@super-work/core";
import {
  mapArtifactRow,
  mapCasebookRow,
  mapCheckpointRow,
  mapEvalCaseRow,
  mapEvalRunRow,
  mapGoalCampaignRow,
  mapGoalCampaignWaveRow,
  mapInboxRow,
  mapMergeTrainEntryRow,
  mapOutboxRow,
  mapPlaybookRow,
  mapRepoRow,
  mapReviewCommentRow,
  mapRoutineRow,
  mapRoutineRunRow,
  mapStageRunRow,
  mapThreadRow,
  mapTicketRow,
  mapTriggerRow,
} from "./sqlite-mappers.ts";
import { initializeSqliteSchema } from "./sqlite-schema.ts";

export function tokenizeFtsQuery(rawQuery: string): string | null {
  // Keep alphanumeric, underscore, and CJK characters; split into safe double-quoted OR terms
  const tokens = rawQuery
    .match(/[\p{L}\p{N}_]+/gu)
    ?.map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 12);

  if (!tokens || tokens.length === 0) {
    return null;
  }

  return tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

export class SqliteStateStore implements StateStore {
  db: Database;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.db = new Database(dbPath, { create: true });
    initializeSqliteSchema(this.db);
  }

  close(): void {
    this.db.close();
  }

  // --- Repos ---
  async upsertRepo(repo: RepoConfig): Promise<void> {
    this.db
      .query(
        `INSERT INTO repos (
          id, name, root_path, base_branch, mode, github_repo, default_template, default_tdd_mode,
          preferred_implement_engine, preferred_review_engine, fallback_engines_json, auto_cleanup_worktree,
          verification_commands_json, setup_commands_json, hooks_json, smoke_check_json, preview_command, sandbox_mode, forbidden_paths_json,
          conventions, contract_synced_hash, contract_synced_at,
          default_delivery_channel,
          max_concurrent_workers, daily_budget_usd, daily_budget_override_usd, daily_budget_override_date,
          delivery_gate_policy, risk_threshold, sensitive_paths_json, blueprints_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          root_path = excluded.root_path,
          base_branch = excluded.base_branch,
          mode = excluded.mode,
          github_repo = excluded.github_repo,
          default_template = excluded.default_template,
          default_tdd_mode = excluded.default_tdd_mode,
          preferred_implement_engine = excluded.preferred_implement_engine,
          preferred_review_engine = excluded.preferred_review_engine,
          fallback_engines_json = excluded.fallback_engines_json,
          auto_cleanup_worktree = excluded.auto_cleanup_worktree,
          verification_commands_json = excluded.verification_commands_json,
          setup_commands_json = excluded.setup_commands_json,
          hooks_json = excluded.hooks_json,
          smoke_check_json = excluded.smoke_check_json,
          preview_command = excluded.preview_command,
          sandbox_mode = excluded.sandbox_mode,
          forbidden_paths_json = excluded.forbidden_paths_json,
          conventions = excluded.conventions,
          contract_synced_hash = excluded.contract_synced_hash,
          contract_synced_at = excluded.contract_synced_at,
          default_delivery_channel = excluded.default_delivery_channel,
          max_concurrent_workers = excluded.max_concurrent_workers,
          daily_budget_usd = excluded.daily_budget_usd,
          daily_budget_override_usd = excluded.daily_budget_override_usd,
          daily_budget_override_date = excluded.daily_budget_override_date,
          delivery_gate_policy = excluded.delivery_gate_policy,
          risk_threshold = excluded.risk_threshold,
          sensitive_paths_json = excluded.sensitive_paths_json,
          blueprints_json = excluded.blueprints_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        repo.id,
        repo.name,
        repo.rootPath,
        repo.baseBranch,
        repo.mode,
        repo.githubRepo ?? null,
        repo.defaultTemplate,
        repo.defaultTddMode ? 1 : 0,
        repo.preferredImplementEngine,
        repo.preferredReviewEngine,
        repo.fallbackEngines ? JSON.stringify(repo.fallbackEngines) : null,
        repo.autoCleanupWorktree === false ? 0 : 1,
        JSON.stringify(repo.verificationCommands ?? []),
        JSON.stringify(repo.setupCommands ?? []),
        repo.hooks ? JSON.stringify(repo.hooks) : null,
        repo.smokeCheck ? JSON.stringify(repo.smokeCheck) : null,
        repo.previewCommand ?? null,
        repo.sandboxMode ?? null,
        JSON.stringify(repo.forbiddenPaths ?? []),
        repo.conventions ?? null,
        repo.contractSyncedHash ?? null,
        repo.contractSyncedAt ?? null,
        repo.defaultDeliveryChannel ?? "auto_pr_or_branch",
        repo.maxConcurrentWorkers ?? null,
        repo.dailyBudgetUsd ?? null,
        repo.dailyBudgetOverrideUsd ?? null,
        repo.dailyBudgetOverrideDate ?? null,
        repo.deliveryGatePolicy ?? null,
        repo.riskThreshold ?? null,
        repo.sensitivePaths ? JSON.stringify(repo.sensitivePaths) : null,
        repo.blueprints ? JSON.stringify(repo.blueprints) : null,
        repo.createdAt,
        repo.updatedAt,
      );
  }

  async getRepo(id: string): Promise<RepoConfig | null> {
    const row = this.db.query("SELECT * FROM repos WHERE id = ?").get(id) as Record<string, unknown> | null;
    return row ? mapRepoRow(row) : null;
  }

  async listRepos(): Promise<RepoConfig[]> {
    const rows = this.db.query("SELECT * FROM repos ORDER BY created_at ASC").all() as Record<string, unknown>[];
    return rows.map(mapRepoRow);
  }

  // --- Triggers & Threads ---
  async saveTrigger(trigger: Trigger): Promise<void> {
    this.db
      .query(
        `INSERT OR REPLACE INTO triggers (
          id, repo_id, source, external_ref, thread_key, title, payload_json, raw_text, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        trigger.id,
        trigger.repoId,
        trigger.source,
        trigger.externalRef ?? null,
        trigger.threadKey,
        trigger.title,
        JSON.stringify(trigger.payload),
        trigger.rawText,
        trigger.createdAt,
      );
  }

  async getTrigger(id: string): Promise<Trigger | null> {
    const row = this.db.query("SELECT * FROM triggers WHERE id = ?").get(id) as Record<string, unknown> | null;
    return row ? mapTriggerRow(row) : null;
  }

  async findTriggerByExternalRef(repoId: string, externalRef: string): Promise<Trigger | null> {
    const row = this.db
      .query("SELECT * FROM triggers WHERE repo_id = ? AND external_ref = ?")
      .get(repoId, externalRef) as Record<string, unknown> | null;
    return row ? mapTriggerRow(row) : null;
  }

  async listTriggersByThread(threadId: string): Promise<Trigger[]> {
    const thread = await this.getThread(threadId);
    if (!thread) return [];
    const rows = this.db
      .query("SELECT * FROM triggers WHERE repo_id = ? AND thread_key = ? ORDER BY created_at ASC")
      .all(thread.repoId, thread.threadKey) as Record<string, unknown>[];
    return rows.map(mapTriggerRow);
  }

  async upsertThread(thread: Thread): Promise<void> {
    this.db
      .query(
        `INSERT INTO threads (
          id, repo_id, thread_key, subscribed_ticket_id, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(repo_id, thread_key) DO UPDATE SET
          subscribed_ticket_id = excluded.subscribed_ticket_id,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        thread.id,
        thread.repoId,
        thread.threadKey,
        thread.subscribedTicketId ?? null,
        JSON.stringify(thread.metadata),
        thread.createdAt,
        thread.updatedAt,
      );
  }

  async getThread(id: string): Promise<Thread | null> {
    const row = this.db.query("SELECT * FROM threads WHERE id = ?").get(id) as Record<string, unknown> | null;
    return row ? mapThreadRow(row) : null;
  }

  async getThreadByKey(repoId: string, threadKey: string): Promise<Thread | null> {
    const row = this.db
      .query("SELECT * FROM threads WHERE repo_id = ? AND thread_key = ?")
      .get(repoId, threadKey) as Record<string, unknown> | null;
    return row ? mapThreadRow(row) : null;
  }

  // --- Tickets ---
  async saveTicket(ticket: Ticket): Promise<void> {
    this.db
      .query(
        `INSERT INTO tickets (
          id, repo_id, thread_id, source_trigger_id, title, description, status, template,
          current_stage, stage_retries, mandate_json, depends_on_json,
          parent_ticket_id, is_epic, subtask_key,
          epic_delivery_mode, pr_number, pr_url, pr_auto_followup_count, pending_violation_paths_json,
          merged_commit_sha, reverted_at, revert_commit_sha,
          worktree_path, branch_name, worktree_cleaned_at,
          native_sessions_json, preferred_engine, active_engine, failed_engines_json,
          arena_mode, arena_competitor_engine, arena_candidates_json, arena_winner_id,
          tdd_mode, locked_test_paths_json, spec_test_commit_sha, spec_test_challenge_count,
          task_category, routing_rationale, auto_arena_escalated, impact_summary_json, pause_before_run,
          blueprint_id, delivery_gate_policy, risk_threshold, risk_assessment_json, conflict_resolution_count, conflict_context_json,
          clarification_count, steer_count,
          routine_id, campaign_id, campaign_wave, target_branch, barrier_group_id, base_head_at_rebase,
          epic_replan_count, epic_replan_history_json, pending_epic_replan_json,
          model_override, effort_override,
          inline_memory_json, handover_digest_json, cost_usd, priority, error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          description = excluded.description,
          status = excluded.status,
          template = excluded.template,
          current_stage = excluded.current_stage,
          stage_retries = excluded.stage_retries,
          mandate_json = excluded.mandate_json,
          depends_on_json = excluded.depends_on_json,
          parent_ticket_id = excluded.parent_ticket_id,
          is_epic = excluded.is_epic,
          subtask_key = excluded.subtask_key,
          epic_delivery_mode = excluded.epic_delivery_mode,
          pr_number = excluded.pr_number,
          pr_url = excluded.pr_url,
          pr_auto_followup_count = excluded.pr_auto_followup_count,
          pending_violation_paths_json = excluded.pending_violation_paths_json,
          merged_commit_sha = excluded.merged_commit_sha,
          reverted_at = excluded.reverted_at,
          revert_commit_sha = excluded.revert_commit_sha,
          worktree_path = excluded.worktree_path,
          branch_name = excluded.branch_name,
          worktree_cleaned_at = excluded.worktree_cleaned_at,
          native_sessions_json = excluded.native_sessions_json,
          preferred_engine = excluded.preferred_engine,
          active_engine = excluded.active_engine,
          failed_engines_json = excluded.failed_engines_json,
          arena_mode = excluded.arena_mode,
          arena_competitor_engine = excluded.arena_competitor_engine,
          arena_candidates_json = excluded.arena_candidates_json,
          arena_winner_id = excluded.arena_winner_id,
          tdd_mode = excluded.tdd_mode,
          locked_test_paths_json = excluded.locked_test_paths_json,
          spec_test_commit_sha = excluded.spec_test_commit_sha,
          spec_test_challenge_count = excluded.spec_test_challenge_count,
          task_category = excluded.task_category,
          routing_rationale = excluded.routing_rationale,
          auto_arena_escalated = excluded.auto_arena_escalated,
          impact_summary_json = excluded.impact_summary_json,
          pause_before_run = excluded.pause_before_run,
          blueprint_id = excluded.blueprint_id,
          delivery_gate_policy = excluded.delivery_gate_policy,
          risk_threshold = excluded.risk_threshold,
          risk_assessment_json = excluded.risk_assessment_json,
          conflict_resolution_count = excluded.conflict_resolution_count,
          conflict_context_json = excluded.conflict_context_json,
          clarification_count = excluded.clarification_count,
          steer_count = excluded.steer_count,
          routine_id = excluded.routine_id,
          campaign_id = excluded.campaign_id,
          campaign_wave = excluded.campaign_wave,
          target_branch = excluded.target_branch,
          barrier_group_id = excluded.barrier_group_id,
          base_head_at_rebase = excluded.base_head_at_rebase,
          epic_replan_count = excluded.epic_replan_count,
          epic_replan_history_json = excluded.epic_replan_history_json,
          pending_epic_replan_json = excluded.pending_epic_replan_json,
          model_override = excluded.model_override,
          effort_override = excluded.effort_override,
          inline_memory_json = excluded.inline_memory_json,
          handover_digest_json = excluded.handover_digest_json,
          cost_usd = excluded.cost_usd,
          priority = excluded.priority,
          error_message = excluded.error_message,
          updated_at = excluded.updated_at`,
      )
      .run(
        ticket.id,
        ticket.repoId,
        ticket.threadId,
        ticket.sourceTriggerId,
        ticket.title,
        ticket.description,
        ticket.status,
        ticket.template,
        ticket.currentStage,
        ticket.stageRetries,
        JSON.stringify(ticket.mandate),
        JSON.stringify(ticket.dependsOn),
        ticket.parentTicketId ?? null,
        ticket.isEpic ? 1 : 0,
        ticket.subtaskKey ?? null,
        ticket.epicDeliveryMode ?? null,
        ticket.prNumber ?? null,
        ticket.prUrl ?? null,
        ticket.prAutoFollowupCount ?? 0,
        ticket.pendingViolationPaths ? JSON.stringify(ticket.pendingViolationPaths) : null,
        ticket.mergedCommitSha ?? null,
        ticket.revertedAt ?? null,
        ticket.revertCommitSha ?? null,
        ticket.worktreePath ?? null,
        ticket.branchName ?? null,
        ticket.worktreeCleanedAt ?? null,
        JSON.stringify(ticket.nativeSessions),
        ticket.preferredEngine ?? null,
        ticket.activeEngine ?? null,
        ticket.failedEngines ? JSON.stringify(ticket.failedEngines) : null,
        ticket.arenaMode ? 1 : 0,
        ticket.arenaCompetitorEngine ?? null,
        ticket.arenaCandidates ? JSON.stringify(ticket.arenaCandidates) : null,
        ticket.arenaWinnerId ?? null,
        ticket.tddMode ? 1 : 0,
        ticket.lockedTestPaths ? JSON.stringify(ticket.lockedTestPaths) : null,
        ticket.specTestCommitSha ?? null,
        ticket.specTestChallengeCount ?? 0,
        ticket.taskCategory ?? null,
        ticket.routingRationale ?? null,
        ticket.autoArenaEscalated ? 1 : 0,
        ticket.impactSummary ? JSON.stringify(ticket.impactSummary) : null,
        ticket.pauseBeforeRun ? 1 : 0,
        ticket.blueprintId ?? null,
        ticket.deliveryGatePolicy ?? null,
        ticket.riskThreshold ?? null,
        ticket.riskAssessment ? JSON.stringify(ticket.riskAssessment) : null,
        ticket.conflictResolutionCount ?? 0,
        ticket.conflictContext ? JSON.stringify(ticket.conflictContext) : null,
        ticket.clarificationCount ?? 0,
        ticket.steerCount ?? 0,
        ticket.routineId ?? null,
        ticket.campaignId ?? null,
        ticket.campaignWave ?? null,
        ticket.targetBranch ?? null,
        ticket.barrierGroupId ?? null,
        ticket.baseHeadAtRebase ?? null,
        ticket.epicReplanCount ?? 0,
        ticket.epicReplanHistory ? JSON.stringify(ticket.epicReplanHistory) : null,
        ticket.pendingEpicReplan ? JSON.stringify(ticket.pendingEpicReplan) : null,
        ticket.modelOverride ?? null,
        ticket.effortOverride ?? null,
        JSON.stringify(ticket.inlineMemory),
        ticket.handoverDigest ? JSON.stringify(ticket.handoverDigest) : null,
        ticket.costUsd,
        ticket.priority,
        ticket.errorMessage ?? null,
        ticket.createdAt,
        ticket.updatedAt,
      );
  }

  async getTicket(id: string): Promise<Ticket | null> {
    const row = this.db.query("SELECT * FROM tickets WHERE id = ?").get(id) as Record<string, unknown> | null;
    return row ? mapTicketRow(row) : null;
  }

  async listTickets(filter?: { repoId?: string; status?: TicketStatus }): Promise<Ticket[]> {
    const conditions: string[] = [];
    const params: string[] = [];
    if (filter?.repoId) {
      conditions.push("repo_id = ?");
      params.push(filter.repoId);
    }
    if (filter?.status) {
      conditions.push("status = ?");
      params.push(filter.status);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .query(`SELECT * FROM tickets ${where} ORDER BY priority DESC, created_at ASC`)
      .all(...params) as Record<string, unknown>[];
    return rows.map(mapTicketRow);
  }

  async listActiveTickets(repoId: string): Promise<Ticket[]> {
    const terminal = Array.from(TERMINAL_TICKET_STATUSES);
    const placeholders = terminal.map(() => "?").join(", ");
    const rows = this.db
      .query(
        `SELECT * FROM tickets WHERE repo_id = ? AND status NOT IN (${placeholders}) ORDER BY created_at ASC`,
      )
      .all(repoId, ...terminal) as Record<string, unknown>[];
    return rows.map(mapTicketRow);
  }

  // --- StageRuns & Artifacts ---
  async saveStageRun(stageRun: StageRun): Promise<void> {
    this.db
      .query(
        `INSERT INTO stage_runs (
          id, ticket_id, stage, engine, status, native_session_id, cost_usd,
          started_at, completed_at, summary, spill_transcript_id, spans_json, tool_profile_json, steered
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          native_session_id = excluded.native_session_id,
          cost_usd = excluded.cost_usd,
          completed_at = excluded.completed_at,
          summary = excluded.summary,
          spill_transcript_id = excluded.spill_transcript_id,
          spans_json = excluded.spans_json,
          tool_profile_json = excluded.tool_profile_json,
          steered = excluded.steered`,
      )
      .run(
        stageRun.id,
        stageRun.ticketId,
        stageRun.stage,
        stageRun.engine,
        stageRun.status,
        stageRun.nativeSessionId ?? null,
        stageRun.costUsd,
        stageRun.startedAt,
        stageRun.completedAt ?? null,
        stageRun.summary ?? null,
        stageRun.spillTranscriptId ?? null,
        stageRun.spans ? JSON.stringify(stageRun.spans) : null,
        stageRun.toolProfile ? JSON.stringify(stageRun.toolProfile) : null,
        stageRun.steered ? 1 : 0,
      );
  }

  async getStageRun(id: string): Promise<StageRun | null> {
    const row = this.db.query("SELECT * FROM stage_runs WHERE id = ?").get(id) as Record<string, unknown> | null;
    return row ? mapStageRunRow(row) : null;
  }

  async listStageRuns(ticketId: string): Promise<StageRun[]> {
    const rows = this.db
      .query("SELECT * FROM stage_runs WHERE ticket_id = ? ORDER BY started_at ASC")
      .all(ticketId) as Record<string, unknown>[];
    return rows.map(mapStageRunRow);
  }

  async saveArtifact(artifact: SpillArtifact, indexBody?: string): Promise<void> {
    const tx = this.db.transaction(() => {
      this.db
        .query(
          `INSERT OR REPLACE INTO artifacts (
            id, ticket_id, stage_run_id, kind, summary, storage_uri, byte_size, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          artifact.id,
          artifact.ticketId,
          artifact.stageRunId ?? null,
          artifact.kind,
          artifact.summary,
          artifact.storageUri,
          artifact.byteSize,
          artifact.createdAt,
        );

      if (indexBody) {
        const ticket = this.db
          .query("SELECT repo_id FROM tickets WHERE id = ?")
          .get(artifact.ticketId) as { repo_id: string } | null;
        if (ticket) {
          this.db
            .query("DELETE FROM memory_fts WHERE entity_type = ? AND entity_id = ?")
            .run("artifact", artifact.id);
          this.db
            .query(
              "INSERT INTO memory_fts (entity_type, entity_id, ticket_id, repo_id, title, body) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .run("artifact", artifact.id, artifact.ticketId, ticket.repo_id, artifact.summary, indexBody);
        }
      }
    });
    tx();
  }

  async getArtifact(id: string): Promise<SpillArtifact | null> {
    const row = this.db.query("SELECT * FROM artifacts WHERE id = ?").get(id) as Record<string, unknown> | null;
    return row ? mapArtifactRow(row) : null;
  }

  async listArtifacts(ticketId: string): Promise<SpillArtifact[]> {
    const rows = this.db
      .query("SELECT * FROM artifacts WHERE ticket_id = ? ORDER BY created_at ASC")
      .all(ticketId) as Record<string, unknown>[];
    return rows.map(mapArtifactRow);
  }

  // --- Inbox ---
  async saveInboxItem(item: InboxItem): Promise<void> {
    this.db
      .query(
        `INSERT INTO inbox_items (
          id, repo_id, ticket_id, kind, status, title, summary,
          context_payload_json, resolution_note, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          resolution_note = excluded.resolution_note,
          resolved_at = excluded.resolved_at`,
      )
      .run(
        item.id,
        item.repoId,
        item.ticketId,
        item.kind,
        item.status,
        item.title,
        item.summary,
        JSON.stringify(item.contextPayload),
        item.resolutionNote ?? null,
        item.createdAt,
        item.resolvedAt ?? null,
      );
  }

  async getInboxItem(id: string): Promise<InboxItem | null> {
    const row = this.db.query("SELECT * FROM inbox_items WHERE id = ?").get(id) as Record<string, unknown> | null;
    return row ? mapInboxRow(row) : null;
  }

  async listInboxItems(filter?: {
    repoId?: string;
    status?: InboxItemStatus;
    ticketId?: string;
  }): Promise<InboxItem[]> {
    const conditions: string[] = [];
    const params: string[] = [];
    if (filter?.repoId) {
      conditions.push("repo_id = ?");
      params.push(filter.repoId);
    }
    if (filter?.status) {
      conditions.push("status = ?");
      params.push(filter.status);
    }
    if (filter?.ticketId) {
      conditions.push("ticket_id = ?");
      params.push(filter.ticketId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .query(`SELECT * FROM inbox_items ${where} ORDER BY created_at DESC`)
      .all(...params) as Record<string, unknown>[];
    return rows.map(mapInboxRow);
  }

  // --- Transactional Outbox ---
  async enqueueOutbox(entry: OutboxEntry): Promise<void> {
    this.db
      .query(
        `INSERT INTO outbox_entries (
          id, repo_id, ticket_id, action, idempotency_key, payload_json, status,
          attempts, next_attempt_at, last_error, result_payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .run(
        entry.id,
        entry.repoId,
        entry.ticketId,
        entry.action,
        entry.idempotencyKey,
        JSON.stringify(entry.payload),
        entry.status,
        entry.attempts,
        entry.nextAttemptAt,
        entry.lastError ?? null,
        entry.resultPayload ? JSON.stringify(entry.resultPayload) : null,
        entry.createdAt,
        entry.updatedAt,
      );
  }

  async getOutboxEntry(id: string): Promise<OutboxEntry | null> {
    const row = this.db.query("SELECT * FROM outbox_entries WHERE id = ?").get(id) as Record<string, unknown> | null;
    return row ? mapOutboxRow(row) : null;
  }

  async listOutboxEntries(filter?: {
    repoId?: string;
    ticketId?: string;
    status?: OutboxStatus;
  }): Promise<OutboxEntry[]> {
    const conditions: string[] = [];
    const params: string[] = [];
    if (filter?.repoId) {
      conditions.push("repo_id = ?");
      params.push(filter.repoId);
    }
    if (filter?.ticketId) {
      conditions.push("ticket_id = ?");
      params.push(filter.ticketId);
    }
    if (filter?.status) {
      conditions.push("status = ?");
      params.push(filter.status);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .query(`SELECT * FROM outbox_entries ${where} ORDER BY created_at DESC`)
      .all(...params) as Record<string, unknown>[];
    return rows.map(mapOutboxRow);
  }

  async updateOutboxEntry(entry: OutboxEntry): Promise<void> {
    this.db
      .query(
        `UPDATE outbox_entries SET
          status = ?, attempts = ?, next_attempt_at = ?, last_error = ?,
          result_payload_json = ?, updated_at = ?
        WHERE id = ?`,
      )
      .run(
        entry.status,
        entry.attempts,
        entry.nextAttemptAt,
        entry.lastError ?? null,
        entry.resultPayload ? JSON.stringify(entry.resultPayload) : null,
        entry.updatedAt,
        entry.id,
      );
  }

  async claimNextOutboxEntries(
    limit: number,
    nowIso: string,
    excludeActions?: OutboxAction[],
  ): Promise<OutboxEntry[]> {
    const claimTx = this.db.transaction((): OutboxEntry[] => {
      const excludes = (excludeActions ?? []).filter(Boolean);
      const excludeClause =
        excludes.length > 0
          ? ` AND action NOT IN (${excludes.map(() => "?").join(", ")})`
          : "";
      const rows = this.db
        .query(
          `SELECT * FROM outbox_entries
           WHERE status = 'pending' AND next_attempt_at <= ?${excludeClause}
           ORDER BY created_at ASC
           LIMIT ?`,
        )
        .all(nowIso, ...excludes, limit) as Record<string, unknown>[];

      const claimed: OutboxEntry[] = [];
      for (const row of rows) {
        const entry = mapOutboxRow(row);
        this.db
          .query("UPDATE outbox_entries SET status = 'processing', updated_at = ? WHERE id = ?")
          .run(nowIso, entry.id);
        claimed.push({ ...entry, status: "processing", updatedAt: nowIso });
      }
      return claimed;
    });
    return claimTx();
  }

  async requeueInterruptedOutboxEntries(nowIso: string): Promise<number> {
    const res = this.db
      .query(
        "UPDATE outbox_entries SET status = 'pending', next_attempt_at = ?, updated_at = ? WHERE status = 'processing'",
      )
      .run(nowIso, nowIso);
    return Number(res.changes ?? 0);
  }

  checkpointWal(): void {
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      // Non-fatal WAL checkpoint
    }
  }

  // --- Daily Budget & Metrics ---
  async getDailyRepoSpendUsd(repoId: string, utcDatePrefix: string): Promise<number> {
    const row = this.db
      .query(
        `SELECT (
           COALESCE((
             SELECT SUM(sr.cost_usd)
             FROM stage_runs sr
             JOIN tickets t ON t.id = sr.ticket_id
             WHERE t.repo_id = ? AND sr.started_at LIKE ?
           ), 0)
           +
           COALESCE((
             SELECT SUM(rr.cost_usd)
             FROM routine_runs rr
             WHERE rr.repo_id = ? AND rr.started_at LIKE ?
           ), 0)
         ) AS total`,
      )
      .get(repoId, `${utcDatePrefix}%`, repoId, `${utcDatePrefix}%`) as { total: number } | null;
    return Number(row?.total ?? 0);
  }

  async getMetricsSummary(repoId?: string, utcDatePrefix?: string): Promise<RepoMetricsSummary> {
    const todayDate = utcDatePrefix ?? new Date().toISOString().slice(0, 10);

    let todayCostUsd = 0;
    let dailyBudgetUsd: number | undefined;
    let effectiveDailyBudgetUsd: number | undefined;
    if (repoId) {
      todayCostUsd = await this.getDailyRepoSpendUsd(repoId, todayDate);
      const repo = await this.getRepo(repoId);
      dailyBudgetUsd = repo?.dailyBudgetUsd;
      effectiveDailyBudgetUsd =
        repo?.dailyBudgetOverrideDate === todayDate && repo.dailyBudgetOverrideUsd !== undefined
          ? repo.dailyBudgetOverrideUsd
          : repo?.dailyBudgetUsd;
    } else {
      const todayRow = this.db
        .query(
          `SELECT (
             COALESCE((SELECT SUM(cost_usd) FROM stage_runs WHERE started_at LIKE ?), 0)
             + COALESCE((SELECT SUM(cost_usd) FROM routine_runs WHERE started_at LIKE ?), 0)
           ) AS total`,
        )
        .get(`${todayDate}%`, `${todayDate}%`) as { total: number } | null;
      todayCostUsd = Number(todayRow?.total ?? 0);
    }

    const budgetExceeded = Boolean(
      effectiveDailyBudgetUsd !== undefined &&
        effectiveDailyBudgetUsd > 0 &&
        todayCostUsd >= effectiveDailyBudgetUsd,
    );

    const totalCostRow = (
      repoId
        ? this.db
            .query(
              "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM tickets WHERE COALESCE(is_epic, 0) = 0 AND repo_id = ?",
            )
            .get(repoId)
        : this.db
            .query("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM tickets WHERE COALESCE(is_epic, 0) = 0")
            .get()
    ) as { total: number } | null;
    const totalCostUsd = Number(totalCostRow?.total ?? 0);

    const statusRows = (
      repoId
        ? this.db
            .query(
              "SELECT status, COUNT(*) AS cnt FROM tickets WHERE COALESCE(is_epic, 0) = 0 AND repo_id = ? GROUP BY status",
            )
            .all(repoId)
        : this.db
            .query(
              "SELECT status, COUNT(*) AS cnt FROM tickets WHERE COALESCE(is_epic, 0) = 0 GROUP BY status",
            )
            .all()
    ) as Array<{ status: TicketStatus; cnt: number }>;

    let total = 0;
    let active = 0;
    let delivered = 0;
    let failed = 0;
    let cancelled = 0;
    let needsHuman = 0;

    for (const r of statusRows) {
      const count = Number(r.cnt ?? 0);
      total += count;
      if (r.status === "delivered") {
        delivered += count;
      } else if (r.status === "failed") {
        failed += count;
      } else if (r.status === "cancelled") {
        cancelled += count;
      } else {
        active += count;
        if (r.status === "needs_human") {
          needsHuman += count;
        }
      }
    }

    const finished = delivered + failed + cancelled;
    const deliveryRate = finished > 0 ? delivered / finished : 0;

    const engineSql = `
      SELECT
        sr.engine AS engine,
        COUNT(*) AS runs,
        SUM(CASE WHEN sr.status = 'completed' THEN 1 ELSE 0 END) AS completed_runs,
        SUM(CASE WHEN sr.status IN ('failed', 'aborted') THEN 1 ELSE 0 END) AS failed_runs,
        COALESCE(SUM(sr.cost_usd), 0) AS total_cost_usd,
        COALESCE(AVG(
          CASE
            WHEN sr.completed_at IS NOT NULL THEN
              MAX(0, (julianday(sr.completed_at) - julianday(sr.started_at)) * 86400000.0)
            ELSE NULL
          END
        ), 0) AS avg_duration_ms
      FROM stage_runs sr
      JOIN tickets t ON t.id = sr.ticket_id
      ${repoId ? "WHERE t.repo_id = ?" : ""}
      GROUP BY sr.engine
      ORDER BY total_cost_usd DESC, runs DESC
    `;

    const engineRows = (
      repoId ? this.db.query(engineSql).all(repoId) : this.db.query(engineSql).all()
    ) as Array<Record<string, unknown>>;

    const byEngine: EngineMetricRow[] = engineRows.map((r) => ({
      engine: String(r.engine) as WorkerEngineId,
      runs: Number(r.runs ?? 0),
      completedRuns: Number(r.completed_runs ?? 0),
      failedRuns: Number(r.failed_runs ?? 0),
      totalCostUsd: Number(r.total_cost_usd ?? 0),
      avgDurationMs: Number(r.avg_duration_ms ?? 0),
    }));

    const historicalTickets = await this.listTickets(repoId ? { repoId } : undefined);
    const stageRunRows = (
      repoId
        ? this.db
            .query(
              "SELECT sr.* FROM stage_runs sr JOIN tickets t ON t.id = sr.ticket_id WHERE t.repo_id = ? ORDER BY sr.started_at ASC",
            )
            .all(repoId)
        : this.db.query("SELECT * FROM stage_runs ORDER BY started_at ASC").all()
    ) as Array<Record<string, unknown>>;
    const casebookRows = (
      repoId
        ? this.db.query("SELECT * FROM casebook_entries WHERE repo_id = ?").all(repoId)
        : this.db.query("SELECT * FROM casebook_entries").all()
    ) as Array<Record<string, unknown>>;
    const engineMatrix = buildEngineCategoryMatrix({
      tickets: historicalTickets,
      stageRuns: stageRunRows.map(mapStageRunRow),
      casebookEntries: casebookRows.map(mapCasebookRow),
    });

    return {
      repoId,
      todayDate,
      todayCostUsd,
      dailyBudgetUsd,
      effectiveDailyBudgetUsd,
      budgetExceeded,
      totalCostUsd,
      ticketCounts: {
        total,
        active,
        delivered,
        failed,
        cancelled,
        needsHuman,
      },
      deliveryRate,
      byEngine,
      engineMatrix,
    };
  }

  // --- Memory & Chain of Recall ---
  async indexMemoryDocument(doc: {
    entityType: string;
    entityId: string;
    ticketId: string;
    repoId: string;
    title: string;
    body: string;
  }): Promise<void> {
    const tx = this.db.transaction(() => {
      this.db
        .query("DELETE FROM memory_fts WHERE entity_type = ? AND entity_id = ?")
        .run(doc.entityType, doc.entityId);
      this.db
        .query(
          "INSERT INTO memory_fts (entity_type, entity_id, ticket_id, repo_id, title, body) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(doc.entityType, doc.entityId, doc.ticketId, doc.repoId, doc.title, doc.body);
    });
    tx();
  }

  async searchMemory(query: string, limit = 10, repoId?: string): Promise<MemorySearchHit[]> {
    const ftsQuery = tokenizeFtsQuery(query);
    if (!ftsQuery) return [];

    const sql = repoId
      ? `SELECT entity_type, entity_id, ticket_id, repo_id, title,
                snippet(memory_fts, 5, '[', ']', '...', 18) AS snippet
         FROM memory_fts
         WHERE memory_fts MATCH ? AND repo_id = ?
         ORDER BY bm25(memory_fts)
         LIMIT ?`
      : `SELECT entity_type, entity_id, ticket_id, repo_id, title,
                snippet(memory_fts, 5, '[', ']', '...', 18) AS snippet
         FROM memory_fts
         WHERE memory_fts MATCH ?
         ORDER BY bm25(memory_fts)
         LIMIT ?`;

    const rows = (
      repoId
        ? this.db.query(sql).all(ftsQuery, repoId, limit)
        : this.db.query(sql).all(ftsQuery, limit)
    ) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      entityType: String(r.entity_type),
      entityId: String(r.entity_id),
      ticketId: String(r.ticket_id),
      repoId: String(r.repo_id),
      title: String(r.title),
      snippet: String(r.snippet ?? ""),
    }));
  }

  async recallChain(ticketId: string): Promise<ChainOfRecall | null> {
    const ticket = await this.getTicket(ticketId);
    if (!ticket) return null;

    const trigger = await this.getTrigger(ticket.sourceTriggerId);
    const thread = await this.getThread(ticket.threadId);
    const threadTriggers = thread ? await this.listTriggersByThread(thread.id) : [];
    const stageRuns = await this.listStageRuns(ticket.id);
    const artifacts = await this.listArtifacts(ticket.id);

    const hits = await this.searchMemory(ticket.title, 6, ticket.repoId);
    const relatedTickets: ChainOfRecall["relatedTickets"] = [];
    const seen = new Set<string>([ticket.id]);

    for (const hit of hits) {
      if (seen.has(hit.ticketId)) continue;
      seen.add(hit.ticketId);
      const rel = await this.getTicket(hit.ticketId);
      if (rel) {
        relatedTickets.push({
          ticketId: rel.id,
          title: rel.title,
          status: rel.status,
          snippet: hit.snippet,
        });
      }
    }

    return {
      trigger,
      thread,
      ticket,
      threadTriggers,
      stageRuns,
      artifacts,
      relatedTickets,
    };
  }

  // --- Playbook ---
  async savePlaybookEntry(entry: PlaybookEntry): Promise<void> {
    this.db
      .query(
        `INSERT INTO playbook_entries (
          id, repo_id, rule, scope_paths_json, source, source_ticket_id,
          enabled, pinned, hit_count, last_matched_at, suspect, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          rule = excluded.rule,
          scope_paths_json = excluded.scope_paths_json,
          source = excluded.source,
          source_ticket_id = excluded.source_ticket_id,
          enabled = excluded.enabled,
          pinned = excluded.pinned,
          hit_count = excluded.hit_count,
          last_matched_at = excluded.last_matched_at,
          suspect = excluded.suspect,
          updated_at = excluded.updated_at`,
      )
      .run(
        entry.id,
        entry.repoId,
        entry.rule,
        JSON.stringify(entry.scopePaths ?? ["**"]),
        entry.source,
        entry.sourceTicketId ?? null,
        entry.enabled ? 1 : 0,
        entry.pinned ? 1 : 0,
        entry.hitCount ?? 0,
        entry.lastMatchedAt ?? null,
        entry.suspect ? 1 : 0,
        entry.createdAt,
        entry.updatedAt,
      );
  }

  async getPlaybookEntry(id: string): Promise<PlaybookEntry | null> {
    const row = this.db
      .query("SELECT * FROM playbook_entries WHERE id = ?")
      .get(id) as Record<string, unknown> | null;
    return row ? mapPlaybookRow(row) : null;
  }

  async listPlaybookEntries(
    repoId: string,
    options?: { onlyEnabled?: boolean },
  ): Promise<PlaybookEntry[]> {
    const sql = options?.onlyEnabled
      ? "SELECT * FROM playbook_entries WHERE repo_id = ? AND enabled = 1 ORDER BY pinned DESC, updated_at DESC"
      : "SELECT * FROM playbook_entries WHERE repo_id = ? ORDER BY pinned DESC, updated_at DESC";
    const rows = this.db.query(sql).all(repoId) as Record<string, unknown>[];
    return rows.map(mapPlaybookRow);
  }

  async deletePlaybookEntry(id: string): Promise<boolean> {
    const res = this.db.query("DELETE FROM playbook_entries WHERE id = ?").run(id);
    return Number(res.changes ?? 0) > 0;
  }

  async recordPlaybookHits(ids: string[], matchedAt: string): Promise<void> {
    if (ids.length === 0) return;
    const tx = this.db.transaction(() => {
      const stmt = this.db.query(
        "UPDATE playbook_entries SET hit_count = COALESCE(hit_count, 0) + 1, last_matched_at = ? WHERE id = ?",
      );
      for (const id of ids) {
        stmt.run(matchedAt, id);
      }
    });
    tx();
  }

  // --- Routines (A.1) ---
  async saveRoutine(routine: RoutineSpec): Promise<void> {
    this.db
      .query(
        `INSERT INTO routines (
          id, repo_id, name, prompt, schedule_kind, interval_minutes, cron_expr,
          active_hours_start, active_hours_end, allowed_paths_json, template, preferred_engine,
          max_budget_usd, enabled, active_ticket_id, last_run_at, last_run_status, next_run_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          prompt = excluded.prompt,
          schedule_kind = excluded.schedule_kind,
          interval_minutes = excluded.interval_minutes,
          cron_expr = excluded.cron_expr,
          active_hours_start = excluded.active_hours_start,
          active_hours_end = excluded.active_hours_end,
          allowed_paths_json = excluded.allowed_paths_json,
          template = excluded.template,
          preferred_engine = excluded.preferred_engine,
          max_budget_usd = excluded.max_budget_usd,
          enabled = excluded.enabled,
          active_ticket_id = excluded.active_ticket_id,
          last_run_at = excluded.last_run_at,
          last_run_status = excluded.last_run_status,
          next_run_at = excluded.next_run_at,
          updated_at = excluded.updated_at`,
      )
      .run(
        routine.id,
        routine.repoId,
        routine.name,
        routine.prompt,
        routine.scheduleKind,
        routine.intervalMinutes ?? null,
        routine.cronExpr ?? null,
        routine.activeHoursStart ?? null,
        routine.activeHoursEnd ?? null,
        JSON.stringify(routine.allowedPaths ?? ["**"]),
        routine.template,
        routine.preferredEngine ?? null,
        routine.maxBudgetUsd,
        routine.enabled ? 1 : 0,
        routine.activeTicketId ?? null,
        routine.lastRunAt ?? null,
        routine.lastRunStatus ?? null,
        routine.nextRunAt ?? null,
        routine.createdAt,
        routine.updatedAt,
      );
  }

  async getRoutine(id: string): Promise<RoutineSpec | null> {
    const row = this.db
      .query("SELECT * FROM routines WHERE id = ?")
      .get(id) as Record<string, unknown> | null;
    return row ? mapRoutineRow(row) : null;
  }

  async listRoutines(repoId?: string): Promise<RoutineSpec[]> {
    const rows = (
      repoId
        ? this.db.query("SELECT * FROM routines WHERE repo_id = ? ORDER BY created_at DESC").all(repoId)
        : this.db.query("SELECT * FROM routines ORDER BY created_at DESC").all()
    ) as Record<string, unknown>[];
    return rows.map(mapRoutineRow);
  }

  async deleteRoutine(id: string): Promise<boolean> {
    const tx = this.db.transaction(() => {
      this.db.query("DELETE FROM routine_runs WHERE routine_id = ?").run(id);
      return this.db.query("DELETE FROM routines WHERE id = ?").run(id);
    });
    const res = tx();
    return Number(res.changes ?? 0) > 0;
  }

  async saveRoutineRun(run: RoutineRun): Promise<void> {
    this.db
      .query(
        `INSERT INTO routine_runs (
          id, routine_id, repo_id, status, summary, changed_files_json,
          promoted_ticket_id, cost_usd, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          summary = excluded.summary,
          changed_files_json = excluded.changed_files_json,
          promoted_ticket_id = excluded.promoted_ticket_id,
          cost_usd = excluded.cost_usd,
          completed_at = excluded.completed_at`,
      )
      .run(
        run.id,
        run.routineId,
        run.repoId,
        run.status,
        run.summary,
        JSON.stringify(run.changedFiles ?? []),
        run.promotedTicketId ?? null,
        run.costUsd,
        run.startedAt,
        run.completedAt ?? null,
      );
  }

  async listRoutineRuns(filter?: {
    repoId?: string;
    routineId?: string;
    limit?: number;
  }): Promise<RoutineRun[]> {
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (filter?.repoId) {
      conditions.push("repo_id = ?");
      params.push(filter.repoId);
    }
    if (filter?.routineId) {
      conditions.push("routine_id = ?");
      params.push(filter.routineId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filter?.limit ?? 50;
    const rows = this.db
      .query(`SELECT * FROM routine_runs ${where} ORDER BY started_at DESC LIMIT ?`)
      .all(...params, limit) as Record<string, unknown>[];
    return rows.map(mapRoutineRunRow);
  }

  // --- Casebook (C.2) ---
  async saveCasebookEntry(entry: CasebookEntry): Promise<void> {
    this.db
      .query(
        `INSERT INTO casebook_entries (
          id, repo_id, ticket_id, title, goal_summary, solution_summary, pitfalls_and_fixes,
          changed_files_json, scope_paths_json, exported_symbols_json,
          reverted, hit_count, last_matched_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ticket_id) DO UPDATE SET
          title = excluded.title,
          goal_summary = excluded.goal_summary,
          solution_summary = excluded.solution_summary,
          pitfalls_and_fixes = excluded.pitfalls_and_fixes,
          changed_files_json = excluded.changed_files_json,
          scope_paths_json = excluded.scope_paths_json,
          exported_symbols_json = excluded.exported_symbols_json,
          reverted = excluded.reverted,
          hit_count = excluded.hit_count,
          last_matched_at = excluded.last_matched_at,
          updated_at = excluded.updated_at`,
      )
      .run(
        entry.id,
        entry.repoId,
        entry.ticketId,
        entry.title,
        entry.goalSummary,
        entry.solutionSummary,
        entry.pitfallsAndFixes ?? null,
        JSON.stringify(entry.changedFiles ?? []),
        JSON.stringify(entry.scopePaths ?? ["**"]),
        JSON.stringify(entry.exportedSymbols ?? []),
        entry.reverted ? 1 : 0,
        entry.hitCount ?? 0,
        entry.lastMatchedAt ?? null,
        entry.createdAt,
        entry.updatedAt,
      );
  }

  async getCasebookEntry(id: string): Promise<CasebookEntry | null> {
    const row = this.db
      .query("SELECT * FROM casebook_entries WHERE id = ?")
      .get(id) as Record<string, unknown> | null;
    return row ? mapCasebookRow(row) : null;
  }

  async getCasebookEntryByTicket(ticketId: string): Promise<CasebookEntry | null> {
    const row = this.db
      .query("SELECT * FROM casebook_entries WHERE ticket_id = ?")
      .get(ticketId) as Record<string, unknown> | null;
    return row ? mapCasebookRow(row) : null;
  }

  async listCasebookEntries(
    repoId: string,
    options?: { includeReverted?: boolean },
  ): Promise<CasebookEntry[]> {
    const sql =
      options?.includeReverted === false
        ? "SELECT * FROM casebook_entries WHERE repo_id = ? AND COALESCE(reverted, 0) = 0 ORDER BY updated_at DESC"
        : "SELECT * FROM casebook_entries WHERE repo_id = ? ORDER BY updated_at DESC";
    const rows = this.db.query(sql).all(repoId) as Record<string, unknown>[];
    return rows.map(mapCasebookRow);
  }

  async deleteCasebookEntry(id: string): Promise<boolean> {
    const res = this.db.query("DELETE FROM casebook_entries WHERE id = ?").run(id);
    return Number(res.changes ?? 0) > 0;
  }

  async recordCasebookHits(ids: string[], matchedAt: string): Promise<void> {
    if (ids.length === 0) return;
    const tx = this.db.transaction(() => {
      const stmt = this.db.query(
        "UPDATE casebook_entries SET hit_count = COALESCE(hit_count, 0) + 1, last_matched_at = ? WHERE id = ?",
      );
      for (const id of ids) {
        stmt.run(matchedAt, id);
      }
    });
    tx();
  }

  // --- Worktree Checkpoints (D.2) ---
  async saveCheckpoint(cp: TicketCheckpoint): Promise<void> {
    this.db
      .query(
        `INSERT INTO ticket_checkpoints (
          id, ticket_id, repo_id, stage_run_id, stage, engine, label, git_ref,
          commit_sha, changed_files_json, verification_passed, created_at, cleaned_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          label = excluded.label,
          verification_passed = excluded.verification_passed,
          cleaned_at = excluded.cleaned_at`,
      )
      .run(
        cp.id,
        cp.ticketId,
        cp.repoId,
        cp.stageRunId ?? null,
        cp.stage,
        cp.engine ?? null,
        cp.label,
        cp.gitRef,
        cp.commitSha,
        JSON.stringify(cp.changedFiles ?? []),
        cp.verificationPassed === undefined ? null : cp.verificationPassed ? 1 : 0,
        cp.createdAt,
        cp.cleanedAt ?? null,
      );
  }

  async getCheckpoint(id: string): Promise<TicketCheckpoint | null> {
    const row = this.db
      .query("SELECT * FROM ticket_checkpoints WHERE id = ?")
      .get(id) as Record<string, unknown> | null;
    return row ? mapCheckpointRow(row) : null;
  }

  async listCheckpoints(ticketId: string): Promise<TicketCheckpoint[]> {
    const rows = this.db
      .query("SELECT * FROM ticket_checkpoints WHERE ticket_id = ? ORDER BY created_at ASC")
      .all(ticketId) as Array<Record<string, unknown>>;
    return rows.map(mapCheckpointRow);
  }

  async markCheckpointsCleaned(ticketId: string, cleanedAt: string): Promise<void> {
    this.db
      .query(
        "UPDATE ticket_checkpoints SET cleaned_at = ? WHERE ticket_id = ? AND cleaned_at IS NULL",
      )
      .run(cleanedAt, ticketId);
  }

  // --- Line-Anchored Review Comments (v1.0.0 B.1) ---
  async listReviewComments(ticketId: string): Promise<TicketReviewComment[]> {
    const rows = this.db
      .query("SELECT * FROM ticket_review_comments WHERE ticket_id = ? ORDER BY created_at ASC")
      .all(ticketId) as Record<string, unknown>[];
    return rows.map(mapReviewCommentRow);
  }

  async saveReviewComment(comment: TicketReviewComment): Promise<void> {
    this.db
      .query(
        `INSERT INTO ticket_review_comments (
          id, ticket_id, repo_id, file_path, line, side, code_snippet, author, severity, body, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          file_path = excluded.file_path,
          line = excluded.line,
          side = excluded.side,
          code_snippet = excluded.code_snippet,
          author = excluded.author,
          severity = excluded.severity,
          body = excluded.body,
          status = excluded.status,
          updated_at = excluded.updated_at`,
      )
      .run(
        comment.id,
        comment.ticketId,
        comment.repoId,
        comment.filePath,
        comment.line,
        comment.side ?? null,
        comment.codeSnippet ?? null,
        comment.author,
        comment.severity ?? null,
        comment.body,
        comment.status,
        comment.createdAt,
        comment.updatedAt,
      );
  }

  async updateReviewCommentStatus(
    id: string,
    status: ReviewCommentStatus,
    updatedAt: string,
  ): Promise<TicketReviewComment | null> {
    this.db
      .query("UPDATE ticket_review_comments SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, updatedAt, id);
    const row = this.db
      .query("SELECT * FROM ticket_review_comments WHERE id = ?")
      .get(id) as Record<string, unknown> | null;
    return row ? mapReviewCommentRow(row) : null;
  }

  // --- System Maintenance (v1.0.0 C.1 + v1.1.0 D.1) ---
  async checkDatabaseIntegrity(): Promise<{ ok: boolean; detail: string; walPages?: number }> {
    const row = this.db.query("PRAGMA quick_check;").get() as { quick_check?: string } | null;
    const status = String(row?.quick_check ?? "ok");
    const walRow = this.db.query("PRAGMA wal_checkpoint(PASSIVE);").get() as
      | { busy?: number; log?: number; checkpointed?: number }
      | null;
    return {
      ok: status === "ok",
      detail: status === "ok" ? "SQLite integrity quick_check passed" : `quick_check: ${status}`,
      walPages: walRow?.log !== undefined ? Number(walRow.log) : undefined,
    };
  }

  async vacuumIntoBackup(destFilePath: string): Promise<void> {
    const escaped = destFilePath.replace(/'/g, "''");
    this.db.run(`VACUUM INTO '${escaped}';`);
  }

  async restoreFromBackup(backupFilePath: string): Promise<{ ok: boolean; detail: string }> {
    if (!this.dbPath || this.dbPath === ":memory:") {
      throw new Error("In-memory SQLite StateStore cannot restore a disk backup file.");
    }
    if (!existsSync(backupFilePath)) {
      throw new Error(`Backup file not found: ${backupFilePath}`);
    }

    const probeDb = new Database(backupFilePath, { readonly: true });
    let integrityStatus = "unknown";
    try {
      const checkRow = probeDb.query("PRAGMA quick_check;").get() as { quick_check?: string } | null;
      integrityStatus = String(checkRow?.quick_check ?? "unknown");
    } finally {
      probeDb.close();
    }
    if (integrityStatus !== "ok") {
      throw new Error(`Backup failed SQLite integrity check: ${integrityStatus}`);
    }

    this.db.close();
    rmSync(`${this.dbPath}-wal`, { force: true });
    rmSync(`${this.dbPath}-shm`, { force: true });
    copyFileSync(backupFilePath, this.dbPath);

    this.db = new Database(this.dbPath, { create: true });
    initializeSqliteSchema(this.db);

    const postCheck = await this.checkDatabaseIntegrity();
    return {
      ok: postCheck.ok,
      detail: postCheck.detail,
    };
  }

  // --- Golden Eval Suite (v1.1.0 D.1) ---
  async saveEvalCase(evalCase: EvalCase): Promise<void> {
    this.db
      .query(
        `INSERT INTO eval_cases (
          id, repo_id, source_ticket_id, title, description, base_commit_sha,
          allowed_paths_json, forbidden_paths_json, tdd_mode, locked_test_paths_json,
          verification_commands_json, smoke_check_json, reference_metrics_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          description = excluded.description,
          base_commit_sha = excluded.base_commit_sha,
          allowed_paths_json = excluded.allowed_paths_json,
          forbidden_paths_json = excluded.forbidden_paths_json,
          tdd_mode = excluded.tdd_mode,
          locked_test_paths_json = excluded.locked_test_paths_json,
          verification_commands_json = excluded.verification_commands_json,
          smoke_check_json = excluded.smoke_check_json,
          reference_metrics_json = excluded.reference_metrics_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        evalCase.id,
        evalCase.repoId,
        evalCase.sourceTicketId ?? null,
        evalCase.title,
        evalCase.description,
        evalCase.baseCommitSha,
        JSON.stringify(evalCase.allowedPaths),
        JSON.stringify(evalCase.forbiddenPaths),
        evalCase.tddMode ? 1 : 0,
        evalCase.lockedTestPaths ? JSON.stringify(evalCase.lockedTestPaths) : null,
        JSON.stringify(evalCase.verificationCommands),
        evalCase.smokeCheck ? JSON.stringify(evalCase.smokeCheck) : null,
        evalCase.referenceMetrics ? JSON.stringify(evalCase.referenceMetrics) : null,
        evalCase.createdAt,
        evalCase.updatedAt,
      );
  }

  async getEvalCase(id: string): Promise<EvalCase | null> {
    const row = this.db.query("SELECT * FROM eval_cases WHERE id = ?").get(id) as Record<
      string,
      unknown
    > | null;
    return row ? mapEvalCaseRow(row) : null;
  }

  async listEvalCases(repoId?: string): Promise<EvalCase[]> {
    const rows = repoId
      ? (this.db
          .query("SELECT * FROM eval_cases WHERE repo_id = ? ORDER BY created_at DESC")
          .all(repoId) as Record<string, unknown>[])
      : (this.db
          .query("SELECT * FROM eval_cases ORDER BY created_at DESC")
          .all() as Record<string, unknown>[]);
    return rows.map(mapEvalCaseRow);
  }

  async deleteEvalCase(id: string): Promise<boolean> {
    const res = this.db.query("DELETE FROM eval_cases WHERE id = ?").run(id);
    return Number(res.changes ?? 0) > 0;
  }

  async saveEvalRun(run: EvalRunRecord): Promise<void> {
    this.db
      .query(
        `INSERT INTO eval_runs (
          id, eval_case_id, repo_id, status, engines_json, results_json,
          max_budget_usd, total_cost_usd, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          results_json = excluded.results_json,
          total_cost_usd = excluded.total_cost_usd,
          completed_at = excluded.completed_at`,
      )
      .run(
        run.id,
        run.evalCaseId,
        run.repoId,
        run.status,
        JSON.stringify(run.engines),
        JSON.stringify(run.results),
        run.maxBudgetUsd,
        run.totalCostUsd,
        run.startedAt,
        run.completedAt ?? null,
      );
  }

  async getEvalRun(id: string): Promise<EvalRunRecord | null> {
    const row = this.db.query("SELECT * FROM eval_runs WHERE id = ?").get(id) as Record<
      string,
      unknown
    > | null;
    return row ? mapEvalRunRow(row) : null;
  }

  async listEvalRuns(filter?: {
    repoId?: string;
    evalCaseId?: string;
    limit?: number;
  }): Promise<EvalRunRecord[]> {
    const conds: string[] = [];
    const params: Array<string | number> = [];
    if (filter?.repoId) {
      conds.push("repo_id = ?");
      params.push(filter.repoId);
    }
    if (filter?.evalCaseId) {
      conds.push("eval_case_id = ?");
      params.push(filter.evalCaseId);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(100, filter?.limit ?? 30));
    const rows = this.db
      .query(`SELECT * FROM eval_runs ${where} ORDER BY started_at DESC LIMIT ?`)
      .all(...params, limit) as Record<string, unknown>[];
    return rows.map(mapEvalRunRow);
  }

  // --- Goal Campaigns (v1.2.0 Pillar A) ---
  async saveCampaign(campaign: GoalCampaign): Promise<void> {
    this.db
      .query(
        `INSERT INTO goal_campaigns (
          id, repo_id, name, goal_prompt, metric_command, metric_regex, metric_unit,
          direction, baseline_value, current_value, target_value, delivery_mode,
          staging_branch, last_good_commit_sha, allowed_paths_json, template, preferred_engine,
          max_iterations, completed_waves, max_total_budget_usd, total_cost_usd,
          consecutive_no_improve_count, active_ticket_id, pause_reason,
          delivered_pr_url, delivered_commit_sha, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          goal_prompt = excluded.goal_prompt,
          metric_command = excluded.metric_command,
          metric_regex = excluded.metric_regex,
          metric_unit = excluded.metric_unit,
          direction = excluded.direction,
          baseline_value = excluded.baseline_value,
          current_value = excluded.current_value,
          target_value = excluded.target_value,
          delivery_mode = excluded.delivery_mode,
          staging_branch = excluded.staging_branch,
          last_good_commit_sha = excluded.last_good_commit_sha,
          allowed_paths_json = excluded.allowed_paths_json,
          template = excluded.template,
          preferred_engine = excluded.preferred_engine,
          max_iterations = excluded.max_iterations,
          completed_waves = excluded.completed_waves,
          max_total_budget_usd = excluded.max_total_budget_usd,
          total_cost_usd = excluded.total_cost_usd,
          consecutive_no_improve_count = excluded.consecutive_no_improve_count,
          active_ticket_id = excluded.active_ticket_id,
          pause_reason = excluded.pause_reason,
          delivered_pr_url = excluded.delivered_pr_url,
          delivered_commit_sha = excluded.delivered_commit_sha,
          status = excluded.status,
          updated_at = excluded.updated_at`,
      )
      .run(
        campaign.id,
        campaign.repoId,
        campaign.name,
        campaign.goalPrompt,
        campaign.metricCommand,
        campaign.metricRegex ?? null,
        campaign.metricUnit ?? null,
        campaign.direction,
        campaign.baselineValue ?? null,
        campaign.currentValue ?? null,
        campaign.targetValue,
        campaign.deliveryMode,
        campaign.stagingBranch ?? null,
        campaign.lastGoodCommitSha ?? null,
        JSON.stringify(campaign.allowedPaths ?? ["**"]),
        campaign.template,
        campaign.preferredEngine ?? null,
        campaign.maxIterations,
        campaign.completedWaves,
        campaign.maxTotalBudgetUsd,
        campaign.totalCostUsd,
        campaign.consecutiveNoImproveCount,
        campaign.activeTicketId ?? null,
        campaign.pauseReason ?? null,
        campaign.deliveredPrUrl ?? null,
        campaign.deliveredCommitSha ?? null,
        campaign.status,
        campaign.createdAt,
        campaign.updatedAt,
      );
  }

  async getCampaign(id: string): Promise<GoalCampaign | null> {
    const row = this.db
      .query("SELECT * FROM goal_campaigns WHERE id = ?")
      .get(id) as Record<string, unknown> | null;
    return row ? mapGoalCampaignRow(row) : null;
  }

  async listCampaigns(repoId?: string): Promise<GoalCampaign[]> {
    const rows = (
      repoId
        ? this.db
            .query("SELECT * FROM goal_campaigns WHERE repo_id = ? ORDER BY created_at DESC")
            .all(repoId)
        : this.db.query("SELECT * FROM goal_campaigns ORDER BY created_at DESC").all()
    ) as Record<string, unknown>[];
    return rows.map(mapGoalCampaignRow);
  }

  async deleteCampaign(id: string): Promise<boolean> {
    const tx = this.db.transaction(() => {
      this.db.query("DELETE FROM goal_campaign_waves WHERE campaign_id = ?").run(id);
      return this.db.query("DELETE FROM goal_campaigns WHERE id = ?").run(id);
    });
    const res = tx();
    return Number(res.changes ?? 0) > 0;
  }

  async saveCampaignWave(wave: GoalCampaignWave): Promise<void> {
    this.db
      .query(
        `INSERT INTO goal_campaign_waves (
          id, campaign_id, repo_id, wave_number, ticket_id, status,
          before_value, measured_value, delta, commit_sha, rolled_back,
          cost_usd, summary, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          ticket_id = excluded.ticket_id,
          status = excluded.status,
          before_value = excluded.before_value,
          measured_value = excluded.measured_value,
          delta = excluded.delta,
          commit_sha = excluded.commit_sha,
          rolled_back = excluded.rolled_back,
          cost_usd = excluded.cost_usd,
          summary = excluded.summary,
          completed_at = excluded.completed_at`,
      )
      .run(
        wave.id,
        wave.campaignId,
        wave.repoId,
        wave.waveNumber,
        wave.ticketId ?? null,
        wave.status,
        wave.beforeValue,
        wave.measuredValue ?? null,
        wave.delta ?? null,
        wave.commitSha ?? null,
        wave.rolledBack ? 1 : 0,
        wave.costUsd,
        wave.summary,
        wave.startedAt,
        wave.completedAt ?? null,
      );
  }

  async listCampaignWaves(campaignId: string): Promise<GoalCampaignWave[]> {
    const rows = this.db
      .query("SELECT * FROM goal_campaign_waves WHERE campaign_id = ? ORDER BY wave_number ASC")
      .all(campaignId) as Record<string, unknown>[];
    return rows.map(mapGoalCampaignWaveRow);
  }

  // --- Speculative Merge Train (v1.2.0 Pillar B) ---
  async saveMergeTrainEntry(entry: MergeTrainEntry): Promise<void> {
    this.db
      .query(
        `INSERT INTO merge_train_entries (
          id, repo_id, ticket_id, outbox_id, branch_name, base_branch, barrier_group_id,
          position, status, bypassed_speculation, speculative_commit_sha, merged_commit_sha,
          error_summary, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          position = excluded.position,
          bypassed_speculation = excluded.bypassed_speculation,
          speculative_commit_sha = excluded.speculative_commit_sha,
          merged_commit_sha = excluded.merged_commit_sha,
          error_summary = excluded.error_summary,
          updated_at = excluded.updated_at`,
      )
      .run(
        entry.id,
        entry.repoId,
        entry.ticketId,
        entry.outboxId,
        entry.branchName,
        entry.baseBranch,
        entry.barrierGroupId ?? null,
        entry.position,
        entry.status,
        entry.bypassedSpeculation ? 1 : 0,
        entry.speculativeCommitSha ?? null,
        entry.mergedCommitSha ?? null,
        entry.errorSummary ?? null,
        entry.createdAt,
        entry.updatedAt,
      );
  }

  async getMergeTrainEntry(id: string): Promise<MergeTrainEntry | null> {
    const row = this.db
      .query("SELECT * FROM merge_train_entries WHERE id = ?")
      .get(id) as Record<string, unknown> | null;
    return row ? mapMergeTrainEntryRow(row) : null;
  }

  async listMergeTrainEntries(filter?: {
    repoId?: string;
    barrierGroupId?: string;
    status?: MergeTrainEntryStatus;
  }): Promise<MergeTrainEntry[]> {
    const conds: string[] = [];
    const params: string[] = [];
    if (filter?.repoId) {
      conds.push("repo_id = ?");
      params.push(filter.repoId);
    }
    if (filter?.barrierGroupId) {
      conds.push("barrier_group_id = ?");
      params.push(filter.barrierGroupId);
    }
    if (filter?.status) {
      conds.push("status = ?");
      params.push(filter.status);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const rows = this.db
      .query(`SELECT * FROM merge_train_entries ${where} ORDER BY position ASC, created_at ASC`)
      .all(...params) as Record<string, unknown>[];
    return rows.map(mapMergeTrainEntryRow);
  }

  async nextMergeTrainPosition(repoId: string): Promise<number> {
    const row = this.db
      .query("SELECT COALESCE(MAX(position), 0) AS max_pos FROM merge_train_entries WHERE repo_id = ?")
      .get(repoId) as { max_pos: number } | null;
    return Number(row?.max_pos ?? 0) + 1;
  }

  // --- System Settings ---
  async getSystemSetting<T>(key: string): Promise<T | null> {
    const row = this.db
      .query("SELECT value_json FROM system_settings WHERE key = ?")
      .get(key) as { value_json: string } | null;
    if (!row) return null;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return null;
    }
  }

  async setSystemSetting<T>(key: string, value: T): Promise<void> {
    this.db
      .query(
        `INSERT INTO system_settings (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), new Date().toISOString());
  }
}
