import { validateChangedFilesAgainstMandate } from "./mandate.ts";
import { MemoryManager } from "./memory.ts";
import { OutboxProcessor } from "./outbox.ts";
import {
  getAlternateEngine,
  getFirstStage,
  getNextStage,
  getPipelineTemplate,
  selectEngineForStage,
  statusForStage,
} from "./pipeline.ts";
import type {
  ArtifactStore,
  ControlPlaneLLM,
  DirectTicketInput,
  IngestTriggerInput,
  KernelConfig,
  OutboxExecutor,
  StateStore,
  WorkerDriver,
  WorkspaceProvider,
} from "./ports.ts";
import { EventIntakeRouter, type IngestResult } from "./router.ts";
import type {
  InboxItem,
  KernelEvent,
  OutboxEntry,
  RepoConfig,
  StageKind,
  StageRun,
  Ticket,
  WatchdogDecision,
  WatchdogSignal,
  WorkerEngineId,
  WorkerStreamEvent,
} from "./types.ts";
import { newId, nowIso } from "./utils.ts";
import { DEFAULT_WATCHDOG_CONFIG, TwoTierWatchdog } from "./watchdog.ts";

export const DEFAULT_KERNEL_CONFIG: KernelConfig = {
  maxConcurrentWorkers: 4,
  schedulerIntervalMs: 1_000,
  outboxIntervalMs: 2_000,
  outboxMaxAttempts: 5,
  watchdog: DEFAULT_WATCHDOG_CONFIG,
};

export interface SuperWorkKernelDeps {
  stateStore: StateStore;
  artifactStore: ArtifactStore;
  workspace: WorkspaceProvider;
  llm: ControlPlaneLLM;
  drivers: WorkerDriver[];
  outboxExecutor: OutboxExecutor;
  config?: Partial<KernelConfig>;
}

export class SuperWorkKernel {
  readonly config: KernelConfig;
  readonly stateStore: StateStore;
  readonly artifactStore: ArtifactStore;
  readonly workspace: WorkspaceProvider;
  readonly memory: MemoryManager;
  readonly router: EventIntakeRouter;
  readonly watchdog: TwoTierWatchdog;
  readonly outbox: OutboxProcessor;

  private readonly drivers = new Map<WorkerEngineId, WorkerDriver>();
  private readonly listeners = new Set<(event: KernelEvent) => void>();
  private readonly activeTicketRuns = new Map<string, Promise<void>>();
  private readonly abortControllers = new Map<string, AbortController>();

  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private outboxTimer: ReturnType<typeof setInterval> | null = null;
  private isTicking = false;
  private stopped = false;

  constructor(deps: SuperWorkKernelDeps) {
    this.config = {
      ...DEFAULT_KERNEL_CONFIG,
      ...deps.config,
      watchdog: { ...DEFAULT_WATCHDOG_CONFIG, ...deps.config?.watchdog },
    };
    this.stateStore = deps.stateStore;
    this.artifactStore = deps.artifactStore;
    this.workspace = deps.workspace;

    for (const driver of deps.drivers) {
      this.drivers.set(driver.engine, driver);
    }

    const emit = (event: KernelEvent) => this.emitEvent(event);
    this.memory = new MemoryManager(deps.stateStore, deps.artifactStore);
    this.router = new EventIntakeRouter(deps.stateStore, deps.llm, emit);
    this.watchdog = new TwoTierWatchdog(deps.llm, this.config.watchdog);
    this.outbox = new OutboxProcessor(
      deps.stateStore,
      deps.outboxExecutor,
      emit,
      this.config.outboxMaxAttempts,
    );
  }

  subscribe(listener: (event: KernelEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitEvent(event: KernelEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Isolate subscriber exceptions from the kernel loop
      }
    }
  }

  async getAvailableEngines(): Promise<WorkerEngineId[]> {
    const available: WorkerEngineId[] = [];
    for (const [engine, driver] of this.drivers.entries()) {
      try {
        if (await driver.isAvailable()) {
          available.push(engine);
        }
      } catch {
        // Treat probe errors as unavailable
      }
    }
    return available;
  }

