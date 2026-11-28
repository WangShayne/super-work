import type {
  AutonomyPreset,
  RepoAutoDetectResult,
  BackupArchiveInfo,
  BackupRestoreResult,
  BatchResolveInboxResult,
  CasebookEntry,
  ChainOfRecall,
  ChiefAskResult,
  CliScanReport,
  CreateCampaignInput,
  CreateMilestoneInput,
  Milestone,
  DagNodeMutationInput,
  DeliveryChannel,
  DeliveryGatePolicy,
  ApiWorkerPreset,
  ApiWorkerProfilePatch,
  EngineProfilePatch,
  EnginePreference,
  EpicDecompositionPlan,
  EpicDeliveryMode,
  EpicSubtaskSpec,
  EvalCase,
  EvalRunRecord,
  GoalCampaign,
  GoalCampaignWave,
  HealthResponse,
  ImportKnowledgeBundleResult,
  InboxItem,
  LifecycleHooksConfig,
  LlmConnectionTestResult,
  LlmProviderPreset,
  ManagedWorktreeItem,
  MemorySearchHit,
  MergeTrainEntry,
  NotificationConfig,
  OperatingMode,
  OutboxEntry,
  PipelineTemplateId,
  PlaybookEntry,
  PreviewSession,
  PublicSetupStatus,
  ReasoningEffort,
  RepoConfig,
  RepoContractFile,
  RepoKnowledgeBundle,
  FlightEvent,
  RepoMetricsSummary,
  RunDigestReport,
  RequirementIntakeInput,
  RequirementIntakePlan,
  RequirementIntakeResult,
  RestoreCheckpointInput,
  ReviewCommentStatus,
  RoutinePresetTemplate,
  RoutineRun,
  RoutineScheduleKind,
  RoutineSpec,
  SandboxMode,
  SelfReloadState,
  ServiceStatusResponse,
  SmokeCheckConfig,
  SpecClarificationResult,
  SpillArtifact,
  SubmitReviewCommentsInput,
  SymbolImpactReport,
  EngineHealthRecord,
  PlaybookHygieneReport,
  PlaybookHygienePruneResult,
  SystemDoctorReport,
  RefactorGuardConfig,
  TaskBlueprint,
  Ticket,
  TicketCheckpoint,
  TicketDetailResponse,
  TicketReviewComment,
  VerificationStrategy,
  WorkerConnectionTestResult,
  WorkerEngineId,
  WorktreeGcResult,
  ModelConnectionTestResult,
  ModelDiscoveryResult,
  ModelProfilePatch,
} from "./types.ts";

