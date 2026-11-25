import {
  createCampaignOp,
  deleteCampaignOp,
  deliverCampaignOp,
  onCampaignTicketSettledOp,
  pauseCampaignOp,
  startCampaignOp,
} from "./kernel/campaign-coordinator.ts";
import {
  getTicketCheckpointDiffOp,
  mutateDagNodeOp,
  restoreTicketCheckpointOp,
} from "./kernel/checkpoint-dag-coordinator.ts";
import type { KernelCoordinatorContext } from "./kernel/context.ts";
import {
  addOrUpdatePlaybookRuleOp,
  auditPlaybookHygieneOp,
  pruneNoisyPlaybooksOp,
  exportRepoContractOp,
  generateAndSaveHandoverDigestOp,
  maybeDistillClosedLoopLessonOp,
  prunePlaybookEntriesOp,
  recordDeliveredCasebookEntryOp,
  syncRepoContractOp,
} from "./kernel/contract-playbook-coordinator.ts";
import {
  createSystemBackup,
  listSystemBackups,
  restoreSystemBackup as restoreSystemBackupOp,
  runSystemDoctor,
} from "./kernel/doctor-backup-coordinator.ts";
import { maybeEvaluateEpicReplanOp } from "./kernel/epic-replan-coordinator.ts";
import {
  createEvalCaseFromTicket as createEvalCaseFromTicketOp,
  runEvalCase as runEvalCaseOp,
} from "./kernel/eval-coordinator.ts";
import { batchResolveInboxOp, resolveInboxItemOp } from "./kernel/inbox-resolution-coordinator.ts";
import {
  type CreateMilestoneInput,
  type ReleaseMilestoneOptions,
  createMilestoneOp,
  releaseMilestoneOp,
  syncMilestonesOp,
} from "./kernel/milestone-coordinator.ts";
import {
  exportRepoKnowledgeBundle as exportRepoKnowledgeBundleOp,
  importRepoKnowledgeBundle as importRepoKnowledgeBundleOp,
} from "./kernel/knowledge-bundle-coordinator.ts";
import { executeLifecycleHookOp } from "./kernel/lifecycle-hooks.ts";
import {
  ejectMergeTrainEntryOp,
  ensureMergeTrainForOutboxOp,
  flushMergeTrainOp,
} from "./kernel/merge-train-coordinator.ts";
import { submitTicketReviewComments, updateReviewCommentStatusOp } from "./kernel/review-comments-coordinator.ts";
import {
  createRoutineSpec,
  deleteRoutineSpec,
  processDueRoutinesTick,
  triggerRoutineNowSpec,
  updateRoutineSpec,
} from "./kernel/routine-coordinator.ts";
import { triggerManualSelfReloadOp } from "./kernel/self-host-coordinator.ts";
import { MemoryManager } from "./memory.ts";
import { OutboxFatalError, OutboxProcessor } from "./outbox.ts";
import type { PlaybookHygieneReport } from "./playbook-hygiene.ts";
import type {
  ArtifactStore,
  ControlPlaneLLM,
  CreateEpicInput,
  DirectTicketInput,
  IngestTriggerInput,
  KernelConfig,
  OutboxExecutor,
  PreviewProvider,
  RepoProbeExecutor,
  SelfHostRunner,
  StateStore,
  WorkerDriver,
  WorkspaceProvider,
} from "./ports.ts";
import { EventIntakeRouter, type IngestResult } from "./router.ts";
import type {
  BackupArchiveInfo,
  BackupRestoreResult,
  BatchResolveInboxInput,
  BatchResolveInboxResult,
  ChiefAskInput,
  ChiefAskResult,
  CreateCampaignInput,
  DagNodeMutationInput,
  EpicDecompositionPlan,
  EvalCase,
  EvalRunRecord,
  EngineHealthRecord,
  FlightEvent,
  GoalCampaign,
  GoalCampaignWave,
  ImportKnowledgeBundleResult,
  InboxItem,
  KernelEvent,
  ManagedWorktreeItem,
  MergeTrainEntry,
  Milestone,
  OutboxAction,
  RunDigestReport,
  OutboxEntry,
  PipelineTemplateId,
  PlaybookEntry,
  PreviewSession,
  RepoConfig,
  ReviewEvidencePacket,
  RepoContractFile,
  RepoKnowledgeBundle,
  RequirementIntakeInput,
  RequirementIntakePlan,
  RequirementIntakeResult,
  RestoreCheckpointInput,
  ReviewCommentStatus,
  RoutineRun,
  RoutineScheduleKind,
  RoutineSpec,
  SelfReloadState,
  SpecClarificationInput,
  SpecClarificationResult,
  StageKind,
  SteerTicketInput,
  SubmitReviewCommentsInput,
  SymbolImpactReport,
  SystemDoctorReport,
  TaskBlueprint,
  Ticket,
  TicketCheckpoint,
  TicketReviewComment,
  WorkerEngineId,
  WorktreeGcResult,
} from "./types.ts";
import { newId, nowIso } from "./utils.ts";
import { DEFAULT_WATCHDOG_CONFIG, TwoTierWatchdog } from "./watchdog.ts";
import {
  cancelTicketOp,
  captureTicketCheckpointOp,
  clarifySpecOp,
  enqueueDeliveryOutboxOp,
  escalateTicketOp,
  intakeRequirementOp,
  onOutboxTicketDeliveredOp,
  revertTicketDeliveryOp,
  steerTicketOp,
  triggerTicketDeliveryOp,
} from "./kernel/kernel-ticket-ops.ts";
import {
  cleanupTicketWorktreeOp,
  gcWorktreesOp,
  getEffectiveBaseInfoOp,
  getEffectiveDailyBudget,
  hasUnfinishedDependenciesOp,
  inspectWorktreesOp,
  performTickOp,
  recoverInterruptedRunsOp,
  runUntilIdleOp,
  startTicketPreviewOp,
} from "./kernel/kernel-runtime-ops.ts";
import {
  analyzeRepoImpactOp,
  askChiefOp,
  buildEnrichedWorkerPromptOp,
  getRunDigestOp,
  listRepoBlueprintsOp,
} from "./kernel/kernel-knowledge-ops.ts";

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
  previewProvider?: PreviewProvider;
  selfHostRunner?: SelfHostRunner;
  dataDir?: string;
  config?: Partial<KernelConfig>;
}

