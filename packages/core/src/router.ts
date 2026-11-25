import { applyBlueprintToTicketInput, resolveRepoBlueprints } from "./blueprints.ts";
import { classifyTaskCategory } from "./engine-router.ts";
import { heuristicDecomposeEpic, sanitizeEpicSubtasks } from "./epic.ts";
import {
  heuristicPlanRequirementIntake,
  normalizeRequirementIntakePlan,
  synthesizeRequirementTitle,
} from "./intake.ts";
import { createDefaultMandate, mandateScopesOverlap, matchesPathScope } from "./mandate.ts";
import { getFirstStage } from "./pipeline.ts";
import { formatPlaybookContext } from "./playbook.ts";
import type {
  ControlPlaneLLM,
  CreateEpicInput,
  DirectTicketInput,
  IngestTriggerInput,
  RepoProbeExecutor,
  StateStore,
} from "./ports.ts";
import type {
  ControlProbeRequest,
  ControlProbeStep,
  EpicDecompositionPlan,
  EpicDeliveryMode,
  InboxItem,
  KernelEvent,
  Mandate,
  PipelineTemplateId,
  RefactorGuardConfig,
  RepoConfig,
  RepoProbeContextPack,
  RequirementIntakeInput,
  RequirementIntakePlan,
  SymbolImpactReport,
  Thread,
  Ticket,
  TicketImpactSummary,
  Trigger,
} from "./types.ts";
import { isTerminalTicketStatus, newId, nowIso } from "./utils.ts";

export type IngestResult =
  | { action: "duplicate"; trigger: Trigger }
  | { action: "ignored_off"; trigger: Trigger; thread: Thread }
  | { action: "ignored_triage"; trigger: Trigger; thread: Thread; reason: string }
  | { action: "routed_to_ticket"; trigger: Trigger; thread: Thread; ticket: Ticket }
  | { action: "proposed"; trigger: Trigger; thread: Thread; ticket: Ticket; inboxItem: InboxItem }
  | { action: "queued"; trigger: Trigger; thread: Thread; ticket: Ticket };

export class EventIntakeRouter {
  constructor(
    private readonly stateStore: StateStore,
    private readonly llm: ControlPlaneLLM,
    private readonly emit: (event: KernelEvent) => void,
    private readonly repoStructureProvider?: (rootPath: string) => Promise<string>,
    private readonly symbolImpactProvider?: (
      rootPath: string,
      scopePatterns: string[],
    ) => Promise<SymbolImpactReport>,
    private readonly repoPreProbeProvider?: (
      rootPath: string,
      queryText: string,
      forbiddenPaths?: string[],
    ) => Promise<RepoProbeContextPack>,
    private readonly repoProbeToolProvider?: (
      rootPath: string,
      req: ControlProbeRequest,
      forbiddenPaths?: string[],
      stepIndex?: number,
    ) => Promise<ControlProbeStep>,
  ) {}

  private buildProbeExecutor(repo: RepoConfig): RepoProbeExecutor | undefined {
    const provider = this.repoProbeToolProvider;
    if (!provider) return undefined;
    let step = 0;
    return (req) => {
      step += 1;
      return provider(repo.rootPath, req, repo.forbiddenPaths, step);
    };
  }

  private async resolveRepoStructure(repo: RepoConfig): Promise<string | undefined> {
    if (!this.repoStructureProvider) return undefined;
    try {
      const summary = await this.repoStructureProvider(repo.rootPath);
      return summary || undefined;
    } catch {
      return undefined;
    }
  }

