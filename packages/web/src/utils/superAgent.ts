// Browser-pure Super-Agent helpers. Core is imported TYPE-ONLY (runtime core pulls in node:fs).
import type {
  AutonomyPreset,
  EngineHealthRecord,
  InboxHumanAction,
  InboxItem,
  RepoConfig,
  StageKind,
  Ticket,
  TicketStatus,
  WorkerEngineId,
} from "../types.ts";

export const AUTONOMY_PRESETS: readonly AutonomyPreset[] = ["guarded", "smart", "autonomous"];

/** Pre-v1.8.0 preset names that may still sit on an unmigrated RepoConfig. */
const LEGACY_PRESET_ALIASES: Readonly<Record<string, AutonomyPreset>> = {
  copilot: "guarded",
  standard: "smart",
  autopilot: "autonomous",
};

/** Mirror of core normalizeAutonomyPreset: canonical names pass through, legacy aliases map, else undefined. */
export function normalizeAutonomyPreset(value: unknown): AutonomyPreset | undefined {
  if (typeof value !== "string") return undefined;
  if ((AUTONOMY_PRESETS as readonly string[]).includes(value)) return value as AutonomyPreset;
  return Object.hasOwn(LEGACY_PRESET_ALIASES, value) ? LEGACY_PRESET_ALIASES[value] : undefined;
}

export const HUMAN_ACTIONS: readonly InboxHumanAction[] = ["approve", "answer", "unblock"];

/** Mirror of core classifyInboxHumanAction (kept browser-pure on purpose). */
export function classifyInboxHumanAction(kind: InboxItem["kind"]): InboxHumanAction {
  switch (kind) {
    case "outbox_signoff":
    case "plan_approval":
    case "observe_proposal":
    case "milestone_ready":
    case "arena_tiebreak":
      return "approve";
    case "clarification_request":
    case "epic_replan":
      return "answer";
    case "mandate_violation":
    case "watchdog_escalation":
    case "merge_conflict":
    case "budget_cap":
    case "pr_followup":
    case "campaign_paused":
      return "unblock";
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      return "unblock";
    }
  }
}

/** Mirror of core inferAutonomyPreset: explicit preset wins, else derive from gate policy. */
export function inferAutonomyPreset(repo: Partial<RepoConfig> | undefined): AutonomyPreset {
  if (!repo) return "smart";
  const stored = normalizeAutonomyPreset(repo.autonomyPreset);
  if (stored) return stored;
  if (repo.deliveryGatePolicy === "always_auto") return "autonomous";
  if (repo.deliveryGatePolicy === "always_signoff") return "guarded";
  return "smart";
}

export const RUNNING_STATUSES: readonly TicketStatus[] = [
  "planning",
  "spec_testing",
  "implementing",
  "reviewing",
  "rebasing",
];

const QUEUED_STATUSES: readonly TicketStatus[] = ["queued", "waiting_deps", "triaging", "proposed"];
const ATTENTION_STATUSES: readonly TicketStatus[] = [
  "needs_human",
  "watchdog_intervention",
  "awaiting_plan_approval",
  "outbox_pending",
];
export const FINISHED_STATUSES: readonly TicketStatus[] = ["delivered", "failed", "cancelled"];

export type HumanTicketPhase = "working" | "queued" | "attention" | "done" | "failed";

export function humanTicketPhase(status: TicketStatus): HumanTicketPhase {
  if (RUNNING_STATUSES.includes(status)) return "working";
  if (QUEUED_STATUSES.includes(status)) return "queued";
  if (ATTENTION_STATUSES.includes(status)) return "attention";
  if (status === "delivered") return "done";
  return "failed";
}

export function isLiveTicket(ticket: Ticket): boolean {
  const phase = humanTicketPhase(ticket.status);
  return phase === "working" || phase === "queued" || phase === "attention";
}

export type HealthAlertReason = "sse_offline" | "no_healthy_engine" | "pinned_engine_down";

export interface HealthInput {
  /** Already grace-gated by the caller (SSE offline AFTER the initial mount grace period). */
  sseOffline: boolean;
  availableEngines: readonly WorkerEngineId[];
  engineHealth: readonly EngineHealthRecord[];
  repo?: Pick<RepoConfig, "preferredImplementEngine" | "fallbackEngines">;
}