  start(): void {
    this.stopped = false;
    if (!this.schedulerTimer) {
      this.schedulerTimer = setInterval(() => {
        void this.tick();
      }, this.config.schedulerIntervalMs);
    }
    if (!this.outboxTimer) {
      this.outboxTimer = setInterval(() => {
        void this.outbox.processDueEntries();
      }, this.config.outboxIntervalMs);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    if (this.outboxTimer) {
      clearInterval(this.outboxTimer);
      this.outboxTimer = null;
    }
    for (const ctrl of this.abortControllers.values()) {
      ctrl.abort("kernel_shutdown");
    }
    await Promise.allSettled(Array.from(this.activeTicketRuns.values()));
  }

  async ingestTrigger(input: IngestTriggerInput): Promise<IngestResult> {
    const result = await this.router.ingestTrigger(input);
    return result;
  }

  async createDirectTicket(input: DirectTicketInput): Promise<Ticket> {
    return this.router.createDirectTicket(input);
  }

  async sendThreadMessage(ticketId: string, message: string): Promise<Ticket> {
    const ticket = await this.stateStore.getTicket(ticketId);
    if (!ticket) throw new Error(`Ticket not found: ${ticketId}`);
    const thread = await this.stateStore.getThread(ticket.threadId);
    if (!thread) throw new Error(`Thread not found: ${ticket.threadId}`);

    const res = await this.router.ingestTrigger({
      repoId: ticket.repoId,
      source: "web",
      threadKey: thread.threadKey,
      title: `Follow-up on ${ticket.title}`,
      rawText: message,
    });

    if (res.action === "routed_to_ticket") {
      return res.ticket;
    }
    return (await this.stateStore.getTicket(ticketId)) ?? ticket;
  }

  async cancelTicket(ticketId: string, reason = "Cancelled by user"): Promise<Ticket> {
    const ctrl = this.abortControllers.get(ticketId);
    if (ctrl) {
      ctrl.abort("cancelled_by_user");
    }
    const ticket = await this.stateStore.getTicket(ticketId);
    if (!ticket) throw new Error(`Ticket not found: ${ticketId}`);

    const updated: Ticket = {
      ...ticket,
      status: "cancelled",
      errorMessage: reason,
      updatedAt: nowIso(),
    };
    await this.stateStore.saveTicket(updated);
    this.emitEvent({ type: "ticket_updated", ticket: updated, timestamp: updated.updatedAt });
    return updated;
  }

  async resolveInboxItem(
    inboxId: string,
    decision: "approved" | "rejected",
    note?: string,
  ): Promise<{ item: InboxItem; ticket: Ticket }> {
    const item = await this.stateStore.getInboxItem(inboxId);
    if (!item) throw new Error(`Inbox item not found: ${inboxId}`);
    if (item.status !== "pending") {
      throw new Error(`Inbox item ${inboxId} is already ${item.status}`);
    }

    const ticket = await this.stateStore.getTicket(item.ticketId);
    if (!ticket) throw new Error(`Ticket not found for inbox item: ${item.ticketId}`);

    const ts = nowIso();
    const resolvedItem: InboxItem = {
      ...item,
      status: decision,
      resolutionNote: note,
      resolvedAt: ts,
    };
    await this.stateStore.saveInboxItem(resolvedItem);
    this.emitEvent({ type: "inbox_resolved", item: resolvedItem, timestamp: ts });

    let nextTicket = { ...ticket, updatedAt: ts };

    if (item.kind === "observe_proposal") {
      if (decision === "approved") {
        const hasPendingDeps = await this.hasUnfinishedDependencies(ticket);
        nextTicket = {
          ...nextTicket,
          status: hasPendingDeps ? "waiting_deps" : "queued",
          currentStage: getFirstStage(ticket.template),
          inlineMemory: {
            ...nextTicket.inlineMemory,
            activeHint: note || nextTicket.inlineMemory.activeHint,
          },
        };
      } else {
        nextTicket = { ...nextTicket, status: "cancelled", errorMessage: note ?? "Proposal rejected" };
      }
    } else if (item.kind === "plan_approval") {
      if (decision === "approved") {
        nextTicket = {
          ...nextTicket,
          status: "queued",
          currentStage: "implement",
          inlineMemory: {
            ...nextTicket.inlineMemory,
            activeHint: note || nextTicket.inlineMemory.activeHint,
          },
        };
      } else if (note) {
        nextTicket = {
          ...nextTicket,
          status: "queued",
          currentStage: "plan",
          inlineMemory: {
            ...nextTicket.inlineMemory,
            activeHint: `Plan rejected with feedback: ${note}`,
          },
        };
      } else {
        nextTicket = { ...nextTicket, status: "cancelled", errorMessage: "Plan rejected" };
      }
    } else if (item.kind === "outbox_signoff") {
      const outboxId = item.contextPayload.outboxId as string | undefined;
      const entries = outboxId
        ? [await this.stateStore.getOutboxEntry(outboxId)].filter((x): x is OutboxEntry => x !== null)
        : await this.stateStore.listOutboxEntries({ ticketId: ticket.id, status: "awaiting_approval" });

      for (const entry of entries) {
        const updatedEntry: OutboxEntry = {
          ...entry,
          status: decision === "approved" ? "pending" : "cancelled",
          nextAttemptAt: ts,
          updatedAt: ts,
        };
        await this.stateStore.updateOutboxEntry(updatedEntry);
        if (decision === "approved") {
          this.emitEvent({ type: "outbox_queued", entry: updatedEntry, timestamp: ts });
        }
      }
      if (decision === "rejected") {
        nextTicket = { ...nextTicket, status: "cancelled", errorMessage: note ?? "PR sign-off rejected" };
      }
    } else {
      // watchdog_escalation, mandate_violation, merge_conflict
      if (decision === "approved") {
        nextTicket = {
          ...nextTicket,
          status: "queued",
          stageRetries: 0,
          errorMessage: undefined,
          inlineMemory: {
            ...nextTicket.inlineMemory,
            activeHint: note ?? "Human approved continuation; proceed carefully within Mandate.",
          },
        };
      } else {
        nextTicket = { ...nextTicket, status: "cancelled", errorMessage: note ?? "Escalation rejected" };
      }
    }

    await this.stateStore.saveTicket(nextTicket);
    this.emitEvent({ type: "ticket_updated", ticket: nextTicket, timestamp: ts });
    return { item: resolvedItem, ticket: nextTicket };
  }

  async tick(): Promise<void> {
    if (this.stopped || this.isTicking) return;
    this.isTicking = true;
    try {
      const repos = await this.stateStore.listRepos();
      for (const repo of repos) {
        await this.router.resolveDependenciesForWaitingTickets(repo);
      }

      const capacity = this.config.maxConcurrentWorkers - this.activeTicketRuns.size;
      if (capacity <= 0) return;

      const queued = await this.stateStore.listTickets({ status: "queued" });
      const candidates = queued
        .filter((t) => !this.activeTicketRuns.has(t.id))
        .slice(0, capacity);

      for (const ticket of candidates) {
        const promise = this.runTicketStage(ticket.id).finally(() => {
          this.activeTicketRuns.delete(ticket.id);
          this.abortControllers.delete(ticket.id);
        });
        this.activeTicketRuns.set(ticket.id, promise);
      }
    } finally {
      this.isTicking = false;
    }
  }

  async runUntilIdle(maxCycles = 30): Promise<void> {
    for (let i = 0; i < maxCycles; i++) {
      await this.tick();
      if (this.activeTicketRuns.size > 0) {
        await Promise.allSettled(Array.from(this.activeTicketRuns.values()));
      }
      await this.outbox.processDueEntries();

      const waiting = await this.stateStore.listTickets({ status: "waiting_deps" });
      const queued = await this.stateStore.listTickets({ status: "queued" });
      const pendingOutbox = await this.stateStore.listOutboxEntries({ status: "pending" });
      if (
        this.activeTicketRuns.size === 0 &&
        queued.length === 0 &&
        pendingOutbox.length === 0 &&
        waiting.length === 0
      ) {
        break;
      }
      if (
        this.activeTicketRuns.size === 0 &&
        queued.length === 0 &&
        pendingOutbox.length === 0 &&
        waiting.length > 0
      ) {
        // Check if any waiting ticket can still unblock; if none are runnable, stop looping
        let canUnblock = false;
        for (const w of waiting) {
          if (!(await this.hasUnfinishedDependencies(w))) {
            canUnblock = true;
            break;
          }
        }
        if (!canUnblock) break;
      }
    }
  }

  private async hasUnfinishedDependencies(ticket: Ticket): Promise<boolean> {
    for (const depId of ticket.dependsOn) {
      const dep = await this.stateStore.getTicket(depId);
      if (!dep || dep.status !== "delivered") {
        return true;
      }
    }
    return false;
  }

  private async runTicketStage(ticketId: string): Promise<void> {
    let ticket = await this.stateStore.getTicket(ticketId);
    if (!ticket || ticket.status !== "queued") return;

    const repo = await this.stateStore.getRepo(ticket.repoId);
    if (!repo) return;

    const stage = ticket.currentStage || getFirstStage(ticket.template);
    const availableEngines = await this.getAvailableEngines();
    const chosenEngine = selectEngineForStage(repo, stage, ticket.activeEngine);
    const driver =
      this.drivers.get(chosenEngine) ??
      (availableEngines[0] ? this.drivers.get(availableEngines[0]) : undefined);

    if (!driver) {
      await this.escalateTicket(ticket, "watchdog_escalation", `No WorkerDriver available for engine '${chosenEngine}'`, {
        chosenEngine,
      });
      return;
    }

    // Prepare isolated worktree workspace
    const ws = await this.workspace.prepareWorkspace(ticket, repo);
    const stageRun: StageRun = {
      id: newId("run"),
      ticketId: ticket.id,
      stage,
      engine: driver.engine,
      status: "running",
      nativeSessionId: ticket.nativeSessions[driver.engine],
      costUsd: 0,
      startedAt: nowIso(),
    };

    ticket = {
      ...ticket,
      status: statusForStage(stage),
      currentStage: stage,
      activeEngine: driver.engine,
      worktreePath: ws.worktreePath,
      branchName: ws.branchName,
      updatedAt: nowIso(),
    };
    await this.stateStore.saveTicket(ticket);
    await this.stateStore.saveStageRun(stageRun);
    this.emitEvent({ type: "ticket_updated", ticket, timestamp: ticket.updatedAt });
    this.emitEvent({ type: "stage_started", ticketId: ticket.id, stageRun, timestamp: stageRun.startedAt });

    // For rebase stage: attempt rebase onto baseBranch first; only run worker if conflict needs resolution!
    if (stage === "rebase") {
      await this.handleRebaseStage(ticket, repo, stageRun);
      return;
    }

    const relatedMemory = await this.stateStore.searchMemory(ticket.title, 4, repo.id);
    const prompt = this.memory.buildWorkerPromptContext(ticket, stage, relatedMemory);

    const existingSessionId = ticket.nativeSessions[driver.engine];
    const abortController = new AbortController();
    this.abortControllers.set(ticket.id, abortController);

    const tracker = this.watchdog.createTracker(stageRun, ticket.mandate);
    const collectedEvents: WorkerStreamEvent[] = [];
    let completedEvent: Extract<WorkerStreamEvent, { type: "completed" }> | null = null;
    let watchdogDecision: WatchdogDecision | null = null;
    let watchdogSignal: WatchdogSignal | null = null;
    let discoveredSessionId = existingSessionId;
    let stageCostUsd = 0;

    const triggerWatchdogCheck = async (): Promise<boolean> => {
      if (abortController.signal.aborted || watchdogDecision) return false;
      const sig = this.watchdog.evaluateL1(tracker);
      if (!sig) return false;

      watchdogSignal = sig;
      this.emitEvent({ type: "watchdog_signal", signal: sig, timestamp: nowIso() });

      const decision = await this.watchdog.evaluateAndDecide({
        ticket,
        stageRun,
        signal: sig,
        recentEvents: tracker.recentEvents,
        availableEngines,
      });
      this.emitEvent({
        type: "watchdog_decision",
        ticketId: ticket.id,
        stageRunId: stageRun.id,
        decision,
        timestamp: nowIso(),
      });

      if (decision.action === "CONTINUE") {
        tracker.lastEventAtMs = Date.now();
        tracker.consecutiveErrorCount = 0;
        return false;
      }

      watchdogDecision = decision;
      abortController.abort(`watchdog_${decision.action}`);
      return true;
    };

    const l1Timer = setInterval(() => {
      void triggerWatchdogCheck();
    }, this.config.watchdog.pollIntervalMs);

    try {
      const stream = driver.runTurn(
        {
          ticketId: ticket.id,
          stageRunId: stageRun.id,
          stage,
          worktreePath: ws.worktreePath,
          prompt,
          mandate: ticket.mandate,
          nativeSessionId: existingSessionId,
          isResume: Boolean(existingSessionId),
        },
        abortController.signal,
      );

      for await (const event of stream) {
        collectedEvents.push(event);
        this.emitEvent({
          type: "worker_event",
          ticketId: ticket.id,
          stageRunId: stageRun.id,
          engine: driver.engine,
          event,
          timestamp: event.timestamp,
        });

        this.watchdog.recordEvent(tracker, event);

        if (event.type === "session_started") {
          discoveredSessionId = event.nativeSessionId;
        } else if (event.type === "usage") {
          stageCostUsd = Math.max(stageCostUsd, event.costUsd);
        } else if (event.type === "completed") {
          completedEvent = event;
          if (typeof event.costUsd === "number") {
            stageCostUsd = Math.max(stageCostUsd, event.costUsd);
          }
        } else if (event.type === "tool_result" && stage === "implement") {
          // Track worktree diff snapshots for A -> B -> A oscillation detection
          try {
            const diffText = await this.workspace.getDiff(ws.worktreePath, repo.baseBranch);
            const changed = await this.workspace.getChangedFiles(ws.worktreePath, repo.baseBranch);
            const hash = new Bun.CryptoHasher("sha256").update(diffText).digest("hex").slice(0, 12);
            this.watchdog.recordDiffCheckpoint(tracker, hash, changed.length > 0);
          } catch {
            // Non-fatal during streaming
          }
        }

        if (await triggerWatchdogCheck()) {
          break;
        }
      }
    } catch (err) {
      if (!abortController.signal.aborted) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const errEvent: WorkerStreamEvent = {
          type: "error",
          message: errMsg,
          fatal: true,
          timestamp: nowIso(),
        };
        collectedEvents.push(errEvent);
        this.watchdog.recordEvent(tracker, errEvent);
        await triggerWatchdogCheck();
      }
    } finally {
      clearInterval(l1Timer);
    }

    // Re-read ticket in case external cancellation happened mid-turn
    const latestTicket = await this.stateStore.getTicket(ticket.id);
    if (latestTicket && latestTicket.status === "cancelled") {
      await this.stateStore.saveStageRun({
        ...stageRun,
        status: "aborted",
        nativeSessionId: discoveredSessionId,
        costUsd: stageCostUsd,
        completedAt: nowIso(),
        summary: "Cancelled by user",
      });
      return;
    }

    if (this.stopped) {
      await this.stateStore.saveStageRun({
        ...stageRun,
        status: "aborted",
        nativeSessionId: discoveredSessionId,
        costUsd: stageCostUsd,
        completedAt: nowIso(),
        summary: "Aborted on kernel shutdown",
      });
      await this.stateStore.saveTicket({
        ...ticket,
        status: "queued",
        costUsd: ticket.costUsd + stageCostUsd,
        updatedAt: nowIso(),
      });
      return;
    }

    // Handle Watchdog intervention if triggered
    if (watchdogDecision) {
      const dec: WatchdogDecision = watchdogDecision;
      const sig: WatchdogSignal | null = watchdogSignal;
      const abortedRun: StageRun = {
        ...stageRun,
        status: "aborted",
        nativeSessionId: discoveredSessionId,
        costUsd: stageCostUsd,
        completedAt: nowIso(),
        summary: `Watchdog ${dec.action}: ${dec.reason}`,
      };
      await this.memory.recordStageSpillAndNote({
        ticket,
        stageRun: abortedRun,
        events: collectedEvents,
        changedFiles: [],
        summary: abortedRun.summary!,
        verificationPassed: false,
      });

      if (dec.action === "INJECT_HINT") {
        const nextTicket: Ticket = {
          ...ticket,
          status: "queued",
          stageRetries: ticket.stageRetries + 1,
          costUsd: ticket.costUsd + stageCostUsd,
          nativeSessions: discoveredSessionId
            ? { ...ticket.nativeSessions, [driver.engine]: discoveredSessionId }
            : ticket.nativeSessions,
          inlineMemory: {
            ...ticket.inlineMemory,
            activeHint: dec.hint ?? dec.reason,
          },
          updatedAt: nowIso(),
        };
        await this.stateStore.saveStageRun(abortedRun);
        await this.stateStore.saveTicket(nextTicket);
        this.emitEvent({ type: "ticket_updated", ticket: nextTicket, timestamp: nextTicket.updatedAt });
        return;
      }

      if (dec.action === "SWITCH_ENGINE") {
        const altEngine =
          dec.targetEngine && dec.targetEngine !== driver.engine
            ? dec.targetEngine
            : getAlternateEngine(driver.engine, availableEngines);
        if (altEngine) {
          const nextTicket: Ticket = {
            ...ticket,
            status: "queued",
            activeEngine: altEngine,
            stageRetries: ticket.stageRetries + 1,
            costUsd: ticket.costUsd + stageCostUsd,
            inlineMemory: {
              ...ticket.inlineMemory,
              activeHint: dec.hint ?? `Switched from ${driver.engine} to ${altEngine} due to: ${dec.reason}`,
            },
            updatedAt: nowIso(),
          };
          await this.stateStore.saveStageRun(abortedRun);
          await this.stateStore.saveTicket(nextTicket);
          this.emitEvent({ type: "ticket_updated", ticket: nextTicket, timestamp: nextTicket.updatedAt });
          return;
        }
      }

      await this.stateStore.saveStageRun(abortedRun);
      await this.escalateTicket(
        { ...ticket, costUsd: ticket.costUsd + stageCostUsd },
        "watchdog_escalation",
        dec.reason,
        { signal: sig, decision: dec },
      );
      return;
    }

    // Check if turn failed without completion
    const lastErrorEvent = [...collectedEvents].reverse().find((e) => e.type === "error");
    if (!completedEvent && lastErrorEvent && lastErrorEvent.type === "error") {
      const failedRun: StageRun = {
        ...stageRun,
        status: "failed",
        nativeSessionId: discoveredSessionId,
        costUsd: stageCostUsd,
        completedAt: nowIso(),
        summary: lastErrorEvent.message,
      };
      await this.stateStore.saveStageRun(failedRun);
      await this.memory.recordStageSpillAndNote({
        ticket,
        stageRun: failedRun,
        events: collectedEvents,
        changedFiles: [],
        summary: lastErrorEvent.message,
        verificationPassed: false,
      });

      if (ticket.stageRetries < ticket.mandate.maxStageRetries) {
        const retried: Ticket = {
          ...ticket,
          status: "queued",
          stageRetries: ticket.stageRetries + 1,
          costUsd: ticket.costUsd + stageCostUsd,
          inlineMemory: {
            ...ticket.inlineMemory,
            activeHint: `Previous ${stage} attempt errored (${lastErrorEvent.message}). Fix and retry.`,
          },
          updatedAt: nowIso(),
        };
        await this.stateStore.saveTicket(retried);
        this.emitEvent({ type: "ticket_updated", ticket: retried, timestamp: retried.updatedAt });
      } else {
        await this.escalateTicket(
          { ...ticket, costUsd: ticket.costUsd + stageCostUsd },
          "watchdog_escalation",
          `Stage ${stage} failed: ${lastErrorEvent.message}`,
          { stageRunId: stageRun.id },
        );
      }
      return;
    }

    // Post-turn Mandate Guardrail via Git Diff
    const changedFiles = await this.workspace.getChangedFiles(ws.worktreePath, repo.baseBranch);
    const diffText = await this.workspace.getDiff(ws.worktreePath, repo.baseBranch);
    const mandateCheck = validateChangedFilesAgainstMandate(changedFiles, ticket.mandate);

    if (!mandateCheck.ok) {
      await this.workspace.revertPaths(ws.worktreePath, mandateCheck.violations);
      const abortedRun: StageRun = {
        ...stageRun,
        status: "failed",
        nativeSessionId: discoveredSessionId,
        costUsd: stageCostUsd,
        completedAt: nowIso(),
        summary: `Mandate violation on paths: ${mandateCheck.violations.join(", ")}`,
      };
      await this.stateStore.saveStageRun(abortedRun);
      await this.memory.recordStageSpillAndNote({
        ticket,
        stageRun: abortedRun,
        events: collectedEvents,
        changedFiles: mandateCheck.violations,
        diffText,
        summary: abortedRun.summary!,
        verificationPassed: false,
      });
      await this.escalateTicket(
        { ...ticket, costUsd: ticket.costUsd + stageCostUsd },
        "mandate_violation",
        `Worker attempted to modify forbidden or out-of-scope paths: ${mandateCheck.violations.join(", ")} (changes reverted)`,
        { violations: mandateCheck.violations },
      );
      return;
    }

    // Extract text summary
    const textChunks = collectedEvents
      .filter((e): e is Extract<WorkerStreamEvent, { type: "text" }> => e.type === "text")
      .map((e) => e.text)
      .join("\n");
    const summary = completedEvent?.summary || textChunks || `${stage} completed`;

    let reviewApproved: boolean | undefined;
    if (stage === "review") {
      if (typeof completedEvent?.structuredOutput?.approved === "boolean") {
        reviewApproved = completedEvent.structuredOutput.approved;
      } else {
        reviewApproved = !/verdict:\s*rejected/i.test(summary);
      }
    }

    const finishedRun: StageRun = {
      ...stageRun,
      status: "completed",
      nativeSessionId: discoveredSessionId,
      costUsd: stageCostUsd,
      completedAt: nowIso(),
      summary,
    };

    const { note } = await this.memory.recordStageSpillAndNote({
      ticket,
      stageRun: finishedRun,
      events: collectedEvents,
      changedFiles,
      diffText,
      summary,
      verificationPassed: completedEvent?.structuredOutput?.verificationPassed ?? true,
      reviewApproved,
    });
    finishedRun.spillTranscriptId = note.spillArtifactIds[0];
    await this.stateStore.saveStageRun(finishedRun);
    this.emitEvent({
      type: "stage_completed",
      ticketId: ticket.id,
      stageRun: finishedRun,
      note,
      timestamp: finishedRun.completedAt!,
    });

    const updatedSessions = discoveredSessionId
      ? { ...ticket.nativeSessions, [driver.engine]: discoveredSessionId }
      : ticket.nativeSessions;

    const updatedMemory = {
      ...ticket.inlineMemory,
      planSummary:
        stage === "plan"
          ? completedEvent?.structuredOutput?.planSummary || summary
          : ticket.inlineMemory.planSummary,
      stageNotes: [...ticket.inlineMemory.stageNotes, note],
      activeHint: undefined,
    };

    const template = getPipelineTemplate(ticket.template);

    // Stage transitions
    if (stage === "plan") {
      if (template.requirePlanApproval) {
        const awaitingTicket: Ticket = {
          ...ticket,
          status: "awaiting_plan_approval",
          costUsd: ticket.costUsd + stageCostUsd,
          nativeSessions: updatedSessions,
          activeEngine: undefined,
          inlineMemory: updatedMemory,
          updatedAt: nowIso(),
        };
        await this.stateStore.saveTicket(awaitingTicket);
        this.emitEvent({ type: "ticket_updated", ticket: awaitingTicket, timestamp: awaitingTicket.updatedAt });

        const inboxItem: InboxItem = {
          id: newId("inb"),
          repoId: repo.id,
          ticketId: ticket.id,
          kind: "plan_approval",
          status: "pending",
          title: `Approve Plan: ${ticket.title}`,
          summary: updatedMemory.planSummary ?? summary,
          contextPayload: { stageRunId: finishedRun.id, spillArtifactIds: note.spillArtifactIds },
          createdAt: nowIso(),
        };
        await this.stateStore.saveInboxItem(inboxItem);
        this.emitEvent({ type: "inbox_created", item: inboxItem, timestamp: inboxItem.createdAt });
        return;
      }
    }

    if (stage === "implement") {
      await this.workspace.commitAll(ws.worktreePath, `super-work(${ticket.id}): ${ticket.title}`);
    }

    if (stage === "review" && reviewApproved === false) {
      const feedback = completedEvent?.structuredOutput?.feedback || summary;
      if (ticket.stageRetries < ticket.mandate.maxStageRetries) {
        const sentBack: Ticket = {
          ...ticket,
          status: "queued",
          currentStage: "implement",
          stageRetries: ticket.stageRetries + 1,
          costUsd: ticket.costUsd + stageCostUsd,
          nativeSessions: updatedSessions,
          activeEngine: undefined,
          inlineMemory: {
            ...updatedMemory,
            activeHint: `Review rejected implementation. Address feedback:\n${feedback}`,
          },
          updatedAt: nowIso(),
        };
        await this.stateStore.saveTicket(sentBack);
        this.emitEvent({ type: "ticket_updated", ticket: sentBack, timestamp: sentBack.updatedAt });
        return;
      }
      await this.escalateTicket(
        {
          ...ticket,
          costUsd: ticket.costUsd + stageCostUsd,
          nativeSessions: updatedSessions,
          inlineMemory: updatedMemory,
        },
        "watchdog_escalation",
        `Code review rejected after ${ticket.mandate.maxStageRetries} revisions: ${feedback}`,
        { stageRunId: finishedRun.id },
      );
      return;
    }

    const nextStage: StageKind | null = getNextStage(ticket.template, stage);
    if (!nextStage) {
      await this.enqueueDeliveryOutbox({
        ...ticket,
        costUsd: ticket.costUsd + stageCostUsd,
        nativeSessions: updatedSessions,
        activeEngine: undefined,
        inlineMemory: updatedMemory,
      });
      return;
    }

    const advancing: Ticket = {
      ...ticket,
      status: "queued",
      currentStage: nextStage,
      stageRetries: 0,
      costUsd: ticket.costUsd + stageCostUsd,
      nativeSessions: updatedSessions,
      activeEngine: undefined,
      inlineMemory: updatedMemory,
      updatedAt: nowIso(),
    };
    await this.stateStore.saveTicket(advancing);
    this.emitEvent({ type: "ticket_updated", ticket: advancing, timestamp: advancing.updatedAt });
  }

