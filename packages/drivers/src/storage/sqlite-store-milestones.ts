// Milestones, goal campaigns/waves and speculative merge train storage helpers (extracted from sqlite-state-store.ts).
import type { Database } from "bun:sqlite";
import type {
  GoalCampaign,
  GoalCampaignWave,
  Milestone,
  MergeTrainEntry,
  MergeTrainEntryStatus,
} from "@super-work/core";
import {
  mapGoalCampaignRow,
  mapGoalCampaignWaveRow,
  mapMergeTrainEntryRow,
  mapMilestoneRow,
} from "./sqlite-mappers.ts";

export function saveMilestone(db: Database, m: Milestone): void {
  db
    .query(
      `INSERT INTO milestones (
        id, repo_id, name, target_version, status, items_json, release_notes_zh,
        release_notes_en, digest_summary, released_commit_sha, released_tag,
        integration_mode, staging_branch, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        target_version = excluded.target_version,
        status = excluded.status,
        items_json = excluded.items_json,
        release_notes_zh = excluded.release_notes_zh,
        release_notes_en = excluded.release_notes_en,
        digest_summary = excluded.digest_summary,
        released_commit_sha = excluded.released_commit_sha,
        released_tag = excluded.released_tag,
        integration_mode = excluded.integration_mode,
        staging_branch = excluded.staging_branch,
        updated_at = excluded.updated_at`,
    )
    .run(
      m.id,
      m.repoId,
      m.name,
      m.targetVersion ?? null,
      m.status,
      JSON.stringify(m.items),
      m.releaseNotesZh ?? null,
      m.releaseNotesEn ?? null,
      m.digestSummary ?? null,
      m.releasedCommitSha ?? null,
      m.releasedTag ?? null,
      m.integrationMode ?? null,
      m.stagingBranch ?? null,
      m.createdAt,
      m.updatedAt,
    );
}

export function getMilestone(db: Database, id: string): Milestone | null {
  const row = db.query("SELECT * FROM milestones WHERE id = ?").get(id) as
    | Record<string, unknown>
    | null;
  return row ? mapMilestoneRow(row) : null;
}

export function listMilestones(db: Database, repoId?: string): Milestone[] {
  const rows = (
    repoId
      ? db
          .query("SELECT * FROM milestones WHERE repo_id = ? ORDER BY created_at DESC")
          .all(repoId)
      : db.query("SELECT * FROM milestones ORDER BY created_at DESC").all()
  ) as Record<string, unknown>[];
  return rows.map(mapMilestoneRow);
}

export function saveCampaign(db: Database, campaign: GoalCampaign): void {
  db
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

export function getCampaign(db: Database, id: string): GoalCampaign | null {
  const row = db
    .query("SELECT * FROM goal_campaigns WHERE id = ?")
    .get(id) as Record<string, unknown> | null;
  return row ? mapGoalCampaignRow(row) : null;
}

export function listCampaigns(db: Database, repoId?: string): GoalCampaign[] {
  const rows = (
    repoId
      ? db
          .query("SELECT * FROM goal_campaigns WHERE repo_id = ? ORDER BY created_at DESC")
          .all(repoId)
      : db.query("SELECT * FROM goal_campaigns ORDER BY created_at DESC").all()
  ) as Record<string, unknown>[];
  return rows.map(mapGoalCampaignRow);
}

export function deleteCampaign(db: Database, id: string): boolean {
  const tx = db.transaction(() => {
    db.query("DELETE FROM goal_campaign_waves WHERE campaign_id = ?").run(id);
    return db.query("DELETE FROM goal_campaigns WHERE id = ?").run(id);
  });
  const res = tx();
  return Number(res.changes ?? 0) > 0;
}

export function saveCampaignWave(db: Database, wave: GoalCampaignWave): void {
  db
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

export function listCampaignWaves(db: Database, campaignId: string): GoalCampaignWave[] {
  const rows = db
    .query("SELECT * FROM goal_campaign_waves WHERE campaign_id = ? ORDER BY wave_number ASC")
    .all(campaignId) as Record<string, unknown>[];
  return rows.map(mapGoalCampaignWaveRow);
}

export function saveMergeTrainEntry(db: Database, entry: MergeTrainEntry): void {
  db
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

export function getMergeTrainEntry(db: Database, id: string): MergeTrainEntry | null {
  const row = db
    .query("SELECT * FROM merge_train_entries WHERE id = ?")
    .get(id) as Record<string, unknown> | null;
  return row ? mapMergeTrainEntryRow(row) : null;
}

export function listMergeTrainEntries(db: Database, filter?: {
  repoId?: string;
  barrierGroupId?: string;
  status?: MergeTrainEntryStatus;
}): MergeTrainEntry[] {
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
  const rows = db
    .query(`SELECT * FROM merge_train_entries ${where} ORDER BY position ASC, created_at ASC`)
    .all(...params) as Record<string, unknown>[];
  return rows.map(mapMergeTrainEntryRow);
}

export function nextMergeTrainPosition(db: Database, repoId: string): number {
  const row = db
    .query("SELECT COALESCE(MAX(position), 0) AS max_pos FROM merge_train_entries WHERE repo_id = ?")
    .get(repoId) as { max_pos: number } | null;
  return Number(row?.max_pos ?? 0) + 1;
}
