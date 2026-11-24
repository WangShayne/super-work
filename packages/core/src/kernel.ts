import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  countDiffLines,
  pickNextFallbackEngine,
  resolveFallbackChain,
  scoreArenaCandidates,
} from "./arena.ts";
import { resolveRepoBlueprints } from "./blueprints.ts";
import { buildCasebookEntryFromTicket, selectRelevantCasesForContext } from "./casebook.ts";
import { runChiefOfStaffQuery } from "./chief.ts";
import { buildConflictResolutionPrompt } from "./conflict-resolver.ts";
import {
  computeEngineRoutingDecision,
  isSpecTestFilePath,
  isUiIntentTicket,
  parseSpecTestChallenge,
} from "./engine-router.ts";
import {
  classifyEpicReplanApproval,
  detectTicketDependencyCycle,
  evaluateHeuristicEpicReplan,
  sanitizeEpicSubtasks,
} from "./epic.ts";
import { buildHandoverDigest, extractDiffContracts } from "./handover.ts";
import { createDefaultMandate, validateChangedFilesAgainstMandate } from "./mandate.ts";
import { MemoryManager } from "./memory.ts";
import { OutboxProcessor } from "./outbox.ts";
import {
  getAlternateEngine,
  getFirstStage,
  getNextStage,
  getPipelineTemplate,
  selectEngineForStage,
  selectReviewEngine,
  statusForStage,
} from "./pipeline.ts";
import {
  classifyPlaybookHealth,
  contractRuleDeterministicId,
  distillHumanNoteToRule,
  formatPlaybookContext,
  heuristicDistillPlaybookLesson,
  normalizePlaybookRuleText,
  playbookDedupeKey,
  selectPlaybookRulesForContext,
} from "./playbook.ts";
import {
  formatBlockingFindingsForRework,
  formatNitSummary,
  parseReviewReport,
} from "./review.ts";
import {
  computeNextRoutineRunAt,
  isWithinActiveHours,
  parseRoutineProbeVerdict,
} from "./routine.ts";
import {
  applyClarificationAnswers,
  buildHeuristicSpecClarification,
} from "./spec-studio.ts";
import {
  adoptArenaCandidateWinnerOp,
  cleanupArenaCandidateWorktreesOp,
  runArenaImplementStageOp,
} from "./kernel/arena-coordinator.ts";
import {
  getTicketCheckpointDiffOp,
  mutateDagNodeOp,
  restoreTicketCheckpointOp,
} from "./kernel/checkpoint-dag-coordinator.ts";
import type { KernelCoordinatorContext } from "./kernel/context.ts";
import {
  createSystemBackup,
  listSystemBackups,
  restoreSystemBackup as restoreSystemBackupOp,
  runSystemDoctor,
} from "./kernel/doctor-backup-coordinator.ts";
import {
  createEvalCaseFromTicket as createEvalCaseFromTicketOp,
  runEvalCase as runEvalCaseOp,
} from "./kernel/eval-coordinator.ts";
import {
  applyEpicReplanProposalOp,
  maybeEvaluateEpicReplanOp,
} from "./kernel/epic-replan-coordinator.ts";
import {
  exportRepoKnowledgeBundle as exportRepoKnowledgeBundleOp,
  importRepoKnowledgeBundle as importRepoKnowledgeBundleOp,
} from "./kernel/knowledge-bundle-coordinator.ts";
import {
  autoResolveModifiedReviewComments,
  submitTicketReviewComments,
  syncAiFindingsToReviewComments,
} from "./kernel/review-comments-coordinator.ts";
import {
  createRoutineSpec,
  deleteRoutineSpec,
  executeRoutineProbe,
  processDueRoutinesTick,
  triggerRoutineNowSpec,
  updateRoutineSpec,
} from "./kernel/routine-coordinator.ts";
import { SpanRecorder } from "./kernel/span-recorder.ts";
import { evaluateTicketRisk } from "./risk.ts";
import { buildStageToolProfile, extractWorkerClarificationRequest } from "./tool-profiler.ts";
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
  StateStore,
  WorkerDriver,
  WorkspaceProvider,
} from "./ports.ts";
import { EventIntakeRouter, type IngestResult } from "./router.ts";
import type {
  ArenaCandidateResult,
  BackupArchiveInfo,
  BackupRestoreResult,
  BatchResolveInboxInput,
  BatchResolveInboxResult,
  CasebookEntry,
  ChiefAskInput,
  ChiefAskResult,
  ConflictSemanticContext,
  DagNodeMutationInput,
  EpicDecompositionPlan,
  EpicReplanProposal,
  EvalCase,
  EvalRunRecord,
  HandoverDigest,
  ImportKnowledgeBundleResult,
  InboxItem,
  KernelEvent,
  ManagedWorktreeItem,
  OutboxAction,
  OutboxEntry,
  PipelineTemplateId,
  PlaybookEntry,
  PreviewSession,
  RepoConfig,
  RepoContractFile,
  RepoKnowledgeBundle,
  RestoreCheckpointInput,
  ReviewCommentStatus,
  ReviewReport,
  RoutineRun,
  RoutineScheduleKind,
  RoutineSpec,
  SmokeCheckResult,
  SpecClarificationInput,
  SpecClarificationResult,
  SpillArtifact,
  StageKind,
  StageRun,
  StageSpan,
  SteerTicketInput,
  SubmitReviewCommentsInput,
  SymbolImpactReport,
  SystemDoctorReport,
  SystemSetupConfig,
  TaskBlueprint,
  Thread,
  Ticket,
  TicketCheckpoint,
  TicketReviewComment,
  Trigger,
  VerificationRunResult,
  WatchdogDecision,
  WatchdogSignal,
  WorkerClarificationRequest,
  WorkerEngineId,
  WorkerStreamEvent,
  WorktreeGcResult,
} from "./types.ts";
import { isTerminalTicketStatus, newId, normalizeSmokeCheckConfig, nowIso } from "./utils.ts";
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
  readonly previewProvider?: PreviewProvider;
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
    this.previewProvider = deps.previewProvider;
    this.dataDir = deps.dataDir ?? ".super-work";
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

        currentTicket = await this.generateAndSaveHandoverDigest(currentTicket, repo);
        await this.recordDeliveredCasebookEntry(currentTicket, repo);

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
          await this.maybeEvaluateEpicReplan(currentTicket.parentTicketId, currentTicket);
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

  private coordinatorCtx(): KernelCoordinatorContext {
    return {
      stateStore: this.stateStore,
      artifactStore: this.artifactStore,
      workspace: this.workspace,
      memory: this.memory,
      llm: this.llm,
      previewProvider: this.previewProvider,
      dataDir: this.dataDir,
      drivers: this.drivers,
      activeTicketRuns: this.activeTicketRuns,
      activeRoutineRuns: this.activeRoutineRuns,
      abortControllers: this.abortControllers,
      isStopped: () => this.stopped,
      emitEvent: (event) => this.emitEvent(event),
      getAvailableEngines: () => this.getAvailableEngines(),
      getEffectiveDailyBudget: (repo, utcDate) => getEffectiveDailyBudget(repo, utcDate),
      runWithRepoWorkspaceLock: (repoId, fn) => this.runWithRepoWorkspaceLock(repoId, fn),
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
      runRepoVerificationGate: (ticket, repo, stageRun, worktreePath, options) =>
        this.runRepoVerificationGate(ticket, repo, stageRun, worktreePath, options),
      enqueueDeliveryOutbox: (ticket, repoArg) => this.enqueueDeliveryOutbox(ticket, repoArg),
      escalateTicket: (ticket, kind, summary, contextPayload) =>
        this.escalateTicket(ticket, kind, summary, contextPayload),
      createDirectTicket: (input) => this.router.createDirectTicket(input),
      inspectWorktrees: (repoId) => this.inspectWorktrees(repoId),
      gcWorktrees: (options) => this.gcWorktrees(options),
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

  private flushOutbox(): Promise<unknown> {
    if (this.stopped) return Promise.resolve();
    if (this.outboxFlushPromise) {
      return this.outboxFlushPromise;
    }
    this.outboxFlushPromise = this.outbox.processDueEntries().finally(() => {
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
    const result = await this.router.ingestTrigger(input);
    return result;
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

  async syncRepoContract(repoId: string, force = false): Promise<RepoConfig | null> {
    const repo = await this.stateStore.getRepo(repoId);
    if (!repo || !this.workspace.loadRepoContract) return repo;

    let loaded: Awaited<ReturnType<NonNullable<WorkspaceProvider["loadRepoContract"]>>> = null;
    try {
      loaded = await this.workspace.loadRepoContract(repo.rootPath);
    } catch {
      return repo;
    }
    if (!loaded) return repo;
    if (!force && repo.contractSyncedHash === loaded.rawHash) {
      return repo;
    }

    const { contract, rawHash } = loaded;
    const ts = nowIso();
    const updatedRepo: RepoConfig = {
      ...repo,
      defaultTemplate: contract.defaultTemplate ?? repo.defaultTemplate,
      defaultTddMode:
        contract.defaultTddMode !== undefined ? Boolean(contract.defaultTddMode) : repo.defaultTddMode,
      deliveryGatePolicy:
        contract.deliveryGatePolicy !== undefined
          ? contract.deliveryGatePolicy
          : repo.deliveryGatePolicy,
      riskThreshold:
        contract.riskThreshold !== undefined
          ? contract.riskThreshold
          : repo.riskThreshold,
      sensitivePaths:
        contract.sensitivePaths !== undefined
          ? contract.sensitivePaths.map((s) => String(s).trim()).filter(Boolean)
          : repo.sensitivePaths,
      blueprints:
        Array.isArray(contract.blueprints)
          ? contract.blueprints.filter((b) => Boolean(b?.id?.trim()))
          : repo.blueprints,
      verificationCommands:
        contract.verificationCommands !== undefined
          ? contract.verificationCommands.map((s) => String(s).trim()).filter(Boolean)
          : repo.verificationCommands,
      setupCommands:
        contract.setupCommands !== undefined
          ? contract.setupCommands.map((s) => String(s).trim()).filter(Boolean)
          : repo.setupCommands,
      smokeCheck:
        contract.smokeCheck !== undefined
          ? normalizeSmokeCheckConfig(contract.smokeCheck)
          : repo.smokeCheck,
      previewCommand:
        contract.previewCommand !== undefined
          ? contract.previewCommand.trim() || undefined
          : repo.previewCommand,
      sandboxMode:
        contract.sandboxMode !== undefined
          ? contract.sandboxMode
          : repo.sandboxMode,
      forbiddenPaths:
        contract.forbiddenPaths !== undefined
          ? contract.forbiddenPaths.map((s) => String(s).trim()).filter(Boolean)
          : repo.forbiddenPaths,
      conventions:
        contract.conventions !== undefined
          ? contract.conventions.trim() || undefined
          : repo.conventions,
      contractSyncedHash: rawHash,
      contractSyncedAt: ts,
      updatedAt: ts,
    };

    await this.stateStore.upsertRepo(updatedRepo);

    if (Array.isArray(contract.playbook)) {
      const existingEntries = await this.stateStore.listPlaybookEntries(repo.id);
      const keepContractIds = new Set<string>();

      for (const spec of contract.playbook) {
        const cleanRule = normalizePlaybookRuleText(String(spec.rule ?? ""));
        if (!cleanRule) continue;
        const entryId = contractRuleDeterministicId(repo.id, { ...spec, rule: cleanRule });
        keepContractIds.add(entryId);
        const existing = existingEntries.find((e) => e.id === entryId);
        const entry: PlaybookEntry = {
          id: entryId,
          repoId: repo.id,
          rule: cleanRule,
          scopePaths:
            Array.isArray(spec.scopePaths) && spec.scopePaths.length > 0
              ? spec.scopePaths.map((p) => String(p).trim()).filter(Boolean)
              : ["**"],
          source: "repo_contract",
          enabled: existing ? existing.enabled : true,
          pinned: spec.pinned ?? existing?.pinned ?? false,
          createdAt: existing?.createdAt ?? ts,
          updatedAt: ts,
        };
        await this.stateStore.savePlaybookEntry(entry);
        this.emitEvent({ type: "playbook_updated", repoId: repo.id, entry, timestamp: ts });
      }

      for (const existing of existingEntries) {
        if (existing.source === "repo_contract" && !keepContractIds.has(existing.id)) {
          await this.stateStore.deletePlaybookEntry(existing.id);
          this.emitEvent({
            type: "playbook_updated",
            repoId: repo.id,
            deletedId: existing.id,
            timestamp: ts,
          });
        }
      }
    }

    this.emitEvent({ type: "repo_updated", repo: updatedRepo, timestamp: ts });
    return updatedRepo;
  }

  async exportRepoContract(
    repoId: string,
  ): Promise<{ repo: RepoConfig; contract: RepoContractFile; filePath: string }> {
    const repo = await this.stateStore.getRepo(repoId);
    if (!repo) {
      throw new Error(`Repository not found: ${repoId}`);
    }
    if (!this.workspace.writeRepoContract) {
      throw new Error("WorkspaceProvider does not support writing super-work.json contract.");
    }

    const entries = await this.stateStore.listPlaybookEntries(repoId, { onlyEnabled: true });
    const contract: RepoContractFile = {
      version: 1,
      defaultTemplate: repo.defaultTemplate,
      ...(repo.defaultTddMode !== undefined ? { defaultTddMode: repo.defaultTddMode } : {}),
      ...(repo.deliveryGatePolicy ? { deliveryGatePolicy: repo.deliveryGatePolicy } : {}),
      ...(repo.riskThreshold !== undefined ? { riskThreshold: repo.riskThreshold } : {}),
      ...(repo.sensitivePaths && repo.sensitivePaths.length > 0
        ? { sensitivePaths: repo.sensitivePaths }
        : {}),
      verificationCommands: repo.verificationCommands ?? [],
      setupCommands: repo.setupCommands ?? [],
      ...(repo.smokeCheck ? { smokeCheck: repo.smokeCheck } : {}),
      ...(repo.previewCommand?.trim() ? { previewCommand: repo.previewCommand.trim() } : {}),
      ...(repo.sandboxMode ? { sandboxMode: repo.sandboxMode } : {}),
      forbiddenPaths: repo.forbiddenPaths ?? [],
      ...(repo.conventions?.trim() ? { conventions: repo.conventions.trim() } : {}),
      playbook: entries.map((e) => ({
        id: e.id,
        rule: e.rule,
        scopePaths: e.scopePaths,
        pinned: e.pinned,
      })),
      ...(repo.blueprints && repo.blueprints.length > 0 ? { blueprints: repo.blueprints } : {}),
    };

    const written = await this.workspace.writeRepoContract(repo.rootPath, contract);
    const ts = nowIso();
    const updatedRepo: RepoConfig = {
      ...repo,
      contractSyncedHash: written.rawHash,
      contractSyncedAt: ts,
      updatedAt: ts,
    };
    await this.stateStore.upsertRepo(updatedRepo);
    this.emitEvent({ type: "repo_updated", repo: updatedRepo, timestamp: ts });
    return { repo: updatedRepo, contract, filePath: written.filePath };
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
    const cleanRule = normalizePlaybookRuleText(input.rule);
    if (!cleanRule) return null;

    const ts = nowIso();
    const scopePaths =
      input.scopePaths && input.scopePaths.length > 0
        ? Array.from(new Set(input.scopePaths.map((s) => s.trim()).filter(Boolean)))
        : ["**"];

    const existing = await this.stateStore.listPlaybookEntries(input.repoId);
    const key = playbookDedupeKey(cleanRule);
    const dup = existing.find((e) => playbookDedupeKey(e.rule) === key);

    if (dup) {
      const mergedScopes = Array.from(new Set([...dup.scopePaths, ...scopePaths]));
      const updated: PlaybookEntry = {
        ...dup,
        rule: input.source === "human" ? cleanRule : dup.rule,
        scopePaths: mergedScopes,
        pinned: input.pinned ?? dup.pinned,
        enabled: input.enabled ?? dup.enabled,
        updatedAt: ts,
      };
      await this.stateStore.savePlaybookEntry(updated);
      this.emitEvent({ type: "playbook_updated", repoId: input.repoId, entry: updated, timestamp: ts });
      return updated;
    }

    const entry: PlaybookEntry = {
      id: newId("pbk"),
      repoId: input.repoId,
      rule: cleanRule,
      scopePaths,
      source: input.source,
      sourceTicketId: input.sourceTicketId,
      enabled: input.enabled ?? true,
      pinned: input.pinned ?? false,
      createdAt: ts,
      updatedAt: ts,
    };
    await this.stateStore.savePlaybookEntry(entry);
    this.emitEvent({ type: "playbook_updated", repoId: input.repoId, entry, timestamp: ts });
    return entry;
  }

  private async maybeDistillClosedLoopLesson(ticket: Ticket, repoArg?: RepoConfig): Promise<void> {
    if (ticket.isEpic) return;
    const stageRuns = await this.stateStore.listStageRuns(ticket.id);
    const failedImplRuns = stageRuns.filter(
      (r) => (r.stage === "implement" || r.stage === "rebase") && r.status === "failed",
    );
    const rejectedReviewNotes = ticket.inlineMemory.stageNotes.filter(
      (n) => n.stage === "review" && n.reviewApproved === false,
    );

    if (failedImplRuns.length === 0 && rejectedReviewNotes.length === 0) {
      return;
    }

    const repo = repoArg ?? (await this.stateStore.getRepo(ticket.repoId));
    if (!repo) return;

    const latestRejectedReview = rejectedReviewNotes.at(-1);
    const latestFailedImpl = failedImplRuns.at(-1);
    const useReviewFailure = Boolean(
      latestRejectedReview &&
        (!latestFailedImpl ||
          latestRejectedReview.createdAt >= (latestFailedImpl.completedAt ?? latestFailedImpl.startedAt)),
    );

    const isSmokeFailure = Boolean(latestFailedImpl?.summary?.includes("Smoke check failed"));
    const failureKind: "verification" | "smoke" | "review" = useReviewFailure
      ? "review"
      : isSmokeFailure
        ? "smoke"
        : "verification";
    const failureSummary = useReviewFailure
      ? latestRejectedReview?.summary || "Code review requested changes"
      : latestFailedImpl?.summary || "Verification check failed";

    const latestSuccessImpl = [...ticket.inlineMemory.stageNotes]
      .reverse()
      .find((n) => n.stage === "implement" && n.verificationPassed);
    const fixSummary =
      latestSuccessImpl?.summary ||
      ticket.inlineMemory.stageNotes.at(-1)?.summary ||
      "Fixed implementation and passed verification gate";
    const changedFiles = Array.from(
      new Set(ticket.inlineMemory.stageNotes.flatMap((n) => n.changedFiles)),
    );

    let lesson: { rule: string; scopePaths: string[] } | null = null;
    if (this.llm.distillPlaybookLesson) {
      try {
        lesson = await this.llm.distillPlaybookLesson({
          repo,
          ticket,
          failureKind,
          failureSummary,
          fixSummary,
          changedFiles,
        });
      } catch {
        lesson = null;
      }
    }
    if (!lesson || !lesson.rule.trim()) {
      lesson = heuristicDistillPlaybookLesson({
        failureKind,
        failureSummary,
        fixSummary,
        changedFiles,
        allowedPaths: ticket.mandate.allowedPaths,
      });
    }

    await this.addOrUpdatePlaybookRule({
      repoId: repo.id,
      rule: lesson.rule,
      scopePaths: lesson.scopePaths,
      source: "auto_healed",
      sourceTicketId: ticket.id,
      enabled: true,
      pinned: false,
    });
  }

  private async generateAndSaveHandoverDigest(
    ticket: Ticket,
    repo: RepoConfig,
    precomputed?: { changedFiles: string[]; diffText: string },
  ): Promise<Ticket> {
    if (ticket.isEpic && ticket.epicDeliveryMode === "per_subtask") {
      return ticket;
    }

    let changedFiles = precomputed?.changedFiles ?? [];
    let diffText = precomputed?.diffText ?? "";

    if (!precomputed) {
      if (ticket.worktreePath && existsSync(ticket.worktreePath)) {
        try {
          const { effectiveBaseBranch } = await this.getEffectiveBaseInfo(ticket, repo);
          changedFiles = await this.workspace.getChangedFiles(ticket.worktreePath, effectiveBaseBranch);
          diffText = await this.workspace.getDiff(ticket.worktreePath, effectiveBaseBranch);
        } catch {
          // Fall back to latest recorded Spill diff artifact
        }
      }

      if (!diffText.trim()) {
        const artifacts = await this.stateStore.listArtifacts(ticket.id);
        const latestDiff = [...artifacts].reverse().find((a) => a.kind === "diff");
        if (latestDiff) {
          try {
            diffText = await this.artifactStore.readSpill(latestDiff.storageUri);
          } catch {
            diffText = "";
          }
        }
      }

      if (changedFiles.length === 0) {
        const latestFilesNote = [...ticket.inlineMemory.stageNotes]
          .reverse()
          .find((n) => n.changedFiles.length > 0 && n.verificationPassed);
        if (latestFilesNote) {
          changedFiles = latestFilesNote.changedFiles;
        } else if (diffText.trim()) {
          changedFiles = Array.from(
            new Set(
              Array.from(diffText.matchAll(/^\+\+\+\s+b\/(.+)$/gm))
                .map((m) => m[1]!.trim())
                .filter((p) => p !== "/dev/null"),
            ),
          );
        }
      }
    }

    const stageSummary =
      [...ticket.inlineMemory.stageNotes]
        .reverse()
        .find((n) => n.stage === "implement" || n.stage === "rebase")?.summary ??
      ticket.inlineMemory.stageNotes.at(-1)?.summary ??
      ticket.title;

    const extracted = extractDiffContracts(diffText);
    let llmRefinement: {
      summary?: string;
      exportedSymbols?: string[];
      contractSnippets?: string[];
    } | null = null;
    if (this.llm.distillHandoverDigest && (changedFiles.length > 0 || diffText.trim().length > 0)) {
      try {
        llmRefinement = await this.llm.distillHandoverDigest({
          repo,
          ticket,
          changedFiles,
          exportedSymbols: extracted.exportedSymbols,
          contractSnippets: extracted.contractSnippets,
          diffExcerpt: diffText.slice(0, 6000),
          stageSummary,
        });
      } catch {
        llmRefinement = null;
      }
    }

    const previousDigest = ticket.handoverDigest;
    const version = (previousDigest?.version ?? 0) + 1;
    const digest = buildHandoverDigest({
      ticket,
      repoName: repo.name,
      changedFiles,
      diffText,
      stageSummary,
      version,
      llmRefinement,
    });

    const handoverArtifact = await this.artifactStore.writeSpill(
      {
        ticketId: ticket.id,
        kind: "handover",
        summary: `Handover v${digest.version}: ${ticket.title}`,
        ext: "md",
      },
      digest.formattedMarkdown,
    );
    await this.stateStore.saveArtifact(handoverArtifact, digest.formattedMarkdown);

    const ts = nowIso();
    const updated: Ticket = {
      ...ticket,
      handoverDigest: digest,
      updatedAt: ts,
    };
    await this.stateStore.saveTicket(updated);
    this.emitEvent({ type: "ticket_updated", ticket: updated, timestamp: ts });

    // Contract Drift Propagation: notify non-terminal downstream dependents when upstream handover changes
    if (
      previousDigest &&
      previousDigest.formattedMarkdown !== digest.formattedMarkdown
    ) {
      const allTickets = await this.stateStore.listTickets();
      for (const downstream of allTickets) {
        if (downstream.id === ticket.id || isTerminalTicketStatus(downstream.status)) continue;
        if (!downstream.dependsOn.includes(ticket.id)) continue;

        const driftTs = nowIso();
        const driftMsg = `[Upstream Contract Updated v${digest.version} from ${repo.name}/${ticket.id}] ${digest.summary}`;
        const updatedDownstream: Ticket = {
          ...downstream,
          inlineMemory: {
            ...downstream.inlineMemory,
            threadUpdates: [
              ...downstream.inlineMemory.threadUpdates,
              {
                triggerId: newId("drift"),
                message: driftMsg,
                createdAt: driftTs,
              },
            ],
            activeHint: [downstream.inlineMemory.activeHint?.trim(), driftMsg]
              .filter(Boolean)
              .join("\n\n"),
          },
          updatedAt: driftTs,
        };
        await this.stateStore.saveTicket(updatedDownstream);
        this.emitEvent({
          type: "thread_routed",
          ticketId: updatedDownstream.id,
          triggerId: ticket.id,
          message: driftMsg,
          timestamp: driftTs,
        });
        this.emitEvent({
          type: "ticket_updated",
          ticket: updatedDownstream,
          timestamp: driftTs,
        });
      }
    }

    return updated;
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

    // C.2 Self-Cleansing: flip linked Casebook entry to reverted warning and flag auto_healed Playbook rules as suspect
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

  // --- D.1 Pre-Flight Spec Clarification ---
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

  // --- B.2 Live Worktree Preview Lifecycle ---
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

    if (options?.saveToPlaybook !== false && item.kind !== "budget_cap") {
      const rule = distillHumanNoteToRule(note);
      if (rule) {
        await this.addOrUpdatePlaybookRule({
          repoId: ticket.repoId,
          rule,
          scopePaths: ticket.mandate.allowedPaths,
          source: "human",
          sourceTicketId: ticket.id,
          enabled: true,
          pinned: false,
        });
      }
    }

    let nextTicket = { ...ticket, updatedAt: ts };

    if (item.kind === "observe_proposal") {
      if (decision === "approved") {
        const hasPendingDeps = await this.hasUnfinishedDependencies(ticket);
        nextTicket = {
          ...nextTicket,
          status: hasPendingDeps ? "waiting_deps" : "queued",
          currentStage: getFirstStage(ticket.template, ticket.tddMode),
          inlineMemory: {
            ...nextTicket.inlineMemory,
            activeHint: note || nextTicket.inlineMemory.activeHint,
          },
        };
      } else {
        nextTicket = { ...nextTicket, status: "cancelled", errorMessage: note ?? "Proposal rejected" };
      }
    } else if (item.kind === "plan_approval") {
      const isDagBreakpoint = item.contextPayload.isDagBreakpoint === true;
      if (decision === "approved") {
        nextTicket = {
          ...nextTicket,
          status: "queued",
          pauseBeforeRun: false,
          currentStage: isDagBreakpoint
            ? ticket.currentStage
            : (getNextStage(ticket.template, "plan", ticket.tddMode) ?? "implement"),
          errorMessage: undefined,
          inlineMemory: {
            ...nextTicket.inlineMemory,
            activeHint: note || nextTicket.inlineMemory.activeHint,
          },
        };
      } else if (note) {
        nextTicket = {
          ...nextTicket,
          status: "queued",
          pauseBeforeRun: false,
          currentStage: isDagBreakpoint ? ticket.currentStage : "plan",
          errorMessage: undefined,
          inlineMemory: {
            ...nextTicket.inlineMemory,
            activeHint: isDagBreakpoint ? note : `Plan rejected with feedback: ${note}`,
          },
        };
      } else {
        nextTicket = {
          ...nextTicket,
          pauseBeforeRun: false,
          status: "cancelled",
          errorMessage: isDagBreakpoint ? "DAG breakpoint rejected" : "Plan rejected",
        };
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
          const resolvedEngine: WorkerEngineId =
            ticket.activeEngine ??
            (repo
              ? selectEngineForStage(repo, "implement", ticket.preferredEngine)
              : ticket.preferredEngine && ticket.preferredEngine !== "auto"
                ? ticket.preferredEngine
                : "mock");
          const syntheticRun: StageRun = {
            id: newId("run"),
            ticketId: ticket.id,
            stage: "implement",
            engine: resolvedEngine,
            status: "running",
            costUsd: 0,
            startedAt: ts,
          };
          await this.stateStore.saveStageRun(syntheticRun);
          const gate = repo
            ? await this.runRepoVerificationGate(nextTicket, repo, syntheticRun, ticket.worktreePath)
            : { passed: true, artifacts: [] as SpillArtifact[], result: undefined };

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
              extraArtifacts: gate.artifacts.length > 0 ? gate.artifacts : undefined,
            });
            finishedRun.spillTranscriptId = expNote.spillArtifactIds[0];
            await this.stateStore.saveStageRun(finishedRun);

            const afterStage = ticket.prNumber
              ? "rebase"
              : getNextStage(ticket.template, "implement", ticket.tddMode);
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
    } else if (item.kind === "arena_tiebreak") {
      const repo = await this.stateStore.getRepo(ticket.repoId);
      const candidates = ticket.arenaCandidates ?? [];
      if (decision === "approved" && candidates.length > 0) {
        const chosenId =
          options?.arenaWinnerId ??
          (item.contextPayload.recommendedCandidateId as string | undefined) ??
          candidates.find((c) => c.recommended)?.candidateId ??
          candidates[0]!.candidateId;
        const winner = candidates.find((c) => c.candidateId === chosenId) ?? candidates[0]!;
        const adopted = await this.adoptArenaCandidateWinner(
          {
            ...nextTicket,
            inlineMemory: {
              ...nextTicket.inlineMemory,
              activeHint: note || nextTicket.inlineMemory.activeHint,
            },
          },
          repo ?? undefined,
          winner,
          candidates,
          true,
        );
        return { item: resolvedItem, ticket: adopted };
      } else {
        await this.previewProvider?.stopPreviewsForTicket(nextTicket.id).catch(() => {});
        await this.cleanupArenaCandidateWorktrees(candidates, repo?.rootPath);
        nextTicket = {
          ...nextTicket,
          worktreePath: undefined,
          status: "cancelled",
          errorMessage: note ?? "Arena duel rejected by human reviewer",
        };
      }
    } else if (item.kind === "epic_replan") {
      const proposal =
        ticket.pendingEpicReplan ??
        (item.contextPayload.proposal as EpicReplanProposal | undefined);
      if (decision === "approved" && proposal) {
        const appliedEpic = await this.applyEpicReplanProposal(ticket, proposal, {
          humanApproved: true,
        });
        return { item: resolvedItem, ticket: appliedEpic };
      } else {
        nextTicket = {
          ...nextTicket,
          pendingEpicReplan: undefined,
          status: ticket.isEpic ? "implementing" : ticket.status,
          errorMessage: undefined,
        };
      }
    } else if (item.kind === "clarification_request") {
      if (decision === "approved") {
        const clarificationPayload = item.contextPayload.clarification as
          | WorkerClarificationRequest
          | undefined;
        const chosenAnswer =
          options?.selectedOption?.trim() ||
          note?.trim() ||
          clarificationPayload?.recommendedOption ||
          "Proceed with the recommended engineering approach.";
        const clarificationLine = `[HUMAN CLARIFICATION] Q: ${clarificationPayload?.question ?? item.summary} -> Answer: ${chosenAnswer}${note && options?.selectedOption && note.trim() !== chosenAnswer ? ` (${note.trim()})` : ""}`;
        nextTicket = {
          ...nextTicket,
          status: "queued",
          stageRetries: 0,
          errorMessage: undefined,
          inlineMemory: {
            ...nextTicket.inlineMemory,
            threadUpdates: [
              ...nextTicket.inlineMemory.threadUpdates,
              {
                triggerId: item.id,
                message: clarificationLine,
                createdAt: ts,
              },
            ],
            activeHint: clarificationLine,
          },
        };
      } else {
        nextTicket = {
          ...nextTicket,
          status: "cancelled",
          errorMessage: note ?? "Worker clarification rejected by reviewer",
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
    if (this.stopped) return 0;
    let launched = 0;
    const initialRepos = await this.stateStore.listRepos();
    const epicById = new Map<string, Ticket>();
    for (const r of initialRepos) {
      if (this.stopped) return 0;
      const synced = (await this.syncRepoContract(r.id).catch(() => r)) ?? r;
      if (this.stopped) return 0;
      await this.router.resolveDependenciesForWaitingTickets(synced);
      await this.syncEpicStatuses(synced);
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

  private async runTicketStage(ticketId: string): Promise<void> {
    let ticket = await this.stateStore.getTicket(ticketId);
    if (!ticket || ticket.status !== "queued") return;

    const repo = await this.stateStore.getRepo(ticket.repoId);
    if (!repo) return;

    const stage = ticket.currentStage || getFirstStage(ticket.template, ticket.tddMode);

    if (ticket.pauseBeforeRun) {
      const pauseTs = nowIso();
      const paused: Ticket = {
        ...ticket,
        pauseBeforeRun: false,
        status: "needs_human",
        errorMessage: `Paused at DAG breakpoint before '${stage}' stage`,
        updatedAt: pauseTs,
      };
      await this.stateStore.saveTicket(paused);
      this.emitEvent({ type: "ticket_updated", ticket: paused, timestamp: pauseTs });
      const bpInbox: InboxItem = {
        id: newId("inb"),
        repoId: repo.id,
        ticketId: ticket.id,
        kind: "plan_approval",
        status: "pending",
        title: `DAG Breakpoint: ${ticket.title}`,
        summary: `Execution paused before '${stage}' stage per DAG breakpoint. Approve to resume (optionally include steering guidance).`,
        contextPayload: { isDagBreakpoint: true, stage },
        createdAt: pauseTs,
      };
      await this.stateStore.saveInboxItem(bpInbox);
      this.emitEvent({ type: "inbox_created", item: bpInbox, timestamp: pauseTs });
      return;
    }

    const availableEngines = await this.getAvailableEngines();

    const wantsAutoRouting =
      ticket.preferredEngine === "auto" ||
      (!ticket.preferredEngine && repo.preferredImplementEngine === "auto");
    if (wantsAutoRouting && !ticket.activeEngine && (stage === "spec_test" || stage === "implement")) {
      const currentTicket = ticket;
      const failedSet = currentTicket.failedEngines ?? [];
      const eligibleEngines = availableEngines.filter((e) => !failedSet.includes(e));
      const [repoTickets, casebookEntries] = await Promise.all([
        this.stateStore.listTickets({ repoId: repo.id }),
        this.stateStore.listCasebookEntries(repo.id, { includeReverted: true }),
      ]);
      const historicalTickets = repoTickets.filter((t) => t.id !== currentTicket.id);
      const runsLists = await Promise.all(
        historicalTickets.map((t) => this.stateStore.listStageRuns(t.id)),
      );
      const oneHourAgoMs = Date.now() - 3_600_000;
      const recentAutoArenaCountLastHour = historicalTickets.filter(
        (t) => t.autoArenaEscalated && Date.parse(t.createdAt) >= oneHourAgoMs,
      ).length;
      const today = utcTodayString();
      const effectiveDailyBudgetUsd = getEffectiveDailyBudget(repo, today);
      const todaySpendUsd =
        effectiveDailyBudgetUsd !== undefined
          ? await this.stateStore.getDailyRepoSpendUsd(repo.id, today)
          : 0;
      const routing = computeEngineRoutingDecision({
        repo,
        ticket,
        availableEngines: eligibleEngines.length > 0 ? eligibleEngines : availableEngines,
        historicalTickets,
        historicalStageRuns: runsLists.flat(),
        casebookEntries,
        todaySpendUsd,
        effectiveDailyBudgetUsd,
        recentAutoArenaCountLastHour,
      });
      ticket = {
        ...ticket,
        activeEngine: routing.chosenEngine,
        taskCategory: routing.category,
        routingRationale: routing.rationale,
        ...(stage === "implement" && routing.autoUpgradeArena && !ticket.arenaMode
          ? {
              arenaMode: true,
              arenaCompetitorEngine: routing.competitorEngine,
              autoArenaEscalated: true,
            }
          : {}),
        updatedAt: nowIso(),
      };
      await this.stateStore.saveTicket(ticket);
      this.emitEvent({ type: "ticket_updated", ticket, timestamp: ticket.updatedAt });
    }

    if (ticket.arenaMode && stage === "implement" && !ticket.arenaWinnerId) {
      const arenaHandled = await this.runArenaImplementStage(ticket, repo, availableEngines);
      if (arenaHandled) {
        return;
      }
    }

    let chosenEngine: WorkerEngineId;
    if (stage === "review") {
      const priorRuns = await this.stateStore.listStageRuns(ticket.id);
      const lastImplRun = [...priorRuns]
        .reverse()
        .find((r) => r.stage === "implement" && r.status === "completed");
      const rawImplPref =
        lastImplRun?.engine ?? ticket.preferredEngine ?? repo.preferredImplementEngine;
      const implementEngine: WorkerEngineId =
        rawImplPref === "auto"
          ? selectEngineForStage(repo, "implement")
          : rawImplPref;
      chosenEngine = selectReviewEngine({
        repo,
        implementEngine,
        availableEngines,
        explicitWatchdogEngine: ticket.activeEngine,
      });
    } else {
      const explicitEngine = ticket.activeEngine ?? ticket.preferredEngine;
      chosenEngine = selectEngineForStage(repo, stage, explicitEngine);
      if (!ticket.activeEngine && (ticket.failedEngines ?? []).includes(chosenEngine)) {
        chosenEngine =
          pickNextFallbackEngine({
            currentEngine: chosenEngine,
            failedEngines: ticket.failedEngines,
            repo,
            availableEngines,
          }) ?? chosenEngine;
      }
    }

    let driver = this.drivers.get(chosenEngine);
    if (!driver) {
      const chain = resolveFallbackChain({
        primaryEngine: chosenEngine,
        repo,
        availableEngines,
        failedEngines: ticket.failedEngines,
      });
      const alt = chain[0] ?? availableEngines[0];
      driver = alt ? this.drivers.get(alt) : undefined;
    }

    if (!driver) {
      await this.escalateTicket(ticket, "watchdog_escalation", `No WorkerDriver available for engine '${chosenEngine}'`, {
        chosenEngine,
      });
      return;
    }

    // Prepare isolated worktree workspace (and merge upstream dependency branches on initial creation)
    const spans = new SpanRecorder();
    const prepSpan = spans.start("workspace_prep", `Prepare worktree (${stage})`);
    const { effectiveBaseBranch } = await this.getEffectiveBaseInfo(ticket, repo);
    const hadWorktree = Boolean(ticket.worktreePath);
    const threadObj = !hadWorktree ? await this.stateStore.getThread(ticket.threadId) : null;
    const forkStartPoint =
      typeof threadObj?.metadata?.forkStartPoint === "string"
        ? threadObj.metadata.forkStartPoint
        : undefined;
    const lockedTicket = ticket;
    let ws: { worktreePath: string; branchName: string };
    try {
      ws = await this.runWithRepoWorkspaceLock(repo.id, () =>
        this.workspace.prepareWorkspace(lockedTicket, repo, {
          startPoint: forkStartPoint ?? effectiveBaseBranch,
        }),
      );
    } catch (err) {
      spans.end(prepSpan, "failed", err instanceof Error ? err.message : String(err));
      await this.escalateTicket(
        ticket,
        "watchdog_escalation",
        err instanceof Error ? err.message : String(err),
        { stage, phase: "prepare_workspace" },
      );
      return;
    }
    if (!hadWorktree && ticket.dependsOn.length > 0) {
      const depBranches: string[] = [];
      for (const depId of ticket.dependsOn) {
        const dep = await this.stateStore.getTicket(depId);
        // Only merge git branches from the SAME repository; cross-repo dependencies exchange contracts via HandoverDigest
        if (dep?.branchName && dep.repoId === ticket.repoId) {
          depBranches.push(dep.branchName);
        }
      }
      if (depBranches.length > 0) {
        await this.workspace.integrateDependencyBranches(ws.worktreePath, depBranches);
      }
    }
    spans.end(prepSpan, "ok", ws.branchName);
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

    if (!hadWorktree) {
      await this.captureTicketCheckpoint(ticket, repo, ws.worktreePath, {
        stage: "baseline",
        label: forkStartPoint
          ? `Forked baseline (${forkStartPoint.slice(0, 8)})`
          : `Initial baseline (${effectiveBaseBranch})`,
        changedFiles: [],
      });
    }

    // For rebase stage: attempt rebase onto baseBranch first; only run worker if conflict needs resolution!
    if (stage === "rebase") {
      await this.handleRebaseStage(ticket, repo, stageRun);
      return;
    }

    const prompt = await this.buildEnrichedWorkerPrompt(ticket, repo, stage);

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

      const probeContext = this.workspace.runRepoPreProbe
        ? await this.workspace
            .runRepoPreProbe(
              repo.rootPath,
              `${ticket.title}\n${sig.details}\n${ticket.mandate.allowedPaths.join(" ")}`,
              repo.forbiddenPaths,
            )
            .catch(() => undefined)
        : undefined;
      const decision = await this.watchdog.evaluateAndDecide({
        ticket,
        stageRun,
        signal: sig,
        recentEvents: tracker.recentEvents,
        availableEngines,
        probeContext,
        probeExecutor: this.createRepoProbeExecutor(repo),
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

    const workerSpan = spans.start("worker_turn", `${driver.engine} ${stage}`);
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
          sandboxMode: repo.sandboxMode ?? "balanced",
          rootRepoPath: repo.rootPath,
          readOnlyPaths: stage === "implement" ? ticket.lockedTestPaths : undefined,
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

    const toolProfile = buildStageToolProfile(collectedEvents);
    const turnSpanStatus: StageSpan["status"] =
      this.pendingSteers.has(ticket.id)
        ? "ok"
        : watchdogDecision
          ? "failed"
          : !completedEvent && collectedEvents.some((e) => e.type === "error")
            ? "failed"
            : "ok";
    spans.end(workerSpan, turnSpanStatus, `$${stageCostUsd.toFixed(3)}`);

    // Re-read ticket in case external cancellation happened mid-turn
    const latestTicket = await this.stateStore.getTicket(ticket.id);
    if (latestTicket && latestTicket.status === "cancelled") {
      this.pendingSteers.delete(ticket.id);
      await this.stateStore.saveStageRun({
        ...stageRun,
        status: "aborted",
        nativeSessionId: discoveredSessionId,
        costUsd: stageCostUsd,
        spans: spans.toArray(),
        toolProfile,
        completedAt: nowIso(),
        summary: "Cancelled by user",
      });
      return;
    }

    if (this.stopped) {
      this.pendingSteers.delete(ticket.id);
      await this.stateStore.saveStageRun({
        ...stageRun,
        status: "aborted",
        nativeSessionId: discoveredSessionId,
        costUsd: stageCostUsd,
        spans: spans.toArray(),
        toolProfile,
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

    // Handle mid-turn lossless Live Steer without burning stageRetries
    const pendingSteer = this.pendingSteers.get(ticket.id);
    if (pendingSteer && abortController.signal.aborted) {
      this.pendingSteers.delete(ticket.id);
      const ts = nowIso();
      const steeredRun: StageRun = {
        ...stageRun,
        status: "aborted",
        nativeSessionId: discoveredSessionId,
        costUsd: stageCostUsd,
        spans: spans.toArray(),
        toolProfile,
        steered: true,
        completedAt: ts,
        summary: `Live steer applied: ${pendingSteer.instruction.slice(0, 140)}`,
      };
      const { note: steerNote } = await this.memory.recordStageSpillAndNote({
        ticket,
        stageRun: steeredRun,
        events: collectedEvents,
        changedFiles: [],
        summary: steeredRun.summary!,
        verificationPassed: false,
      });
      steeredRun.spillTranscriptId = steerNote.spillArtifactIds[0];
      await this.stateStore.saveStageRun(steeredRun);
      this.emitEvent({
        type: "stage_completed",
        ticketId: ticket.id,
        stageRun: steeredRun,
        note: steerNote,
        timestamp: ts,
      });

      const preservedSessions =
        discoveredSessionId && stage !== "review"
          ? { ...ticket.nativeSessions, [driver.engine]: discoveredSessionId }
          : ticket.nativeSessions;
      const switchedEngine =
        pendingSteer.preferredEngine && pendingSteer.preferredEngine !== "auto"
          ? pendingSteer.preferredEngine
          : driver.engine;

      const steeredTicket: Ticket = {
        ...ticket,
        status: "queued",
        steerCount: (ticket.steerCount ?? 0) + 1,
        costUsd: ticket.costUsd + stageCostUsd,
        nativeSessions: preservedSessions,
        preferredEngine: pendingSteer.preferredEngine ?? ticket.preferredEngine,
        activeEngine: switchedEngine,
        inlineMemory: {
          ...ticket.inlineMemory,
          stageNotes: [...ticket.inlineMemory.stageNotes, steerNote],
          threadUpdates: [
            ...ticket.inlineMemory.threadUpdates,
            {
              triggerId: newId("str"),
              message: `[Live Steer]: ${pendingSteer.instruction}`,
              createdAt: ts,
            },
          ],
          activeHint: `[LIVE STEER]: ${pendingSteer.instruction}`,
        },
        updatedAt: ts,
      };
      await this.stateStore.saveTicket(steeredTicket);
      this.emitEvent({
        type: "ticket_updated",
        ticket: steeredTicket,
        timestamp: ts,
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
        spans: spans.toArray(),
        toolProfile,
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
        const nextFailed = Array.from(new Set([...(ticket.failedEngines ?? []), driver.engine]));
        const altEngine =
          dec.targetEngine &&
          dec.targetEngine !== driver.engine &&
          !nextFailed.includes(dec.targetEngine) &&
          availableEngines.includes(dec.targetEngine)
            ? dec.targetEngine
            : pickNextFallbackEngine({
                currentEngine: driver.engine,
                failedEngines: nextFailed,
                repo,
                availableEngines,
              }) ?? getAlternateEngine(driver.engine, availableEngines);
        if (altEngine && altEngine !== driver.engine && !nextFailed.includes(altEngine)) {
          const nextTicket: Ticket = {
            ...ticket,
            status: "queued",
            activeEngine: altEngine,
            failedEngines: nextFailed,
            stageRetries: ticket.stageRetries + 1,
            costUsd: ticket.costUsd + stageCostUsd,
            inlineMemory: {
              ...ticket.inlineMemory,
              activeHint:
                dec.hint ??
                `[Fallback Engine: ${driver.engine} -> ${altEngine}] Switched due to: ${dec.reason}`,
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

    // Check if turn failed without completion -> auto fallback to next healthy engine in chain
    const lastErrorEvent = [...collectedEvents].reverse().find((e) => e.type === "error");
    if (!completedEvent && lastErrorEvent && lastErrorEvent.type === "error") {
      const failedRun: StageRun = {
        ...stageRun,
        status: "failed",
        nativeSessionId: discoveredSessionId,
        costUsd: stageCostUsd,
        spans: spans.toArray(),
        toolProfile,
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

      const nextFailed = Array.from(new Set([...(ticket.failedEngines ?? []), driver.engine]));
      const fallbackEngine = pickNextFallbackEngine({
        currentEngine: driver.engine,
        failedEngines: nextFailed,
        repo,
        availableEngines,
      });

      if (fallbackEngine) {
        const handedOff: Ticket = {
          ...ticket,
          status: "queued",
          activeEngine: fallbackEngine,
          failedEngines: nextFailed,
          stageRetries: 0,
          costUsd: ticket.costUsd + stageCostUsd,
          inlineMemory: {
            ...ticket.inlineMemory,
            activeHint: `[Engine Fallback: ${driver.engine} -> ${fallbackEngine}] Previous engine errored (${lastErrorEvent.message}). Existing worktree state is preserved; continue and finish cleanly.`,
          },
          updatedAt: nowIso(),
        };
        await this.stateStore.saveTicket(handedOff);
        this.emitEvent({ type: "ticket_updated", ticket: handedOff, timestamp: handedOff.updatedAt });
      } else if (ticket.stageRetries < ticket.mandate.maxStageRetries) {
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
          { stageRunId: stageRun.id, failedEngines: nextFailed },
        );
      }
      return;
    }

    if (stage === "spec_test") {
      await this.handleSpecTestPostTurn({
        ticket,
        repo,
        stageRun,
        worktreePath: ws.worktreePath,
        effectiveBaseBranch,
        driverEngine: driver.engine,
        collectedEvents,
        completedEvent,
        discoveredSessionId,
        stageCostUsd,
      });
      return;
    }

    // Post-turn Mandate Guardrail & Locked Spec-Test Integrity Check via Git Diff
    const changedFiles = await this.workspace.getChangedFiles(ws.worktreePath, effectiveBaseBranch);
    const diffText = await this.workspace.getDiff(ws.worktreePath, effectiveBaseBranch);
    const textChunks = collectedEvents
      .filter((e): e is Extract<WorkerStreamEvent, { type: "text" }> => e.type === "text")
      .map((e) => e.text)
      .join("\n");
    const summary = completedEvent?.summary || textChunks || `${stage} completed`;

    let tamperedLockedTests: string[] = [];
    if (
      stage === "implement" &&
      ticket.lockedTestPaths &&
      ticket.lockedTestPaths.length > 0 &&
      ticket.specTestCommitSha &&
      this.workspace.getChangedFilesSince
    ) {
      const changedSinceSpec = await this.workspace.getChangedFilesSince(
        ws.worktreePath,
        ticket.specTestCommitSha,
      );
      tamperedLockedTests = changedSinceSpec.filter((f) => ticket.lockedTestPaths!.includes(f));
      if (tamperedLockedTests.length > 0) {
        await this.workspace.revertPathsToCommit?.(
          ws.worktreePath,
          ticket.specTestCommitSha,
          tamperedLockedTests,
        );
      }
    }

    const challengeReason =
      stage === "implement" && ticket.tddMode
        ? parseSpecTestChallenge(`${summary}\n${textChunks}`)
        : null;

    if (tamperedLockedTests.length > 0 && !challengeReason) {
      const tamperSummary = `Locked spec_test file(s) modified during implement and reverted: ${tamperedLockedTests.join(", ")}`;
      const failedRun: StageRun = {
        ...stageRun,
        status: "failed",
        nativeSessionId: discoveredSessionId,
        costUsd: stageCostUsd,
        completedAt: nowIso(),
        summary: tamperSummary,
      };
      await this.stateStore.saveStageRun(failedRun);
      const { note: tNote } = await this.memory.recordStageSpillAndNote({
        ticket,
        stageRun: failedRun,
        events: collectedEvents,
        changedFiles: tamperedLockedTests,
        diffText,
        summary: tamperSummary,
        verificationPassed: false,
      });
      const updatedTamperSessions =
        discoveredSessionId ? { ...ticket.nativeSessions, [driver.engine]: discoveredSessionId } : ticket.nativeSessions;

      if (ticket.stageRetries < ticket.mandate.maxStageRetries) {
        const retrying: Ticket = {
          ...ticket,
          status: "queued",
          stageRetries: ticket.stageRetries + 1,
          costUsd: ticket.costUsd + stageCostUsd,
          nativeSessions: updatedTamperSessions,
          inlineMemory: {
            ...ticket.inlineMemory,
            stageNotes: [...ticket.inlineMemory.stageNotes, tNote],
            activeHint: `${tamperSummary}. Locked test files are read-only; fix production code or emit SPEC_TEST_CHALLENGE: <reason> if the spec test itself is flawed.`,
          },
          updatedAt: nowIso(),
        };
        await this.stateStore.saveTicket(retrying);
        this.emitEvent({ type: "ticket_updated", ticket: retrying, timestamp: retrying.updatedAt });
      } else {
        await this.escalateTicket(
          {
            ...ticket,
            costUsd: ticket.costUsd + stageCostUsd,
            nativeSessions: updatedTamperSessions,
            inlineMemory: {
              ...ticket.inlineMemory,
              stageNotes: [...ticket.inlineMemory.stageNotes, tNote],
            },
          },
          "mandate_violation",
          tamperSummary,
          { tamperedLockedTests, interruptedStage: stage },
        );
      }
      return;
    }

    const filesForMandate =
      ticket.lockedTestPaths && ticket.lockedTestPaths.length > 0
        ? changedFiles.filter((f) => !ticket.lockedTestPaths!.includes(f))
        : changedFiles;
    const mandateCheck = validateChangedFilesAgainstMandate(filesForMandate, ticket.mandate);

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

    if (challengeReason) {
      const canRewind = (ticket.specTestChallengeCount ?? 0) < 1;
      const chRun: StageRun = {
        ...stageRun,
        status: canRewind ? "completed" : "failed",
        nativeSessionId: discoveredSessionId,
        costUsd: stageCostUsd,
        spans: spans.toArray(),
        toolProfile,
        completedAt: nowIso(),
        summary: `SPEC_TEST_CHALLENGE: ${challengeReason}`,
      };
      const { note: chNote } = await this.memory.recordStageSpillAndNote({
        ticket,
        stageRun: chRun,
        events: collectedEvents,
        changedFiles,
        diffText,
        summary: chRun.summary!,
        verificationPassed: false,
      });
      chRun.spillTranscriptId = chNote.spillArtifactIds[0];
      await this.stateStore.saveStageRun(chRun);
      this.emitEvent({
        type: "stage_completed",
        ticketId: ticket.id,
        stageRun: chRun,
        note: chNote,
        timestamp: chRun.completedAt!,
      });

      const updatedChallengeSessions = discoveredSessionId
        ? { ...ticket.nativeSessions, [driver.engine]: discoveredSessionId }
        : ticket.nativeSessions;

      if (canRewind) {
        const rewound: Ticket = {
          ...ticket,
          status: "queued",
          currentStage: "spec_test",
          stageRetries: 0,
          specTestChallengeCount: (ticket.specTestChallengeCount ?? 0) + 1,
          lockedTestPaths: undefined,
          activeEngine: undefined,
          failedEngines: [],
          costUsd: ticket.costUsd + stageCostUsd,
          nativeSessions: updatedChallengeSessions,
          inlineMemory: {
            ...ticket.inlineMemory,
            stageNotes: [...ticket.inlineMemory.stageNotes, chNote],
            activeHint: `[SPEC_TEST_CHALLENGE from implement] Review and repair the specification tests if justified: ${challengeReason}`,
          },
          updatedAt: nowIso(),
        };
        await this.stateStore.saveTicket(rewound);
        this.emitEvent({ type: "ticket_updated", ticket: rewound, timestamp: rewound.updatedAt });
        return;
      }

      await this.escalateTicket(
        {
          ...ticket,
          costUsd: ticket.costUsd + stageCostUsd,
          nativeSessions: updatedChallengeSessions,
          inlineMemory: {
            ...ticket.inlineMemory,
            stageNotes: [...ticket.inlineMemory.stageNotes, chNote],
          },
        },
        "watchdog_escalation",
        `SPEC_TEST_CHALLENGE raised again after max 1 rewind: ${challengeReason}`,
        { stageRunId: chRun.id, challengeReason },
      );
      return;
    }

    // Worker structured clarification protocol (capped at 1 per ticket)
    const workerClarification =
      (stage === "plan" || stage === "implement") && (ticket.clarificationCount ?? 0) < 1
        ? extractWorkerClarificationRequest(
            collectedEvents,
            completedEvent?.structuredOutput?.clarificationRequest,
          )
        : null;
    if (workerClarification) {
      const clarTs = nowIso();
      const clarRun: StageRun = {
        ...stageRun,
        status: "completed",
        nativeSessionId: discoveredSessionId,
        costUsd: stageCostUsd,
        spans: spans.toArray(),
        toolProfile,
        completedAt: clarTs,
        summary: `Clarification requested: ${workerClarification.question}`,
      };
      const { note: clarNote } = await this.memory.recordStageSpillAndNote({
        ticket,
        stageRun: clarRun,
        events: collectedEvents,
        changedFiles,
        diffText,
        summary: clarRun.summary!,
        verificationPassed: false,
      });
      clarRun.spillTranscriptId = clarNote.spillArtifactIds[0];
      await this.stateStore.saveStageRun(clarRun);
      this.emitEvent({
        type: "stage_completed",
        ticketId: ticket.id,
        stageRun: clarRun,
        note: clarNote,
        timestamp: clarTs,
      });

      const updatedClarSessions = discoveredSessionId
        ? { ...ticket.nativeSessions, [driver.engine]: discoveredSessionId }
        : ticket.nativeSessions;
      const effectiveGatePolicy = ticket.deliveryGatePolicy ?? repo.deliveryGatePolicy ?? "always_auto";
      const shouldPauseForHuman =
        repo.mode === "observe" ||
        ticket.template === "strict" ||
        effectiveGatePolicy === "risk_gated" ||
        effectiveGatePolicy === "always_signoff";

      if (shouldPauseForHuman) {
        await this.escalateTicket(
          {
            ...ticket,
            clarificationCount: (ticket.clarificationCount ?? 0) + 1,
            costUsd: ticket.costUsd + stageCostUsd,
            nativeSessions: updatedClarSessions,
            inlineMemory: {
              ...ticket.inlineMemory,
              stageNotes: [...ticket.inlineMemory.stageNotes, clarNote],
            },
          },
          "clarification_request",
          workerClarification.question,
          {
            clarification: workerClarification,
            stage,
            stageRunId: clarRun.id,
          },
        );
        return;
      }

      const autoLine = `[AUTO-CLARIFIED] Q: ${workerClarification.question} -> Adopted recommended option: ${workerClarification.recommendedOption}`;
      const autoResumed: Ticket = {
        ...ticket,
        status: "queued",
        clarificationCount: (ticket.clarificationCount ?? 0) + 1,
        costUsd: ticket.costUsd + stageCostUsd,
        nativeSessions: updatedClarSessions,
        activeEngine: driver.engine,
        inlineMemory: {
          ...ticket.inlineMemory,
          stageNotes: [...ticket.inlineMemory.stageNotes, clarNote],
          threadUpdates: [
            ...ticket.inlineMemory.threadUpdates,
            {
              triggerId: newId("clr"),
              message: autoLine,
              createdAt: clarTs,
            },
          ],
          activeHint: autoLine,
        },
        updatedAt: clarTs,
      };
      await this.stateStore.saveTicket(autoResumed);
      this.emitEvent({
        type: "ticket_updated",
        ticket: autoResumed,
        timestamp: clarTs,
      });
      return;
    }

    let reviewApproved: boolean | undefined;
    let reviewReport: ReviewReport | undefined;
    let reviewReportArtifact: SpillArtifact | undefined;
    if (stage === "review") {
      reviewReport = parseReviewReport({
        summary,
        textChunks,
        structuredOutput: completedEvent?.structuredOutput,
        engine: driver.engine,
      });
      reviewApproved = reviewReport.verdict === "approved";

      reviewReportArtifact = await this.artifactStore.writeSpill(
        {
          ticketId: ticket.id,
          stageRunId: stageRun.id,
          kind: "review_report",
          summary: `Review ${reviewReport.verdict} (${reviewReport.findings.length} finding(s))`,
          ext: "json",
        },
        JSON.stringify(reviewReport, null, 2),
      );
      await this.stateStore.saveArtifact(
        reviewReportArtifact,
        [reviewReport.verdict, ...reviewReport.findings.map((f) => `${f.severity} ${f.file ?? ""} ${f.message}`)].join("\n"),
      );
      if (reviewReport.findings.length > 0) {
        await syncAiFindingsToReviewComments(this.coordinatorCtx(), ticket, reviewReport.findings);
      }
    }

    let verificationArtifacts: SpillArtifact[] = [];
    let verificationPassed = completedEvent?.structuredOutput?.verificationPassed ?? true;
    if (stage === "implement") {
      const gate = await this.runRepoVerificationGate(ticket, repo, stageRun, ws.worktreePath, {
        isFinalDeliveryGate: false,
      });
      spans.addExisting(gate.spans);
      verificationArtifacts = gate.artifacts;
      verificationPassed = gate.passed;
      if (!gate.passed) {
        const failedSummary = gate.result?.summary ?? "Deterministic verification gate failed";
        const failedRun: StageRun = {
          ...stageRun,
          status: "failed",
          nativeSessionId: discoveredSessionId,
          costUsd: stageCostUsd,
          spans: spans.toArray(),
          toolProfile,
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
          extraArtifacts: verificationArtifacts.length > 0 ? verificationArtifacts : undefined,
        });
        failedRun.spillTranscriptId = failNote.spillArtifactIds[0];
        await this.stateStore.saveStageRun(failedRun);
        await this.captureTicketCheckpoint(ticket, repo, ws.worktreePath, {
          stage: "implement",
          stageRunId: failedRun.id,
          engine: driver.engine,
          label: `Implement attempt #${ticket.stageRetries + 1} (failed gate)`,
          changedFiles,
          verificationPassed: false,
        });
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
            activeEngine: driver.engine,
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
          const nextFailed = Array.from(new Set([...(ticket.failedEngines ?? []), driver.engine]));
          const fallbackEngine = pickNextFallbackEngine({
            currentEngine: driver.engine,
            failedEngines: nextFailed,
            repo,
            availableEngines,
          });
          if (fallbackEngine) {
            const handedOff: Ticket = {
              ...ticket,
              status: "queued",
              stageRetries: 0,
              costUsd: ticket.costUsd + stageCostUsd,
              nativeSessions: updatedFailSessions,
              failedEngines: nextFailed,
              activeEngine: fallbackEngine,
              inlineMemory: {
                ...updatedFailMemory,
                activeHint: `[Engine Fallback: ${driver.engine} -> ${fallbackEngine}] ${driver.engine} exhausted retries on verification gate (${gate.result?.failedCommand ?? "checks"}). Preserved worktree changes; fix and pass verification:\n${failedSummary}`,
              },
              updatedAt: nowIso(),
            };
            await this.stateStore.saveTicket(handedOff);
            this.emitEvent({
              type: "ticket_updated",
              ticket: handedOff,
              timestamp: handedOff.updatedAt,
            });
          } else {
            await this.escalateTicket(
              {
                ...ticket,
                costUsd: ticket.costUsd + stageCostUsd,
                nativeSessions: updatedFailSessions,
                failedEngines: nextFailed,
                inlineMemory: updatedFailMemory,
              },
              "watchdog_escalation",
              `Deterministic verification failed after ${ticket.mandate.maxStageRetries} retries: ${gate.result?.failedCommand ?? failedSummary}`,
              { stageRunId: failedRun.id, failedCommand: gate.result?.failedCommand, failedEngines: nextFailed },
            );
          }
        }
        return;
      }
    }

    const extraArtifacts: SpillArtifact[] = [...verificationArtifacts];
    if (reviewReportArtifact) extraArtifacts.push(reviewReportArtifact);

    const nitText =
      reviewApproved && reviewReport && reviewReport.findings.length > 0
        ? formatNitSummary(reviewReport.findings)
        : "";
    const noteSummary = nitText ? `${summary}\nAdvisory nits: ${nitText}` : summary;

    const finishedRun: StageRun = {
      ...stageRun,
      status: "completed",
      nativeSessionId: discoveredSessionId,
      costUsd: stageCostUsd,
      spans: spans.toArray(),
      toolProfile,
      completedAt: nowIso(),
      summary: noteSummary,
    };

    const { note } = await this.memory.recordStageSpillAndNote({
      ticket,
      stageRun: finishedRun,
      events: collectedEvents,
      changedFiles,
      diffText,
      summary: noteSummary,
      verificationPassed,
      reviewApproved,
      reviewFindings: reviewReport?.findings,
      extraArtifacts: extraArtifacts.length > 0 ? extraArtifacts : undefined,
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
      await autoResolveModifiedReviewComments(this.coordinatorCtx(), ticket.id, changedFiles);
      await this.workspace.commitAll(ws.worktreePath, `super-work(${ticket.id}): ${ticket.title}`);
      await this.captureTicketCheckpoint(ticket, repo, ws.worktreePath, {
        stage: "implement",
        stageRunId: finishedRun.id,
        engine: driver.engine,
        label: "Implement verified & committed",
        changedFiles,
        verificationPassed: true,
      });
    }

    if (stage === "review" && reviewApproved === false) {
      const feedback =
        reviewReport && reviewReport.findings.length > 0
          ? formatBlockingFindingsForRework(reviewReport.findings)
          : completedEvent?.structuredOutput?.feedback || summary;
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
            activeHint: `Review requested changes. Address blocking findings:\n${feedback}`,
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
        `Code review rejected after ${ticket.mandate.maxStageRetries} revisions:\n${feedback}`,
        { stageRunId: finishedRun.id, findings: reviewReport?.findings ?? [] },
      );
      return;
    }

    const nextStage: StageKind | null =
      stage === "implement" && ticket.prNumber
        ? "rebase"
        : getNextStage(ticket.template, stage, ticket.tddMode);
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
      failedEngines: [],
      inlineMemory: updatedMemory,
      updatedAt: nowIso(),
    };
    await this.stateStore.saveTicket(advancing);
    this.emitEvent({ type: "ticket_updated", ticket: advancing, timestamp: advancing.updatedAt });
  }

  private async handleSpecTestPostTurn(input: {
    ticket: Ticket;
    repo: RepoConfig;
    stageRun: StageRun;
    worktreePath: string;
    effectiveBaseBranch: string;
    driverEngine: WorkerEngineId;
    collectedEvents: WorkerStreamEvent[];
    completedEvent: Extract<WorkerStreamEvent, { type: "completed" }> | null;
    discoveredSessionId?: string;
    stageCostUsd: number;
  }): Promise<void> {
    const {
      ticket,
      repo,
      stageRun,
      worktreePath,
      effectiveBaseBranch,
      driverEngine,
      collectedEvents,
      completedEvent,
      discoveredSessionId,
      stageCostUsd,
    } = input;

    const changedFiles = await this.workspace.getChangedFiles(worktreePath, effectiveBaseBranch);
    const diffText = await this.workspace.getDiff(worktreePath, effectiveBaseBranch);
    const textChunks = collectedEvents
      .filter((e): e is Extract<WorkerStreamEvent, { type: "text" }> => e.type === "text")
      .map((e) => e.text)
      .join("\n");
    const summary = completedEvent?.summary || textChunks || "spec_test completed";

    const forbiddenViolations = validateChangedFilesAgainstMandate(changedFiles, {
      ...ticket.mandate,
      allowedPaths: ["**"],
    }).forbiddenViolations;
    const nonTestFiles = changedFiles.filter((f) => !isSpecTestFilePath(f));
    const updatedSessions = discoveredSessionId
      ? { ...ticket.nativeSessions, [driverEngine]: discoveredSessionId }
      : ticket.nativeSessions;

    if (forbiddenViolations.length > 0 || nonTestFiles.length > 0) {
      const toRevert = Array.from(new Set([...forbiddenViolations, ...nonTestFiles]));
      await this.workspace.revertPaths(worktreePath, toRevert);
      const failSummary = `spec_test may only create/modify test files; reverted: ${toRevert.join(", ")}`;
      const failedRun: StageRun = {
        ...stageRun,
        status: "failed",
        nativeSessionId: discoveredSessionId,
        costUsd: stageCostUsd,
        completedAt: nowIso(),
        summary: failSummary,
      };
      await this.stateStore.saveStageRun(failedRun);
      const { note: errNote } = await this.memory.recordStageSpillAndNote({
        ticket,
        stageRun: failedRun,
        events: collectedEvents,
        changedFiles: toRevert,
        diffText,
        summary: failSummary,
        verificationPassed: false,
      });

      if (forbiddenViolations.length === 0 && ticket.stageRetries < ticket.mandate.maxStageRetries) {
        const retrying: Ticket = {
          ...ticket,
          status: "queued",
          stageRetries: ticket.stageRetries + 1,
          costUsd: ticket.costUsd + stageCostUsd,
          nativeSessions: updatedSessions,
          inlineMemory: {
            ...ticket.inlineMemory,
            stageNotes: [...ticket.inlineMemory.stageNotes, errNote],
            activeHint: `spec_test stage may ONLY write test files (*.test.*, *.spec.*, test/**, tests/**, __tests__/**). Reverted non-test files: ${nonTestFiles.join(", ")}. Write failing tests only.`,
          },
          updatedAt: nowIso(),
        };
        await this.stateStore.saveTicket(retrying);
        this.emitEvent({ type: "ticket_updated", ticket: retrying, timestamp: retrying.updatedAt });
      } else {
        await this.escalateTicket(
          {
            ...ticket,
            costUsd: ticket.costUsd + stageCostUsd,
            nativeSessions: updatedSessions,
            inlineMemory: {
              ...ticket.inlineMemory,
              stageNotes: [...ticket.inlineMemory.stageNotes, errNote],
            },
          },
          "mandate_violation",
          failSummary,
          { violations: toRevert, forbiddenViolations, nonTestFiles, interruptedStage: "spec_test" },
        );
      }
      return;
    }

    const testFiles = changedFiles.filter((f) => isSpecTestFilePath(f));
    if (testFiles.length === 0) {
      const emptySummary = "spec_test produced no test files to lock.";
      const failedRun: StageRun = {
        ...stageRun,
        status: "failed",
        nativeSessionId: discoveredSessionId,
        costUsd: stageCostUsd,
        completedAt: nowIso(),
        summary: emptySummary,
      };
      await this.stateStore.saveStageRun(failedRun);
      const { note: emptyNote } = await this.memory.recordStageSpillAndNote({
        ticket,
        stageRun: failedRun,
        events: collectedEvents,
        changedFiles: [],
        diffText,
        summary: emptySummary,
        verificationPassed: false,
      });

      if (ticket.stageRetries < ticket.mandate.maxStageRetries) {
        const retrying: Ticket = {
          ...ticket,
          status: "queued",
          stageRetries: ticket.stageRetries + 1,
          costUsd: ticket.costUsd + stageCostUsd,
          nativeSessions: updatedSessions,
          inlineMemory: {
            ...ticket.inlineMemory,
            stageNotes: [...ticket.inlineMemory.stageNotes, emptyNote],
            activeHint:
              "spec_test stage created zero test files. Write at least one failing test file encoding the acceptance criteria.",
          },
          updatedAt: nowIso(),
        };
        await this.stateStore.saveTicket(retrying);
        this.emitEvent({ type: "ticket_updated", ticket: retrying, timestamp: retrying.updatedAt });
      } else {
        await this.escalateTicket(
          {
            ...ticket,
            costUsd: ticket.costUsd + stageCostUsd,
            nativeSessions: updatedSessions,
            inlineMemory: {
              ...ticket.inlineMemory,
              stageNotes: [...ticket.inlineMemory.stageNotes, emptyNote],
            },
          },
          "watchdog_escalation",
          emptySummary,
          { stageRunId: failedRun.id },
        );
      }
      return;
    }

    const extraArtifacts: SpillArtifact[] = [];
    let redProbeHint = `Locked spec_test file(s): ${testFiles.join(", ")}. Implement ONLY production code to pass these tests.`;
    const commands = (repo.verificationCommands ?? []).map((c) => c.trim()).filter(Boolean);
    if (commands.length > 0) {
      const redRes = await this.workspace.runVerificationCommands(
        worktreePath,
        commands,
        ticket.mandate.maxDurationSec,
        {
          sandboxMode: repo.sandboxMode ?? "balanced",
          forbiddenPaths: ticket.mandate.forbiddenPaths,
          allowNetwork: ticket.mandate.allowNetwork,
          rootRepoPath: repo.rootPath,
        },
      );
      const logBody = redRes.results
        .map(
          (r) =>
            `$ ${r.command}\n[exit=${r.exitCode}, duration=${r.durationMs}ms]\n${r.output || "(no output)"}\n`,
        )
        .join("\n---\n");
      const probeArtifact = await this.artifactStore.writeSpill(
        {
          ticketId: ticket.id,
          stageRunId: stageRun.id,
          kind: "test_log",
          summary: `Red-first probe (${redRes.ok ? "GREEN advisory" : "RED expected fail"})`,
          ext: "log",
        },
        logBody || redRes.summary,
      );
      await this.stateStore.saveArtifact(probeArtifact, `${redRes.summary}\n${logBody}`);
      extraArtifacts.push(probeArtifact);
      redProbeHint = redRes.ok
        ? `Red-first probe passed early (advisory). Implement remaining behavior cleanly without modifying locked tests: ${testFiles.join(", ")}.`
        : `Red-first probe failed as expected (RED phase) on ${redRes.failedCommand ?? "tests"}. Locked read-only spec tests: ${testFiles.join(", ")}. Implement code until checks pass.`;
    }

    await this.workspace.commitAll(worktreePath, `super-work(${ticket.id}/spec_test): lock spec tests`);
    const specTestCommitSha = this.workspace.getHeadCommitSha
      ? await this.workspace.getHeadCommitSha(worktreePath).catch(() => undefined)
      : undefined;

    const finishedRun: StageRun = {
      ...stageRun,
      status: "completed",
      nativeSessionId: discoveredSessionId,
      costUsd: stageCostUsd,
      toolProfile: buildStageToolProfile(collectedEvents),
      completedAt: nowIso(),
      summary: `${summary}\nLocked ${testFiles.length} spec test file(s).`,
    };
    const { note } = await this.memory.recordStageSpillAndNote({
      ticket,
      stageRun: finishedRun,
      events: collectedEvents,
      changedFiles: testFiles,
      diffText,
      summary: finishedRun.summary!,
      verificationPassed: true,
      extraArtifacts: extraArtifacts.length > 0 ? extraArtifacts : undefined,
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

    await this.captureTicketCheckpoint(ticket, repo, worktreePath, {
      stage: "spec_test",
      stageRunId: finishedRun.id,
      engine: driverEngine,
      label: `Locked ${testFiles.length} spec test file(s)`,
      changedFiles: testFiles,
      verificationPassed: true,
    });

    const nextStage = getNextStage(ticket.template, "spec_test", ticket.tddMode) ?? "implement";
    const nextTicket: Ticket = {
      ...ticket,
      status: "queued",
      currentStage: nextStage,
      stageRetries: 0,
      lockedTestPaths: testFiles,
      specTestCommitSha,
      costUsd: ticket.costUsd + stageCostUsd,
      nativeSessions: updatedSessions,
      activeEngine: undefined,
      failedEngines: [],
      inlineMemory: {
        ...ticket.inlineMemory,
        stageNotes: [...ticket.inlineMemory.stageNotes, note],
        activeHint: redProbeHint,
      },
      updatedAt: nowIso(),
    };
    await this.stateStore.saveTicket(nextTicket);
    this.emitEvent({ type: "ticket_updated", ticket: nextTicket, timestamp: nextTicket.updatedAt });
  }

  private async handleRebaseStage(ticket: Ticket, repo: RepoConfig, stageRun: StageRun): Promise<void> {
    const worktreePath = ticket.worktreePath!;
    const { effectiveBaseBranch, parentEpic } = await this.getEffectiveBaseInfo(ticket, repo);
    const spans = new SpanRecorder();
    let workingTicket = ticket;
    let preConflictCp: TicketCheckpoint | null = null;
    let attemptConflictCtx: ConflictSemanticContext | undefined;
    let autoResolvedConflict = false;
    let resolveCostUsd = 0;

    const commitSpan = spans.start("git_ops", `Commit & rebase onto ${effectiveBaseBranch}`);
    await this.workspace.commitAll(worktreePath, `super-work(${ticket.id}): ${ticket.title}`);
    const rebaseRes = await this.workspace.rebaseOntoBase(worktreePath, effectiveBaseBranch);
    spans.end(commitSpan, rebaseRes.ok ? "ok" : "failed", rebaseRes.conflictSummary);

    if (!rebaseRes.ok) {
      const canAttemptSemanticResolve =
        (ticket.conflictResolutionCount ?? 0) < 1 &&
        Boolean(this.workspace.prepareThreeWayConflictWorkspace);

      if (!canAttemptSemanticResolve) {
        const failedRun: StageRun = {
          ...stageRun,
          status: "failed",
          spans: spans.toArray(),
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
            { branchName: ticket.branchName, conflictContext: ticket.conflictContext },
          );
        }
        return;
      }

      preConflictCp = await this.captureTicketCheckpoint(ticket, repo, worktreePath, {
        stage: "rebase",
        stageRunId: stageRun.id,
        label: `Pre-rebase conflict snapshot (${effectiveBaseBranch})`,
        changedFiles: [],
      });

      const prepSpan = spans.start("git_ops", "Prepare 3-way semantic conflict workspace");
      const prep = await this.workspace.prepareThreeWayConflictWorkspace!({
        worktreePath,
        rootRepoPath: repo.rootPath,
        baseBranch: effectiveBaseBranch,
      });
      attemptConflictCtx = {
        baseBranch: effectiveBaseBranch,
        mergeBaseSha: prep.mergeBaseSha,
        upstreamCommitSummaries: prep.upstreamCommitSummaries,
        conflictFiles: prep.conflictFiles,
        fileHunks: prep.fileHunks,
      };
      spans.end(prepSpan, prep.conflictFiles.length > 0 ? "ok" : "failed", `${prep.conflictFiles.length} file(s)`);

      const availableEngines = await this.getAvailableEngines();
      let chosenEngine = selectEngineForStage(repo, "implement", ticket.preferredEngine);
      if (!this.drivers.has(chosenEngine) && availableEngines[0]) {
        chosenEngine = availableEngines[0];
      }
      const driver = this.drivers.get(chosenEngine);

      const failConflictEscalation = async (
        reason: string,
        collectedEvents: WorkerStreamEvent[] = [],
      ): Promise<void> => {
        if (preConflictCp && this.workspace.restoreWorktreeCheckpoint) {
          await this.workspace
            .restoreWorktreeCheckpoint({
              worktreePath,
              rootRepoPath: repo.rootPath,
              commitSha: preConflictCp.commitSha,
            })
            .catch(() => {});
        }
        const failedCtx: ConflictSemanticContext = {
          ...attemptConflictCtx!,
          resolvedAutomatically: false,
          resolutionSummary: reason,
        };
        const failedRun: StageRun = {
          ...stageRun,
          status: "failed",
          costUsd: resolveCostUsd,
          spans: spans.toArray(),
          completedAt: nowIso(),
          summary: reason,
        };
        const { note: failNote } = await this.memory.recordStageSpillAndNote({
          ticket,
          stageRun: failedRun,
          events: collectedEvents,
          changedFiles: attemptConflictCtx?.conflictFiles ?? [],
          summary: reason,
          verificationPassed: false,
        });
        failedRun.spillTranscriptId = failNote.spillArtifactIds[0];
        await this.stateStore.saveStageRun(failedRun);
        await this.escalateTicket(
          {
            ...ticket,
            costUsd: ticket.costUsd + resolveCostUsd,
            conflictResolutionCount: (ticket.conflictResolutionCount ?? 0) + 1,
            conflictContext: failedCtx,
            inlineMemory: {
              ...ticket.inlineMemory,
              stageNotes: [...ticket.inlineMemory.stageNotes, failNote],
            },
          },
          "merge_conflict",
          reason,
          {
            branchName: ticket.branchName,
            conflictContext: failedCtx,
            stageRunId: stageRun.id,
          },
        );
      };

      if (!driver || prep.conflictFiles.length === 0) {
        await failConflictEscalation(
          `Rebase onto ${effectiveBaseBranch} conflicted (${prep.conflictFiles.join(", ") || rebaseRes.conflictSummary}); automatic 3-way resolution unavailable.`,
        );
        return;
      }

      const conflictPrompt = buildConflictResolutionPrompt(ticket, attemptConflictCtx);
      const resolveSpan = spans.start(
        "worker_turn",
        `3-way conflict resolve (${prep.conflictFiles.length} file(s), ${driver.engine})`,
      );
      const collectedEvents: WorkerStreamEvent[] = [];
      let completedEvent: Extract<WorkerStreamEvent, { type: "completed" }> | undefined;
      const abortController = new AbortController();
      const timeoutHandle = setTimeout(
        () => abortController.abort("conflict_resolve_timeout"),
        Math.max(30_000, ticket.mandate.maxDurationSec * 1000),
      );
      try {
        const stream = driver.runTurn(
          {
            ticketId: ticket.id,
            stageRunId: stageRun.id,
            stage: "implement",
            worktreePath,
            prompt: conflictPrompt,
            mandate: ticket.mandate,
            isResume: false,
            sandboxMode: repo.sandboxMode ?? "balanced",
            rootRepoPath: repo.rootPath,
            readOnlyPaths: ticket.lockedTestPaths,
          },
          abortController.signal,
        );
        for await (const ev of stream) {
          collectedEvents.push(ev);
          this.emitEvent({
            type: "worker_event",
            ticketId: ticket.id,
            stageRunId: stageRun.id,
            engine: driver.engine,
            event: ev,
            timestamp: ev.timestamp,
          });
          if (ev.type === "usage") {
            resolveCostUsd = Math.max(resolveCostUsd, ev.costUsd);
          } else if (ev.type === "completed") {
            completedEvent = ev;
            if (typeof ev.costUsd === "number") {
              resolveCostUsd = Math.max(resolveCostUsd, ev.costUsd);
            }
          }
        }
      } catch (err) {
        spans.end(resolveSpan, "failed", err instanceof Error ? err.message : String(err));
        await failConflictEscalation(
          `3-way conflict resolver errored: ${err instanceof Error ? err.message : String(err)}`,
          collectedEvents,
        );
        return;
      } finally {
        clearTimeout(timeoutHandle);
      }

      if (!completedEvent) {
        const errMsg =
          [...collectedEvents].reverse().find((e) => e.type === "error")?.message ??
          "Conflict resolution worker did not complete";
        spans.end(resolveSpan, "failed", errMsg);
        await failConflictEscalation(`3-way conflict resolution failed: ${errMsg}`, collectedEvents);
        return;
      }

      const leftoverMarkers = prep.conflictFiles.filter((relPath) => {
        const abs = join(worktreePath, relPath);
        if (!existsSync(abs)) return false;
        const content = readFileSync(abs, "utf8");
        return /^(<{7}|={7}|>{7})/m.test(content);
      });
      if (leftoverMarkers.length > 0) {
        spans.end(resolveSpan, "failed", `Leftover conflict markers in ${leftoverMarkers.join(", ")}`);
        await failConflictEscalation(
          `3-way conflict resolution left unresolved markers in: ${leftoverMarkers.join(", ")}`,
          collectedEvents,
        );
        return;
      }

      if (
        ticket.lockedTestPaths &&
        ticket.lockedTestPaths.length > 0 &&
        ticket.specTestCommitSha &&
        this.workspace.getChangedFilesSince
      ) {
        const changedSinceSpec = await this.workspace.getChangedFilesSince(
          worktreePath,
          ticket.specTestCommitSha,
        );
        const tampered = changedSinceSpec.filter((f) => ticket.lockedTestPaths!.includes(f));
        if (tampered.length > 0) {
          await this.workspace.revertPathsToCommit?.(worktreePath, ticket.specTestCommitSha, tampered);
          spans.end(resolveSpan, "failed", `Tampered locked tests: ${tampered.join(", ")}`);
          await failConflictEscalation(
            `3-way conflict resolution modified locked spec tests (${tampered.join(", ")})`,
            collectedEvents,
          );
          return;
        }
      }

      const postResolveFiles = await this.workspace.getChangedFiles(worktreePath, effectiveBaseBranch);
      const mandateFiles = ticket.lockedTestPaths?.length
        ? postResolveFiles.filter((f) => !ticket.lockedTestPaths!.includes(f))
        : postResolveFiles;
      const mandateRes = validateChangedFilesAgainstMandate(mandateFiles, ticket.mandate);
      if (!mandateRes.ok) {
        spans.end(resolveSpan, "failed", `Mandate violation: ${mandateRes.violations.join(", ")}`);
        await failConflictEscalation(
          `3-way conflict resolution violated Mandate paths: ${mandateRes.violations.join(", ")}`,
          collectedEvents,
        );
        return;
      }

      const resolveSummary = completedEvent.summary || "3-way semantic conflict resolved";
      spans.end(resolveSpan, "ok", `$${resolveCostUsd.toFixed(3)}`);
      autoResolvedConflict = true;
      attemptConflictCtx = {
        ...attemptConflictCtx,
        resolvedAutomatically: true,
        resolutionSummary: resolveSummary.slice(0, 400),
      };
      workingTicket = {
        ...ticket,
        costUsd: ticket.costUsd + resolveCostUsd,
        conflictResolutionCount: (ticket.conflictResolutionCount ?? 0) + 1,
        conflictContext: attemptConflictCtx,
      };
    }

    const gate = await this.runRepoVerificationGate(workingTicket, repo, stageRun, worktreePath, {
      isFinalDeliveryGate: !parentEpic,
    });
    spans.addExisting(gate.spans);
    if (!gate.passed) {
      if (autoResolvedConflict && preConflictCp && this.workspace.restoreWorktreeCheckpoint) {
        await this.workspace
          .restoreWorktreeCheckpoint({
            worktreePath,
            rootRepoPath: repo.rootPath,
            commitSha: preConflictCp.commitSha,
          })
          .catch(() => {});
      }
      const failedSummary = gate.result?.summary ?? "Post-rebase verification gate failed";
      const failedCtx = autoResolvedConflict && attemptConflictCtx
        ? { ...attemptConflictCtx, resolvedAutomatically: false, resolutionSummary: failedSummary }
        : attemptConflictCtx;
      const failedRun: StageRun = {
        ...stageRun,
        status: "failed",
        costUsd: resolveCostUsd,
        spans: spans.toArray(),
        completedAt: nowIso(),
        summary: failedSummary,
      };
      const changedFiles = await this.workspace.getChangedFiles(worktreePath, effectiveBaseBranch);
      const { note: failNote } = await this.memory.recordStageSpillAndNote({
        ticket: workingTicket,
        stageRun: failedRun,
        events: [],
        changedFiles,
        summary: failedSummary,
        verificationPassed: false,
        extraArtifacts: gate.artifacts.length > 0 ? gate.artifacts : undefined,
      });
      await this.stateStore.saveStageRun(failedRun);

      if (!autoResolvedConflict && ticket.stageRetries < ticket.mandate.maxStageRetries) {
        const retryTicket: Ticket = {
          ...workingTicket,
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
          {
            ...workingTicket,
            conflictContext: failedCtx,
            inlineMemory: {
              ...workingTicket.inlineMemory,
              stageNotes: [...workingTicket.inlineMemory.stageNotes, failNote],
            },
          },
          autoResolvedConflict ? "merge_conflict" : "watchdog_escalation",
          autoResolvedConflict
            ? `3-way conflict resolved edits failed verification gate: ${failedSummary}`
            : `Post-rebase verification failed: ${failedSummary}`,
          {
            stageRunId: stageRun.id,
            branchName: ticket.branchName,
            ...(failedCtx ? { conflictContext: failedCtx } : {}),
          },
        );
      }
      return;
    }

    if (autoResolvedConflict) {
      const commitResolvedSpan = spans.start("git_ops", "Commit resolved rebase tree");
      await this.workspace.commitAll(
        worktreePath,
        `super-work(${ticket.id}): 3-way conflict resolved onto ${effectiveBaseBranch}`,
      );
      spans.end(commitResolvedSpan, "ok");
    }

    const finishedRun: StageRun = {
      ...stageRun,
      status: "completed",
      costUsd: resolveCostUsd,
      spans: spans.toArray(),
      completedAt: nowIso(),
      summary: autoResolvedConflict
        ? `3-way conflict auto-resolved onto ${effectiveBaseBranch}${gate.result?.summary ? `; ${gate.result.summary}` : ""}`
        : gate.artifacts.length > 0
          ? `Rebased cleanly onto ${effectiveBaseBranch}; ${gate.result?.summary ?? "verification passed"}`
          : `Rebased cleanly onto ${effectiveBaseBranch}`,
    };
    const changedFiles = await this.workspace.getChangedFiles(worktreePath, effectiveBaseBranch);
    const diffText = await this.workspace.getDiff(worktreePath, effectiveBaseBranch);
    const { note } = await this.memory.recordStageSpillAndNote({
      ticket: workingTicket,
      stageRun: finishedRun,
      events: [],
      changedFiles,
      diffText,
      summary: finishedRun.summary!,
      verificationPassed: true,
      extraArtifacts: gate.artifacts.length > 0 ? gate.artifacts : undefined,
    });
    finishedRun.spillTranscriptId = note.spillArtifactIds[0];
    await this.stateStore.saveStageRun(finishedRun);
    await this.captureTicketCheckpoint(workingTicket, repo, worktreePath, {
      stage: "rebase",
      stageRunId: finishedRun.id,
      engine: stageRun.engine,
      label: autoResolvedConflict
        ? `3-way conflict resolved onto ${effectiveBaseBranch}`
        : `Rebased cleanly onto ${effectiveBaseBranch}`,
      changedFiles,
      verificationPassed: true,
    });
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
      await this.workspace.cleanupTicketCheckpoints?.(repo.rootPath, ticket.id).catch(() => {});
      await this.stateStore.markCheckpointsCleaned(ticket.id, deliveredTs).catch(() => {});
      let deliveredSubtask: Ticket = {
        ...workingTicket,
        status: "delivered",
        activeEngine: undefined,
        worktreePath: undefined,
        worktreeCleanedAt: deliveredTs,
        inlineMemory: {
          ...workingTicket.inlineMemory,
          stageNotes: [...workingTicket.inlineMemory.stageNotes, note],
        },
        updatedAt: deliveredTs,
      };
      await this.maybeDistillClosedLoopLesson(deliveredSubtask, repo);
      await this.stateStore.saveTicket(deliveredSubtask);
      deliveredSubtask = await this.generateAndSaveHandoverDigest(deliveredSubtask, repo, {
        changedFiles,
        diffText,
      });
      await this.recordDeliveredCasebookEntry(deliveredSubtask, repo);
      await this.maybeEvaluateEpicReplan(parentEpic.id, deliveredSubtask);
      return;
    }

    await this.enqueueDeliveryOutbox(
      {
        ...workingTicket,
        inlineMemory: {
          ...workingTicket.inlineMemory,
          stageNotes: [...workingTicket.inlineMemory.stageNotes, note],
        },
      },
      repo,
    );
  }

  private async ensureVisualBaselineDir(
    repo: RepoConfig,
    smokeCfg: NonNullable<RepoConfig["smokeCheck"]>,
  ): Promise<string | undefined> {
    if (!smokeCfg.browserCheck?.enabled) return undefined;
    const diffMode = smokeCfg.browserCheck.visualDiffMode ?? "auto";
    if (diffMode === "off") return undefined;
    if (!this.workspace.getHeadCommitSha || !this.workspace.runSmokeCheck) return undefined;

    const baseSha = await this.workspace
      .getHeadCommitSha(repo.rootPath, repo.baseBranch)
      .catch(() => "");
    if (!baseSha) return undefined;

    const cacheDir = resolve(this.dataDir, "visual-baselines", repo.id, baseSha);
    if (existsSync(join(cacheDir, "route_0.png"))) {
      return cacheDir;
    }
    if (existsSync(join(cacheDir, ".skip"))) {
      return undefined;
    }

    const tempId = `vbase_${repo.id.slice(-6)}_${baseSha.slice(0, 8)}_${Date.now().toString(36)}`;
    const tempBranch = `super-work/${tempId}`;
    const syntheticTicket: Ticket = {
      id: tempId,
      repoId: repo.id,
      threadId: `thr_${tempId}`,
      sourceTriggerId: `trg_${tempId}`,
      title: `[Visual Baseline] ${baseSha.slice(0, 8)}`,
      description: "Lazy visual diff baseline capture",
      status: "implementing",
      template: "fast",
      currentStage: "implement",
      stageRetries: 0,
      mandate: createDefaultMandate(),
      dependsOn: [],
      branchName: tempBranch,
      nativeSessions: {},
      inlineMemory: {
        goal: "Baseline screenshot capture",
        acceptanceCriteria: [],
        stageNotes: [],
        threadUpdates: [],
      },
      costUsd: 0,
      priority: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    let ws: { worktreePath: string; branchName: string };
    try {
      ws = await this.runWithRepoWorkspaceLock(repo.id, () =>
        this.workspace.prepareWorkspace(syntheticTicket, repo, { startPoint: baseSha }),
      );
    } catch {
      return undefined;
    }

    try {
      if (existsSync(join(cacheDir, "route_0.png"))) {
        return cacheDir;
      }
      if (existsSync(join(cacheDir, ".skip"))) {
        return undefined;
      }
      const baseSmoke = await this.workspace.runSmokeCheck(ws.worktreePath, smokeCfg);
      mkdirSync(cacheDir, { recursive: true });
      if (baseSmoke.ok && baseSmoke.rawScreenshots && baseSmoke.rawScreenshots.length > 0) {
        for (const shot of baseSmoke.rawScreenshots) {
          writeFileSync(join(cacheDir, `route_${shot.routeIndex}.png`), shot.bytes);
        }
        return cacheDir;
      }
      writeFileSync(join(cacheDir, ".skip"), baseSmoke.summary || "no baseline screenshot");
      return undefined;
    } catch {
      try {
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(join(cacheDir, ".skip"), "baseline capture error");
      } catch {
        // Ignore cache write errors
      }
      return undefined;
    } finally {
      await this.runWithRepoWorkspaceLock(repo.id, async () => {
        await this.workspace.cleanupWorkspace(ws.worktreePath, repo.rootPath).catch(() => {});
        await this.workspace.deleteBranch?.(repo.rootPath, ws.branchName).catch(() => {});
      });
    }
  }

  private async runRepoVerificationGate(
    ticket: Ticket,
    repo: RepoConfig,
    stageRun: StageRun,
    worktreePath: string,
    options?: { isFinalDeliveryGate?: boolean },
  ): Promise<{
    passed: boolean;
    artifacts: SpillArtifact[];
    result?: VerificationRunResult;
    spans?: StageSpan[];
  }> {
    const spans = new SpanRecorder();
    const artifacts: SpillArtifact[] = [];
    const commands = (repo.verificationCommands ?? []).map((c) => c.trim()).filter(Boolean);
    let staticResult: VerificationRunResult | undefined;

    if (commands.length > 0) {
      const staticSpan = spans.start("static_verify", `Static verify (${commands.length} cmd)`);
      staticResult = await this.workspace.runVerificationCommands(
        worktreePath,
        commands,
        ticket.mandate.maxDurationSec,
        {
          sandboxMode: repo.sandboxMode ?? "balanced",
          forbiddenPaths: ticket.mandate.forbiddenPaths,
          readOnlyPaths: stageRun.stage === "implement" ? ticket.lockedTestPaths : undefined,
          allowNetwork: ticket.mandate.allowNetwork,
          rootRepoPath: repo.rootPath,
        },
      );
      spans.end(staticSpan, staticResult.ok ? "ok" : "failed", staticResult.failedCommand);

      const logBody = staticResult.results
        .map(
          (r) =>
            `$ ${r.command}\n[exit=${r.exitCode}, duration=${r.durationMs}ms]\n${r.output || "(no output)"}\n`,
        )
        .join("\n---\n");

      const testArtifact = await this.artifactStore.writeSpill(
        {
          ticketId: ticket.id,
          stageRunId: stageRun.id,
          kind: "test_log",
          summary: `${staticResult.ok ? "PASS" : "FAIL"} verification (${commands.join(" && ")})`,
          ext: "log",
        },
        logBody || staticResult.summary,
      );
      await this.stateStore.saveArtifact(testArtifact, `${staticResult.summary}\n${logBody}`);
      artifacts.push(testArtifact);

      if (!staticResult.ok) {
        this.emitEvent({
          type: "verification_completed",
          ticketId: ticket.id,
          stageRunId: stageRun.id,
          result: staticResult,
          timestamp: nowIso(),
        });
        return { passed: false, artifacts, result: staticResult, spans: spans.toArray() };
      }
    }

    const smokeCfg = repo.smokeCheck;
    const smokeTriggerMode = smokeCfg?.triggerMode ?? "every_gate";
    const shouldRunSmoke = Boolean(
      smokeCfg?.enabled &&
        smokeCfg.startCommand?.trim() &&
        this.workspace.runSmokeCheck &&
        (smokeTriggerMode === "every_gate" || options?.isFinalDeliveryGate),
    );

    if (!shouldRunSmoke) {
      if (staticResult) {
        this.emitEvent({
          type: "verification_completed",
          ticketId: ticket.id,
          stageRunId: stageRun.id,
          result: staticResult,
          timestamp: nowIso(),
        });
      }
      return { passed: true, artifacts, result: staticResult, spans: spans.toArray() };
    }

    const smokeSpan = spans.start(
      "smoke_cdp",
      smokeCfg?.browserCheck?.enabled ? "Smoke server & CDP check" : "Smoke server check",
    );
    const smokeRes = await this.workspace.runSmokeCheck!(worktreePath, smokeCfg!, {
      resolveBaselineScreenshotsDir: () =>
        this.ensureVisualBaselineDir(repo, smokeCfg!).catch(() => undefined),
    });
    spans.end(smokeSpan, smokeRes.ok ? "ok" : "failed", smokeRes.failedStep ?? smokeRes.readyUrl);

    if (
      smokeRes.rawScreenshots &&
      smokeRes.rawScreenshots.length > 0 &&
      this.artifactStore.writeBinarySpill
    ) {
      for (const shot of smokeRes.rawScreenshots) {
        try {
          const shotArt = await this.artifactStore.writeBinarySpill(
            {
              ticketId: ticket.id,
              stageRunId: stageRun.id,
              kind: "screenshot",
              summary: `Browser gate screenshot (${shot.path})`,
              ext: "png",
            },
            shot.bytes,
          );
          await this.stateStore.saveArtifact(
            shotArt,
            `screenshot ${shot.path} ${smokeRes.browserResult?.summary ?? ""}`,
          );
          artifacts.push(shotArt);
          const routeObj = smokeRes.browserResult?.routes?.[shot.routeIndex];
          if (routeObj) {
            routeObj.screenshotArtifactId = shotArt.id;
          }
        } catch {
          // Do not fail pipeline solely on screenshot persistence I/O error
        }
      }
    }

    if (
      smokeRes.rawVisualDiffs &&
      smokeRes.rawVisualDiffs.length > 0 &&
      this.artifactStore.writeBinarySpill
    ) {
      for (const vd of smokeRes.rawVisualDiffs) {
        try {
          const vdArt = await this.artifactStore.writeBinarySpill(
            {
              ticketId: ticket.id,
              stageRunId: stageRun.id,
              kind: "visual_diff",
              summary: `Visual diff (${vd.path}, ${(vd.diffRatio * 100).toFixed(2)}% changed)`,
              ext: "png",
            },
            vd.bytes,
          );
          await this.stateStore.saveArtifact(
            vdArt,
            `visual_diff ${vd.path} diffRatio=${vd.diffRatio.toFixed(6)}`,
          );
          artifacts.push(vdArt);
          const routeObj = smokeRes.browserResult?.routes?.[vd.routeIndex];
          if (routeObj) {
            routeObj.visualDiffArtifactId = vdArt.id;
          }
        } catch {
          // Do not fail pipeline solely on visual_diff artifact I/O error
        }
      }
    }

    const sanitizedSmokeRes: SmokeCheckResult = {
      ...smokeRes,
      rawScreenshots: undefined,
      rawVisualDiffs: undefined,
    };
    delete sanitizedSmokeRes.rawScreenshots;
    delete sanitizedSmokeRes.rawVisualDiffs;

    const visualSpan = sanitizedSmokeRes.browserResult?.routes?.some(
      (r) => typeof r.diffRatio === "number",
    )
      ? spans.start("visual_diff", "Visual pixel diff evaluation")
      : null;

    const visualDiffMode = smokeCfg!.browserCheck?.visualDiffMode ?? "auto";
    const maxDiffRatio = smokeCfg!.browserCheck?.maxVisualDiffRatio ?? 0.02;
    if (
      sanitizedSmokeRes.ok &&
      visualDiffMode !== "off" &&
      visualDiffMode !== "informational" &&
      sanitizedSmokeRes.browserResult?.routes
    ) {
      const exceededRoute = sanitizedSmokeRes.browserResult.routes.find(
        (r) => typeof r.diffRatio === "number" && r.diffRatio > maxDiffRatio,
      );
      if (exceededRoute) {
        const shouldBlock =
          visualDiffMode === "enforce" ||
          (visualDiffMode === "auto" &&
            !isUiIntentTicket({
              title: ticket.title,
              description: ticket.description,
            }));
        if (shouldBlock) {
          exceededRoute.ok = false;
          sanitizedSmokeRes.ok = false;
          sanitizedSmokeRes.failedStep = "smoke:visualDiff";
          sanitizedSmokeRes.summary = `Visual regression on ${exceededRoute.path} (${(exceededRoute.diffRatio! * 100).toFixed(2)}% > ${(maxDiffRatio * 100).toFixed(2)}% threshold in '${visualDiffMode}' mode)`;
          if (sanitizedSmokeRes.browserResult) {
            sanitizedSmokeRes.browserResult.ok = false;
            sanitizedSmokeRes.browserResult.summary = sanitizedSmokeRes.summary;
          }
        }
      }
    }
    if (visualSpan) {
      const visualBlocked = sanitizedSmokeRes.failedStep === "smoke:visualDiff";
      spans.end(
        visualSpan,
        visualBlocked ? "failed" : "ok",
        visualBlocked ? sanitizedSmokeRes.summary : undefined,
      );
    }

    const smokeLogLines = [
      `Start Command: ${smokeCfg!.startCommand}`,
      `Ready URL: ${sanitizedSmokeRes.readyUrl}`,
      `Port: ${sanitizedSmokeRes.port}`,
      `Startup Duration: ${sanitizedSmokeRes.startupDurationMs}ms`,
      sanitizedSmokeRes.probeStatus !== undefined ? `Probe Status: ${sanitizedSmokeRes.probeStatus}` : "",
      `Result: ${sanitizedSmokeRes.ok ? "PASS" : "FAIL"} — ${sanitizedSmokeRes.summary}`,
      sanitizedSmokeRes.browserResult
        ? `Browser Check: ${sanitizedSmokeRes.browserResult.summary}`
        : "",
      sanitizedSmokeRes.checkResults.length > 0
        ? "\nCheck Commands:\n" +
          sanitizedSmokeRes.checkResults
            .map(
              (r) =>
                `$ ${r.command}\n[exit=${r.exitCode}, duration=${r.durationMs}ms]\n${r.output || "(no output)"}`,
            )
            .join("\n---\n")
        : "",
      sanitizedSmokeRes.serverOutputTail ? `\nServer Output Tail:\n${sanitizedSmokeRes.serverOutputTail}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const smokeArtifact = await this.artifactStore.writeSpill(
      {
        ticketId: ticket.id,
        stageRunId: stageRun.id,
        kind: "smoke_log",
        summary: `${sanitizedSmokeRes.ok ? "PASS" : "FAIL"} smoke check (${sanitizedSmokeRes.readyUrl})`,
        ext: "log",
      },
      smokeLogLines,
    );
    await this.stateStore.saveArtifact(smokeArtifact, smokeLogLines);
    artifacts.push(smokeArtifact);

    const combinedResult: VerificationRunResult = {
      ok: sanitizedSmokeRes.ok,
      results: [...(staticResult?.results ?? []), ...sanitizedSmokeRes.checkResults],
      failedCommand: sanitizedSmokeRes.ok
        ? undefined
        : (sanitizedSmokeRes.failedStep ?? `smoke:${smokeCfg!.startCommand}`),
      summary: sanitizedSmokeRes.ok
        ? [staticResult?.summary, sanitizedSmokeRes.summary].filter(Boolean).join("\n")
        : `Smoke check failed (${sanitizedSmokeRes.failedStep ?? smokeCfg!.startCommand}): ${sanitizedSmokeRes.summary}`,
      smokeResult: sanitizedSmokeRes,
    };

    this.emitEvent({
      type: "verification_completed",
      ticketId: ticket.id,
      stageRunId: stageRun.id,
      result: combinedResult,
      timestamp: nowIso(),
    });

    return { passed: sanitizedSmokeRes.ok, artifacts, result: combinedResult, spans: spans.toArray() };
  }

  private async enqueueDeliveryOutbox(ticket: Ticket, repoArg?: RepoConfig): Promise<void> {
    const repo = repoArg ?? (await this.stateStore.getRepo(ticket.repoId));
    await this.maybeDistillClosedLoopLesson(ticket, repo ?? undefined);
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
        // Fallback cleanly to recorded stageNote metadata when worktree diff is unavailable
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
      // Non-fatal if artifact lookup fails
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
    const allTickets = await this.stateStore.listTickets();
    const epics = allTickets.filter(
      (t) => t.repoId === repo.id && t.isEpic && !isTerminalTicketStatus(t.status),
    );
    if (epics.length === 0) return;

    for (const epic of epics) {
      const children = allTickets.filter((t) => t.parentTicketId === epic.id);
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

      const activeChildren = children.filter((c) => c.status !== "cancelled");
      const allCancelled = activeChildren.length === 0;
      const allDelivered =
        activeChildren.length > 0 && activeChildren.every((c) => c.status === "delivered");
      const blockedChild = activeChildren.find(
        (c) => c.status === "needs_human" || c.status === "failed",
      );

      let nextStatus: Ticket["status"] = epic.status;
      let nextError: string | undefined = epic.errorMessage;
      let shouldFinalizeUnified = false;

      if (allCancelled) {
        nextStatus = "cancelled";
        nextError = "All Epic subtasks were cancelled";
      } else if (epic.pendingEpicReplan) {
        nextStatus = "needs_human";
        nextError = `Pending adaptive Epic re-plan approval: ${epic.pendingEpicReplan.summary}`;
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

    const gate = await this.runRepoVerificationGate(rebasingEpic, repo, stageRun, ws.worktreePath, {
      isFinalDeliveryGate: true,
    });
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
        extraArtifacts: gate.artifacts.length > 0 ? gate.artifacts : undefined,
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
      summary:
        gate.artifacts.length > 0
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
      extraArtifacts: gate.artifacts.length > 0 ? gate.artifacts : undefined,
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

  private async recordDeliveredCasebookEntry(ticket: Ticket, _repo?: RepoConfig): Promise<void> {
    if (ticket.isEpic && ticket.epicDeliveryMode === "per_subtask") return;
    const priorCase = await this.stateStore.getCasebookEntryByTicket(ticket.id);
    const entry = buildCasebookEntryFromTicket({
      ticket,
      digest: ticket.handoverDigest,
      priorCase,
    });
    await this.stateStore.saveCasebookEntry(entry);
    await this.stateStore.indexMemoryDocument({
      entityType: "casebook",
      entityId: entry.id,
      ticketId: ticket.id,
      repoId: ticket.repoId,
      title: `Casebook: ${entry.title}`,
      body: [
        entry.goalSummary,
        entry.solutionSummary,
        entry.pitfallsAndFixes ?? "",
        entry.exportedSymbols.join(" "),
        entry.changedFiles.join(" "),
      ]
        .filter(Boolean)
        .join("\n"),
    });
    this.emitEvent({
      type: "casebook_updated",
      repoId: ticket.repoId,
      entry,
      timestamp: entry.updatedAt,
    });
  }

  async prunePlaybookEntries(
    repoId: string,
  ): Promise<{ prunedIds: string[]; keptCount: number }> {
    const repo = await this.stateStore.getRepo(repoId);
    if (!repo) {
      throw new Error(`Repository not found: ${repoId}`);
    }
    const entries = await this.stateStore.listPlaybookEntries(repoId);
    const pathExists = (relPath: string): boolean => existsSync(join(repo.rootPath, relPath));
    const prunedIds: string[] = [];
    let keptCount = 0;

    for (const entry of entries) {
      const health = classifyPlaybookHealth(entry, { pathExists });
      if (entry.source === "auto_healed" && !entry.pinned && health.prunable) {
        await this.stateStore.deletePlaybookEntry(entry.id);
        prunedIds.push(entry.id);
        this.emitEvent({
          type: "playbook_updated",
          repoId,
          deletedId: entry.id,
          timestamp: nowIso(),
        });
      } else {
        keptCount += 1;
      }
    }
    return { prunedIds, keptCount };
  }

  // --- A.1 Scheduled Routines (Probe -> Promote) ---
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
    patch: Partial<
      Omit<RoutineSpec, "id" | "repoId" | "createdAt" | "updatedAt">
    >,
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

  private async executeRoutineProbe(
    routine: RoutineSpec,
    repo: RepoConfig,
    options?: { ignoreWindow?: boolean; now?: Date },
  ): Promise<RoutineRun> {
    return executeRoutineProbe(this.coordinatorCtx(), routine, repo, options);
  }

  // --- B.1 Arena Duel ---
  private async cleanupArenaCandidateWorktrees(
    candidates: ArenaCandidateResult[],
    rootRepoPath?: string,
    keepCandidateId?: string,
  ): Promise<void> {
    return cleanupArenaCandidateWorktreesOp(
      this.coordinatorCtx(),
      candidates,
      rootRepoPath,
      keepCandidateId,
    );
  }

  private async adoptArenaCandidateWinner(
    ticket: Ticket,
    repo: RepoConfig | undefined,
    winner: ArenaCandidateResult,
    candidates: ArenaCandidateResult[],
    fromTiebreakInbox = false,
  ): Promise<Ticket> {
    return adoptArenaCandidateWinnerOp(
      this.coordinatorCtx(),
      ticket,
      repo,
      winner,
      candidates,
      fromTiebreakInbox,
    );
  }

  private async runArenaImplementStage(
    ticket: Ticket,
    repo: RepoConfig,
    availableEngines: WorkerEngineId[],
  ): Promise<boolean> {
    return runArenaImplementStageOp(this.coordinatorCtx(), ticket, repo, availableEngines);
  }

  // --- C.1 Adaptive Epic Re-planning ---
  private async maybeEvaluateEpicReplan(epicId: string, completedSubtask: Ticket): Promise<void> {
    return maybeEvaluateEpicReplanOp(this.coordinatorCtx(), epicId, completedSubtask);
  }

  private async applyEpicReplanProposal(
    epic: Ticket,
    proposal: EpicReplanProposal,
    options: { humanApproved: boolean },
  ): Promise<Ticket> {
    return applyEpicReplanProposalOp(this.coordinatorCtx(), epic, proposal, options);
  }

  // --- B.1 Symbol Impact Radius ---
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

  // --- D.2 Worktree Stage Checkpoints & Time-Travel Re-steer ---
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

  // --- D.1 Interactive DAG Studio Live Surgery ---
  async mutateDagNode(ticketId: string, input: DagNodeMutationInput): Promise<Ticket> {
    return mutateDagNodeOp(this.coordinatorCtx(), ticketId, input);
  }

  // --- v1.0.0 D.1 Composable Task Blueprints ---
  async listRepoBlueprints(repoId: string): Promise<TaskBlueprint[]> {
    const repo = await this.stateStore.getRepo(repoId);
    if (!repo) {
      throw new Error(`Repository not found: ${repoId}`);
    }
    return resolveRepoBlueprints(repo);
  }

  // --- v1.0.0 B.1 Line-Anchored Review Studio ---
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
    const ts = nowIso();
    const updated = await this.stateStore.updateReviewCommentStatus(commentId, status, ts);
    if (updated) {
      const comments = await this.stateStore.listReviewComments(updated.ticketId);
      this.emitEvent({
        type: "review_comment_updated",
        ticketId: updated.ticketId,
        comments,
        timestamp: ts,
      });
    }
    return updated;
  }

  // --- v1.0.0 C.1 System Doctor & SQLite Hot Backups ---
  async runSystemDoctor(options?: { fix?: boolean }): Promise<SystemDoctorReport> {
    return runSystemDoctor(this.coordinatorCtx(), options);
  }

  async createSystemBackup(): Promise<BackupArchiveInfo> {
    return createSystemBackup(this.coordinatorCtx());
  }

  async listSystemBackups(): Promise<BackupArchiveInfo[]> {
    return listSystemBackups(this.dataDir);
  }

  // --- v1.1.0 A.2 Batch Inbox Triage & Chief-of-Staff Advisor ---
  async batchResolveInbox(input: BatchResolveInboxInput): Promise<BatchResolveInboxResult> {
    const pendingItems = await this.stateStore.listInboxItems({
      repoId: input.repoId,
      status: "pending",
    });
    const wantedIds = input.inboxIds?.length ? new Set(input.inboxIds) : null;
    const wantedKinds = input.kinds?.length ? new Set(input.kinds) : null;
    const lowRiskKinds = new Set([
      "observe_proposal",
      "outbox_signoff",
      "clarification_request",
    ]);

    const candidates = pendingItems.filter((item) => {
      if (wantedIds && !wantedIds.has(item.id)) return false;
      if (wantedKinds && !wantedKinds.has(item.kind)) return false;
      return true;
    });

    const tickets = await this.stateStore.listTickets({ repoId: input.repoId });
    const ticketsById = new Map(tickets.map((t) => [t.id, t]));

    let resolvedCount = 0;
    let skippedCount = 0;
    const results: BatchResolveInboxResult["results"] = [];

    for (const item of candidates) {
      if (input.onlyLowRisk) {
        const tkt = ticketsById.get(item.ticketId);
        if (!lowRiskKinds.has(item.kind) || tkt?.riskAssessment?.level === "high") {
          skippedCount += 1;
          continue;
        }
      }
      try {
        const resolved = await this.resolveInboxItem(item.id, input.decision, input.note, {
          deliveryAction: input.deliveryAction,
          saveToPlaybook: false,
        });
        resolvedCount += 1;
        results.push({
          inboxId: item.id,
          ticketId: resolved.ticket.id,
          status: resolved.item.status,
        });
      } catch {
        skippedCount += 1;
      }
    }

    return { resolvedCount, skippedCount, results };
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

  // --- v1.1.0 D.1 Golden Eval Suite, Atomic Backup Restore & Knowledge Bundle ---
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
