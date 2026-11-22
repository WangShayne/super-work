import { existsSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type {
  ArtifactStore,
  CliScanReport,
  EngineModelProfile,
  InboxItemStatus,
  LlmProviderPreset,
  OutboxStatus,
  PublicSetupStatus,
  ReasoningEffort,
  RepoConfig,
  StateStore,
  SuperWorkKernel,
  SystemSetupConfig,
  TicketStatus,
  WorkerEngineId,
} from "@super-work/core";
import { newId, nowIso } from "@super-work/core";
import {
  CliEnvironmentScanner,
  MutableControlPlaneLLM,
  buildControlPlaneLLMFromSetup,
  testControlPlaneLLMConnection,
} from "@super-work/drivers";

export interface ServerAppDeps {
  kernel: SuperWorkKernel;
  stateStore: StateStore;
  artifactStore: ArtifactStore;
  llmProviderName?: string;
  mutableLlm?: MutableControlPlaneLLM;
  cliScanner?: CliEnvironmentScanner;
  webDistDir?: string;
}

export function maskApiKey(key?: string): string | undefined {
  const trimmed = key?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}****`;
  return `${trimmed.slice(0, 3)}****${trimmed.slice(-4)}`;
}

export function toPublicSetupStatus(
  savedConfig: SystemSetupConfig | null,
  scanReport: CliScanReport,
  activeLlmProvider: string,
): PublicSetupStatus {
  const cfg: SystemSetupConfig = savedConfig ?? {
    initialized: false,
    llmPreset: "deepseek",
    llmBaseUrl: "https://api.deepseek.com/v1",
    llmModel: "deepseek-chat",
    llmEffort: "low",
    preferredImplementEngine: scanReport.recommendedImplementEngine,
    preferredReviewEngine: scanReport.recommendedReviewEngine,
    claudeProfile: {},
    codexProfile: {},
    opencodeProfile: {},
    updatedAt: scanReport.scannedAt,
  };
  const { llmApiKey, ...rest } = cfg;
  return {
    initialized: cfg.initialized,
    activeLlmProvider,
    config: {
      ...rest,
      hasApiKey: Boolean(llmApiKey?.trim()),
      maskedApiKey: maskApiKey(llmApiKey),
    },
    scanReport,
  };
}

export function createServerApp(deps: ServerAppDeps): Hono {
  const { kernel, stateStore, artifactStore, webDistDir } = deps;
  const scanner = deps.cliScanner ?? new CliEnvironmentScanner();
  const getActiveProviderName = () =>
    deps.mutableLlm?.providerName ?? deps.llmProviderName ?? "heuristic:local";
  const app = new Hono();

  app.use("/api/*", cors());

  app.get("/api/health", async (c) => {
    const [repos, tickets, pendingInbox, pendingOutbox, availableEngines, worktrees] =
      await Promise.all([
        stateStore.listRepos(),
        stateStore.listTickets(),
        stateStore.listInboxItems({ status: "pending" }),
        stateStore.listOutboxEntries({ status: "pending" }),
        kernel.getAvailableEngines(),
        kernel.inspectWorktrees(),
      ]);
    return c.json({
      ok: true,
      llmProvider: getActiveProviderName(),
      availableEngines,
      counts: {
        repos: repos.length,
        tickets: tickets.length,
        pendingInbox: pendingInbox.length,
        pendingOutbox: pendingOutbox.length,
        activeWorktrees: worktrees.filter((w) => !w.reclaimable).length,
        reclaimableWorktrees: worktrees.filter((w) => w.reclaimable).length,
      },
      timestamp: nowIso(),
    });
  });

  // --- First-Run Setup & CLI Scan ---
  app.get("/api/setup/status", async (c) => {
    const savedConfig = await stateStore.getSystemSetting<SystemSetupConfig>("setup_config");
    let scanReport = await stateStore.getSystemSetting<CliScanReport>("last_cli_scan");
    if (!scanReport) {
      scanReport = await scanner.scanAll();
      await stateStore.setSystemSetting("last_cli_scan", scanReport);
    }
    return c.json(toPublicSetupStatus(savedConfig, scanReport, getActiveProviderName()));
  });

  app.post("/api/setup/scan", async (c) => {
    const scanReport = await scanner.scanAll();
    await stateStore.setSystemSetting("last_cli_scan", scanReport);
    return c.json({ scanReport });
  });

  app.post("/api/setup/test-llm", async (c) => {
    const body = (await c.req.json()) as {
      llmPreset?: LlmProviderPreset;
      llmBaseUrl?: string;
      llmModel?: string;
      llmEffort?: ReasoningEffort;
      llmApiKey?: string;
      useSavedKey?: boolean;
    };
    const preset: LlmProviderPreset = body.llmPreset ?? "heuristic";
    let apiKey = body.llmApiKey?.trim();
    if (!apiKey && body.useSavedKey) {
      const saved = await stateStore.getSystemSetting<SystemSetupConfig>("setup_config");
      apiKey = saved?.llmApiKey;
    }

    const result = await testControlPlaneLLMConnection({
      llmPreset: preset,
      llmBaseUrl: body.llmBaseUrl ?? "",
      llmModel: body.llmModel ?? "",
      llmEffort: body.llmEffort,
      llmApiKey: apiKey,
    });
    return c.json(result);
  });

  app.post("/api/setup/configure", async (c) => {
    const body = (await c.req.json()) as {
      llmPreset?: LlmProviderPreset;
      llmBaseUrl?: string;
      llmModel?: string;
      llmEffort?: ReasoningEffort;
      llmApiKey?: string;
      clearApiKey?: boolean;
      preferredImplementEngine?: WorkerEngineId;
      preferredReviewEngine?: WorkerEngineId;
      claudeProfile?: EngineModelProfile;
      codexProfile?: EngineModelProfile;
      opencodeProfile?: EngineModelProfile;
    };

    const existing = await stateStore.getSystemSetting<SystemSetupConfig>("setup_config");
    let scanReport = await stateStore.getSystemSetting<CliScanReport>("last_cli_scan");
    if (!scanReport) {
      scanReport = await scanner.scanAll();
      await stateStore.setSystemSetting("last_cli_scan", scanReport);
    }

    const finalApiKey = body.clearApiKey
      ? undefined
      : body.llmApiKey?.trim()
        ? body.llmApiKey.trim()
        : existing?.llmApiKey;

    const cleanProfile = (p?: EngineModelProfile): EngineModelProfile => ({
      model: p?.model?.trim() || undefined,
      effort: p?.effort || undefined,
    });

    const nextConfig: SystemSetupConfig = {
      initialized: true,
      llmPreset: body.llmPreset ?? existing?.llmPreset ?? "heuristic",
      llmBaseUrl: body.llmBaseUrl?.trim() ?? existing?.llmBaseUrl ?? "",
      llmModel: body.llmModel?.trim() ?? existing?.llmModel ?? "",
      llmEffort: body.llmEffort ?? existing?.llmEffort ?? "low",
      llmApiKey: finalApiKey,
      preferredImplementEngine:
        body.preferredImplementEngine ??
        existing?.preferredImplementEngine ??
        scanReport.recommendedImplementEngine,
      preferredReviewEngine:
        body.preferredReviewEngine ??
        existing?.preferredReviewEngine ??
        scanReport.recommendedReviewEngine,
      claudeProfile:
        body.claudeProfile !== undefined
          ? cleanProfile(body.claudeProfile)
          : (existing?.claudeProfile ?? {}),
      codexProfile:
        body.codexProfile !== undefined
          ? cleanProfile(body.codexProfile)
          : (existing?.codexProfile ?? {}),
      opencodeProfile:
        body.opencodeProfile !== undefined
          ? cleanProfile(body.opencodeProfile)
          : (existing?.opencodeProfile ?? {}),
      updatedAt: nowIso(),
    };

    await stateStore.setSystemSetting("setup_config", nextConfig);

    if (deps.mutableLlm) {
      deps.mutableLlm.reconfigure(buildControlPlaneLLMFromSetup(nextConfig));
    }

    const repos = await stateStore.listRepos();
    for (const repo of repos) {
      await stateStore.upsertRepo({
        ...repo,
        preferredImplementEngine: nextConfig.preferredImplementEngine,
        preferredReviewEngine: nextConfig.preferredReviewEngine,
        updatedAt: nowIso(),
      });
    }

    return c.json(toPublicSetupStatus(nextConfig, scanReport, getActiveProviderName()));
  });

  // --- Repositories ---
  app.get("/api/repos", async (c) => {
    const repos = await stateStore.listRepos();
    return c.json({ repos });
  });

  app.post("/api/repos", async (c) => {
    const body = (await c.req.json()) as Partial<RepoConfig>;
    if (!body.name || !body.rootPath) {
      return c.json({ error: "name and rootPath are required" }, 400);
    }
    const ts = nowIso();
    const repo: RepoConfig = {
      id: body.id ?? newId("repo"),
      name: body.name,
      rootPath: resolve(body.rootPath),
      baseBranch: body.baseBranch ?? "main",
      mode: body.mode ?? "observe",
      githubRepo: body.githubRepo,
      defaultTemplate: body.defaultTemplate ?? "standard",
      preferredImplementEngine: body.preferredImplementEngine ?? "claude",
      preferredReviewEngine: body.preferredReviewEngine ?? "codex",
      autoCleanupWorktree: body.autoCleanupWorktree ?? true,
      createdAt: ts,
      updatedAt: ts,
    };
    await stateStore.upsertRepo(repo);
    return c.json({ repo }, 201);
  });

  app.patch("/api/repos/:id", async (c) => {
    const id = c.req.param("id");
    const existing = await stateStore.getRepo(id);
    if (!existing) {
      return c.json({ error: "Repository not found" }, 404);
    }
    const patch = (await c.req.json()) as Partial<RepoConfig>;
    const updated: RepoConfig = {
      ...existing,
      ...patch,
      name: patch.name?.trim() || existing.name,
      baseBranch: patch.baseBranch?.trim() || existing.baseBranch,
      githubRepo:
        patch.githubRepo !== undefined
          ? patch.githubRepo.trim() || undefined
          : existing.githubRepo,
      autoCleanupWorktree: patch.autoCleanupWorktree ?? existing.autoCleanupWorktree ?? true,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: nowIso(),
    };
    await stateStore.upsertRepo(updated);
    return c.json({ repo: updated });
  });

  // --- Triggers ---
  app.post("/api/triggers", async (c) => {
    const body = (await c.req.json()) as {
      repoId?: string;
      source?: "web" | "github_issue" | "github_pr" | "github_ci" | "cli";
      externalRef?: string;
      threadKey?: string;
      title?: string;
      rawText?: string;
      payload?: Record<string, unknown>;
    };

    if (!body.repoId || !body.title || !body.rawText) {
      return c.json({ error: "repoId, title, and rawText are required" }, 400);
    }

    const result = await kernel.ingestTrigger({
      repoId: body.repoId,
      source: body.source ?? "github_issue",
      externalRef: body.externalRef,
      threadKey: body.threadKey ?? `sim:${newId("thread")}`,
      title: body.title,
      rawText: body.rawText,
      payload: body.payload,
    });

    void kernel.tick();
    return c.json({ result }, 201);
  });

  // --- Tickets ---
  app.get("/api/tickets", async (c) => {
    const repoId = c.req.query("repoId") || undefined;
    const status = (c.req.query("status") as TicketStatus | undefined) || undefined;
    const tickets = await stateStore.listTickets({ repoId, status });
    return c.json({ tickets });
  });

  app.post("/api/tickets", async (c) => {
    const body = (await c.req.json()) as {
      repoId?: string;
      title?: string;
      description?: string;
      template?: RepoConfig["defaultTemplate"];
      allowedPaths?: string[];
      forbiddenPaths?: string[];
      maxCostUsd?: number;
      preferredEngine?: RepoConfig["preferredImplementEngine"];
      modelOverride?: string;
      effortOverride?: ReasoningEffort;
      acceptanceCriteria?: string[];
    };

    if (!body.repoId || !body.title || !body.description) {
      return c.json({ error: "repoId, title, and description are required" }, 400);
    }

    const ticket = await kernel.createDirectTicket({
      repoId: body.repoId,
      title: body.title,
      description: body.description,
      template: body.template,
      allowedPaths: body.allowedPaths,
      forbiddenPaths: body.forbiddenPaths,
      maxCostUsd: body.maxCostUsd,
      preferredEngine: body.preferredEngine,
      modelOverride: body.modelOverride,
      effortOverride: body.effortOverride,
      acceptanceCriteria: body.acceptanceCriteria,
    });

    void kernel.tick();
    return c.json({ ticket }, 201);
  });

  app.get("/api/tickets/:id", async (c) => {
    const id = c.req.param("id");
    const ticket = await stateStore.getTicket(id);
    if (!ticket) {
      return c.json({ error: "Ticket not found" }, 404);
    }
    const repo = await stateStore.getRepo(ticket.repoId);
    const [stageRuns, artifacts, inboxItems, outboxEntries] = await Promise.all([
      stateStore.listStageRuns(ticket.id),
      stateStore.listArtifacts(ticket.id),
      stateStore.listInboxItems({ ticketId: ticket.id }),
      stateStore.listOutboxEntries({ ticketId: ticket.id }),
    ]);

    let diff = "";
    if (repo) {
      try {
        if (ticket.worktreePath && existsSync(ticket.worktreePath)) {
          diff = await kernel.workspace.getDiff(ticket.worktreePath, repo.baseBranch);
        } else if (ticket.branchName) {
          diff = await kernel.workspace.getBranchDiff(
            repo.rootPath,
            repo.baseBranch,
            ticket.branchName,
          );
        }
      } catch {
        diff = "";
      }
    }

    return c.json({
      ticket,
      stageRuns,
      artifacts,
      inboxItems,
      outboxEntries,
      diff,
    });
  });

  app.post("/api/tickets/:id/message", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json()) as { message?: string };
    if (!body.message?.trim()) {
      return c.json({ error: "message is required" }, 400);
    }
    const ticket = await kernel.sendThreadMessage(id, body.message.trim());
    void kernel.tick();
    return c.json({ ticket });
  });

  app.post("/api/tickets/:id/cancel", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    const ticket = await kernel.cancelTicket(id, body.reason);
    return c.json({ ticket });
  });

  app.post("/api/tickets/:id/cleanup-worktree", async (c) => {
    const id = c.req.param("id");
    try {
      const ticket = await kernel.cleanupTicketWorktree(id);
      if (!ticket) {
        return c.json({ error: "Ticket not found" }, 404);
      }
      return c.json({ ticket });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // --- Worktree Lifecycle & GC ---
  app.get("/api/worktrees", async (c) => {
    const repoId = c.req.query("repoId") || undefined;
    const items = await kernel.inspectWorktrees(repoId);
    return c.json({ items });
  });

  app.post("/api/worktrees/gc", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { repoId?: string };
    const result = await kernel.gcWorktrees({ repoId: body.repoId });
    const items = await kernel.inspectWorktrees(body.repoId);
    return c.json({ result, items });
  });

  // --- Attention Inbox ---
  app.get("/api/inbox", async (c) => {
    const repoId = c.req.query("repoId") || undefined;
    const status = (c.req.query("status") as InboxItemStatus | undefined) || undefined;
    const items = await stateStore.listInboxItems({ repoId, status });
    return c.json({ items });
  });

  app.post("/api/inbox/:id/resolve", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json()) as {
      decision?: "approved" | "rejected";
      note?: string;
    };
    if (body.decision !== "approved" && body.decision !== "rejected") {
      return c.json({ error: "decision must be 'approved' or 'rejected'" }, 400);
    }
    const result = await kernel.resolveInboxItem(id, body.decision, body.note);
    void kernel.tick();
    void kernel.outbox.processDueEntries();
    return c.json(result);
  });

  // --- Chain of Recall & Memory ---
  app.get("/api/tickets/:id/recall", async (c) => {
    const id = c.req.param("id");
    const chain = await kernel.memory.getChainOfRecall(id);
    if (!chain) {
      return c.json({ error: "Ticket not found" }, 404);
    }
    return c.json({ chain });
  });

  app.get("/api/memory/search", async (c) => {
    const q = c.req.query("q") ?? "";
    const repoId = c.req.query("repoId") || undefined;
    const limit = Number(c.req.query("limit") ?? 10);
    const hits = await stateStore.searchMemory(q, Number.isFinite(limit) ? limit : 10, repoId);
    return c.json({ hits });
  });

  app.get("/api/artifacts/:id", async (c) => {
    const id = c.req.param("id");
    const artifact = await stateStore.getArtifact(id);
    if (!artifact) {
      return c.json({ error: "Artifact not found" }, 404);
    }
    const content = await artifactStore.readSpill(artifact.storageUri);
    return c.json({ artifact, content });
  });

  // --- Transactional Outbox ---
  app.get("/api/outbox", async (c) => {
    const repoId = c.req.query("repoId") || undefined;
    const ticketId = c.req.query("ticketId") || undefined;
    const status = (c.req.query("status") as OutboxStatus | undefined) || undefined;
    const entries = await stateStore.listOutboxEntries({ repoId, ticketId, status });
    return c.json({ entries });
  });

  // --- Real-time SSE Bus ---
  app.get("/api/events", (c) => {
    return streamSSE(c, async (stream) => {
      let closed = false;
      let resolveClosed!: () => void;
      const donePromise = new Promise<void>((res) => {
        resolveClosed = res;
      });

      const unsubscribe = kernel.subscribe((event) => {
        if (closed) return;
        void stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        });
      });

      const heartbeat = setInterval(() => {
        if (closed) return;
        void stream.writeSSE({
          event: "ping",
          data: JSON.stringify({ timestamp: nowIso() }),
        });
      }, 15_000);

      stream.onAbort(() => {
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        resolveClosed();
      });

      await stream.writeSSE({
        event: "connected",
        data: JSON.stringify({ timestamp: nowIso() }),
      });

      await donePromise;
    });
  });

  // --- Static Web Dashboard (when built into packages/web/dist) ---
  if (webDistDir && existsSync(webDistDir)) {
    const resolvedDist = resolve(webDistDir);
    app.get("*", async (c) => {
      const reqPath = c.req.path === "/" ? "/index.html" : c.req.path;
      const safeRel = normalize(reqPath).replace(/^(\.\.[/\\])+/, "").replace(/^\/+/, "");
      const candidate = resolve(join(resolvedDist, safeRel));
      if (candidate.startsWith(resolvedDist) && existsSync(candidate)) {
        const file = Bun.file(candidate);
        if (await file.exists()) {
          return new Response(file);
        }
      }
      const indexFile = Bun.file(join(resolvedDist, "index.html"));
      if (await indexFile.exists()) {
        return new Response(indexFile, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return c.text("Not Found", 404);
    });
  }

  return app;
}
