import { existsSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { nowIso } from "@super-work/core";
import type {
  ArtifactStore,
  HandoverDigest,
  KernelEvent,
  StateStore,
  SuperWorkKernel,
  Ticket,
  TicketStatus,
} from "@super-work/core";
import {
  CliEnvironmentScanner,
  MutableControlPlaneLLM,
  NotificationDispatcher,
  ServiceManager,
} from "@super-work/drivers";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { registerAutonomyRoutes } from "./routes/autonomy-routes.ts";
import type { ServerRouteContext } from "./routes/context.ts";
import { registerInboxOutboxRoutes } from "./routes/inbox-outbox-routes.ts";
import { registerMcpWebhookRoutes } from "./routes/mcp-webhook-routes.ts";
import { registerMilestoneRoutes } from "./routes/milestone-routes.ts";
import { registerRepoRoutes } from "./routes/repo-routes.ts";
import { registerSetupSystemRoutes } from "./routes/setup-system-routes.ts";
import { registerTicketRoutes } from "./routes/ticket-routes.ts";

export { maskApiKey, toPublicSetupStatus } from "./routes/context.ts";

export interface ServerAppDeps {
  kernel: SuperWorkKernel;
  stateStore: StateStore;
  artifactStore: ArtifactStore;
  llmProviderName?: string;
  mutableLlm?: MutableControlPlaneLLM;
  cliScanner?: CliEnvironmentScanner;
  notificationDispatcher?: NotificationDispatcher;
  serviceManager?: ServiceManager;
  authToken?: string;
  webDistDir?: string;
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
    case "eval_run_updated":
    case "campaign_updated":
    case "milestone_updated":
    case "merge_train_updated":
      return { repoId: event.repoId };
    case "lifecycle_hook_executed":
      return { repoId: event.repoId, ticketId: event.ticketId };
    case "self_reload_updated":
      return { ticketId: event.state.ticketId };
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
  const serviceManager = deps.serviceManager ?? new ServiceManager({ authToken: deps.authToken });
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

  const routeCtx: ServerRouteContext = {
    app,
    kernel,
    stateStore,
    artifactStore,
    scanner,
    notificationDispatcher,
    mutableLlm: deps.mutableLlm,
    getActiveProviderName,
    buildTicketDetail,
    serviceManager,
  };

  registerSetupSystemRoutes(routeCtx);
  registerRepoRoutes(routeCtx);
  registerTicketRoutes(routeCtx);
  registerInboxOutboxRoutes(routeCtx);
  registerAutonomyRoutes(routeCtx);
  registerMilestoneRoutes(routeCtx);
  registerMcpWebhookRoutes(routeCtx);

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