  async ingestTrigger(input: IngestTriggerInput): Promise<IngestResult> {
    const repo = await this.stateStore.getRepo(input.repoId);
    if (!repo) {
      throw new Error(`Repository not found: ${input.repoId}`);
    }

    if (input.externalRef) {
      const existing = await this.stateStore.findTriggerByExternalRef(repo.id, input.externalRef);
      if (existing) {
        return { action: "duplicate", trigger: existing };
      }
    }

    const ts = nowIso();
    const trigger: Trigger = {
      id: newId("trg"),
      repoId: repo.id,
      source: input.source,
      externalRef: input.externalRef,
      threadKey: input.threadKey,
      title: input.title,
      payload: input.payload ?? {},
      rawText: input.rawText,
      createdAt: ts,
    };
    await this.stateStore.saveTrigger(trigger);
    this.emit({ type: "trigger_ingested", trigger, timestamp: ts });

    let thread = await this.stateStore.getThreadByKey(repo.id, input.threadKey);
    if (!thread) {
      thread = {
        id: newId("thr"),
        repoId: repo.id,
        threadKey: input.threadKey,
        metadata: { source: input.source },
        createdAt: ts,
        updatedAt: ts,
      };
      await this.stateStore.upsertThread(thread);
    }

    if (repo.mode === "off") {
      return { action: "ignored_off", trigger, thread };
    }

    if (input.rawText.includes("[super-work]")) {
      return { action: "ignored_triage", trigger, thread, reason: "Ignored [super-work] bot message" };
    }

    // Bind unsubscribed github_pr / github_ci threads automatically by branch or PR number
    if (!thread.subscribedTicketId && (input.source === "github_pr" || input.source === "github_ci")) {
      const branchFromPayload =
        typeof input.payload?.branch === "string" ? input.payload.branch : undefined;
      const prNumFromPayload =
        typeof input.payload?.prNumber === "number" ? input.payload.prNumber : undefined;
      if (branchFromPayload || prNumFromPayload) {
        const repoTickets = await this.stateStore.listTickets({ repoId: repo.id });
        const matched = [...repoTickets]
          .reverse()
          .find(
            (t) =>
              t.status !== "cancelled" &&
              ((branchFromPayload && t.branchName === branchFromPayload) ||
                (prNumFromPayload && t.prNumber === prNumFromPayload)),
          );
        if (matched) {
          thread = {
            ...thread,
            subscribedTicketId: matched.id,
            updatedAt: ts,
          };
          await this.stateStore.upsertThread(thread);
        }
      }
    }

    // Thread Subscription: route follow-up events directly to the subscribed active or PR-linked ticket
    if (thread.subscribedTicketId) {
      const existingTicket = await this.stateStore.getTicket(thread.subscribedTicketId);
      if (existingTicket && !isTerminalTicketStatus(existingTicket.status)) {
        const updatedTicket: Ticket = {
          ...existingTicket,
          status:
            existingTicket.status === "needs_human"
              ? "queued"
              : existingTicket.status,
          prAutoFollowupCount:
            input.source === "web" ? 0 : existingTicket.prAutoFollowupCount,
          inlineMemory: {
            ...existingTicket.inlineMemory,
            threadUpdates: [
              ...existingTicket.inlineMemory.threadUpdates,
              {
                triggerId: trigger.id,
                message: trigger.rawText,
                createdAt: ts,
              },
            ],
            activeHint: trigger.rawText,
          },
          updatedAt: ts,
        };
        await this.stateStore.saveTicket(updatedTicket);
        await this.stateStore.indexMemoryDocument({
          entityType: "thread_update",
          entityId: trigger.id,
          ticketId: updatedTicket.id,
          repoId: repo.id,
          title: trigger.title,
          body: trigger.rawText,
        });

        this.emit({
          type: "thread_routed",
          ticketId: updatedTicket.id,
          triggerId: trigger.id,
          message: trigger.rawText,
          timestamp: ts,
        });
        this.emit({ type: "ticket_updated", ticket: updatedTicket, timestamp: ts });
        return { action: "routed_to_ticket", trigger, thread, ticket: updatedTicket };
      }

      const canFollowupDeliveredPr =
        existingTicket &&
        existingTicket.status === "delivered" &&
        (input.source === "github_pr" ||
          input.source === "github_ci" ||
          (input.source === "web" && Boolean(existingTicket.prNumber)));

      if (canFollowupDeliveredPr) {
        const threadUpdates = [
          ...existingTicket.inlineMemory.threadUpdates,
          {
            triggerId: trigger.id,
            message: trigger.rawText,
            createdAt: ts,
          },
        ];

        await this.stateStore.indexMemoryDocument({
          entityType: "thread_update",
          entityId: trigger.id,
          ticketId: existingTicket.id,
          repoId: repo.id,
          title: trigger.title,
          body: trigger.rawText,
        });

        if (input.source === "web") {
          const reopened: Ticket = {
            ...existingTicket,
            status: "queued",
            currentStage: "implement",
            stageRetries: 0,
            prAutoFollowupCount: 0,
            errorMessage: undefined,
            inlineMemory: {
              ...existingTicket.inlineMemory,
              threadUpdates,
              activeHint: trigger.rawText,
            },
            updatedAt: ts,
          };
          await this.stateStore.saveTicket(reopened);
          this.emit({
            type: "thread_routed",
            ticketId: reopened.id,
            triggerId: trigger.id,
            message: trigger.rawText,
            timestamp: ts,
          });
          this.emit({ type: "ticket_updated", ticket: reopened, timestamp: ts });
          return { action: "routed_to_ticket", trigger, thread, ticket: reopened };
        }

        const currentRounds = existingTicket.prAutoFollowupCount ?? 0;
        if (currentRounds >= 3) {
          const cappedTicket: Ticket = {
            ...existingTicket,
            status: "needs_human",
            errorMessage: "Reached max automatic PR follow-up rounds (3)",
            inlineMemory: {
              ...existingTicket.inlineMemory,
              threadUpdates,
            },
            updatedAt: ts,
          };
          await this.stateStore.saveTicket(cappedTicket);
          this.emit({ type: "ticket_updated", ticket: cappedTicket, timestamp: ts });

          const inboxItem: InboxItem = {
            id: newId("inb"),
            repoId: repo.id,
            ticketId: cappedTicket.id,
            kind: "watchdog_escalation",
            status: "pending",
            title: `Max PR follow-up rounds reached (3): ${cappedTicket.title}`,
            summary: `PR #${cappedTicket.prNumber ?? "?"} received new feedback after 3 automated follow-up rounds:\n${trigger.rawText}`,
            contextPayload: {
              triggerId: trigger.id,
              source: trigger.source,
              prNumber: cappedTicket.prNumber,
              branchName: cappedTicket.branchName,
            },
            createdAt: ts,
          };
          await this.stateStore.saveInboxItem(inboxItem);
          this.emit({ type: "inbox_created", item: inboxItem, timestamp: ts });
          return { action: "routed_to_ticket", trigger, thread, ticket: cappedTicket };
        }

        if (repo.mode === "observe") {
          const pausedTicket: Ticket = {
            ...existingTicket,
            status: "needs_human",
            errorMessage: `PR follow-up review/CI triggered: ${trigger.title}`,
            inlineMemory: {
              ...existingTicket.inlineMemory,
              threadUpdates,
              activeHint: trigger.rawText,
            },
            updatedAt: ts,
          };
          await this.stateStore.saveTicket(pausedTicket);
          this.emit({ type: "ticket_updated", ticket: pausedTicket, timestamp: ts });

          const inboxItem: InboxItem = {
            id: newId("inb"),
            repoId: repo.id,
            ticketId: pausedTicket.id,
            kind: "pr_followup",
            status: "pending",
            title: `PR Follow-up Needed: ${pausedTicket.title}`,
            summary: trigger.rawText,
            contextPayload: {
              triggerId: trigger.id,
              source: trigger.source,
              prNumber: pausedTicket.prNumber,
              branchName: pausedTicket.branchName,
            },
            createdAt: ts,
          };
          await this.stateStore.saveInboxItem(inboxItem);
          this.emit({ type: "inbox_created", item: inboxItem, timestamp: ts });
          return { action: "proposed", trigger, thread, ticket: pausedTicket, inboxItem };
        }

        // auto mode: reactivate the same branch/PR for lightweight fixup -> verify -> push + comment_pr
        const reactivated: Ticket = {
          ...existingTicket,
          status: "queued",
          currentStage: "implement",
          stageRetries: 0,
          prAutoFollowupCount: currentRounds + 1,
          errorMessage: undefined,
          inlineMemory: {
            ...existingTicket.inlineMemory,
            threadUpdates,
            activeHint: `Address GitHub PR feedback / CI failure on existing branch ${existingTicket.branchName ?? ""}:\n${trigger.rawText}`,
          },
          updatedAt: ts,
        };
        await this.stateStore.saveTicket(reactivated);
        this.emit({
          type: "thread_routed",
          ticketId: reactivated.id,
          triggerId: trigger.id,
          message: trigger.rawText,
          timestamp: ts,
        });
        this.emit({ type: "ticket_updated", ticket: reactivated, timestamp: ts });
        return { action: "routed_to_ticket", trigger, thread, ticket: reactivated };
      }
    }

    // New thread / unsubscribed event -> MasterAssessor triage via ControlPlaneLLM
    const activeTickets = await this.stateStore.listActiveTickets(repo.id);
    const relatedMemory = await this.stateStore.searchMemory(
      `${trigger.title} ${trigger.rawText}`,
      5,
      repo.id,
    );

    const [repoStructure, playbookEntries] = await Promise.all([
      this.resolveRepoStructure(repo),
      this.stateStore.listPlaybookEntries(repo.id, { onlyEnabled: true }),
    ]);
    const playbookRules = formatPlaybookContext(playbookEntries, ["**"]) || undefined;
    const rawCombined = `${trigger.title}\n${trigger.rawText}`;
    const hasExplicitPathLiteral =
      /scope:[^\s,;]+|(?:packages|src|apps|docs|test)\/[a-zA-Z0-9_./*-]+/i.test(rawCombined);
    const probeContext =
      !hasExplicitPathLiteral && this.repoPreProbeProvider
        ? await this.repoPreProbeProvider(
            repo.rootPath,
            rawCombined,
            repo.forbiddenPaths,
          ).catch(() => undefined)
        : undefined;
    const probeExecutor =
      !hasExplicitPathLiteral ? this.buildProbeExecutor(repo) : undefined;
    const proposal = await this.llm.triageTrigger({
      repo,
      trigger,
      activeTickets,
      relatedMemory,
      repoStructure,
      playbookRules,
      conventions: repo.conventions,
      probeContext,
      probeExecutor,
    });

    if (!proposal.shouldCreateTicket) {
      return { action: "ignored_triage", trigger, thread, reason: proposal.reason };
    }

    const mandate = createDefaultMandate({
      allowedPaths: proposal.allowedPaths.length > 0 ? proposal.allowedPaths : ["**"],
      forbiddenPaths: repo.forbiddenPaths ?? [],
    });
    const overlapDeps = this.computeOverlappingDependencies(mandate, activeTickets);
    const semantic = await this.computeSemanticDependencies(repo, mandate, activeTickets);
    const dependsOn = Array.from(new Set([...overlapDeps, ...semantic.semanticDepIds]));
    const template = proposal.template ?? repo.defaultTemplate;
    const tddMode = Boolean(repo.defaultTddMode);
    const isObserve = repo.mode === "observe";
    const ticketTitle = proposal.title || trigger.title;
    const ticketDesc = proposal.description || trigger.rawText;

    const ticket: Ticket = {
      id: newId("tkt"),
      repoId: repo.id,
      threadId: thread.id,
      sourceTriggerId: trigger.id,
      title: ticketTitle,
      description: ticketDesc,
      status: isObserve ? "proposed" : dependsOn.length > 0 ? "waiting_deps" : "queued",
      template,
      currentStage: getFirstStage(template, tddMode),
      stageRetries: 0,
      mandate,
      dependsOn,
      nativeSessions: {},
      tddMode: tddMode || undefined,
      deliveryGatePolicy: repo.deliveryGatePolicy,
      riskThreshold: repo.riskThreshold,
      taskCategory: classifyTaskCategory(ticketTitle, ticketDesc, mandate.allowedPaths),
      impactSummary: semantic.impactSummary,
      inlineMemory: {
        goal: ticketDesc,
        acceptanceCriteria: proposal.acceptanceCriteria,
        stageNotes: [],
        threadUpdates: semantic.transitiveWarnings.map((w) => ({
          triggerId: newId("imp"),
          message: w,
          createdAt: ts,
        })),
      },
      costUsd: 0,
      priority: proposal.priority ?? 1,
      createdAt: ts,
      updatedAt: ts,
    };

    await this.stateStore.saveTicket(ticket);
    thread = {
      ...thread,
      subscribedTicketId: ticket.id,
      updatedAt: ts,
    };
    await this.stateStore.upsertThread(thread);

    await this.stateStore.indexMemoryDocument({
      entityType: "ticket",
      entityId: ticket.id,
      ticketId: ticket.id,
      repoId: repo.id,
      title: ticket.title,
      body: `${ticket.description}\nAllowed: ${mandate.allowedPaths.join(", ")}`,
    });

    this.emit({ type: "ticket_created", ticket, timestamp: ts });

    if (isObserve) {
      const inboxItem: InboxItem = {
        id: newId("inb"),
        repoId: repo.id,
        ticketId: ticket.id,
        kind: "observe_proposal",
        status: "pending",
        title: `Proposed Ticket: ${ticket.title}`,
        summary: proposal.reason || `Observed ${trigger.source} trigger and proposed ${template} pipeline.`,
        contextPayload: {
          triggerId: trigger.id,
          source: trigger.source,
          template,
          allowedPaths: mandate.allowedPaths,
          dependsOn,
        },
        createdAt: ts,
      };
      await this.stateStore.saveInboxItem(inboxItem);
      this.emit({ type: "inbox_created", item: inboxItem, timestamp: ts });
      return { action: "proposed", trigger, thread, ticket, inboxItem };
    }

    return { action: "queued", trigger, thread, ticket };
  }

  async createDirectTicket(input: DirectTicketInput): Promise<Ticket> {
    const repo = await this.stateStore.getRepo(input.repoId);
    if (!repo) {
      throw new Error(`Repository not found: ${input.repoId}`);
    }

    let effectiveInput = input;
    if (input.blueprintId?.trim()) {
      const bpId = input.blueprintId.trim();
      const blueprint = resolveRepoBlueprints(repo).find((b) => b.id === bpId);
      if (!blueprint) {
        throw new Error(`Unknown Task Blueprint '${bpId}' for repository '${repo.name}'.`);
      }
      effectiveInput = applyBlueprintToTicketInput(input, blueprint);
    }

    const ts = nowIso();
    const threadKey = effectiveInput.threadKey ?? `web:${newId("task")}`;
    const trigger: Trigger = {
      id: newId("trg"),
      repoId: repo.id,
      source: "web",
      threadKey,
      title: effectiveInput.title,
      payload: {
        direct: true,
        ...(effectiveInput.blueprintId ? { blueprintId: effectiveInput.blueprintId } : {}),
      },
      rawText: effectiveInput.description,
      createdAt: ts,
    };
    await this.stateStore.saveTrigger(trigger);
    this.emit({ type: "trigger_ingested", trigger, timestamp: ts });

    const thread: Thread = {
      id: newId("thr"),
      repoId: repo.id,
      threadKey,
      metadata: {
        source: "web",
        ...(effectiveInput.startPoint ? { forkStartPoint: effectiveInput.startPoint } : {}),
      },
      createdAt: ts,
      updatedAt: ts,
    };
    await this.stateStore.upsertThread(thread);

    const mandate = createDefaultMandate({
      allowedPaths:
        effectiveInput.allowedPaths && effectiveInput.allowedPaths.length > 0
          ? effectiveInput.allowedPaths
          : ["**"],
      forbiddenPaths: [...(repo.forbiddenPaths ?? []), ...(effectiveInput.forbiddenPaths ?? [])],
      maxCostUsd: effectiveInput.maxCostUsd ?? 2.0,
      maxDurationSec: effectiveInput.maxDurationSec ?? 600,
    });

    const explicitDeps: string[] = [];
    let hasPendingDeps = false;
    for (const rawDepId of effectiveInput.dependsOn ?? []) {
      const depId = rawDepId.trim();
      if (!depId || explicitDeps.includes(depId)) continue;
      const depTicket = await this.stateStore.getTicket(depId);
      if (!depTicket) {
        throw new Error(`Dependency ticket not found: ${depId}`);
      }
      explicitDeps.push(depId);
      if (depTicket.status !== "delivered") {
        hasPendingDeps = true;
      }
    }

    const activeTickets = await this.stateStore.listActiveTickets(repo.id);
    const overlapDeps = this.computeOverlappingDependencies(mandate, activeTickets);
    const semantic = await this.computeSemanticDependencies(
      repo,
      mandate,
      activeTickets,
      effectiveInput.refactorGuard,
    );
    if (overlapDeps.length > 0 || semantic.semanticDepIds.length > 0) {
      hasPendingDeps = true;
    }
    const dependsOn = Array.from(
      new Set([...explicitDeps, ...overlapDeps, ...semantic.semanticDepIds]),
    );
    const template = effectiveInput.template ?? repo.defaultTemplate;
    const tddMode = effectiveInput.tddMode ?? repo.defaultTddMode ?? false;

    const ticket: Ticket = {
      id: newId("tkt"),
      repoId: repo.id,
      threadId: thread.id,
      sourceTriggerId: trigger.id,
      title: effectiveInput.title,
      description: effectiveInput.description,
      status: hasPendingDeps ? "waiting_deps" : "queued",
      template,
      currentStage: getFirstStage(template, tddMode),
      stageRetries: 0,
      mandate,
      dependsOn,
      nativeSessions: {},
      preferredEngine: effectiveInput.preferredEngine,
      activeEngine:
        effectiveInput.preferredEngine && effectiveInput.preferredEngine !== "auto"
          ? effectiveInput.preferredEngine
          : undefined,
      campaignId: effectiveInput.campaignId,
      milestoneId: effectiveInput.milestoneId,
      campaignWave: effectiveInput.campaignWave,
      targetBranch: effectiveInput.targetBranch,
      barrierGroupId: effectiveInput.barrierGroupId,
      arenaMode: effectiveInput.arenaMode || undefined,
      arenaCompetitorEngine: effectiveInput.arenaCompetitorEngine,
      blueprintId: effectiveInput.blueprintId,
      deliveryGatePolicy: effectiveInput.deliveryGatePolicy ?? repo.deliveryGatePolicy,
      riskThreshold: effectiveInput.riskThreshold ?? repo.riskThreshold,
      tddMode: tddMode || undefined,
      refactorGuard: effectiveInput.refactorGuard?.targetHotspotPath
        ? effectiveInput.refactorGuard
        : undefined,
      pauseBeforeRun: effectiveInput.pauseBeforeRun || undefined,
      taskCategory: classifyTaskCategory(effectiveInput.title, effectiveInput.description, mandate.allowedPaths),
      impactSummary: semantic.impactSummary,
      modelOverride: effectiveInput.modelOverride?.trim() || undefined,
      effortOverride: effectiveInput.effortOverride,
      inlineMemory: {
        goal: effectiveInput.description,
        acceptanceCriteria: effectiveInput.acceptanceCriteria ?? [],
        stageNotes: [],
        threadUpdates: semantic.transitiveWarnings.map((w) => ({
          triggerId: newId("imp"),
          message: w,
          createdAt: ts,
        })),
      },
      costUsd: 0,
      priority: 1,
      createdAt: ts,
      updatedAt: ts,
    };

    await this.stateStore.saveTicket(ticket);
    await this.stateStore.upsertThread({
      ...thread,
      subscribedTicketId: ticket.id,
      updatedAt: ts,
    });

    await this.stateStore.indexMemoryDocument({
      entityType: "ticket",
      entityId: ticket.id,
      ticketId: ticket.id,
      repoId: repo.id,
      title: ticket.title,
      body: `${ticket.description}\nAllowed: ${mandate.allowedPaths.join(", ")}`,
    });

    this.emit({ type: "ticket_created", ticket, timestamp: ts });
    return ticket;
  }

  async previewEpic(input: {
    repoId: string;
    title: string;
    description: string;
    template?: PipelineTemplateId;
  }): Promise<EpicDecompositionPlan> {
    const repo = await this.stateStore.getRepo(input.repoId);
    if (!repo) {
      throw new Error(`Repository not found: ${input.repoId}`);
    }
    const defaultTemplate = input.template ?? repo.defaultTemplate;
    const [allRepos, repoStructure, playbookEntries] = await Promise.all([
      this.stateStore.listRepos(),
      this.resolveRepoStructure(repo),
      this.stateStore.listPlaybookEntries(repo.id, { onlyEnabled: true }),
    ]);

    const availableRepos =
      allRepos.length > 1
        ? await Promise.all(
            allRepos.map(async (r) => ({
              id: r.id,
              name: r.name,
              structure: r.id === repo.id ? repoStructure : await this.resolveRepoStructure(r),
            })),
          )
        : [{ id: repo.id, name: repo.name, structure: repoStructure }];
    const sanitizeOpts = {
      validRepoIds: new Set(allRepos.map((r) => r.id)),
      repoIdByName: new Map(allRepos.map((r) => [r.name.toLowerCase(), r.id])),
      defaultRepoId: repo.id,
    };

    const playbookRules = formatPlaybookContext(playbookEntries, ["**"]) || undefined;
    const probeContext = this.repoPreProbeProvider
      ? await this.repoPreProbeProvider(
          repo.rootPath,
          `${input.title}\n${input.description}`,
          repo.forbiddenPaths,
        ).catch(() => undefined)
      : undefined;
    const probeExecutor = this.buildProbeExecutor(repo);
    if (this.llm.planEpicDecomposition) {
      const plan = await this.llm.planEpicDecomposition({
        repo,
        title: input.title,
        description: input.description,
        defaultTemplate,
        repoStructure,
        playbookRules,
        conventions: repo.conventions,
        availableRepos,
        probeContext,
        probeExecutor,
      });
      return {
        ...plan,
        subtasks: sanitizeEpicSubtasks(plan.subtasks, defaultTemplate, sanitizeOpts),
      };
    }
    return heuristicDecomposeEpic({
      repo,
      title: input.title,
      description: input.description,
      defaultTemplate,
      repoStructure,
      availableRepos,
    });
  }

  async previewRequirementIntake(input: RequirementIntakeInput): Promise<RequirementIntakePlan> {
    const repo = await this.stateStore.getRepo(input.repoId);
    if (!repo) {
      throw new Error(`Repository not found: ${input.repoId}`);
    }
    const defaultTemplate = input.template ?? repo.defaultTemplate;
    const defaultTddMode = input.tddMode ?? repo.defaultTddMode ?? false;
    const title = synthesizeRequirementTitle(input.requirement, input.title);

    const [allRepos, repoStructure, playbookEntries] = await Promise.all([
      this.stateStore.listRepos(),
      this.resolveRepoStructure(repo),
      this.stateStore.listPlaybookEntries(repo.id, { onlyEnabled: true }),
    ]);

    const availableRepos =
      allRepos.length > 1
        ? await Promise.all(
            allRepos.map(async (r) => ({
              id: r.id,
              name: r.name,
              structure: r.id === repo.id ? repoStructure : await this.resolveRepoStructure(r),
            })),
          )
        : [{ id: repo.id, name: repo.name, structure: repoStructure }];

    const playbookRules = formatPlaybookContext(playbookEntries, ["**"]) || undefined;
    const probeContext = this.repoPreProbeProvider
      ? await this.repoPreProbeProvider(
          repo.rootPath,
          `${title}\n${input.requirement}`,
          repo.forbiddenPaths,
        ).catch(() => undefined)
      : undefined;
    const probeExecutor = this.buildProbeExecutor(repo);

    const metricHint =
      input.metricCommand?.trim() || input.targetValue !== undefined
        ? {
            metricCommand: input.metricCommand?.trim(),
            targetValue: input.targetValue,
            direction: input.direction,
            metricUnit: input.metricUnit,
            metricRegex: input.metricRegex,
          }
        : undefined;

    const fallbackInput = {
      repo,
      title,
      requirement: input.requirement,
      preferredRoute: input.preferredRoute,
      defaultTemplate,
      defaultTddMode,
      maxBudgetUsd: input.maxBudgetUsd,
      repoStructure,
      availableRepos,
      probeContext,
      metricHint,
    };

    if (this.llm.planRequirementIntake) {
      try {
        const llmPlan = await this.llm.planRequirementIntake({
          repo,
          title,
          requirement: input.requirement,
          defaultTemplate,
          defaultTddMode,
          repoStructure,
          playbookRules,
          conventions: repo.conventions,
          availableRepos,
          probeContext,
          probeExecutor,
          metricHint,
        });
        return normalizeRequirementIntakePlan(llmPlan, fallbackInput);
      } catch {
        // Fallback to deterministic intake planner on LLM error
      }
    }

    return heuristicPlanRequirementIntake(fallbackInput);
  }

  async createEpic(input: CreateEpicInput): Promise<{ epic: Ticket; subtasks: Ticket[] }> {
    const repo = await this.stateStore.getRepo(input.repoId);
    if (!repo) {
      throw new Error(`Repository not found: ${input.repoId}`);
    }

    const allRepos = await this.stateStore.listRepos();
    const reposById = new Map(allRepos.map((r) => [r.id, r]));
    reposById.set(repo.id, repo);
    const sanitizeOpts = {
      validRepoIds: new Set(reposById.keys()),
      repoIdByName: new Map(Array.from(reposById.values()).map((r) => [r.name.toLowerCase(), r.id])),
      defaultRepoId: repo.id,
    };

    const defaultTemplate = input.template ?? repo.defaultTemplate;
    const plan =
      input.subtasks && input.subtasks.length > 0
        ? {
            epicTitle: input.title,
            summary: `Epic decomposed into ${input.subtasks.length} subtask(s).`,
            subtasks: sanitizeEpicSubtasks(input.subtasks, defaultTemplate, sanitizeOpts),
          }
        : await this.previewEpic({
            repoId: repo.id,
            title: input.title,
            description: input.description,
            template: defaultTemplate,
          });

    const distinctRepoIds = new Set(
      plan.subtasks.map((s) => (s.repoId && reposById.has(s.repoId) ? s.repoId : repo.id)),
    );
    const isCrossRepoEpic = distinctRepoIds.size > 1 || !distinctRepoIds.has(repo.id);
    const deliveryMode: EpicDeliveryMode = isCrossRepoEpic
      ? "per_subtask"
      : (input.epicDeliveryMode ?? "unified");

    const ts = nowIso();
    const epicId = newId("epc");
    const barrierGroupId =
      input.barrierGroupId?.trim() ||
      (isCrossRepoEpic && input.releaseBarrier !== false
        ? epicId
        : input.releaseBarrier
          ? epicId
          : undefined);
    const threadKey = `epic:${epicId}`;
    const trigger: Trigger = {
      id: newId("trg"),
      repoId: repo.id,
      source: "web",
      threadKey,
      title: input.title,
      payload: {
        epic: true,
        epicDeliveryMode: deliveryMode,
        crossRepo: isCrossRepoEpic,
        repoIds: Array.from(distinctRepoIds),
      },
      rawText: input.description,
      createdAt: ts,
    };
    await this.stateStore.saveTrigger(trigger);
    this.emit({ type: "trigger_ingested", trigger, timestamp: ts });

    const epicThread: Thread = {
      id: newId("thr"),
      repoId: repo.id,
      threadKey,
      metadata: { source: "web", epic: true, epicDeliveryMode: deliveryMode, crossRepo: isCrossRepoEpic },
      createdAt: ts,
      updatedAt: ts,
    };
    await this.stateStore.upsertThread(epicThread);

    const epic: Ticket = {
      id: epicId,
      repoId: repo.id,
      threadId: epicThread.id,
      sourceTriggerId: trigger.id,
      title: input.title,
      description: input.description,
      status: "implementing",
      template: defaultTemplate,
      currentStage: "implement",
      stageRetries: 0,
      mandate: createDefaultMandate({
        allowedPaths: ["**"],
        forbiddenPaths: repo.forbiddenPaths ?? [],
        maxCostUsd: (input.maxCostUsdPerSubtask ?? 2.0) * Math.max(1, plan.subtasks.length),
      }),
      dependsOn: [],
      isEpic: true,
      epicDeliveryMode: deliveryMode,
      barrierGroupId,
      branchName: deliveryMode === "unified" ? `super-work/epic/${epicId}` : undefined,
      nativeSessions: {},
      preferredEngine: input.preferredEngine,
      tddMode: (input.tddMode ?? repo.defaultTddMode) || undefined,
      taskCategory: classifyTaskCategory(input.title, input.description, ["**"]),
      inlineMemory: {
        goal: input.description,
        acceptanceCriteria: plan.subtasks.map((s) => `[${s.key}] ${s.title}`),
        planSummary: `${plan.summary}\n${plan.subtasks
          .map((s) => {
            const rName = s.repoId ? (reposById.get(s.repoId)?.name ?? s.repoId) : repo.name;
            return `- ${s.key} (${rName}): ${s.title} (${s.allowedPaths.join(", ")})`;
          })
          .join("\n")}`,
        stageNotes: [],
        threadUpdates: [],
      },
      costUsd: 0,
      priority: 1,
      createdAt: ts,
      updatedAt: ts,
    };
    await this.stateStore.saveTicket(epic);
    await this.stateStore.upsertThread({
      ...epicThread,
      subscribedTicketId: epic.id,
      updatedAt: ts,
    });
    this.emit({ type: "ticket_created", ticket: epic, timestamp: ts });

    const createdByKey = new Map<string, Ticket>();
    const subtasks: Ticket[] = [];
    const activeByRepo = new Map<string, Ticket[]>();

    for (const spec of plan.subtasks) {
      const targetRepo = (spec.repoId ? reposById.get(spec.repoId) : undefined) ?? repo;
      let activeBefore = activeByRepo.get(targetRepo.id);
      if (!activeBefore) {
        activeBefore = (await this.stateStore.listActiveTickets(targetRepo.id)).filter(
          (t) => !t.isEpic,
        );
        activeByRepo.set(targetRepo.id, activeBefore);
      }

      const subTs = nowIso();
      const subThreadKey = `${threadKey}:${spec.key}`;
      const subThread: Thread = {
        id: newId("thr"),
        repoId: targetRepo.id,
        threadKey: subThreadKey,
        metadata: { source: "web", epicId: epic.id, subtaskKey: spec.key, repoId: targetRepo.id },
        createdAt: subTs,
        updatedAt: subTs,
      };
      await this.stateStore.upsertThread(subThread);

      const subMandate = createDefaultMandate({
        allowedPaths: spec.allowedPaths,
        forbiddenPaths: targetRepo.forbiddenPaths ?? [],
        maxCostUsd: input.maxCostUsdPerSubtask ?? 2.0,
      });

      const explicitDeps = spec.dependsOnKeys
        .map((k) => createdByKey.get(k)?.id)
        .filter((id): id is string => Boolean(id));
      const sameRepoPriorSubtasks = subtasks.filter(
        (existing) => existing.repoId === targetRepo.id && !explicitDeps.includes(existing.id),
      );
      const sameRepoAll = [...activeBefore, ...sameRepoPriorSubtasks];
      const existingOverlapDeps = this.computeOverlappingDependencies(subMandate, sameRepoAll);
      const semantic = await this.computeSemanticDependencies(targetRepo, subMandate, sameRepoAll);
      const dependsOn = Array.from(
        new Set([...explicitDeps, ...existingOverlapDeps, ...semantic.semanticDepIds]),
      );
      const subTddMode = spec.tddMode ?? input.tddMode ?? targetRepo.defaultTddMode ?? false;
      const subPreferredEngine = spec.preferredEngine ?? input.preferredEngine;

      const subTicket: Ticket = {
        id: newId("tkt"),
        repoId: targetRepo.id,
        threadId: subThread.id,
        sourceTriggerId: trigger.id,
        title: spec.title,
        description: spec.description,
        status: dependsOn.length > 0 ? "waiting_deps" : "queued",
        template: spec.template,
        currentStage: getFirstStage(spec.template, subTddMode),
        stageRetries: 0,
        mandate: subMandate,
        dependsOn,
        parentTicketId: epic.id,
        isEpic: false,
        subtaskKey: spec.key,
        barrierGroupId,
        nativeSessions: {},
        preferredEngine: subPreferredEngine,
        activeEngine:
          subPreferredEngine && subPreferredEngine !== "auto" ? subPreferredEngine : undefined,
        tddMode: subTddMode || undefined,
        taskCategory: classifyTaskCategory(spec.title, spec.description, subMandate.allowedPaths),
        impactSummary: semantic.impactSummary,
        modelOverride: input.modelOverride?.trim() || undefined,
        effortOverride: input.effortOverride,
        inlineMemory: {
          goal: spec.description,
          acceptanceCriteria: spec.acceptanceCriteria,
          stageNotes: [],
          threadUpdates: semantic.transitiveWarnings.map((w) => ({
            triggerId: newId("imp"),
            message: w,
            createdAt: subTs,
          })),
        },
        costUsd: 0,
        priority: 1,
        createdAt: subTs,
        updatedAt: subTs,
      };

      await this.stateStore.saveTicket(subTicket);
      await this.stateStore.upsertThread({
        ...subThread,
        subscribedTicketId: subTicket.id,
        updatedAt: subTs,
      });
      await this.stateStore.indexMemoryDocument({
        entityType: "ticket",
        entityId: subTicket.id,
        ticketId: subTicket.id,
        repoId: targetRepo.id,
        title: subTicket.title,
        body: `${subTicket.description}\nAllowed: ${subMandate.allowedPaths.join(", ")}`,
      });
      this.emit({ type: "ticket_created", ticket: subTicket, timestamp: subTs });

      createdByKey.set(spec.key, subTicket);
      subtasks.push(subTicket);
    }

    return { epic, subtasks };
  }

  async resolveDependenciesForWaitingTickets(repo: RepoConfig): Promise<Ticket[]> {
    const waiting = await this.stateStore.listTickets({ repoId: repo.id, status: "waiting_deps" });
    const unblocked: Ticket[] = [];

    for (const ticket of waiting) {
      if (ticket.parentTicketId) {
        const parentEpic = await this.stateStore.getTicket(ticket.parentTicketId);
        if (parentEpic?.pendingEpicReplan) {
          continue;
        }
      }

      if (ticket.dependsOn.length === 0) {
        const next = { ...ticket, status: "queued" as const, updatedAt: nowIso() };
        await this.stateStore.saveTicket(next);
        this.emit({ type: "ticket_updated", ticket: next, timestamp: next.updatedAt });
        unblocked.push(next);
        continue;
      }

      let allDelivered = true;
      let failedDep: Ticket | null = null;
      for (const depId of ticket.dependsOn) {
        const dep = await this.stateStore.getTicket(depId);
        if (!dep || dep.status === "failed" || dep.status === "cancelled") {
          failedDep = dep;
          allDelivered = false;
          break;
        }
        const barrierReady = Boolean(
          ticket.barrierGroupId &&
            dep.barrierGroupId === ticket.barrierGroupId &&
            dep.status === "outbox_pending" &&
            dep.handoverDigest,
        );
        if (dep.status !== "delivered" && !barrierReady) {
          allDelivered = false;
        }
      }

      if (failedDep) {
        const blocked = {
          ...ticket,
          status: "needs_human" as const,
          errorMessage: `Dependency ticket ${failedDep.id} (${failedDep.title}) ended with status ${failedDep.status}`,
          updatedAt: nowIso(),
        };
        await this.stateStore.saveTicket(blocked);
        this.emit({ type: "ticket_updated", ticket: blocked, timestamp: blocked.updatedAt });

        const inboxItem: InboxItem = {
          id: newId("inb"),
          repoId: ticket.repoId,
          ticketId: ticket.id,
          kind: "watchdog_escalation",
          status: "pending",
          title: `Dependency failed for ${ticket.title}`,
          summary: blocked.errorMessage,
          contextPayload: { failedDependencyId: failedDep.id },
          createdAt: nowIso(),
        };
        await this.stateStore.saveInboxItem(inboxItem);
        this.emit({ type: "inbox_created", item: inboxItem, timestamp: inboxItem.createdAt });
      } else if (allDelivered) {
        const ready = { ...ticket, status: "queued" as const, updatedAt: nowIso() };
        await this.stateStore.saveTicket(ready);
        this.emit({ type: "ticket_updated", ticket: ready, timestamp: ready.updatedAt });
        unblocked.push(ready);
      }
    }

    return unblocked;
  }

  private async computeSemanticDependencies(
    repo: RepoConfig,
    mandate: Mandate,
    activeTickets: Ticket[],
    refactorGuard?: RefactorGuardConfig,
  ): Promise<{
    semanticDepIds: string[];
    impactSummary?: TicketImpactSummary;
    transitiveWarnings: string[];
  }> {
    if (!this.symbolImpactProvider || mandate.allowedPaths.includes("**")) {
      return { semanticDepIds: [], transitiveWarnings: [] };
    }
    let report: SymbolImpactReport;
    try {
      report = await this.symbolImpactProvider(repo.rootPath, mandate.allowedPaths);
    } catch {
      return { semanticDepIds: [], transitiveWarnings: [] };
    }
    if (report.targetFiles.length === 0) {
      return { semanticDepIds: [], transitiveWarnings: [] };
    }

    const semanticDepIds: string[] = [];
    const transitiveWarnings: string[] = [];

    for (const active of activeTickets) {
      if (active.status === "proposed" || active.isEpic) continue;
      if (active.mandate.allowedPaths.includes("**")) continue;
      // Export-preserving refactors on disjoint scopes run truly concurrently (no semantic serialization).
      if (refactorGuard?.enforceExportParity === true && !mandateScopesOverlap(mandate, active.mandate)) {
        continue;
      }

      const matchesDirect =
        report.directDependents.some((f) => matchesPathScope(f, active.mandate.allowedPaths)) ||
        (active.impactSummary?.directDependents ?? []).some((f) =>
          matchesPathScope(f, mandate.allowedPaths),
        );
      if (matchesDirect) {
        semanticDepIds.push(active.id);
        continue;
      }

      const matchesTransitive =
        report.transitiveDependents.some((f) => matchesPathScope(f, active.mandate.allowedPaths)) ||
        (active.impactSummary?.transitiveDependents ?? []).some((f) =>
          matchesPathScope(f, mandate.allowedPaths),
        );
      if (matchesTransitive) {
        transitiveWarnings.push(
          `Transitive (>1 hop) symbol impact with active ticket ${active.id} (${active.title})`,
        );
      }
    }

    const impactSummary: TicketImpactSummary = {
      directDependents: report.directDependents.slice(0, 20),
      transitiveDependents: report.transitiveDependents.slice(0, 20),
      semanticDepTicketIds: semanticDepIds,
    };

    return { semanticDepIds, impactSummary, transitiveWarnings };
  }

  private computeOverlappingDependencies(mandate: Mandate, activeTickets: Ticket[]): string[] {
    const deps: string[] = [];
    for (const active of activeTickets) {
      if (active.status === "proposed" || active.isEpic) continue;
      if (mandateScopesOverlap(mandate, active.mandate)) {
        deps.push(active.id);
      }
    }
    return deps;
  }
}
