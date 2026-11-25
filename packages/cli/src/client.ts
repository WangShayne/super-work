import type {
  EngineHealthRecord,
  BackupArchiveInfo,
  BackupRestoreResult,
  BatchResolveInboxInput,
  BatchResolveInboxResult,
  CasebookEntry,
  ChiefAskResult,
  CreateCampaignInput,
  DagNodeMutationInput,
  DeliveryGatePolicy,
  EnginePreference,
  EpicDecompositionPlan,
  EpicDeliveryMode,
  EvalCase,
  EvalRunRecord,
  GoalCampaign,
  GoalCampaignWave,
  HandoverDigest,
  ImportKnowledgeBundleResult,
  InboxItem,
  InboxItemStatus,
  MergeTrainEntry,
  Milestone,
  OutboxEntry,
  PipelineTemplateId,
  PlaybookEntry,
  FlightEvent,
  PreviewSession,
  RepoConfig,
  RepoContractFile,
  RepoKnowledgeBundle,
  RepoMetricsSummary,
  RequirementIntakeInput,
  RequirementIntakePlan,
  RequirementIntakeResult,
  RestoreCheckpointInput,
  RoutineRun,
  RunDigestReport,
  RoutineScheduleKind,
  RoutineSpec,
  SelfReloadState,
  ServiceDaemonStatus,
  SpecClarificationResult,
  SpillArtifact,
  StageRun,
  SteerTicketInput,
  SymbolImpactReport,
  SystemDoctorReport,
  TaskBlueprint,
  Ticket,
  TicketCheckpoint,
  TicketReviewComment,
  WorkerEngineId,
} from "@super-work/core";

export class DaemonNotReachableError extends Error {
  constructor(
    public readonly baseUrl: string,
    cause?: unknown,
  ) {
    super(
      `Daemon is not reachable at ${baseUrl}. Run 'super-work up -d' or pass --auto-start.`,
    );
    this.name = "DaemonNotReachableError";
    if (cause) {
      this.cause = cause;
    }
  }
}

export interface DaemonHealth {
  ok: boolean;
  llmProvider: string;
  availableEngines: WorkerEngineId[];
  counts: {
    repos: number;
    tickets: number;
    pendingInbox: number;
    pendingOutbox: number;
    activeWorktrees?: number;
    reclaimableWorktrees?: number;
    activeRoutines?: number;
    activePreviews?: number;
    activeCampaigns?: number;
    queuedMergeTrain?: number;
  };
  selfReload?: SelfReloadState;
  timestamp: string;
}

export interface ParsedSseEvent {
  event: string;
  data: Record<string, unknown>;
}

export class SuperWorkHttpClient {
  readonly baseUrl: string;
  readonly token?: string;

  constructor(baseUrl: string, token?: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token?.trim() || undefined;
  }

