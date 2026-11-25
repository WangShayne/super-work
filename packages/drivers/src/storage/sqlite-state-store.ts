import { copyFileSync, existsSync, rmSync } from "node:fs";
import type {
  CasebookEntry,
  ChainOfRecall,
  EvalCase,
  EvalRunRecord,
  EngineHealthRecord,
  FlightEvent,
  GoalCampaign,
  GoalCampaignWave,
  Milestone,
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
import {
  mapInboxRow,
  mapOutboxRow,
} from "./sqlite-mappers.ts";
import { Database } from "bun:sqlite";
import { getDailyRepoSpendUsd, getMetricsSummary } from "./sqlite-store-metrics.ts";
import { indexMemoryDocument, searchMemoryByMatch } from "./sqlite-store-memory.ts";
import { saveCheckpoint, getCheckpoint, listCheckpoints, markCheckpointsCleaned, listReviewComments, saveReviewComment, updateReviewCommentStatus, saveEvalCase, getEvalCase, listEvalCases, deleteEvalCase, saveEvalRun, getEvalRun, listEvalRuns } from "./sqlite-store-quality.ts";
import { saveMilestone, getMilestone, listMilestones, saveCampaign, getCampaign, listCampaigns, deleteCampaign, saveCampaignWave, listCampaignWaves, saveMergeTrainEntry, getMergeTrainEntry, listMergeTrainEntries, nextMergeTrainPosition } from "./sqlite-store-milestones.ts";
import { savePlaybookEntry, getPlaybookEntry, listPlaybookEntries, deletePlaybookEntry, recordPlaybookHits, saveRoutine, getRoutine, listRoutines, deleteRoutine, saveRoutineRun, listRoutineRuns, saveCasebookEntry, getCasebookEntry, getCasebookEntryByTicket, listCasebookEntries, deleteCasebookEntry, recordCasebookHits, saveEngineHealth, getEngineHealth, listEngineHealth, recordFlightEvent, listFlightEvents } from "./sqlite-store-autonomy.ts";
import { upsertRepo, getRepo, listRepos, saveTrigger, getTrigger, findTriggerByExternalRef, listTriggersByThread, upsertThread, getThread, getThreadByKey, saveTicket, getTicket, listTickets, listActiveTickets, saveStageRun, getStageRun, listStageRuns, saveArtifact, getArtifact, listArtifacts } from "./sqlite-store-tickets.ts";
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
    return upsertRepo(this.db, repo);
  }

  async getRepo(id: string): Promise<RepoConfig | null> {
    return getRepo(this.db, id);
  }

  async listRepos(): Promise<RepoConfig[]> {
    return listRepos(this.db);
  }


  // --- Triggers & Threads ---
  async saveTrigger(trigger: Trigger): Promise<void> {
    return saveTrigger(this.db, trigger);
  }

  async getTrigger(id: string): Promise<Trigger | null> {
    return getTrigger(this.db, id);
  }

  async findTriggerByExternalRef(repoId: string, externalRef: string): Promise<Trigger | null> {
    return findTriggerByExternalRef(this.db, repoId, externalRef);
  }

  async listTriggersByThread(threadId: string): Promise<Trigger[]> {
    return listTriggersByThread(this.db, threadId);
  }

  async upsertThread(thread: Thread): Promise<void> {
    return upsertThread(this.db, thread);
  }

  async getThread(id: string): Promise<Thread | null> {
    return getThread(this.db, id);
  }

  async getThreadByKey(repoId: string, threadKey: string): Promise<Thread | null> {
    return getThreadByKey(this.db, repoId, threadKey);
  }


  // --- Tickets ---
  async saveTicket(ticket: Ticket): Promise<void> {
    return saveTicket(this.db, ticket);
  }

  async getTicket(id: string): Promise<Ticket | null> {
    return getTicket(this.db, id);
  }

  async listTickets(filter?: { repoId?: string; status?: TicketStatus }): Promise<Ticket[]> {
    return listTickets(this.db, filter);
  }

  async listActiveTickets(repoId: string): Promise<Ticket[]> {
    return listActiveTickets(this.db, repoId);
  }


  // --- StageRuns & Artifacts ---
  async saveStageRun(stageRun: StageRun): Promise<void> {
    return saveStageRun(this.db, stageRun);
  }

  async getStageRun(id: string): Promise<StageRun | null> {
    return getStageRun(this.db, id);
  }

  async listStageRuns(ticketId: string): Promise<StageRun[]> {
    return listStageRuns(this.db, ticketId);
  }

  async saveArtifact(artifact: SpillArtifact, indexBody?: string): Promise<void> {
    return saveArtifact(this.db, artifact, indexBody);
  }

  async getArtifact(id: string): Promise<SpillArtifact | null> {
    return getArtifact(this.db, id);
  }

  async listArtifacts(ticketId: string): Promise<SpillArtifact[]> {
    return listArtifacts(this.db, ticketId);
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
    return getDailyRepoSpendUsd(this.db, repoId, utcDatePrefix);
  }

  async getMetricsSummary(repoId?: string, utcDatePrefix?: string): Promise<RepoMetricsSummary> {
    return getMetricsSummary(this.db, repoId, utcDatePrefix);
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
    indexMemoryDocument(this.db, doc);
  }

  async searchMemory(query: string, limit = 10, repoId?: string): Promise<MemorySearchHit[]> {
    const ftsQuery = tokenizeFtsQuery(query);
    if (!ftsQuery) return [];
    return searchMemoryByMatch(this.db, ftsQuery, limit, repoId);
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
    return savePlaybookEntry(this.db, entry);
  }

  async getPlaybookEntry(id: string): Promise<PlaybookEntry | null> {
    return getPlaybookEntry(this.db, id);
  }

  async listPlaybookEntries(
    repoId: string,
    options?: { onlyEnabled?: boolean },
  ): Promise<PlaybookEntry[]> {
    return listPlaybookEntries(this.db, repoId, options);
  }

  async deletePlaybookEntry(id: string): Promise<boolean> {
    return deletePlaybookEntry(this.db, id);
  }

  async recordPlaybookHits(ids: string[], matchedAt: string): Promise<void> {
    return recordPlaybookHits(this.db, ids, matchedAt);
  }


  // --- Routines (A.1) ---
  async saveRoutine(routine: RoutineSpec): Promise<void> {
    return saveRoutine(this.db, routine);
  }

  async getRoutine(id: string): Promise<RoutineSpec | null> {
    return getRoutine(this.db, id);
  }

  async listRoutines(repoId?: string): Promise<RoutineSpec[]> {
    return listRoutines(this.db, repoId);
  }

  async deleteRoutine(id: string): Promise<boolean> {
    return deleteRoutine(this.db, id);
  }

  async saveRoutineRun(run: RoutineRun): Promise<void> {
    return saveRoutineRun(this.db, run);
  }

  async listRoutineRuns(filter?: {
    repoId?: string;
    routineId?: string;
    limit?: number;
  }): Promise<RoutineRun[]> {
    return listRoutineRuns(this.db, filter);
  }


  // --- Casebook (C.2) ---
  async saveCasebookEntry(entry: CasebookEntry): Promise<void> {
    return saveCasebookEntry(this.db, entry);
  }

  async getCasebookEntry(id: string): Promise<CasebookEntry | null> {
    return getCasebookEntry(this.db, id);
  }

  async getCasebookEntryByTicket(ticketId: string): Promise<CasebookEntry | null> {
    return getCasebookEntryByTicket(this.db, ticketId);
  }

  async listCasebookEntries(
    repoId: string,
    options?: { includeReverted?: boolean },
  ): Promise<CasebookEntry[]> {
    return listCasebookEntries(this.db, repoId, options);
  }

  async deleteCasebookEntry(id: string): Promise<boolean> {
    return deleteCasebookEntry(this.db, id);
  }

  async recordCasebookHits(ids: string[], matchedAt: string): Promise<void> {
    return recordCasebookHits(this.db, ids, matchedAt);
  }


  // --- Engine Circuit Breaker (v1.5.0 Direction A) ---
  async saveEngineHealth(rec: EngineHealthRecord): Promise<void> {
    return saveEngineHealth(this.db, rec);
  }

  async getEngineHealth(engine: WorkerEngineId): Promise<EngineHealthRecord | null> {
    return getEngineHealth(this.db, engine);
  }

  async listEngineHealth(): Promise<EngineHealthRecord[]> {
    return listEngineHealth(this.db);
  }


  // --- Flight Recorder (Direction D) ---
  async recordFlightEvent(event: FlightEvent): Promise<void> {
    return recordFlightEvent(this.db, event);
  }

  async listFlightEvents(filter?: {
    repoId?: string;
    limit?: number;
    sinceIso?: string;
  }): Promise<FlightEvent[]> {
    return listFlightEvents(this.db, filter);
  }


  // --- Milestones (v1.4.0 Direction B) ---
  async saveMilestone(m: Milestone): Promise<void> {
    return saveMilestone(this.db, m);
  }

  async getMilestone(id: string): Promise<Milestone | null> {
    return getMilestone(this.db, id);
  }

  async listMilestones(repoId?: string): Promise<Milestone[]> {
    return listMilestones(this.db, repoId);
  }


  // --- Worktree Checkpoints (D.2) ---
  async saveCheckpoint(cp: TicketCheckpoint): Promise<void> {
    return saveCheckpoint(this.db, cp);
  }

  async getCheckpoint(id: string): Promise<TicketCheckpoint | null> {
    return getCheckpoint(this.db, id);
  }

  async listCheckpoints(ticketId: string): Promise<TicketCheckpoint[]> {
    return listCheckpoints(this.db, ticketId);
  }

  async markCheckpointsCleaned(ticketId: string, cleanedAt: string): Promise<void> {
    return markCheckpointsCleaned(this.db, ticketId, cleanedAt);
  }


  // --- Line-Anchored Review Comments (v1.0.0 B.1) ---
  async listReviewComments(ticketId: string): Promise<TicketReviewComment[]> {
    return listReviewComments(this.db, ticketId);
  }

  async saveReviewComment(comment: TicketReviewComment): Promise<void> {
    return saveReviewComment(this.db, comment);
  }

  async updateReviewCommentStatus(
    id: string,
    status: ReviewCommentStatus,
    updatedAt: string,
  ): Promise<TicketReviewComment | null> {
    return updateReviewCommentStatus(this.db, id, status, updatedAt);
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
    return saveEvalCase(this.db, evalCase);
  }

  async getEvalCase(id: string): Promise<EvalCase | null> {
    return getEvalCase(this.db, id);
  }

  async listEvalCases(repoId?: string): Promise<EvalCase[]> {
    return listEvalCases(this.db, repoId);
  }

  async deleteEvalCase(id: string): Promise<boolean> {
    return deleteEvalCase(this.db, id);
  }

  async saveEvalRun(run: EvalRunRecord): Promise<void> {
    return saveEvalRun(this.db, run);
  }

  async getEvalRun(id: string): Promise<EvalRunRecord | null> {
    return getEvalRun(this.db, id);
  }

  async listEvalRuns(filter?: {
    repoId?: string;
    evalCaseId?: string;
    limit?: number;
  }): Promise<EvalRunRecord[]> {
    return listEvalRuns(this.db, filter);
  }


  // --- Goal Campaigns (v1.2.0 Pillar A) ---
  async saveCampaign(campaign: GoalCampaign): Promise<void> {
    return saveCampaign(this.db, campaign);
  }

  async getCampaign(id: string): Promise<GoalCampaign | null> {
    return getCampaign(this.db, id);
  }

  async listCampaigns(repoId?: string): Promise<GoalCampaign[]> {
    return listCampaigns(this.db, repoId);
  }

  async deleteCampaign(id: string): Promise<boolean> {
    return deleteCampaign(this.db, id);
  }

  async saveCampaignWave(wave: GoalCampaignWave): Promise<void> {
    return saveCampaignWave(this.db, wave);
  }

  async listCampaignWaves(campaignId: string): Promise<GoalCampaignWave[]> {
    return listCampaignWaves(this.db, campaignId);
  }


  // --- Speculative Merge Train (v1.2.0 Pillar B) ---
  async saveMergeTrainEntry(entry: MergeTrainEntry): Promise<void> {
    return saveMergeTrainEntry(this.db, entry);
  }

  async getMergeTrainEntry(id: string): Promise<MergeTrainEntry | null> {
    return getMergeTrainEntry(this.db, id);
  }

  async listMergeTrainEntries(filter?: {
    repoId?: string;
    barrierGroupId?: string;
    status?: MergeTrainEntryStatus;
  }): Promise<MergeTrainEntry[]> {
    return listMergeTrainEntries(this.db, filter);
  }

  async nextMergeTrainPosition(repoId: string): Promise<number> {
    return nextMergeTrainPosition(this.db, repoId);
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
