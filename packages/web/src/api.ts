import type {
  ChainOfRecall,
  CliScanReport,
  EngineModelProfile,
  HealthResponse,
  InboxItem,
  LlmConnectionTestResult,
  LlmProviderPreset,
  ManagedWorktreeItem,
  MemorySearchHit,
  OperatingMode,
  OutboxEntry,
  PipelineTemplateId,
  PluginStatus,
  PublicSetupStatus,
  ReasoningEffort,
  RepoConfig,
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

/** Turn a thrown `request()` error (raw JSON body or text) into a readable message. */
export function parseApiError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    const body = JSON.parse(raw) as { error?: string; details?: string[] };
    if (body.error) {
      return body.details?.length ? `${body.error}: ${body.details.join("; ")}` : body.error;
    }
  } catch {
    // not JSON
  }
  return raw;
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

  cleanupTicketWorktree: (ticketId: string) =>
    request<{ ticket: Ticket }>(`/api/tickets/${ticketId}/cleanup-worktree`, {
      method: "POST",
      body: "{}",
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

  listPlugins: () => request<{ plugins: PluginStatus[] }>("/api/plugins"),

  enablePlugin: (id: string, config?: Record<string, unknown>) =>
    request<{ plugin: PluginStatus }>(`/api/plugins/${encodeURIComponent(id)}/enable`, {
      method: "POST",
      body: JSON.stringify(config ? { config } : {}),
    }),

  disablePlugin: (id: string) =>
    request<{ plugin: PluginStatus }>(`/api/plugins/${encodeURIComponent(id)}/disable`, {
      method: "POST",
      body: "{}",
    }),

  updatePluginConfig: (id: string, config: Record<string, unknown>) =>
    request<{ plugin: PluginStatus }>(`/api/plugins/${encodeURIComponent(id)}/config`, {
      method: "PUT",
      body: JSON.stringify({ config }),
    }),

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
