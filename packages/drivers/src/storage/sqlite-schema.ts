import type { Database } from "bun:sqlite";

function ensureColumn(
  db: Database,
  existingCols: Set<string>,
  table: string,
  column: string,
  definition: string,
): void {
  if (!existingCols.has(column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

export function initializeSqliteSchema(db: Database): void {
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA foreign_keys = ON;");
  db.run("PRAGMA busy_timeout = 5000;");

  db.run(`
    CREATE TABLE IF NOT EXISTS repos (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      mode TEXT NOT NULL,
      github_repo TEXT,
      default_template TEXT NOT NULL,
      preferred_implement_engine TEXT NOT NULL,
      preferred_review_engine TEXT NOT NULL,
      auto_cleanup_worktree INTEGER NOT NULL DEFAULT 1,
      verification_commands_json TEXT NOT NULL DEFAULT '[]',
      default_delivery_channel TEXT NOT NULL DEFAULT 'auto_pr_or_branch',
      max_concurrent_workers INTEGER,
      daily_budget_usd REAL,
      daily_budget_override_usd REAL,
      daily_budget_override_date TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS triggers (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      source TEXT NOT NULL,
      external_ref TEXT,
      thread_key TEXT NOT NULL,
      title TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_triggers_extref
      ON triggers(repo_id, external_ref)
      WHERE external_ref IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_triggers_thread
      ON triggers(repo_id, thread_key, created_at);

    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      thread_key TEXT NOT NULL,
      subscribed_ticket_id TEXT,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(repo_id, thread_key)
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      source_trigger_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      template TEXT NOT NULL,
      current_stage TEXT NOT NULL,
      stage_retries INTEGER NOT NULL DEFAULT 0,
      mandate_json TEXT NOT NULL,
      depends_on_json TEXT NOT NULL,
      parent_ticket_id TEXT,
      is_epic INTEGER NOT NULL DEFAULT 0,
      subtask_key TEXT,
      epic_delivery_mode TEXT,
      pr_number INTEGER,
      pr_url TEXT,
      pr_auto_followup_count INTEGER NOT NULL DEFAULT 0,
      pending_violation_paths_json TEXT,
      worktree_path TEXT,
      branch_name TEXT,
      worktree_cleaned_at TEXT,
      native_sessions_json TEXT NOT NULL,
      preferred_engine TEXT,
      active_engine TEXT,
      model_override TEXT,
      effort_override TEXT,
      inline_memory_json TEXT NOT NULL,
      cost_usd REAL NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 1,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tickets_repo_status
      ON tickets(repo_id, status, priority DESC, created_at ASC);

    CREATE TABLE IF NOT EXISTS stage_runs (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      engine TEXT NOT NULL,
      status TEXT NOT NULL,
      native_session_id TEXT,
      cost_usd REAL NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      summary TEXT,
      spill_transcript_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_stage_runs_ticket
      ON stage_runs(ticket_id, started_at ASC);

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      stage_run_id TEXT,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      storage_uri TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_ticket
      ON artifacts(ticket_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS inbox_items (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      ticket_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      context_payload_json TEXT NOT NULL,
      resolution_note TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_status
      ON inbox_items(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS outbox_entries (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      ticket_id TEXT NOT NULL,
      action TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      last_error TEXT,
      result_payload_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_pending
      ON outbox_entries(status, next_attempt_at);

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      entity_type,
      entity_id,
      ticket_id,
      repo_id,
      title,
      body
    );

    CREATE TABLE IF NOT EXISTS playbook_entries (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      rule TEXT NOT NULL,
      scope_paths_json TEXT NOT NULL DEFAULT '["**"]',
      source TEXT NOT NULL,
      source_ticket_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      pinned INTEGER NOT NULL DEFAULT 0,
      hit_count INTEGER NOT NULL DEFAULT 0,
      last_matched_at TEXT,
      suspect INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_playbook_repo
      ON playbook_entries(repo_id, enabled, pinned, updated_at DESC);

    CREATE TABLE IF NOT EXISTS routines (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_kind TEXT NOT NULL,
      interval_minutes INTEGER,
      cron_expr TEXT,
      active_hours_start TEXT,
      active_hours_end TEXT,
      allowed_paths_json TEXT NOT NULL DEFAULT '["**"]',
      template TEXT NOT NULL,
      preferred_engine TEXT,
      max_budget_usd REAL NOT NULL DEFAULT 1.5,
      enabled INTEGER NOT NULL DEFAULT 1,
      active_ticket_id TEXT,
      last_run_at TEXT,
      last_run_status TEXT,
      next_run_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_routines_repo
      ON routines(repo_id, enabled, next_run_at);

    CREATE TABLE IF NOT EXISTS routine_runs (
      id TEXT PRIMARY KEY,
      routine_id TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL,
      changed_files_json TEXT NOT NULL DEFAULT '[]',
      promoted_ticket_id TEXT,
      cost_usd REAL NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_routine_runs_routine
      ON routine_runs(routine_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS casebook_entries (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      ticket_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      goal_summary TEXT NOT NULL,
      solution_summary TEXT NOT NULL,
      pitfalls_and_fixes TEXT,
      changed_files_json TEXT NOT NULL DEFAULT '[]',
      scope_paths_json TEXT NOT NULL DEFAULT '["**"]',
      exported_symbols_json TEXT NOT NULL DEFAULT '[]',
      reverted INTEGER NOT NULL DEFAULT 0,
      hit_count INTEGER NOT NULL DEFAULT 0,
      last_matched_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_casebook_repo
      ON casebook_entries(repo_id, reverted, updated_at DESC);

    CREATE TABLE IF NOT EXISTS flight_events (
      id TEXT PRIMARY KEY,
      repo_id TEXT,
      ticket_id TEXT,
      kind TEXT NOT NULL,
      engine TEXT,
      summary TEXT NOT NULL,
      saved_ms INTEGER,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_flight_events_created
      ON flight_events(created_at DESC);

    CREATE TABLE IF NOT EXISTS engine_health (
      engine TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      failure_kind TEXT,
      reason TEXT,
      tripped_at TEXT,
      cooldown_until TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_probed_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS milestones (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      name TEXT NOT NULL,
      target_version TEXT,
      status TEXT NOT NULL,
      items_json TEXT NOT NULL,
      release_notes_zh TEXT,
      release_notes_en TEXT,
      digest_summary TEXT,
      released_commit_sha TEXT,
      released_tag TEXT,
      integration_mode TEXT,
      staging_branch TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_milestones_repo
      ON milestones(repo_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ticket_checkpoints (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      stage_run_id TEXT,
      stage TEXT NOT NULL,
      engine TEXT,
      label TEXT NOT NULL,
      git_ref TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      changed_files_json TEXT NOT NULL DEFAULT '[]',
      verification_passed INTEGER,
      created_at TEXT NOT NULL,
      cleaned_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_checkpoints_ticket
      ON ticket_checkpoints(ticket_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS ticket_review_comments (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      line INTEGER NOT NULL,
      side TEXT,
      code_snippet TEXT,
      author TEXT NOT NULL,
      severity TEXT,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_review_comments_ticket
      ON ticket_review_comments(ticket_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS eval_cases (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      source_ticket_id TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      base_commit_sha TEXT NOT NULL,
      allowed_paths_json TEXT NOT NULL,
      forbidden_paths_json TEXT NOT NULL,
      tdd_mode INTEGER NOT NULL DEFAULT 0,
      locked_test_paths_json TEXT,
      verification_commands_json TEXT NOT NULL DEFAULT '[]',
      smoke_check_json TEXT,
      reference_metrics_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_eval_cases_repo
      ON eval_cases(repo_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS eval_runs (
      id TEXT PRIMARY KEY,
      eval_case_id TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      status TEXT NOT NULL,
      engines_json TEXT NOT NULL,
      results_json TEXT NOT NULL,
      max_budget_usd REAL NOT NULL,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_eval_runs_case
      ON eval_runs(eval_case_id, started_at DESC);

    -- v1.2.0 Goal Campaigns (Pillar A)
    CREATE TABLE IF NOT EXISTS goal_campaigns (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      name TEXT NOT NULL,
      goal_prompt TEXT NOT NULL,
      metric_command TEXT NOT NULL,
      metric_regex TEXT,
      metric_unit TEXT,
      direction TEXT NOT NULL,
      baseline_value REAL,
      current_value REAL,
      target_value REAL NOT NULL,
      delivery_mode TEXT NOT NULL DEFAULT 'staging_branch',
      staging_branch TEXT,
      last_good_commit_sha TEXT,
      allowed_paths_json TEXT NOT NULL DEFAULT '["**"]',
      template TEXT NOT NULL DEFAULT 'fast',
      preferred_engine TEXT,
      max_iterations INTEGER NOT NULL DEFAULT 5,
      completed_waves INTEGER NOT NULL DEFAULT 0,
      max_total_budget_usd REAL NOT NULL DEFAULT 5.0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      consecutive_no_improve_count INTEGER NOT NULL DEFAULT 0,
      active_ticket_id TEXT,
      pause_reason TEXT,
      delivered_pr_url TEXT,
      delivered_commit_sha TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_campaigns_repo_status
      ON goal_campaigns(repo_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS goal_campaign_waves (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      wave_number INTEGER NOT NULL,
      ticket_id TEXT,
      status TEXT NOT NULL,
      before_value REAL NOT NULL,
      measured_value REAL,
      delta REAL,
      commit_sha TEXT,
      rolled_back INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      summary TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_campaign_waves_campaign
      ON goal_campaign_waves(campaign_id, wave_number ASC);

    -- v1.2.0 Speculative Merge Train & Cross-Repo Barrier (Pillar B)
    CREATE TABLE IF NOT EXISTS merge_train_entries (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      ticket_id TEXT NOT NULL,
      outbox_id TEXT NOT NULL UNIQUE,
      branch_name TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      barrier_group_id TEXT,
      position INTEGER NOT NULL,
      status TEXT NOT NULL,
      bypassed_speculation INTEGER NOT NULL DEFAULT 0,
      speculative_commit_sha TEXT,
      merged_commit_sha TEXT,
      error_summary TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_merge_train_repo_status
      ON merge_train_entries(repo_id, status, position ASC);
    CREATE INDEX IF NOT EXISTS idx_merge_train_barrier
      ON merge_train_entries(barrier_group_id, status);
  `);

  const repoCols = db.query("PRAGMA table_info(repos)").all() as Array<{ name: string }>;
  const existingRepoCols = new Set(repoCols.map((c) => c.name));
  ensureColumn(db, existingRepoCols, "repos", "auto_cleanup_worktree", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, existingRepoCols, "repos", "verification_commands_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, existingRepoCols, "repos", "default_delivery_channel", "TEXT NOT NULL DEFAULT 'auto_pr_or_branch'");
  ensureColumn(db, existingRepoCols, "repos", "max_concurrent_workers", "INTEGER");
  ensureColumn(db, existingRepoCols, "repos", "daily_budget_usd", "REAL");
  ensureColumn(db, existingRepoCols, "repos", "daily_budget_override_usd", "REAL");
  ensureColumn(db, existingRepoCols, "repos", "daily_budget_override_date", "TEXT");
  ensureColumn(db, existingRepoCols, "repos", "setup_commands_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, existingRepoCols, "repos", "forbidden_paths_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, existingRepoCols, "repos", "conventions", "TEXT");
  ensureColumn(db, existingRepoCols, "repos", "contract_synced_hash", "TEXT");
  ensureColumn(db, existingRepoCols, "repos", "implement_model_id", "TEXT");
  ensureColumn(db, existingRepoCols, "repos", "review_model_id", "TEXT");
  ensureColumn(db, existingRepoCols, "repos", "contract_synced_at", "TEXT");
  ensureColumn(db, existingRepoCols, "repos", "smoke_check_json", "TEXT");
  ensureColumn(db, existingRepoCols, "repos", "fallback_engines_json", "TEXT");
  ensureColumn(db, existingRepoCols, "repos", "sandbox_mode", "TEXT");
  ensureColumn(db, existingRepoCols, "repos", "preview_command", "TEXT");
  ensureColumn(db, existingRepoCols, "repos", "default_tdd_mode", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, existingRepoCols, "repos", "delivery_gate_policy", "TEXT");
  ensureColumn(db, existingRepoCols, "repos", "risk_threshold", "INTEGER");
  ensureColumn(db, existingRepoCols, "repos", "sensitive_paths_json", "TEXT");
  ensureColumn(db, existingRepoCols, "repos", "verification_strategy", "TEXT");
  ensureColumn(db, existingRepoCols, "repos", "blueprints_json", "TEXT");
  ensureColumn(db, existingRepoCols, "repos", "hooks_json", "TEXT");

  const ticketCols = db.query("PRAGMA table_info(tickets)").all() as Array<{ name: string }>;
  const existingCols = new Set(ticketCols.map((c) => c.name));
  ensureColumn(db, existingCols, "tickets", "preferred_engine", "TEXT");
  ensureColumn(db, existingCols, "tickets", "preferred_model_id", "TEXT");
  ensureColumn(db, existingCols, "tickets", "active_model_id", "TEXT");
  ensureColumn(db, existingCols, "tickets", "model_override", "TEXT");
  ensureColumn(db, existingCols, "tickets", "effort_override", "TEXT");
  ensureColumn(db, existingCols, "tickets", "worktree_cleaned_at", "TEXT");
  ensureColumn(db, existingCols, "tickets", "parent_ticket_id", "TEXT");
  ensureColumn(db, existingCols, "tickets", "is_epic", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, existingCols, "tickets", "subtask_key", "TEXT");
  ensureColumn(db, existingCols, "tickets", "epic_delivery_mode", "TEXT");
  ensureColumn(db, existingCols, "tickets", "pr_number", "INTEGER");
  ensureColumn(db, existingCols, "tickets", "pr_url", "TEXT");
  ensureColumn(db, existingCols, "tickets", "pr_auto_followup_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, existingCols, "tickets", "pending_violation_paths_json", "TEXT");
  ensureColumn(db, existingCols, "tickets", "merged_commit_sha", "TEXT");
  ensureColumn(db, existingCols, "tickets", "reverted_at", "TEXT");
  ensureColumn(db, existingCols, "tickets", "revert_commit_sha", "TEXT");
  ensureColumn(db, existingCols, "tickets", "handover_digest_json", "TEXT");
  ensureColumn(db, existingCols, "tickets", "routine_id", "TEXT");
  ensureColumn(db, existingCols, "tickets", "failed_engines_json", "TEXT");
  ensureColumn(db, existingCols, "tickets", "arena_mode", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, existingCols, "tickets", "arena_competitor_engine", "TEXT");
  ensureColumn(db, existingCols, "tickets", "arena_candidates_json", "TEXT");
  ensureColumn(db, existingCols, "tickets", "arena_winner_id", "TEXT");
  ensureColumn(db, existingCols, "tickets", "epic_replan_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, existingCols, "tickets", "epic_replan_history_json", "TEXT");
  ensureColumn(db, existingCols, "tickets", "pending_epic_replan_json", "TEXT");
  ensureColumn(db, existingCols, "tickets", "tdd_mode", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, existingCols, "tickets", "locked_test_paths_json", "TEXT");
  ensureColumn(db, existingCols, "tickets", "refactor_guard_json", "TEXT");
  ensureColumn(db, existingCols, "tickets", "spec_test_commit_sha", "TEXT");
  ensureColumn(db, existingCols, "tickets", "spec_test_challenge_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, existingCols, "tickets", "task_category", "TEXT");
  ensureColumn(db, existingCols, "tickets", "routing_rationale", "TEXT");
  ensureColumn(db, existingCols, "tickets", "auto_arena_escalated", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, existingCols, "tickets", "impact_summary_json", "TEXT");
  ensureColumn(db, existingCols, "tickets", "pause_before_run", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, existingCols, "tickets", "blueprint_id", "TEXT");
  ensureColumn(db, existingCols, "tickets", "delivery_gate_policy", "TEXT");
  ensureColumn(db, existingCols, "tickets", "risk_threshold", "INTEGER");
  ensureColumn(db, existingCols, "tickets", "risk_assessment_json", "TEXT");
  ensureColumn(db, existingCols, "tickets", "conflict_resolution_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, existingCols, "tickets", "conflict_context_json", "TEXT");
  ensureColumn(db, existingCols, "tickets", "clarification_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, existingCols, "tickets", "steer_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, existingCols, "tickets", "campaign_id", "TEXT");
  ensureColumn(db, existingCols, "tickets", "milestone_id", "TEXT");
  ensureColumn(db, existingCols, "tickets", "campaign_wave", "INTEGER");
  ensureColumn(db, existingCols, "tickets", "target_branch", "TEXT");
  ensureColumn(db, existingCols, "tickets", "barrier_group_id", "TEXT");
  ensureColumn(db, existingCols, "tickets", "base_head_at_rebase", "TEXT");

  const milestoneCols = db.query("PRAGMA table_info(milestones)").all() as Array<{ name: string }>;
  const existingMilestoneCols = new Set(milestoneCols.map((c) => c.name));
  ensureColumn(db, existingMilestoneCols, "milestones", "integration_mode", "TEXT");
  ensureColumn(db, existingMilestoneCols, "milestones", "staging_branch", "TEXT");

  const stageRunCols = db.query("PRAGMA table_info(stage_runs)").all() as Array<{ name: string }>;
  const existingStageRunCols = new Set(stageRunCols.map((c) => c.name));
  ensureColumn(db, existingStageRunCols, "stage_runs", "spans_json", "TEXT");
  ensureColumn(db, existingStageRunCols, "stage_runs", "tool_profile_json", "TEXT");
  ensureColumn(db, existingStageRunCols, "stage_runs", "steered", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, existingStageRunCols, "stage_runs", "model_profile_id", "TEXT");

  const playbookCols = db.query("PRAGMA table_info(playbook_entries)").all() as Array<{ name: string }>;
  const existingPlaybookCols = new Set(playbookCols.map((c) => c.name));
  ensureColumn(db, existingPlaybookCols, "playbook_entries", "hit_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, existingPlaybookCols, "playbook_entries", "last_matched_at", "TEXT");
  ensureColumn(db, existingPlaybookCols, "playbook_entries", "suspect", "INTEGER NOT NULL DEFAULT 0");
}