export class SuperWorkKernel {
  readonly config: KernelConfig;
  readonly stateStore: StateStore;
  readonly artifactStore: ArtifactStore;
  readonly workspace: WorkspaceProvider;
  readonly llm: ControlPlaneLLM;
  readonly memory: MemoryManager;
  readonly router: EventIntakeRouter;
  readonly watchdog: TwoTierWatchdog;
  readonly outbox: OutboxProcessor;
  readonly outboxExecutor: OutboxExecutor;
  readonly previewProvider?: PreviewProvider;
  readonly selfHostRunner?: SelfHostRunner;
  readonly dataDir: string;

  private readonly drivers = new Map<WorkerEngineId, WorkerDriver>();
  private readonly listeners = new Set<(event: KernelEvent) => void>();
  private readonly activeTicketRuns = new Map<string, Promise<void>>();
  private readonly activeRoutineRuns = new Set<string>();
  private readonly repoWorkspaceLocks = new Map<string, Promise<void>>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly pendingSteers = new Map<string, SteerTicketInput>();
  private readonly finalizingEpics = new Set<string>();
  private readonly epicMergeLocks = new Map<string, Promise<void>>();

  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private outboxTimer: ReturnType<typeof setInterval> | null = null;
  private tickingPromise: Promise<number> | null = null;
  private outboxFlushPromise: Promise<unknown> | null = null;
  private stopped = false;
  private selfReloadState: SelfReloadState;

