import type { EnginePreference, PipelineTemplateId } from "@super-work/core";
import type { ServerRouteContext } from "./context.ts";

export function registerMilestoneRoutes(ctx: ServerRouteContext): void {
  const { app, kernel } = ctx;

  app.get("/api/milestones", async (c) => {
    const repoId = c.req.query("repoId") || undefined;
    const milestones = await kernel.listMilestones(repoId);
    return c.json({ milestones });
  });

  app.post("/api/milestones", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      repoId?: string;
      name?: string;
      targetVersion?: string;
      requirements?: unknown;
      preferredEngine?: EnginePreference;
      template?: PipelineTemplateId;
      maxBudgetUsdPerItem?: number;
    };
    if (!body.repoId || !body.name || !Array.isArray(body.requirements)) {
      return c.json({ error: "repoId, name and requirements[] are required" }, 400);
    }
    try {
      const milestone = await kernel.createMilestone({
        repoId: body.repoId,
        name: body.name,
        targetVersion: body.targetVersion,
        requirements: body.requirements.map(String),
        preferredEngine: body.preferredEngine,
        template: body.template,
        maxBudgetUsdPerItem:
          typeof body.maxBudgetUsdPerItem === "number" ? body.maxBudgetUsdPerItem : undefined,
      });
      return c.json({ milestone }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get("/api/milestones/:id", async (c) => {
    const milestone = await kernel.getMilestone(c.req.param("id"));
    if (!milestone) return c.json({ error: "Milestone not found" }, 404);
    return c.json({ milestone });
  });

  app.post("/api/milestones/:id/release", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      bumpVersion?: boolean;
      createTag?: boolean;
      pushRemote?: boolean;
    };
    const id = c.req.param("id");
    const existing = await kernel.getMilestone(id);
    if (!existing) return c.json({ error: "Milestone not found" }, 404);
    try {
      const milestone = await kernel.releaseMilestone(id, {
        bumpVersion: body.bumpVersion === true,
        createTag: body.createTag === true,
        pushRemote: body.pushRemote === true,
      });
      return c.json({ milestone });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });
}
