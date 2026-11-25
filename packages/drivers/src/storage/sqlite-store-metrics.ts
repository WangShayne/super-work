// Daily spend and metrics summary queries storage helpers (extracted from sqlite-state-store.ts).
import type { Database } from "bun:sqlite";
import type {
  EngineMetricRow,
  RepoMetricsSummary,
  TicketStatus,
  WorkerEngineId,
} from "@super-work/core";
import { buildEngineCategoryMatrix } from "@super-work/core";
import {
  mapCasebookRow,
  mapStageRunRow,
} from "./sqlite-mappers.ts";
import { getRepo, listTickets } from "./sqlite-store-tickets.ts";

export function getDailyRepoSpendUsd(db: Database, repoId: string, utcDatePrefix: string): number {
  const row = db
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

export async function getMetricsSummary(db: Database, repoId?: string, utcDatePrefix?: string): Promise<RepoMetricsSummary> {
  const todayDate = utcDatePrefix ?? new Date().toISOString().slice(0, 10);

  let todayCostUsd = 0;
  let dailyBudgetUsd: number | undefined;
  let effectiveDailyBudgetUsd: number | undefined;
  if (repoId) {
    todayCostUsd = await getDailyRepoSpendUsd(db, repoId, todayDate);
    const repo = await getRepo(db, repoId);
    dailyBudgetUsd = repo?.dailyBudgetUsd;
    effectiveDailyBudgetUsd =
      repo?.dailyBudgetOverrideDate === todayDate && repo.dailyBudgetOverrideUsd !== undefined
        ? repo.dailyBudgetOverrideUsd
        : repo?.dailyBudgetUsd;
  } else {
    const todayRow = db
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
      ? db
          .query(
            "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM tickets WHERE COALESCE(is_epic, 0) = 0 AND repo_id = ?",
          )
          .get(repoId)
      : db
          .query("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM tickets WHERE COALESCE(is_epic, 0) = 0")
          .get()
  ) as { total: number } | null;
  const totalCostUsd = Number(totalCostRow?.total ?? 0);

  const statusRows = (
    repoId
      ? db
          .query(
            "SELECT status, COUNT(*) AS cnt FROM tickets WHERE COALESCE(is_epic, 0) = 0 AND repo_id = ? GROUP BY status",
          )
          .all(repoId)
      : db
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
    repoId ? db.query(engineSql).all(repoId) : db.query(engineSql).all()
  ) as Array<Record<string, unknown>>;

  const byEngine: EngineMetricRow[] = engineRows.map((r) => ({
    engine: String(r.engine) as WorkerEngineId,
    runs: Number(r.runs ?? 0),
    completedRuns: Number(r.completed_runs ?? 0),
    failedRuns: Number(r.failed_runs ?? 0),
    totalCostUsd: Number(r.total_cost_usd ?? 0),
    avgDurationMs: Number(r.avg_duration_ms ?? 0),
  }));

  const historicalTickets = await listTickets(db, repoId ? { repoId } : undefined);
  const stageRunRows = (
    repoId
      ? db
          .query(
            "SELECT sr.* FROM stage_runs sr JOIN tickets t ON t.id = sr.ticket_id WHERE t.repo_id = ? ORDER BY sr.started_at ASC",
          )
          .all(repoId)
      : db.query("SELECT * FROM stage_runs ORDER BY started_at ASC").all()
  ) as Array<Record<string, unknown>>;
  const casebookRows = (
    repoId
      ? db.query("SELECT * FROM casebook_entries WHERE repo_id = ?").all(repoId)
      : db.query("SELECT * FROM casebook_entries").all()
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