  constructor(deps: SuperWorkKernelDeps) {
    this.config = {
      ...DEFAULT_KERNEL_CONFIG,
      ...deps.config,
      watchdog: { ...DEFAULT_WATCHDOG_CONFIG, ...deps.config?.watchdog },
    };
    this.stateStore = deps.stateStore;
    this.artifactStore = deps.artifactStore;
    this.workspace = deps.workspace;
    this.llm = deps.llm;
    this.outboxExecutor = deps.outboxExecutor;
    this.previewProvider = deps.previewProvider;
    this.selfHostRunner = deps.selfHostRunner;
    this.dataDir = deps.dataDir ?? ".super-work";
    this.selfReloadState = {
      phase: "idle",
      ...(deps.selfHostRunner ? { selfRepoRoot: deps.selfHostRunner.selfRepoRoot } : {}),
      updatedAt: nowIso(),
    };
    this.previewProvider?.subscribe?.((preview) => {
      this.emitEvent({ type: "preview_updated", preview, timestamp: nowIso() });
    });

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
      deps.workspace.analyzeSymbolImpact?.bind(deps.workspace),
      deps.workspace.runRepoPreProbe?.bind(deps.workspace),
      deps.workspace.executeRepoProbeTool?.bind(deps.workspace),
    );
    this.watchdog = new TwoTierWatchdog(deps.llm, this.config.watchdog);
    this.outbox = new OutboxProcessor(
      deps.stateStore,
      deps.outboxExecutor,
      emit,
      this.config.outboxMaxAttempts,
      async (deliveredTicket, repo, entry) => this.onOutboxTicketDelivered(deliveredTicket, repo, entry),
      {
        skipActions: new Set<OutboxAction>(["local_merge"]),
        onBeforeExecute: async (_entry, repo, ticket) => {
          const hookRes = await executeLifecycleHookOp(
            this.coordinatorCtx(),
            "pre_deliver",
            ticket,
            repo,
          );
          if (!hookRes.ok) {
            throw new OutboxFatalError(`pre_deliver hook blocked delivery: ${hookRes.summary}`);
          }
        },
      },
    );
  }

  private async onOutboxTicketDelivered(
    deliveredTicket: Ticket,
    repo: RepoConfig,
    entry: OutboxEntry,
  ): Promise<void> {
    return onOutboxTicketDeliveredOp(this.coordinatorCtx(), () => this.coordinatorCtx(), deliveredTicket, repo, entry);
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

  /** Best-effort persistent Flight Recorder write; never throws into the kernel loop. */
  async recordFlightEvent(event: Omit<FlightEvent, "id" | "createdAt">): Promise<void> {
    if (!this.stateStore.recordFlightEvent) return;
    try {
      await this.stateStore.recordFlightEvent({ ...event, id: newId("fev"), createdAt: nowIso() });
    } catch {
      // Flight recorder failures must never block delivery, reload or rollback paths
    }
  }

  async listEngineHealth(): Promise<EngineHealthRecord[]> {
    return (await this.stateStore.listEngineHealth?.()) ?? [];
  }

  async resetEngineHealth(engine: WorkerEngineId): Promise<EngineHealthRecord> {
    const now = nowIso();
    const record: EngineHealthRecord = { engine, status: "healthy", consecutiveFailures: 0, updatedAt: now };
    await this.stateStore.saveEngineHealth?.(record);
    return record;
  }

  /**
   * Clears the cooldown of tripped engines so the next stage re-probes them with a real turn;
   * a still-broken engine re-trips immediately on its first deterministic error.
   */
  async reprobeEngineHealth(engine?: WorkerEngineId): Promise<EngineHealthRecord[]> {
    const now = nowIso();
    const all = await this.listEngineHealth();
    const out: EngineHealthRecord[] = [];
    for (const rec of all) {
      if (rec.status !== "tripped" || (engine && rec.engine !== engine)) continue;
      const next: EngineHealthRecord = {
        ...rec,
        status: "healthy",
        cooldownUntil: undefined,
        lastProbedAt: now,
        updatedAt: now,
      };
      await this.stateStore.saveEngineHealth?.(next);
      out.push(next);
    }
    return out;
  }

  async listFlightEvents(filter?: {
    repoId?: string;
    limit?: number;
    sinceIso?: string;
  }): Promise<FlightEvent[]> {
    return (await this.stateStore.listFlightEvents?.(filter)) ?? [];
  }

  async getRunDigest(options?: { repoId?: string; hours?: number }): Promise<RunDigestReport> {
    return getRunDigestOp(this.coordinatorCtx(), options);
  }

  private coordinatorCtx(): KernelCoordinatorContext {
    return {
      stateStore: this.stateStore,
      artifactStore: this.artifactStore,
      workspace: this.workspace,
      memory: this.memory,
      llm: this.llm,
      watchdog: this.watchdog,
      outboxExecutor: this.outboxExecutor,
      previewProvider: this.previewProvider,
      selfHostRunner: this.selfHostRunner,
      selfReloadState: this.selfReloadState,
      setSelfReloadState: (next) => {
        this.selfReloadState = next;
      },
      hasActiveOutboxFlush: () => Boolean(this.outboxFlushPromise),
      revertTicketDelivery: (ticketId) => this.revertTicketDelivery(ticketId),
      dataDir: this.dataDir,
      drivers: this.drivers,
      activeTicketRuns: this.activeTicketRuns,
      activeRoutineRuns: this.activeRoutineRuns,
      abortControllers: this.abortControllers,
      pendingSteers: this.pendingSteers,
      finalizingEpics: this.finalizingEpics,
      isStopped: () => this.stopped,
      emitEvent: (event) => this.emitEvent(event),
      recordFlightEvent: (event) => this.recordFlightEvent(event),
      getAvailableEngines: () => this.getAvailableEngines(),
      getEffectiveDailyBudget: (repo, utcDate) => getEffectiveDailyBudget(repo, utcDate),
      createRepoProbeExecutor: (repo) => this.createRepoProbeExecutor(repo),
      runWithRepoWorkspaceLock: (repoId, fn) => this.runWithRepoWorkspaceLock(repoId, fn),
      runWithEpicLock: (epicId, fn) => this.runWithEpicLock(epicId, fn),
      getEffectiveBaseInfo: async (ticket, repo) => {
        const info = await this.getEffectiveBaseInfo(ticket, repo);
        return {
          effectiveBaseBranch: info.effectiveBaseBranch,
          parentEpic: info.parentEpic ?? undefined,
        };
      },
      hasUnfinishedDependencies: (ticket) => this.hasUnfinishedDependencies(ticket),
      buildEnrichedWorkerPrompt: (ticket, repo, stage, options) =>
        this.buildEnrichedWorkerPrompt(ticket, repo, stage, options),
      captureTicketCheckpoint: (ticket, repo, worktreePath, opts) =>
        this.captureTicketCheckpoint(ticket, repo, worktreePath, opts),
      runRepoVerificationGate: (ticket, repo, stageRun, worktreePath, options) =>
        import("./kernel/stage-execution-coordinator.ts").then((m) =>
          m.runRepoVerificationGateOp(this.coordinatorCtx(), ticket, repo, stageRun, worktreePath, options),
        ),
      enqueueDeliveryOutbox: (ticket, repoArg) => this.enqueueDeliveryOutbox(ticket, repoArg),
      onOutboxTicketDelivered: (ticket, repo, entry) =>
        this.onOutboxTicketDelivered(ticket, repo, entry),
      escalateTicket: (ticket, kind, summary, contextPayload) =>
        this.escalateTicket(ticket, kind, summary, contextPayload),
      createDirectTicket: (input) => this.router.createDirectTicket(input),
      createEpic: (input) => this.createEpic(input),
      createCampaign: (input) => this.createCampaign(input),
      previewRequirementIntake: (input) => this.previewRequirementIntake(input),
      inspectWorktrees: (repoId) => this.inspectWorktrees(repoId),
      gcWorktrees: (options) => this.gcWorktrees(options),
      cleanupTicketWorktree: (ticketId) => this.cleanupTicketWorktree(ticketId),
      addOrUpdatePlaybookRule: (input) => addOrUpdatePlaybookRuleOp(this.coordinatorCtx(), input),
      maybeDistillClosedLoopLesson: (ticket, repoArg) =>
        maybeDistillClosedLoopLessonOp(this.coordinatorCtx(), ticket, repoArg),
      generateAndSaveHandoverDigest: (ticket, repo, precomputed) =>
        generateAndSaveHandoverDigestOp(this.coordinatorCtx(), ticket, repo, precomputed),
      recordDeliveredCasebookEntry: (ticket) =>
        recordDeliveredCasebookEntryOp(this.coordinatorCtx(), ticket),
      maybeEvaluateEpicReplan: (epicId, completedSubtask) =>
        maybeEvaluateEpicReplanOp(this.coordinatorCtx(), epicId, completedSubtask),
      onCampaignTicketSettled: (ticket, repo) =>
        onCampaignTicketSettledOp(this.coordinatorCtx(), ticket, repo),
      ensureMergeTrainForOutbox: (entry, ticket, repo) =>
        ensureMergeTrainForOutboxOp(this.coordinatorCtx(), entry, ticket, repo),
    };
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
        void this.flushOutbox();
      }, this.config.outboxIntervalMs);
    }
  }

  flushOutbox(): Promise<unknown> {
    if (this.stopped) return Promise.resolve();
    if (this.outboxFlushPromise) {
      return this.outboxFlushPromise;
    }
    this.outboxFlushPromise = Promise.all([
      flushMergeTrainOp(this.coordinatorCtx()),
      this.outbox.processDueEntries(),
    ]).finally(() => {
      this.outboxFlushPromise = null;
    });
    return this.outboxFlushPromise;
  }

  async recoverInterruptedRuns(): Promise<{ recoveredTickets: number; requeuedOutbox: number }> {
    return recoverInterruptedRunsOp(this.coordinatorCtx());
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
    if (this.tickingPromise) {
      await Promise.allSettled([this.tickingPromise]);
    }
    for (const ctrl of this.abortControllers.values()) {
      ctrl.abort("kernel_shutdown");
    }
    const pending: Array<Promise<unknown>> = Array.from(this.activeTicketRuns.values());
    if (this.outboxFlushPromise) {
      pending.push(this.outboxFlushPromise);
    }
    await Promise.allSettled(pending);
    await this.previewProvider?.stopAll().catch(() => {});
  }

  async ingestTrigger(input: IngestTriggerInput): Promise<IngestResult> {
    await this.syncRepoContract(input.repoId);
    return this.router.ingestTrigger(input);
  }

  async createDirectTicket(input: DirectTicketInput): Promise<Ticket> {
    await this.syncRepoContract(input.repoId);
    return this.router.createDirectTicket(input);
  }

  async previewEpic(input: {
    repoId: string;
    title: string;
    description: string;
    template?: PipelineTemplateId;
  }): Promise<EpicDecompositionPlan> {
    await this.syncRepoContract(input.repoId);
    return this.router.previewEpic(input);
  }

  async createEpic(input: CreateEpicInput): Promise<{ epic: Ticket; subtasks: Ticket[] }> {
    const allRepos = await this.stateStore.listRepos();
    await Promise.all(allRepos.map((r) => this.syncRepoContract(r.id).catch(() => null)));
    await this.syncRepoContract(input.repoId);
    return this.router.createEpic(input);
  }

  getSelfReloadState(): SelfReloadState {
    return this.selfReloadState;
  }

  isDraining(): boolean {
    return (
      this.selfReloadState.phase === "draining" ||
      this.selfReloadState.phase === "reloading"
    );
  }

  async triggerSelfReload(options?: {
    force?: boolean;
    skipCanary?: boolean;
  }): Promise<SelfReloadState> {
    return triggerManualSelfReloadOp(this.coordinatorCtx(), options);
  }

  async previewRequirementIntake(
    input: RequirementIntakeInput,
  ): Promise<RequirementIntakePlan> {
    const allRepos = await this.stateStore.listRepos();
    await Promise.all(allRepos.map((r) => this.syncRepoContract(r.id).catch(() => null)));
    await this.syncRepoContract(input.repoId);
    return this.router.previewRequirementIntake(input);
  }

  async intakeRequirement(
    input: RequirementIntakeInput,
  ): Promise<RequirementIntakeResult> {
    return intakeRequirementOp(this.coordinatorCtx(), input);
  }

  async syncRepoContract(repoId: string, force = false): Promise<RepoConfig | null> {
    return syncRepoContractOp(this.coordinatorCtx(), repoId, force);
  }

  async exportRepoContract(
    repoId: string,
  ): Promise<{ repo: RepoConfig; contract: RepoContractFile; filePath: string }> {
    return exportRepoContractOp(this.coordinatorCtx(), repoId);
  }

  async addOrUpdatePlaybookRule(input: {
    repoId: string;
    rule: string;
    scopePaths?: string[];
    source: PlaybookEntry["source"];
    sourceTicketId?: string;
    pinned?: boolean;
    enabled?: boolean;
  }): Promise<PlaybookEntry | null> {
    return addOrUpdatePlaybookRuleOp(this.coordinatorCtx(), input);
  }

  async revertTicketDelivery(
    ticketId: string,
  ): Promise<{ ticket: Ticket; revertCommitSha: string }> {
    return revertTicketDeliveryOp(this.coordinatorCtx(), ticketId);
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

  private createRepoProbeExecutor(repo: RepoConfig): RepoProbeExecutor | undefined {
    const provider = this.workspace.executeRepoProbeTool;
    if (!provider) return undefined;
    let step = 0;
    return (req) => {
      step += 1;
      return provider.call(this.workspace, repo.rootPath, req, repo.forbiddenPaths, step);
    };
  }

  async steerTicket(ticketId: string, input: SteerTicketInput): Promise<Ticket> {
    return steerTicketOp(this.coordinatorCtx(), ticketId, input);
  }

  async cancelTicket(ticketId: string, reason = "Cancelled by user"): Promise<Ticket> {
    return cancelTicketOp(this.coordinatorCtx(), ticketId, reason);
  }

  async cleanupTicketWorktree(ticketId: string): Promise<Ticket | null> {
    return cleanupTicketWorktreeOp(this.coordinatorCtx(), ticketId);
  }

  async inspectWorktrees(repoId?: string): Promise<ManagedWorktreeItem[]> {
    return inspectWorktreesOp(this.coordinatorCtx(), repoId);
  }

  async clarifySpec(input: SpecClarificationInput): Promise<SpecClarificationResult> {
    return clarifySpecOp(this.coordinatorCtx(), input);
  }

  async listPreviews(repoId?: string): Promise<PreviewSession[]> {
    if (!this.previewProvider) return [];
    return this.previewProvider.listPreviews(repoId);
  }

  async startTicketPreview(
    ticketId: string,
    candidateId?: string,
    ttlMinutes?: number,
  ): Promise<PreviewSession> {
    return startTicketPreviewOp(this.coordinatorCtx(), ticketId, candidateId, ttlMinutes);
  }

  async renewPreview(previewId: string, ttlMinutes?: number): Promise<PreviewSession | null> {
    if (!this.previewProvider) return null;
    return this.previewProvider.renewPreview(previewId, ttlMinutes);
  }

  async stopPreview(previewId: string): Promise<PreviewSession | null> {
    if (!this.previewProvider) return null;
    return this.previewProvider.stopPreview(previewId);
  }

  async gcWorktrees(options?: { repoId?: string }): Promise<WorktreeGcResult> {
    return gcWorktreesOp(this.coordinatorCtx(), options);
  }

  async resolveInboxItem(
    inboxId: string,
    decision: "approved" | "rejected",
    note?: string,
    options?: {
      deliveryAction?: "local_merge" | "push_and_create_pr";
      expandMandate?: boolean;
      budgetIncreaseUsd?: number;
      saveToPlaybook?: boolean;
      arenaWinnerId?: string;
      selectedOption?: string;
    },
  ): Promise<{ item: InboxItem; ticket: Ticket }> {
    return resolveInboxItemOp(this.coordinatorCtx(), inboxId, decision, note, options);
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
    return performTickOp(this.coordinatorCtx(), this.router, this.config);
  }

  async runUntilIdle(maxCycles = 30): Promise<void> {
    return runUntilIdleOp(this.coordinatorCtx(), () => this.tick(), this.outbox, maxCycles);
  }

  private async hasUnfinishedDependencies(ticket: Ticket): Promise<boolean> {
    return hasUnfinishedDependenciesOp(this.coordinatorCtx(), ticket);
  }

  private async getEffectiveBaseInfo(
    ticket: Ticket,
    repo: RepoConfig,
  ): Promise<{ effectiveBaseBranch: string; parentEpic: Ticket | null }> {
    return getEffectiveBaseInfoOp(this.coordinatorCtx(), ticket, repo);
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

  private async captureTicketCheckpoint(
    ticket: Ticket,
    repo: RepoConfig,
    worktreePath: string,
    opts: {
      stage: StageKind | "baseline";
      stageRunId?: string;
      engine?: WorkerEngineId;
      label: string;
      changedFiles: string[];
      verificationPassed?: boolean;
    },
  ): Promise<TicketCheckpoint | null> {
    return captureTicketCheckpointOp(this.coordinatorCtx(), ticket, repo, worktreePath, opts);
  }

  private async enqueueDeliveryOutbox(ticket: Ticket, repoArg?: RepoConfig): Promise<void> {
    return enqueueDeliveryOutboxOp(this.coordinatorCtx(), ticket, repoArg);
  }

  async triggerTicketDelivery(
    ticketId: string,
    action: "local_merge" | "push_and_create_pr",
  ): Promise<{ ticket: Ticket; entry: OutboxEntry }> {
    return triggerTicketDeliveryOp(this.coordinatorCtx(), this.outbox, ticketId, action);
  }

  private async escalateTicket(
    ticket: Ticket,
    kind: InboxItem["kind"],
    reason: string,
    contextPayload: Record<string, unknown>,
  ): Promise<void> {
    return escalateTicketOp(this.coordinatorCtx(), ticket, kind, reason, contextPayload);
  }

  private async runWithRepoWorkspaceLock<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.repoWorkspaceLocks.get(repoId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((res) => {
      release = res;
    });
    const chained = prev.then(() => next);
    this.repoWorkspaceLocks.set(repoId, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.repoWorkspaceLocks.get(repoId) === chained) {
        this.repoWorkspaceLocks.delete(repoId);
      }
    }
  }

  private async buildEnrichedWorkerPrompt(
    ticket: Ticket,
    repo: RepoConfig,
    stage: StageKind,
    options?: { skipHitTracking?: boolean; reviewEvidence?: ReviewEvidencePacket; worktreePath?: string },
  ): Promise<string> {
    return buildEnrichedWorkerPromptOp(this.coordinatorCtx(), ticket, repo, stage, options);
  }

  async prunePlaybookEntries(
    repoId: string,
  ): Promise<{ prunedIds: string[]; keptCount: number }> {
    return prunePlaybookEntriesOp(this.coordinatorCtx(), repoId);
  }

  async auditPlaybookHygiene(repoId?: string): Promise<PlaybookHygieneReport> {
    return auditPlaybookHygieneOp(this.coordinatorCtx(), repoId);
  }

  async pruneNoisyPlaybooks(
    repoId?: string,
    options?: { dryRun?: boolean; mode?: "disable" | "delete" },
  ): Promise<{
    audited: PlaybookHygieneReport;
    affectedIds: string[];
    mode: "disable" | "delete";
    dryRun: boolean;
  }> {
    return pruneNoisyPlaybooksOp(this.coordinatorCtx(), repoId, options);
  }

  // --- Routines ---
  async createRoutine(input: {
    repoId: string;
    name: string;
    prompt: string;
    scheduleKind: RoutineScheduleKind;
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
  }): Promise<RoutineSpec> {
    return createRoutineSpec(this.coordinatorCtx(), input);
  }

  async updateRoutine(
    id: string,
    patch: Partial<Omit<RoutineSpec, "id" | "repoId" | "createdAt" | "updatedAt">>,
  ): Promise<RoutineSpec> {
    return updateRoutineSpec(this.coordinatorCtx(), id, patch);
  }

  async deleteRoutine(id: string): Promise<boolean> {
    return deleteRoutineSpec(this.coordinatorCtx(), id);
  }

  async triggerRoutineNow(routineId: string): Promise<RoutineRun> {
    return triggerRoutineNowSpec(this.coordinatorCtx(), routineId);
  }

  async processDueRoutines(now = new Date()): Promise<number> {
    return processDueRoutinesTick(this.coordinatorCtx(), now);
  }

  // --- Milestones (v1.4.0 Direction B) ---
  async createMilestone(input: CreateMilestoneInput): Promise<Milestone> {
    return createMilestoneOp(this.coordinatorCtx(), input);
  }

  async getMilestone(id: string): Promise<Milestone | null> {
    return (await this.stateStore.getMilestone?.(id)) ?? null;
  }

  async listMilestones(repoId?: string): Promise<Milestone[]> {
    return (await this.stateStore.listMilestones?.(repoId)) ?? [];
  }

  async syncMilestones(repoId: string): Promise<void> {
    await syncMilestonesOp(this.coordinatorCtx(), repoId);
  }

  /** Explicit-only release (REST / CLI / Inbox signoff); never invoked by the scheduler. */
  async releaseMilestone(id: string, options: ReleaseMilestoneOptions = {}): Promise<Milestone> {
    return releaseMilestoneOp(this.coordinatorCtx(), id, options);
  }

  // --- Goal Campaigns (v1.2.0 Pillar A) ---
  async createCampaign(input: CreateCampaignInput): Promise<GoalCampaign> {
    return createCampaignOp(this.coordinatorCtx(), input);
  }

  async listCampaigns(repoId?: string): Promise<GoalCampaign[]> {
    return this.stateStore.listCampaigns ? this.stateStore.listCampaigns(repoId) : [];
  }

  async getCampaign(
    id: string,
  ): Promise<{ campaign: GoalCampaign; waves: GoalCampaignWave[] } | null> {
    const campaign = await this.stateStore.getCampaign?.(id);
    if (!campaign) return null;
    const waves = (await this.stateStore.listCampaignWaves?.(id)) ?? [];
    return { campaign, waves };
  }

  async startCampaign(id: string, options?: { note?: string }): Promise<GoalCampaign> {
    return startCampaignOp(this.coordinatorCtx(), id, options);
  }

  async pauseCampaign(id: string, reason?: string): Promise<GoalCampaign> {
    return pauseCampaignOp(this.coordinatorCtx(), id, reason);
  }

  async deliverCampaign(
    id: string,
    action: "local_merge" | "push_and_create_pr" = "local_merge",
  ): Promise<GoalCampaign> {
    return deliverCampaignOp(this.coordinatorCtx(), id, action);
  }

  async deleteCampaign(id: string): Promise<boolean> {
    return deleteCampaignOp(this.coordinatorCtx(), id);
  }

  // --- Speculative Merge Train (v1.2.0 Pillar B) ---
  async listMergeTrain(repoId?: string): Promise<MergeTrainEntry[]> {
    return this.stateStore.listMergeTrainEntries
      ? this.stateStore.listMergeTrainEntries(repoId ? { repoId } : undefined)
      : [];
  }

  async flushMergeTrain(repoId?: string): Promise<number> {
    return flushMergeTrainOp(this.coordinatorCtx(), repoId);
  }

  async ejectMergeTrainEntry(entryId: string, reason?: string): Promise<MergeTrainEntry> {
    return ejectMergeTrainEntryOp(this.coordinatorCtx(), entryId, reason);
  }

  // --- Impact, Checkpoints, DAG, Blueprints, Review Comments, Doctor, Chief, Evals ---
  async analyzeRepoImpact(repoId: string, paths: string[]): Promise<SymbolImpactReport> {
    return analyzeRepoImpactOp(this.coordinatorCtx(), repoId, paths);
  }

  async listTicketCheckpoints(ticketId: string): Promise<TicketCheckpoint[]> {
    return this.stateStore.listCheckpoints(ticketId);
  }

  async getTicketCheckpointDiff(
    ticketId: string,
    checkpointId: string,
    baseCheckpointId?: string,
  ): Promise<{ diff: string; fromSha: string; toSha: string }> {
    return getTicketCheckpointDiffOp(this.coordinatorCtx(), ticketId, checkpointId, baseCheckpointId);
  }

  async restoreTicketCheckpoint(
    ticketId: string,
    checkpointId: string,
    input?: RestoreCheckpointInput,
  ): Promise<{ mode: "in_place" | "fork"; ticket: Ticket }> {
    return restoreTicketCheckpointOp(this.coordinatorCtx(), ticketId, checkpointId, input);
  }

  async mutateDagNode(ticketId: string, input: DagNodeMutationInput): Promise<Ticket> {
    return mutateDagNodeOp(this.coordinatorCtx(), ticketId, input);
  }

  async listRepoBlueprints(repoId: string): Promise<TaskBlueprint[]> {
    return listRepoBlueprintsOp(this.coordinatorCtx(), repoId);
  }

  async listTicketReviewComments(ticketId: string): Promise<TicketReviewComment[]> {
    return this.stateStore.listReviewComments(ticketId);
  }

  async submitTicketReviewComments(
    ticketId: string,
    input: SubmitReviewCommentsInput,
  ): Promise<{ comments: TicketReviewComment[]; ticket: Ticket }> {
    return submitTicketReviewComments(this.coordinatorCtx(), ticketId, input);
  }

  async updateReviewCommentStatus(
    commentId: string,
    status: ReviewCommentStatus,
  ): Promise<TicketReviewComment | null> {
    return updateReviewCommentStatusOp(this.coordinatorCtx(), commentId, status);
  }

  async runSystemDoctor(options?: { fix?: boolean }): Promise<SystemDoctorReport> {
    return runSystemDoctor(this.coordinatorCtx(), options);
  }

  async createSystemBackup(): Promise<BackupArchiveInfo> {
    return createSystemBackup(this.coordinatorCtx());
  }

  async listSystemBackups(): Promise<BackupArchiveInfo[]> {
    return listSystemBackups(this.dataDir);
  }

  async batchResolveInbox(input: BatchResolveInboxInput): Promise<BatchResolveInboxResult> {
    return batchResolveInboxOp(this.coordinatorCtx(), input);
  }

  async askChief(input: ChiefAskInput): Promise<ChiefAskResult> {
    return askChiefOp(this.coordinatorCtx(), input);
  }

  async createEvalCaseFromTicket(ticketId: string): Promise<EvalCase> {
    return createEvalCaseFromTicketOp(this.coordinatorCtx(), ticketId);
  }

  async listEvalCases(repoId?: string): Promise<EvalCase[]> {
    return this.stateStore.listEvalCases ? this.stateStore.listEvalCases(repoId) : [];
  }

  async deleteEvalCase(id: string): Promise<boolean> {
    return this.stateStore.deleteEvalCase ? this.stateStore.deleteEvalCase(id) : false;
  }

  async runEvalCase(input: {
    evalCaseId: string;
    engines?: WorkerEngineId[];
    maxBudgetUsd?: number;
  }): Promise<EvalRunRecord> {
    return runEvalCaseOp(this.coordinatorCtx(), input);
  }

  async listEvalRuns(filter?: {
    repoId?: string;
    evalCaseId?: string;
    limit?: number;
  }): Promise<EvalRunRecord[]> {
    return this.stateStore.listEvalRuns ? this.stateStore.listEvalRuns(filter) : [];
  }

  async restoreSystemBackup(
    backupIdOrFilename: string,
    options?: { force?: boolean },
  ): Promise<BackupRestoreResult> {
    return restoreSystemBackupOp(this.coordinatorCtx(), backupIdOrFilename, options);
  }

  async exportRepoKnowledgeBundle(repoId: string): Promise<RepoKnowledgeBundle> {
    return exportRepoKnowledgeBundleOp(this.coordinatorCtx(), repoId);
  }

  async importRepoKnowledgeBundle(
    repoId: string,
    bundle: RepoKnowledgeBundle,
  ): Promise<ImportKnowledgeBundleResult> {
    return importRepoKnowledgeBundleOp(this.coordinatorCtx(), repoId, bundle);
  }
}
