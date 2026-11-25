// Playbook, routines, casebook, engine health and flight recorder storage helpers (extracted from sqlite-state-store.ts).
import type { Database } from "bun:sqlite";
import type {
  CasebookEntry,
  EngineHealthRecord,
  FlightEvent,
  PlaybookEntry,
  RoutineRun,
  RoutineSpec,
  WorkerEngineId,
} from "@super-work/core";
import {
  mapCasebookRow,
  mapEngineHealthRow,
  mapFlightEventRow,
  mapPlaybookRow,
  mapRoutineRow,
  mapRoutineRunRow,
} from "./sqlite-mappers.ts";

export function savePlaybookEntry(db: Database, entry: PlaybookEntry): void {
  db
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

export function getPlaybookEntry(db: Database, id: string): PlaybookEntry | null {
  const row = db
    .query("SELECT * FROM playbook_entries WHERE id = ?")
    .get(id) as Record<string, unknown> | null;
  return row ? mapPlaybookRow(row) : null;
}

export function listPlaybookEntries(db: Database, 
  repoId: string,
  options?: { onlyEnabled?: boolean },
): PlaybookEntry[] {
  const sql = options?.onlyEnabled
    ? "SELECT * FROM playbook_entries WHERE repo_id = ? AND enabled = 1 ORDER BY pinned DESC, updated_at DESC"
    : "SELECT * FROM playbook_entries WHERE repo_id = ? ORDER BY pinned DESC, updated_at DESC";
  const rows = db.query(sql).all(repoId) as Record<string, unknown>[];
  return rows.map(mapPlaybookRow);
}

export function deletePlaybookEntry(db: Database, id: string): boolean {
  const res = db.query("DELETE FROM playbook_entries WHERE id = ?").run(id);
  return Number(res.changes ?? 0) > 0;
}

export function recordPlaybookHits(db: Database, ids: string[], matchedAt: string): void {
  if (ids.length === 0) return;
  const tx = db.transaction(() => {
    const stmt = db.query(
      "UPDATE playbook_entries SET hit_count = COALESCE(hit_count, 0) + 1, last_matched_at = ? WHERE id = ?",
    );
    for (const id of ids) {
      stmt.run(matchedAt, id);
    }
  });
  tx();
}

export function saveRoutine(db: Database, routine: RoutineSpec): void {
  db
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

export function getRoutine(db: Database, id: string): RoutineSpec | null {
  const row = db
    .query("SELECT * FROM routines WHERE id = ?")
    .get(id) as Record<string, unknown> | null;
  return row ? mapRoutineRow(row) : null;
}

export function listRoutines(db: Database, repoId?: string): RoutineSpec[] {
  const rows = (
    repoId
      ? db.query("SELECT * FROM routines WHERE repo_id = ? ORDER BY created_at DESC").all(repoId)
      : db.query("SELECT * FROM routines ORDER BY created_at DESC").all()
  ) as Record<string, unknown>[];
  return rows.map(mapRoutineRow);
}

export function deleteRoutine(db: Database, id: string): boolean {
  const tx = db.transaction(() => {
    db.query("DELETE FROM routine_runs WHERE routine_id = ?").run(id);
    return db.query("DELETE FROM routines WHERE id = ?").run(id);
  });
  const res = tx();
  return Number(res.changes ?? 0) > 0;
}

export function saveRoutineRun(db: Database, run: RoutineRun): void {
  db
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

export function listRoutineRuns(db: Database, filter?: {
  repoId?: string;
  routineId?: string;
  limit?: number;
}): RoutineRun[] {
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
  const rows = db
    .query(`SELECT * FROM routine_runs ${where} ORDER BY started_at DESC LIMIT ?`)
    .all(...params, limit) as Record<string, unknown>[];
  return rows.map(mapRoutineRunRow);
}

export function saveCasebookEntry(db: Database, entry: CasebookEntry): void {
  db
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

export function getCasebookEntry(db: Database, id: string): CasebookEntry | null {
  const row = db
    .query("SELECT * FROM casebook_entries WHERE id = ?")
    .get(id) as Record<string, unknown> | null;
  return row ? mapCasebookRow(row) : null;
}

export function getCasebookEntryByTicket(db: Database, ticketId: string): CasebookEntry | null {
  const row = db
    .query("SELECT * FROM casebook_entries WHERE ticket_id = ?")
    .get(ticketId) as Record<string, unknown> | null;
  return row ? mapCasebookRow(row) : null;
}

export function listCasebookEntries(db: Database, 
  repoId: string,
  options?: { includeReverted?: boolean },
): CasebookEntry[] {
  const sql =
    options?.includeReverted === false
      ? "SELECT * FROM casebook_entries WHERE repo_id = ? AND COALESCE(reverted, 0) = 0 ORDER BY updated_at DESC"
      : "SELECT * FROM casebook_entries WHERE repo_id = ? ORDER BY updated_at DESC";
  const rows = db.query(sql).all(repoId) as Record<string, unknown>[];
  return rows.map(mapCasebookRow);
}

export function deleteCasebookEntry(db: Database, id: string): boolean {
  const res = db.query("DELETE FROM casebook_entries WHERE id = ?").run(id);
  return Number(res.changes ?? 0) > 0;
}

export function recordCasebookHits(db: Database, ids: string[], matchedAt: string): void {
  if (ids.length === 0) return;
  const tx = db.transaction(() => {
    const stmt = db.query(
      "UPDATE casebook_entries SET hit_count = COALESCE(hit_count, 0) + 1, last_matched_at = ? WHERE id = ?",
    );
    for (const id of ids) {
      stmt.run(matchedAt, id);
    }
  });
  tx();
}

export function saveEngineHealth(db: Database, rec: EngineHealthRecord): void {
  db
    .query(
      `INSERT OR REPLACE INTO engine_health (
        engine, status, failure_kind, reason, tripped_at, cooldown_until,
        consecutive_failures, last_probed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      rec.engine,
      rec.status,
      rec.failureKind ?? null,
      rec.reason ?? null,
      rec.trippedAt ?? null,
      rec.cooldownUntil ?? null,
      Math.max(0, Math.floor(rec.consecutiveFailures)),
      rec.lastProbedAt ?? null,
      rec.updatedAt,
    );
}

export function getEngineHealth(db: Database, engine: WorkerEngineId): EngineHealthRecord | null {
  const row = db.query("SELECT * FROM engine_health WHERE engine = ?").get(engine) as
    | Record<string, unknown>
    | null;
  return row ? mapEngineHealthRow(row) : null;
}

export function listEngineHealth(db: Database): EngineHealthRecord[] {
  const rows = db.query("SELECT * FROM engine_health ORDER BY engine ASC").all() as Record<
    string,
    unknown
  >[];
  return rows.map(mapEngineHealthRow);
}

export function recordFlightEvent(db: Database, event: FlightEvent): void {
  db
    .query(
      `INSERT OR REPLACE INTO flight_events (
        id, repo_id, ticket_id, kind, engine, summary, saved_ms, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.id,
      event.repoId ?? null,
      event.ticketId ?? null,
      event.kind,
      event.engine ?? null,
      event.summary,
      event.savedMs != null ? Math.round(event.savedMs) : null,
      event.metadata ? JSON.stringify(event.metadata) : null,
      event.createdAt,
    );
}

export function listFlightEvents(db: Database, filter?: {
  repoId?: string;
  limit?: number;
  sinceIso?: string;
}): FlightEvent[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter?.repoId) {
    clauses.push("repo_id = ?");
    params.push(filter.repoId);
  }
  if (filter?.sinceIso) {
    clauses.push("created_at >= ?");
    params.push(filter.sinceIso);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(Math.max(Math.floor(filter?.limit ?? 50), 1), 1000);
  const rows = db
    .query(`SELECT * FROM flight_events ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, limit) as Record<string, unknown>[];
  return rows.map(mapFlightEventRow);
}