  private authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...this.authHeaders(),
          ...(init?.headers ?? {}),
        },
      });
    } catch (err) {
      throw new DaemonNotReachableError(this.baseUrl, err);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(body || `HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }

  getHealth(): Promise<DaemonHealth> {
    return this.request<DaemonHealth>("/api/health");
  }

  getRunDigest(options?: { repoId?: string; hours?: number }): Promise<{ digest: RunDigestReport }> {
    const params = new URLSearchParams();
    if (options?.repoId) params.set("repoId", options.repoId);
    if (options?.hours !== undefined) params.set("hours", String(options.hours));
    const qs = params.toString();
    return this.request<{ digest: RunDigestReport }>(`/api/digest${qs ? `?${qs}` : ""}`);
  }

  listFlightEvents(options?: { repoId?: string; limit?: number }): Promise<{ events: FlightEvent[] }> {
    const params = new URLSearchParams();
    if (options?.repoId) params.set("repoId", options.repoId);
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    const qs = params.toString();
    return this.request<{ events: FlightEvent[] }>(`/api/flight-events${qs ? `?${qs}` : ""}`);
  }

  getMetrics(repoId?: string): Promise<{ metrics: RepoMetricsSummary }> {
    const qs = repoId ? `?repoId=${encodeURIComponent(repoId)}` : "";
    return this.request<{ metrics: RepoMetricsSummary }>(`/api/metrics${qs}`);
  }

  listRepos(): Promise<{ repos: RepoConfig[] }> {
    return this.request<{ repos: RepoConfig[] }>("/api/repos");
  }

  listTickets(repoId?: string): Promise<{ tickets: Ticket[] }> {
    const qs = repoId ? `?repoId=${encodeURIComponent(repoId)}` : "";
    return this.request<{ tickets: Ticket[] }>(`/api/tickets${qs}`);
  }

  getTicketDetail(id: string): Promise<{
    ticket: Ticket;
    stageRuns: StageRun[];
    artifacts: SpillArtifact[];
    inboxItems: InboxItem[];
    outboxEntries: OutboxEntry[];
    diff: string;
    checkpoints?: TicketCheckpoint[];
    reviewComments?: TicketReviewComment[];
    subtasks?: Ticket[];
    arenaCandidateDiffs?: Record<string, string>;
    upstreamDependencies?: Array<{
      id: string;
      repoId: string;
      repoName?: string;
      title: string;
      status: Ticket["status"];
      handoverDigest?: HandoverDigest;
    }>;
  }> {
    return this.request(`/api/tickets/${encodeURIComponent(id)}`);
  }

  getArtifact(id: string): Promise<{ artifact: SpillArtifact; content: string }> {
    return this.request(`/api/artifacts/${encodeURIComponent(id)}`);
  }

  revertTicket(id: string): Promise<{ ticket: Ticket; revertCommitSha: string }> {
    return this.request(`/api/tickets/${encodeURIComponent(id)}/revert`, {
      method: "POST",
    });
  }

  listPlaybook(repoId: string): Promise<{ entries: PlaybookEntry[] }> {
    return this.request(`/api/repos/${encodeURIComponent(repoId)}/playbook`);
  }

  addPlaybook(
    repoId: string,
    payload: { rule: string; scopePaths?: string[]; pinned?: boolean; enabled?: boolean },
  ): Promise<{ entry: PlaybookEntry }> {
    return this.request(`/api/repos/${encodeURIComponent(repoId)}/playbook`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  patchPlaybook(
    entryId: string,
    payload: { rule?: string; scopePaths?: string[]; pinned?: boolean; enabled?: boolean },
  ): Promise<{ entry: PlaybookEntry }> {
    return this.request(`/api/playbook/${encodeURIComponent(entryId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  }

  deletePlaybook(entryId: string): Promise<{ ok: boolean; id: string }> {
    return this.request(`/api/playbook/${encodeURIComponent(entryId)}`, {
      method: "DELETE",
    });
  }

  syncContract(repoId: string): Promise<{ repo: RepoConfig }> {
    return this.request(`/api/repos/${encodeURIComponent(repoId)}/contract/sync`, {
      method: "POST",
    });
  }

  exportContract(repoId: string): Promise<{
    repo: RepoConfig;
    contract: RepoContractFile;
    filePath: string;
  }> {
    return this.request(`/api/repos/${encodeURIComponent(repoId)}/contract/export`, {
      method: "POST",
    });
  }

  createTicket(payload: {
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
    arenaMode?: boolean;
    arenaCompetitorEngine?: WorkerEngineId;
    acceptanceCriteria?: string[];
  }): Promise<{ ticket: Ticket }> {
    return this.request<{ ticket: Ticket }>("/api/tickets", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  listBlueprints(repoId: string): Promise<{ blueprints: TaskBlueprint[] }> {
    return this.request(`/api/repos/${encodeURIComponent(repoId)}/blueprints`);
  }

  runDoctor(fix = false): Promise<SystemDoctorReport> {
    return this.request(fix ? "/api/system/doctor/fix" : "/api/system/doctor", {
      method: fix ? "POST" : "GET",
    });
  }

  listEngineHealth(): Promise<{ engines: EngineHealthRecord[] }> {
    return this.request("/api/system/engines");
  }

  resetEngineHealth(engine: string): Promise<{ engine: EngineHealthRecord }> {
    return this.request(`/api/system/engines/${encodeURIComponent(engine)}/reset`, { method: "POST" });
  }

  probeEngineHealth(
    engine?: string,
  ): Promise<{ probed: EngineHealthRecord[]; engines: EngineHealthRecord[] }> {
    return this.request("/api/system/engines/probe", {
      method: "POST",
      body: JSON.stringify(engine ? { engine } : {}),
    });
  }

  listBackups(): Promise<{ backups: BackupArchiveInfo[] }> {
    return this.request("/api/system/backups");
  }

  createBackup(): Promise<{ backup: BackupArchiveInfo }> {
    return this.request("/api/system/backups", { method: "POST" });
  }

  analyzeRepoImpact(repoId: string, paths: string[]): Promise<{ report: SymbolImpactReport }> {
    return this.request(`/api/repos/${encodeURIComponent(repoId)}/impact`, {
      method: "POST",
      body: JSON.stringify({ paths }),
    });
  }

  listCheckpoints(ticketId: string): Promise<{ checkpoints: TicketCheckpoint[] }> {
    return this.request(`/api/tickets/${encodeURIComponent(ticketId)}/checkpoints`);
  }

  getCheckpointDiff(
    ticketId: string,
    cpId: string,
    baseCpId?: string,
  ): Promise<{ diff: string; fromSha: string; toSha: string }> {
    const qs = baseCpId ? `?base=${encodeURIComponent(baseCpId)}` : "";
    return this.request(
      `/api/tickets/${encodeURIComponent(ticketId)}/checkpoints/${encodeURIComponent(cpId)}/diff${qs}`,
    );
  }

  restoreCheckpoint(
    ticketId: string,
    cpId: string,
    payload?: RestoreCheckpointInput,
  ): Promise<{ mode: "in_place" | "fork"; ticket: Ticket }> {
    return this.request(
      `/api/tickets/${encodeURIComponent(ticketId)}/checkpoints/${encodeURIComponent(cpId)}/restore`,
      {
        method: "POST",
        body: JSON.stringify(payload ?? {}),
      },
    );
  }

  mutateDagNode(ticketId: string, payload: DagNodeMutationInput): Promise<{ ticket: Ticket }> {
    return this.request(`/api/tickets/${encodeURIComponent(ticketId)}/dag-node`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  }

  clarifySpec(payload: {
    repoId: string;
    title: string;
    description: string;
    template?: PipelineTemplateId;
    answers?: Record<string, string>;
  }): Promise<{ clarification: SpecClarificationResult }> {
    return this.request("/api/specs/clarify", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  listPreviews(repoId?: string, ticketId?: string): Promise<{ previews: PreviewSession[] }> {
    const params = new URLSearchParams();
    if (repoId) params.set("repoId", repoId);
    if (ticketId) params.set("ticketId", ticketId);
    const qs = params.toString();
    return this.request(qs ? `/api/previews?${qs}` : "/api/previews");
  }

  startPreview(payload: {
    ticketId: string;
    candidateId?: string;
    ttlMinutes?: number;
  }): Promise<{ preview: PreviewSession }> {
    return this.request("/api/previews", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  renewPreview(id: string, ttlMinutes?: number): Promise<{ preview: PreviewSession }> {
    return this.request(`/api/previews/${encodeURIComponent(id)}/renew`, {
      method: "POST",
      body: JSON.stringify(ttlMinutes ? { ttlMinutes } : {}),
    });
  }

  stopPreview(id: string): Promise<{ preview: PreviewSession }> {
    return this.request(`/api/previews/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  async sendMcpMessage(message: unknown): Promise<unknown | null> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.authHeaders(),
        },
        body: JSON.stringify(message),
      });
    } catch (err) {
      throw new DaemonNotReachableError(this.baseUrl, err);
    }
    if (res.status === 202 || res.status === 204) {
      return null;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(body || `HTTP ${res.status}`);
    }
    const text = await res.text();
    return text.trim() ? (JSON.parse(text) as unknown) : null;
  }

  prunePlaybook(
    repoId: string,
  ): Promise<{ prunedIds: string[]; keptCount: number; entries: PlaybookEntry[] }> {
    return this.request(`/api/repos/${encodeURIComponent(repoId)}/playbook/prune`, {
      method: "POST",
      body: "{}",
    });
  }

  listCasebook(repoId: string, q?: string): Promise<{ entries: CasebookEntry[] }> {
    const qs = q ? `?q=${encodeURIComponent(q)}` : "";
    return this.request(`/api/repos/${encodeURIComponent(repoId)}/casebook${qs}`);
  }

  listRoutines(repoId?: string): Promise<{ routines: RoutineSpec[]; presets: unknown[] }> {
    const qs = repoId ? `?repoId=${encodeURIComponent(repoId)}` : "";
    return this.request(`/api/routines${qs}`);
  }

  createRoutine(payload: {
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
  }): Promise<{ routine: RoutineSpec }> {
    return this.request("/api/routines", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  patchRoutine(
    id: string,
    patch: Partial<Omit<RoutineSpec, "id" | "repoId" | "createdAt" | "updatedAt">>,
  ): Promise<{ routine: RoutineSpec }> {
    return this.request(`/api/routines/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  deleteRoutine(id: string): Promise<{ ok: boolean; id: string }> {
    return this.request(`/api/routines/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  runRoutineNow(id: string): Promise<{ run: RoutineRun }> {
    return this.request(`/api/routines/${encodeURIComponent(id)}/run`, {
      method: "POST",
      body: "{}",
    });
  }

  listRoutineRuns(filter?: {
    repoId?: string;
    routineId?: string;
    limit?: number;
  }): Promise<{ runs: RoutineRun[] }> {
    const params = new URLSearchParams();
    if (filter?.repoId) params.set("repoId", filter.repoId);
    if (filter?.routineId) params.set("routineId", filter.routineId);
    if (filter?.limit) params.set("limit", String(filter.limit));
    const qs = params.toString();
    return this.request(qs ? `/api/routines/runs?${qs}` : "/api/routines/runs");
  }

  previewEpic(payload: {
    repoId: string;
    title: string;
    description: string;
    template?: PipelineTemplateId;
  }): Promise<{ plan: EpicDecompositionPlan }> {
    return this.request<{ plan: EpicDecompositionPlan }>("/api/epics/preview", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  createEpic(payload: {
    repoId: string;
    title: string;
    description: string;
    template?: PipelineTemplateId;
    tddMode?: boolean;
    epicDeliveryMode?: EpicDeliveryMode;
    preferredEngine?: EnginePreference;
    maxCostUsdPerSubtask?: number;
  }): Promise<{ epic: Ticket; subtasks: Ticket[] }> {
    return this.request<{ epic: Ticket; subtasks: Ticket[] }>("/api/epics", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  listInbox(repoId?: string, status: InboxItemStatus = "pending"): Promise<{ items: InboxItem[] }> {
    const params = new URLSearchParams();
    if (repoId) params.set("repoId", repoId);
    if (status) params.set("status", status);
    const qs = params.toString();
    return this.request<{ items: InboxItem[] }>(qs ? `/api/inbox?${qs}` : "/api/inbox");
  }

  resolveInbox(
    id: string,
    payload: {
      decision: "approved" | "rejected";
      note?: string;
      deliveryAction?: "local_merge" | "push_and_create_pr";
      expandMandate?: boolean;
      budgetIncreaseUsd?: number;
      arenaWinnerId?: string;
      selectedOption?: string;
    },
  ): Promise<{ item: InboxItem; ticket: Ticket }> {
    return this.request<{ item: InboxItem; ticket: Ticket }>(
      `/api/inbox/${encodeURIComponent(id)}/resolve`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );
  }

  batchResolveInbox(payload: BatchResolveInboxInput): Promise<BatchResolveInboxResult> {
    return this.request<BatchResolveInboxResult>("/api/inbox/batch-resolve", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  steerTicket(ticketId: string, payload: SteerTicketInput): Promise<{ ticket: Ticket }> {
    return this.request<{ ticket: Ticket }>(
      `/api/tickets/${encodeURIComponent(ticketId)}/steer`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );
  }

  askChief(payload: { repoId?: string; question: string }): Promise<ChiefAskResult> {
    return this.request<ChiefAskResult>("/api/chief/ask", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  listEvalCases(repoId?: string): Promise<{ cases: EvalCase[] }> {
    const qs = repoId ? `?repoId=${encodeURIComponent(repoId)}` : "";
    return this.request<{ cases: EvalCase[] }>(`/api/evals/cases${qs}`);
  }

  saveEvalCaseFromTicket(ticketId: string): Promise<{ evalCase: EvalCase }> {
    return this.request<{ evalCase: EvalCase }>(
      `/api/evals/cases/from-ticket/${encodeURIComponent(ticketId)}`,
      { method: "POST", body: "{}" },
    );
  }

  deleteEvalCase(id: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`/api/evals/cases/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  listEvalRuns(repoId?: string, evalCaseId?: string): Promise<{ runs: EvalRunRecord[] }> {
    const params = new URLSearchParams();
    if (repoId) params.set("repoId", repoId);
    if (evalCaseId) params.set("evalCaseId", evalCaseId);
    const qs = params.toString();
    return this.request<{ runs: EvalRunRecord[] }>(`/api/evals/runs${qs ? `?${qs}` : ""}`);
  }

  runEval(payload: {
    evalCaseId: string;
    engines?: WorkerEngineId[];
    maxBudgetUsd?: number;
  }): Promise<{ evalRun: EvalRunRecord }> {
    return this.request<{ evalRun: EvalRunRecord }>("/api/evals/run", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  restoreBackup(backupId: string, force = false): Promise<BackupRestoreResult> {
    return this.request<BackupRestoreResult>(
      `/api/system/backups/${encodeURIComponent(backupId)}/restore`,
      {
        method: "POST",
        body: JSON.stringify({ force }),
      },
    );
  }

  exportKnowledgeBundle(repoId: string): Promise<{ bundle: RepoKnowledgeBundle }> {
    return this.request<{ bundle: RepoKnowledgeBundle }>(
      `/api/repos/${encodeURIComponent(repoId)}/knowledge-bundle`,
    );
  }

  importKnowledgeBundle(
    repoId: string,
    bundle: RepoKnowledgeBundle,
  ): Promise<ImportKnowledgeBundleResult> {
    return this.request<ImportKnowledgeBundleResult>(
      `/api/repos/${encodeURIComponent(repoId)}/knowledge-bundle/import`,
      {
        method: "POST",
        body: JSON.stringify({ bundle }),
      },
    );
  }

  listCampaigns(repoId?: string): Promise<{ campaigns: GoalCampaign[] }> {
    const qs = repoId ? `?repoId=${encodeURIComponent(repoId)}` : "";
    return this.request<{ campaigns: GoalCampaign[] }>(`/api/campaigns${qs}`);
  }

  getCampaign(id: string): Promise<{ campaign: GoalCampaign; waves: GoalCampaignWave[] }> {
    return this.request<{ campaign: GoalCampaign; waves: GoalCampaignWave[] }>(
      `/api/campaigns/${encodeURIComponent(id)}`,
    );
  }

  listMilestones(repoId?: string): Promise<{ milestones: Milestone[] }> {
    const qs = repoId ? `?repoId=${encodeURIComponent(repoId)}` : "";
    return this.request<{ milestones: Milestone[] }>(`/api/milestones${qs}`);
  }

  getMilestone(id: string): Promise<{ milestone: Milestone }> {
    return this.request<{ milestone: Milestone }>(`/api/milestones/${encodeURIComponent(id)}`);
  }

  createMilestone(payload: {
    repoId: string;
    name: string;
    targetVersion?: string;
    requirements: string[];
    preferredEngine?: EnginePreference;
    template?: PipelineTemplateId;
    maxBudgetUsdPerItem?: number;
    integrationMode?: "direct_main" | "milestone_branch";
    preferredRoute?: "auto" | "single_ticket";
  }): Promise<{ milestone: Milestone }> {
    return this.request<{ milestone: Milestone }>("/api/milestones", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  releaseMilestone(
    id: string,
    options: {
      bumpVersion?: boolean;
      createTag?: boolean;
      pushRemote?: boolean;
      squashReleaseCommit?: boolean;
      releaseCommitMessage?: string;
    },
  ): Promise<{ milestone: Milestone }> {
    return this.request<{ milestone: Milestone }>(
      `/api/milestones/${encodeURIComponent(id)}/release`,
      { method: "POST", body: JSON.stringify(options) },
    );
  }

  createCampaign(payload: CreateCampaignInput): Promise<{ campaign: GoalCampaign }> {
    return this.request<{ campaign: GoalCampaign }>("/api/campaigns", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  startCampaign(id: string, note?: string): Promise<{ campaign: GoalCampaign }> {
    return this.request<{ campaign: GoalCampaign }>(
      `/api/campaigns/${encodeURIComponent(id)}/start`,
      {
        method: "POST",
        body: JSON.stringify(note ? { note } : {}),
      },
    );
  }

  pauseCampaign(id: string, reason?: string): Promise<{ campaign: GoalCampaign }> {
    return this.request<{ campaign: GoalCampaign }>(
      `/api/campaigns/${encodeURIComponent(id)}/pause`,
      {
        method: "POST",
        body: JSON.stringify(reason ? { reason } : {}),
      },
    );
  }

  deliverCampaign(
    id: string,
    action: "local_merge" | "push_and_create_pr" = "local_merge",
  ): Promise<{ campaign: GoalCampaign }> {
    return this.request<{ campaign: GoalCampaign }>(
      `/api/campaigns/${encodeURIComponent(id)}/deliver`,
      {
        method: "POST",
        body: JSON.stringify({ action }),
      },
    );
  }

  deleteCampaign(id: string): Promise<{ ok: boolean; id: string }> {
    return this.request<{ ok: boolean; id: string }>(
      `/api/campaigns/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  }

  listMergeTrain(repoId?: string): Promise<{ entries: MergeTrainEntry[] }> {
    const qs = repoId ? `?repoId=${encodeURIComponent(repoId)}` : "";
    return this.request<{ entries: MergeTrainEntry[] }>(`/api/merge-train${qs}`);
  }

  flushMergeTrain(repoId?: string): Promise<{ mergedCount: number }> {
    return this.request<{ mergedCount: number }>("/api/merge-train/flush", {
      method: "POST",
      body: JSON.stringify(repoId ? { repoId } : {}),
    });
  }

  ejectMergeTrainEntry(entryId: string, reason?: string): Promise<{ entry: MergeTrainEntry }> {
    return this.request<{ entry: MergeTrainEntry }>(
      `/api/merge-train/${encodeURIComponent(entryId)}/eject`,
      {
        method: "POST",
        body: JSON.stringify(reason ? { reason } : {}),
      },
    );
  }

  getSystemService(lines = 40): Promise<{
    status: ServiceDaemonStatus;
    logs: { logFilePath: string; exists: boolean; lines: string[] };
  }> {
    return this.request(`/api/system/service?lines=${encodeURIComponent(String(lines))}`);
  }

  previewIntake(payload: RequirementIntakeInput): Promise<{ plan: RequirementIntakePlan }> {
    return this.request<{ plan: RequirementIntakePlan }>("/api/intake/preview", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  submitIntake(payload: RequirementIntakeInput): Promise<RequirementIntakeResult> {
    return this.request<RequirementIntakeResult>("/api/intake", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  getReloadStatus(): Promise<{ reload: SelfReloadState }> {
    return this.request<{ reload: SelfReloadState }>("/api/system/reload");
  }

  triggerReload(options?: {
    force?: boolean;
    skipCanary?: boolean;
  }): Promise<{ reload: SelfReloadState }> {
    return this.request<{ reload: SelfReloadState }>("/api/system/reload", {
      method: "POST",
      body: JSON.stringify(options ?? {}),
    });
  }

  async streamEvents(
    onEvent: (event: ParsedSseEvent) => void | Promise<void>,
    signal?: AbortSignal,
    options?: {
      repoId?: string;
      ticketId?: string;
      reconnect?: boolean;
      reconnectDelayMs?: number;
    },
  ): Promise<void> {
    const params = new URLSearchParams();
    if (options?.repoId) params.set("repoId", options.repoId);
    if (options?.ticketId) params.set("ticketId", options.ticketId);
    const qs = params.toString();
    const ssePath = qs ? `/api/events?${qs}` : "/api/events";

    const pumpOnce = async () => {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}${ssePath}`, {
          headers: {
            Accept: "text/event-stream",
            ...this.authHeaders(),
          },
          signal,
        });
      } catch (err) {
        if (signal?.aborted) return;
        throw new DaemonNotReachableError(this.baseUrl, err);
      }

      if (!res.ok || !res.body) {
        throw new Error(`Failed to open SSE stream: HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let eventName = "message";
      const dataLines: string[] = [];

      const flushEvent = async () => {
        if (dataLines.length === 0) return;
        const rawData = dataLines.join("\n");
        dataLines.length = 0;
        const currentEvent = eventName || "message";
        eventName = "message";
        try {
          const parsed = JSON.parse(rawData) as Record<string, unknown>;
          await onEvent({ event: currentEvent, data: parsed });
        } catch {
          // Ignore malformed SSE JSON payload
        }
      };

      try {
        while (!signal?.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let newlineIdx = buffer.indexOf("\n");
          while (newlineIdx !== -1) {
            const line = buffer.slice(0, newlineIdx).replace(/\r$/, "");
            buffer = buffer.slice(newlineIdx + 1);

            if (line === "") {
              await flushEvent();
            } else if (line.startsWith("event:")) {
              eventName = line.slice("event:".length).trim();
            } else if (line.startsWith("data:")) {
              dataLines.push(line.slice("data:".length).trim());
            }
            newlineIdx = buffer.indexOf("\n");
          }
        }
      } catch (err) {
        if (!signal?.aborted) {
          throw err;
        }
      } finally {
        try {
          await reader.cancel();
        } catch {
          // Ignore reader cancel errors
        }
      }
    };

    const delayMs = options?.reconnectDelayMs ?? 1000;
    do {
      try {
        await pumpOnce();
      } catch (err) {
        if (!options?.reconnect || signal?.aborted || err instanceof DaemonNotReachableError) {
          if (err instanceof DaemonNotReachableError && options?.reconnect && !signal?.aborted) {
            // Allow transient reconnect when server restarts
          } else {
            throw err;
          }
        }
      }
      if (!options?.reconnect || signal?.aborted) {
        break;
      }
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, delayMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolveWait();
        }, { once: true });
      });
    } while (!signal?.aborted);
  }
}
