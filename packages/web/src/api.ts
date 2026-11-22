import type {
  ChainOfRecall,
  HealthResponse,
  InboxItem,
  MemorySearchHit,
  OperatingMode,
  OutboxEntry,
  PipelineTemplateId,
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
};
