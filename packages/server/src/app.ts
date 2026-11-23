import { existsSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import {
  ROUTINE_PRESET_TEMPLATES,
  classifyPlaybookHealth,
  newId,
  normalizePlaybookRuleText,
  normalizeSmokeCheckConfig,
  nowIso,
} from "@super-work/core";
import type {
  ArtifactStore,
  CliScanReport,
  CreateEpicInput,
  DeliveryChannel,
  EngineModelProfile,
  EpicDeliveryMode,
  HandoverDigest,
  InboxItemStatus,
  KernelEvent,
  LlmProviderPreset,
  NotificationConfig,
  OutboxStatus,
  PipelineTemplateId,
  PlaybookEntry,
  PublicSetupStatus,
  ReasoningEffort,
  RepoConfig,
  RoutineScheduleKind,
  RoutineSpec,
  SmokeCheckConfig,
  StateStore,
  SuperWorkKernel,
  SystemSetupConfig,
  Ticket,
  TicketStatus,
  WorkerEngineId,
} from "@super-work/core";
import {
  CliEnvironmentScanner,
  DEFAULT_NOTIFICATION_CONFIG,
  MutableControlPlaneLLM,
  NotificationDispatcher,
  buildControlPlaneLLMFromSetup,
  sanitizeCliModelName,
  testControlPlaneLLMConnection,
} from "@super-work/drivers";

function normalizeSetupModel(preset: LlmProviderPreset, model?: string): string {
  if (preset === "claude_cli" || preset === "codex_cli") {
    return sanitizeCliModelName(model) ?? "";
  }
  return model?.trim() ?? "";
}

export interface ServerAppDeps {
  kernel: SuperWorkKernel;
  stateStore: StateStore;
  artifactStore: ArtifactStore;
  llmProviderName?: string;
  mutableLlm?: MutableControlPlaneLLM;
  cliScanner?: CliEnvironmentScanner;
  notificationDispatcher?: NotificationDispatcher;
  authToken?: string;
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
    notifications: { ...DEFAULT_NOTIFICATION_CONFIG },
    updatedAt: scanReport.scannedAt,
  };
  const { llmApiKey, notifications, ...rest } = cfg;
  const mergedNotifs: NotificationConfig = {
    ...DEFAULT_NOTIFICATION_CONFIG,
    ...(notifications ?? {}),
  };
  const { webhookSecret, ...notifRest } = mergedNotifs;
  return {
    initialized: cfg.initialized,
    activeLlmProvider,
    config: {
      ...rest,
      llmModel: normalizeSetupModel(cfg.llmPreset, rest.llmModel),
      hasApiKey: Boolean(llmApiKey?.trim()),
      maskedApiKey: maskApiKey(llmApiKey),
      notifications: {
        ...notifRest,
        hasWebhookSecret: Boolean(webhookSecret?.trim()),
        maskedWebhookSecret: maskApiKey(webhookSecret),
      },
    },
    scanReport,
  };
}

function resolveEventTarget(
  event: KernelEvent,
  ticketMeta: Map<string, { repoId: string; parentTicketId?: string }>,
): { repoId?: string; ticketId?: string } {
  switch (event.type) {
    case "repo_updated":
      return { repoId: event.repo.id };
    case "playbook_updated":
      return { repoId: event.repoId, ticketId: event.entry?.sourceTicketId };
    case "routine_updated":
    case "routine_run_updated":
      return { repoId: event.repoId };
    case "casebook_updated":
      return { repoId: event.repoId, ticketId: event.entry.ticketId };
    case "epic_replanned":
      return { repoId: event.repoId, ticketId: event.epicId };
    case "trigger_ingested":
      return { repoId: event.trigger.repoId };
    case "ticket_created":
    case "ticket_updated":
      return { repoId: event.ticket.repoId, ticketId: event.ticket.id };
    case "thread_routed":
    case "stage_started":
    case "worker_event":
    case "stage_completed":
    case "watchdog_decision":
    case "verification_completed":
      return { repoId: ticketMeta.get(event.ticketId)?.repoId, ticketId: event.ticketId };
    case "watchdog_signal":
      return {
        repoId: ticketMeta.get(event.signal.ticketId)?.repoId,
        ticketId: event.signal.ticketId,
      };
    case "inbox_created":
    case "inbox_resolved":
      return { repoId: event.item.repoId, ticketId: event.item.ticketId };
    case "outbox_queued":
    case "outbox_sent":
    case "outbox_failed":
      return { repoId: event.entry.repoId, ticketId: event.entry.ticketId };
    case "worktrees_gc":
      return {};
  }
}

