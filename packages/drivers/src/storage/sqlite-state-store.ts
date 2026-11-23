import { Database } from "bun:sqlite";
import type {
  ChainOfRecall,
  EngineMetricRow,
  HandoverDigest,
  InboxItem,
  InboxItemStatus,
  MemorySearchHit,
  OutboxEntry,
  OutboxStatus,
  PlaybookEntry,
  RepoConfig,
  RepoMetricsSummary,
  SmokeCheckConfig,
  SpillArtifact,
  StageRun,
  StateStore,
  Thread,
  Ticket,
  TicketStatus,
  Trigger,
  WorkerEngineId,
} from "@super-work/core";
import { TERMINAL_TICKET_STATUSES } from "@super-work/core";

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
  readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.init();
  }

  close(): void {
    this.db.close();
  }

  private init(): void {
    this.db.run("PRAGMA journal_mode = WAL;");
    this.db.run("PRAGMA foreign_keys = ON;");
    this.db.run("PRAGMA busy_timeout = 5000;");

    this.db.run(`
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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_playbook_repo
        ON playbook_entries(repo_id, enabled, pinned, updated_at DESC);

      CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const repoCols = this.db
      .query("PRAGMA table_info(repos)")
      .all() as Array<{ name: string }>;
    const existingRepoCols = new Set(repoCols.map((c) => c.name));
    if (!existingRepoCols.has("auto_cleanup_worktree")) {
      this.db.run("ALTER TABLE repos ADD COLUMN auto_cleanup_worktree INTEGER NOT NULL DEFAULT 1;");
    }
    if (!existingRepoCols.has("verification_commands_json")) {
      this.db.run(
        "ALTER TABLE repos ADD COLUMN verification_commands_json TEXT NOT NULL DEFAULT '[]';",
      );
    }
    if (!existingRepoCols.has("default_delivery_channel")) {
      this.db.run(
        "ALTER TABLE repos ADD COLUMN default_delivery_channel TEXT NOT NULL DEFAULT 'auto_pr_or_branch';",
      );
    }
    if (!existingRepoCols.has("max_concurrent_workers")) {
      this.db.run("ALTER TABLE repos ADD COLUMN max_concurrent_workers INTEGER;");
    }
    if (!existingRepoCols.has("daily_budget_usd")) {
      this.db.run("ALTER TABLE repos ADD COLUMN daily_budget_usd REAL;");
    }
    if (!existingRepoCols.has("daily_budget_override_usd")) {
      this.db.run("ALTER TABLE repos ADD COLUMN daily_budget_override_usd REAL;");
    }
    if (!existingRepoCols.has("daily_budget_override_date")) {
      this.db.run("ALTER TABLE repos ADD COLUMN daily_budget_override_date TEXT;");
    }
    if (!existingRepoCols.has("setup_commands_json")) {
      this.db.run("ALTER TABLE repos ADD COLUMN setup_commands_json TEXT NOT NULL DEFAULT '[]';");
    }
    if (!existingRepoCols.has("forbidden_paths_json")) {
      this.db.run("ALTER TABLE repos ADD COLUMN forbidden_paths_json TEXT NOT NULL DEFAULT '[]';");
    }
    if (!existingRepoCols.has("conventions")) {
      this.db.run("ALTER TABLE repos ADD COLUMN conventions TEXT;");
    }
    if (!existingRepoCols.has("contract_synced_hash")) {
      this.db.run("ALTER TABLE repos ADD COLUMN contract_synced_hash TEXT;");
    }
    if (!existingRepoCols.has("contract_synced_at")) {
      this.db.run("ALTER TABLE repos ADD COLUMN contract_synced_at TEXT;");
    }
    if (!existingRepoCols.has("smoke_check_json")) {
      this.db.run("ALTER TABLE repos ADD COLUMN smoke_check_json TEXT;");
    }

    const cols = this.db
      .query("PRAGMA table_info(tickets)")
      .all() as Array<{ name: string }>;
    const existingCols = new Set(cols.map((c) => c.name));
    if (!existingCols.has("preferred_engine")) {
      this.db.run("ALTER TABLE tickets ADD COLUMN preferred_engine TEXT;");
    }
    if (!existingCols.has("model_override")) {
      this.db.run("ALTER TABLE tickets ADD COLUMN model_override TEXT;");
    }
    if (!existingCols.has("effort_override")) {
      this.db.run("ALTER TABLE tickets ADD COLUMN effort_override TEXT;");
    }
    if (!existingCols.has("worktree_cleaned_at")) {
      this.db.run("ALTER TABLE tickets ADD COLUMN worktree_cleaned_at TEXT;");
    }
    if (!existingCols.has("parent_ticket_id")) {
      this.db.run("ALTER TABLE tickets ADD COLUMN parent_ticket_id TEXT;");
    }
    if (!existingCols.has("is_epic")) {
      this.db.run("ALTER TABLE tickets ADD COLUMN is_epic INTEGER NOT NULL DEFAULT 0;");
    }
    if (!existingCols.has("subtask_key")) {
      this.db.run("ALTER TABLE tickets ADD COLUMN subtask_key TEXT;");
    }
    if (!existingCols.has("epic_delivery_mode")) {
      this.db.run("ALTER TABLE tickets ADD COLUMN epic_delivery_mode TEXT;");
    }
    if (!existingCols.has("pr_number")) {
      this.db.run("ALTER TABLE tickets ADD COLUMN pr_number INTEGER;");
    }
    if (!existingCols.has("pr_url")) {
      this.db.run("ALTER TABLE tickets ADD COLUMN pr_url TEXT;");
    }
    if (!existingCols.has("pr_auto_followup_count")) {
      this.db.run(
        "ALTER TABLE tickets ADD COLUMN pr_auto_followup_count INTEGER NOT NULL DEFAULT 0;",
      );
    }
    if (!existingCols.has("pending_violation_paths_json")) {
      this.db.run("ALTER TABLE tickets ADD COLUMN pending_violation_paths_json TEXT;");
    }
    if (!existingCols.has("merged_commit_sha")) {
      this.db.run("ALTER TABLE tickets ADD COLUMN merged_commit_sha TEXT;");
    }
    if (!existingCols.has("reverted_at")) {
      this.db.run("ALTER TABLE tickets ADD COLUMN reverted_at TEXT;");
    }
    if (!existingCols.has("revert_commit_sha")) {
      this.db.run("ALTER TABLE tickets ADD COLUMN revert_commit_sha TEXT;");
    }
    if (!existingCols.has("handover_digest_json")) {
      this.db.run("ALTER TABLE tickets ADD COLUMN handover_digest_json TEXT;");
    }
  }

  // --- Repos ---
  async upsertRepo(repo: RepoConfig): Promise<void> {
    this.db
      .query(
        `INSERT INTO repos (
          id, name, root_path, base_branch, mode, github_repo, default_template,
          preferred_implement_engine, preferred_review_engine, auto_cleanup_worktree,
          verification_commands_json, setup_commands_json, smoke_check_json, forbidden_paths_json,
          conventions, contract_synced_hash, contract_synced_at,
          default_delivery_channel,
          max_concurrent_workers, daily_budget_usd, daily_budget_override_usd, daily_budget_override_date,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          root_path = excluded.root_path,
          base_branch = excluded.base_branch,
          mode = excluded.mode,
          github_repo = excluded.github_repo,
          default_template = excluded.default_template,
          preferred_implement_engine = excluded.preferred_implement_engine,
          preferred_review_engine = excluded.preferred_review_engine,
          auto_cleanup_worktree = excluded.auto_cleanup_worktree,
          verification_commands_json = excluded.verification_commands_json,
          setup_commands_json = excluded.setup_commands_json,
          smoke_check_json = excluded.smoke_check_json,
          forbidden_paths_json = excluded.forbidden_paths_json,
          conventions = excluded.conventions,
          contract_synced_hash = excluded.contract_synced_hash,
          contract_synced_at = excluded.contract_synced_at,
          default_delivery_channel = excluded.default_delivery_channel,
          max_concurrent_workers = excluded.max_concurrent_workers,
          daily_budget_usd = excluded.daily_budget_usd,
          daily_budget_override_usd = excluded.daily_budget_override_usd,
          daily_budget_override_date = excluded.daily_budget_override_date,
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
        repo.preferredImplementEngine,
        repo.preferredReviewEngine,
        repo.autoCleanupWorktree === false ? 0 : 1,
        JSON.stringify(repo.verificationCommands ?? []),
        JSON.stringify(repo.setupCommands ?? []),
        repo.smokeCheck ? JSON.stringify(repo.smokeCheck) : null,
        JSON.stringify(repo.forbiddenPaths ?? []),
        repo.conventions ?? null,
        repo.contractSyncedHash ?? null,
        repo.contractSyncedAt ?? null,
        repo.defaultDeliveryChannel ?? "auto_pr_or_branch",
        repo.maxConcurrentWorkers ?? null,
        repo.dailyBudgetUsd ?? null,
        repo.dailyBudgetOverrideUsd ?? null,
        repo.dailyBudgetOverrideDate ?? null,
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
          native_sessions_json, preferred_engine, active_engine, model_override, effort_override,
          inline_memory_json, handover_digest_json, cost_usd, priority, error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
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
          started_at, completed_at, summary, spill_transcript_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          native_session_id = excluded.native_session_id,
          cost_usd = excluded.cost_usd,
          completed_at = excluded.completed_at,
          summary = excluded.summary,
          spill_transcript_id = excluded.spill_transcript_id`,
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

  async claimNextOutboxEntries(limit: number, nowIso: string): Promise<OutboxEntry[]> {
    const claimTx = this.db.transaction((): OutboxEntry[] => {
      const rows = this.db
        .query(
          `SELECT * FROM outbox_entries
           WHERE status = 'pending' AND next_attempt_at <= ?
           ORDER BY created_at ASC
           LIMIT ?`,
        )
        .all(nowIso, limit) as Record<string, unknown>[];

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

  // --- Daily Budget & Metrics ---
  async getDailyRepoSpendUsd(repoId: string, utcDatePrefix: string): Promise<number> {
    const row = this.db
      .query(
        `SELECT COALESCE(SUM(sr.cost_usd), 0) AS total
         FROM stage_runs sr
         JOIN tickets t ON t.id = sr.ticket_id
         WHERE t.repo_id = ? AND sr.started_at LIKE ?`,
      )
      .get(repoId, `${utcDatePrefix}%`) as { total: number } | null;
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
        .query("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM stage_runs WHERE started_at LIKE ?")
        .get(`${todayDate}%`) as { total: number } | null;
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
          enabled, pinned, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          rule = excluded.rule,
          scope_paths_json = excluded.scope_paths_json,
          source = excluded.source,
          source_ticket_id = excluded.source_ticket_id,
          enabled = excluded.enabled,
          pinned = excluded.pinned,
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

function mapRepoRow(r: Record<string, unknown>): RepoConfig {
  return {
    id: String(r.id),
    name: String(r.name),
    rootPath: String(r.root_path),
    baseBranch: String(r.base_branch),
    mode: r.mode as RepoConfig["mode"],
    githubRepo: r.github_repo ? String(r.github_repo) : undefined,
    defaultTemplate: r.default_template as RepoConfig["defaultTemplate"],
    preferredImplementEngine: r.preferred_implement_engine as RepoConfig["preferredImplementEngine"],
    preferredReviewEngine: r.preferred_review_engine as RepoConfig["preferredReviewEngine"],
    autoCleanupWorktree:
      r.auto_cleanup_worktree === undefined || r.auto_cleanup_worktree === null
        ? true
        : Boolean(r.auto_cleanup_worktree),
    verificationCommands: r.verification_commands_json
      ? (JSON.parse(String(r.verification_commands_json)) as string[])
      : [],
    setupCommands: r.setup_commands_json
      ? (JSON.parse(String(r.setup_commands_json)) as string[])
      : [],
    smokeCheck: r.smoke_check_json
      ? (JSON.parse(String(r.smoke_check_json)) as SmokeCheckConfig)
      : undefined,
    forbiddenPaths: r.forbidden_paths_json
      ? (JSON.parse(String(r.forbidden_paths_json)) as string[])
      : [],
    conventions: r.conventions ? String(r.conventions) : undefined,
    contractSyncedHash: r.contract_synced_hash ? String(r.contract_synced_hash) : undefined,
    contractSyncedAt: r.contract_synced_at ? String(r.contract_synced_at) : undefined,
    defaultDeliveryChannel: (r.default_delivery_channel
      ? String(r.default_delivery_channel)
      : "auto_pr_or_branch") as RepoConfig["defaultDeliveryChannel"],
    maxConcurrentWorkers:
      r.max_concurrent_workers !== null && r.max_concurrent_workers !== undefined
        ? Number(r.max_concurrent_workers)
        : undefined,
    dailyBudgetUsd:
      r.daily_budget_usd !== null && r.daily_budget_usd !== undefined
        ? Number(r.daily_budget_usd)
        : undefined,
    dailyBudgetOverrideUsd:
      r.daily_budget_override_usd !== null && r.daily_budget_override_usd !== undefined
        ? Number(r.daily_budget_override_usd)
        : undefined,
    dailyBudgetOverrideDate: r.daily_budget_override_date
      ? String(r.daily_budget_override_date)
      : undefined,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapTriggerRow(r: Record<string, unknown>): Trigger {
  return {
    id: String(r.id),
    repoId: String(r.repo_id),
    source: r.source as Trigger["source"],
    externalRef: r.external_ref ? String(r.external_ref) : undefined,
    threadKey: String(r.thread_key),
    title: String(r.title),
    payload: JSON.parse(String(r.payload_json)),
    rawText: String(r.raw_text),
    createdAt: String(r.created_at),
  };
}

function mapThreadRow(r: Record<string, unknown>): Thread {
  return {
    id: String(r.id),
    repoId: String(r.repo_id),
    threadKey: String(r.thread_key),
    subscribedTicketId: r.subscribed_ticket_id ? String(r.subscribed_ticket_id) : undefined,
    metadata: JSON.parse(String(r.metadata_json)),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapTicketRow(r: Record<string, unknown>): Ticket {
  return {
    id: String(r.id),
    repoId: String(r.repo_id),
    threadId: String(r.thread_id),
    sourceTriggerId: String(r.source_trigger_id),
    title: String(r.title),
    description: String(r.description),
    status: r.status as Ticket["status"],
    template: r.template as Ticket["template"],
    currentStage: r.current_stage as Ticket["currentStage"],
    stageRetries: Number(r.stage_retries),
    mandate: JSON.parse(String(r.mandate_json)),
    dependsOn: JSON.parse(String(r.depends_on_json)),
    parentTicketId: r.parent_ticket_id ? String(r.parent_ticket_id) : undefined,
    isEpic: Boolean(r.is_epic),
    subtaskKey: r.subtask_key ? String(r.subtask_key) : undefined,
    epicDeliveryMode: r.epic_delivery_mode
      ? (String(r.epic_delivery_mode) as Ticket["epicDeliveryMode"])
      : undefined,
    prNumber:
      r.pr_number !== null && r.pr_number !== undefined ? Number(r.pr_number) : undefined,
    prUrl: r.pr_url ? String(r.pr_url) : undefined,
    prAutoFollowupCount:
      r.pr_auto_followup_count !== null && r.pr_auto_followup_count !== undefined
        ? Number(r.pr_auto_followup_count)
        : undefined,
    pendingViolationPaths: r.pending_violation_paths_json
      ? (JSON.parse(String(r.pending_violation_paths_json)) as string[])
      : undefined,
    mergedCommitSha: r.merged_commit_sha ? String(r.merged_commit_sha) : undefined,
    revertedAt: r.reverted_at ? String(r.reverted_at) : undefined,
    revertCommitSha: r.revert_commit_sha ? String(r.revert_commit_sha) : undefined,
    worktreePath: r.worktree_path ? String(r.worktree_path) : undefined,
    branchName: r.branch_name ? String(r.branch_name) : undefined,
    worktreeCleanedAt: r.worktree_cleaned_at ? String(r.worktree_cleaned_at) : undefined,
    nativeSessions: JSON.parse(String(r.native_sessions_json)),
    preferredEngine: r.preferred_engine
      ? (String(r.preferred_engine) as Ticket["preferredEngine"])
      : undefined,
    activeEngine: r.active_engine ? (String(r.active_engine) as Ticket["activeEngine"]) : undefined,
    modelOverride: r.model_override ? String(r.model_override) : undefined,
    effortOverride: r.effort_override
      ? (String(r.effort_override) as Ticket["effortOverride"])
      : undefined,
    inlineMemory: JSON.parse(String(r.inline_memory_json)),
    handoverDigest: r.handover_digest_json
      ? (JSON.parse(String(r.handover_digest_json)) as HandoverDigest)
      : undefined,
    costUsd: Number(r.cost_usd),
    priority: Number(r.priority),
    errorMessage: r.error_message ? String(r.error_message) : undefined,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapStageRunRow(r: Record<string, unknown>): StageRun {
  return {
    id: String(r.id),
    ticketId: String(r.ticket_id),
    stage: r.stage as StageRun["stage"],
    engine: r.engine as StageRun["engine"],
    status: r.status as StageRun["status"],
    nativeSessionId: r.native_session_id ? String(r.native_session_id) : undefined,
    costUsd: Number(r.cost_usd),
    startedAt: String(r.started_at),
    completedAt: r.completed_at ? String(r.completed_at) : undefined,
    summary: r.summary ? String(r.summary) : undefined,
    spillTranscriptId: r.spill_transcript_id ? String(r.spill_transcript_id) : undefined,
  };
}

function mapArtifactRow(r: Record<string, unknown>): SpillArtifact {
  return {
    id: String(r.id),
    ticketId: String(r.ticket_id),
    stageRunId: r.stage_run_id ? String(r.stage_run_id) : undefined,
    kind: r.kind as SpillArtifact["kind"],
    summary: String(r.summary),
    storageUri: String(r.storage_uri),
    byteSize: Number(r.byte_size),
    createdAt: String(r.created_at),
  };
}

function mapInboxRow(r: Record<string, unknown>): InboxItem {
  return {
    id: String(r.id),
    repoId: String(r.repo_id),
    ticketId: String(r.ticket_id),
    kind: r.kind as InboxItem["kind"],
    status: r.status as InboxItem["status"],
    title: String(r.title),
    summary: String(r.summary),
    contextPayload: JSON.parse(String(r.context_payload_json)),
    resolutionNote: r.resolution_note ? String(r.resolution_note) : undefined,
    createdAt: String(r.created_at),
    resolvedAt: r.resolved_at ? String(r.resolved_at) : undefined,
  };
}

function mapOutboxRow(r: Record<string, unknown>): OutboxEntry {
  return {
    id: String(r.id),
    repoId: String(r.repo_id),
    ticketId: String(r.ticket_id),
    action: r.action as OutboxEntry["action"],
    idempotencyKey: String(r.idempotency_key),
    payload: JSON.parse(String(r.payload_json)),
    status: r.status as OutboxEntry["status"],
    attempts: Number(r.attempts),
    nextAttemptAt: String(r.next_attempt_at),
    lastError: r.last_error ? String(r.last_error) : undefined,
    resultPayload: r.result_payload_json ? JSON.parse(String(r.result_payload_json)) : undefined,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapPlaybookRow(r: Record<string, unknown>): PlaybookEntry {
  return {
    id: String(r.id),
    repoId: String(r.repo_id),
    rule: String(r.rule),
    scopePaths: r.scope_paths_json ? (JSON.parse(String(r.scope_paths_json)) as string[]) : ["**"],
    source: r.source as PlaybookEntry["source"],
    sourceTicketId: r.source_ticket_id ? String(r.source_ticket_id) : undefined,
    enabled: Boolean(r.enabled),
    pinned: Boolean(r.pinned),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}
