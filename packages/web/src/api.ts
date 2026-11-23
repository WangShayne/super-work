import type {
  CasebookEntry,
  ChainOfRecall,
  CliScanReport,
  DeliveryChannel,
  EngineModelProfile,
  EpicDecompositionPlan,
  EpicDeliveryMode,
  EpicSubtaskSpec,
  HealthResponse,
  InboxItem,
  LlmConnectionTestResult,
  LlmProviderPreset,
  ManagedWorktreeItem,
  MemorySearchHit,
  NotificationConfig,
  OperatingMode,
  OutboxEntry,
  PipelineTemplateId,
  PlaybookEntry,
  PublicSetupStatus,
  ReasoningEffort,
  RepoConfig,
  RepoContractFile,
  RepoMetricsSummary,
  RoutinePresetTemplate,
  RoutineRun,
  RoutineScheduleKind,
  RoutineSpec,
  SmokeCheckConfig,
  SpillArtifact,
  Ticket,
  TicketDetailResponse,
  WorkerEngineId,
  WorktreeGcResult,
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
    preferredImplementEngine?: WorkerEngineId;
    preferredReviewEngine?: WorkerEngineId;
    verificationCommands?: string[];
    defaultDeliveryChannel?: DeliveryChannel;
  }) => request<{ repo: RepoConfig }>("/api/repos", { method: "POST", body: JSON.stringify(payload) }),

  patchRepo: (
    id: string,
    patch: Omit<
      Partial<RepoConfig>,
      "maxConcurrentWorkers" | "dailyBudgetUsd" | "conventions" | "smokeCheck" | "fallbackEngines"
    > & {
      maxConcurrentWorkers?: number | null;
      dailyBudgetUsd?: number | null;
      conventions?: string | null;
      smokeCheck?: SmokeCheckConfig | null;
      fallbackEngines?: WorkerEngineId[] | null;
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

  listTickets: (repoId?: string) =>
    request<{ tickets: Ticket[] }>(repoId ? `/api/tickets?repoId=${encodeURIComponent(repoId)}` : "/api/tickets"),

  createTicket: (payload: {
    repoId: string;
    title: string;
    description: string;
    template?: PipelineTemplateId;
    allowedPaths?: string[];
    dependsOn?: string[];
    maxCostUsd?: number;
    preferredEngine?: WorkerEngineId;
    arenaMode?: boolean;
    arenaCompetitorEngine?: WorkerEngineId;
    modelOverride?: string;
    effortOverride?: ReasoningEffort;
  }) => request<{ ticket: Ticket }>("/api/tickets", { method: "POST", body: JSON.stringify(payload) }),

  getTicketDetail: (id: string) => request<TicketDetailResponse>(`/api/tickets/${id}`),

  sendThreadMessage: (ticketId: string, message: string) =>
    request<{ ticket: Ticket }>(`/api/tickets/${ticketId}/message`, {
      method: "POST",
      body: JSON.stringify({ message }),
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
    epicDeliveryMode?: EpicDeliveryMode;
    preferredEngine?: WorkerEngineId;
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
      }),
    }),

  getRecall: (ticketId: string) => request<{ chain: ChainOfRecall }>(`/api/tickets/${ticketId}/recall`),

  searchMemory: (q: string, repoId?: string) => {
    const params = new URLSearchParams({ q });
    if (repoId) params.set("repoId", repoId);
    return request<{ hits: MemorySearchHit[] }>(`/api/memory/search?${params.toString()}`);
  },

  getArtifact: (id: string) => request<{ artifact: SpillArtifact; content: string }>(`/api/artifacts/${id}`),

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

  configureSetup: (payload: {
    llmPreset: LlmProviderPreset;
    llmBaseUrl: string;
    llmModel: string;
    llmEffort?: ReasoningEffort;
    llmApiKey?: string;
    clearApiKey?: boolean;
    preferredImplementEngine: WorkerEngineId;
    preferredReviewEngine: WorkerEngineId;
    claudeProfile?: EngineModelProfile;
    codexProfile?: EngineModelProfile;
    opencodeProfile?: EngineModelProfile;
    notifications?: Partial<NotificationConfig> & { clearWebhookSecret?: boolean };
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
};
