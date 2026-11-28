import type {
  ArenaCandidateResult,
  RefactorGuardConfig,
  CampaignDeliveryMode,
  CampaignDirection,
  CampaignStatus,
  CampaignWaveStatus,
  CasebookEntry,
  ConflictSemanticContext,
  DeliveryGatePolicy,
  EngineHealthFailureKind,
  EngineHealthRecord,
  EnginePreference,
  EpicReplanProposal,
  EvalCandidateRun,
  EvalCase,
  EvalRunRecord,
  FlightEvent,
  FlightEventKind,
  GoalCampaign,
  GoalCampaignWave,
  HandoverDigest,
  Milestone,
  MilestoneIntegrationMode,
  MilestoneItem,
  MilestoneStatus,
  InboxItem,
  LifecycleHooksConfig,
  MergeTrainEntry,
  MergeTrainEntryStatus,
  OutboxEntry,
  PipelineTemplateId,
  PlaybookEntry,
  RepoConfig,
  ReviewCommentAuthor,
  ReviewCommentStatus,
  ReviewSeverity,
  RoutineRun,
  RoutineSpec,
  SmokeCheckConfig,
  SpillArtifact,
  StageKind,
  StageRun,
  StageSpan,
  StageToolProfile,
  TaskBlueprint,
  TaskCategory,
  Thread,
  Ticket,
  TicketCheckpoint,
  TicketImpactSummary,
  TicketReviewComment,
  TicketRiskAssessment,
  Trigger,
  WorkerEngineId,
} from "@super-work/core";
import { normalizeVerificationStrategy } from "@super-work/core";