  private async handleRebaseStage(ticket: Ticket, repo: RepoConfig, stageRun: StageRun): Promise<void> {
    const worktreePath = ticket.worktreePath!;
    await this.workspace.commitAll(worktreePath, `super-work(${ticket.id}): ${ticket.title}`);
    const rebaseRes = await this.workspace.rebaseOntoBase(worktreePath, repo.baseBranch);

    if (!rebaseRes.ok) {
      const failedRun: StageRun = {
        ...stageRun,
        status: "failed",
        completedAt: nowIso(),
        summary: rebaseRes.conflictSummary ?? "Rebase conflict",
      };
      await this.stateStore.saveStageRun(failedRun);

      if (ticket.stageRetries < ticket.mandate.maxStageRetries) {
        const retryTicket: Ticket = {
          ...ticket,
          status: "queued",
          currentStage: "implement",
          stageRetries: ticket.stageRetries + 1,
          inlineMemory: {
            ...ticket.inlineMemory,
            activeHint: `Rebase onto ${repo.baseBranch} failed with conflicts: ${rebaseRes.conflictSummary}. Update code to stay compatible and re-test.`,
          },
          updatedAt: nowIso(),
        };
        await this.stateStore.saveTicket(retryTicket);
        this.emitEvent({ type: "ticket_updated", ticket: retryTicket, timestamp: retryTicket.updatedAt });
      } else {
        await this.escalateTicket(
          ticket,
          "merge_conflict",
          `Rebase onto ${repo.baseBranch} conflicted: ${rebaseRes.conflictSummary}`,
          { branchName: ticket.branchName },
        );
      }
      return;
    }

    const finishedRun: StageRun = {
      ...stageRun,
      status: "completed",
      completedAt: nowIso(),
      summary: `Rebased cleanly onto ${repo.baseBranch}`,
    };
    const changedFiles = await this.workspace.getChangedFiles(worktreePath, repo.baseBranch);
    const diffText = await this.workspace.getDiff(worktreePath, repo.baseBranch);
    const { note } = await this.memory.recordStageSpillAndNote({
      ticket,
      stageRun: finishedRun,
      events: [],
      changedFiles,
      diffText,
      summary: finishedRun.summary!,
      verificationPassed: true,
    });
    finishedRun.spillTranscriptId = note.spillArtifactIds[0];
    await this.stateStore.saveStageRun(finishedRun);
    this.emitEvent({
      type: "stage_completed",
      ticketId: ticket.id,
      stageRun: finishedRun,
      note,
      timestamp: finishedRun.completedAt!,
    });

    await this.enqueueDeliveryOutbox({
      ...ticket,
      inlineMemory: {
        ...ticket.inlineMemory,
        stageNotes: [...ticket.inlineMemory.stageNotes, note],
      },
    });
  }

