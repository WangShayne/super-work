import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
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
  CreateEpicInput,
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
  EpicDecompositionPlan,
  InboxItem,
  KernelEvent,
  ManagedWorktreeItem,
  OutboxAction,
  OutboxEntry,
  PipelineTemplateId,
  RepoConfig,
  SpillArtifact,
  StageKind,
  StageRun,
  SystemSetupConfig,
  Ticket,
  VerificationRunResult,
  WatchdogDecision,
  WatchdogSignal,
  WorkerEngineId,
  WorkerStreamEvent,
  WorktreeGcResult,
} from "./types.ts";
import { isTerminalTicketStatus, newId, nowIso } from "./utils.ts";
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

function utcTodayString(): string {
  return new Date().toISOString().slice(0, 10);
}

function getEffectiveDailyBudget(repo: RepoConfig, todayDate: string): number | undefined {
  if (repo.dailyBudgetOverrideDate === todayDate && repo.dailyBudgetOverrideUsd !== undefined) {
    return repo.dailyBudgetOverrideUsd;
  }
  return repo.dailyBudgetUsd;
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
  private readonly finalizingEpics = new Set<string>();
  private readonly epicMergeLocks = new Map<string, Promise<void>>();

  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private outboxTimer: ReturnType<typeof setInterval> | null = null;
  private tickingPromise: Promise<number> | null = null;
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
    this.router = new EventIntakeRouter(
      deps.stateStore,
      deps.llm,
      emit,
      deps.workspace.getRepoStructureSummary?.bind(deps.workspace),
    );
    this.watchdog = new TwoTierWatchdog(deps.llm, this.config.watchdog);
    this.outbox = new OutboxProcessor(
      deps.stateStore,
      deps.outboxExecutor,
      emit,
      this.config.outboxMaxAttempts,
      async (deliveredTicket, repo, entry) => {
        let currentTicket = deliveredTicket;
        const payloadPrNumber =
          typeof entry.resultPayload?.prNumber === "number"
            ? entry.resultPayload.prNumber
            : undefined;
        const payloadPrUrl =
          typeof entry.resultPayload?.prUrl === "string"
            ? entry.resultPayload.prUrl
            : undefined;

        if (payloadPrNumber || payloadPrUrl) {
          const prTs = nowIso();
          currentTicket = {
            ...currentTicket,
            prNumber: payloadPrNumber ?? currentTicket.prNumber,
            prUrl: payloadPrUrl ?? currentTicket.prUrl,
            updatedAt: prTs,
          };
          await this.stateStore.saveTicket(currentTicket);
          this.emitEvent({ type: "ticket_updated", ticket: currentTicket, timestamp: prTs });

          if (repo.githubRepo && currentTicket.prNumber) {
            const prThreadKey = `gh:${repo.githubRepo}:pr:${currentTicket.prNumber}`;
            const existingPrThread = await this.stateStore.getThreadByKey(repo.id, prThreadKey);
            await this.stateStore.upsertThread({
              id: existingPrThread?.id ?? newId("thr"),
              repoId: repo.id,
              threadKey: prThreadKey,
              subscribedTicketId: currentTicket.id,
              metadata: {
                ...(existingPrThread?.metadata ?? {}),
                source: "github_pr",
                prNumber: currentTicket.prNumber,
                branchName: currentTicket.branchName,
              },
              createdAt: existingPrThread?.createdAt ?? prTs,
              updatedAt: prTs,
            });
          }
        }

        if (
          currentTicket.worktreePath &&
          (repo.autoCleanupWorktree !== false || entry.action === "local_merge")
        ) {
          await this.cleanupTicketWorktree(currentTicket.id);
        }
      },
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

  async recoverInterruptedRuns(): Promise<{ recoveredTickets: number; requeuedOutbox: number }> {
    const ts = nowIso();
    const interruptedStatuses = new Set<Ticket["status"]>([
      "planning",
      "implementing",
      "reviewing",
      "rebasing",
      "watchdog_intervention",
    ]);
    const allTickets = await this.stateStore.listTickets();
    let recoveredTickets = 0;

    for (const ticket of allTickets) {
      if (!interruptedStatuses.has(ticket.status) || this.activeTicketRuns.has(ticket.id)) {
        continue;
      }

      const stageRuns = await this.stateStore.listStageRuns(ticket.id);
      const runningRuns = stageRuns.filter((r) => r.status === "running");

      // Epic umbrella tickets stay in 'implementing' normally while children run unless
      // they were actively executing a final integration/rebasing stage.
      if (ticket.isEpic && ticket.status !== "rebasing" && runningRuns.length === 0) {
        continue;
      }

      for (const run of runningRuns) {
        await this.stateStore.saveStageRun({
          ...run,
          status: "aborted",
          completedAt: ts,
          summary: "Interrupted by daemon restart (recovered)",
        });
      }

      const recoveryNote =
        "Previous turn was interrupted by daemon restart. Inspect current git status/diff in the worktree first and continue from existing progress.";
      const existingHint = ticket.inlineMemory.activeHint?.trim() ?? "";
      const nextHint = existingHint.includes(recoveryNote)
        ? existingHint
        : [existingHint, recoveryNote].filter(Boolean).join("\n\n");

      const recovered: Ticket = {
        ...ticket,
        status: "queued",
        activeEngine: undefined,
        inlineMemory: {
          ...ticket.inlineMemory,
          activeHint: nextHint,
        },
        updatedAt: ts,
      };
      await this.stateStore.saveTicket(recovered);
      this.emitEvent({ type: "ticket_updated", ticket: recovered, timestamp: ts });
      recoveredTickets += 1;
    }

    const requeuedOutbox = await this.stateStore.requeueInterruptedOutboxEntries(ts);
    return { recoveredTickets, requeuedOutbox };
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

  async previewEpic(input: {
    repoId: string;
    title: string;
    description: string;
    template?: PipelineTemplateId;
  }): Promise<EpicDecompositionPlan> {
    return this.router.previewEpic(input);
  }

  async createEpic(input: CreateEpicInput): Promise<{ epic: Ticket; subtasks: Ticket[] }> {
    return this.router.createEpic(input);
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
    const activeRun = this.activeTicketRuns.get(ticketId);
    if (activeRun) {
      await Promise.race([activeRun, new Promise((r) => setTimeout(r, 500))]).catch(() => {});
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

    const repo = await this.stateStore.getRepo(updated.repoId);
    if (repo?.autoCleanupWorktree !== false && updated.worktreePath) {
      return (await this.cleanupTicketWorktree(ticketId)) ?? updated;
    }
    return updated;
  }

  async cleanupTicketWorktree(ticketId: string): Promise<Ticket | null> {
    const ticket = await this.stateStore.getTicket(ticketId);
    if (!ticket) return null;

    if (!isTerminalTicketStatus(ticket.status) || this.activeTicketRuns.has(ticketId)) {
      throw new Error(
        `Cannot cleanup worktree for non-terminal ticket ${ticketId} (${ticket.status})`,
      );
    }

    const repo = await this.stateStore.getRepo(ticket.repoId);
    if (ticket.worktreePath) {
      await this.workspace.cleanupWorkspace(ticket.worktreePath, repo?.rootPath);
    }

    const ts = nowIso();
    const updated: Ticket = {
      ...ticket,
      worktreePath: undefined,
      worktreeCleanedAt: ts,
      updatedAt: ts,
    };
    await this.stateStore.saveTicket(updated);
    this.emitEvent({ type: "ticket_updated", ticket: updated, timestamp: ts });
    return updated;
  }

  async inspectWorktrees(repoId?: string): Promise<ManagedWorktreeItem[]> {
    const [dirs, tickets, repos] = await Promise.all([
      this.workspace.listWorktreeDirs(),
      this.stateStore.listTickets(),
      this.stateStore.listRepos(),
    ]);
    const reposById = new Map(repos.map((r) => [r.id, r]));
    const ticketsByPath = new Map<string, Ticket>();
    const ticketsById = new Map<string, Ticket>();
    for (const t of tickets) {
      ticketsById.set(t.id, t);
      if (t.worktreePath) {
        ticketsByPath.set(resolve(t.worktreePath), t);
      }
    }

    const items: ManagedWorktreeItem[] = [];
    for (const dir of dirs) {
      const resolvedDir = resolve(dir);
      const matched = ticketsByPath.get(resolvedDir) ?? ticketsById.get(basename(resolvedDir));
      if (matched) {
        const repo = reposById.get(matched.repoId);
        const item: ManagedWorktreeItem = {
          path: dir,
          ticketId: matched.id,
          ticketTitle: matched.title,
          ticketStatus: matched.status,
          repoId: matched.repoId,
          repoName: repo?.name,
          branchName: matched.branchName,
          reclaimable:
            isTerminalTicketStatus(matched.status) && !this.activeTicketRuns.has(matched.id),
          isOrphan: false,
        };
        if (!repoId || item.repoId === repoId) {
          items.push(item);
        }
      } else {
        items.push({
          path: dir,
          reclaimable: true,
          isOrphan: true,
        });
      }
    }
    return items;
  }

  async gcWorktrees(options?: { repoId?: string }): Promise<WorktreeGcResult> {
    const items = await this.inspectWorktrees(options?.repoId);
    const removedPaths: string[] = [];
    const cleanedTicketIds: string[] = [];
    let skippedActiveCount = 0;

    for (const item of items) {
      if (!item.reclaimable) {
        skippedActiveCount += 1;
        continue;
      }
      if (item.ticketId) {
        await this.cleanupTicketWorktree(item.ticketId);
        removedPaths.push(item.path);
        cleanedTicketIds.push(item.ticketId);
      } else {
        await this.workspace.cleanupWorkspace(item.path);
        removedPaths.push(item.path);
      }
    }

    const result: WorktreeGcResult = {
      removedPaths,
      cleanedTicketIds,
      skippedActiveCount,
      timestamp: nowIso(),
    };
    this.emitEvent({ type: "worktrees_gc", result, timestamp: result.timestamp });
    return result;
  }

  async resolveInboxItem(
    inboxId: string,
    decision: "approved" | "rejected",
    note?: string,
    options?: {
      deliveryAction?: "local_merge" | "push_and_create_pr";
      expandMandate?: boolean;
      budgetIncreaseUsd?: number;
    },
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
          action:
            decision === "approved" && options?.deliveryAction
              ? options.deliveryAction
              : entry.action,
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
    } else if (item.kind === "mandate_violation") {
      const pendingPaths =
        ticket.pendingViolationPaths ??
        (Array.isArray(item.contextPayload.scopeViolations)
          ? (item.contextPayload.scopeViolations as string[])
          : []);
      const canExpand =
        Boolean(options?.expandMandate) &&
        item.contextPayload.canExpandMandate === true &&
        pendingPaths.length > 0;

      if (decision === "approved" && canExpand) {
        const mergedAllowed = Array.from(new Set([...ticket.mandate.allowedPaths, ...pendingPaths]));
        const expandedMandate = { ...ticket.mandate, allowedPaths: mergedAllowed };
        const interruptedStage =
          (item.contextPayload.interruptedStage as StageKind | undefined) ?? ticket.currentStage;

        nextTicket = {
          ...nextTicket,
          mandate: expandedMandate,
          pendingViolationPaths: undefined,
          stageRetries: 0,
          errorMessage: undefined,
        };

        if (
          interruptedStage === "implement" &&
          ticket.worktreePath &&
          existsSync(ticket.worktreePath)
        ) {
          const repo = await this.stateStore.getRepo(ticket.repoId);
          const syntheticRun: StageRun = {
            id: newId("run"),
            ticketId: ticket.id,
            stage: "implement",
            engine:
              ticket.activeEngine ??
              ticket.preferredEngine ??
              repo?.preferredImplementEngine ??
              "mock",
            status: "running",
            costUsd: 0,
            startedAt: ts,
          };
          await this.stateStore.saveStageRun(syntheticRun);
          const gate = repo
            ? await this.runRepoVerificationGate(nextTicket, repo, syntheticRun, ticket.worktreePath)
            : { passed: true };

          if (gate.passed) {
            await this.workspace.commitAll(
              ticket.worktreePath,
              `super-work(${ticket.id}): ${ticket.title}`,
            );
            const effectiveBaseBranch = repo
              ? (await this.getEffectiveBaseInfo(nextTicket, repo)).effectiveBaseBranch
              : "main";
            const changedFiles = await this.workspace.getChangedFiles(
              ticket.worktreePath,
              effectiveBaseBranch,
            );
            const diffText = await this.workspace.getDiff(ticket.worktreePath, effectiveBaseBranch);
            const finishedRun: StageRun = {
              ...syntheticRun,
              status: "completed",
              completedAt: nowIso(),
              summary: `Mandate expanded to [${pendingPaths.join(", ")}] and verification passed`,
            };
            const { note: expNote } = await this.memory.recordStageSpillAndNote({
              ticket: nextTicket,
              stageRun: finishedRun,
              events: [],
              changedFiles,
              diffText,
              summary: finishedRun.summary!,
              verificationPassed: true,
              extraArtifacts: gate.artifact ? [gate.artifact] : undefined,
            });
            finishedRun.spillTranscriptId = expNote.spillArtifactIds[0];
            await this.stateStore.saveStageRun(finishedRun);

            const afterStage = ticket.prNumber
              ? "rebase"
              : getNextStage(ticket.template, "implement");
            const withNote: Ticket = {
              ...nextTicket,
              inlineMemory: {
                ...nextTicket.inlineMemory,
                stageNotes: [...nextTicket.inlineMemory.stageNotes, expNote],
                activeHint: note || undefined,
              },
            };
            if (!afterStage) {
              await this.enqueueDeliveryOutbox(withNote, repo ?? undefined);
              return {
                item: resolvedItem,
                ticket: (await this.stateStore.getTicket(ticket.id)) ?? withNote,
              };
            }
            nextTicket = {
              ...withNote,
              status: "queued",
              currentStage: afterStage,
              updatedAt: nowIso(),
            };
          } else {
            const failRun: StageRun = {
              ...syntheticRun,
              status: "failed",
              completedAt: nowIso(),
              summary: gate.result?.summary ?? "Verification failed after Mandate expansion",
            };
            await this.stateStore.saveStageRun(failRun);
            nextTicket = {
              ...nextTicket,
              status: "queued",
              currentStage: "implement",
              inlineMemory: {
                ...nextTicket.inlineMemory,
                activeHint: `Mandate expanded to include ${pendingPaths.join(", ")}, but verification failed (${gate.result?.failedCommand ?? "checks"}):\n${gate.result?.summary ?? ""}`,
              },
            };
          }
        } else {
          nextTicket = {
            ...nextTicket,
            status: "queued",
            inlineMemory: {
              ...nextTicket.inlineMemory,
              activeHint:
                note ??
                `Mandate expanded to include ${pendingPaths.join(", ")}; continue carefully within Mandate.`,
            },
          };
        }
      } else {
        if (ticket.worktreePath && existsSync(ticket.worktreePath) && pendingPaths.length > 0) {
          await this.workspace.revertPaths(ticket.worktreePath, pendingPaths);
        }
        nextTicket = {
          ...nextTicket,
          pendingViolationPaths: undefined,
          ...(decision === "approved"
            ? {
                status: "queued" as const,
                stageRetries: 0,
                errorMessage: undefined,
                inlineMemory: {
                  ...nextTicket.inlineMemory,
                  activeHint:
                    note ??
                    `Out-of-scope edits (${pendingPaths.join(", ")}) were reverted; stay strictly within ${nextTicket.mandate.allowedPaths.join(", ")}.`,
                },
              }
            : {
                status: "cancelled" as const,
                errorMessage: note ?? "Mandate violation rejected",
              }),
        };
      }
    } else if (item.kind === "budget_cap") {
      const repo = await this.stateStore.getRepo(item.repoId);
      if (decision === "approved" && repo) {
        const today = utcTodayString();
        const todaySpend = await this.stateStore.getDailyRepoSpendUsd(repo.id, today);
        const currentEffective = getEffectiveDailyBudget(repo, today) ?? todaySpend;
        const baseCap = Math.max(todaySpend, currentEffective);
        const increase = options?.budgetIncreaseUsd ?? 5.0;
        const updatedRepo: RepoConfig = {
          ...repo,
          dailyBudgetOverrideDate: today,
          dailyBudgetOverrideUsd: Number((baseCap + increase).toFixed(4)),
          updatedAt: ts,
        };
        await this.stateStore.upsertRepo(updatedRepo);
        this.emitEvent({ type: "repo_updated", repo: updatedRepo, timestamp: ts });
      } else if (decision === "rejected") {
        nextTicket = {
          ...nextTicket,
          status: "cancelled",
          errorMessage: note ?? "Daily budget cap increase rejected",
        };
      }
    } else if (item.kind === "pr_followup") {
      if (decision === "approved") {
        nextTicket = {
          ...nextTicket,
          status: "queued",
          currentStage: "implement",
          stageRetries: 0,
          prAutoFollowupCount: 0,
          errorMessage: undefined,
          inlineMemory: {
            ...nextTicket.inlineMemory,
            activeHint:
              note ??
              `Address PR feedback on branch ${nextTicket.branchName ?? ""}: ${item.summary}`,
          },
        };
      } else {
        // Rejecting a PR follow-up keeps the existing PR ticket in delivered state
        nextTicket = {
          ...nextTicket,
          status: "delivered",
          errorMessage: undefined,
        };
      }
    } else {
      // watchdog_escalation, merge_conflict
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

  tick(): Promise<number> {
    if (this.stopped) return Promise.resolve(0);
    if (this.tickingPromise) {
      return this.tickingPromise;
    }
    this.tickingPromise = this.performTick().finally(() => {
      this.tickingPromise = null;
    });
    return this.tickingPromise;
  }

  private async performTick(): Promise<number> {
    let launched = 0;
    const repos = await this.stateStore.listRepos();
    for (const repo of repos) {
      await this.router.resolveDependenciesForWaitingTickets(repo);
      await this.syncEpicStatuses(repo);
    }

    const capacity = this.config.maxConcurrentWorkers - this.activeTicketRuns.size;
    if (capacity <= 0) return 0;

    const activeByRepo = new Map<string, number>();
    for (const activeId of this.activeTicketRuns.keys()) {
      const activeTicket = await this.stateStore.getTicket(activeId);
      if (activeTicket) {
        activeByRepo.set(activeTicket.repoId, (activeByRepo.get(activeTicket.repoId) ?? 0) + 1);
      }
    }

    const reposById = new Map(repos.map((r) => [r.id, r]));
    const today = utcTodayString();
    const todaySpendCache = new Map<string, number>();

    const queued = await this.stateStore.listTickets({ status: "queued" });
    const candidates = queued.filter((t) => !this.activeTicketRuns.has(t.id));

    for (const ticket of candidates) {
      if (launched >= capacity) break;
      const repo = reposById.get(ticket.repoId);
      const stage = ticket.currentStage || getFirstStage(ticket.template);

      if (repo?.maxConcurrentWorkers && repo.maxConcurrentWorkers > 0) {
        const curRepoActive = activeByRepo.get(repo.id) ?? 0;
        if (curRepoActive >= repo.maxConcurrentWorkers) {
          continue;
        }
      }

      const effectiveBudget = repo ? getEffectiveDailyBudget(repo, today) : undefined;
      if (stage !== "rebase" && repo && effectiveBudget !== undefined && effectiveBudget > 0) {
        let spend = todaySpendCache.get(repo.id);
        if (spend === undefined) {
          spend = await this.stateStore.getDailyRepoSpendUsd(repo.id, today);
          todaySpendCache.set(repo.id, spend);
        }
        if (spend >= effectiveBudget) {
          await this.ensureBudgetCapInboxItem(repo, ticket, spend, effectiveBudget, today);
          continue;
        }
      }

      activeByRepo.set(ticket.repoId, (activeByRepo.get(ticket.repoId) ?? 0) + 1);
      launched += 1;
      const promise = this.runTicketStage(ticket.id).finally(() => {
        this.activeTicketRuns.delete(ticket.id);
        this.abortControllers.delete(ticket.id);
      });
      this.activeTicketRuns.set(ticket.id, promise);
    }
    return launched;
  }

  private async ensureBudgetCapInboxItem(
    repo: RepoConfig,
    ticket: Ticket,
    todaySpendUsd: number,
    dailyBudgetUsd: number,
    todayDate: string,
  ): Promise<void> {
    const existingPending = await this.stateStore.listInboxItems({
      repoId: repo.id,
      status: "pending",
    });
    if (existingPending.some((i) => i.kind === "budget_cap")) {
      return;
    }
    const ts = nowIso();
    const item: InboxItem = {
      id: newId("inb"),
      repoId: repo.id,
      ticketId: ticket.id,
      kind: "budget_cap",
      status: "pending",
      title: `Daily budget cap reached for ${repo.name} ($${todaySpendUsd.toFixed(2)} / $${dailyBudgetUsd.toFixed(2)})`,
      summary: `Repository ${repo.name} spent $${todaySpendUsd.toFixed(4)} today (cap: $${dailyBudgetUsd.toFixed(2)}). In-flight stages finish cleanly; queued dispatch is paused until budget increase is approved.`,
      contextPayload: {
        repoId: repo.id,
        todaySpendUsd,
        dailyBudgetUsd,
        date: todayDate,
      },
      createdAt: ts,
    };
    await this.stateStore.saveInboxItem(item);
    this.emitEvent({ type: "inbox_created", item, timestamp: ts });
  }

  async runUntilIdle(maxCycles = 30): Promise<void> {
    for (let i = 0; i < maxCycles; i++) {
      const launched = await this.tick();
      const hadActive = this.activeTicketRuns.size > 0;
      if (hadActive) {
        await Promise.allSettled(Array.from(this.activeTicketRuns.values()));
      }
      await this.outbox.processDueEntries();
      const reposAfter = await this.stateStore.listRepos();
      for (const repo of reposAfter) {
        await this.syncEpicStatuses(repo);
      }

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
        !hadActive &&
        launched === 0 &&
        pendingOutbox.length === 0
      ) {
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

  private async getEffectiveBaseInfo(
    ticket: Ticket,
    repo: RepoConfig,
  ): Promise<{ effectiveBaseBranch: string; parentEpic: Ticket | null }> {
    if (!ticket.parentTicketId) {
      return { effectiveBaseBranch: repo.baseBranch, parentEpic: null };
    }
    const parentEpic = await this.stateStore.getTicket(ticket.parentTicketId);
    if (
      parentEpic &&
      parentEpic.isEpic &&
      parentEpic.epicDeliveryMode !== "per_subtask" &&
      parentEpic.branchName
    ) {
      await this.workspace.ensureBranch(repo.rootPath, parentEpic.branchName, repo.baseBranch);
      return { effectiveBaseBranch: parentEpic.branchName, parentEpic };
    }
    return { effectiveBaseBranch: repo.baseBranch, parentEpic: null };
  }

  private async runWithEpicLock<T>(epicId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.epicMergeLocks.get(epicId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((res) => {
      release = res;
    });
    const chained = prev.then(() => next);
    this.epicMergeLocks.set(epicId, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.epicMergeLocks.get(epicId) === chained) {
        this.epicMergeLocks.delete(epicId);
      }
    }
  }

  private async runTicketStage(ticketId: string): Promise<void> {
    let ticket = await this.stateStore.getTicket(ticketId);
    if (!ticket || ticket.status !== "queued") return;

    const repo = await this.stateStore.getRepo(ticket.repoId);
    if (!repo) return;

    const stage = ticket.currentStage || getFirstStage(ticket.template);
    const availableEngines = await this.getAvailableEngines();
    const explicitEngine =
      stage === "review"
        ? ticket.activeEngine
        : (ticket.activeEngine ?? ticket.preferredEngine);
    const chosenEngine = selectEngineForStage(repo, stage, explicitEngine);
    const driver =
      this.drivers.get(chosenEngine) ??
      (availableEngines[0] ? this.drivers.get(availableEngines[0]) : undefined);

    if (!driver) {
      await this.escalateTicket(ticket, "watchdog_escalation", `No WorkerDriver available for engine '${chosenEngine}'`, {
        chosenEngine,
      });
      return;
    }

    // Prepare isolated worktree workspace (and merge upstream dependency branches on initial creation)
    const { effectiveBaseBranch } = await this.getEffectiveBaseInfo(ticket, repo);
    const hadWorktree = Boolean(ticket.worktreePath);
    const ws = await this.workspace.prepareWorkspace(ticket, repo, {
      startPoint: effectiveBaseBranch,
    });
    if (!hadWorktree && ticket.dependsOn.length > 0) {
      const depBranches: string[] = [];
      for (const depId of ticket.dependsOn) {
        const dep = await this.stateStore.getTicket(depId);
        if (dep?.branchName) {
          depBranches.push(dep.branchName);
        }
      }
      if (depBranches.length > 0) {
        await this.workspace.integrateDependencyBranches(ws.worktreePath, depBranches);
      }
    }
    const existingSessionId =
      stage === "review" ? undefined : ticket.nativeSessions[driver.engine];
    const stageRun: StageRun = {
      id: newId("run"),
      ticketId: ticket.id,
      stage,
      engine: driver.engine,
      status: "running",
      nativeSessionId: existingSessionId,
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
    const prompt = this.memory.buildWorkerPromptContext(
      ticket,
      stage,
      relatedMemory,
      repo.verificationCommands,
    );

    const setupConfig = await this.stateStore.getSystemSetting<SystemSetupConfig>("setup_config");
    const engineProfile =
      driver.engine === "claude"
        ? setupConfig?.claudeProfile
        : driver.engine === "codex"
          ? setupConfig?.codexProfile
          : driver.engine === "opencode"
            ? setupConfig?.opencodeProfile
            : undefined;
    const canApplyModelOverride = Boolean(
      ticket.modelOverride &&
        stage !== "review" &&
        (!ticket.preferredEngine || ticket.preferredEngine === driver.engine),
    );
    const effectiveModel = canApplyModelOverride ? ticket.modelOverride : engineProfile?.model;
    const effectiveEffort =
      stage !== "review" && ticket.effortOverride
        ? ticket.effortOverride
        : engineProfile?.effort;

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
          model: effectiveModel,
          effort: effectiveEffort,
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
            const diffText = await this.workspace.getDiff(ws.worktreePath, effectiveBaseBranch);
            const changed = await this.workspace.getChangedFiles(ws.worktreePath, effectiveBaseBranch);
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
    const changedFiles = await this.workspace.getChangedFiles(ws.worktreePath, effectiveBaseBranch);
    const diffText = await this.workspace.getDiff(ws.worktreePath, effectiveBaseBranch);
    const mandateCheck = validateChangedFilesAgainstMandate(changedFiles, ticket.mandate);

    if (!mandateCheck.ok) {
      const hasForbidden = mandateCheck.forbiddenViolations.length > 0;
      if (hasForbidden) {
        await this.workspace.revertPaths(ws.worktreePath, mandateCheck.violations);
      }

      const abortedRun: StageRun = {
        ...stageRun,
        status: "failed",
        nativeSessionId: discoveredSessionId,
        costUsd: stageCostUsd,
        completedAt: nowIso(),
        summary: `Mandate violation on paths: ${mandateCheck.violations.join(", ")}`,
      };
      await this.stateStore.saveStageRun(abortedRun);
      const { note: vNote } = await this.memory.recordStageSpillAndNote({
        ticket,
        stageRun: abortedRun,
        events: collectedEvents,
        changedFiles: mandateCheck.violations,
        diffText,
        summary: abortedRun.summary!,
        verificationPassed: false,
      });

      const updatedSessionsOnViolation =
        discoveredSessionId && stage !== "review"
          ? { ...ticket.nativeSessions, [driver.engine]: discoveredSessionId }
          : ticket.nativeSessions;

      const reason = hasForbidden
        ? `Worker attempted to modify forbidden paths (${mandateCheck.forbiddenViolations.join(", ")}) or out-of-scope paths: ${mandateCheck.violations.join(", ")} (changes reverted)`
        : `Worker modified files outside authorized allowedPaths: ${mandateCheck.scopeViolations.join(", ")} (preserved in worktree pending approval or revert)`;

      await this.escalateTicket(
        {
          ...ticket,
          costUsd: ticket.costUsd + stageCostUsd,
          nativeSessions: updatedSessionsOnViolation,
          pendingViolationPaths: hasForbidden ? undefined : mandateCheck.scopeViolations,
          inlineMemory: {
            ...ticket.inlineMemory,
            stageNotes: [...ticket.inlineMemory.stageNotes, vNote],
          },
        },
        "mandate_violation",
        reason,
        {
          violations: mandateCheck.violations,
          forbiddenViolations: mandateCheck.forbiddenViolations,
          scopeViolations: mandateCheck.scopeViolations,
          canExpandMandate: !hasForbidden && mandateCheck.scopeViolations.length > 0,
          interruptedStage: stage,
        },
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
        reviewApproved = !/verdict:\s*[*_`]*\s*rejected/i.test(summary);
      }
    }

    let verificationArtifact: SpillArtifact | undefined;
    let verificationPassed = completedEvent?.structuredOutput?.verificationPassed ?? true;
    if (stage === "implement") {
      const gate = await this.runRepoVerificationGate(ticket, repo, stageRun, ws.worktreePath);
      if (gate.artifact) {
        verificationArtifact = gate.artifact;
      }
      verificationPassed = gate.passed;
      if (!gate.passed) {
        const failedSummary = gate.result?.summary ?? "Deterministic verification gate failed";
        const failedRun: StageRun = {
          ...stageRun,
          status: "failed",
          nativeSessionId: discoveredSessionId,
          costUsd: stageCostUsd,
          completedAt: nowIso(),
          summary: failedSummary,
        };
        const { note: failNote } = await this.memory.recordStageSpillAndNote({
          ticket,
          stageRun: failedRun,
          events: collectedEvents,
          changedFiles,
          diffText,
          summary: failedSummary,
          verificationPassed: false,
          extraArtifacts: verificationArtifact ? [verificationArtifact] : undefined,
        });
        failedRun.spillTranscriptId = failNote.spillArtifactIds[0];
        await this.stateStore.saveStageRun(failedRun);
        this.emitEvent({
          type: "stage_completed",
          ticketId: ticket.id,
          stageRun: failedRun,
          note: failNote,
          timestamp: failedRun.completedAt!,
        });

        const updatedFailSessions = discoveredSessionId
          ? { ...ticket.nativeSessions, [driver.engine]: discoveredSessionId }
          : ticket.nativeSessions;
        const updatedFailMemory = {
          ...ticket.inlineMemory,
          stageNotes: [...ticket.inlineMemory.stageNotes, failNote],
          activeHint: `Deterministic verification failed (${gate.result?.failedCommand ?? "checks"}). Fix the errors and verify locally:\n${failedSummary}`,
        };

        if (ticket.stageRetries < ticket.mandate.maxStageRetries) {
          const retrying: Ticket = {
            ...ticket,
            status: "queued",
            stageRetries: ticket.stageRetries + 1,
            costUsd: ticket.costUsd + stageCostUsd,
            nativeSessions: updatedFailSessions,
            activeEngine: undefined,
            inlineMemory: updatedFailMemory,
            updatedAt: nowIso(),
          };
          await this.stateStore.saveTicket(retrying);
          this.emitEvent({
            type: "ticket_updated",
            ticket: retrying,
            timestamp: retrying.updatedAt,
          });
        } else {
          await this.escalateTicket(
            {
              ...ticket,
              costUsd: ticket.costUsd + stageCostUsd,
              nativeSessions: updatedFailSessions,
              inlineMemory: updatedFailMemory,
            },
            "watchdog_escalation",
            `Deterministic verification failed after ${ticket.mandate.maxStageRetries} retries: ${gate.result?.failedCommand ?? failedSummary}`,
            { stageRunId: failedRun.id, failedCommand: gate.result?.failedCommand },
          );
        }
        return;
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
      verificationPassed,
      reviewApproved,
      extraArtifacts: verificationArtifact ? [verificationArtifact] : undefined,
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

    const updatedSessions =
      discoveredSessionId && stage !== "review"
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

    const nextStage: StageKind | null =
      stage === "implement" && ticket.prNumber
        ? "rebase"
        : getNextStage(ticket.template, stage);
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
    const { effectiveBaseBranch, parentEpic } = await this.getEffectiveBaseInfo(ticket, repo);
    await this.workspace.commitAll(worktreePath, `super-work(${ticket.id}): ${ticket.title}`);
    const rebaseRes = await this.workspace.rebaseOntoBase(worktreePath, effectiveBaseBranch);

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
            activeHint: `Rebase onto ${effectiveBaseBranch} failed with conflicts: ${rebaseRes.conflictSummary}. Update code to stay compatible and re-test.`,
          },
          updatedAt: nowIso(),
        };
        await this.stateStore.saveTicket(retryTicket);
        this.emitEvent({ type: "ticket_updated", ticket: retryTicket, timestamp: retryTicket.updatedAt });
      } else {
        await this.escalateTicket(
          ticket,
          "merge_conflict",
          `Rebase onto ${effectiveBaseBranch} conflicted: ${rebaseRes.conflictSummary}`,
          { branchName: ticket.branchName },
        );
      }
      return;
    }

    const gate = await this.runRepoVerificationGate(ticket, repo, stageRun, worktreePath);
    if (!gate.passed) {
      const failedSummary = gate.result?.summary ?? "Post-rebase verification gate failed";
      const failedRun: StageRun = {
        ...stageRun,
        status: "failed",
        completedAt: nowIso(),
        summary: failedSummary,
      };
      const changedFiles = await this.workspace.getChangedFiles(worktreePath, effectiveBaseBranch);
      const { note: failNote } = await this.memory.recordStageSpillAndNote({
        ticket,
        stageRun: failedRun,
        events: [],
        changedFiles,
        summary: failedSummary,
        verificationPassed: false,
        extraArtifacts: gate.artifact ? [gate.artifact] : undefined,
      });
      await this.stateStore.saveStageRun(failedRun);

      if (ticket.stageRetries < ticket.mandate.maxStageRetries) {
        const retryTicket: Ticket = {
          ...ticket,
          status: "queued",
          currentStage: "implement",
          stageRetries: ticket.stageRetries + 1,
          inlineMemory: {
            ...ticket.inlineMemory,
            stageNotes: [...ticket.inlineMemory.stageNotes, failNote],
            activeHint: `Post-rebase verification failed (${gate.result?.failedCommand ?? "checks"}). Fix the issue and ensure checks pass:\n${failedSummary}`,
          },
          updatedAt: nowIso(),
        };
        await this.stateStore.saveTicket(retryTicket);
        this.emitEvent({
          type: "ticket_updated",
          ticket: retryTicket,
          timestamp: retryTicket.updatedAt,
        });
      } else {
        await this.escalateTicket(
          ticket,
          "watchdog_escalation",
          `Post-rebase verification failed: ${failedSummary}`,
          { stageRunId: stageRun.id },
        );
      }
      return;
    }

    const finishedRun: StageRun = {
      ...stageRun,
      status: "completed",
      completedAt: nowIso(),
      summary: gate.artifact
        ? `Rebased cleanly onto ${effectiveBaseBranch}; ${gate.result?.summary ?? "verification passed"}`
        : `Rebased cleanly onto ${effectiveBaseBranch}`,
    };
    const changedFiles = await this.workspace.getChangedFiles(worktreePath, effectiveBaseBranch);
    const diffText = await this.workspace.getDiff(worktreePath, effectiveBaseBranch);
    const { note } = await this.memory.recordStageSpillAndNote({
      ticket,
      stageRun: finishedRun,
      events: [],
      changedFiles,
      diffText,
      summary: finishedRun.summary!,
      verificationPassed: true,
      extraArtifacts: gate.artifact ? [gate.artifact] : undefined,
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

    if (parentEpic && parentEpic.branchName) {
      await this.runWithEpicLock(parentEpic.id, () =>
        this.workspace.mergeBranchToBase({
          rootRepoPath: repo.rootPath,
          baseBranch: parentEpic.branchName!,
          branchName: ticket.branchName!,
          worktreePath,
          commitMessage: `epic(${parentEpic.id}/${ticket.subtaskKey ?? ticket.id}): ${ticket.title}`,
          deleteBranch: true,
        }),
      );
      const deliveredTs = nowIso();
      const deliveredSubtask: Ticket = {
        ...ticket,
        status: "delivered",
        activeEngine: undefined,
        worktreePath: undefined,
        worktreeCleanedAt: deliveredTs,
        inlineMemory: {
          ...ticket.inlineMemory,
          stageNotes: [...ticket.inlineMemory.stageNotes, note],
        },
        updatedAt: deliveredTs,
      };
      await this.stateStore.saveTicket(deliveredSubtask);
      this.emitEvent({
        type: "ticket_updated",
        ticket: deliveredSubtask,
        timestamp: deliveredTs,
      });
      return;
    }

    await this.enqueueDeliveryOutbox(
      {
        ...ticket,
        inlineMemory: {
          ...ticket.inlineMemory,
          stageNotes: [...ticket.inlineMemory.stageNotes, note],
        },
      },
      repo,
    );
  }

  private async runRepoVerificationGate(
    ticket: Ticket,
    repo: RepoConfig,
    stageRun: StageRun,
    worktreePath: string,
  ): Promise<{ passed: boolean; artifact?: SpillArtifact; result?: VerificationRunResult }> {
    const commands = (repo.verificationCommands ?? []).map((c) => c.trim()).filter(Boolean);
    if (commands.length === 0) {
      return { passed: true };
    }

    const result = await this.workspace.runVerificationCommands(
      worktreePath,
      commands,
      ticket.mandate.maxDurationSec,
    );
    this.emitEvent({
      type: "verification_completed",
      ticketId: ticket.id,
      stageRunId: stageRun.id,
      result,
      timestamp: nowIso(),
    });

    const logBody = result.results
      .map(
        (r) =>
          `$ ${r.command}\n[exit=${r.exitCode}, duration=${r.durationMs}ms]\n${r.output || "(no output)"}\n`,
      )
      .join("\n---\n");

    const artifact = await this.artifactStore.writeSpill(
      {
        ticketId: ticket.id,
        stageRunId: stageRun.id,
        kind: "test_log",
        summary: `${result.ok ? "PASS" : "FAIL"} verification (${commands.join(" && ")})`,
        ext: "log",
      },
      logBody || result.summary,
    );
    await this.stateStore.saveArtifact(artifact, `${result.summary}\n${logBody}`);

    return { passed: result.ok, artifact, result };
  }

  private async enqueueDeliveryOutbox(ticket: Ticket, repoArg?: RepoConfig): Promise<void> {
    const repo = repoArg ?? (await this.stateStore.getRepo(ticket.repoId));
    const template = getPipelineTemplate(ticket.template);
    const ts = nowIso();
    const needsSignoff = template.requireOutboxSignoff;
    const defaultChannel = repo?.defaultDeliveryChannel ?? "auto_pr_or_branch";
    const action: OutboxAction =
      defaultChannel === "local_merge" ? "local_merge" : "push_and_create_pr";

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
      action,
      idempotencyKey: `deliver:${action}:${ticket.id}:${ticket.branchName ?? "branch"}:n${ticket.inlineMemory.stageNotes.length}`,
      payload: {
        title: ticket.title,
        branchName: ticket.branchName,
        worktreePath: ticket.worktreePath,
        forceGithubPr: defaultChannel === "github_pr",
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
        title:
          action === "local_merge"
            ? `Sign off Local Merge: ${ticket.title}`
            : `Sign off PR Delivery: ${ticket.title}`,
        summary:
          action === "local_merge"
            ? `Ready to merge branch ${ticket.branchName} into ${repo?.baseBranch ?? "main"}. Approve Outbox execution to merge & cleanup.`
            : `Ready to deliver branch ${ticket.branchName}. Approve Outbox execution to push / create PR.`,
        contextPayload: {
          outboxId: outboxEntry.id,
          branchName: ticket.branchName,
          action,
        },
        createdAt: ts,
      };
      await this.stateStore.saveInboxItem(inboxItem);
      this.emitEvent({ type: "inbox_created", item: inboxItem, timestamp: ts });
    }
  }

  async triggerTicketDelivery(
    ticketId: string,
    action: "local_merge" | "push_and_create_pr",
  ): Promise<{ ticket: Ticket; entry: OutboxEntry }> {
    const ticket = await this.stateStore.getTicket(ticketId);
    if (!ticket) {
      throw new Error(`Ticket not found: ${ticketId}`);
    }
    if (ticket.isEpic && ticket.epicDeliveryMode === "per_subtask") {
      throw new Error("Per-subtask Epic umbrella tickets are delivered via their subtasks.");
    }
    if (!ticket.branchName) {
      throw new Error(`Ticket ${ticketId} has no branchName to deliver.`);
    }
    if (ticket.parentTicketId) {
      const parentEpic = await this.stateStore.getTicket(ticket.parentTicketId);
      if (parentEpic?.isEpic && parentEpic.epicDeliveryMode !== "per_subtask") {
        throw new Error(
          `Subtask ${ticketId} was integrated into unified Epic branch '${parentEpic.branchName}'; trigger delivery on parent Epic ${parentEpic.id} instead.`,
        );
      }
    }
    if (ticket.status !== "delivered" && ticket.status !== "outbox_pending") {
      throw new Error(
        `Ticket ${ticketId} must be delivered or outbox_pending before triggering ${action} (status=${ticket.status})`,
      );
    }

    const existingEntries = await this.stateStore.listOutboxEntries({ ticketId: ticket.id });
    const alreadySent = existingEntries.find((e) => e.action === action && e.status === "sent");
    if (alreadySent) {
      return { ticket, entry: alreadySent };
    }

    const ts = nowIso();
    const idempotencyKey = `deliver:${action}:${ticket.id}:${ticket.branchName}`;
    const existingByKey = existingEntries.find((e) => e.idempotencyKey === idempotencyKey);
    let entry: OutboxEntry;
    if (existingByKey) {
      entry = {
        ...existingByKey,
        status: "pending",
        attempts: 0,
        lastError: undefined,
        nextAttemptAt: ts,
        updatedAt: ts,
      };
      await this.stateStore.updateOutboxEntry(entry);
    } else {
      entry = {
        id: newId("obx"),
        repoId: ticket.repoId,
        ticketId: ticket.id,
        action,
        idempotencyKey,
        payload: {
          title: ticket.title,
          branchName: ticket.branchName,
          worktreePath: ticket.worktreePath,
          forceGithubPr: action === "push_and_create_pr",
          summary: ticket.inlineMemory.stageNotes
            .map((n) => `[${n.stage}] ${n.summary}`)
            .join("\n"),
        },
        status: "pending",
        attempts: 0,
        nextAttemptAt: ts,
        createdAt: ts,
        updatedAt: ts,
      };
      await this.stateStore.enqueueOutbox(entry);
    }
    this.emitEvent({ type: "outbox_queued", entry, timestamp: ts });

    await this.outbox.processDueEntries(10);

    let refreshedTicket = (await this.stateStore.getTicket(ticket.id)) ?? ticket;
    const refreshedEntry = (await this.stateStore.getOutboxEntry(entry.id)) ?? entry;
    if (action === "local_merge" && refreshedEntry.status === "sent" && refreshedTicket.worktreePath) {
      refreshedTicket = {
        ...refreshedTicket,
        worktreePath: undefined,
        worktreeCleanedAt: refreshedTicket.worktreeCleanedAt ?? nowIso(),
        updatedAt: nowIso(),
      };
      await this.stateStore.saveTicket(refreshedTicket);
      this.emitEvent({
        type: "ticket_updated",
        ticket: refreshedTicket,
        timestamp: refreshedTicket.updatedAt,
      });
    }

    return { ticket: refreshedTicket, entry: refreshedEntry };
  }

  private async syncEpicStatuses(repo: RepoConfig): Promise<void> {
    const repoTickets = await this.stateStore.listTickets({ repoId: repo.id });
    const epics = repoTickets.filter((t) => t.isEpic && !isTerminalTicketStatus(t.status));
    if (epics.length === 0) return;

    for (const epic of epics) {
      const children = repoTickets.filter((t) => t.parentTicketId === epic.id);
      if (children.length === 0) continue;

      const childrenCost = children.reduce((sum, c) => sum + c.costUsd, 0);
      const epicRuns = await this.stateStore.listStageRuns(epic.id);
      const epicOwnCost = epicRuns.reduce((sum, r) => sum + r.costUsd, 0);
      const totalCost = childrenCost + epicOwnCost;

      if (this.activeTicketRuns.has(epic.id) || this.finalizingEpics.has(epic.id)) {
        if (Math.abs(epic.costUsd - totalCost) > 0.0001) {
          const updatedCost: Ticket = { ...epic, costUsd: totalCost, updatedAt: nowIso() };
          await this.stateStore.saveTicket(updatedCost);
          this.emitEvent({
            type: "ticket_updated",
            ticket: updatedCost,
            timestamp: updatedCost.updatedAt,
          });
        }
        continue;
      }

      const allDelivered = children.every((c) => c.status === "delivered");
      const allCancelled = children.every((c) => c.status === "cancelled");
      const blockedChild = children.find(
        (c) => c.status === "needs_human" || c.status === "failed",
      );

      let nextStatus: Ticket["status"] = epic.status;
      let nextError: string | undefined = epic.errorMessage;
      let shouldFinalizeUnified = false;

      if (allCancelled) {
        nextStatus = "cancelled";
        nextError = "All Epic subtasks were cancelled";
      } else if (blockedChild) {
        nextStatus = "needs_human";
        nextError = `Subtask ${blockedChild.subtaskKey ?? blockedChild.id} (${blockedChild.title}) requires attention: ${blockedChild.errorMessage ?? blockedChild.status}`;
      } else if (allDelivered) {
        if (epic.epicDeliveryMode === "per_subtask") {
          nextStatus = "delivered";
          nextError = undefined;
        } else {
          if (epic.status === "implementing") {
            shouldFinalizeUnified = true;
            nextStatus = "implementing";
            nextError = undefined;
          }
          // Preserve "queued" / "rebasing" / "outbox_pending" / "needs_human" while Epic finishes integration/delivery
        }
      } else {
        // Subtasks still running; if a previously blocked child was unblocked, return umbrella to implementing
        if (epic.status === "needs_human") {
          nextStatus = "implementing";
          nextError = undefined;
        }
      }

      let currentEpic = epic;
      if (
        epic.status !== nextStatus ||
        Math.abs(epic.costUsd - totalCost) > 0.0001 ||
        epic.errorMessage !== nextError
      ) {
        currentEpic = {
          ...epic,
          status: nextStatus,
          costUsd: totalCost,
          errorMessage: nextError,
          updatedAt: nowIso(),
        };
        await this.stateStore.saveTicket(currentEpic);
        this.emitEvent({
          type: "ticket_updated",
          ticket: currentEpic,
          timestamp: currentEpic.updatedAt,
        });
      }

      if (shouldFinalizeUnified) {
        this.finalizingEpics.add(currentEpic.id);
        try {
          await this.finalizeUnifiedEpic(currentEpic, repo);
        } finally {
          this.finalizingEpics.delete(currentEpic.id);
        }
      }
    }
  }

  private async finalizeUnifiedEpic(epic: Ticket, repo: RepoConfig): Promise<void> {
    const branchName = epic.branchName ?? `super-work/epic/${epic.id}`;
    await this.workspace.ensureBranch(repo.rootPath, branchName, repo.baseBranch);
    const ws = await this.workspace.prepareWorkspace(
      { ...epic, branchName },
      repo,
    );

    const ts = nowIso();
    const stageRun: StageRun = {
      id: newId("run"),
      ticketId: epic.id,
      stage: "rebase",
      engine: selectEngineForStage(repo, "rebase", epic.preferredEngine),
      status: "running",
      costUsd: 0,
      startedAt: ts,
    };

    const rebasingEpic: Ticket = {
      ...epic,
      branchName: ws.branchName,
      worktreePath: ws.worktreePath,
      status: "rebasing",
      currentStage: "rebase",
      updatedAt: ts,
    };
    await this.stateStore.saveTicket(rebasingEpic);
    await this.stateStore.saveStageRun(stageRun);
    this.emitEvent({ type: "ticket_updated", ticket: rebasingEpic, timestamp: ts });

    const rebaseRes = await this.workspace.rebaseOntoBase(ws.worktreePath, repo.baseBranch);
    if (!rebaseRes.ok) {
      const failedRun: StageRun = {
        ...stageRun,
        status: "failed",
        completedAt: nowIso(),
        summary: rebaseRes.conflictSummary ?? "Epic rebase conflict",
      };
      await this.stateStore.saveStageRun(failedRun);

      if (rebasingEpic.stageRetries < 1) {
        const retryEpic: Ticket = {
          ...rebasingEpic,
          status: "queued",
          currentStage: "implement",
          template: "fast",
          stageRetries: 1,
          mandate: { ...rebasingEpic.mandate, maxStageRetries: 1 },
          inlineMemory: {
            ...rebasingEpic.inlineMemory,
            activeHint: `All Epic subtasks merged into staging branch ${ws.branchName}, but rebasing onto ${repo.baseBranch} failed: ${rebaseRes.conflictSummary}. Resolve integration conflicts across modules and re-verify.`,
          },
          updatedAt: nowIso(),
        };
        await this.stateStore.saveTicket(retryEpic);
        this.emitEvent({ type: "ticket_updated", ticket: retryEpic, timestamp: retryEpic.updatedAt });
      } else {
        await this.escalateTicket(
          rebasingEpic,
          "merge_conflict",
          `Epic integration rebase onto ${repo.baseBranch} conflicted: ${rebaseRes.conflictSummary}`,
          { branchName: ws.branchName },
        );
      }
      return;
    }

    const gate = await this.runRepoVerificationGate(rebasingEpic, repo, stageRun, ws.worktreePath);
    const changedFiles = await this.workspace.getChangedFiles(ws.worktreePath, repo.baseBranch);
    const diffText = await this.workspace.getDiff(ws.worktreePath, repo.baseBranch);

    if (!gate.passed) {
      const failedSummary = gate.result?.summary ?? "Epic final verification gate failed";
      const failedRun: StageRun = {
        ...stageRun,
        status: "failed",
        completedAt: nowIso(),
        summary: failedSummary,
      };
      const { note: failNote } = await this.memory.recordStageSpillAndNote({
        ticket: rebasingEpic,
        stageRun: failedRun,
        events: [],
        changedFiles,
        diffText,
        summary: failedSummary,
        verificationPassed: false,
        extraArtifacts: gate.artifact ? [gate.artifact] : undefined,
      });
      failedRun.spillTranscriptId = failNote.spillArtifactIds[0];
      await this.stateStore.saveStageRun(failedRun);

      if (rebasingEpic.stageRetries < 1) {
        const fixupEpic: Ticket = {
          ...rebasingEpic,
          status: "queued",
          currentStage: "implement",
          template: "fast",
          stageRetries: 1,
          mandate: { ...rebasingEpic.mandate, maxStageRetries: 1 },
          inlineMemory: {
            ...rebasingEpic.inlineMemory,
            stageNotes: [...rebasingEpic.inlineMemory.stageNotes, failNote],
            activeHint: `All Epic subtasks merged into staging branch ${ws.branchName}, but the final Epic integration verification failed (${gate.result?.failedCommand ?? "checks"}). Fix cross-module integration issues and pass checks:\n${failedSummary}`,
          },
          updatedAt: nowIso(),
        };
        await this.stateStore.saveTicket(fixupEpic);
        this.emitEvent({ type: "ticket_updated", ticket: fixupEpic, timestamp: fixupEpic.updatedAt });
      } else {
        await this.escalateTicket(
          {
            ...rebasingEpic,
            inlineMemory: {
              ...rebasingEpic.inlineMemory,
              stageNotes: [...rebasingEpic.inlineMemory.stageNotes, failNote],
            },
          },
          "watchdog_escalation",
          `Epic final verification failed after integration fixup: ${failedSummary}`,
          { stageRunId: stageRun.id, failedCommand: gate.result?.failedCommand },
        );
      }
      return;
    }

    const finishedRun: StageRun = {
      ...stageRun,
      status: "completed",
      completedAt: nowIso(),
      summary: gate.artifact
        ? `Epic staging branch verified on ${ws.branchName}; ${gate.result?.summary ?? "verification passed"}`
        : `Epic staging branch ${ws.branchName} rebased cleanly onto ${repo.baseBranch}`,
    };
    const { note } = await this.memory.recordStageSpillAndNote({
      ticket: rebasingEpic,
      stageRun: finishedRun,
      events: [],
      changedFiles,
      diffText,
      summary: finishedRun.summary!,
      verificationPassed: true,
      extraArtifacts: gate.artifact ? [gate.artifact] : undefined,
    });
    finishedRun.spillTranscriptId = note.spillArtifactIds[0];
    await this.stateStore.saveStageRun(finishedRun);
    this.emitEvent({
      type: "stage_completed",
      ticketId: rebasingEpic.id,
      stageRun: finishedRun,
      note,
      timestamp: finishedRun.completedAt!,
    });

    await this.enqueueDeliveryOutbox(
      {
        ...rebasingEpic,
        inlineMemory: {
          ...rebasingEpic.inlineMemory,
          stageNotes: [...rebasingEpic.inlineMemory.stageNotes, note],
        },
      },
      repo,
    );
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