export function isEngineTripped(records: readonly EngineHealthRecord[], id: WorkerEngineId): boolean {
  return records.some((r) => r.engine === id && r.status === "tripped");
}

/**
 * Why the header should show an amber alert. Optional tripped CLIs never alert while at least one
 * real (non-mock) worker engine is healthy. A setup with no real engine installed is a setup state
 * (handled by the setup wizard), not an alert.
 */
export function healthAlertReasons(i: HealthInput): HealthAlertReason[] {
  const reasons: HealthAlertReason[] = [];
  if (i.sseOffline) reasons.push("sse_offline");

  const real = i.availableEngines.filter((e) => e !== "mock");
  const healthyReal = real.filter((e) => !isEngineTripped(i.engineHealth, e));
  if (real.length > 0 && healthyReal.length === 0) reasons.push("no_healthy_engine");

  const pinned = i.repo?.preferredImplementEngine;
  if (pinned && pinned !== "auto" && pinned !== "mock" && isEngineTripped(i.engineHealth, pinned)) {
    const fallbackHealthy = (i.repo?.fallbackEngines ?? []).some((e) => !isEngineTripped(i.engineHealth, e));
    if (!fallbackHealthy) reasons.push("pinned_engine_down");
  }
  return reasons;
}

/** Count of alerts shown on the header health indicator. */
export function countHealthAlerts(i: HealthInput): number {
  return healthAlertReasons(i).length;
}

export type PipelineStageId = "plan" | "code" | "review" | "merge";
export const PIPELINE_STAGES: readonly PipelineStageId[] = ["plan", "code", "review", "merge"];

/** Index of the compact 4-stage pipeline for a core StageKind (-1 when unknown). */
export function stageIndex(stage: StageKind | undefined): number {
  switch (stage) {
    case "plan":
    case "spec_test":
      return 0;
    case "implement":
      return 1;
    case "review":
      return 2;
    case "rebase":
      return 3;
    default:
      return -1;
  }
}

export type HeadlineState = "decision" | "executing" | "idle";

export function headlineState(pendingCount: number, workingCount: number): HeadlineState {
  if (pendingCount > 0) return "decision";
  if (workingCount > 0) return "executing";
  return "idle";
}

export type MissionFilter = "active" | "all";
const RECENT_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Mission Stream selection: live + recently finished (default) or every ticket, newest first. */
export function selectMissions(tickets: readonly Ticket[], filter: MissionFilter, now: number): Ticket[] {
  const visible = tickets.filter((tk) => !tk.isEpic || tk.status !== "delivered");
  const picked =
    filter === "all"
      ? visible
      : visible.filter(
          (tk) =>
            isLiveTicket(tk) ||
            (humanTicketPhase(tk.status) !== "queued" && now - Date.parse(tk.updatedAt) < RECENT_WINDOW_MS),
        );
  return [...picked].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, filter === "all" ? 100 : 24);
}

export function formatUsd(value: number | undefined): string {
  return `$${(value ?? 0).toFixed(2)}`;
}

/** Parse comma / newline separated path globs. */
export function parsePathList(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Scope paths → explicit `scope:<glob>` tokens. Core intake parses these deterministically into
 * structured `mandate.allowedPaths` with top priority (packages/core/src/intake.ts: extractScopeTags,
 * consumed by inferModuleScopedPaths). Tokens cannot contain whitespace, `,` or `;`.
 */
export function formatScopeTokens(paths: string[]): string[] {
  return paths
    .map((p) => p.trim().replace(/^scope:/i, "").replace(/[\s,;]+/g, ""))
    .filter(Boolean)
    .map((p) => `scope:${p}`);
}

/** Appends `scope:` tokens to a requirement (unchanged when there are no paths). */
export function withScopeTokens(requirement: string, paths: string[]): string {
  const tokens = formatScopeTokens(paths);
  return tokens.length ? `${requirement}\n\n${tokens.join(" ")}` : requirement;
}

/** Split a Markdown bullet / numbered list (or plain lines) into individual requirements. */
export function parseMilestoneRequirements(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
}

export function isSemver(raw: string): boolean {
  return /^v?\d+\.\d+\.\d+$/.test(raw.trim());
}
