import { newId } from "@super-work/core";
import type {
  CreateEpicInput,
  DagNodeMutationInput,
  DeliveryGatePolicy,
  EnginePreference,
  EpicDeliveryMode,
  PipelineTemplateId,
  ReasoningEffort,
  RepoConfig,
  RequirementIntakeInput,
  RestoreCheckpointInput,
  ReviewCommentStatus,
  SubmitReviewCommentsInput,
  TicketStatus,
  WorkerEngineId,
} from "@super-work/core";
import type { ServerRouteContext } from "./context.ts";

export function registerTicketRoutes(ctx: ServerRouteContext): void {
  const { app, kernel, stateStore, artifactStore, buildTicketDetail } = ctx;

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
      /** v1.8.1: pin a ModelProfile id (resolves preferredEngine/activeModelId). */
      preferredModelId?: string;
      arenaMode?: boolean;
      arenaCompetitorEngine?: WorkerEngineId;
      modelOverride?: string;
      effortOverride?: ReasoningEffort;
      acceptanceCriteria?: string[];
      refactorGuard?: {
        targetHotspotPath?: unknown;
        maxLinesAfter?: unknown;
        enforceExportParity?: unknown;
      };
    };

    if (!body.repoId || !body.title || !body.description) {
      return c.json({ error: "repoId, title, and description are required" }, 400);
    }

    const rawGuard = body.refactorGuard;
    const guardPath =
      typeof rawGuard?.targetHotspotPath === "string" ? rawGuard.targetHotspotPath.trim() : "";
    const refactorGuard = guardPath
      ? {
          targetHotspotPath: guardPath,
          maxLinesAfter:
            typeof rawGuard?.maxLinesAfter === "number" && rawGuard.maxLinesAfter > 0
              ? Math.floor(rawGuard.maxLinesAfter)
              : undefined,
          enforceExportParity:
            typeof rawGuard?.enforceExportParity === "boolean"
              ? rawGuard.enforceExportParity
              : undefined,
        }
      : undefined;

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
        preferredModelId: body.preferredModelId?.trim() || undefined,
        arenaMode: Boolean(body.arenaMode),
        arenaCompetitorEngine: body.arenaCompetitorEngine,
        modelOverride: body.modelOverride,
        effortOverride: body.effortOverride,
        acceptanceCriteria: body.acceptanceCriteria,
        refactorGuard,
      });

      void kernel.tick();
      return c.json({ ticket }, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 400);
    }
  });

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

  app.post("/api/tickets/:id/steer", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as {
      instruction?: string;
      preferredEngine?: EnginePreference;
      preferredModelId?: string;
    };
    if (!body.instruction?.trim()) {
      return c.json({ error: "instruction is required" }, 400);
    }
    try {
      const ticket = await kernel.steerTicket(id, {
        instruction: body.instruction.trim(),
        preferredEngine: body.preferredEngine,
        preferredModelId: body.preferredModelId?.trim() || undefined,
      });
      void kernel.tick();
      return c.json({ ticket });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.includes("not found") ? 404 : 400);
    }
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
        releaseBarrier: body.releaseBarrier,
        barrierGroupId: body.barrierGroupId,
        preferredEngine: body.preferredEngine,
        preferredModelId: body.preferredModelId?.trim() || undefined,
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

  // --- v1.3.0 Unified Smart Requirement Intake ---
  app.post("/api/intake/preview", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<RequirementIntakeInput>;
    if (!body.repoId || !body.requirement?.trim()) {
      return c.json({ error: "repoId and requirement are required" }, 400);
    }
    try {
      const plan = await kernel.previewRequirementIntake({
        repoId: body.repoId,
        requirement: body.requirement.trim(),
        title: body.title?.trim() || undefined,
        preferredRoute: body.preferredRoute,
        preferredEngine: body.preferredEngine,
        template: body.template,
        tddMode: body.tddMode,
        deliveryGatePolicy: body.deliveryGatePolicy,
        maxBudgetUsd: body.maxBudgetUsd,
        metricCommand: body.metricCommand,
        metricRegex: body.metricRegex,
        metricUnit: body.metricUnit,
        direction: body.direction,
        targetValue: body.targetValue,
      });
      return c.json({ plan });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.includes("Repository not found") ? 404 : 400);
    }
  });

  app.post("/api/intake", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<RequirementIntakeInput>;
    if (!body.repoId || !body.requirement?.trim()) {
      return c.json({ error: "repoId and requirement are required" }, 400);
    }
    try {
      const result = await kernel.intakeRequirement({
        repoId: body.repoId,
        requirement: body.requirement.trim(),
        title: body.title?.trim() || undefined,
        preferredRoute: body.preferredRoute,
        preferredEngine: body.preferredEngine,
        template: body.template,
        tddMode: body.tddMode,
        deliveryGatePolicy: body.deliveryGatePolicy,
        maxBudgetUsd: body.maxBudgetUsd,
        preferredModelId: body.preferredModelId?.trim() || undefined,
        previewOnly: Boolean(body.previewOnly),
        metricCommand: body.metricCommand,
        metricRegex: body.metricRegex,
        metricUnit: body.metricUnit,
        direction: body.direction,
        targetValue: body.targetValue,
        modelOverride: body.modelOverride,
        effortOverride: body.effortOverride,
      });
      if (!body.previewOnly) {
        void kernel.tick();
      }
      return c.json(result, body.previewOnly ? 200 : 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg.includes("Repository not found") ? 404 : 400);
    }
  });
}
