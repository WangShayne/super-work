import { nowIso } from "@super-work/core";
import type {
  CliScanReport,
  EngineModelProfile,
  LlmProviderPreset,
  NotificationConfig,
  ReasoningEffort,
  SystemSetupConfig,
  WorkerEngineId,
} from "@super-work/core";
import {
  DEFAULT_NOTIFICATION_CONFIG,
  buildControlPlaneLLMFromSetup,
  testControlPlaneLLMConnection,
} from "@super-work/drivers";
import {
  type ServerRouteContext,
  normalizeSetupModel,
  toPublicSetupStatus,
} from "./context.ts";

export function registerSetupSystemRoutes(ctx: ServerRouteContext): void {
  const { app, kernel, stateStore, scanner, notificationDispatcher, getActiveProviderName } = ctx;

  app.get("/api/health", async (c) => {
    const [
      repos,
      tickets,
      pendingInbox,
      pendingOutbox,
      availableEngines,
      worktrees,
      routines,
      previews,
      campaigns,
      mergeTrain,
    ] = await Promise.all([
      stateStore.listRepos(),
      stateStore.listTickets(),
      stateStore.listInboxItems({ status: "pending" }),
      stateStore.listOutboxEntries({ status: "pending" }),
      kernel.getAvailableEngines(),
      kernel.inspectWorktrees(),
      stateStore.listRoutines(),
      kernel.listPreviews(),
      kernel.listCampaigns(),
      kernel.listMergeTrain(),
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
        activeCampaigns: campaigns.filter((cmp) => cmp.status === "running").length,
        queuedMergeTrain: mergeTrain.filter(
          (m) => m.status === "queued" || m.status === "validating" || m.status === "barrier_waiting",
        ).length,
      },
      selfReload: kernel.getSelfReloadState(),
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
      geminiProfile?: EngineModelProfile;
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
      geminiProfile:
        body.geminiProfile !== undefined
          ? cleanProfile(body.geminiProfile)
          : (existing?.geminiProfile ?? {}),
      notifications: nextNotifications,
      updatedAt: nowIso(),
    };

    await stateStore.setSystemSetting("setup_config", nextConfig);

    if (ctx.mutableLlm) {
      ctx.mutableLlm.reconfigure(buildControlPlaneLLMFromSetup(nextConfig));
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

  // --- Metrics & Quota ---
  app.get("/api/metrics", async (c) => {
    const repoId = c.req.query("repoId") || undefined;
    const metrics = await stateStore.getMetricsSummary(repoId);
    return c.json({ metrics });
  });

  // --- v1.1.0 A.2 Chief-of-Staff Advisor ---
  app.post("/api/chief/ask", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      repoId?: string;
      question?: string;
    };
    if (!body.question?.trim()) {
      return c.json({ error: "question is required" }, 400);
    }
    const result = await kernel.askChief({
      repoId: body.repoId?.trim() || undefined,
      question: body.question.trim(),
    });
    return c.json(result);
  });

  // --- v1.0.0 System Doctor & SQLite Hot Backups + v1.1.0 Restore + v1.2.0 Service Status ---
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

  app.post("/api/system/backups/:id/restore", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { force?: boolean };
    try {
      const result = await kernel.restoreSystemBackup(id, { force: Boolean(body.force) });
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.includes("not found") ? 404 : 400);
    }
  });

  app.get("/api/system/service", async (c) => {
    const linesRaw = Number(c.req.query("lines") ?? 40);
    const tailLines =
      Number.isFinite(linesRaw) && linesRaw > 0 ? Math.min(500, Math.floor(linesRaw)) : 40;
    const status = await ctx.serviceManager.status();
    const logs = ctx.serviceManager.readLogs(tailLines);
    return c.json({ status, logs });
  });

  app.get("/api/system/reload", (c) => {
    return c.json({ reload: kernel.getSelfReloadState() });
  });

  app.post("/api/system/reload", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      force?: boolean;
      skipCanary?: boolean;
    };
    const reload = await kernel.triggerSelfReload({
      force: Boolean(body.force),
      skipCanary: Boolean(body.skipCanary),
    });
    return c.json({ reload }, reload.phase === "failed" ? 500 : 202);
  });
}