  private async enqueueDeliveryOutbox(ticket: Ticket): Promise<void> {
    const template = getPipelineTemplate(ticket.template);
    const ts = nowIso();
    const needsSignoff = template.requireOutboxSignoff;

    const updatedTicket: Ticket = {
      ...ticket,
      status: "outbox_pending",
      activeEngine: undefined,
      updatedAt: ts,
    };
    await this.stateStore.saveTicket(updatedTicket);
    this.emitEvent({ type: "ticket_updated", ticket: updatedTicket, timestamp: ts });

    const outboxEntry: OutboxEntry = {
      id: newId("obx"),
      repoId: ticket.repoId,
      ticketId: ticket.id,
      action: "push_and_create_pr",
      idempotencyKey: `deliver:${ticket.id}:${ticket.branchName ?? "branch"}`,
      payload: {
        title: ticket.title,
        branchName: ticket.branchName,
        worktreePath: ticket.worktreePath,
        summary: ticket.inlineMemory.stageNotes.map((n) => `[${n.stage}] ${n.summary}`).join("\n"),
      },
      status: needsSignoff ? "awaiting_approval" : "pending",
      attempts: 0,
      nextAttemptAt: ts,
      createdAt: ts,
      updatedAt: ts,
    };
    await this.stateStore.enqueueOutbox(outboxEntry);
    this.emitEvent({ type: "outbox_queued", entry: outboxEntry, timestamp: ts });

    if (needsSignoff) {
      const inboxItem: InboxItem = {
        id: newId("inb"),
        repoId: ticket.repoId,
        ticketId: ticket.id,
        kind: "outbox_signoff",
        status: "pending",
        title: `Sign off PR Delivery: ${ticket.title}`,
        summary: `Ready to deliver branch ${ticket.branchName}. Approve Outbox execution to push / create PR.`,
        contextPayload: { outboxId: outboxEntry.id, branchName: ticket.branchName },
        createdAt: ts,
      };
      await this.stateStore.saveInboxItem(inboxItem);
      this.emitEvent({ type: "inbox_created", item: inboxItem, timestamp: ts });
    }
  }

  private async escalateTicket(
    ticket: Ticket,
    kind: InboxItem["kind"],
    reason: string,
    contextPayload: Record<string, unknown>,
  ): Promise<void> {
    const ts = nowIso();
    const updated: Ticket = {
      ...ticket,
      status: "needs_human",
      activeEngine: undefined,
      errorMessage: reason,
      updatedAt: ts,
    };
    await this.stateStore.saveTicket(updated);
    this.emitEvent({ type: "ticket_updated", ticket: updated, timestamp: ts });

    const inboxItem: InboxItem = {
      id: newId("inb"),
      repoId: ticket.repoId,
      ticketId: ticket.id,
      kind,
      status: "pending",
      title: `Action Needed: ${ticket.title}`,
      summary: reason,
      contextPayload,
      createdAt: ts,
    };
    await this.stateStore.saveInboxItem(inboxItem);
    this.emitEvent({ type: "inbox_created", item: inboxItem, timestamp: ts });
  }
}
