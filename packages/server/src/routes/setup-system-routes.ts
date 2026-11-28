import { normalizeSystemSetupConfig, nowIso, profileDriverEngine } from "@super-work/core";
import type {
  ApiWorkerProfile,
  CliScanReport,
  LlmProviderPreset,
  ModelProfile,
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
import {
  type ApiWorkerProfileInput,
  type EngineProfileInput,
  type ModelProfileInput,
  SetupValidationError,
  applyProfileDeletions,
  cleanApiWorkerProfile,
  cleanEngineProfile,
  mergeModelProfiles,
  registerTestModelRoute,
  registerTestWorkerRoute,
  resetTrippedEngineHealth,
  syncLegacyIntoProfiles,
  validateRoleId,
} from "./setup-worker-helpers.ts";

import { registerListModelsRoute } from "./setup-model-discovery-route.ts";

export function registerSetupSystemRoutes(ctx: ServerRouteContext): void {
  const { app, kernel, stateStore, scanner, notificationDispatcher, getActiveProviderName } = ctx;
  registerTestWorkerRoute(ctx);
  registerTestModelRoute(ctx);
  registerListModelsRoute(ctx);

  /** 保存 setup_config、热切换控制面 LLM，并同步各仓库的首选引擎（configure 与 quick-start 共用）。 */
  async function persistSetupConfig(nextConfig: SystemSetupConfig, syncRepos = true): Promise<void> {
    await stateStore.setSystemSetting("setup_config", nextConfig);
    if (ctx.mutableLlm) {
      ctx.mutableLlm.reconfigure(buildControlPlaneLLMFromSetup(nextConfig));
    }
    if (syncRepos === false) return;
    for (const repo of await stateStore.listRepos()) {
      await stateStore.upsertRepo({
        ...repo,
        preferredImplementEngine: nextConfig.preferredImplementEngine,
        preferredReviewEngine: nextConfig.preferredReviewEngine,
        implementModelId: nextConfig.implementModelId,
        reviewModelId: nextConfig.reviewModelId,
        updatedAt: nowIso(),
      });
    }
  }

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
      claudeProfile?: EngineProfileInput;
      codexProfile?: EngineProfileInput;
      opencodeProfile?: EngineProfileInput;
      geminiProfile?: EngineProfileInput;
      apiWorkerProfile?: ApiWorkerProfileInput;
      /** v1.8.1 unified peer registry: upserted by id; saved apiKey kept unless clearApiKey. */
      modelProfiles?: ModelProfileInput[];
      /** Custom profile ids to remove (builtinCli profiles are rejected); dangling role bindings fall back to heuristic/auto. */
      deleteModelProfileIds?: string[];
      controlModelId?: string;
      implementModelId?: string;
      reviewModelId?: string;
      /** When false, persistSetupConfig leaves each repo's preferredImplementEngine/preferredReviewEngine untouched (default: sync). */
      syncRepos?: boolean;
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

    let apiWorkerProfile: ApiWorkerProfile | undefined = existing?.apiWorkerProfile;
    let mergedProfiles: ModelProfile[] = normalizeSystemSetupConfig(existing, scanReport).modelProfiles ?? [];
    let touchedProfiles: ModelProfile[] = [];
    let deletedProfileIds = new Set<string>();
    try {
      if (body.apiWorkerProfile) {
        apiWorkerProfile = cleanApiWorkerProfile(body.apiWorkerProfile, existing?.apiWorkerProfile);
      }
      for (const p of [body.claudeProfile, body.codexProfile, body.opencodeProfile, body.geminiProfile]) {
        if (p) cleanEngineProfile(p); // validate baseUrl up-front so nothing is half-saved
      }
      if (body.modelProfiles !== undefined && !Array.isArray(body.modelProfiles)) {
        throw new SetupValidationError("modelProfiles must be an array");
      }
      const merged = mergeModelProfiles(mergedProfiles, body.modelProfiles ?? []);
      const pruned = applyProfileDeletions(merged.profiles, body.deleteModelProfileIds);
      mergedProfiles = pruned.profiles;
      deletedProfileIds = pruned.deleted;
      touchedProfiles = merged.touched.filter((p) => !deletedProfileIds.has(p.id));
      validateRoleId("controlModelId", body.controlModelId, mergedProfiles);
      validateRoleId("implementModelId", body.implementModelId, mergedProfiles);
      validateRoleId("reviewModelId", body.reviewModelId, mergedProfiles);
    } catch (err) {
      if (err instanceof SetupValidationError) return c.json({ error: err.message }, 400);
      throw err;
    }

    const finalApiKey = body.clearApiKey
      ? undefined
      : body.llmApiKey?.trim()
        ? body.llmApiKey.trim()
        : existing?.llmApiKey;

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

    const legacyLlmTouched =
      body.llmPreset !== undefined ||
      body.llmApiKey !== undefined ||
      body.llmBaseUrl !== undefined ||
      body.llmModel !== undefined ||
      body.clearApiKey === true;
    const nextConfig: SystemSetupConfig = normalizeSystemSetupConfig({
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
          ? cleanEngineProfile(body.claudeProfile, existing?.claudeProfile)
          : (existing?.claudeProfile ?? {}),
      codexProfile:
        body.codexProfile !== undefined
          ? cleanEngineProfile(body.codexProfile, existing?.codexProfile)
          : (existing?.codexProfile ?? {}),
      opencodeProfile:
        body.opencodeProfile !== undefined
          ? cleanEngineProfile(body.opencodeProfile, existing?.opencodeProfile)
          : (existing?.opencodeProfile ?? {}),
      geminiProfile:
        body.geminiProfile !== undefined
          ? cleanEngineProfile(body.geminiProfile, existing?.geminiProfile)
          : (existing?.geminiProfile ?? {}),
      ...(apiWorkerProfile ? { apiWorkerProfile } : {}),
      modelProfiles: syncLegacyIntoProfiles(mergedProfiles, {
        // legacy per-engine / api profile edits flow into their peer profiles unless the same
        // request also edits that profile through modelProfiles (which wins).
        claude: body.claudeProfile !== undefined ? cleanEngineProfile(body.claudeProfile, existing?.claudeProfile) : undefined,
        codex: body.codexProfile !== undefined ? cleanEngineProfile(body.codexProfile, existing?.codexProfile) : undefined,
        opencode: body.opencodeProfile !== undefined ? cleanEngineProfile(body.opencodeProfile, existing?.opencodeProfile) : undefined,
        gemini: body.geminiProfile !== undefined ? cleanEngineProfile(body.geminiProfile, existing?.geminiProfile) : undefined,
        api: body.apiWorkerProfile !== undefined ? apiWorkerProfile : undefined,
        // legacy HTTP control-plane edits must re-migrate instead of leaving a stale api_llm_* copy
        refreshLegacyLlm: legacyLlmTouched && body.controlModelId === undefined,
        skipIds: new Set(touchedProfiles.map((p) => p.id)),
      }),
      controlModelId:
        body.controlModelId ?? (legacyLlmTouched ? undefined : existing?.controlModelId),
      implementModelId: body.implementModelId ?? existing?.implementModelId,
      reviewModelId: body.reviewModelId ?? existing?.reviewModelId,
      notifications: nextNotifications,
      updatedAt: nowIso(),
    }, scanReport);

    await persistSetupConfig(nextConfig, body.syncRepos !== false);
    if (deletedProfileIds.size > 0) {
      // repos pinning a deleted profile fall back to 'auto' (independent of syncRepos)
      for (const repo of await stateStore.listRepos()) {
        const impl = repo.implementModelId && deletedProfileIds.has(repo.implementModelId);
        const rev = repo.reviewModelId && deletedProfileIds.has(repo.reviewModelId);
        if (!impl && !rev) continue;
        await stateStore.upsertRepo({
          ...repo,
          ...(impl ? { implementModelId: "auto" } : {}),
          ...(rev ? { reviewModelId: "auto" } : {}),
          updatedAt: nowIso(),
        });
      }
    }
    // Fresh credentials/endpoints must not wait out a tripped circuit-breaker cooldown.
    await resetTrippedEngineHealth(ctx, [
      ...new Set<WorkerEngineId>([
        ...(
          [
            ["claude", body.claudeProfile],
            ["codex", body.codexProfile],
            ["opencode", body.opencodeProfile],
            ["gemini", body.geminiProfile],
            ["api", body.apiWorkerProfile],
          ] as const
        )
          .filter(([, profile]) => profile !== undefined)
          .map(([engine]) => engine as WorkerEngineId),
        ...touchedProfiles.map((p) => profileDriverEngine(p)),
      ]),
    ]);

    return c.json(toPublicSetupStatus(nextConfig, scanReport, getActiveProviderName()));
  });

  // v1.8.0 零配置首跑：自动选择已登录的最佳 CLI 作为控制面大脑。
  app.post("/api/setup/quick-start", async (c) => {
    await c.req.json().catch(() => ({}));
    const existing = await stateStore.getSystemSetting<SystemSetupConfig>("setup_config");
    const scanReport = await scanner.scanAll();
    await stateStore.setSystemSetting("last_cli_scan", scanReport);

    const isReady = (id: "claude" | "codex"): boolean =>
      scanReport.tools.some((t) => t.id === id && t.installed && t.authenticated === true);
    const llmPreset: LlmProviderPreset = isReady("claude")
      ? "claude_cli"
      : isReady("codex")
        ? "codex_cli"
        : "heuristic";

    const nextConfig: SystemSetupConfig = normalizeSystemSetupConfig(
      {
        ...(existing ?? {
          llmBaseUrl: "",
          llmEffort: "low",
          claudeProfile: {},
          codexProfile: {},
          opencodeProfile: {},
          geminiProfile: {},
          notifications: DEFAULT_NOTIFICATION_CONFIG,
        }),
        initialized: true,
        llmPreset,
        llmModel: normalizeSetupModel(llmPreset, undefined),
        preferredImplementEngine: scanReport.recommendedImplementEngine,
        preferredReviewEngine: scanReport.recommendedReviewEngine,
        // re-derived by normalization: claude_cli -> cli_claude, codex_cli -> cli_codex, else heuristic
        controlModelId: undefined,
        implementModelId: "auto",
        reviewModelId: "auto",
        updatedAt: nowIso(),
      },
      scanReport,
    );
    await persistSetupConfig(nextConfig);
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

  // --- Direction D: Flight Recorder & Run Digest ---
  app.get("/api/digest", async (c) => {
    const repoId = c.req.query("repoId") || undefined;
    const rawHours = c.req.query("hours");
    const parsed = rawHours === undefined || rawHours === "" ? 24 : Number(rawHours);
    const hours = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 8760) : 24;
    const digest = await kernel.getRunDigest({ repoId, hours });
    return c.json({ digest });
  });

  app.get("/api/flight-events", async (c) => {
    const repoId = c.req.query("repoId") || undefined;
    const rawLimit = Number(c.req.query("limit") ?? 50);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 500) : 50;
    const events = await kernel.listFlightEvents({ repoId, limit });
    return c.json({ events });
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

  // --- v1.5.0 Persistent Engine Circuit Breaker ---
  const ENGINE_IDS = ["claude", "codex", "gemini", "opencode", "api", "mock"] as const;
  const parseEngine = (raw: string | undefined): (typeof ENGINE_IDS)[number] | undefined =>
    ENGINE_IDS.find((e) => e === raw);

  app.get("/api/system/engines", async (c) => {
    const engines = await kernel.listEngineHealth();
    return c.json({ engines });
  });

  app.post("/api/system/engines/probe", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { engine?: string };
    const engine = body.engine ? parseEngine(body.engine) : undefined;
    if (body.engine && !engine) {
      return c.json({ error: `unknown engine '${body.engine}'` }, 400);
    }
    const probed = await kernel.reprobeEngineHealth(engine);
    const engines = await kernel.listEngineHealth();
    return c.json({ probed, engines });
  });

  app.post("/api/system/engines/:engine/reset", async (c) => {
    const engine = parseEngine(c.req.param("engine"));
    if (!engine) {
      return c.json({ error: `unknown engine '${c.req.param("engine")}'` }, 400);
    }
    const record = await kernel.resetEngineHealth(engine);
    return c.json({ engine: record });
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
