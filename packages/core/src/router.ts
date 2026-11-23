import { heuristicDecomposeEpic, sanitizeEpicSubtasks } from "./epic.ts";
import { createDefaultMandate, mandateScopesOverlap } from "./mandate.ts";
import { getFirstStage } from "./pipeline.ts";
import type {
  ControlPlaneLLM,
  CreateEpicInput,
  DirectTicketInput,
  IngestTriggerInput,
  StateStore,
} from "./ports.ts";
import type {
  EpicDecompositionPlan,
  InboxItem,
  KernelEvent,
  Mandate,
  PipelineTemplateId,
  RepoConfig,
  Thread,
  Ticket,
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
  ) {}

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

    // Thread Subscription: route follow-up events directly to the subscribed active ticket
    if (thread.subscribedTicketId) {
      const existingTicket = await this.stateStore.getTicket(thread.subscribedTicketId);
      if (existingTicket && !isTerminalTicketStatus(existingTicket.status)) {
        const updatedTicket: Ticket = {
          ...existingTicket,
          status:
            existingTicket.status === "needs_human"
              ? "queued"
              : existingTicket.status,
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
    }

    // New thread / unsubscribed event -> MasterAssessor triage via ControlPlaneLLM
    const activeTickets = await this.stateStore.listActiveTickets(repo.id);
    const relatedMemory = await this.stateStore.searchMemory(
      `${trigger.title} ${trigger.rawText}`,
      5,
      repo.id,
    );

    const proposal = await this.llm.triageTrigger({
      repo,
      trigger,
      activeTickets,
      relatedMemory,
    });

    if (!proposal.shouldCreateTicket) {
      return { action: "ignored_triage", trigger, thread, reason: proposal.reason };
    }

    const mandate = createDefaultMandate({
      allowedPaths: proposal.allowedPaths.length > 0 ? proposal.allowedPaths : ["**"],
    });
    const dependsOn = this.computeOverlappingDependencies(mandate, activeTickets);
    const template = proposal.template ?? repo.defaultTemplate;
    const isObserve = repo.mode === "observe";

    const ticket: Ticket = {
      id: newId("tkt"),
      repoId: repo.id,
      threadId: thread.id,
      sourceTriggerId: trigger.id,
      title: proposal.title || trigger.title,
      description: proposal.description || trigger.rawText,
      status: isObserve ? "proposed" : dependsOn.length > 0 ? "waiting_deps" : "queued",
      template,
      currentStage: getFirstStage(template),
      stageRetries: 0,
      mandate,
      dependsOn,
      nativeSessions: {},
      inlineMemory: {
        goal: proposal.description || trigger.rawText,
        acceptanceCriteria: proposal.acceptanceCriteria,
        stageNotes: [],
        threadUpdates: [],
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

    const ts = nowIso();
    const threadKey = input.threadKey ?? `web:${newId("task")}`;
    const trigger: Trigger = {
      id: newId("trg"),
      repoId: repo.id,
      source: "web",
      threadKey,
      title: input.title,
      payload: { direct: true },
      rawText: input.description,
      createdAt: ts,
    };
    await this.stateStore.saveTrigger(trigger);
    this.emit({ type: "trigger_ingested", trigger, timestamp: ts });

    const thread: Thread = {
      id: newId("thr"),
      repoId: repo.id,
      threadKey,
      metadata: { source: "web" },
      createdAt: ts,
      updatedAt: ts,
    };
    await this.stateStore.upsertThread(thread);

    const mandate = createDefaultMandate({
      allowedPaths: input.allowedPaths && input.allowedPaths.length > 0 ? input.allowedPaths : ["**"],
      forbiddenPaths: input.forbiddenPaths ?? [],
      maxCostUsd: input.maxCostUsd ?? 2.0,
      maxDurationSec: input.maxDurationSec ?? 600,
    });

    const activeTickets = await this.stateStore.listActiveTickets(repo.id);
    const dependsOn = this.computeOverlappingDependencies(mandate, activeTickets);
    const template = input.template ?? repo.defaultTemplate;

    const ticket: Ticket = {
      id: newId("tkt"),
      repoId: repo.id,
      threadId: thread.id,
      sourceTriggerId: trigger.id,
      title: input.title,
      description: input.description,
      status: dependsOn.length > 0 ? "waiting_deps" : "queued",
      template,
      currentStage: getFirstStage(template),
      stageRetries: 0,
      mandate,
      dependsOn,
      nativeSessions: {},
      preferredEngine: input.preferredEngine,
      activeEngine: input.preferredEngine,
      modelOverride: input.modelOverride?.trim() || undefined,
      effortOverride: input.effortOverride,
      inlineMemory: {
        goal: input.description,
        acceptanceCriteria: input.acceptanceCriteria ?? [],
        stageNotes: [],
        threadUpdates: [],
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
    if (this.llm.planEpicDecomposition) {
      const plan = await this.llm.planEpicDecomposition({
        repo,
        title: input.title,
        description: input.description,
        defaultTemplate,
      });
      return {
        ...plan,
        subtasks: sanitizeEpicSubtasks(plan.subtasks, defaultTemplate),
      };
    }
    return heuristicDecomposeEpic({
      repo,
      title: input.title,
      description: input.description,
      defaultTemplate,
    });
  }

  async createEpic(input: CreateEpicInput): Promise<{ epic: Ticket; subtasks: Ticket[] }> {
    const repo = await this.stateStore.getRepo(input.repoId);
    if (!repo) {
      throw new Error(`Repository not found: ${input.repoId}`);
    }

    const defaultTemplate = input.template ?? repo.defaultTemplate;
    const plan =
      input.subtasks && input.subtasks.length > 0
        ? {
            epicTitle: input.title,
            summary: `Epic decomposed into ${input.subtasks.length} subtask(s).`,
            subtasks: sanitizeEpicSubtasks(input.subtasks, defaultTemplate),
          }
        : await this.previewEpic({
            repoId: repo.id,
            title: input.title,
            description: input.description,
            template: defaultTemplate,
          });

    const ts = nowIso();
    const threadKey = `epic:${newId("epc")}`;
    const trigger: Trigger = {
      id: newId("trg"),
      repoId: repo.id,
      source: "web",
      threadKey,
      title: input.title,
      payload: { epic: true },
      rawText: input.description,
      createdAt: ts,
    };
    await this.stateStore.saveTrigger(trigger);
    this.emit({ type: "trigger_ingested", trigger, timestamp: ts });

    const epicThread: Thread = {
      id: newId("thr"),
      repoId: repo.id,
      threadKey,
      metadata: { source: "web", epic: true },
      createdAt: ts,
      updatedAt: ts,
    };
    await this.stateStore.upsertThread(epicThread);

    const epicId = newId("epc");
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
        maxCostUsd: (input.maxCostUsdPerSubtask ?? 2.0) * Math.max(1, plan.subtasks.length),
      }),
      dependsOn: [],
      isEpic: true,
      nativeSessions: {},
      preferredEngine: input.preferredEngine,
      inlineMemory: {
        goal: input.description,
        acceptanceCriteria: plan.subtasks.map((s) => `[${s.key}] ${s.title}`),
        planSummary: `${plan.summary}\n${plan.subtasks
          .map((s) => `- ${s.key}: ${s.title} (${s.allowedPaths.join(", ")})`)
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
    const activeBefore = (await this.stateStore.listActiveTickets(repo.id)).filter(
      (t) => !t.isEpic,
    );

    for (const spec of plan.subtasks) {
      const subTs = nowIso();
      const subThreadKey = `${threadKey}:${spec.key}`;
      const subThread: Thread = {
        id: newId("thr"),
        repoId: repo.id,
        threadKey: subThreadKey,
        metadata: { source: "web", epicId: epic.id, subtaskKey: spec.key },
        createdAt: subTs,
        updatedAt: subTs,
      };
      await this.stateStore.upsertThread(subThread);

      const subMandate = createDefaultMandate({
        allowedPaths: spec.allowedPaths,
        maxCostUsd: input.maxCostUsdPerSubtask ?? 2.0,
      });

      const explicitDeps = spec.dependsOnKeys
        .map((k) => createdByKey.get(k)?.id)
        .filter((id): id is string => Boolean(id));
      const existingOverlapDeps = this.computeOverlappingDependencies(subMandate, [
        ...activeBefore,
        ...subtasks.filter((existing) => !explicitDeps.includes(existing.id)),
      ]);
      const dependsOn = Array.from(new Set([...explicitDeps, ...existingOverlapDeps]));

      const subTicket: Ticket = {
        id: newId("tkt"),
        repoId: repo.id,
        threadId: subThread.id,
        sourceTriggerId: trigger.id,
        title: spec.title,
        description: spec.description,
        status: dependsOn.length > 0 ? "waiting_deps" : "queued",
        template: spec.template,
        currentStage: getFirstStage(spec.template),
        stageRetries: 0,
        mandate: subMandate,
        dependsOn,
        parentTicketId: epic.id,
        isEpic: false,
        subtaskKey: spec.key,
        nativeSessions: {},
        preferredEngine: input.preferredEngine,
        activeEngine: input.preferredEngine,
        modelOverride: input.modelOverride?.trim() || undefined,
        effortOverride: input.effortOverride,
        inlineMemory: {
          goal: spec.description,
          acceptanceCriteria: spec.acceptanceCriteria,
          stageNotes: [],
          threadUpdates: [],
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
        repoId: repo.id,
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
        if (dep.status !== "delivered") {
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
