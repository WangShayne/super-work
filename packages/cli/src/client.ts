import type {
  EpicDecompositionPlan,
  EpicDeliveryMode,
  InboxItem,
  InboxItemStatus,
  PipelineTemplateId,
  RepoConfig,
  RepoMetricsSummary,
  StageRun,
  Ticket,
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
  };
  timestamp: string;
}

export interface ParsedSseEvent {
  event: string;
  data: Record<string, unknown>;
}

export class SuperWorkHttpClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
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
    inboxItems: InboxItem[];
    diff: string;
  }> {
    return this.request(`/api/tickets/${encodeURIComponent(id)}`);
  }

  createTicket(payload: {
    repoId: string;
    title: string;
    description: string;
    template?: PipelineTemplateId;
    allowedPaths?: string[];
    maxCostUsd?: number;
    preferredEngine?: WorkerEngineId;
  }): Promise<{ ticket: Ticket }> {
    return this.request<{ ticket: Ticket }>("/api/tickets", {
      method: "POST",
      body: JSON.stringify(payload),
    });
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
    epicDeliveryMode?: EpicDeliveryMode;
    preferredEngine?: WorkerEngineId;
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

  async streamEvents(
    onEvent: (event: ParsedSseEvent) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/events`, {
        headers: { Accept: "text/event-stream" },
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
  }
}
