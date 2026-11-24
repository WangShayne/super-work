import { ROUTINE_PRESET_TEMPLATES } from "@super-work/core";
import type {
  CreateCampaignInput,
  PipelineTemplateId,
  RoutineScheduleKind,
  RoutineSpec,
  WorkerEngineId,
} from "@super-work/core";
import type { ServerRouteContext } from "./context.ts";

export function registerAutonomyRoutes(ctx: ServerRouteContext): void {
  const { app, kernel, stateStore } = ctx;

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

  // --- v1.1.0 D.1 Golden Eval Benchmark Suite ---
  app.get("/api/evals/cases", async (c) => {
    const repoId = c.req.query("repoId") || undefined;
    const cases = await kernel.listEvalCases(repoId);
    return c.json({ cases });
  });

  app.post("/api/evals/cases/from-ticket/:ticketId", async (c) => {
    const ticketId = c.req.param("ticketId");
    try {
      const evalCase = await kernel.createEvalCaseFromTicket(ticketId);
      return c.json({ evalCase }, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.includes("not found") ? 404 : 400);
    }
  });

  app.delete("/api/evals/cases/:id", async (c) => {
    const deleted = await kernel.deleteEvalCase(c.req.param("id"));
    if (!deleted) {
      return c.json({ error: "Eval case not found" }, 404);
    }
    return c.json({ ok: true });
  });

  app.get("/api/evals/runs", async (c) => {
    const repoId = c.req.query("repoId") || undefined;
    const evalCaseId = c.req.query("evalCaseId") || undefined;
    const runs = await kernel.listEvalRuns({ repoId, evalCaseId });
    return c.json({ runs });
  });

  app.post("/api/evals/run", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      evalCaseId?: string;
      engines?: WorkerEngineId[];
      maxBudgetUsd?: number;
    };
    if (!body.evalCaseId?.trim()) {
      return c.json({ error: "evalCaseId is required" }, 400);
    }
    try {
      const evalRun = await kernel.runEvalCase({
        evalCaseId: body.evalCaseId.trim(),
        engines: Array.isArray(body.engines) ? body.engines : undefined,
        maxBudgetUsd: typeof body.maxBudgetUsd === "number" ? body.maxBudgetUsd : undefined,
      });
      return c.json({ evalRun }, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.includes("not found") ? 404 : 400);
    }
  });

  // --- v1.2.0 Pillar A: Metric-Driven Goal Campaigns ---
  app.get("/api/campaigns", async (c) => {
    const repoId = c.req.query("repoId") || undefined;
    const campaigns = await kernel.listCampaigns(repoId);
    return c.json({ campaigns });
  });

  app.post("/api/campaigns", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<CreateCampaignInput>;
    if (
      !body.repoId ||
      !body.name?.trim() ||
      !body.goalPrompt?.trim() ||
      !body.metricCommand?.trim() ||
      (body.direction !== "increase" && body.direction !== "decrease") ||
      typeof body.targetValue !== "number"
    ) {
      return c.json(
        {
          error:
            "repoId, name, goalPrompt, metricCommand, direction ('increase'|'decrease'), and targetValue are required",
        },
        400,
      );
    }
    try {
      const campaign = await kernel.createCampaign({
        repoId: body.repoId,
        name: body.name,
        goalPrompt: body.goalPrompt,
        metricCommand: body.metricCommand,
        metricRegex: body.metricRegex,
        metricUnit: body.metricUnit,
        direction: body.direction,
        targetValue: body.targetValue,
        deliveryMode: body.deliveryMode,
        allowedPaths: body.allowedPaths,
        template: body.template,
        preferredEngine: body.preferredEngine,
        maxIterations: body.maxIterations,
        maxTotalBudgetUsd: body.maxTotalBudgetUsd,
        autoStart: body.autoStart,
      });
      if (campaign.status === "running") {
        void kernel.tick();
      }
      return c.json({ campaign }, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.includes("not found") ? 404 : 400);
    }
  });

  app.get("/api/campaigns/:id", async (c) => {
    const detail = await kernel.getCampaign(c.req.param("id"));
    if (!detail) {
      return c.json({ error: "Goal campaign not found" }, 404);
    }
    return c.json(detail);
  });

  app.post("/api/campaigns/:id/start", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { note?: string };
    try {
      const campaign = await kernel.startCampaign(id, { note: body.note });
      if (campaign.status === "running") {
        void kernel.tick();
      }
      return c.json({ campaign });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.includes("not found") ? 404 : 400);
    }
  });

  app.post("/api/campaigns/:id/pause", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    try {
      const campaign = await kernel.pauseCampaign(id, body.reason);
      return c.json({ campaign });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.includes("not found") ? 404 : 400);
    }
  });

  app.post("/api/campaigns/:id/deliver", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as {
      action?: "local_merge" | "push_and_create_pr";
    };
    const action = body.action === "push_and_create_pr" ? "push_and_create_pr" : "local_merge";
    try {
      const campaign = await kernel.deliverCampaign(id, action);
      return c.json({ campaign });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.includes("not found") ? 404 : 400);
    }
  });

  app.delete("/api/campaigns/:id", async (c) => {
    const id = c.req.param("id");
    const deleted = await kernel.deleteCampaign(id);
    if (!deleted) {
      return c.json({ error: "Goal campaign not found" }, 404);
    }
    return c.json({ ok: true, id });
  });
}
