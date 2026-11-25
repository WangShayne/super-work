// Worktree checkpoints, review comments and golden eval suite storage helpers (extracted from sqlite-state-store.ts).
import type { Database } from "bun:sqlite";
import type {
  EvalCase,
  EvalRunRecord,
  ReviewCommentStatus,
  TicketCheckpoint,
  TicketReviewComment,
} from "@super-work/core";
import {
  mapCheckpointRow,
  mapEvalCaseRow,
  mapEvalRunRow,
  mapReviewCommentRow,
} from "./sqlite-mappers.ts";

export function saveCheckpoint(db: Database, cp: TicketCheckpoint): void {
  db
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

export function getCheckpoint(db: Database, id: string): TicketCheckpoint | null {
  const row = db
    .query("SELECT * FROM ticket_checkpoints WHERE id = ?")
    .get(id) as Record<string, unknown> | null;
  return row ? mapCheckpointRow(row) : null;
}

export function listCheckpoints(db: Database, ticketId: string): TicketCheckpoint[] {
  const rows = db
    .query("SELECT * FROM ticket_checkpoints WHERE ticket_id = ? ORDER BY created_at ASC")
    .all(ticketId) as Array<Record<string, unknown>>;
  return rows.map(mapCheckpointRow);
}

export function markCheckpointsCleaned(db: Database, ticketId: string, cleanedAt: string): void {
  db
    .query(
      "UPDATE ticket_checkpoints SET cleaned_at = ? WHERE ticket_id = ? AND cleaned_at IS NULL",
    )
    .run(cleanedAt, ticketId);
}

export function listReviewComments(db: Database, ticketId: string): TicketReviewComment[] {
  const rows = db
    .query("SELECT * FROM ticket_review_comments WHERE ticket_id = ? ORDER BY created_at ASC")
    .all(ticketId) as Record<string, unknown>[];
  return rows.map(mapReviewCommentRow);
}

export function saveReviewComment(db: Database, comment: TicketReviewComment): void {
  db
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

export function updateReviewCommentStatus(db: Database, 
  id: string,
  status: ReviewCommentStatus,
  updatedAt: string,
): TicketReviewComment | null {
  db
    .query("UPDATE ticket_review_comments SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, updatedAt, id);
  const row = db
    .query("SELECT * FROM ticket_review_comments WHERE id = ?")
    .get(id) as Record<string, unknown> | null;
  return row ? mapReviewCommentRow(row) : null;
}

export function saveEvalCase(db: Database, evalCase: EvalCase): void {
  db
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

export function getEvalCase(db: Database, id: string): EvalCase | null {
  const row = db.query("SELECT * FROM eval_cases WHERE id = ?").get(id) as Record<
    string,
    unknown
  > | null;
  return row ? mapEvalCaseRow(row) : null;
}

export function listEvalCases(db: Database, repoId?: string): EvalCase[] {
  const rows = repoId
    ? (db
        .query("SELECT * FROM eval_cases WHERE repo_id = ? ORDER BY created_at DESC")
        .all(repoId) as Record<string, unknown>[])
    : (db
        .query("SELECT * FROM eval_cases ORDER BY created_at DESC")
        .all() as Record<string, unknown>[]);
  return rows.map(mapEvalCaseRow);
}

export function deleteEvalCase(db: Database, id: string): boolean {
  const res = db.query("DELETE FROM eval_cases WHERE id = ?").run(id);
  return Number(res.changes ?? 0) > 0;
}

export function saveEvalRun(db: Database, run: EvalRunRecord): void {
  db
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

export function getEvalRun(db: Database, id: string): EvalRunRecord | null {
  const row = db.query("SELECT * FROM eval_runs WHERE id = ?").get(id) as Record<
    string,
    unknown
  > | null;
  return row ? mapEvalRunRow(row) : null;
}

export function listEvalRuns(db: Database, filter?: {
  repoId?: string;
  evalCaseId?: string;
  limit?: number;
}): EvalRunRecord[] {
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
  const rows = db
    .query(`SELECT * FROM eval_runs ${where} ORDER BY started_at DESC LIMIT ?`)
    .all(...params, limit) as Record<string, unknown>[];
  return rows.map(mapEvalRunRow);
}
