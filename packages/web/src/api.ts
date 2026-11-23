import type {
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
  OperatingMode,
  OutboxEntry,
  PipelineTemplateId,
  PublicSetupStatus,
  ReasoningEffort,
  RepoConfig,
  RepoMetricsSummary,
  SpillArtifact,
  Ticket,
  TicketDetailResponse,
  WorkerEngineId,
  WorktreeGcResult,
} from "./types.ts";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
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
    patch: Omit<Partial<RepoConfig>, "maxConcurrentWorkers" | "dailyBudgetUsd"> & {
      maxConcurrentWorkers?: number | null;
      dailyBudgetUsd?: number | null;
    },
  ) =>
    request<{ repo: RepoConfig }>(`/api/repos/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
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
    maxCostUsd?: number;
    preferredEngine?: WorkerEngineId;
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
  }) =>
    request<PublicSetupStatus>("/api/setup/configure", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
};