export function mapRepoRow(r: Record<string, unknown>): RepoConfig {
  return {
    id: String(r.id),
    name: String(r.name),
    rootPath: String(r.root_path),
    baseBranch: String(r.base_branch),
    mode: r.mode as RepoConfig["mode"],
    githubRepo: r.github_repo ? String(r.github_repo) : undefined,
    defaultTemplate: r.default_template as RepoConfig["defaultTemplate"],
    defaultTddMode: Boolean(r.default_tdd_mode),
    preferredImplementEngine: r.preferred_implement_engine as RepoConfig["preferredImplementEngine"],
    preferredReviewEngine: r.preferred_review_engine as RepoConfig["preferredReviewEngine"],
    fallbackEngines: r.fallback_engines_json
      ? (JSON.parse(String(r.fallback_engines_json)) as WorkerEngineId[])
      : undefined,
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
    hooks: r.hooks_json ? (JSON.parse(String(r.hooks_json)) as LifecycleHooksConfig) : undefined,
    smokeCheck: r.smoke_check_json
      ? (JSON.parse(String(r.smoke_check_json)) as SmokeCheckConfig)
      : undefined,
    previewCommand: r.preview_command ? String(r.preview_command) : undefined,
    sandboxMode: r.sandbox_mode ? (String(r.sandbox_mode) as RepoConfig["sandboxMode"]) : undefined,
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
    deliveryGatePolicy: r.delivery_gate_policy
      ? (String(r.delivery_gate_policy) as DeliveryGatePolicy)
      : undefined,
    riskThreshold:
      r.risk_threshold !== null && r.risk_threshold !== undefined
        ? Number(r.risk_threshold)
        : undefined,
    sensitivePaths: r.sensitive_paths_json
      ? (JSON.parse(String(r.sensitive_paths_json)) as string[])
      : undefined,
    blueprints: r.blueprints_json
      ? (JSON.parse(String(r.blueprints_json)) as TaskBlueprint[])
      : undefined,
    verificationStrategy: normalizeVerificationStrategy(r.verification_strategy),
    implementModelId: r.implement_model_id ? String(r.implement_model_id) : undefined,
    reviewModelId: r.review_model_id ? String(r.review_model_id) : undefined,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function mapTriggerRow(r: Record<string, unknown>): Trigger {
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

export function mapThreadRow(r: Record<string, unknown>): Thread {
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

export function mapTicketRow(r: Record<string, unknown>): Ticket {
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
    failedEngines: r.failed_engines_json
      ? (JSON.parse(String(r.failed_engines_json)) as WorkerEngineId[])
      : undefined,
    arenaMode: r.arena_mode ? Boolean(r.arena_mode) : undefined,
    arenaCompetitorEngine: r.arena_competitor_engine
      ? (String(r.arena_competitor_engine) as WorkerEngineId)
      : undefined,
    arenaCandidates: r.arena_candidates_json
      ? (JSON.parse(String(r.arena_candidates_json)) as ArenaCandidateResult[])
      : undefined,
    arenaWinnerId: r.arena_winner_id ? String(r.arena_winner_id) : undefined,
    tddMode: Boolean(r.tdd_mode),
    lockedTestPaths: r.locked_test_paths_json
      ? (JSON.parse(String(r.locked_test_paths_json)) as string[])
      : undefined,
    refactorGuard: r.refactor_guard_json
      ? (JSON.parse(String(r.refactor_guard_json)) as RefactorGuardConfig)
      : undefined,
    specTestCommitSha: r.spec_test_commit_sha ? String(r.spec_test_commit_sha) : undefined,
    specTestChallengeCount:
      r.spec_test_challenge_count !== null && r.spec_test_challenge_count !== undefined
        ? Number(r.spec_test_challenge_count)
        : undefined,
    taskCategory: r.task_category ? (String(r.task_category) as TaskCategory) : undefined,
    routingRationale: r.routing_rationale ? String(r.routing_rationale) : undefined,
    autoArenaEscalated: Boolean(r.auto_arena_escalated),
    impactSummary: r.impact_summary_json
      ? (JSON.parse(String(r.impact_summary_json)) as TicketImpactSummary)
      : undefined,
    pauseBeforeRun: Boolean(r.pause_before_run),
    blueprintId: r.blueprint_id ? String(r.blueprint_id) : undefined,
    deliveryGatePolicy: r.delivery_gate_policy
      ? (String(r.delivery_gate_policy) as DeliveryGatePolicy)
      : undefined,
    riskThreshold:
      r.risk_threshold !== null && r.risk_threshold !== undefined
        ? Number(r.risk_threshold)
        : undefined,
    riskAssessment: r.risk_assessment_json
      ? (JSON.parse(String(r.risk_assessment_json)) as TicketRiskAssessment)
      : undefined,
    conflictResolutionCount:
      r.conflict_resolution_count !== null && r.conflict_resolution_count !== undefined
        ? Number(r.conflict_resolution_count)
        : undefined,
    conflictContext: r.conflict_context_json
      ? (JSON.parse(String(r.conflict_context_json)) as ConflictSemanticContext)
      : undefined,
    clarificationCount:
      r.clarification_count !== null && r.clarification_count !== undefined
        ? Number(r.clarification_count)
        : undefined,
    steerCount:
      r.steer_count !== null && r.steer_count !== undefined ? Number(r.steer_count) : undefined,
    routineId: r.routine_id ? String(r.routine_id) : undefined,
    campaignId: r.campaign_id ? String(r.campaign_id) : undefined,
    milestoneId: r.milestone_id ? String(r.milestone_id) : undefined,
    campaignWave:
      r.campaign_wave !== null && r.campaign_wave !== undefined
        ? Number(r.campaign_wave)
        : undefined,
    targetBranch: r.target_branch ? String(r.target_branch) : undefined,
    barrierGroupId: r.barrier_group_id ? String(r.barrier_group_id) : undefined,
    baseHeadAtRebase: r.base_head_at_rebase ? String(r.base_head_at_rebase) : undefined,
    epicReplanCount:
      r.epic_replan_count !== null && r.epic_replan_count !== undefined
        ? Number(r.epic_replan_count)
        : undefined,
    epicReplanHistory: r.epic_replan_history_json
      ? (JSON.parse(String(r.epic_replan_history_json)) as EpicReplanProposal[])
      : undefined,
    pendingEpicReplan: r.pending_epic_replan_json
      ? (JSON.parse(String(r.pending_epic_replan_json)) as EpicReplanProposal)
      : undefined,
    preferredModelId: r.preferred_model_id ? String(r.preferred_model_id) : undefined,
    activeModelId: r.active_model_id ? String(r.active_model_id) : undefined,
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

export function mapStageRunRow(r: Record<string, unknown>): StageRun {
  return {
    id: String(r.id),
    ticketId: String(r.ticket_id),
    stage: r.stage as StageRun["stage"],
    engine: r.engine as StageRun["engine"],
    status: r.status as StageRun["status"],
    nativeSessionId: r.native_session_id ? String(r.native_session_id) : undefined,
    modelProfileId: r.model_profile_id ? String(r.model_profile_id) : undefined,
    costUsd: Number(r.cost_usd),
    startedAt: String(r.started_at),
    completedAt: r.completed_at ? String(r.completed_at) : undefined,
    summary: r.summary ? String(r.summary) : undefined,
    spillTranscriptId: r.spill_transcript_id ? String(r.spill_transcript_id) : undefined,
    spans: r.spans_json ? (JSON.parse(String(r.spans_json)) as StageSpan[]) : undefined,
    toolProfile: r.tool_profile_json
      ? (JSON.parse(String(r.tool_profile_json)) as StageToolProfile)
      : undefined,
    steered: r.steered ? Boolean(r.steered) : undefined,
  };
}

export function mapArtifactRow(r: Record<string, unknown>): SpillArtifact {
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

export function mapInboxRow(r: Record<string, unknown>): InboxItem {
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

export function mapOutboxRow(r: Record<string, unknown>): OutboxEntry {
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

export function mapPlaybookRow(r: Record<string, unknown>): PlaybookEntry {
  return {
    id: String(r.id),
    repoId: String(r.repo_id),
    rule: String(r.rule),
    scopePaths: r.scope_paths_json ? (JSON.parse(String(r.scope_paths_json)) as string[]) : ["**"],
    source: r.source as PlaybookEntry["source"],
    sourceTicketId: r.source_ticket_id ? String(r.source_ticket_id) : undefined,
    enabled: Boolean(r.enabled),
    pinned: Boolean(r.pinned),
    hitCount:
      r.hit_count !== null && r.hit_count !== undefined ? Number(r.hit_count) : 0,
    lastMatchedAt: r.last_matched_at ? String(r.last_matched_at) : undefined,
    suspect: Boolean(r.suspect),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function mapRoutineRow(r: Record<string, unknown>): RoutineSpec {
  return {
    id: String(r.id),
    repoId: String(r.repo_id),
    name: String(r.name),
    prompt: String(r.prompt),
    scheduleKind: String(r.schedule_kind) as RoutineSpec["scheduleKind"],
    intervalMinutes:
      r.interval_minutes !== null && r.interval_minutes !== undefined
        ? Number(r.interval_minutes)
        : undefined,
    cronExpr: r.cron_expr ? String(r.cron_expr) : undefined,
    activeHoursStart: r.active_hours_start ? String(r.active_hours_start) : undefined,
    activeHoursEnd: r.active_hours_end ? String(r.active_hours_end) : undefined,
    allowedPaths: r.allowed_paths_json
      ? (JSON.parse(String(r.allowed_paths_json)) as string[])
      : ["**"],
    template: String(r.template) as RoutineSpec["template"],
    preferredEngine: r.preferred_engine
      ? (String(r.preferred_engine) as WorkerEngineId)
      : undefined,
    maxBudgetUsd: Number(r.max_budget_usd ?? 1.5),
    enabled: Boolean(r.enabled),
    activeTicketId: r.active_ticket_id ? String(r.active_ticket_id) : undefined,
    lastRunAt: r.last_run_at ? String(r.last_run_at) : undefined,
    lastRunStatus: r.last_run_status
      ? (String(r.last_run_status) as RoutineRun["status"])
      : undefined,
    nextRunAt: r.next_run_at ? String(r.next_run_at) : undefined,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function mapRoutineRunRow(r: Record<string, unknown>): RoutineRun {
  return {
    id: String(r.id),
    routineId: String(r.routine_id),
    repoId: String(r.repo_id),
    status: String(r.status) as RoutineRun["status"],
    summary: String(r.summary),
    changedFiles: r.changed_files_json
      ? (JSON.parse(String(r.changed_files_json)) as string[])
      : [],
    promotedTicketId: r.promoted_ticket_id ? String(r.promoted_ticket_id) : undefined,
    costUsd: Number(r.cost_usd ?? 0),
    startedAt: String(r.started_at),
    completedAt: r.completed_at ? String(r.completed_at) : undefined,
  };
}

export function mapMilestoneRow(r: Record<string, unknown>): Milestone {
  let items: MilestoneItem[] = [];
  try {
    const parsed = JSON.parse(String(r.items_json ?? "[]")) as unknown;
    if (Array.isArray(parsed)) items = parsed as MilestoneItem[];
  } catch {
    items = [];
  }
  return {
    id: String(r.id),
    repoId: String(r.repo_id),
    name: String(r.name),
    targetVersion: r.target_version ? String(r.target_version) : undefined,
    status: String(r.status) as MilestoneStatus,
    items,
    releaseNotesZh: r.release_notes_zh ? String(r.release_notes_zh) : undefined,
    releaseNotesEn: r.release_notes_en ? String(r.release_notes_en) : undefined,
    digestSummary: r.digest_summary ? String(r.digest_summary) : undefined,
    releasedCommitSha: r.released_commit_sha ? String(r.released_commit_sha) : undefined,
    releasedTag: r.released_tag ? String(r.released_tag) : undefined,
    integrationMode: r.integration_mode
      ? (String(r.integration_mode) as MilestoneIntegrationMode)
      : undefined,
    stagingBranch: r.staging_branch ? String(r.staging_branch) : undefined,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function mapFlightEventRow(r: Record<string, unknown>): FlightEvent {
  let metadata: Record<string, unknown> | undefined;
  if (typeof r.metadata_json === "string" && r.metadata_json) {
    try {
      const parsed = JSON.parse(r.metadata_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      metadata = undefined;
    }
  }
  return {
    id: String(r.id),
    ...(r.repo_id != null ? { repoId: String(r.repo_id) } : {}),
    ...(r.ticket_id != null ? { ticketId: String(r.ticket_id) } : {}),
    kind: String(r.kind) as FlightEventKind,
    ...(r.engine != null ? { engine: String(r.engine) as WorkerEngineId } : {}),
    summary: String(r.summary),
    ...(r.saved_ms != null ? { savedMs: Number(r.saved_ms) } : {}),
    ...(metadata ? { metadata } : {}),
    createdAt: String(r.created_at),
  };
}

export function mapCasebookRow(r: Record<string, unknown>): CasebookEntry {
  return {
    id: String(r.id),
    repoId: String(r.repo_id),
    ticketId: String(r.ticket_id),
    title: String(r.title),
    goalSummary: String(r.goal_summary),
    solutionSummary: String(r.solution_summary),
    pitfallsAndFixes: r.pitfalls_and_fixes ? String(r.pitfalls_and_fixes) : undefined,
    changedFiles: r.changed_files_json
      ? (JSON.parse(String(r.changed_files_json)) as string[])
      : [],
    scopePaths: r.scope_paths_json
      ? (JSON.parse(String(r.scope_paths_json)) as string[])
      : ["**"],
    exportedSymbols: r.exported_symbols_json
      ? (JSON.parse(String(r.exported_symbols_json)) as string[])
      : [],
    reverted: Boolean(r.reverted),
    hitCount: Number(r.hit_count ?? 0),
    lastMatchedAt: r.last_matched_at ? String(r.last_matched_at) : undefined,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function mapCheckpointRow(r: Record<string, unknown>): TicketCheckpoint {
  return {
    id: String(r.id),
    ticketId: String(r.ticket_id),
    repoId: String(r.repo_id),
    stageRunId: r.stage_run_id ? String(r.stage_run_id) : undefined,
    stage: String(r.stage) as StageKind | "baseline",
    engine: r.engine ? (String(r.engine) as WorkerEngineId) : undefined,
    label: String(r.label),
    gitRef: String(r.git_ref),
    commitSha: String(r.commit_sha),
    changedFiles: r.changed_files_json
      ? (JSON.parse(String(r.changed_files_json)) as string[])
      : [],
    verificationPassed:
      r.verification_passed === null || r.verification_passed === undefined
        ? undefined
        : Boolean(r.verification_passed),
    createdAt: String(r.created_at),
    cleanedAt: r.cleaned_at ? String(r.cleaned_at) : undefined,
  };
}

export function mapReviewCommentRow(r: Record<string, unknown>): TicketReviewComment {
  return {
    id: String(r.id),
    ticketId: String(r.ticket_id),
    repoId: String(r.repo_id),
    filePath: String(r.file_path),
    line: Number(r.line),
    side: r.side ? (String(r.side) as "new" | "old") : undefined,
    codeSnippet: r.code_snippet ? String(r.code_snippet) : undefined,
    author: String(r.author) as ReviewCommentAuthor,
    severity: r.severity ? (String(r.severity) as ReviewSeverity) : undefined,
    body: String(r.body),
    status: String(r.status) as ReviewCommentStatus,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function mapEvalCaseRow(r: Record<string, unknown>): EvalCase {
  return {
    id: String(r.id),
    repoId: String(r.repo_id),
    sourceTicketId: r.source_ticket_id ? String(r.source_ticket_id) : undefined,
    title: String(r.title),
    description: String(r.description),
    baseCommitSha: String(r.base_commit_sha),
    allowedPaths: r.allowed_paths_json
      ? (JSON.parse(String(r.allowed_paths_json)) as string[])
      : ["**"],
    forbiddenPaths: r.forbidden_paths_json
      ? (JSON.parse(String(r.forbidden_paths_json)) as string[])
      : [],
    tddMode: Boolean(r.tdd_mode),
    lockedTestPaths: r.locked_test_paths_json
      ? (JSON.parse(String(r.locked_test_paths_json)) as string[])
      : undefined,
    verificationCommands: r.verification_commands_json
      ? (JSON.parse(String(r.verification_commands_json)) as string[])
      : [],
    smokeCheck: r.smoke_check_json
      ? (JSON.parse(String(r.smoke_check_json)) as SmokeCheckConfig)
      : undefined,
    referenceMetrics: r.reference_metrics_json
      ? (JSON.parse(String(r.reference_metrics_json)) as EvalCase["referenceMetrics"])
      : undefined,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function mapEvalRunRow(r: Record<string, unknown>): EvalRunRecord {
  return {
    id: String(r.id),
    evalCaseId: String(r.eval_case_id),
    repoId: String(r.repo_id),
    status: String(r.status) as EvalRunRecord["status"],
    engines: r.engines_json ? (JSON.parse(String(r.engines_json)) as WorkerEngineId[]) : [],
    results: r.results_json ? (JSON.parse(String(r.results_json)) as EvalCandidateRun[]) : [],
    maxBudgetUsd: Number(r.max_budget_usd ?? 2),
    totalCostUsd: Number(r.total_cost_usd ?? 0),
    startedAt: String(r.started_at),
    completedAt: r.completed_at ? String(r.completed_at) : undefined,
  };
}

export function mapGoalCampaignRow(r: Record<string, unknown>): GoalCampaign {
  return {
    id: String(r.id),
    repoId: String(r.repo_id),
    name: String(r.name),
    goalPrompt: String(r.goal_prompt),
    metricCommand: String(r.metric_command),
    metricRegex: r.metric_regex ? String(r.metric_regex) : undefined,
    metricUnit: r.metric_unit ? String(r.metric_unit) : undefined,
    direction: String(r.direction) as CampaignDirection,
    baselineValue:
      r.baseline_value !== null && r.baseline_value !== undefined
        ? Number(r.baseline_value)
        : undefined,
    currentValue:
      r.current_value !== null && r.current_value !== undefined
        ? Number(r.current_value)
        : undefined,
    targetValue: Number(r.target_value),
    deliveryMode: String(r.delivery_mode ?? "staging_branch") as CampaignDeliveryMode,
    stagingBranch: r.staging_branch ? String(r.staging_branch) : undefined,
    lastGoodCommitSha: r.last_good_commit_sha ? String(r.last_good_commit_sha) : undefined,
    allowedPaths: r.allowed_paths_json
      ? (JSON.parse(String(r.allowed_paths_json)) as string[])
      : ["**"],
    template: String(r.template ?? "fast") as PipelineTemplateId,
    preferredEngine: r.preferred_engine
      ? (String(r.preferred_engine) as EnginePreference)
      : undefined,
    maxIterations: Number(r.max_iterations ?? 5),
    completedWaves: Number(r.completed_waves ?? 0),
    maxTotalBudgetUsd: Number(r.max_total_budget_usd ?? 5),
    totalCostUsd: Number(r.total_cost_usd ?? 0),
    consecutiveNoImproveCount: Number(r.consecutive_no_improve_count ?? 0),
    activeTicketId: r.active_ticket_id ? String(r.active_ticket_id) : undefined,
    pauseReason: r.pause_reason ? String(r.pause_reason) : undefined,
    deliveredPrUrl: r.delivered_pr_url ? String(r.delivered_pr_url) : undefined,
    deliveredCommitSha: r.delivered_commit_sha ? String(r.delivered_commit_sha) : undefined,
    status: String(r.status) as CampaignStatus,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function mapGoalCampaignWaveRow(r: Record<string, unknown>): GoalCampaignWave {
  return {
    id: String(r.id),
    campaignId: String(r.campaign_id),
    repoId: String(r.repo_id),
    waveNumber: Number(r.wave_number),
    ticketId: r.ticket_id ? String(r.ticket_id) : undefined,
    status: String(r.status) as CampaignWaveStatus,
    beforeValue: Number(r.before_value),
    measuredValue:
      r.measured_value !== null && r.measured_value !== undefined
        ? Number(r.measured_value)
        : undefined,
    delta: r.delta !== null && r.delta !== undefined ? Number(r.delta) : undefined,
    commitSha: r.commit_sha ? String(r.commit_sha) : undefined,
    rolledBack: Boolean(r.rolled_back),
    costUsd: Number(r.cost_usd ?? 0),
    summary: String(r.summary ?? ""),
    startedAt: String(r.started_at),
    completedAt: r.completed_at ? String(r.completed_at) : undefined,
  };
}

export function mapMergeTrainEntryRow(r: Record<string, unknown>): MergeTrainEntry {
  return {
    id: String(r.id),
    repoId: String(r.repo_id),
    ticketId: String(r.ticket_id),
    outboxId: String(r.outbox_id),
    branchName: String(r.branch_name),
    baseBranch: String(r.base_branch),
    barrierGroupId: r.barrier_group_id ? String(r.barrier_group_id) : undefined,
    position: Number(r.position),
    status: String(r.status) as MergeTrainEntryStatus,
    bypassedSpeculation: Boolean(r.bypassed_speculation),
    speculativeCommitSha: r.speculative_commit_sha ? String(r.speculative_commit_sha) : undefined,
    mergedCommitSha: r.merged_commit_sha ? String(r.merged_commit_sha) : undefined,
    errorSummary: r.error_summary ? String(r.error_summary) : undefined,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function mapEngineHealthRow(r: Record<string, unknown>): EngineHealthRecord {
  return {
    engine: String(r.engine) as WorkerEngineId,
    status: String(r.status) as EngineHealthRecord["status"],
    ...(r.failure_kind != null ? { failureKind: String(r.failure_kind) as EngineHealthFailureKind } : {}),
    ...(r.reason != null ? { reason: String(r.reason) } : {}),
    ...(r.tripped_at != null ? { trippedAt: String(r.tripped_at) } : {}),
    ...(r.cooldown_until != null ? { cooldownUntil: String(r.cooldown_until) } : {}),
    consecutiveFailures: Number(r.consecutive_failures ?? 0),
    ...(r.last_probed_at != null ? { lastProbedAt: String(r.last_probed_at) } : {}),
    updatedAt: String(r.updated_at),
  };
}
