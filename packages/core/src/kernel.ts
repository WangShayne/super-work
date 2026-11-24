import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { countDiffLines } from "./arena.ts";
import { resolveRepoBlueprints } from "./blueprints.ts";
import { runChiefOfStaffQuery } from "./chief.ts";
import { selectRelevantCasesForContext } from "./casebook.ts";
import { buildHandoverDigest } from "./handover.ts";
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
import { syncEpicStatusesOp } from "./kernel/epic-lifecycle-coordinator.ts";
import { maybeEvaluateEpicReplanOp } from "./kernel/epic-replan-coordinator.ts";
import {
  createEvalCaseFromTicket as createEvalCaseFromTicketOp,
  runEvalCase as runEvalCaseOp,
} from "./kernel/eval-coordinator.ts";
import { batchResolveInboxOp, resolveInboxItemOp } from "./kernel/inbox-resolution-coordinator.ts";
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
import { handleSelfHostPostMergeOp, triggerManualSelfReloadOp } from "./kernel/self-host-coordinator.ts";
import { runTicketStageOp } from "./kernel/stage-execution-coordinator.ts";
import { MemoryManager } from "./memory.ts";
import { OutboxFatalError, OutboxProcessor } from "./outbox.ts";
import { getFirstStage, getPipelineTemplate } from "./pipeline.ts";
import { formatPlaybookContext, selectPlaybookRulesForContext } from "./playbook.ts";
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
import { evaluateTicketRisk } from "./risk.ts";
import { EventIntakeRouter, type IngestResult } from "./router.ts";
import { applyClarificationAnswers, buildHeuristicSpecClarification } from "./spec-studio.ts";
import type {
  BackupArchiveInfo,
  BackupRestoreResult,
  BatchResolveInboxInput,
  BatchResolveInboxResult,
  CasebookEntry,
  ChiefAskInput,
  ChiefAskResult,
  CreateCampaignInput,
  DagNodeMutationInput,
  EpicDecompositionPlan,
  EvalCase,
  EvalRunRecord,
  GoalCampaign,
  GoalCampaignWave,
  HandoverDigest,
  ImportKnowledgeBundleResult,
  InboxItem,
  KernelEvent,
  ManagedWorktreeItem,
  MergeTrainEntry,
  OutboxAction,
  OutboxEntry,
  PipelineTemplateId,
  PlaybookEntry,
  PreviewSession,
  RepoConfig,
  RepoContractFile,
  RepoKnowledgeBundle,
  RequirementIntakeInput,
  RequirementIntakePlan,
  RequirementIntakeResult,
  RestoreCheckpointInput,
  ReviewCommentStatus,
  ReviewReport,
  RoutineRun,
  RoutineScheduleKind,
  RoutineSpec,
  SelfReloadState,
  SmokeCheckResult,
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
  previewProvider?: PreviewProvider;
  selfHostRunner?: SelfHostRunner;
  dataDir?: string;
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
    let currentTicket = deliveredTicket;
    const payloadPrNumber =
      typeof entry.resultPayload?.prNumber === "number" ? entry.resultPayload.prNumber : undefined;
    const payloadPrUrl =
      typeof entry.resultPayload?.prUrl === "string" ? entry.resultPayload.prUrl : undefined;
    const payloadMergeSha =
      entry.action === "local_merge" && typeof entry.resultPayload?.commitSha === "string"
        ? entry.resultPayload.commitSha
        : undefined;

    if (payloadPrNumber || payloadPrUrl || payloadMergeSha) {
      const prTs = nowIso();
      currentTicket = {
        ...currentTicket,
        prNumber: payloadPrNumber ?? currentTicket.prNumber,
        prUrl: payloadPrUrl ?? currentTicket.prUrl,
        mergedCommitSha: payloadMergeSha ?? currentTicket.mergedCommitSha,
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

    if (!(currentTicket.barrierGroupId && currentTicket.handoverDigest)) {
      currentTicket = await generateAndSaveHandoverDigestOp(
        this.coordinatorCtx(),
        currentTicket,
        repo,
      );
    }
    await recordDeliveredCasebookEntryOp(this.coordinatorCtx(), currentTicket);

    if (currentTicket.routineId) {
      const routine = await this.stateStore.getRoutine(currentTicket.routineId);
      if (routine && routine.activeTicketId === currentTicket.id) {
        const cleared: RoutineSpec = {
          ...routine,
          activeTicketId: undefined,
          updatedAt: nowIso(),
        };
        await this.stateStore.saveRoutine(cleared);
        this.emitEvent({
          type: "routine_updated",
          repoId: routine.repoId,
          routine: cleared,
          timestamp: cleared.updatedAt,
        });
      }
    }

    if (currentTicket.parentTicketId) {
      await maybeEvaluateEpicReplanOp(this.coordinatorCtx(), currentTicket.parentTicketId, currentTicket);
    }

    if (
      currentTicket.worktreePath &&
      (repo.autoCleanupWorktree !== false || entry.action === "local_merge")
    ) {
      await this.cleanupTicketWorktree(currentTicket.id);
    }

    // Best-effort post_deliver lifecycle hook
    await executeLifecycleHookOp(this.coordinatorCtx(), "post_deliver", currentTicket, repo, {
      cwd: entry.action === "local_merge" ? repo.rootPath : currentTicket.worktreePath || repo.rootPath,
    }).catch(() => {});

    if (currentTicket.campaignId) {
      await onCampaignTicketSettledOp(this.coordinatorCtx(), currentTicket, repo).catch(() => {});
    }

    await handleSelfHostPostMergeOp(this.coordinatorCtx(), currentTicket, repo, entry).catch(
      () => {},
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
    const ts = nowIso();
    const interruptedStatuses = new Set<Ticket["status"]>([
      "planning",
      "spec_testing",
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
    const plan = await this.previewRequirementIntake(input);
    if (input.previewOnly) {
      return { route: plan.route, plan };
    }

    if (plan.route === "goal_campaign" && plan.campaignSpec) {
      const cmpSpec = plan.campaignSpec;
      const campaign = await this.createCampaign({
        repoId: input.repoId,
        name: cmpSpec.name,
        goalPrompt: cmpSpec.goalPrompt,
        metricCommand: cmpSpec.metricCommand,
        metricRegex: cmpSpec.metricRegex,
        metricUnit: cmpSpec.metricUnit,
        direction: cmpSpec.direction,
        targetValue: cmpSpec.targetValue,
        deliveryMode: cmpSpec.deliveryMode,
        allowedPaths: cmpSpec.allowedPaths,
        template: input.template ?? "standard",
        preferredEngine: input.preferredEngine,
        maxIterations: cmpSpec.maxIterations,
        maxTotalBudgetUsd: input.maxBudgetUsd ?? cmpSpec.maxTotalBudgetUsd,
        autoStart: true,
      });
      return { route: "goal_campaign", plan, campaign };
    }

    if (plan.route === "epic_dag" && plan.epicPlan) {
      const { epic, subtasks } = await this.createEpic({
        repoId: input.repoId,
        title: plan.title,
        description: input.requirement.trim(),
        template: input.template,
        tddMode: input.tddMode,
        epicDeliveryMode: plan.epicPlan.epicDeliveryMode,
        releaseBarrier: plan.epicPlan.releaseBarrier,
        preferredEngine: input.preferredEngine,
        modelOverride: input.modelOverride,
        effortOverride: input.effortOverride,
        maxCostUsdPerSubtask: input.maxBudgetUsd,
        subtasks: plan.epicPlan.subtasks,
      });
      return { route: "epic_dag", plan, epic, subtasks };
    }

    const single = plan.singleSpec!;
    const ticket = await this.createDirectTicket({
      repoId: input.repoId,
      title: plan.title,
      description: single.description,
      template: input.template ?? single.template,
      tddMode: input.tddMode ?? single.tddMode,
      deliveryGatePolicy: input.deliveryGatePolicy,
      allowedPaths: single.allowedPaths,
      acceptanceCriteria: single.acceptanceCriteria,
      preferredEngine: input.preferredEngine,
      modelOverride: input.modelOverride,
      effortOverride: input.effortOverride,
      maxCostUsd: input.maxBudgetUsd,
    });
    return { route: "single_ticket", plan, ticket };
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
    const ticket = await this.stateStore.getTicket(ticketId);
    if (!ticket) {
      throw new Error(`Ticket not found: ${ticketId}`);
    }
    if (ticket.revertedAt) {
      throw new Error(
        `Ticket ${ticketId} was already reverted (${ticket.revertCommitSha ?? ticket.revertedAt})`,
      );
    }
    const repo = await this.stateStore.getRepo(ticket.repoId);
    if (!repo) {
      throw new Error(`Repository not found: ${ticket.repoId}`);
    }

    let commitSha = ticket.mergedCommitSha;
    if (!commitSha) {
      const entries = await this.stateStore.listOutboxEntries({ ticketId: ticket.id });
      const mergedEntry = [...entries]
        .reverse()
        .find((e) => e.action === "local_merge" && e.status === "sent");
      const shaFromEntry = mergedEntry?.resultPayload?.commitSha;
      if (typeof shaFromEntry === "string" && shaFromEntry.trim()) {
        commitSha = shaFromEntry.trim();
      }
    }

    if (!commitSha) {
      throw new Error(
        `Ticket ${ticketId} has no recorded local merge commit SHA to revert.`,
      );
    }

    const res = await this.workspace.revertMergedCommit({
      rootRepoPath: repo.rootPath,
      baseBranch: repo.baseBranch,
      commitSha,
    });
    if (!res.ok || !res.revertCommitSha) {
      const detail =
        res.conflictFiles && res.conflictFiles.length > 0
          ? `Revert conflicted on: ${res.conflictFiles.join(", ")}`
          : res.error || "Git revert failed";
      throw new Error(detail);
    }

    const ts = nowIso();
    const updated: Ticket = {
      ...ticket,
      mergedCommitSha: commitSha,
      revertedAt: ts,
      revertCommitSha: res.revertCommitSha,
      updatedAt: ts,
    };
    await this.stateStore.saveTicket(updated);
    this.emitEvent({ type: "ticket_updated", ticket: updated, timestamp: ts });
    await this.previewProvider?.stopPreviewsForTicket(ticket.id).catch(() => {});

    const existingCase = await this.stateStore.getCasebookEntryByTicket(ticket.id);
    if (existingCase && !existingCase.reverted) {
      const flaggedCase: CasebookEntry = {
        ...existingCase,
        reverted: true,
        updatedAt: ts,
      };
      await this.stateStore.saveCasebookEntry(flaggedCase);
      this.emitEvent({
        type: "casebook_updated",
        repoId: updated.repoId,
        entry: flaggedCase,
        timestamp: ts,
      });
    }
    const repoPlaybook = await this.stateStore.listPlaybookEntries(ticket.repoId);
    for (const pb of repoPlaybook) {
      if (pb.source === "auto_healed" && pb.sourceTicketId === ticket.id && !pb.suspect) {
        const suspectEntry: PlaybookEntry = {
          ...pb,
          suspect: true,
          updatedAt: ts,
        };
        await this.stateStore.savePlaybookEntry(suspectEntry);
        this.emitEvent({
          type: "playbook_updated",
          repoId: ticket.repoId,
          entry: suspectEntry,
          timestamp: ts,
        });
      }
    }

    return { ticket: updated, revertCommitSha: res.revertCommitSha };
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
    const instruction = input.instruction?.trim();
    if (!instruction) {
      throw new Error("Live steer instruction is required.");
    }
    const existing = await this.stateStore.getTicket(ticketId);
    if (!existing) {
      throw new Error(`Ticket not found: ${ticketId}`);
    }
    if (isTerminalTicketStatus(existing.status)) {
      throw new Error(`Cannot steer terminal ticket ${ticketId} (${existing.status}).`);
    }

    const activeCtrl = this.abortControllers.get(ticketId);
    if (activeCtrl) {
      this.pendingSteers.set(ticketId, {
        instruction,
        preferredEngine: input.preferredEngine,
      });
      activeCtrl.abort("live_steer");
      const activeRun = this.activeTicketRuns.get(ticketId);
      if (activeRun) {
        await Promise.race([activeRun, new Promise((r) => setTimeout(r, 600))]).catch(() => {});
      }
      return (await this.stateStore.getTicket(ticketId)) ?? existing;
    }

    const ts = nowIso();
    const overrideEngine =
      input.preferredEngine && input.preferredEngine !== "auto"
        ? input.preferredEngine
        : existing.activeEngine;
    const updated: Ticket = {
      ...existing,
      status: existing.status === "waiting_deps" ? "waiting_deps" : "queued",
      pauseBeforeRun: false,
      errorMessage: undefined,
      steerCount: (existing.steerCount ?? 0) + 1,
      preferredEngine: input.preferredEngine ?? existing.preferredEngine,
      activeEngine: overrideEngine,
      inlineMemory: {
        ...existing.inlineMemory,
        threadUpdates: [
          ...existing.inlineMemory.threadUpdates,
          {
            triggerId: newId("str"),
            message: `[Live Steer]: ${instruction}`,
            createdAt: ts,
          },
        ],
        activeHint: `[LIVE STEER]: ${instruction}`,
      },
      updatedAt: ts,
    };
    await this.stateStore.saveTicket(updated);
    this.emitEvent({ type: "ticket_updated", ticket: updated, timestamp: ts });
    return updated;
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
    await this.previewProvider?.stopPreviewsForTicket(ticketId).catch(() => {});

    const repo = await this.stateStore.getRepo(updated.repoId);
    if (repo?.autoCleanupWorktree !== false && updated.worktreePath) {
      return (await this.cleanupTicketWorktree(ticketId)) ?? updated;
    }
    if (repo && updated.campaignId) {
      await onCampaignTicketSettledOp(this.coordinatorCtx(), updated, repo).catch(() => {});
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

    await this.previewProvider?.stopPreviewsForTicket(ticketId).catch(() => {});
    const repo = await this.stateStore.getRepo(ticket.repoId);
    if (ticket.worktreePath) {
      await this.workspace.cleanupWorkspace(ticket.worktreePath, repo?.rootPath);
    }
    if (ticket.arenaCandidates) {
      for (const cand of ticket.arenaCandidates) {
        if (cand.worktreePath && cand.worktreePath !== ticket.worktreePath) {
          await this.workspace.cleanupWorkspace(cand.worktreePath, repo?.rootPath).catch(() => {});
        }
      }
    }

    const ts = nowIso();
    if (repo) {
      await this.workspace.cleanupTicketCheckpoints?.(repo.rootPath, ticket.id).catch(() => {});
      await this.stateStore.markCheckpointsCleaned(ticket.id, ts).catch(() => {});
    }

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
    const [dirs, tickets, repos, previews] = await Promise.all([
      this.workspace.listWorktreeDirs(),
      this.stateStore.listTickets(),
      this.stateStore.listRepos(),
      this.previewProvider ? this.previewProvider.listPreviews(repoId) : Promise.resolve([]),
    ]);
    const previewByPath = new Map<string, PreviewSession>();
    for (const p of previews) {
      previewByPath.set(resolve(p.worktreePath), p);
    }
    const reposById = new Map(repos.map((r) => [r.id, r]));
    const ticketsByPath = new Map<string, Ticket>();
    const ticketsById = new Map<string, Ticket>();
    for (const t of tickets) {
      ticketsById.set(t.id, t);
      if (t.worktreePath) {
        ticketsByPath.set(resolve(t.worktreePath), t);
      }
      if (t.arenaCandidates) {
        for (const cand of t.arenaCandidates) {
          if (cand.worktreePath) {
            ticketsByPath.set(resolve(cand.worktreePath), t);
          }
        }
      }
    }

    const items: ManagedWorktreeItem[] = [];
    for (const dir of dirs) {
      const resolvedDir = resolve(dir);
      const matched = ticketsByPath.get(resolvedDir) ?? ticketsById.get(basename(resolvedDir));
      const activePreview = previewByPath.get(resolvedDir);
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
          ...(activePreview ? { activePreview } : {}),
        };
        if (!repoId || item.repoId === repoId) {
          items.push(item);
        }
      } else {
        items.push({
          path: dir,
          reclaimable: true,
          isOrphan: true,
          ...(activePreview ? { activePreview } : {}),
        });
      }
    }
    return items;
  }

  async clarifySpec(input: SpecClarificationInput): Promise<SpecClarificationResult> {
    const repo =
      (await this.syncRepoContract(input.repoId).catch(() => null)) ??
      (await this.stateStore.getRepo(input.repoId));
    if (!repo) {
      throw new Error(`Repository not found: ${input.repoId}`);
    }
    const [repoStructure, playbookEntries, casebookEntries, probeContext] = await Promise.all([
      this.workspace.getRepoStructureSummary
        ? this.workspace.getRepoStructureSummary(repo.rootPath).catch(() => undefined)
        : Promise.resolve(undefined),
      this.stateStore.listPlaybookEntries(repo.id, { onlyEnabled: true }),
      this.stateStore.listCasebookEntries(repo.id),
      this.workspace.runRepoPreProbe
        ? this.workspace
            .runRepoPreProbe(
              repo.rootPath,
              `${input.title}\n${input.description}`,
              repo.forbiddenPaths,
            )
            .catch(() => undefined)
        : Promise.resolve(undefined),
    ]);

    const playbookText = formatPlaybookContext(playbookEntries, ["**"], 8, 1200);
    const caseSelection = selectRelevantCasesForContext({
      cases: casebookEntries,
      targetPaths: ["**"],
      queryText: `${input.title} ${input.description}`,
    });
    const caseText = caseSelection.formattedMarkdown;

    let spec: SpecClarificationResult;
    if (this.llm.clarifySpec) {
      spec = await this.llm.clarifySpec({
        repo,
        title: input.title,
        description: input.description,
        defaultTemplate: input.template ?? repo.defaultTemplate,
        repoStructure,
        playbookRules: playbookText || undefined,
        casebookContext: caseText || undefined,
        conventions: repo.conventions,
        probeContext,
        probeExecutor: this.createRepoProbeExecutor(repo),
      });
      spec = {
        ...spec,
        matchedCaseTitles:
          spec.matchedCaseTitles.length > 0
            ? spec.matchedCaseTitles
            : caseSelection.positiveCases.map((c) => c.title),
        probeSteps:
          spec.probeSteps && spec.probeSteps.length > 0
            ? spec.probeSteps
            : probeContext?.probeSteps,
      };
    } else {
      spec = buildHeuristicSpecClarification({
        repo,
        title: input.title,
        description: input.description,
        defaultTemplate: input.template ?? repo.defaultTemplate,
        repoStructure,
        casebookEntries,
        playbookEntries,
        probeContext,
      });
    }

    if (
      this.workspace.analyzeSymbolImpact &&
      spec.suggestedAllowedPaths.length > 0 &&
      !spec.suggestedAllowedPaths.includes("**")
    ) {
      const symbolImpact = await this.workspace
        .analyzeSymbolImpact(repo.rootPath, spec.suggestedAllowedPaths)
        .catch(() => undefined);
      if (symbolImpact) {
        spec = {
          ...spec,
          ...(symbolImpact.directDependents.length > 0
            ? { directDependents: symbolImpact.directDependents.slice(0, 12) }
            : {}),
          ...(symbolImpact.transitiveDependents.length > 0
            ? { transitiveDependents: symbolImpact.transitiveDependents.slice(0, 12) }
            : {}),
          recommendedTddMode:
            spec.recommendedTddMode || symbolImpact.directDependents.length >= 3,
        };
      }
    }

    return applyClarificationAnswers(spec, input.answers);
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
    if (!this.previewProvider) {
      throw new Error("Live preview provider is not configured in this kernel.");
    }
    const ticket = await this.stateStore.getTicket(ticketId);
    if (!ticket) {
      throw new Error(`Ticket not found: ${ticketId}`);
    }
    const repo = await this.stateStore.getRepo(ticket.repoId);
    if (!repo) {
      throw new Error(`Repository not found: ${ticket.repoId}`);
    }

    let worktreePath = ticket.worktreePath;
    let label = `${ticket.title}`;
    if (candidateId && ticket.arenaCandidates) {
      const cand = ticket.arenaCandidates.find((c) => c.candidateId === candidateId);
      if (!cand || !cand.worktreePath) {
        throw new Error(`Arena candidate '${candidateId}' has no active worktree.`);
      }
      worktreePath = cand.worktreePath;
      label = `${ticket.title} [${cand.engine} · ${cand.candidateId}]`;
    }
    if (!worktreePath || !existsSync(worktreePath)) {
      throw new Error(`No active worktree directory exists on disk for ticket ${ticketId}.`);
    }

    const command =
      repo.previewCommand?.trim() || repo.smokeCheck?.startCommand?.trim() || "";
    if (!command) {
      throw new Error(
        `Repository '${repo.name}' has neither previewCommand nor smokeCheck.startCommand configured.`,
      );
    }

    return this.previewProvider.startPreview({
      repoId: repo.id,
      ticketId: ticket.id,
      candidateId,
      label,
      worktreePath,
      command,
      ttlMinutes,
    });
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
    if (this.stopped || this.isDraining()) return 0;
    let launched = 0;
    const initialRepos = await this.stateStore.listRepos();
    const epicById = new Map<string, Ticket>();
    for (const r of initialRepos) {
      if (this.stopped) return 0;
      const synced = (await this.syncRepoContract(r.id).catch(() => r)) ?? r;
      if (this.stopped) return 0;
      await this.router.resolveDependenciesForWaitingTickets(synced);
      await syncEpicStatusesOp(this.coordinatorCtx(), synced);
    }
    if (this.stopped) return 0;
    await this.processDueRoutines();
    if (this.stopped) return 0;
    const repos = await this.stateStore.listRepos();
    for (const t of await this.stateStore.listTickets()) {
      if (t.isEpic) epicById.set(t.id, t);
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
    const candidates = queued.filter((t) => {
      if (this.activeTicketRuns.has(t.id)) return false;
      if (t.parentTicketId && epicById.get(t.parentTicketId)?.pendingEpicReplan) {
        return false;
      }
      return true;
    });

    for (const ticket of candidates) {
      if (this.stopped) break;
      if (launched >= capacity) break;
      const repo = reposById.get(ticket.repoId);
      const stage = ticket.currentStage || getFirstStage(ticket.template, ticket.tddMode);

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
      const promise = runTicketStageOp(this.coordinatorCtx(), ticket.id).finally(() => {
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
      const trainMerged = await this.flushMergeTrain();
      const outboxSent = await this.outbox.processDueEntries();
      const reposAfter = await this.stateStore.listRepos();
      for (const repo of reposAfter) {
        await syncEpicStatusesOp(this.coordinatorCtx(), repo);
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
        trainMerged === 0 &&
        outboxSent === 0
      ) {
        let canUnblock = false;
        for (const w of waiting) {
          if (!(await this.hasUnfinishedDependencies(w))) {
            canUnblock = true;
            break;
          }
        }
        if (!canUnblock && queued.length === 0) break;
      }
    }
  }

  private async hasUnfinishedDependencies(ticket: Ticket): Promise<boolean> {
    for (const depId of ticket.dependsOn) {
      const dep = await this.stateStore.getTicket(depId);
      if (!dep) return true;
      const barrierReady = Boolean(
        ticket.barrierGroupId &&
          dep.barrierGroupId === ticket.barrierGroupId &&
          dep.status === "outbox_pending" &&
          dep.handoverDigest,
      );
      if (dep.status !== "delivered" && !barrierReady) {
        return true;
      }
    }
    return false;
  }

  private async getEffectiveBaseInfo(
    ticket: Ticket,
    repo: RepoConfig,
  ): Promise<{ effectiveBaseBranch: string; parentEpic: Ticket | null }> {
    if (ticket.targetBranch && ticket.targetBranch !== repo.baseBranch) {
      await this.workspace.ensureBranch(repo.rootPath, ticket.targetBranch, repo.baseBranch);
      return { effectiveBaseBranch: ticket.targetBranch, parentEpic: null };
    }
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
    if (!this.workspace.captureWorktreeCheckpoint) return null;
    try {
      const cpId = newId("cp");
      const snap = await this.workspace.captureWorktreeCheckpoint({
        worktreePath,
        ticketId: ticket.id,
        checkpointId: cpId,
        label: opts.label,
      });
      const checkpoint: TicketCheckpoint = {
        id: cpId,
        ticketId: ticket.id,
        repoId: repo.id,
        stageRunId: opts.stageRunId,
        stage: opts.stage,
        engine: opts.engine,
        label: opts.label,
        gitRef: snap.gitRef,
        commitSha: snap.commitSha,
        changedFiles: opts.changedFiles,
        verificationPassed: opts.verificationPassed,
        createdAt: nowIso(),
      };
      await this.stateStore.saveCheckpoint(checkpoint);
      this.emitEvent({
        type: "checkpoint_created",
        checkpoint,
        timestamp: checkpoint.createdAt,
      });
      return checkpoint;
    } catch {
      return null;
    }
  }

  private async enqueueDeliveryOutbox(ticket: Ticket, repoArg?: RepoConfig): Promise<void> {
    const repo = repoArg ?? (await this.stateStore.getRepo(ticket.repoId));
    await maybeDistillClosedLoopLessonOp(this.coordinatorCtx(), ticket, repo ?? undefined);
    const template = getPipelineTemplate(ticket.template);
    const ts = nowIso();

    let changedFiles: string[] = Array.from(
      new Set(ticket.inlineMemory.stageNotes.flatMap((n) => n.changedFiles ?? [])),
    );
    let addedLines = 0;
    let deletedLines = 0;
    if (ticket.worktreePath && repo) {
      try {
        const { effectiveBaseBranch } = await this.getEffectiveBaseInfo(ticket, repo);
        const wsChanged = await this.workspace.getChangedFiles(ticket.worktreePath, effectiveBaseBranch);
        if (wsChanged.length > 0) changedFiles = wsChanged;
        const diffText = await this.workspace.getDiff(ticket.worktreePath, effectiveBaseBranch);
        const counts = countDiffLines(diffText);
        addedLines = counts.addedLines;
        deletedLines = counts.deletedLines;
      } catch {
        // Fallback cleanly to recorded stageNote metadata
      }
    }

    let reviewReport: ReviewReport | undefined;
    let maxVisualDiffRatio: number | undefined;
    let smokeResult: SmokeCheckResult | undefined;
    try {
      const artifacts = await this.stateStore.listArtifacts(ticket.id);
      const latestReviewArt = [...artifacts].reverse().find((a) => a.kind === "review_report");
      if (latestReviewArt) {
        const raw = await this.artifactStore.readSpill(latestReviewArt.storageUri).catch(() => "");
        if (raw) {
          reviewReport = JSON.parse(raw) as ReviewReport;
        }
      }
      for (const art of artifacts) {
        if (art.kind === "visual_diff") {
          const match = /([0-9]+(?:\.[0-9]+)?)%\s*changed/i.exec(art.summary);
          if (match) {
            const ratio = Number(match[1]) / 100;
            if (Number.isFinite(ratio)) {
              maxVisualDiffRatio = Math.max(maxVisualDiffRatio ?? 0, ratio);
            }
          }
        }
      }
      const latestSmokeArt = [...artifacts].reverse().find((a) => a.kind === "smoke_log");
      if (latestSmokeArt) {
        smokeResult = {
          ok: /^PASS\b/i.test(latestSmokeArt.summary),
          readyUrl: "",
          port: 0,
          startupDurationMs: 0,
          checkResults: [],
          serverOutputTail: "",
          summary: latestSmokeArt.summary,
        };
      }
    } catch {
      // Non-fatal
    }

    if (!reviewReport) {
      const reviewNote = [...ticket.inlineMemory.stageNotes]
        .reverse()
        .find((n) => n.stage === "review");
      if (reviewNote && reviewNote.reviewApproved !== undefined) {
        reviewReport = {
          verdict: reviewNote.reviewApproved ? "approved" : "changes_requested",
          reviewedByEngine: reviewNote.engine ?? "codex",
          summary: reviewNote.summary,
          findings: reviewNote.reviewFindings ?? [],
          createdAt: reviewNote.createdAt,
        };
      }
    }

    const staticVerificationPassed = Boolean(
      [...ticket.inlineMemory.stageNotes]
        .reverse()
        .find((n) => (n.stage === "implement" || n.stage === "rebase") && n.verificationPassed !== undefined)
        ?.verificationPassed,
    );

    const riskAssessment = evaluateTicketRisk({
      ticket,
      repo: repo ?? undefined,
      changedFiles,
      addedLines,
      deletedLines,
      maxVisualDiffRatio,
      reviewReport,
      smokeResult,
      staticVerificationPassed,
    });

    const needsSignoff =
      template.requireOutboxSignoff ||
      (Boolean(ticket.routineId) && repo?.mode === "observe") ||
      riskAssessment.requiresSignoff;
    const defaultChannel = repo?.defaultDeliveryChannel ?? "auto_pr_or_branch";
    const action: OutboxAction =
      defaultChannel === "local_merge" ? "local_merge" : "push_and_create_pr";

    const updatedTicket: Ticket = {
      ...ticket,
      status: "outbox_pending",
      activeEngine: undefined,
      riskAssessment,
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
        riskAssessment,
      },
      status: needsSignoff ? "awaiting_approval" : "pending",
      attempts: 0,
      nextAttemptAt: ts,
      createdAt: ts,
      updatedAt: ts,
    };
    await this.stateStore.enqueueOutbox(outboxEntry);
    this.emitEvent({ type: "outbox_queued", entry: outboxEntry, timestamp: ts });

    if (!needsSignoff && action === "local_merge" && repo) {
      await ensureMergeTrainForOutboxOp(this.coordinatorCtx(), outboxEntry, updatedTicket, repo);
    }

    if (needsSignoff) {
      const riskNote = riskAssessment.requiresSignoff
        ? ` [Risk ${riskAssessment.score}/100 (${riskAssessment.level}), policy=${riskAssessment.policy}]`
        : "";
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
          (action === "local_merge"
            ? `Ready to merge branch ${ticket.branchName} into ${repo?.baseBranch ?? "main"}. Approve Outbox execution to merge & cleanup.`
            : `Ready to deliver branch ${ticket.branchName}. Approve Outbox execution to push / create PR.`) +
          riskNote,
        contextPayload: {
          outboxId: outboxEntry.id,
          branchName: ticket.branchName,
          action,
          riskAssessment,
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

    if (action === "local_merge") {
      const repo = await this.stateStore.getRepo(ticket.repoId);
      if (repo) {
        await ensureMergeTrainForOutboxOp(this.coordinatorCtx(), entry, ticket, repo);
        await this.flushMergeTrain(repo.id);
      }
    } else {
      await this.outbox.processDueEntries(10);
    }

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

    const repo = await this.stateStore.getRepo(ticket.repoId);
    if (repo) {
      await executeLifecycleHookOp(this.coordinatorCtx(), "on_escalate", updated, repo).catch(
        () => {},
      );
    }
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
    options?: { skipHitTracking?: boolean },
  ): Promise<string> {
    const ts = nowIso();
    const [relatedMemory, playbookEntries, caseEntries] = await Promise.all([
      this.stateStore.searchMemory(ticket.title, 6, repo.id),
      this.stateStore.listPlaybookEntries(repo.id, { onlyEnabled: true }),
      this.stateStore.listCasebookEntries(repo.id, { includeReverted: true }),
    ]);

    const upstreamHandovers: HandoverDigest[] = [];
    if (ticket.dependsOn.length > 0) {
      const reposById = new Map((await this.stateStore.listRepos()).map((r) => [r.id, r]));
      for (const depId of ticket.dependsOn) {
        const dep = await this.stateStore.getTicket(depId);
        if (!dep) continue;
        if (dep.handoverDigest) {
          upstreamHandovers.push(dep.handoverDigest);
        } else if (dep.status === "delivered") {
          const depFiles = Array.from(
            new Set(dep.inlineMemory.stageNotes.flatMap((n) => n.changedFiles)),
          );
          upstreamHandovers.push(
            buildHandoverDigest({
              ticket: dep,
              repoName: reposById.get(dep.repoId)?.name,
              changedFiles: depFiles,
              diffText: "",
              stageSummary: dep.inlineMemory.stageNotes.at(-1)?.summary || dep.title,
            }),
          );
        }
      }
    }

    const pathExists = (relPath: string): boolean => existsSync(join(repo.rootPath, relPath));
    const selectedPlaybook = selectPlaybookRulesForContext(
      playbookEntries,
      ticket.mandate.allowedPaths,
      8,
      1200,
      { pathExists },
    );
    const playbookContext = formatPlaybookContext(
      playbookEntries,
      ticket.mandate.allowedPaths,
      8,
      1200,
      { pathExists },
    );

    const otherCases = caseEntries.filter((c) => c.ticketId !== ticket.id);
    const ftsTicketIds = new Set(relatedMemory.map((m) => m.ticketId));
    const caseSelection = selectRelevantCasesForContext({
      cases: otherCases,
      ftsTicketIds,
      targetPaths: ticket.mandate.allowedPaths,
      queryText: `${ticket.title} ${ticket.description}`,
      maxPositive: 2,
      maxChars: 900,
    });

    if (!options?.skipHitTracking) {
      if (selectedPlaybook.length > 0) {
        await this.stateStore.recordPlaybookHits(
          selectedPlaybook.map((e) => e.id),
          ts,
        );
      }
      if (caseSelection.positiveCases.length > 0) {
        await this.stateStore.recordCasebookHits(
          caseSelection.positiveCases.map((c) => c.id),
          ts,
        );
      }
    }

    let symbolContextPack: string | undefined;
    if (
      (stage === "plan" || stage === "spec_test" || stage === "implement") &&
      this.workspace.analyzeSymbolImpact &&
      !ticket.mandate.allowedPaths.includes("**")
    ) {
      const impact = await this.workspace
        .analyzeSymbolImpact(repo.rootPath, ticket.mandate.allowedPaths)
        .catch(() => null);
      if (impact?.contextPackMarkdown?.trim()) {
        symbolContextPack = impact.contextPackMarkdown.trim();
      }
    }

    return this.memory.buildWorkerPromptContext(ticket, stage, relatedMemory, {
      verificationCommands: repo.verificationCommands,
      smokeCheck: repo.smokeCheck,
      repoConventions:
        [repo.conventions?.trim(), symbolContextPack].filter(Boolean).join("\n\n") || undefined,
      playbookContext,
      casebookContext: caseSelection.formattedMarkdown || undefined,
      upstreamHandovers,
    });
  }

  async prunePlaybookEntries(
    repoId: string,
  ): Promise<{ prunedIds: string[]; keptCount: number }> {
    return prunePlaybookEntriesOp(this.coordinatorCtx(), repoId);
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
    const repo = await this.stateStore.getRepo(repoId);
    if (!repo) {
      throw new Error(`Repository not found: ${repoId}`);
    }
    if (!this.workspace.analyzeSymbolImpact) {
      throw new Error("WorkspaceProvider does not support symbol impact analysis.");
    }
    return this.workspace.analyzeSymbolImpact(repo.rootPath, paths);
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
    const repo = await this.stateStore.getRepo(repoId);
    if (!repo) {
      throw new Error(`Repository not found: ${repoId}`);
    }
    return resolveRepoBlueprints(repo);
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
    const [allRepos, repo, tickets, inboxItems] = await Promise.all([
      this.stateStore.listRepos(),
      input.repoId ? this.stateStore.getRepo(input.repoId) : Promise.resolve(null),
      this.stateStore.listTickets(),
      this.stateStore.listInboxItems(),
    ]);
    const effectiveRepo = repo ?? (allRepos.length === 1 ? allRepos[0] : undefined);
    const [metrics, memoryHits, probeContext] = await Promise.all([
      this.stateStore.getMetricsSummary(effectiveRepo?.id, utcTodayString()),
      this.stateStore.searchMemory(input.question, 6, effectiveRepo?.id),
      effectiveRepo && this.workspace.runRepoPreProbe
        ? this.workspace
            .runRepoPreProbe(
              effectiveRepo.rootPath,
              input.question,
              effectiveRepo.forbiddenPaths,
            )
            .catch(() => undefined)
        : Promise.resolve(undefined),
    ]);

    return runChiefOfStaffQuery({
      question: input.question,
      repo: effectiveRepo,
      allRepos,
      tickets,
      inboxItems,
      metrics,
      memoryHits,
      probeContext,
      llm: this.llm,
      probeExecutor: effectiveRepo ? this.createRepoProbeExecutor(effectiveRepo) : undefined,
    });
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
