import type {
  ChainOfRecall,
  CliScanReport,
  EngineModelProfile,
  HealthResponse,
  InboxItem,
  LlmConnectionTestResult,
  LlmProviderPreset,
  MemorySearchHit,
  OperatingMode,
  OutboxEntry,
  PipelineTemplateId,
  PublicSetupStatus,
  ReasoningEffort,
  RepoConfig,
  SpillArtifact,
  Ticket,
  TicketDetailResponse,
  WorkerEngineId,
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
  }) => request<{ repo: RepoConfig }>("/api/repos", { method: "POST", body: JSON.stringify(payload) }),

  patchRepo: (id: string, patch: Partial<RepoConfig>) =>
    request<{ repo: RepoConfig }>(`/api/repos/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

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

  resolveInbox: (id: string, decision: "approved" | "rejected", note?: string) =>
    request<{ item: InboxItem; ticket: Ticket }>(`/api/inbox/${id}/resolve`, {
      method: "POST",
      body: JSON.stringify({ decision, note }),
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
  }) =>
    request<PublicSetupStatus>("/api/setup/configure", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
};
