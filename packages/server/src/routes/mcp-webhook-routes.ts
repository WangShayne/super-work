import {
  handleMcpJsonRpcMessage,
  parseGithubWebhookEvent,
  verifyActionToken,
  verifyWebhookHmacSha256,
} from "@super-work/core";
import type {
  CampaignDeliveryMode,
  CampaignDirection,
  DagNodeMutationInput,
  DeliveryGatePolicy,
  EnginePreference,
  EpicDeliveryMode,
  InboxItemKind,
  InboxItemStatus,
  McpToolHost,
  PipelineTemplateId,
  RequirementIntakeInput,
  StageKind,
  SystemSetupConfig,
  TicketStatus,
  WorkerEngineId,
} from "@super-work/core";
import { type ServerRouteContext, escapeHtml } from "./context.ts";

export function registerMcpWebhookRoutes(ctx: ServerRouteContext): void {
  const { app, kernel, stateStore, getActiveProviderName, buildTicketDetail } = ctx;

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
      void kernel.flushOutbox();
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
    steerTicket: async (args) => {
      const ticket = await kernel.steerTicket(String(args.ticketId ?? ""), {
        instruction: String(args.instruction ?? ""),
        preferredEngine: args.preferredEngine as EnginePreference | undefined,
      });
      void kernel.tick();
      return { ticket };
    },
    batchResolveInbox: async (args) => {
      const res = await kernel.batchResolveInbox({
        inboxIds: Array.isArray(args.inboxIds) ? args.inboxIds.map(String) : undefined,
        repoId: args.repoId ? String(args.repoId) : undefined,
        kinds: Array.isArray(args.kinds) ? (args.kinds.map(String) as InboxItemKind[]) : undefined,
        onlyLowRisk: args.onlyLowRisk !== undefined ? Boolean(args.onlyLowRisk) : undefined,
        decision: args.decision === "rejected" ? "rejected" : "approved",
        note: args.note ? String(args.note) : undefined,
        deliveryAction: args.deliveryAction as "local_merge" | "push_and_create_pr" | undefined,
      });
      void kernel.tick();
      void kernel.flushOutbox();
      return res;
    },
    askChief: async (args) =>
      kernel.askChief({
        question: String(args.question ?? ""),
        repoId: args.repoId ? String(args.repoId) : undefined,
      }),
    manageEvals: async (args) => {
      const action = String(args.action ?? "list_cases");
      if (action === "list_cases") {
        return { cases: await kernel.listEvalCases(args.repoId ? String(args.repoId) : undefined) };
      }
      if (action === "save_from_ticket") {
        return { evalCase: await kernel.createEvalCaseFromTicket(String(args.ticketId ?? "")) };
      }
      if (action === "delete_case") {
        return { ok: await kernel.deleteEvalCase(String(args.evalCaseId ?? "")) };
      }
      if (action === "run") {
        return {
          evalRun: await kernel.runEvalCase({
            evalCaseId: String(args.evalCaseId ?? ""),
            engines: Array.isArray(args.engines)
              ? (args.engines.map(String) as WorkerEngineId[])
              : undefined,
            maxBudgetUsd:
              typeof args.maxBudgetUsd === "number" ? args.maxBudgetUsd : undefined,
          }),
        };
      }
      if (action === "list_runs") {
        return {
          runs: await kernel.listEvalRuns({
            repoId: args.repoId ? String(args.repoId) : undefined,
            evalCaseId: args.evalCaseId ? String(args.evalCaseId) : undefined,
          }),
        };
      }
      throw new Error(`Unknown eval action: ${action}`);
    },
    manageCampaigns: async (args) => {
      const action = String(args.action ?? "list");
      if (action === "list") {
        return { campaigns: await kernel.listCampaigns(args.repoId ? String(args.repoId) : undefined) };
      }
      if (action === "get") {
        const detail = await kernel.getCampaign(String(args.campaignId ?? ""));
        if (!detail) throw new Error(`Goal campaign not found: ${String(args.campaignId ?? "")}`);
        return detail;
      }
      if (action === "create") {
        const campaign = await kernel.createCampaign({
          repoId: String(args.repoId ?? ""),
          name: String(args.name ?? ""),
          goalPrompt: String(args.goalPrompt ?? ""),
          metricCommand: String(args.metricCommand ?? ""),
          metricRegex: args.metricRegex ? String(args.metricRegex) : undefined,
          metricUnit: args.metricUnit ? String(args.metricUnit) : undefined,
          direction: (args.direction === "increase" ? "increase" : "decrease") as CampaignDirection,
          targetValue: Number(args.targetValue ?? 0),
          deliveryMode: args.deliveryMode as CampaignDeliveryMode | undefined,
          allowedPaths: Array.isArray(args.allowedPaths)
            ? args.allowedPaths.map(String)
            : undefined,
          template: args.template as PipelineTemplateId | undefined,
          preferredEngine: args.preferredEngine as EnginePreference | undefined,
          maxIterations: typeof args.maxIterations === "number" ? args.maxIterations : undefined,
          maxTotalBudgetUsd:
            typeof args.maxTotalBudgetUsd === "number" ? args.maxTotalBudgetUsd : undefined,
          autoStart: args.autoStart !== undefined ? Boolean(args.autoStart) : undefined,
        });
        if (campaign.status === "running") {
          void kernel.tick();
        }
        return { campaign };
      }
      if (action === "start") {
        const campaign = await kernel.startCampaign(String(args.campaignId ?? ""), {
          note: args.note ? String(args.note) : undefined,
        });
        if (campaign.status === "running") {
          void kernel.tick();
        }
        return { campaign };
      }
      if (action === "pause") {
        return {
          campaign: await kernel.pauseCampaign(
            String(args.campaignId ?? ""),
            args.reason ? String(args.reason) : undefined,
          ),
        };
      }
      if (action === "deliver") {
        return {
          campaign: await kernel.deliverCampaign(
            String(args.campaignId ?? ""),
            args.deliveryAction === "push_and_create_pr" ? "push_and_create_pr" : "local_merge",
          ),
        };
      }
      if (action === "delete") {
        return { ok: await kernel.deleteCampaign(String(args.campaignId ?? "")) };
      }
      throw new Error(`Unknown campaign action: ${action}`);
    },
    manageMergeTrain: async (args) => {
      const action = String(args.action ?? "list");
      if (action === "list") {
        return {
          entries: await kernel.listMergeTrain(args.repoId ? String(args.repoId) : undefined),
        };
      }
      if (action === "flush") {
        return {
          mergedCount: await kernel.flushMergeTrain(args.repoId ? String(args.repoId) : undefined),
        };
      }
      if (action === "eject") {
        return {
          entry: await kernel.ejectMergeTrainEntry(
            String(args.entryId ?? ""),
            args.reason ? String(args.reason) : undefined,
          ),
        };
      }
      throw new Error(`Unknown merge train action: ${action}`);
    },
    dispatchRequirement: async (args) => {
      const res = await kernel.intakeRequirement({
        repoId: String(args.repoId ?? ""),
        requirement: String(args.requirement ?? ""),
        title: args.title ? String(args.title) : undefined,
        preferredRoute: args.preferredRoute as RequirementIntakeInput["preferredRoute"],
        preferredEngine: args.preferredEngine as EnginePreference | undefined,
        template: args.template as PipelineTemplateId | undefined,
        tddMode: args.tddMode !== undefined ? Boolean(args.tddMode) : undefined,
        deliveryGatePolicy: args.deliveryGatePolicy as DeliveryGatePolicy | undefined,
        maxBudgetUsd: typeof args.maxBudgetUsd === "number" ? args.maxBudgetUsd : undefined,
        previewOnly: Boolean(args.previewOnly),
        metricCommand: args.metricCommand ? String(args.metricCommand) : undefined,
        metricRegex: args.metricRegex ? String(args.metricRegex) : undefined,
        metricUnit: args.metricUnit ? String(args.metricUnit) : undefined,
        direction: args.direction as CampaignDirection | undefined,
        targetValue: typeof args.targetValue === "number" ? args.targetValue : undefined,
      });
      if (!args.previewOnly) {
        void kernel.tick();
      }
      return res;
    },
    manageSelfHost: async (args) => {
      const action = String(args.action ?? "status");
      if (action === "status") {
        return { reload: kernel.getSelfReloadState() };
      }
      if (action === "reload") {
        return {
          reload: await kernel.triggerSelfReload({
            force: Boolean(args.force),
            skipCanary: Boolean(args.skipCanary),
          }),
        };
      }
      throw new Error(`Unknown self-host action: ${action}`);
    },
    manageMilestones: async (args) => {
      const action = String(args.action ?? "list");
      if (action === "list") {
        return { milestones: await kernel.listMilestones(args.repoId ? String(args.repoId) : undefined) };
      }
      if (action === "get") {
        const milestone = await kernel.getMilestone(String(args.id ?? ""));
        if (!milestone) throw new Error(`Milestone not found: ${String(args.id ?? "")}`);
        return { milestone };
      }
      if (action === "create") {
        const milestone = await kernel.createMilestone({
          repoId: String(args.repoId ?? ""),
          name: String(args.name ?? ""),
          targetVersion: args.targetVersion ? String(args.targetVersion) : undefined,
          requirements: Array.isArray(args.requirements) ? args.requirements.map(String) : [],
          preferredEngine: args.preferredEngine as EnginePreference | undefined,
          template: args.template as PipelineTemplateId | undefined,
          maxBudgetUsdPerItem:
            typeof args.maxBudgetUsdPerItem === "number" ? args.maxBudgetUsdPerItem : undefined,
          integrationMode:
            args.integrationMode === "milestone_branch" || args.integrationMode === "direct_main"
              ? args.integrationMode
              : undefined,
          preferredRoute:
            args.preferredRoute === "auto" || args.preferredRoute === "single_ticket"
              ? args.preferredRoute
              : undefined,
        });
        return { milestone };
      }
      if (action === "release") {
        const milestone = await kernel.releaseMilestone(String(args.id ?? ""), {
          bumpVersion: args.bumpVersion === true,
          createTag: args.createTag === true,
          pushRemote: args.pushRemote === true,
          squashReleaseCommit: args.squashReleaseCommit === true,
          createGithubRelease: args.createGithubRelease === true,
          releaseCommitMessage:
            typeof args.releaseCommitMessage === "string" ? args.releaseCommitMessage : undefined,
        });
        return { milestone };
      }
      throw new Error(`Unknown milestone action: ${action}`);
    },
    manageEngineHealth: async (args) => {
      const action = String(args.action ?? "list");
      const engines = ["claude", "codex", "gemini", "opencode", "api", "mock"] as const;
      const engine = engines.find((e) => e === args.engine);
      if (args.engine && !engine) throw new Error(`Unknown engine: ${String(args.engine)}`);
      if (action === "list") return { engines: await kernel.listEngineHealth() };
      if (action === "reset") {
        if (!engine) throw new Error("engine is required for reset");
        return { engine: await kernel.resetEngineHealth(engine) };
      }
      if (action === "probe") {
        const probed = await kernel.reprobeEngineHealth(engine);
        return { probed, engines: await kernel.listEngineHealth() };
      }
      throw new Error(`Unknown engine health action: ${action}`);
    },
    managePlaybookHygiene: async (args) => {
      const action = String(args.action ?? "audit");
      const repoId = args.repoId ? String(args.repoId) : undefined;
      if (action === "audit") return { report: await kernel.auditPlaybookHygiene(repoId) };
      if (action === "prune") {
        if (args.mode !== undefined && args.mode !== "disable" && args.mode !== "delete") {
          throw new Error(`Invalid mode: ${String(args.mode)} (expected "disable" or "delete")`);
        }
        return kernel.pruneNoisyPlaybooks(repoId, {
          mode: args.mode === "delete" ? "delete" : "disable",
          dryRun: args.dryRun === true,
        });
      }
      throw new Error(`Unknown playbook hygiene action: ${action}`);
    },
    getRunDigest: async (args) => {
      const rawHours = Number(args.hours ?? 24);
      const hours = Number.isFinite(rawHours) ? Math.min(Math.max(rawHours, 0), 8760) : 24;
      return {
        digest: await kernel.getRunDigest({
          repoId: args.repoId ? String(args.repoId) : undefined,
          hours,
        }),
      };
    },
  });

  app.get("/api/mcp", (c) => {
    return c.json({
      name: "super-work",
      version: "1.8.1",
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
    void kernel.flushOutbox();

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
    void kernel.flushOutbox();
    return c.json({ ok: true, ...res });
  });
}
