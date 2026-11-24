import { existsSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import {
  ROUTINE_PRESET_TEMPLATES,
  classifyPlaybookHealth,
  handleMcpJsonRpcMessage,
  newId,
  normalizePlaybookRuleText,
  normalizeSmokeCheckConfig,
  nowIso,
  parseGithubWebhookEvent,
  verifyActionToken,
  verifyWebhookHmacSha256,
} from "@super-work/core";
import type {
  ArtifactStore,
  CliScanReport,
  CreateEpicInput,
  DagNodeMutationInput,
  DeliveryChannel,
  DeliveryGatePolicy,
  EngineModelProfile,
  EnginePreference,
  EpicDeliveryMode,
  HandoverDigest,
  InboxItemStatus,
  KernelEvent,
  LlmProviderPreset,
  McpToolHost,
  NotificationConfig,
  OutboxStatus,
  PipelineTemplateId,
  PlaybookEntry,
  PublicSetupStatus,
  ReasoningEffort,
  RepoConfig,
  RestoreCheckpointInput,
  ReviewCommentStatus,
  RoutineScheduleKind,
  RoutineSpec,
  SandboxMode,
  SmokeCheckConfig,
  StageKind,
  StateStore,
  SubmitReviewCommentsInput,
  SuperWorkKernel,
  SystemSetupConfig,
  TaskBlueprint,
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
  const { webhookSecret, actionSecret, githubWebhookSecret, ...notifRest } = mergedNotifs;
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
        hasActionSecret: Boolean(actionSecret?.trim()),
        maskedActionSecret: maskApiKey(actionSecret),
        hasGithubWebhookSecret: Boolean(githubWebhookSecret?.trim()),
        maskedGithubWebhookSecret: maskApiKey(githubWebhookSecret),
      },
    },
    scanReport,
  };
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
    case "preview_updated":
      return { repoId: event.preview.repoId, ticketId: event.preview.ticketId };
    case "checkpoint_created":
      return { repoId: event.checkpoint.repoId, ticketId: event.checkpoint.ticketId };
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
    case "review_comment_updated":
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
      if (c.req.method === "OPTIONS" || c.req.path.startsWith("/api/webhooks/")) {
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
    const [repos, tickets, pendingInbox, pendingOutbox, availableEngines, worktrees, routines, previews] =
      await Promise.all([
        stateStore.listRepos(),
        stateStore.listTickets(),
        stateStore.listInboxItems({ status: "pending" }),
        stateStore.listOutboxEntries({ status: "pending" }),
        kernel.getAvailableEngines(),
        kernel.inspectWorktrees(),
        stateStore.listRoutines(),
        kernel.listPreviews(),
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
        activePreviews: previews.length,
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
      notifications?: Partial<NotificationConfig> & {
        clearWebhookSecret?: boolean;
        clearActionSecret?: boolean;
        generateActionSecret?: boolean;
        clearGithubWebhookSecret?: boolean;
      };
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
    const nextActionSecret = body.notifications?.generateActionSecret
      ? `${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`
      : body.notifications?.clearActionSecret
        ? undefined
        : body.notifications?.actionSecret?.trim()
          ? body.notifications.actionSecret.trim()
          : existingNotifs.actionSecret;
    const rawTtl =
      body.notifications?.actionTtlMinutes !== undefined
        ? Number(body.notifications.actionTtlMinutes)
        : existingNotifs.actionTtlMinutes;
    const nextTtl =
      typeof rawTtl === "number" && Number.isFinite(rawTtl) && rawTtl >= 5
        ? Math.min(24 * 60, Math.floor(rawTtl))
        : existingNotifs.actionTtlMinutes;

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
          publicBaseUrl:
            body.notifications.publicBaseUrl !== undefined
              ? body.notifications.publicBaseUrl.trim().replace(/\/+$/, "") || undefined
              : existingNotifs.publicBaseUrl,
          actionSecret: nextActionSecret,
          githubWebhookSecret: body.notifications.clearGithubWebhookSecret
            ? undefined
            : body.notifications.githubWebhookSecret?.trim()
              ? body.notifications.githubWebhookSecret.trim()
              : existingNotifs.githubWebhookSecret,
          actionTtlMinutes: nextTtl,
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
      defaultTddMode: Boolean(body.defaultTddMode),
      deliveryGatePolicy:
        body.deliveryGatePolicy === "always_auto" ||
        body.deliveryGatePolicy === "risk_gated" ||
        body.deliveryGatePolicy === "always_signoff"
          ? body.deliveryGatePolicy
          : undefined,
      riskThreshold:
        typeof body.riskThreshold === "number" && Number.isFinite(body.riskThreshold)
          ? Math.max(0, Math.min(100, Math.round(body.riskThreshold)))
          : undefined,
      sensitivePaths: Array.isArray(body.sensitivePaths)
        ? body.sensitivePaths.map((s) => String(s).trim()).filter(Boolean)
        : undefined,
      blueprints: Array.isArray(body.blueprints)
        ? body.blueprints.filter(
            (b): b is TaskBlueprint => Boolean(b && typeof b.id === "string" && b.id.trim()),
          )
        : undefined,
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
      previewCommand: body.previewCommand?.trim() || undefined,
      sandboxMode:
        body.sandboxMode === "off" || body.sandboxMode === "balanced" || body.sandboxMode === "strict"
          ? body.sandboxMode
          : undefined,
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
    > & {
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
      defaultTddMode:
        patch.defaultTddMode !== undefined
          ? Boolean(patch.defaultTddMode)
          : existing.defaultTddMode,
      deliveryGatePolicy:
        patch.deliveryGatePolicy !== undefined
          ? patch.deliveryGatePolicy === "always_auto" ||
            patch.deliveryGatePolicy === "risk_gated" ||
            patch.deliveryGatePolicy === "always_signoff"
            ? patch.deliveryGatePolicy
            : undefined
          : existing.deliveryGatePolicy,
      riskThreshold:
        patch.riskThreshold !== undefined
          ? typeof patch.riskThreshold === "number" && Number.isFinite(patch.riskThreshold)
            ? Math.max(0, Math.min(100, Math.round(patch.riskThreshold)))
            : undefined
          : existing.riskThreshold,
      sensitivePaths:
        patch.sensitivePaths !== undefined
          ? patch.sensitivePaths === null
            ? undefined
            : patch.sensitivePaths.map((s) => String(s).trim()).filter(Boolean)
          : existing.sensitivePaths,
      blueprints:
        patch.blueprints !== undefined
          ? patch.blueprints === null
            ? undefined
            : patch.blueprints.filter(
                (b): b is TaskBlueprint => Boolean(b && typeof b.id === "string" && b.id.trim()),
              )
          : existing.blueprints,
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
      previewCommand:
        patch.previewCommand !== undefined
          ? patch.previewCommand?.trim() || undefined
          : existing.previewCommand,
      sandboxMode:
        patch.sandboxMode !== undefined
          ? patch.sandboxMode === "off" ||
            patch.sandboxMode === "balanced" ||
            patch.sandboxMode === "strict"
            ? patch.sandboxMode
            : undefined
          : existing.sandboxMode,
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

  app.get("/api/repos/:id/blueprints", async (c) => {
    const id = c.req.param("id");
    try {
      const blueprints = await kernel.listRepoBlueprints(id);
      return c.json({ blueprints });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.includes("not found") ? 404 : 400);
    }
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

  app.post("/api/repos/:id/impact", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { paths?: string[] };
    const paths = Array.isArray(body.paths)
      ? body.paths.map((p) => String(p).trim()).filter(Boolean)
      : ["**"];
    try {
      const report = await kernel.analyzeRepoImpact(id, paths);
      return c.json({ report });
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
      blueprintId?: string;
      deliveryGatePolicy?: DeliveryGatePolicy;
      riskThreshold?: number;
      template?: RepoConfig["defaultTemplate"];
      tddMode?: boolean;
      pauseBeforeRun?: boolean;
      allowedPaths?: string[];
      forbiddenPaths?: string[];
      dependsOn?: string[];
      maxCostUsd?: number;
      preferredEngine?: EnginePreference;
      arenaMode?: boolean;
      arenaCompetitorEngine?: WorkerEngineId;
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
        blueprintId: body.blueprintId,
        deliveryGatePolicy: body.deliveryGatePolicy,
        riskThreshold: body.riskThreshold,
        template: body.template,
        tddMode: body.tddMode,
        pauseBeforeRun: body.pauseBeforeRun,
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

  const buildTicketDetail = async (id: string) => {
    const ticket = await stateStore.getTicket(id);
    if (!ticket) {
      return null;
    }
    const [
      repo,
      allRepos,
      stageRuns,
      artifacts,
      inboxItems,
      outboxEntries,
      allPreviews,
      checkpoints,
      reviewComments,
    ] = await Promise.all([
      stateStore.getRepo(ticket.repoId),
      stateStore.listRepos(),
      stateStore.listStageRuns(ticket.id),
      stateStore.listArtifacts(ticket.id),
      stateStore.listInboxItems({ ticketId: ticket.id }),
      stateStore.listOutboxEntries({ ticketId: ticket.id }),
      kernel.listPreviews(ticket.repoId),
      kernel.listTicketCheckpoints(ticket.id),
      kernel.listTicketReviewComments(ticket.id),
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

    const previews = allPreviews.filter((p) => p.ticketId === ticket.id);

    return {
      ticket,
      stageRuns,
      artifacts,
      inboxItems,
      outboxEntries,
      diff,
      previews,
      checkpoints,
      reviewComments,
      ...(subtasks ? { subtasks } : {}),
      ...(upstreamDependencies.length > 0 ? { upstreamDependencies } : {}),
      ...(arenaCandidateDiffs ? { arenaCandidateDiffs } : {}),
    };
  };

  app.get("/api/tickets/:id", async (c) => {
    const detail = await buildTicketDetail(c.req.param("id"));
    if (!detail) {
      return c.json({ error: "Ticket not found" }, 404);
    }
    return c.json(detail);
  });

  app.get("/api/tickets/:id/checkpoints", async (c) => {
    const id = c.req.param("id");
    const ticket = await stateStore.getTicket(id);
    if (!ticket) {
      return c.json({ error: "Ticket not found" }, 404);
    }
    const checkpoints = await kernel.listTicketCheckpoints(id);
    return c.json({ checkpoints });
  });

  app.get("/api/tickets/:id/checkpoints/:cpId/diff", async (c) => {
    const id = c.req.param("id");
    const cpId = c.req.param("cpId");
    const base = c.req.query("base") || undefined;
    try {
      const result = await kernel.getTicketCheckpointDiff(id, cpId, base);
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.includes("not found") ? 404 : 400);
    }
  });

  app.post("/api/tickets/:id/checkpoints/:cpId/restore", async (c) => {
    const id = c.req.param("id");
    const cpId = c.req.param("cpId");
    const body = (await c.req.json().catch(() => ({}))) as RestoreCheckpointInput;
    try {
      const result = await kernel.restoreTicketCheckpoint(id, cpId, body);
      void kernel.tick();
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.includes("not found") ? 404 : 400);
    }
  });

  app.patch("/api/tickets/:id/dag-node", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as DagNodeMutationInput;
    try {
      const ticket = await kernel.mutateDagNode(id, body);
      void kernel.tick();
      return c.json({ ticket });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.includes("not found") ? 404 : 400);
    }
  });

  // --- v1.0.0 Line-Anchored Review Studio ---
  app.get("/api/tickets/:id/review-comments", async (c) => {
    const id = c.req.param("id");
    const ticket = await stateStore.getTicket(id);
    if (!ticket) {
      return c.json({ error: "Ticket not found" }, 404);
    }
    const comments = await kernel.listTicketReviewComments(id);
    return c.json({ comments });
  });

  app.post("/api/tickets/:id/review-comments", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as Partial<SubmitReviewCommentsInput>;
    try {
      const result = await kernel.submitTicketReviewComments(id, {
        mode: body.mode === "request_changes" ? "request_changes" : "comment_only",
        summaryNote: typeof body.summaryNote === "string" ? body.summaryNote : undefined,
        comments: Array.isArray(body.comments) ? body.comments : [],
        statusUpdates: Array.isArray(body.statusUpdates) ? body.statusUpdates : undefined,
      });
      if (body.mode === "request_changes") {
        void kernel.tick();
      }
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.includes("not found") ? 404 : 400);
    }
  });

  app.patch("/api/review-comments/:commentId", async (c) => {
    const commentId = c.req.param("commentId");
    const body = (await c.req.json().catch(() => ({}))) as { status?: ReviewCommentStatus };
    if (body.status !== "open" && body.status !== "resolved" && body.status !== "dismissed") {
      return c.json({ error: "status must be 'open', 'resolved', or 'dismissed'" }, 400);
    }
    const comment = await kernel.updateReviewCommentStatus(commentId, body.status);
    if (!comment) {
      return c.json({ error: "Review comment not found" }, 404);
    }
    return c.json({ comment });
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
        tddMode: body.tddMode,
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
    if (
      artifact.kind === "screenshot" ||
      artifact.kind === "visual_diff" ||
      artifact.storageUri.endsWith(".png")
    ) {
      return c.json({
        artifact,
        content: `[binary ${artifact.kind} artifact: ${artifact.byteSize} bytes — view via /api/artifacts/${artifact.id}/raw]`,
      });
    }
    const content = await artifactStore.readSpill(artifact.storageUri);
    return c.json({ artifact, content });
  });

  app.get("/api/artifacts/:id/raw", async (c) => {
    const id = c.req.param("id");
    const artifact = await stateStore.getArtifact(id);
    if (!artifact) {
      return c.json({ error: "Artifact not found" }, 404);
    }
    const isPng =
      artifact.kind === "screenshot" ||
      artifact.kind === "visual_diff" ||
      artifact.storageUri.toLowerCase().endsWith(".png");
    if (artifactStore.readBinarySpill) {
      const bytes = await artifactStore.readBinarySpill(artifact.storageUri);
      return new Response(new Uint8Array(bytes), {
        headers: {
          "Content-Type": isPng ? "image/png" : "text/plain; charset=utf-8",
          "Cache-Control": "private, max-age=3600",
        },
      });
    }
    const text = await artifactStore.readSpill(artifact.storageUri);
    return c.text(text);
  });

  // --- D.1 Pre-Flight Spec Studio ---
  app.post("/api/specs/clarify", async (c) => {
    const body = (await c.req.json()) as {
      repoId?: string;
      title?: string;
      description?: string;
      template?: PipelineTemplateId;
      answers?: Record<string, string>;
    };
    if (!body.repoId || !body.title?.trim() || !body.description?.trim()) {
      return c.json({ error: "repoId, title, and description are required" }, 400);
    }
    try {
      const clarification = await kernel.clarifySpec({
        repoId: body.repoId,
        title: body.title.trim(),
        description: body.description.trim(),
        template: body.template,
        answers: body.answers,
      });
      return c.json({ clarification });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.includes("Repository not found") ? 404 : 400);
    }
  });

  // --- B.2 Live Worktree Preview Manager ---
  app.get("/api/previews", async (c) => {
    const repoId = c.req.query("repoId") || undefined;
    const ticketId = c.req.query("ticketId") || undefined;
    const all = await kernel.listPreviews(repoId);
    const previews = ticketId ? all.filter((p) => p.ticketId === ticketId) : all;
    return c.json({ previews });
  });

  app.post("/api/previews", async (c) => {
    const body = (await c.req.json()) as {
      ticketId?: string;
      candidateId?: string;
      ttlMinutes?: number;
    };
    if (!body.ticketId) {
      return c.json({ error: "ticketId is required" }, 400);
    }
    try {
      const preview = await kernel.startTicketPreview(
        body.ticketId,
        body.candidateId,
        body.ttlMinutes,
      );
      return c.json({ preview }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/previews/:id/renew", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ttlMinutes?: number };
    const preview = await kernel.renewPreview(c.req.param("id"), body.ttlMinutes);
    if (!preview) {
      return c.json({ error: "Active preview not found" }, 404);
    }
    return c.json({ preview });
  });

  app.delete("/api/previews/:id", async (c) => {
    const preview = await kernel.stopPreview(c.req.param("id"));
    if (!preview) {
      return c.json({ error: "Preview not found" }, 404);
    }
    return c.json({ preview });
  });

  // --- A.1 Native MCP JSON-RPC 2.0 Streamable HTTP Endpoint ---
  const buildMcpHost = (): McpToolHost => ({
    getHealth: async () => {
      const [repos, tickets, pendingInbox, pendingOutbox, availableEngines, previews] =
        await Promise.all([
          stateStore.listRepos(),
          stateStore.listTickets(),
          stateStore.listInboxItems({ status: "pending" }),
          stateStore.listOutboxEntries({ status: "pending" }),
          kernel.getAvailableEngines(),
          kernel.listPreviews(),
        ]);
      return {
        ok: true,
        llmProvider: getActiveProviderName(),
        availableEngines,
        counts: {
          repos: repos.length,
          tickets: tickets.length,
          pendingInbox: pendingInbox.length,
          pendingOutbox: pendingOutbox.length,
          activePreviews: previews.length,
        },
      };
    },
    listRepos: () => stateStore.listRepos(),
    clarifySpec: (args) =>
      kernel.clarifySpec({
        repoId: String(args.repoId ?? ""),
        title: String(args.title ?? ""),
        description: String(args.description ?? ""),
        template: args.template as PipelineTemplateId | undefined,
        answers: (args.answers as Record<string, string> | undefined) ?? undefined,
      }),
    dispatchTicket: async (args) => {
      const ticket = await kernel.createDirectTicket({
        repoId: String(args.repoId ?? ""),
        title: String(args.title ?? ""),
        description: String(args.description ?? ""),
        blueprintId: args.blueprintId ? String(args.blueprintId) : undefined,
        deliveryGatePolicy:
          args.deliveryGatePolicy === "always_auto" ||
          args.deliveryGatePolicy === "risk_gated" ||
          args.deliveryGatePolicy === "always_signoff"
            ? args.deliveryGatePolicy
            : undefined,
        riskThreshold:
          typeof args.riskThreshold === "number" ? args.riskThreshold : undefined,
        template: args.template as PipelineTemplateId | undefined,
        tddMode: args.tddMode !== undefined ? Boolean(args.tddMode) : undefined,
        pauseBeforeRun: args.pauseBeforeRun !== undefined ? Boolean(args.pauseBeforeRun) : undefined,
        allowedPaths: Array.isArray(args.allowedPaths)
          ? args.allowedPaths.map(String)
          : undefined,
        dependsOn: Array.isArray(args.dependsOn) ? args.dependsOn.map(String) : undefined,
        preferredEngine: args.preferredEngine as EnginePreference | undefined,
        arenaMode: Boolean(args.arenaMode),
        arenaCompetitorEngine: args.arenaCompetitorEngine as WorkerEngineId | undefined,
        acceptanceCriteria: Array.isArray(args.acceptanceCriteria)
          ? args.acceptanceCriteria.map(String)
          : undefined,
      });
      void kernel.tick();
      return { ticket };
    },
    dispatchEpic: async (args) => {
      const repoId = String(args.repoId ?? "");
      const title = String(args.title ?? "");
      const description = String(args.description ?? "");
      const template = args.template as PipelineTemplateId | undefined;
      if (args.previewOnly) {
        return { plan: await kernel.previewEpic({ repoId, title, description, template }) };
      }
      const res = await kernel.createEpic({
        repoId,
        title,
        description,
        template,
        tddMode: args.tddMode !== undefined ? Boolean(args.tddMode) : undefined,
        preferredEngine: args.preferredEngine as EnginePreference | undefined,
        epicDeliveryMode: args.epicDeliveryMode as EpicDeliveryMode | undefined,
      });
      void kernel.tick();
      return res;
    },
    listTickets: async (args) => {
      const tickets = await stateStore.listTickets({
        repoId: args.repoId ? String(args.repoId) : undefined,
        status: args.status ? (String(args.status) as TicketStatus) : undefined,
      });
      return { tickets };
    },
    getTicketDetail: async (args) => {
      const detail = await buildTicketDetail(String(args.ticketId ?? ""));
      if (!detail) throw new Error(`Ticket not found: ${String(args.ticketId ?? "")}`);
      return detail;
    },
    listInbox: async (args) => {
      const items = await stateStore.listInboxItems({
        repoId: args.repoId ? String(args.repoId) : undefined,
        status: args.status ? (String(args.status) as InboxItemStatus) : undefined,
      });
      return { items };
    },
    resolveInbox: async (args) => {
      const decision = args.decision === "rejected" ? "rejected" : "approved";
      const res = await kernel.resolveInboxItem(
        String(args.inboxId ?? ""),
        decision,
        args.note ? String(args.note) : undefined,
        {
          expandMandate: args.expandMandate !== undefined ? Boolean(args.expandMandate) : undefined,
          arenaWinnerId: args.arenaWinnerId ? String(args.arenaWinnerId) : undefined,
          deliveryAction: args.deliveryAction as "local_merge" | "push_and_create_pr" | undefined,
          budgetIncreaseUsd:
            typeof args.budgetIncreaseUsd === "number" ? args.budgetIncreaseUsd : undefined,
        },
      );
      void kernel.tick();
      void kernel.outbox.processDueEntries();
      return res;
    },
    searchMemoryAndCasebook: async (args) => {
      const query = String(args.query ?? "");
      const repoId = args.repoId ? String(args.repoId) : undefined;
      const limit = typeof args.limit === "number" ? args.limit : 10;
      const memoryHits = await stateStore.searchMemory(query, limit, repoId);
      const repos = repoId ? [await stateStore.getRepo(repoId)] : await stateStore.listRepos();
      const qLower = query.toLowerCase();
      const cases = [];
      for (const r of repos) {
        if (!r) continue;
        const list = await stateStore.listCasebookEntries(r.id, { includeReverted: true });
        for (const c of list) {
          if (
            !qLower ||
            `${c.title} ${c.goalSummary} ${c.solutionSummary} ${c.changedFiles.join(" ")}`
              .toLowerCase()
              .includes(qLower)
          ) {
            cases.push(c);
          }
        }
      }
      return { memoryHits, cases: cases.slice(0, limit) };
    },
    triggerRoutine: (args) => kernel.triggerRoutineNow(String(args.routineId ?? "")),
    managePreview: async (args) => {
      const action = String(args.action ?? "list");
      if (action === "list") {
        return {
          previews: await kernel.listPreviews(args.repoId ? String(args.repoId) : undefined),
        };
      }
      if (action === "start") {
        return {
          preview: await kernel.startTicketPreview(
            String(args.ticketId ?? ""),
            args.candidateId ? String(args.candidateId) : undefined,
            typeof args.ttlMinutes === "number" ? args.ttlMinutes : undefined,
          ),
        };
      }
      if (action === "renew") {
        return {
          preview: await kernel.renewPreview(
            String(args.previewId ?? ""),
            typeof args.ttlMinutes === "number" ? args.ttlMinutes : undefined,
          ),
        };
      }
      if (action === "stop") {
        return {
          preview: await kernel.stopPreview(String(args.previewId ?? "")),
        };
      }
      throw new Error(`Unknown preview action: ${action}`);
    },
    analyzeImpact: (args) =>
      kernel.analyzeRepoImpact(
        String(args.repoId ?? ""),
        Array.isArray(args.paths) ? args.paths.map(String) : ["**"],
      ),
    manageCheckpoints: async (args) => {
      const action = String(args.action ?? "list");
      const ticketId = String(args.ticketId ?? "");
      if (action === "list") {
        return { checkpoints: await kernel.listTicketCheckpoints(ticketId) };
      }
      if (action === "diff") {
        return kernel.getTicketCheckpointDiff(
          ticketId,
          String(args.checkpointId ?? ""),
          args.baseCheckpointId ? String(args.baseCheckpointId) : undefined,
        );
      }
      if (action === "restore") {
        const res = await kernel.restoreTicketCheckpoint(ticketId, String(args.checkpointId ?? ""), {
          mode: args.mode === "fork" ? "fork" : "in_place",
          prompt: args.prompt ? String(args.prompt) : undefined,
          preferredEngine: args.preferredEngine as EnginePreference | undefined,
          targetStage: args.targetStage ? (String(args.targetStage) as StageKind) : undefined,
        });
        void kernel.tick();
        return res;
      }
      throw new Error(`Unknown checkpoint action: ${action}`);
    },
    mutateDagNode: async (args) => {
      const ticket = await kernel.mutateDagNode(String(args.ticketId ?? ""), {
        action: args.action as DagNodeMutationInput["action"],
        title: args.title ? String(args.title) : undefined,
        description: args.description ? String(args.description) : undefined,
        preferredEngine: args.preferredEngine as EnginePreference | undefined,
        allowedPaths: Array.isArray(args.allowedPaths) ? args.allowedPaths.map(String) : undefined,
        dependsOn: Array.isArray(args.dependsOn) ? args.dependsOn.map(String) : undefined,
        tddMode: args.tddMode !== undefined ? Boolean(args.tddMode) : undefined,
        pauseBeforeRun: args.pauseBeforeRun !== undefined ? Boolean(args.pauseBeforeRun) : undefined,
      });
      void kernel.tick();
      return { ticket };
    },
    submitReviewComments: async (args) => {
      const mode = args.mode === "request_changes" ? "request_changes" : "comment_only";
      const result = await kernel.submitTicketReviewComments(String(args.ticketId ?? ""), {
        mode,
        summaryNote: typeof args.summaryNote === "string" ? args.summaryNote : undefined,
        comments: Array.isArray(args.comments)
          ? (args.comments as Array<Record<string, unknown>>).map((cm) => ({
              filePath: String(cm.filePath ?? ""),
              line: typeof cm.line === "number" ? cm.line : 1,
              side: cm.side === "old" ? ("old" as const) : ("new" as const),
              codeSnippet: typeof cm.codeSnippet === "string" ? cm.codeSnippet : undefined,
              severity:
                cm.severity === "blocker" || cm.severity === "major" || cm.severity === "nit"
                  ? cm.severity
                  : undefined,
              body: String(cm.body ?? ""),
            }))
          : [],
      });
      if (mode === "request_changes") {
        void kernel.tick();
      }
      return result;
    },
    systemDoctor: async (args) => kernel.runSystemDoctor({ fix: Boolean(args.fix) }),
  });

  // --- v1.0.0 System Doctor & SQLite Hot Backups ---
  app.get("/api/system/doctor", async (c) => {
    const report = await kernel.runSystemDoctor({ fix: false });
    return c.json(report);
  });

  app.post("/api/system/doctor/fix", async (c) => {
    const report = await kernel.runSystemDoctor({ fix: true });
    return c.json(report);
  });

  app.get("/api/system/backups", async (c) => {
    const backups = await kernel.listSystemBackups();
    return c.json({ backups });
  });

  app.post("/api/system/backups", async (c) => {
    try {
      const backup = await kernel.createSystemBackup();
      return c.json({ backup }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/mcp", (c) => {
    return c.json({
      name: "super-work",
      version: "1.0.0",
      transport: "streamable-http",
      endpoint: "/api/mcp",
    });
  });

  app.post("/api/mcp", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
        400,
      );
    }
    const response = await handleMcpJsonRpcMessage(body, buildMcpHost());
    if (response === null) {
      return c.body(null, 202);
    }
    return c.json(response, 200);
  });

  // --- A.2 Inbound GitHub Webhook & Signed Mobile Remote Approval ---
  app.post("/api/webhooks/github", async (c) => {
    const rawBody = await c.req.text();
    const savedSetup = await stateStore.getSystemSetting<SystemSetupConfig>("setup_config");
    const secret =
      savedSetup?.notifications?.githubWebhookSecret?.trim() ||
      process.env.GITHUB_WEBHOOK_SECRET?.trim() ||
      "";
    if (!secret) {
      return c.json(
        { error: "Configure githubWebhookSecret in Setup before accepting inbound GitHub webhooks." },
        403,
      );
    }
    const sig = c.req.header("x-hub-signature-256") ?? c.req.header("X-Hub-Signature-256");
    if (!verifyWebhookHmacSha256(rawBody, sig, secret)) {
      return c.json({ error: "Invalid GitHub webhook signature" }, 401);
    }

    const eventName = c.req.header("x-github-event") ?? "";
    if (eventName === "ping") {
      return c.json({ ok: true, pong: true });
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON payload" }, 400);
    }

    const repos = await stateStore.listRepos();
    const parsed = parseGithubWebhookEvent(eventName, payload, repos, c.req.query("repoId"));
    if (!parsed.trigger) {
      return c.json({ ok: true, ignored: true, reason: parsed.ignoredReason }, 200);
    }
    const result = await kernel.ingestTrigger(parsed.trigger);
    void kernel.tick();
    return c.json({ ok: true, repoId: parsed.matchedRepo?.id, result }, 202);
  });

  const getActionSecret = async (): Promise<string> => {
    const savedSetup = await stateStore.getSystemSetting<SystemSetupConfig>("setup_config");
    return (
      savedSetup?.notifications?.actionSecret?.trim() ||
      process.env.SUPER_WORK_ACTION_SECRET?.trim() ||
      savedSetup?.notifications?.webhookSecret?.trim() ||
      ""
    );
  };

  app.get("/api/webhooks/action", async (c) => {
    const tokenParam = c.req.query("token") ?? "";
    const secret = await getActionSecret();
    const verified = verifyActionToken(tokenParam, secret);
    if (!verified.valid) {
      return c.html(
        `<!doctype html><html><body style="font-family:system-ui;background:#09090b;color:#f4f4f5;padding:24px;max-width:560px;margin:auto"><h2>Super-Work Remote Action</h2><p style="color:#fb7185">${escapeHtml(verified.reason)}</p></body></html>`,
        401,
      );
    }
    const item = await stateStore.getInboxItem(verified.payload.inboxId);
    if (!item) {
      return c.html(
        `<!doctype html><html><body style="font-family:system-ui;background:#09090b;color:#f4f4f5;padding:24px;max-width:560px;margin:auto"><h2>Inbox Item Not Found</h2></body></html>`,
        404,
      );
    }
    const ticket = await stateStore.getTicket(item.ticketId);
    const alreadyDone = item.status !== "pending";
    const candidates = ticket?.arenaCandidates ?? [];
    const safeToken = escapeHtml(tokenParam);

    const buttonsHtml = alreadyDone
      ? `<p style="padding:12px;border-radius:8px;background:#18181b;border:1px solid #27272a;color:#34d399">Already resolved: <strong>${escapeHtml(item.status)}</strong>${item.resolutionNote ? ` (${escapeHtml(item.resolutionNote)})` : ""}</p>`
      : item.kind === "arena_tiebreak" && candidates.length >= 2
        ? `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">
            <button name="decision" value="approved_cand_a" style="padding:10px 16px;border-radius:8px;border:0;background:#4f46e5;color:#fff;font-weight:600;cursor:pointer">Adopt A (${escapeHtml(candidates[0]!.engine)} · ${candidates[0]!.score})</button>
            <button name="decision" value="approved_cand_b" style="padding:10px 16px;border-radius:8px;border:0;background:#059669;color:#fff;font-weight:600;cursor:pointer">Adopt B (${escapeHtml(candidates[1]!.engine)} · ${candidates[1]!.score})</button>
            <button name="decision" value="rejected" style="padding:10px 16px;border-radius:8px;border:1px solid #3f3f46;background:#18181b;color:#fca5a5;cursor:pointer">Reject</button>
           </div>`
        : `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">
            <button name="decision" value="approved" style="padding:10px 18px;border-radius:8px;border:0;background:#4f46e5;color:#fff;font-weight:600;cursor:pointer">Approve & Continue</button>
            ${item.kind === "mandate_violation" ? `<button name="decision" value="approved_expand" style="padding:10px 16px;border-radius:8px;border:0;background:#d97706;color:#fff;font-weight:600;cursor:pointer">Expand Mandate & Continue</button>` : ""}
            <button name="decision" value="rejected" style="padding:10px 18px;border-radius:8px;border:1px solid #3f3f46;background:#18181b;color:#fca5a5;cursor:pointer">Reject</button>
           </div>`;

    return c.html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Super-Work Decision</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#09090b;color:#f4f4f5;padding:20px;max-width:600px;margin:0 auto;line-height:1.5">
  <div style="border:1px solid #27272a;background:#18181b;border-radius:14px;padding:20px">
    <div style="font-size:12px;color:#818cf8;font-family:monospace">${escapeHtml(item.kind)} · ${escapeHtml(item.ticketId)}</div>
    <h2 style="margin:8px 0;font-size:18px">${escapeHtml(item.title)}</h2>
    <p style="color:#a1a1aa;font-size:14px;white-space:pre-wrap">${escapeHtml(item.summary)}</p>
    ${
      alreadyDone
        ? buttonsHtml
        : `<form method="POST" action="/api/webhooks/action" style="margin-top:16px">
            <input type="hidden" name="token" value="${safeToken}" />
            <label style="display:block;font-size:12px;color:#a1a1aa;margin-bottom:6px">Optional Note / Instruction</label>
            <textarea name="note" rows="2" placeholder="Optional guidance for worker..." style="width:100%;box-sizing:border-box;background:#09090b;color:#f4f4f5;border:1px solid #3f3f46;border-radius:8px;padding:8px"></textarea>
            ${buttonsHtml}
          </form>`
    }
  </div>
</body></html>`);
  });

  app.post("/api/webhooks/action", async (c) => {
    const contentType = c.req.header("content-type") ?? "";
    const accept = c.req.header("accept") ?? "";
    let params: Record<string, unknown> = {};

    if (contentType.includes("application/json")) {
      params = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    } else if (contentType.includes("application/x-www-form-urlencoded")) {
      const formBody = await c.req.text();
      const sp = new URLSearchParams(formBody);
      for (const [k, v] of sp.entries()) {
        params[k] = v;
      }
    } else {
      const parsed = await c.req.parseBody().catch(() => ({}));
      params = parsed as Record<string, unknown>;
    }

    const tokenParam = String(params.token ?? c.req.query("token") ?? "");
    const secret = await getActionSecret();
    const verified = verifyActionToken(tokenParam, secret);
    if (!verified.valid) {
      return c.json({ error: verified.reason }, 401);
    }

    const existingItem = await stateStore.getInboxItem(verified.payload.inboxId);
    if (!existingItem) {
      return c.json({ error: "Inbox item not found" }, 404);
    }

    const wantsHtml =
      contentType.includes("application/x-www-form-urlencoded") ||
      (accept.includes("text/html") && !contentType.includes("application/json"));

    if (existingItem.status !== "pending") {
      if (wantsHtml) {
        return c.html(
          `<!doctype html><html><body style="font-family:system-ui;background:#09090b;color:#f4f4f5;padding:24px;max-width:560px;margin:auto"><h2>Already Resolved</h2><p>Status: <strong>${escapeHtml(existingItem.status)}</strong></p></body></html>`,
        );
      }
      return c.json({ ok: true, alreadyResolved: true, item: existingItem });
    }

    const rawDecision = String(params.decision ?? "approved");
    const decision: "approved" | "rejected" =
      rawDecision === "rejected" || rawDecision === "reject" ? "rejected" : "approved";
    const expandMandate =
      rawDecision === "approved_expand" || Boolean(params.expandMandate);
    const arenaWinnerId =
      rawDecision === "approved_cand_a"
        ? "cand_a"
        : rawDecision === "approved_cand_b"
          ? "cand_b"
          : params.arenaWinnerId
            ? String(params.arenaWinnerId)
            : undefined;
    const note = params.note ? String(params.note).trim() || undefined : undefined;

    const resolved = await kernel.resolveInboxItem(existingItem.id, decision, note, {
      expandMandate: expandMandate || undefined,
      arenaWinnerId,
      deliveryAction: params.deliveryAction as "local_merge" | "push_and_create_pr" | undefined,
      budgetIncreaseUsd:
        params.budgetIncreaseUsd !== undefined ? Number(params.budgetIncreaseUsd) : undefined,
    });
    void kernel.tick();
    void kernel.outbox.processDueEntries();

    if (wantsHtml) {
      return c.html(
        `<!doctype html><html><body style="font-family:system-ui;background:#09090b;color:#f4f4f5;padding:24px;max-width:560px;margin:auto"><div style="border:1px solid #065f46;background:#064e3b33;border-radius:12px;padding:20px"><h2 style="color:#34d399;margin-top:0">Decision Recorded</h2><p>${escapeHtml(resolved.item.title)} -> <strong>${escapeHtml(resolved.item.status)}</strong> (Ticket: ${escapeHtml(resolved.ticket.status)})</p></div></body></html>`,
      );
    }
    return c.json({ ok: true, ...resolved });
  });

  app.post("/api/webhooks/chatops", async (c) => {
    const rawBody = await c.req.text();
    const secret = await getActionSecret();
    if (!secret) {
      return c.json(
        { error: "Configure actionSecret or webhookSecret before accepting ChatOps callbacks." },
        403,
      );
    }
    const sig = c.req.header("x-super-work-signature") ?? c.req.header("X-Super-Work-Signature");
    if (!verifyWebhookHmacSha256(rawBody, sig, secret)) {
      return c.json({ error: "Invalid ChatOps HMAC signature" }, 401);
    }

    let body: {
      action?: string;
      inboxId?: string;
      decision?: "approved" | "rejected";
      note?: string;
      expandMandate?: boolean;
      arenaWinnerId?: string;
      deliveryAction?: "local_merge" | "push_and_create_pr";
      budgetIncreaseUsd?: number;
      ticketId?: string;
      message?: string;
    };
    try {
      body = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "Invalid JSON payload" }, 400);
    }

    if (body.action === "reply_ticket") {
      if (!body.ticketId || !body.message?.trim()) {
        return c.json({ error: "ticketId and message are required for reply_ticket" }, 400);
      }
      const ticket = await kernel.sendThreadMessage(body.ticketId, body.message.trim());
      void kernel.tick();
      return c.json({ ok: true, ticket });
    }

    if (!body.inboxId || (body.decision !== "approved" && body.decision !== "rejected")) {
      return c.json({ error: "inboxId and decision ('approved'|'rejected') are required" }, 400);
    }
    const res = await kernel.resolveInboxItem(body.inboxId, body.decision, body.note, {
      expandMandate: body.expandMandate,
      arenaWinnerId: body.arenaWinnerId,
      deliveryAction: body.deliveryAction,
      budgetIncreaseUsd: body.budgetIncreaseUsd,
    });
    void kernel.tick();
    void kernel.outbox.processDueEntries();
    return c.json({ ok: true, ...res });
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
