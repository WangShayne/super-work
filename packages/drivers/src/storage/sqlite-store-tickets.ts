// Repos, triggers, threads, tickets, stage runs and artifacts storage helpers (extracted from sqlite-state-store.ts).
import type { Database } from "bun:sqlite";
import type {
  RepoConfig,
  SpillArtifact,
  StageRun,
  Thread,
  Ticket,
  TicketStatus,
  Trigger,
} from "@super-work/core";
import { TERMINAL_TICKET_STATUSES } from "@super-work/core";
import {
  mapArtifactRow,
  mapRepoRow,
  mapStageRunRow,
  mapThreadRow,
  mapTicketRow,
  mapTriggerRow,
} from "./sqlite-mappers.ts";

export function upsertRepo(db: Database, repo: RepoConfig): void {
  db
    .query(
      `INSERT INTO repos (
        id, name, root_path, base_branch, mode, github_repo, default_template, default_tdd_mode,
        preferred_implement_engine, preferred_review_engine, fallback_engines_json, auto_cleanup_worktree,
        verification_commands_json, setup_commands_json, hooks_json, smoke_check_json, preview_command, sandbox_mode, forbidden_paths_json,
        conventions, contract_synced_hash, contract_synced_at,
        default_delivery_channel,
        max_concurrent_workers, daily_budget_usd, daily_budget_override_usd, daily_budget_override_date,
        delivery_gate_policy, risk_threshold, sensitive_paths_json, blueprints_json,
        verification_strategy,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        verification_strategy = excluded.verification_strategy,
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
      repo.verificationStrategy ?? null,
      repo.createdAt,
      repo.updatedAt,
    );
}

export function getRepo(db: Database, id: string): RepoConfig | null {
  const row = db.query("SELECT * FROM repos WHERE id = ?").get(id) as Record<string, unknown> | null;
  return row ? mapRepoRow(row) : null;
}

export function listRepos(db: Database): RepoConfig[] {
  const rows = db.query("SELECT * FROM repos ORDER BY created_at ASC").all() as Record<string, unknown>[];
  return rows.map(mapRepoRow);
}

export function saveTrigger(db: Database, trigger: Trigger): void {
  db
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

export function getTrigger(db: Database, id: string): Trigger | null {
  const row = db.query("SELECT * FROM triggers WHERE id = ?").get(id) as Record<string, unknown> | null;
  return row ? mapTriggerRow(row) : null;
}

export function findTriggerByExternalRef(db: Database, repoId: string, externalRef: string): Trigger | null {
  const row = db
    .query("SELECT * FROM triggers WHERE repo_id = ? AND external_ref = ?")
    .get(repoId, externalRef) as Record<string, unknown> | null;
  return row ? mapTriggerRow(row) : null;
}

export async function listTriggersByThread(db: Database, threadId: string): Promise<Trigger[]> {
  const thread = await getThread(db, threadId);
  if (!thread) return [];
  const rows = db
    .query("SELECT * FROM triggers WHERE repo_id = ? AND thread_key = ? ORDER BY created_at ASC")
    .all(thread.repoId, thread.threadKey) as Record<string, unknown>[];
  return rows.map(mapTriggerRow);
}

export function upsertThread(db: Database, thread: Thread): void {
  db
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

export function getThread(db: Database, id: string): Thread | null {
  const row = db.query("SELECT * FROM threads WHERE id = ?").get(id) as Record<string, unknown> | null;
  return row ? mapThreadRow(row) : null;
}

export function getThreadByKey(db: Database, repoId: string, threadKey: string): Thread | null {
  const row = db
    .query("SELECT * FROM threads WHERE repo_id = ? AND thread_key = ?")
    .get(repoId, threadKey) as Record<string, unknown> | null;
  return row ? mapThreadRow(row) : null;
}

export function saveTicket(db: Database, ticket: Ticket): void {
  db
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
        tdd_mode, locked_test_paths_json, refactor_guard_json, spec_test_commit_sha, spec_test_challenge_count,
        task_category, routing_rationale, auto_arena_escalated, impact_summary_json, pause_before_run,
        blueprint_id, delivery_gate_policy, risk_threshold, risk_assessment_json, conflict_resolution_count, conflict_context_json,
        clarification_count, steer_count,
        routine_id, campaign_id, milestone_id, campaign_wave, target_branch, barrier_group_id, base_head_at_rebase,
        epic_replan_count, epic_replan_history_json, pending_epic_replan_json,
        model_override, effort_override,
        inline_memory_json, handover_digest_json, cost_usd, priority, error_message, created_at, updated_at
      ) VALUES (?, ?, ?,?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        refactor_guard_json = excluded.refactor_guard_json,
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
        milestone_id = excluded.milestone_id,
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
      ticket.refactorGuard ? JSON.stringify(ticket.refactorGuard) : null,
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
      ticket.milestoneId ?? null,
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

export function getTicket(db: Database, id: string): Ticket | null {
  const row = db.query("SELECT * FROM tickets WHERE id = ?").get(id) as Record<string, unknown> | null;
  return row ? mapTicketRow(row) : null;
}

export function listTickets(db: Database, filter?: { repoId?: string; status?: TicketStatus }): Ticket[] {
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
  const rows = db
    .query(`SELECT * FROM tickets ${where} ORDER BY priority DESC, created_at ASC`)
    .all(...params) as Record<string, unknown>[];
  return rows.map(mapTicketRow);
}

export function listActiveTickets(db: Database, repoId: string): Ticket[] {
  const terminal = Array.from(TERMINAL_TICKET_STATUSES);
  const placeholders = terminal.map(() => "?").join(", ");
  const rows = db
    .query(
      `SELECT * FROM tickets WHERE repo_id = ? AND status NOT IN (${placeholders}) ORDER BY created_at ASC`,
    )
    .all(repoId, ...terminal) as Record<string, unknown>[];
  return rows.map(mapTicketRow);
}

export function saveStageRun(db: Database, stageRun: StageRun): void {
  db
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

export function getStageRun(db: Database, id: string): StageRun | null {
  const row = db.query("SELECT * FROM stage_runs WHERE id = ?").get(id) as Record<string, unknown> | null;
  return row ? mapStageRunRow(row) : null;
}

export function listStageRuns(db: Database, ticketId: string): StageRun[] {
  const rows = db
    .query("SELECT * FROM stage_runs WHERE ticket_id = ? ORDER BY started_at ASC")
    .all(ticketId) as Record<string, unknown>[];
  return rows.map(mapStageRunRow);
}

export function saveArtifact(db: Database, artifact: SpillArtifact, indexBody?: string): void {
  const tx = db.transaction(() => {
    db
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
      const ticket = db
        .query("SELECT repo_id FROM tickets WHERE id = ?")
        .get(artifact.ticketId) as { repo_id: string } | null;
      if (ticket) {
        db
          .query("DELETE FROM memory_fts WHERE entity_type = ? AND entity_id = ?")
          .run("artifact", artifact.id);
        db
          .query(
            "INSERT INTO memory_fts (entity_type, entity_id, ticket_id, repo_id, title, body) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run("artifact", artifact.id, artifact.ticketId, ticket.repo_id, artifact.summary, indexBody);
      }
    }
  });
  tx();
}

export function getArtifact(db: Database, id: string): SpillArtifact | null {
  const row = db.query("SELECT * FROM artifacts WHERE id = ?").get(id) as Record<string, unknown> | null;
  return row ? mapArtifactRow(row) : null;
}

export function listArtifacts(db: Database, ticketId: string): SpillArtifact[] {
  const rows = db
    .query("SELECT * FROM artifacts WHERE ticket_id = ? ORDER BY created_at ASC")
    .all(ticketId) as Record<string, unknown>[];
  return rows.map(mapArtifactRow);
}