export function getAuthToken(): string | undefined {
  try {
    const params = new URLSearchParams(window.location.search);
    const qTok = params.get("token")?.trim();
    if (qTok) {
      localStorage.setItem("super_work_token", qTok);
      return qTok;
    }
    const stored = localStorage.getItem("super_work_token")?.trim();
    return stored || undefined;
  } catch {
    return undefined;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getAuthToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export const api = {
  getHealth: () => request<HealthResponse>("/api/health"),

  listRepos: () => request<{ repos: RepoConfig[] }>("/api/repos"),

  createRepo: (payload: {
    name: string;
    rootPath: string;
    baseBranch?: string;
    mode?: OperatingMode;
    githubRepo?: string;
    defaultTemplate?: PipelineTemplateId;
    defaultTddMode?: boolean;
    deliveryGatePolicy?: DeliveryGatePolicy;
    riskThreshold?: number;
    sensitivePaths?: string[];
    preferredImplementEngine?: EnginePreference;
    preferredReviewEngine?: WorkerEngineId;
    implementModelId?: string | null;
    reviewModelId?: string | null;
    verificationCommands?: string[];
    verificationStrategy?: VerificationStrategy;
    defaultDeliveryChannel?: DeliveryChannel;
    hooks?: LifecycleHooksConfig;
    autonomyPreset?: AutonomyPreset;
  }) => request<{ repo: RepoConfig }>("/api/repos", { method: "POST", body: JSON.stringify(payload) }),

  detectRepo: (rootPath: string) =>
    request<{ detected: RepoAutoDetectResult }>("/api/repos/detect", {
      method: "POST",
      body: JSON.stringify({ rootPath }),
    }).then((r) => r.detected),

  quickStartSetup: () =>
    request<PublicSetupStatus>("/api/setup/quick-start", { method: "POST", body: "{}" }),

  patchRepo: (
    id: string,
    patch: Omit<
      Partial<RepoConfig>,
      | "maxConcurrentWorkers"
      | "dailyBudgetUsd"
      | "conventions"
      | "smokeCheck"
      | "fallbackEngines"
      | "previewCommand"
      | "sandboxMode"
      | "deliveryGatePolicy"
      | "riskThreshold"
      | "sensitivePaths"
      | "blueprints"
      | "hooks"
      | "implementModelId"
      | "reviewModelId"
    > & {
      implementModelId?: string | null;
      reviewModelId?: string | null;
      maxConcurrentWorkers?: number | null;
      dailyBudgetUsd?: number | null;
      conventions?: string | null;
      smokeCheck?: SmokeCheckConfig | null;
      fallbackEngines?: WorkerEngineId[] | null;
      previewCommand?: string | null;
      sandboxMode?: SandboxMode | null;
      deliveryGatePolicy?: DeliveryGatePolicy | null;
      riskThreshold?: number | null;
      sensitivePaths?: string[] | null;
      blueprints?: TaskBlueprint[] | null;
      hooks?: LifecycleHooksConfig | null;
    },
  ) =>
    request<{ repo: RepoConfig }>(`/api/repos/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  syncRepoContract: (id: string) =>
    request<{ repo: RepoConfig }>(`/api/repos/${id}/contract/sync`, {
      method: "POST",
      body: "{}",
    }),

  exportRepoContract: (id: string) =>
    request<{ repo: RepoConfig; contract: RepoContractFile; filePath: string }>(
      `/api/repos/${id}/contract/export`,
      {
        method: "POST",
        body: "{}",
      },
    ),

  listPlaybook: (repoId: string) =>
    request<{ entries: PlaybookEntry[] }>(`/api/repos/${repoId}/playbook`),

  addPlaybook: (
    repoId: string,
    payload: { rule: string; scopePaths?: string[]; pinned?: boolean; enabled?: boolean },
  ) =>
    request<{ entry: PlaybookEntry }>(`/api/repos/${repoId}/playbook`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  patchPlaybook: (
    entryId: string,
    payload: { rule?: string; scopePaths?: string[]; pinned?: boolean; enabled?: boolean },
  ) =>
    request<{ entry: PlaybookEntry }>(`/api/playbook/${entryId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),

  deletePlaybook: (entryId: string) =>
    request<{ ok: boolean; id: string }>(`/api/playbook/${entryId}`, {
      method: "DELETE",
    }),

  prunePlaybook: (repoId: string) =>
    request<{ prunedIds: string[]; keptCount: number; entries: PlaybookEntry[] }>(
      `/api/repos/${repoId}/playbook/prune`,
      { method: "POST", body: "{}" },
    ),

  listCasebook: (repoId: string, q?: string) =>
    request<{ entries: CasebookEntry[] }>(
      q
        ? `/api/repos/${repoId}/casebook?q=${encodeURIComponent(q)}`
        : `/api/repos/${repoId}/casebook`,
    ),

  deleteCasebookEntry: (entryId: string) =>
    request<{ ok: boolean; id: string }>(`/api/casebook/${entryId}`, {
      method: "DELETE",
    }),

  listRoutines: (repoId?: string) =>
    request<{ routines: RoutineSpec[]; presets: RoutinePresetTemplate[] }>(
      repoId ? `/api/routines?repoId=${encodeURIComponent(repoId)}` : "/api/routines",
    ),

  listRoutineRuns: (filter?: { repoId?: string; routineId?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (filter?.repoId) params.set("repoId", filter.repoId);
    if (filter?.routineId) params.set("routineId", filter.routineId);
    if (filter?.limit) params.set("limit", String(filter.limit));
    const qs = params.toString();
    return request<{ runs: RoutineRun[] }>(qs ? `/api/routines/runs?${qs}` : "/api/routines/runs");
  },

  createRoutine: (payload: {
    repoId: string;
    name: string;
    prompt: string;
    scheduleKind: RoutineScheduleKind;
    intervalMinutes?: number;
    cronExpr?: string;
    activeHoursStart?: string;
    activeHoursEnd?: string;
    allowedPaths?: string[];
    template?: PipelineTemplateId;
    preferredEngine?: WorkerEngineId;
    maxBudgetUsd?: number;
    enabled?: boolean;
  }) =>
    request<{ routine: RoutineSpec }>("/api/routines", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  patchRoutine: (
    id: string,
    patch: Partial<Omit<RoutineSpec, "id" | "repoId" | "createdAt" | "updatedAt">>,
  ) =>
    request<{ routine: RoutineSpec }>(`/api/routines/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  deleteRoutine: (id: string) =>
    request<{ ok: boolean; id: string }>(`/api/routines/${id}`, {
      method: "DELETE",
    }),

  runRoutineNow: (id: string) =>
    request<{ run: RoutineRun }>(`/api/routines/${id}/run`, {
      method: "POST",
      body: "{}",
    }),

  getMetrics: (repoId?: string) =>
    request<{ metrics: RepoMetricsSummary }>(
      repoId ? `/api/metrics?repoId=${encodeURIComponent(repoId)}` : "/api/metrics",
    ),

  getRunDigest: (options?: { repoId?: string; hours?: number }) => {
    const params = new URLSearchParams();
    if (options?.repoId) params.set("repoId", options.repoId);
    if (options?.hours !== undefined) params.set("hours", String(options.hours));
    const qs = params.toString();
    return request<{ digest: RunDigestReport }>(`/api/digest${qs ? `?${qs}` : ""}`);
  },

  listFlightEvents: (options?: { repoId?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (options?.repoId) params.set("repoId", options.repoId);
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    const qs = params.toString();
    return request<{ events: FlightEvent[] }>(`/api/flight-events${qs ? `?${qs}` : ""}`);
  },

  listTickets: (repoId?: string) =>
    request<{ tickets: Ticket[] }>(repoId ? `/api/tickets?repoId=${encodeURIComponent(repoId)}` : "/api/tickets"),

  createTicket: (payload: {
    repoId: string;
    title: string;
    description: string;
    blueprintId?: string;
    deliveryGatePolicy?: DeliveryGatePolicy;
    riskThreshold?: number;
    template?: PipelineTemplateId;
    tddMode?: boolean;
    pauseBeforeRun?: boolean;
    allowedPaths?: string[];
    dependsOn?: string[];
    maxCostUsd?: number;
    preferredEngine?: EnginePreference;
    preferredModelId?: string;
    arenaMode?: boolean;
    arenaCompetitorEngine?: WorkerEngineId;
    modelOverride?: string;
    effortOverride?: ReasoningEffort;
    acceptanceCriteria?: string[];
    refactorGuard?: RefactorGuardConfig;
  }) => request<{ ticket: Ticket }>("/api/tickets", { method: "POST", body: JSON.stringify(payload) }),

  listBlueprints: (repoId: string) =>
    request<{ blueprints: TaskBlueprint[] }>(`/api/repos/${encodeURIComponent(repoId)}/blueprints`),

  listReviewComments: (ticketId: string) =>
    request<{ comments: TicketReviewComment[] }>(
      `/api/tickets/${encodeURIComponent(ticketId)}/review-comments`,
    ),

  submitReviewComments: (ticketId: string, payload: SubmitReviewCommentsInput) =>
    request<{ comments: TicketReviewComment[]; ticket: Ticket }>(
      `/api/tickets/${encodeURIComponent(ticketId)}/review-comments`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    ),

  updateReviewCommentStatus: (commentId: string, status: ReviewCommentStatus) =>
    request<{ comment: TicketReviewComment }>(
      `/api/review-comments/${encodeURIComponent(commentId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ status }),
      },
    ),

  runDoctor: (fix = false) =>
    request<SystemDoctorReport>(fix ? "/api/system/doctor/fix" : "/api/system/doctor", {
      method: fix ? "POST" : "GET",
    }),

  getPlaybookHygiene: (repoId?: string) =>
    request<PlaybookHygieneReport>(
      `/api/playbooks/hygiene${repoId ? `?repoId=${encodeURIComponent(repoId)}` : ""}`,
    ),

  prunePlaybookHygiene: (body: { repoId?: string; dryRun?: boolean; mode?: "disable" | "delete" } = {}) =>
    request<PlaybookHygienePruneResult>("/api/playbooks/hygiene/prune", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  listEngineHealth: () => request<{ engines: EngineHealthRecord[] }>("/api/system/engines"),

  resetEngineHealth: (engine: string) =>
    request<{ engine: EngineHealthRecord }>(`/api/system/engines/${encodeURIComponent(engine)}/reset`, {
      method: "POST",
    }),

  probeEngineHealth: (engine?: string) =>
    request<{ probed: EngineHealthRecord[]; engines: EngineHealthRecord[] }>("/api/system/engines/probe", {
      method: "POST",
      body: JSON.stringify(engine ? { engine } : {}),
    }),

  listBackups: () => request<{ backups: BackupArchiveInfo[] }>("/api/system/backups"),

  createBackup: () =>
    request<{ backup: BackupArchiveInfo }>("/api/system/backups", {
      method: "POST",
    }),

  restoreBackup: (backupId: string, force = false) =>
    request<BackupRestoreResult>(`/api/system/backups/${encodeURIComponent(backupId)}/restore`, {
      method: "POST",
      body: JSON.stringify({ force }),
    }),

  exportKnowledgeBundle: (repoId: string) =>
    request<{ bundle: RepoKnowledgeBundle }>(`/api/repos/${encodeURIComponent(repoId)}/knowledge-bundle`),

  importKnowledgeBundle: (repoId: string, bundle: RepoKnowledgeBundle) =>
    request<ImportKnowledgeBundleResult>(
      `/api/repos/${encodeURIComponent(repoId)}/knowledge-bundle/import`,
      {
        method: "POST",
        body: JSON.stringify({ bundle }),
      },
    ),

  analyzeRepoImpact: (repoId: string, paths: string[]) =>
    request<{ report: SymbolImpactReport }>(`/api/repos/${encodeURIComponent(repoId)}/impact`, {
      method: "POST",
      body: JSON.stringify({ paths }),
    }),

  listCheckpoints: (ticketId: string) =>
    request<{ checkpoints: TicketCheckpoint[] }>(
      `/api/tickets/${encodeURIComponent(ticketId)}/checkpoints`,
    ),

  getCheckpointDiff: (ticketId: string, cpId: string, baseCpId?: string) =>
    request<{ diff: string; fromSha: string; toSha: string }>(
      `/api/tickets/${encodeURIComponent(ticketId)}/checkpoints/${encodeURIComponent(cpId)}/diff${
        baseCpId ? `?base=${encodeURIComponent(baseCpId)}` : ""
      }`,
    ),

  restoreCheckpoint: (ticketId: string, cpId: string, payload?: RestoreCheckpointInput) =>
    request<{ mode: "in_place" | "fork"; ticket: Ticket }>(
      `/api/tickets/${encodeURIComponent(ticketId)}/checkpoints/${encodeURIComponent(cpId)}/restore`,
      { method: "POST", body: JSON.stringify(payload ?? {}) },
    ),

  mutateDagNode: (ticketId: string, payload: DagNodeMutationInput) =>
    request<{ ticket: Ticket }>(`/api/tickets/${encodeURIComponent(ticketId)}/dag-node`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),

  clarifySpec: (payload: {
    repoId: string;
    title: string;
    description: string;
    template?: PipelineTemplateId;
    answers?: Record<string, string>;
  }) =>
    request<{ clarification: SpecClarificationResult }>("/api/specs/clarify", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  listPreviews: (repoId?: string, ticketId?: string) => {
    const params = new URLSearchParams();
    if (repoId) params.set("repoId", repoId);
    if (ticketId) params.set("ticketId", ticketId);
    const qs = params.toString();
    return request<{ previews: PreviewSession[] }>(qs ? `/api/previews?${qs}` : "/api/previews");
  },

  startPreview: (payload: { ticketId: string; candidateId?: string; ttlMinutes?: number }) =>
    request<{ preview: PreviewSession }>("/api/previews", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  renewPreview: (id: string, ttlMinutes?: number) =>
    request<{ preview: PreviewSession }>(`/api/previews/${encodeURIComponent(id)}/renew`, {
      method: "POST",
      body: JSON.stringify(ttlMinutes ? { ttlMinutes } : {}),
    }),

  stopPreview: (id: string) =>
    request<{ preview: PreviewSession }>(`/api/previews/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  getTicketDetail: (id: string) => request<TicketDetailResponse>(`/api/tickets/${id}`),

  sendThreadMessage: (ticketId: string, message: string) =>
    request<{ ticket: Ticket }>(`/api/tickets/${ticketId}/message`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),

  steerTicket: (
    ticketId: string,
    payload: { instruction: string; preferredEngine?: EnginePreference; preferredModelId?: string },
  ) =>
    request<{ ticket: Ticket }>(`/api/tickets/${encodeURIComponent(ticketId)}/steer`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  cancelTicket: (ticketId: string) =>
    request<{ ticket: Ticket }>(`/api/tickets/${ticketId}/cancel`, { method: "POST", body: "{}" }),

  cleanupTicketWorktree: (ticketId: string) =>
    request<{ ticket: Ticket }>(`/api/tickets/${ticketId}/cleanup-worktree`, {
      method: "POST",
      body: "{}",
    }),

  deliverTicket: (ticketId: string, action: "local_merge" | "push_and_create_pr") =>
    request<{ ticket: Ticket; entry: OutboxEntry }>(`/api/tickets/${ticketId}/deliver`, {
      method: "POST",
      body: JSON.stringify({ action }),
    }),

  revertTicket: (ticketId: string) =>
    request<{ ticket: Ticket; revertCommitSha: string }>(`/api/tickets/${ticketId}/revert`, {
      method: "POST",
      body: "{}",
    }),

  previewEpic: (payload: {
    repoId: string;
    title: string;
    description: string;
    template?: PipelineTemplateId;
  }) =>
    request<{ plan: EpicDecompositionPlan }>("/api/epics/preview", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  createEpic: (payload: {
    repoId: string;
    title: string;
    description: string;
    template?: PipelineTemplateId;
    tddMode?: boolean;
    epicDeliveryMode?: EpicDeliveryMode;
    releaseBarrier?: boolean;
    barrierGroupId?: string;
    preferredEngine?: EnginePreference;
    preferredModelId?: string;
    modelOverride?: string;
    effortOverride?: ReasoningEffort;
    maxCostUsdPerSubtask?: number;
    subtasks?: EpicSubtaskSpec[];
  }) =>
    request<{ epic: Ticket; subtasks: Ticket[] }>("/api/epics", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  listWorktrees: (repoId?: string) =>
    request<{ items: ManagedWorktreeItem[] }>(
      repoId ? `/api/worktrees?repoId=${encodeURIComponent(repoId)}` : "/api/worktrees",
    ),

  gcWorktrees: (repoId?: string) =>
    request<{ result: WorktreeGcResult; items: ManagedWorktreeItem[] }>("/api/worktrees/gc", {
      method: "POST",
      body: JSON.stringify(repoId ? { repoId } : {}),
    }),

  simulateTrigger: (payload: {
    repoId: string;
    source: "github_issue" | "github_pr" | "github_ci" | "cli";
    threadKey: string;
    title: string;
    rawText: string;
  }) => request<{ result: unknown }>("/api/triggers", { method: "POST", body: JSON.stringify(payload) }),

  listInbox: (repoId?: string, status?: "pending" | "approved" | "rejected") => {
    const params = new URLSearchParams();
    if (repoId) params.set("repoId", repoId);
    if (status) params.set("status", status);
    const qs = params.toString();
    return request<{ items: InboxItem[] }>(qs ? `/api/inbox?${qs}` : "/api/inbox");
  },

  resolveInbox: (
    id: string,
    decision: "approved" | "rejected",
    note?: string,
    deliveryAction?: "local_merge" | "push_and_create_pr",
    options?: {
      expandMandate?: boolean;
      budgetIncreaseUsd?: number;
      arenaWinnerId?: string;
      selectedOption?: string;
    },
  ) =>
    request<{ item: InboxItem; ticket: Ticket }>(`/api/inbox/${id}/resolve`, {
      method: "POST",
      body: JSON.stringify({
        decision,
        note,
        deliveryAction,
        expandMandate: options?.expandMandate,
        budgetIncreaseUsd: options?.budgetIncreaseUsd,
        arenaWinnerId: options?.arenaWinnerId,
        selectedOption: options?.selectedOption,
      }),
    }),

  batchResolveInbox: (payload: {
    inboxIds?: string[];
    repoId?: string;
    onlyLowRisk?: boolean;
    decision: "approved" | "rejected";
    note?: string;
  }) =>
    request<BatchResolveInboxResult>("/api/inbox/batch-resolve", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  askChief: (payload: { repoId?: string; question: string }) =>
    request<ChiefAskResult>("/api/chief/ask", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  listEvalCases: (repoId?: string) =>
    request<{ cases: EvalCase[] }>(
      repoId ? `/api/evals/cases?repoId=${encodeURIComponent(repoId)}` : "/api/evals/cases",
    ),

  saveEvalCaseFromTicket: (ticketId: string) =>
    request<{ evalCase: EvalCase }>(`/api/evals/cases/from-ticket/${encodeURIComponent(ticketId)}`, {
      method: "POST",
      body: "{}",
    }),

  deleteEvalCase: (id: string) =>
    request<{ ok: boolean }>(`/api/evals/cases/${encodeURIComponent(id)}`, { method: "DELETE" }),

  listEvalRuns: (repoId?: string, evalCaseId?: string) => {
    const params = new URLSearchParams();
    if (repoId) params.set("repoId", repoId);
    if (evalCaseId) params.set("evalCaseId", evalCaseId);
    const qs = params.toString();
    return request<{ runs: EvalRunRecord[] }>(qs ? `/api/evals/runs?${qs}` : "/api/evals/runs");
  },

  runEval: (payload: {
    evalCaseId: string;
    engines?: WorkerEngineId[];
    maxBudgetUsd?: number;
  }) =>
    request<{ evalRun: EvalRunRecord }>("/api/evals/run", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  getRecall: (ticketId: string) => request<{ chain: ChainOfRecall }>(`/api/tickets/${ticketId}/recall`),

  searchMemory: (q: string, repoId?: string) => {
    const params = new URLSearchParams({ q });
    if (repoId) params.set("repoId", repoId);
    return request<{ hits: MemorySearchHit[] }>(`/api/memory/search?${params.toString()}`);
  },

  getArtifact: (id: string) => request<{ artifact: SpillArtifact; content: string }>(`/api/artifacts/${id}`),

  getArtifactRawUrl: (id: string) => {
    const token = getAuthToken();
    return token
      ? `/api/artifacts/${encodeURIComponent(id)}/raw?token=${encodeURIComponent(token)}`
      : `/api/artifacts/${encodeURIComponent(id)}/raw`;
  },

  listOutbox: (repoId?: string) =>
    request<{ entries: OutboxEntry[] }>(
      repoId ? `/api/outbox?repoId=${encodeURIComponent(repoId)}` : "/api/outbox",
    ),

  getSetupStatus: () => request<PublicSetupStatus>("/api/setup/status"),

  scanCliEnvironment: () =>
    request<{ scanReport: CliScanReport }>("/api/setup/scan", { method: "POST", body: "{}" }),

  testLlmConnection: (payload: {
    llmPreset: LlmProviderPreset;
    llmBaseUrl: string;
    llmModel: string;
    llmEffort?: ReasoningEffort;
    llmApiKey?: string;
    useSavedKey?: boolean;
  }) =>
    request<LlmConnectionTestResult>("/api/setup/test-llm", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  testWorkerConnection: (payload: {
    engine: WorkerEngineId;
    preset?: ApiWorkerPreset;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    useSavedKey?: boolean;
  }) =>
    request<WorkerConnectionTestResult>("/api/setup/test-worker", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  testModelConnection: (payload: ModelProfilePatch & { useSavedKey?: boolean }) =>
    request<ModelConnectionTestResult>("/api/setup/test-model", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  fetchProviderModels: (payload: ModelProfilePatch & { useSavedKey?: boolean }) =>
    request<ModelDiscoveryResult>("/api/setup/models", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  configureSetup: (payload: {
    llmPreset?: LlmProviderPreset;
    llmBaseUrl?: string;
    llmModel?: string;
    llmEffort?: ReasoningEffort;
    llmApiKey?: string;
    clearApiKey?: boolean;
    preferredImplementEngine?: WorkerEngineId;
    preferredReviewEngine?: WorkerEngineId;
    claudeProfile?: EngineProfilePatch;
    codexProfile?: EngineProfilePatch;
    opencodeProfile?: EngineProfilePatch;
    geminiProfile?: EngineProfilePatch;
    apiWorkerProfile?: ApiWorkerProfilePatch;
    /** v1.8.1 peer profiles: upserted by id; deleteModelProfileIds removes custom (non-builtin) profiles. */
    modelProfiles?: ModelProfilePatch[];
    deleteModelProfileIds?: string[];
    controlModelId?: string;
    implementModelId?: string;
    reviewModelId?: string;
    /** false: keep each repo's preferred engines (e.g. 'auto') instead of syncing them. */
    syncRepos?: boolean;
    notifications?: Partial<NotificationConfig> & {
      clearWebhookSecret?: boolean;
      clearActionSecret?: boolean;
      generateActionSecret?: boolean;
      clearGithubWebhookSecret?: boolean;
    };
  }) =>
    request<PublicSetupStatus>("/api/setup/configure", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  testNotification: (notifications?: Partial<NotificationConfig>) =>
    request<{
      ok: boolean;
      results: Array<{ channel: string; ok: boolean; detail?: string }>;
    }>("/api/notifications/test", {
      method: "POST",
      body: JSON.stringify(notifications ? { notifications } : {}),
    }),

  listCampaigns: (repoId?: string) =>
    request<{ campaigns: GoalCampaign[] }>(
      repoId ? `/api/campaigns?repoId=${encodeURIComponent(repoId)}` : "/api/campaigns",
    ),

  getCampaign: (id: string) =>
    request<{ campaign: GoalCampaign; waves: GoalCampaignWave[] }>(
      `/api/campaigns/${encodeURIComponent(id)}`,
    ),

  listMilestones: (repoId?: string) =>
    request<{ milestones: Milestone[] }>(
      `/api/milestones${repoId ? `?repoId=${encodeURIComponent(repoId)}` : ""}`,
    ),

  createMilestone: (payload: CreateMilestoneInput) =>
    request<{ milestone: Milestone }>("/api/milestones", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  releaseMilestone: (
    id: string,
    options: {
      bumpVersion: boolean;
      createTag: boolean;
      pushRemote: boolean;
      squashReleaseCommit?: boolean;
      releaseCommitMessage?: string;
      createGithubRelease?: boolean;
    },
  ) =>
    request<{ milestone: Milestone }>(`/api/milestones/${encodeURIComponent(id)}/release`, {
      method: "POST",
      body: JSON.stringify(options),
    }),

  createCampaign: (payload: CreateCampaignInput) =>
    request<{ campaign: GoalCampaign }>("/api/campaigns", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  startCampaign: (id: string, note?: string) =>
    request<{ campaign: GoalCampaign }>(`/api/campaigns/${encodeURIComponent(id)}/start`, {
      method: "POST",
      body: JSON.stringify(note ? { note } : {}),
    }),

  pauseCampaign: (id: string, reason?: string) =>
    request<{ campaign: GoalCampaign }>(`/api/campaigns/${encodeURIComponent(id)}/pause`, {
      method: "POST",
      body: JSON.stringify(reason ? { reason } : {}),
    }),

  deliverCampaign: (id: string, action: "local_merge" | "push_and_create_pr" = "local_merge") =>
    request<{ campaign: GoalCampaign }>(`/api/campaigns/${encodeURIComponent(id)}/deliver`, {
      method: "POST",
      body: JSON.stringify({ action }),
    }),

  deleteCampaign: (id: string) =>
    request<{ ok: boolean; id: string }>(`/api/campaigns/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  listMergeTrain: (repoId?: string) =>
    request<{ entries: MergeTrainEntry[] }>(
      repoId ? `/api/merge-train?repoId=${encodeURIComponent(repoId)}` : "/api/merge-train",
    ),

  flushMergeTrain: (repoId?: string) =>
    request<{ mergedCount: number }>("/api/merge-train/flush", {
      method: "POST",
      body: JSON.stringify(repoId ? { repoId } : {}),
    }),

  ejectMergeTrainEntry: (id: string, reason?: string) =>
    request<{ entry: MergeTrainEntry }>(`/api/merge-train/${encodeURIComponent(id)}/eject`, {
      method: "POST",
      body: JSON.stringify(reason ? { reason } : {}),
    }),

  getSystemService: (lines = 40) =>
    request<ServiceStatusResponse>(`/api/system/service?lines=${encodeURIComponent(String(lines))}`),

  previewIntake: (payload: RequirementIntakeInput) =>
    request<{ plan: RequirementIntakePlan }>("/api/intake/preview", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  submitIntake: (payload: RequirementIntakeInput) =>
    request<RequirementIntakeResult>("/api/intake", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  getSelfReloadStatus: () => request<{ reload: SelfReloadState }>("/api/system/reload"),

  triggerSelfReload: (options?: { force?: boolean; skipCanary?: boolean }) =>
    request<{ reload: SelfReloadState }>("/api/system/reload", {
      method: "POST",
      body: JSON.stringify(options ?? {}),
    }),
};