export function createServerApp(deps: ServerAppDeps): Hono {
  const { kernel, stateStore, artifactStore, webDistDir } = deps;
  const scanner = deps.cliScanner ?? new CliEnvironmentScanner();
  const notificationDispatcher =
    deps.notificationDispatcher ?? new NotificationDispatcher(stateStore);
  const expectedToken = deps.authToken?.trim() || undefined;
  const getActiveProviderName = () =>
    deps.mutableLlm?.providerName ?? deps.llmProviderName ?? "heuristic:local";
  const app = new Hono();

  app.use("/api/*", cors());

  if (expectedToken) {
    app.use("/api/*", async (c, next) => {
      if (c.req.method === "OPTIONS") {
        return next();
      }
      const authHeader = c.req.header("authorization") ?? "";
      const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
      const queryToken = c.req.query("token")?.trim() ?? "";
      if (bearer !== expectedToken && queryToken !== expectedToken) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      return next();
    });
  }

  app.get("/api/health", async (c) => {
    const [repos, tickets, pendingInbox, pendingOutbox, availableEngines, worktrees, routines] =
      await Promise.all([
        stateStore.listRepos(),
        stateStore.listTickets(),
        stateStore.listInboxItems({ status: "pending" }),
        stateStore.listOutboxEntries({ status: "pending" }),
        kernel.getAvailableEngines(),
        kernel.inspectWorktrees(),
        stateStore.listRoutines(),
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
        activeRoutines: routines.filter((r) => r.enabled).length,
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
      notifications?: Partial<NotificationConfig> & { clearWebhookSecret?: boolean };
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

    const nextPreset: LlmProviderPreset = body.llmPreset ?? existing?.llmPreset ?? "heuristic";
    const existingNotifs: NotificationConfig = {
      ...DEFAULT_NOTIFICATION_CONFIG,
      ...(existing?.notifications ?? {}),
    };
    const nextNotifications: NotificationConfig = body.notifications
      ? {
          macosEnabled: body.notifications.macosEnabled ?? existingNotifs.macosEnabled,
          webhookEnabled: body.notifications.webhookEnabled ?? existingNotifs.webhookEnabled,
          webhookUrl:
            body.notifications.webhookUrl !== undefined
              ? body.notifications.webhookUrl.trim() || undefined
              : existingNotifs.webhookUrl,
          webhookSecret: body.notifications.clearWebhookSecret
            ? undefined
            : body.notifications.webhookSecret?.trim()
              ? body.notifications.webhookSecret.trim()
              : existingNotifs.webhookSecret,
          notifyOnInbox: body.notifications.notifyOnInbox ?? existingNotifs.notifyOnInbox,
          notifyOnDelivery: body.notifications.notifyOnDelivery ?? existingNotifs.notifyOnDelivery,
          notifyOnFailure: body.notifications.notifyOnFailure ?? existingNotifs.notifyOnFailure,
        }
      : existingNotifs;

    const nextConfig: SystemSetupConfig = {
      initialized: true,
      llmPreset: nextPreset,
      llmBaseUrl: body.llmBaseUrl?.trim() ?? existing?.llmBaseUrl ?? "",
      llmModel: normalizeSetupModel(nextPreset, body.llmModel ?? existing?.llmModel),
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
      notifications: nextNotifications,
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

  app.post("/api/notifications/test", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      notifications?: Partial<NotificationConfig>;
    };
    const results = await notificationDispatcher.sendTestNotification(body.notifications);
    const ok = results.length > 0 && results.every((r) => r.ok);
    return c.json({ ok, results });
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
      fallbackEngines: Array.isArray(body.fallbackEngines)
        ? body.fallbackEngines.filter((e): e is WorkerEngineId => Boolean(e))
        : undefined,
      autoCleanupWorktree: body.autoCleanupWorktree ?? true,
      verificationCommands: Array.isArray(body.verificationCommands)
        ? body.verificationCommands.map((s) => String(s).trim()).filter(Boolean)
        : [],
      setupCommands: Array.isArray(body.setupCommands)
        ? body.setupCommands.map((s) => String(s).trim()).filter(Boolean)
        : [],
      smokeCheck: normalizeSmokeCheckConfig(body.smokeCheck),
      forbiddenPaths: Array.isArray(body.forbiddenPaths)
        ? body.forbiddenPaths.map((s) => String(s).trim()).filter(Boolean)
        : [],
      conventions: body.conventions?.trim() || undefined,
      defaultDeliveryChannel: body.defaultDeliveryChannel ?? "auto_pr_or_branch",
      maxConcurrentWorkers:
        typeof body.maxConcurrentWorkers === "number" && body.maxConcurrentWorkers > 0
          ? Math.floor(body.maxConcurrentWorkers)
          : undefined,
      dailyBudgetUsd:
        typeof body.dailyBudgetUsd === "number" && body.dailyBudgetUsd > 0
          ? body.dailyBudgetUsd
          : undefined,
      createdAt: ts,
      updatedAt: ts,
    };
    await stateStore.upsertRepo(repo);
    const syncedRepo = (await kernel.syncRepoContract(repo.id).catch(() => repo)) ?? repo;
    return c.json({ repo: syncedRepo }, 201);
  });

  app.patch("/api/repos/:id", async (c) => {
    const id = c.req.param("id");
    const existing = await stateStore.getRepo(id);
    if (!existing) {
      return c.json({ error: "Repository not found" }, 404);
    }
    const patch = (await c.req.json()) as Omit<
      Partial<RepoConfig>,
      "maxConcurrentWorkers" | "dailyBudgetUsd" | "conventions" | "smokeCheck" | "fallbackEngines"
    > & {
      maxConcurrentWorkers?: number | null;
      dailyBudgetUsd?: number | null;
      conventions?: string | null;
      smokeCheck?: SmokeCheckConfig | null;
      fallbackEngines?: WorkerEngineId[] | null;
    };
    const updated: RepoConfig = {
      ...existing,
      ...patch,
      name: patch.name?.trim() || existing.name,
      baseBranch: patch.baseBranch?.trim() || existing.baseBranch,
      fallbackEngines:
        patch.fallbackEngines !== undefined
          ? patch.fallbackEngines === null
            ? undefined
            : patch.fallbackEngines.filter((e): e is WorkerEngineId => Boolean(e))
          : existing.fallbackEngines,
      githubRepo:
        patch.githubRepo !== undefined
          ? patch.githubRepo.trim() || undefined
          : existing.githubRepo,
      autoCleanupWorktree: patch.autoCleanupWorktree ?? existing.autoCleanupWorktree ?? true,
      verificationCommands:
        patch.verificationCommands !== undefined
          ? patch.verificationCommands.map((s) => String(s).trim()).filter(Boolean)
          : (existing.verificationCommands ?? []),
      setupCommands:
        patch.setupCommands !== undefined
          ? patch.setupCommands.map((s) => String(s).trim()).filter(Boolean)
          : (existing.setupCommands ?? []),
      smokeCheck:
        patch.smokeCheck !== undefined
          ? patch.smokeCheck === null
            ? undefined
            : normalizeSmokeCheckConfig(patch.smokeCheck)
          : existing.smokeCheck,
      forbiddenPaths:
        patch.forbiddenPaths !== undefined
          ? patch.forbiddenPaths.map((s) => String(s).trim()).filter(Boolean)
          : (existing.forbiddenPaths ?? []),
      conventions:
        patch.conventions !== undefined
          ? patch.conventions?.trim() || undefined
          : existing.conventions,
      defaultDeliveryChannel:
        (patch.defaultDeliveryChannel as DeliveryChannel | undefined) ??
        existing.defaultDeliveryChannel ??
        "auto_pr_or_branch",
      maxConcurrentWorkers:
        patch.maxConcurrentWorkers !== undefined
          ? typeof patch.maxConcurrentWorkers === "number" && patch.maxConcurrentWorkers > 0
            ? Math.floor(patch.maxConcurrentWorkers)
            : undefined
          : existing.maxConcurrentWorkers,
      dailyBudgetUsd:
        patch.dailyBudgetUsd !== undefined
          ? typeof patch.dailyBudgetUsd === "number" && patch.dailyBudgetUsd > 0
            ? patch.dailyBudgetUsd
            : undefined
          : existing.dailyBudgetUsd,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: nowIso(),
    };
    await stateStore.upsertRepo(updated);
    return c.json({ repo: updated });
  });

  // --- Repo Contract (super-work.json) & Playbook ---
  app.post("/api/repos/:id/contract/sync", async (c) => {
    const id = c.req.param("id");
    const existing = await stateStore.getRepo(id);
    if (!existing) {
      return c.json({ error: "Repository not found" }, 404);
    }
    try {
      const repo = (await kernel.syncRepoContract(id, true)) ?? existing;
      return c.json({ repo });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/repos/:id/contract/export", async (c) => {
    const id = c.req.param("id");
    try {
      const result = await kernel.exportRepoContract(id);
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.includes("Repository not found") ? 404 : 400);
    }
  });

  app.get("/api/repos/:id/playbook", async (c) => {
    const id = c.req.param("id");
    const repo = await stateStore.getRepo(id);
    if (!repo) {
      return c.json({ error: "Repository not found" }, 404);
    }
    const entries = await stateStore.listPlaybookEntries(id);
    const pathExists = (rel: string): boolean => existsSync(join(repo.rootPath, rel));
    const enriched = entries.map((entry) => {
      const health = classifyPlaybookHealth(entry, { pathExists });
      return {
        ...entry,
        healthStatus: health.status,
        prunable: health.prunable,
      };
    });
    return c.json({ entries: enriched });
  });

  app.post("/api/repos/:id/playbook/prune", async (c) => {
    const id = c.req.param("id");
    try {
      const result = await kernel.prunePlaybookEntries(id);
      const repo = await stateStore.getRepo(id);
      const pathExists = repo
        ? (rel: string): boolean => existsSync(join(repo.rootPath, rel))
        : undefined;
      const entries = (await stateStore.listPlaybookEntries(id)).map((entry) => {
        const health = classifyPlaybookHealth(entry, { pathExists });
        return {
          ...entry,
          healthStatus: health.status,
          prunable: health.prunable,
        };
      });
      return c.json({ ...result, entries });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.includes("Repository not found") ? 404 : 400);
    }
  });

  app.get("/api/repos/:id/casebook", async (c) => {
    const id = c.req.param("id");
    const repo = await stateStore.getRepo(id);
    if (!repo) {
      return c.json({ error: "Repository not found" }, 404);
    }
    const q = (c.req.query("q") ?? "").trim().toLowerCase();
    const allEntries = await stateStore.listCasebookEntries(id, { includeReverted: true });
    const entries = q
      ? allEntries.filter((e) =>
          [
            e.title,
            e.goalSummary,
            e.solutionSummary,
            e.pitfallsAndFixes ?? "",
            ...e.exportedSymbols,
            ...e.changedFiles,
            ...e.scopePaths,
          ]
            .join(" ")
            .toLowerCase()
            .includes(q),
        )
      : allEntries;
    return c.json({ entries });
  });

  app.delete("/api/casebook/:entryId", async (c) => {
    const entryId = c.req.param("entryId");
    const deleted = await stateStore.deleteCasebookEntry(entryId);
    if (!deleted) {
      return c.json({ error: "Casebook entry not found" }, 404);
    }
    return c.json({ ok: true, id: entryId });
  });

  app.post("/api/repos/:id/playbook", async (c) => {
    const id = c.req.param("id");
    const repo = await stateStore.getRepo(id);
    if (!repo) {
      return c.json({ error: "Repository not found" }, 404);
    }
    const body = (await c.req.json()) as {
      rule?: string;
      scopePaths?: string[];
      pinned?: boolean;
      enabled?: boolean;
    };
    if (!body.rule?.trim()) {
      return c.json({ error: "rule is required" }, 400);
    }
    const entry = await kernel.addOrUpdatePlaybookRule({
      repoId: id,
      rule: body.rule.trim(),
      scopePaths: Array.isArray(body.scopePaths) ? body.scopePaths : undefined,
      source: "human",
      pinned: body.pinned,
      enabled: body.enabled,
    });
    if (!entry) {
      return c.json({ error: "Invalid rule text" }, 400);
    }
    return c.json({ entry }, 201);
  });

  app.patch("/api/playbook/:entryId", async (c) => {
    const entryId = c.req.param("entryId");
    const existing = await stateStore.getPlaybookEntry(entryId);
    if (!existing) {
      return c.json({ error: "Playbook entry not found" }, 404);
    }
    const patch = (await c.req.json()) as {
      rule?: string;
      scopePaths?: string[];
      pinned?: boolean;
      enabled?: boolean;
    };
    const nextRule = patch.rule !== undefined ? normalizePlaybookRuleText(patch.rule) : existing.rule;
    if (!nextRule) {
      return c.json({ error: "rule cannot be empty" }, 400);
    }
    const updated: PlaybookEntry = {
      ...existing,
      rule: nextRule,
      scopePaths:
        patch.scopePaths !== undefined
          ? patch.scopePaths.map((s) => String(s).trim()).filter(Boolean)
          : existing.scopePaths,
      pinned: patch.pinned !== undefined ? Boolean(patch.pinned) : existing.pinned,
      enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : existing.enabled,
      updatedAt: nowIso(),
    };
    await stateStore.savePlaybookEntry(updated);
    return c.json({ entry: updated });
  });

  app.delete("/api/playbook/:entryId", async (c) => {
    const entryId = c.req.param("entryId");
    const deleted = await stateStore.deletePlaybookEntry(entryId);
    if (!deleted) {
      return c.json({ error: "Playbook entry not found" }, 404);
    }
    return c.json({ ok: true, id: entryId });
  });

  // --- Scheduled Routines (A.1) ---
  app.get("/api/routines", async (c) => {
    const repoId = c.req.query("repoId") || undefined;
    const routines = await stateStore.listRoutines(repoId);
    return c.json({ routines, presets: ROUTINE_PRESET_TEMPLATES });
  });

  app.get("/api/routines/runs", async (c) => {
    const repoId = c.req.query("repoId") || undefined;
    const routineId = c.req.query("routineId") || undefined;
    const limitRaw = Number(c.req.query("limit") ?? 50);
    const runs = await stateStore.listRoutineRuns({
      repoId,
      routineId,
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(200, Math.floor(limitRaw)) : 50,
    });
    return c.json({ runs });
  });

  app.post("/api/routines", async (c) => {
    const body = (await c.req.json()) as {
      repoId?: string;
      name?: string;
      prompt?: string;
      scheduleKind?: RoutineScheduleKind;
      intervalMinutes?: number;
      cronExpr?: string;
      activeHoursStart?: string;
      activeHoursEnd?: string;
      allowedPaths?: string[];
      template?: PipelineTemplateId;
      preferredEngine?: WorkerEngineId;
      maxBudgetUsd?: number;
      enabled?: boolean;
      nextRunAt?: string;
    };
    if (!body.repoId || !body.name || !body.prompt) {
      return c.json({ error: "repoId, name, and prompt are required" }, 400);
    }
    try {
      const routine = await kernel.createRoutine({
        repoId: body.repoId,
        name: body.name,
        prompt: body.prompt,
        scheduleKind: body.scheduleKind ?? "interval",
        intervalMinutes: body.intervalMinutes,
        cronExpr: body.cronExpr,
        activeHoursStart: body.activeHoursStart,
        activeHoursEnd: body.activeHoursEnd,
        allowedPaths: body.allowedPaths,
        template: body.template,
        preferredEngine: body.preferredEngine,
        maxBudgetUsd: body.maxBudgetUsd,
        enabled: body.enabled,
        nextRunAt: body.nextRunAt,
      });
      return c.json({ routine }, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.includes("Repository not found") ? 404 : 400);
    }
  });

  app.patch("/api/routines/:id", async (c) => {
    const id = c.req.param("id");
    const patch = (await c.req.json()) as Partial<
      Omit<RoutineSpec, "id" | "repoId" | "createdAt" | "updatedAt">
    >;
    try {
      const routine = await kernel.updateRoutine(id, patch);
      return c.json({ routine });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.includes("not found") ? 404 : 400);
    }
  });

  app.delete("/api/routines/:id", async (c) => {
    const id = c.req.param("id");
    const deleted = await kernel.deleteRoutine(id);
    if (!deleted) {
      return c.json({ error: "Routine not found" }, 404);
    }
    return c.json({ ok: true, id });
  });

  app.post("/api/routines/:id/run", async (c) => {
    const id = c.req.param("id");
    try {
      const run = await kernel.triggerRoutineNow(id);
      void kernel.tick();
      return c.json({ run });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.includes("not found") ? 404 : 400);
    }
  });

  // --- Metrics & Quota ---
  app.get("/api/metrics", async (c) => {
    const repoId = c.req.query("repoId") || undefined;
    const metrics = await stateStore.getMetricsSummary(repoId);
    return c.json({ metrics });
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
      dependsOn?: string[];
      maxCostUsd?: number;
      preferredEngine?: RepoConfig["preferredImplementEngine"];
      arenaMode?: boolean;
      arenaCompetitorEngine?: RepoConfig["preferredImplementEngine"];
      modelOverride?: string;
      effortOverride?: ReasoningEffort;
      acceptanceCriteria?: string[];
    };

    if (!body.repoId || !body.title || !body.description) {
      return c.json({ error: "repoId, title, and description are required" }, 400);
    }

    try {
      const ticket = await kernel.createDirectTicket({
        repoId: body.repoId,
        title: body.title,
        description: body.description,
        template: body.template,
        allowedPaths: body.allowedPaths,
        forbiddenPaths: body.forbiddenPaths,
        dependsOn: Array.isArray(body.dependsOn)
          ? body.dependsOn.map((d) => String(d).trim()).filter(Boolean)
          : undefined,
        maxCostUsd: body.maxCostUsd,
        preferredEngine: body.preferredEngine,
        arenaMode: Boolean(body.arenaMode),
        arenaCompetitorEngine: body.arenaCompetitorEngine,
        modelOverride: body.modelOverride,
        effortOverride: body.effortOverride,
        acceptanceCriteria: body.acceptanceCriteria,
      });

      void kernel.tick();
      return c.json({ ticket }, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 400);
    }
  });

  app.get("/api/tickets/:id", async (c) => {
    const id = c.req.param("id");
    const ticket = await stateStore.getTicket(id);
    if (!ticket) {
      return c.json({ error: "Ticket not found" }, 404);
    }
    const [repo, allRepos, stageRuns, artifacts, inboxItems, outboxEntries] = await Promise.all([
      stateStore.getRepo(ticket.repoId),
      stateStore.listRepos(),
      stateStore.listStageRuns(ticket.id),
      stateStore.listArtifacts(ticket.id),
      stateStore.listInboxItems({ ticketId: ticket.id }),
      stateStore.listOutboxEntries({ ticketId: ticket.id }),
    ]);

    const reposById = new Map(allRepos.map((r) => [r.id, r]));
    const upstreamDependencies: Array<{
      id: string;
      repoId: string;
      repoName?: string;
      title: string;
      status: TicketStatus;
      handoverDigest?: HandoverDigest;
    }> = [];
    for (const depId of ticket.dependsOn) {
      const dep = await stateStore.getTicket(depId);
      if (dep) {
        upstreamDependencies.push({
          id: dep.id,
          repoId: dep.repoId,
          repoName: reposById.get(dep.repoId)?.name,
          title: dep.title,
          status: dep.status,
          handoverDigest: dep.handoverDigest,
        });
      }
    }

    let subtasks: Ticket[] | undefined;
    if (ticket.isEpic) {
      const allTickets = await stateStore.listTickets();
      subtasks = allTickets.filter((t) => t.parentTicketId === ticket.id);
    }

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
    if (!diff.trim()) {
      const latestDiffArtifact = [...artifacts].reverse().find((a) => a.kind === "diff");
      if (latestDiffArtifact) {
        try {
          diff = await artifactStore.readSpill(latestDiffArtifact.storageUri);
        } catch {
          diff = "";
        }
      }
    }

    let arenaCandidateDiffs: Record<string, string> | undefined;
    if (ticket.arenaCandidates && ticket.arenaCandidates.length > 0) {
      arenaCandidateDiffs = {};
      let effectiveBase = repo?.baseBranch ?? "main";
      if (ticket.parentTicketId) {
        const parentEpic = await stateStore.getTicket(ticket.parentTicketId);
        if (parentEpic?.branchName && parentEpic.epicDeliveryMode !== "per_subtask") {
          effectiveBase = parentEpic.branchName;
        }
      }
      for (const cand of ticket.arenaCandidates) {
        let candDiff = "";
        if (cand.worktreePath && existsSync(cand.worktreePath)) {
          candDiff = await kernel.workspace
            .getDiff(cand.worktreePath, effectiveBase)
            .catch(() => "");
        }
        if (!candDiff.trim() && cand.diffArtifactId) {
          const art = await stateStore.getArtifact(cand.diffArtifactId);
          if (art) {
            candDiff = await artifactStore.readSpill(art.storageUri).catch(() => "");
          }
        }
        arenaCandidateDiffs[cand.candidateId] = candDiff;
      }
    }

    return c.json({
      ticket,
      stageRuns,
      artifacts,
      inboxItems,
      outboxEntries,
      diff,
      ...(subtasks ? { subtasks } : {}),
      ...(upstreamDependencies.length > 0 ? { upstreamDependencies } : {}),
      ...(arenaCandidateDiffs ? { arenaCandidateDiffs } : {}),
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

  app.post("/api/tickets/:id/deliver", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as {
      action?: "local_merge" | "push_and_create_pr";
    };
    const action =
      body.action === "push_and_create_pr" ? "push_and_create_pr" : "local_merge";
    try {
      const result = await kernel.triggerTicketDelivery(id, action);
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/tickets/:id/revert", async (c) => {
    const id = c.req.param("id");
    try {
      const result = await kernel.revertTicketDelivery(id);
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = msg.includes("not found")
        ? 404
        : msg.includes("conflicted")
          ? 409
          : 400;
      return c.json({ error: msg }, status);
    }
  });

  // --- Epic DAG Planning & Dispatch ---
  app.post("/api/epics/preview", async (c) => {
    const body = (await c.req.json()) as {
      repoId?: string;
      title?: string;
      description?: string;
      template?: PipelineTemplateId;
    };
    if (!body.repoId || !body.title || !body.description) {
      return c.json({ error: "repoId, title, and description are required" }, 400);
    }
    try {
      const plan = await kernel.previewEpic({
        repoId: body.repoId,
        title: body.title,
        description: body.description,
        template: body.template,
      });
      return c.json({ plan });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.includes("Repository not found") ? 404 : 500);
    }
  });

  app.post("/api/epics", async (c) => {
    const body = (await c.req.json()) as Partial<CreateEpicInput>;
    if (!body.repoId || !body.title || !body.description) {
      return c.json({ error: "repoId, title, and description are required" }, 400);
    }
    try {
      const result = await kernel.createEpic({
        repoId: body.repoId,
        title: body.title,
        description: body.description,
        template: body.template,
        epicDeliveryMode: body.epicDeliveryMode as EpicDeliveryMode | undefined,
        preferredEngine: body.preferredEngine,
        modelOverride: body.modelOverride,
        effortOverride: body.effortOverride,
        maxCostUsdPerSubtask: body.maxCostUsdPerSubtask,
        subtasks: body.subtasks,
      });
      void kernel.tick();
      return c.json(result, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.includes("Repository not found") ? 404 : 500);
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
      deliveryAction?: "local_merge" | "push_and_create_pr";
      expandMandate?: boolean;
      budgetIncreaseUsd?: number;
      saveToPlaybook?: boolean;
      arenaWinnerId?: string;
    };
    if (body.decision !== "approved" && body.decision !== "rejected") {
      return c.json({ error: "decision must be 'approved' or 'rejected'" }, 400);
    }
    const result = await kernel.resolveInboxItem(id, body.decision, body.note, {
      deliveryAction: body.deliveryAction,
      expandMandate: body.expandMandate,
      budgetIncreaseUsd: body.budgetIncreaseUsd,
      saveToPlaybook: body.saveToPlaybook,
      arenaWinnerId: body.arenaWinnerId,
    });
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
  app.get("/api/events", async (c) => {
    const filterRepoId = c.req.query("repoId") || undefined;
    const filterTicketId = c.req.query("ticketId") || undefined;

    const existingTickets = await stateStore.listTickets();
    const ticketMeta = new Map<string, { repoId: string; parentTicketId?: string }>();
    for (const t of existingTickets) {
      ticketMeta.set(t.id, { repoId: t.repoId, parentTicketId: t.parentTicketId });
    }

    return streamSSE(c, async (stream) => {
      let closed = false;
      let resolveClosed!: () => void;
      const donePromise = new Promise<void>((res) => {
        resolveClosed = res;
      });

      const unsubscribe = kernel.subscribe((event) => {
        if (closed) return;
        if (event.type === "ticket_created" || event.type === "ticket_updated") {
          ticketMeta.set(event.ticket.id, {
            repoId: event.ticket.repoId,
            parentTicketId: event.ticket.parentTicketId,
          });
        }

        if (filterRepoId || filterTicketId) {
          const target = resolveEventTarget(event, ticketMeta);
          if (filterRepoId && target.repoId !== filterRepoId) {
            const parentId = target.ticketId
              ? ticketMeta.get(target.ticketId)?.parentTicketId
              : undefined;
            const parentRepoId = parentId ? ticketMeta.get(parentId)?.repoId : undefined;
            if (parentRepoId !== filterRepoId) {
              return;
            }
          }
          if (filterTicketId) {
            const evTktId = target.ticketId;
            const matchesSelf = evTktId === filterTicketId;
            const matchesChild = Boolean(
              evTktId && ticketMeta.get(evTktId)?.parentTicketId === filterTicketId,
            );
            if (!matchesSelf && !matchesChild) {
              return;
            }
          }
        }

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
