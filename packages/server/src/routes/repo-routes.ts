import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  classifyPlaybookHealth,
  detectRepoDefaults,
  getAutonomyPresetPatch,
  inferAutonomyPreset,
  newId,
  normalizeAutonomyPreset,
  normalizePlaybookRuleText,
  normalizeSmokeCheckConfig,
  normalizeVerificationStrategy,
  nowIso,
} from "@super-work/core";
import type {
  AutonomyPreset,
  DeliveryChannel,
  DeliveryGatePolicy,
  LifecycleHooksConfig,
  PlaybookEntry,
  RepoConfig,
  RepoKnowledgeBundle,
  SandboxMode,
  SmokeCheckConfig,
  TaskBlueprint,
  VerificationStrategy,
  WorkerEngineId,
} from "@super-work/core";
import { type ServerRouteContext, normalizeHooksConfig } from "./context.ts";

/**
 * SQLite repos 表尚无 autonomy_preset 列（drivers 不在本 ticket 范围内）；
 * preset 展开后的具体字段已持久化，读取时由 inferAutonomyPreset 无损还原。
 */
function withAutonomyPreset(repo: RepoConfig): RepoConfig {
  return { ...repo, autonomyPreset: inferAutonomyPreset(repo) };
}

export function registerRepoRoutes(ctx: ServerRouteContext): void {
  const { app, kernel, stateStore } = ctx;

  // --- Repositories ---
  app.get("/api/repos", async (c) => {
    const repos = await stateStore.listRepos();
    return c.json({ repos: repos.map(withAutonomyPreset) });
  });

  // v1.8.0 零配置检测：只读，不注册仓库。
  app.post("/api/repos/detect", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { rootPath?: unknown };
    const rootPath = typeof body.rootPath === "string" ? body.rootPath.trim() : "";
    if (!rootPath) {
      return c.json({ error: "rootPath is required" }, 400);
    }
    const abs = resolve(rootPath);
    let isDir = false;
    try {
      isDir = existsSync(abs) && statSync(abs).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      return c.json({ error: `Directory does not exist: ${abs}` }, 400);
    }
    return c.json({ detected: detectRepoDefaults(abs) });
  });

  app.post("/api/repos", async (c) => {
    const body = (await c.req.json()) as Partial<RepoConfig>;
    if (!body.name || !body.rootPath) {
      return c.json({ error: "name and rootPath are required" }, 400);
    }
    const ts = nowIso();
    const rootPath = resolve(body.rootPath);
    const detected = detectRepoDefaults(rootPath);
    // 显式 autonomyPreset，或既无 mode 也无 deliveryGatePolicy 时展开预设（smart 为默认）；显式字段始终优先。
    const explicitPreset = normalizeAutonomyPreset(body.autonomyPreset);
    const expandPreset =
      explicitPreset !== undefined ||
      (body.mode === undefined && body.deliveryGatePolicy === undefined);
    const preset: AutonomyPreset = explicitPreset ?? "smart";
    const pp = expandPreset ? getAutonomyPresetPatch(preset) : undefined;
    const repo: RepoConfig = {
      id: body.id ?? newId("repo"),
      name: body.name,
      rootPath,
      baseBranch: body.baseBranch ?? detected.baseBranch,
      mode: body.mode ?? pp?.mode ?? "observe",
      autonomyPreset: expandPreset ? preset : undefined,
      githubRepo: body.githubRepo,
      defaultTemplate: body.defaultTemplate ?? "standard",
      defaultTddMode: Boolean(body.defaultTddMode),
      deliveryGatePolicy:
        body.deliveryGatePolicy === "always_auto" ||
        body.deliveryGatePolicy === "risk_gated" ||
        body.deliveryGatePolicy === "always_signoff"
          ? body.deliveryGatePolicy
          : pp?.deliveryGatePolicy,
      riskThreshold:
        typeof body.riskThreshold === "number" && Number.isFinite(body.riskThreshold)
          ? Math.max(0, Math.min(100, Math.round(body.riskThreshold)))
          : pp?.riskThreshold,
      sensitivePaths: Array.isArray(body.sensitivePaths)
        ? body.sensitivePaths.map((s) => String(s).trim()).filter(Boolean)
        : undefined,
      blueprints: Array.isArray(body.blueprints)
        ? body.blueprints.filter(
            (b): b is TaskBlueprint => Boolean(b && typeof b.id === "string" && b.id.trim()),
          )
        : undefined,
      hooks: normalizeHooksConfig(body.hooks),
      preferredImplementEngine: body.preferredImplementEngine ?? "claude",
      preferredReviewEngine: body.preferredReviewEngine ?? "codex",
      fallbackEngines: Array.isArray(body.fallbackEngines)
        ? body.fallbackEngines.filter((e): e is WorkerEngineId => Boolean(e))
        : undefined,
      autoCleanupWorktree: body.autoCleanupWorktree ?? pp?.autoCleanupWorktree ?? true,
      verificationCommands: Array.isArray(body.verificationCommands)
        ? body.verificationCommands.map((s) => String(s).trim()).filter(Boolean)
        : detected.verificationCommands,
      verificationStrategy:
        normalizeVerificationStrategy(body.verificationStrategy) ?? pp?.verificationStrategy,
      setupCommands: Array.isArray(body.setupCommands)
        ? body.setupCommands.map((s) => String(s).trim()).filter(Boolean)
        : [],
      smokeCheck: normalizeSmokeCheckConfig(body.smokeCheck),
      previewCommand: body.previewCommand?.trim() || undefined,
      sandboxMode:
        body.sandboxMode === "off" || body.sandboxMode === "balanced" || body.sandboxMode === "strict"
          ? body.sandboxMode
          : pp?.sandboxMode,
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
    return c.json({ repo: withAutonomyPreset(syncedRepo) }, 201);
  });

  app.patch("/api/repos/:id", async (c) => {
    const id = c.req.param("id");
    const existing = await stateStore.getRepo(id);
    if (!existing) {
      return c.json({ error: "Repository not found" }, 404);
    }
    const rawPatch = (await c.req.json()) as Omit<
      Partial<RepoConfig>,
      | "autonomyPreset"
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
      | "hooks"
      | "verificationStrategy"
    > & {
      autonomyPreset?: AutonomyPreset | null;
      verificationStrategy?: VerificationStrategy | null;
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
      hooks?: LifecycleHooksConfig | null;
    };
    // 预设作为底，同一 PATCH 内的显式字段（含 null）优先。
    const { autonomyPreset: presetRaw, ...explicitPatch } = rawPatch;
    const preset = normalizeAutonomyPreset(presetRaw);
    const patch: Omit<typeof rawPatch, "autonomyPreset"> = preset
      ? { ...getAutonomyPresetPatch(preset), ...explicitPatch }
      : explicitPatch;
    const updated: RepoConfig = {
      ...existing,
      ...patch,
      autonomyPreset: preset ?? (presetRaw === null ? undefined : existing.autonomyPreset),
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
      hooks:
        patch.hooks !== undefined
          ? patch.hooks === null
            ? undefined
            : normalizeHooksConfig(patch.hooks)
          : existing.hooks,
      verificationCommands:
        patch.verificationCommands !== undefined
          ? patch.verificationCommands.map((s) => String(s).trim()).filter(Boolean)
          : (existing.verificationCommands ?? []),
      verificationStrategy:
        patch.verificationStrategy !== undefined
          ? normalizeVerificationStrategy(patch.verificationStrategy)
          : existing.verificationStrategy,
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
    return c.json({ repo: withAutonomyPreset(updated) });
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

  app.get("/api/playbooks/hygiene", async (c) => {
    const repoId = c.req.query("repoId")?.trim() || undefined;
    try {
      return c.json(await kernel.auditPlaybookHygiene(repoId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.includes("Repository not found") ? 404 : 400);
    }
  });

  app.post("/api/playbooks/hygiene/prune", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      repoId?: string;
      dryRun?: boolean;
      mode?: string;
    };
    if (body.mode !== undefined && body.mode !== "disable" && body.mode !== "delete") {
      return c.json({ error: 'mode must be "disable" or "delete"' }, 400);
    }
    try {
      const result = await kernel.pruneNoisyPlaybooks(
        typeof body.repoId === "string" && body.repoId.trim() ? body.repoId.trim() : undefined,
        { dryRun: body.dryRun === true, mode: body.mode === "delete" ? "delete" : "disable" },
      );
      return c.json(result);
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

  app.get("/api/repos/:id/knowledge-bundle", async (c) => {
    try {
      const bundle = await kernel.exportRepoKnowledgeBundle(c.req.param("id"));
      return c.json({ bundle });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.includes("not found") ? 404 : 400);
    }
  });

  app.post("/api/repos/:id/knowledge-bundle/import", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { bundle?: RepoKnowledgeBundle };
    const candidate = body.bundle ?? (body as unknown as RepoKnowledgeBundle);
    try {
      const result = await kernel.importRepoKnowledgeBundle(c.req.param("id"), candidate);
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.includes("not found") ? 404 : 400);
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
}
