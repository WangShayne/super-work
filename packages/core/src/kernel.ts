import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  countDiffLines,
  pickNextFallbackEngine,
  resolveFallbackChain,
  scoreArenaCandidates,
} from "./arena.ts";
import { buildCasebookEntryFromTicket, selectRelevantCasesForContext } from "./casebook.ts";
import {
  classifyEpicReplanApproval,
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
import type {
  ArtifactStore,
  ControlPlaneLLM,
  CreateEpicInput,
  DirectTicketInput,
  IngestTriggerInput,
  KernelConfig,
  OutboxExecutor,
  PreviewProvider,
  StateStore,
  WorkerDriver,
  WorkspaceProvider,
} from "./ports.ts";
import { EventIntakeRouter, type IngestResult } from "./router.ts";
import type {
  ArenaCandidateResult,
  CasebookEntry,
  EpicDecompositionPlan,
  EpicReplanProposal,
  HandoverDigest,
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
  ReviewReport,
  RoutineRun,
  RoutineScheduleKind,
  RoutineSpec,
  SpecClarificationInput,
  SpecClarificationResult,
  SpillArtifact,
  StageKind,
  StageRun,
  SystemSetupConfig,
  Thread,
  Ticket,
  Trigger,
  VerificationRunResult,
  WatchdogDecision,
  WatchdogSignal,
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

  private readonly drivers = new Map<WorkerEngineId, WorkerDriver>();
  private readonly listeners = new Set<(event: KernelEvent) => void>();
  private readonly activeTicketRuns = new Map<string, Promise<void>>();
  private readonly activeRoutineRuns = new Set<string>();
  private readonly repoWorkspaceLocks = new Map<string, Promise<void>>();
  private readonly abortControllers = new Map<string, AbortController>();
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
    const [repoStructure, playbookEntries, casebookEntries] = await Promise.all([
      this.workspace.getRepoStructureSummary
        ? this.workspace.getRepoStructureSummary(repo.rootPath).catch(() => undefined)
        : Promise.resolve(undefined),
      this.stateStore.listPlaybookEntries(repo.id, { onlyEnabled: true }),
      this.stateStore.listCasebookEntries(repo.id),
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
      });
      spec = {
        ...spec,
        matchedCaseTitles:
          spec.matchedCaseTitles.length > 0
            ? spec.matchedCaseTitles
            : caseSelection.positiveCases.map((c) => c.title),
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
      });
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
      const implementEngine =
        lastImplRun?.engine ?? ticket.preferredEngine ?? repo.preferredImplementEngine;
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
    const { effectiveBaseBranch } = await this.getEffectiveBaseInfo(ticket, repo);
    const hadWorktree = Boolean(ticket.worktreePath);
    const lockedTicket = ticket;
    let ws: { worktreePath: string; branchName: string };
    try {
      ws = await this.runWithRepoWorkspaceLock(repo.id, () =>
        this.workspace.prepareWorkspace(lockedTicket, repo, {
          startPoint: effectiveBaseBranch,
        }),
      );
    } catch (err) {
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
          sandboxMode: repo.sandboxMode ?? "balanced",
          rootRepoPath: repo.rootPath,
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
    }

    let verificationArtifacts: SpillArtifact[] = [];
    let verificationPassed = completedEvent?.structuredOutput?.verificationPassed ?? true;
    if (stage === "implement") {
      const gate = await this.runRepoVerificationGate(ticket, repo, stageRun, ws.worktreePath, {
        isFinalDeliveryGate: false,
      });
      verificationArtifacts = gate.artifacts;
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
          extraArtifacts: verificationArtifacts.length > 0 ? verificationArtifacts : undefined,
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
      await this.workspace.commitAll(ws.worktreePath, `super-work(${ticket.id}): ${ticket.title}`);
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
      failedEngines: [],
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

    const gate = await this.runRepoVerificationGate(ticket, repo, stageRun, worktreePath, {
      isFinalDeliveryGate: !parentEpic,
    });
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
        extraArtifacts: gate.artifacts.length > 0 ? gate.artifacts : undefined,
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
      summary:
        gate.artifacts.length > 0
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
      extraArtifacts: gate.artifacts.length > 0 ? gate.artifacts : undefined,
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
      let deliveredSubtask: Ticket = {
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
    options?: { isFinalDeliveryGate?: boolean },
  ): Promise<{ passed: boolean; artifacts: SpillArtifact[]; result?: VerificationRunResult }> {
    const artifacts: SpillArtifact[] = [];
    const commands = (repo.verificationCommands ?? []).map((c) => c.trim()).filter(Boolean);
    let staticResult: VerificationRunResult | undefined;

    if (commands.length > 0) {
      staticResult = await this.workspace.runVerificationCommands(
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
        return { passed: false, artifacts, result: staticResult };
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
      return { passed: true, artifacts, result: staticResult };
    }

    const smokeRes = await this.workspace.runSmokeCheck!(worktreePath, smokeCfg!);

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
    const sanitizedSmokeRes = {
      ...smokeRes,
      rawScreenshots: undefined,
    };
    delete sanitizedSmokeRes.rawScreenshots;

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

    return { passed: sanitizedSmokeRes.ok, artifacts, result: combinedResult };
  }

  private async enqueueDeliveryOutbox(ticket: Ticket, repoArg?: RepoConfig): Promise<void> {
    const repo = repoArg ?? (await this.stateStore.getRepo(ticket.repoId));
    await this.maybeDistillClosedLoopLesson(ticket, repo ?? undefined);
    const template = getPipelineTemplate(ticket.template);
    const ts = nowIso();
    const needsSignoff =
      template.requireOutboxSignoff ||
      (Boolean(ticket.routineId) && repo?.mode === "observe");
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

    return this.memory.buildWorkerPromptContext(ticket, stage, relatedMemory, {
      verificationCommands: repo.verificationCommands,
      smokeCheck: repo.smokeCheck,
      repoConventions: repo.conventions,
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
    const repo = await this.stateStore.getRepo(input.repoId);
    if (!repo) {
      throw new Error(`Repository not found: ${input.repoId}`);
    }
    const ts = nowIso();
    const routine: RoutineSpec = {
      id: newId("rtn"),
      repoId: repo.id,
      name: input.name.trim(),
      prompt: input.prompt.trim(),
      scheduleKind: input.scheduleKind,
      intervalMinutes:
        input.scheduleKind === "interval"
          ? Math.max(1, Math.floor(input.intervalMinutes ?? 360))
          : undefined,
      cronExpr: input.scheduleKind === "cron" ? input.cronExpr?.trim() || "0 2 * * *" : undefined,
      activeHoursStart: input.activeHoursStart?.trim() || undefined,
      activeHoursEnd: input.activeHoursEnd?.trim() || undefined,
      allowedPaths:
        input.allowedPaths && input.allowedPaths.length > 0
          ? input.allowedPaths.map((p) => p.trim()).filter(Boolean)
          : ["**"],
      template: input.template ?? repo.defaultTemplate,
      preferredEngine: input.preferredEngine,
      maxBudgetUsd:
        typeof input.maxBudgetUsd === "number" && input.maxBudgetUsd > 0 ? input.maxBudgetUsd : 1.5,
      enabled: input.enabled ?? true,
      nextRunAt:
        input.nextRunAt ??
        computeNextRoutineRunAt({
          scheduleKind: input.scheduleKind,
          intervalMinutes: input.intervalMinutes ?? 360,
          cronExpr: input.cronExpr,
        }),
      createdAt: ts,
      updatedAt: ts,
    };
    await this.stateStore.saveRoutine(routine);
    this.emitEvent({ type: "routine_updated", repoId: repo.id, routine, timestamp: ts });
    return routine;
  }

  async updateRoutine(
    id: string,
    patch: Partial<
      Omit<RoutineSpec, "id" | "repoId" | "createdAt" | "updatedAt">
    >,
  ): Promise<RoutineSpec> {
    const existing = await this.stateStore.getRoutine(id);
    if (!existing) {
      throw new Error(`Routine not found: ${id}`);
    }
    const scheduleKind = patch.scheduleKind ?? existing.scheduleKind;
    const intervalMinutes =
      scheduleKind === "interval"
        ? Math.max(1, Math.floor(patch.intervalMinutes ?? existing.intervalMinutes ?? 360))
        : undefined;
    const cronExpr =
      scheduleKind === "cron" ? (patch.cronExpr ?? existing.cronExpr ?? "0 2 * * *").trim() : undefined;
    const scheduleChanged =
      patch.scheduleKind !== undefined ||
      patch.intervalMinutes !== undefined ||
      patch.cronExpr !== undefined;

    const updated: RoutineSpec = {
      ...existing,
      ...patch,
      name: patch.name !== undefined ? patch.name.trim() || existing.name : existing.name,
      prompt: patch.prompt !== undefined ? patch.prompt.trim() || existing.prompt : existing.prompt,
      scheduleKind,
      intervalMinutes,
      cronExpr,
      activeHoursStart:
        patch.activeHoursStart !== undefined
          ? patch.activeHoursStart?.trim() || undefined
          : existing.activeHoursStart,
      activeHoursEnd:
        patch.activeHoursEnd !== undefined
          ? patch.activeHoursEnd?.trim() || undefined
          : existing.activeHoursEnd,
      allowedPaths:
        patch.allowedPaths !== undefined
          ? patch.allowedPaths.map((p) => p.trim()).filter(Boolean)
          : existing.allowedPaths,
      nextRunAt:
        patch.nextRunAt ??
        (scheduleChanged
          ? computeNextRoutineRunAt({ scheduleKind, intervalMinutes, cronExpr })
          : existing.nextRunAt),
      id: existing.id,
      repoId: existing.repoId,
      createdAt: existing.createdAt,
      updatedAt: nowIso(),
    };
    await this.stateStore.saveRoutine(updated);
    this.emitEvent({ type: "routine_updated", repoId: updated.repoId, routine: updated, timestamp: updated.updatedAt });
    return updated;
  }

  async deleteRoutine(id: string): Promise<boolean> {
    const existing = await this.stateStore.getRoutine(id);
    if (!existing) return false;
    const ok = await this.stateStore.deleteRoutine(id);
    if (ok) {
      this.emitEvent({
        type: "routine_updated",
        repoId: existing.repoId,
        deletedId: id,
        timestamp: nowIso(),
      });
    }
    return ok;
  }

  async triggerRoutineNow(routineId: string): Promise<RoutineRun> {
    const routine = await this.stateStore.getRoutine(routineId);
    if (!routine) {
      throw new Error(`Routine not found: ${routineId}`);
    }
    const repo = await this.stateStore.getRepo(routine.repoId);
    if (!repo) {
      throw new Error(`Repository not found: ${routine.repoId}`);
    }
    return this.executeRoutineProbe(routine, repo, { ignoreWindow: true });
  }

  async processDueRoutines(now = new Date()): Promise<number> {
    if (this.stopped) return 0;
    const routines = await this.stateStore.listRoutines();
    if (routines.length === 0) return 0;
    let triggered = 0;
    for (const routine of routines) {
      if (this.stopped) break;
      if (!routine.enabled || this.activeRoutineRuns.has(routine.id)) continue;
      if (routine.nextRunAt && new Date(routine.nextRunAt).getTime() > now.getTime()) {
        continue;
      }
      if (!isWithinActiveHours(now, routine.activeHoursStart, routine.activeHoursEnd)) {
        continue;
      }
      const repo = await this.stateStore.getRepo(routine.repoId);
      if (!repo || repo.mode === "off") continue;
      triggered += 1;
      await this.executeRoutineProbe(routine, repo, { ignoreWindow: false, now });
    }
    return triggered;
  }

  private async executeRoutineProbe(
    routine: RoutineSpec,
    repo: RepoConfig,
    options?: { ignoreWindow?: boolean; now?: Date },
  ): Promise<RoutineRun> {
    if (this.activeRoutineRuns.has(routine.id)) {
      throw new Error(`Routine ${routine.id} is already probing`);
    }
    this.activeRoutineRuns.add(routine.id);
    const now = options?.now ?? new Date();
    const nextRunAt = computeNextRoutineRunAt(routine, now);
    const runId = newId("rrun");
    const startedAt = nowIso();

    try {
      // 1. Overlap guard: skip if previously promoted ticket is still active
      if (routine.activeTicketId) {
        const prevTicket = await this.stateStore.getTicket(routine.activeTicketId);
        if (prevTicket && !isTerminalTicketStatus(prevTicket.status)) {
          const skippedRun: RoutineRun = {
            id: runId,
            routineId: routine.id,
            repoId: repo.id,
            status: "skipped_overlap",
            summary: `Skipped patrol because promoted ticket ${prevTicket.id} (${prevTicket.status}) is still open.`,
            changedFiles: [],
            costUsd: 0,
            startedAt,
            completedAt: nowIso(),
          };
          await this.stateStore.saveRoutineRun(skippedRun);
          const nextRoutine: RoutineSpec = {
            ...routine,
            lastRunAt: skippedRun.completedAt,
            lastRunStatus: "skipped_overlap",
            nextRunAt,
            updatedAt: nowIso(),
          };
          await this.stateStore.saveRoutine(nextRoutine);
          this.emitEvent({ type: "routine_run_updated", repoId: repo.id, routineId: routine.id, run: skippedRun, timestamp: skippedRun.completedAt! });
          this.emitEvent({ type: "routine_updated", repoId: repo.id, routine: nextRoutine, timestamp: nextRoutine.updatedAt });
          return skippedRun;
        }
      }

      // 2. Repo daily budget guard
      const today = utcTodayString();
      const effectiveBudget = getEffectiveDailyBudget(repo, today);
      if (effectiveBudget !== undefined && effectiveBudget > 0) {
        const todaySpend = await this.stateStore.getDailyRepoSpendUsd(repo.id, today);
        if (todaySpend >= effectiveBudget) {
          const skippedBudget: RoutineRun = {
            id: runId,
            routineId: routine.id,
            repoId: repo.id,
            status: "skipped_budget",
            summary: `Skipped patrol: daily repo budget reached ($${todaySpend.toFixed(2)} / $${effectiveBudget.toFixed(2)}).`,
            changedFiles: [],
            costUsd: 0,
            startedAt,
            completedAt: nowIso(),
          };
          await this.stateStore.saveRoutineRun(skippedBudget);
          const nextRoutine: RoutineSpec = {
            ...routine,
            lastRunAt: skippedBudget.completedAt,
            lastRunStatus: "skipped_budget",
            nextRunAt,
            updatedAt: nowIso(),
          };
          await this.stateStore.saveRoutine(nextRoutine);
          this.emitEvent({ type: "routine_run_updated", repoId: repo.id, routineId: routine.id, run: skippedBudget, timestamp: skippedBudget.completedAt! });
          this.emitEvent({ type: "routine_updated", repoId: repo.id, routine: nextRoutine, timestamp: nextRoutine.updatedAt });
          return skippedBudget;
        }
      }

      const initialRun: RoutineRun = {
        id: runId,
        routineId: routine.id,
        repoId: repo.id,
        status: "probing",
        summary: `Probing ${routine.name}...`,
        changedFiles: [],
        costUsd: 0,
        startedAt,
      };
      await this.stateStore.saveRoutineRun(initialRun);
      this.emitEvent({ type: "routine_run_updated", repoId: repo.id, routineId: routine.id, run: initialRun, timestamp: startedAt });

      const availableEngines = await this.getAvailableEngines();
      const preferred = routine.preferredEngine ?? repo.preferredImplementEngine;
      let driver = this.drivers.get(preferred);
      if (!driver) {
        const chain = resolveFallbackChain({
          primaryEngine: preferred,
          repo,
          availableEngines,
        });
        const alt = chain[0] ?? availableEngines[0];
        driver = alt ? this.drivers.get(alt) : undefined;
      }
      if (!driver) {
        const failedRun: RoutineRun = {
          ...initialRun,
          status: "failed",
          summary: `No available WorkerDriver for engine '${preferred}'`,
          completedAt: nowIso(),
        };
        await this.stateStore.saveRoutineRun(failedRun);
        const nextRoutine: RoutineSpec = {
          ...routine,
          activeTicketId: undefined,
          lastRunAt: failedRun.completedAt,
          lastRunStatus: "failed",
          nextRunAt,
          updatedAt: nowIso(),
        };
        await this.stateStore.saveRoutine(nextRoutine);
        this.emitEvent({ type: "routine_run_updated", repoId: repo.id, routineId: routine.id, run: failedRun, timestamp: failedRun.completedAt! });
        this.emitEvent({ type: "routine_updated", repoId: repo.id, routine: nextRoutine, timestamp: nextRoutine.updatedAt });
        return failedRun;
      }

      const probeId = `prb_${runId}`;
      const probeBranch = `super-work/routine-probe/${runId}`;
      const mandate = createDefaultMandate({
        allowedPaths: routine.allowedPaths.length > 0 ? routine.allowedPaths : ["**"],
        forbiddenPaths: repo.forbiddenPaths ?? [],
        maxCostUsd: routine.maxBudgetUsd,
      });
      const syntheticProbeTicket: Ticket = {
        id: probeId,
        repoId: repo.id,
        threadId: `thr_${probeId}`,
        sourceTriggerId: `trg_${probeId}`,
        title: `[Routine Probe] ${routine.name}`,
        description: `${routine.prompt}\n\nIMPORTANT PROBE RULE: If everything is healthy and no fix is required, make ZERO file edits and end with \`ROUTINE_VERDICT: CLEAN\`. Only modify files inside allowedPaths when applying a concrete minimal fix, or report \`ROUTINE_VERDICT: ISSUE_FOUND - <summary>\`.`,
        status: "implementing",
        template: routine.template,
        currentStage: "implement",
        stageRetries: 0,
        mandate,
        dependsOn: [],
        branchName: probeBranch,
        nativeSessions: {},
        inlineMemory: {
          goal: routine.prompt,
          acceptanceCriteria: ["Exit cleanly with no changes if healthy; apply minimal scoped fix if regression found."],
          stageNotes: [],
          threadUpdates: [],
        },
        costUsd: 0,
        priority: 0,
        createdAt: startedAt,
        updatedAt: startedAt,
      };

      const ws = await this.runWithRepoWorkspaceLock(repo.id, () =>
        this.workspace.prepareWorkspace(syntheticProbeTicket, repo, { startPoint: repo.baseBranch }),
      );

      const prompt = await this.buildEnrichedWorkerPrompt(syntheticProbeTicket, repo, "implement", {
        skipHitTracking: true,
      });

      const collectedEvents: WorkerStreamEvent[] = [];
      let completedEvent: Extract<WorkerStreamEvent, { type: "completed" }> | null = null;
      let stageCostUsd = 0;
      const ac = new AbortController();

      try {
        for await (const ev of driver.runTurn(
          {
            ticketId: probeId,
            stageRunId: runId,
            stage: "implement",
            worktreePath: ws.worktreePath,
            prompt,
            mandate,
            isResume: false,
            sandboxMode: repo.sandboxMode ?? "balanced",
            rootRepoPath: repo.rootPath,
          },
          ac.signal,
        )) {
          collectedEvents.push(ev);
          if (ev.type === "usage") {
            stageCostUsd = Math.max(stageCostUsd, ev.costUsd);
          } else if (ev.type === "completed") {
            completedEvent = ev;
            if (typeof ev.costUsd === "number") {
              stageCostUsd = Math.max(stageCostUsd, ev.costUsd);
            }
          }
        }
      } catch (err) {
        await this.workspace.cleanupWorkspace(ws.worktreePath, repo.rootPath).catch(() => {});
        await this.workspace.deleteBranch?.(repo.rootPath, ws.branchName).catch(() => {});
        const failedRun: RoutineRun = {
          ...initialRun,
          status: "failed",
          summary: err instanceof Error ? err.message : String(err),
          costUsd: stageCostUsd,
          completedAt: nowIso(),
        };
        await this.stateStore.saveRoutineRun(failedRun);
        const nextRoutine: RoutineSpec = {
          ...routine,
          activeTicketId: undefined,
          lastRunAt: failedRun.completedAt,
          lastRunStatus: "failed",
          nextRunAt,
          updatedAt: nowIso(),
        };
        await this.stateStore.saveRoutine(nextRoutine);
        this.emitEvent({ type: "routine_run_updated", repoId: repo.id, routineId: routine.id, run: failedRun, timestamp: failedRun.completedAt! });
        this.emitEvent({ type: "routine_updated", repoId: repo.id, routine: nextRoutine, timestamp: nextRoutine.updatedAt });
        return failedRun;
      }

      const rawChangedFiles = await this.workspace.getChangedFiles(ws.worktreePath, repo.baseBranch);
      const mandateCheck = validateChangedFilesAgainstMandate(rawChangedFiles, mandate);
      if (!mandateCheck.ok && mandateCheck.forbiddenViolations.length > 0) {
        await this.workspace.revertPaths(ws.worktreePath, mandateCheck.forbiddenViolations);
      }
      const changedFiles = await this.workspace.getChangedFiles(ws.worktreePath, repo.baseBranch);

      const textChunks = collectedEvents
        .filter((e): e is Extract<WorkerStreamEvent, { type: "text" }> => e.type === "text")
        .map((e) => e.text)
        .join("\n");
      const outputText = [completedEvent?.summary, textChunks].filter(Boolean).join("\n");
      const verdict = parseRoutineProbeVerdict(outputText, changedFiles);

      // Clean Fast Exit -> destroy probe workspace & branch silently, 0 tickets, 0 inbox noise
      if (verdict.action === "clean") {
        await this.workspace.cleanupWorkspace(ws.worktreePath, repo.rootPath).catch(() => {});
        await this.workspace.deleteBranch?.(repo.rootPath, ws.branchName).catch(() => {});

        const cleanRun: RoutineRun = {
          ...initialRun,
          status: "clean",
          summary: verdict.summary,
          changedFiles: [],
          costUsd: stageCostUsd,
          completedAt: nowIso(),
        };
        await this.stateStore.saveRoutineRun(cleanRun);
        const nextRoutine: RoutineSpec = {
          ...routine,
          activeTicketId: undefined,
          lastRunAt: cleanRun.completedAt,
          lastRunStatus: "clean",
          nextRunAt,
          updatedAt: nowIso(),
        };
        await this.stateStore.saveRoutine(nextRoutine);
        this.emitEvent({ type: "routine_run_updated", repoId: repo.id, routineId: routine.id, run: cleanRun, timestamp: cleanRun.completedAt! });
        this.emitEvent({ type: "routine_updated", repoId: repo.id, routine: nextRoutine, timestamp: nextRoutine.updatedAt });
        return cleanRun;
      }

      // Promote Phase -> convert probe finding/fix into a real Ticket
      const promoteTs = nowIso();
      const trigger: Trigger = {
        id: newId("trg"),
        repoId: repo.id,
        source: "cli",
        threadKey: `routine:${routine.id}:${runId}`,
        title: `[Routine] ${routine.name}`,
        payload: { routineId: routine.id, routineRunId: runId },
        rawText: `${routine.prompt}\n\nProbe findings: ${verdict.summary}`,
        createdAt: promoteTs,
      };
      await this.stateStore.saveTrigger(trigger);

      const thread: Thread = {
        id: newId("thr"),
        repoId: repo.id,
        threadKey: trigger.threadKey,
        metadata: { source: "routine", routineId: routine.id },
        createdAt: promoteTs,
        updatedAt: promoteTs,
      };
      await this.stateStore.upsertThread(thread);

      const ticketId = newId("tkt");

      if (verdict.isIssueReportOnly) {
        // Report-only patrol alert -> cleanup empty temp worktree and queue proposal in Inbox
        await this.workspace.cleanupWorkspace(ws.worktreePath, repo.rootPath).catch(() => {});
        await this.workspace.deleteBranch?.(repo.rootPath, ws.branchName).catch(() => {});

        const ticket: Ticket = {
          id: ticketId,
          repoId: repo.id,
          threadId: thread.id,
          sourceTriggerId: trigger.id,
          title: `[Routine Fix] ${routine.name}`,
          description: `${routine.prompt}\n\nDetected Issue:\n${verdict.summary}`,
          status: repo.mode === "auto" ? "queued" : "proposed",
          template: routine.template,
          currentStage: getFirstStage(routine.template),
          stageRetries: 0,
          mandate,
          dependsOn: [],
          nativeSessions: {},
          preferredEngine: routine.preferredEngine,
          routineId: routine.id,
          inlineMemory: {
            goal: `${routine.name}: ${verdict.summary}`,
            acceptanceCriteria: ["Resolve issue surfaced by scheduled patrol and pass verification"],
            stageNotes: [],
            threadUpdates: [],
          },
          costUsd: stageCostUsd,
          priority: 1,
          createdAt: promoteTs,
          updatedAt: promoteTs,
        };
        await this.stateStore.saveTicket(ticket);
        await this.stateStore.upsertThread({ ...thread, subscribedTicketId: ticket.id, updatedAt: promoteTs });
        this.emitEvent({ type: "ticket_created", ticket, timestamp: promoteTs });

        if (ticket.status === "proposed") {
          const proposalInbox: InboxItem = {
            id: newId("inb"),
            repoId: repo.id,
            ticketId: ticket.id,
            kind: "observe_proposal",
            status: "pending",
            title: `Routine Alert: ${routine.name}`,
            summary: verdict.summary,
            contextPayload: { routineId: routine.id, routineRunId: runId },
            createdAt: promoteTs,
          };
          await this.stateStore.saveInboxItem(proposalInbox);
          this.emitEvent({ type: "inbox_created", item: proposalInbox, timestamp: promoteTs });
        }

        const promotedRun: RoutineRun = {
          id: runId,
          routineId: routine.id,
          repoId: repo.id,
          status: "promoted",
          summary: `Promoted patrol finding to ${ticket.id}`,
          changedFiles: [],
          promotedTicketId: ticket.id,
          costUsd: stageCostUsd,
          startedAt,
          completedAt: nowIso(),
        };
        await this.stateStore.saveRoutineRun(promotedRun);
        const nextRoutine: RoutineSpec = {
          ...routine,
          activeTicketId: ticket.id,
          lastRunAt: promotedRun.completedAt,
          lastRunStatus: "promoted",
          nextRunAt,
          updatedAt: nowIso(),
        };
        await this.stateStore.saveRoutine(nextRoutine);
        this.emitEvent({ type: "routine_run_updated", repoId: repo.id, routineId: routine.id, run: promotedRun, timestamp: promotedRun.completedAt! });
        this.emitEvent({ type: "routine_updated", repoId: repo.id, routine: nextRoutine, timestamp: nextRoutine.updatedAt });
        return promotedRun;
      }

      // Probe produced concrete code changes inside allowedPaths -> keep probe worktree on the promoted ticket!
      const diffText = await this.workspace.getDiff(ws.worktreePath, repo.baseBranch);
      await this.workspace.commitAll(ws.worktreePath, `super-work(routine:${routine.id}): ${routine.name}`);

      const probeStageRun: StageRun = {
        id: newId("run"),
        ticketId,
        stage: "implement",
        engine: driver.engine,
        status: "running",
        costUsd: stageCostUsd,
        startedAt,
      };
      let promotedTicket: Ticket = {
        id: ticketId,
        repoId: repo.id,
        threadId: thread.id,
        sourceTriggerId: trigger.id,
        title: `[Routine Fix] ${routine.name}`,
        description: routine.prompt,
        status: "implementing",
        template: routine.template,
        currentStage: "implement",
        stageRetries: 0,
        mandate,
        dependsOn: [],
        worktreePath: ws.worktreePath,
        branchName: ws.branchName,
        nativeSessions: {},
        preferredEngine: routine.preferredEngine,
        activeEngine: driver.engine,
        routineId: routine.id,
        inlineMemory: {
          goal: routine.prompt,
          acceptanceCriteria: ["Scheduled patrol fix passes verification and review"],
          stageNotes: [],
          threadUpdates: [],
        },
        costUsd: stageCostUsd,
        priority: 1,
        createdAt: promoteTs,
        updatedAt: promoteTs,
      };
      await this.stateStore.saveTicket(promotedTicket);
      await this.stateStore.upsertThread({ ...thread, subscribedTicketId: promotedTicket.id, updatedAt: promoteTs });
      this.emitEvent({ type: "ticket_created", ticket: promotedTicket, timestamp: promoteTs });

      const gate = await this.runRepoVerificationGate(promotedTicket, repo, probeStageRun, ws.worktreePath, {
        isFinalDeliveryGate: false,
      });

      const finishedRun: StageRun = {
        ...probeStageRun,
        status: gate.passed ? "completed" : "failed",
        completedAt: nowIso(),
        summary: gate.passed
          ? verdict.summary
          : gate.result?.summary ?? "Routine fix failed verification gate",
      };
      const { note } = await this.memory.recordStageSpillAndNote({
        ticket: promotedTicket,
        stageRun: finishedRun,
        events: collectedEvents,
        changedFiles,
        diffText,
        summary: finishedRun.summary!,
        verificationPassed: gate.passed,
        extraArtifacts: gate.artifacts.length > 0 ? gate.artifacts : undefined,
      });
      finishedRun.spillTranscriptId = note.spillArtifactIds[0];
      await this.stateStore.saveStageRun(finishedRun);

      const postProbeMemory = {
        ...promotedTicket.inlineMemory,
        stageNotes: [note],
        activeHint: gate.passed
          ? undefined
          : `Routine probe changes need verification fix: ${finishedRun.summary}`,
      };

      const nextStageAfterImpl = getNextStage(promotedTicket.template, "implement");
      if (!gate.passed) {
        promotedTicket = {
          ...promotedTicket,
          status: "queued",
          currentStage: "implement",
          inlineMemory: postProbeMemory,
          updatedAt: nowIso(),
        };
        await this.stateStore.saveTicket(promotedTicket);
        this.emitEvent({ type: "ticket_updated", ticket: promotedTicket, timestamp: promotedTicket.updatedAt });
      } else if (!nextStageAfterImpl) {
        await this.enqueueDeliveryOutbox(
          {
            ...promotedTicket,
            inlineMemory: postProbeMemory,
          },
          repo,
        );
      } else {
        promotedTicket = {
          ...promotedTicket,
          status: "queued",
          currentStage: nextStageAfterImpl,
          activeEngine: undefined,
          inlineMemory: postProbeMemory,
          updatedAt: nowIso(),
        };
        await this.stateStore.saveTicket(promotedTicket);
        this.emitEvent({ type: "ticket_updated", ticket: promotedTicket, timestamp: promotedTicket.updatedAt });
      }

      const promotedRun: RoutineRun = {
        id: runId,
        routineId: routine.id,
        repoId: repo.id,
        status: "promoted",
        summary: `Promoted edits in ${changedFiles.join(", ")} -> ticket ${promotedTicket.id}`,
        changedFiles,
        promotedTicketId: promotedTicket.id,
        costUsd: stageCostUsd,
        startedAt,
        completedAt: nowIso(),
      };
      await this.stateStore.saveRoutineRun(promotedRun);
      const nextRoutine: RoutineSpec = {
        ...routine,
        activeTicketId: promotedTicket.id,
        lastRunAt: promotedRun.completedAt,
        lastRunStatus: "promoted",
        nextRunAt,
        updatedAt: nowIso(),
      };
      await this.stateStore.saveRoutine(nextRoutine);
      this.emitEvent({ type: "routine_run_updated", repoId: repo.id, routineId: routine.id, run: promotedRun, timestamp: promotedRun.completedAt! });
      this.emitEvent({ type: "routine_updated", repoId: repo.id, routine: nextRoutine, timestamp: nextRoutine.updatedAt });
      return promotedRun;
    } finally {
      this.activeRoutineRuns.delete(routine.id);
    }
  }

  // --- B.1 Arena Duel ---
  private async cleanupArenaCandidateWorktrees(
    candidates: ArenaCandidateResult[],
    rootRepoPath?: string,
    keepCandidateId?: string,
  ): Promise<void> {
    for (const cand of candidates) {
      if (keepCandidateId && cand.candidateId === keepCandidateId) continue;
      if (cand.worktreePath) {
        await this.workspace.cleanupWorkspace(cand.worktreePath, rootRepoPath).catch(() => {});
      }
      if (rootRepoPath && cand.branchName) {
        await this.workspace.deleteBranch?.(rootRepoPath, cand.branchName).catch(() => {});
      }
    }
  }

  private async adoptArenaCandidateWinner(
    ticket: Ticket,
    repo: RepoConfig | undefined,
    winner: ArenaCandidateResult,
    candidates: ArenaCandidateResult[],
    fromTiebreakInbox = false,
  ): Promise<Ticket> {
    await this.previewProvider?.stopPreviewsForTicket(ticket.id).catch(() => {});
    if (repo) {
      await this.cleanupArenaCandidateWorktrees(candidates, repo.rootPath, winner.candidateId);
    }
    if (winner.worktreePath && existsSync(winner.worktreePath)) {
      await this.workspace.commitAll(
        winner.worktreePath,
        `super-work(${ticket.id}/arena:${winner.engine}): ${ticket.title}`,
      );
    }

    const updatedCandidates = candidates.map((c) => ({
      ...c,
      worktreePath: c.candidateId === winner.candidateId ? winner.worktreePath : undefined,
      recommended: c.candidateId === winner.candidateId,
    }));

    const note = {
      stageRunId: winner.stageRunId,
      stage: "implement" as const,
      engine: winner.engine,
      summary: `[Arena Winner: ${winner.engine}, score ${winner.score}] ${winner.summary}`,
      changedFiles: winner.changedFiles,
      verificationPassed: winner.verificationPassed,
      spillArtifactIds: [
        ...(winner.diffArtifactId ? [winner.diffArtifactId] : []),
        ...(winner.screenshotArtifactIds ?? []),
      ],
      createdAt: nowIso(),
    };

    const nextStage = ticket.prNumber ? "rebase" : getNextStage(ticket.template, "implement");
    const nextMemory = {
      ...ticket.inlineMemory,
      stageNotes: [...ticket.inlineMemory.stageNotes, note],
      ...(fromTiebreakInbox ? {} : { activeHint: undefined }),
    };

    if (!nextStage) {
      const preDelivery: Ticket = {
        ...ticket,
        worktreePath: winner.worktreePath,
        branchName: winner.branchName,
        activeEngine: undefined,
        failedEngines: [],
        arenaWinnerId: winner.candidateId,
        arenaCandidates: updatedCandidates,
        inlineMemory: nextMemory,
        updatedAt: nowIso(),
      };
      await this.enqueueDeliveryOutbox(preDelivery, repo);
      return (await this.stateStore.getTicket(ticket.id)) ?? preDelivery;
    }

    const nextTicket: Ticket = {
      ...ticket,
      status: "queued",
      currentStage: nextStage,
      stageRetries: 0,
      worktreePath: winner.worktreePath,
      branchName: winner.branchName,
      activeEngine: undefined,
      failedEngines: [],
      arenaWinnerId: winner.candidateId,
      arenaCandidates: updatedCandidates,
      inlineMemory: nextMemory,
      errorMessage: undefined,
      updatedAt: nowIso(),
    };
    await this.stateStore.saveTicket(nextTicket);
    this.emitEvent({ type: "ticket_updated", ticket: nextTicket, timestamp: nextTicket.updatedAt });
    return nextTicket;
  }

  private async runArenaImplementStage(
    ticket: Ticket,
    repo: RepoConfig,
    availableEngines: WorkerEngineId[],
  ): Promise<boolean> {
    const engineA = selectEngineForStage(repo, "implement", ticket.preferredEngine);
    const preferredOpponent = ticket.arenaCompetitorEngine;
    const engineB =
      preferredOpponent &&
      preferredOpponent !== engineA &&
      availableEngines.includes(preferredOpponent) &&
      this.drivers.has(preferredOpponent)
        ? preferredOpponent
        : pickNextFallbackEngine({
            currentEngine: engineA,
            repo,
            availableEngines,
          });

    const driverA = this.drivers.get(engineA);
    const driverB = engineB ? this.drivers.get(engineB) : undefined;
    if (!driverA || !driverB || engineA === engineB) {
      return false;
    }

    const { effectiveBaseBranch } = await this.getEffectiveBaseInfo(ticket, repo);
    const sameRepoDepBranches: string[] = [];
    for (const depId of ticket.dependsOn) {
      const dep = await this.stateStore.getTicket(depId);
      if (dep?.branchName && dep.repoId === ticket.repoId) {
        sameRepoDepBranches.push(dep.branchName);
      }
    }

    const candSpec = [
      { id: "cand_a", engine: driverA.engine, driver: driverA, branch: `super-work/${ticket.id}-cand-a` },
      { id: "cand_b", engine: driverB.engine, driver: driverB, branch: `super-work/${ticket.id}-cand-b` },
    ];

    const workspaces: Array<{ worktreePath: string; branchName: string }> = [];
    for (const spec of candSpec) {
      const ws = await this.runWithRepoWorkspaceLock(repo.id, async () => {
        const prepared = await this.workspace.prepareWorkspace(
          { ...ticket, id: `${ticket.id}_${spec.id}`, worktreePath: undefined, branchName: spec.branch },
          repo,
          { startPoint: effectiveBaseBranch },
        );
        if (sameRepoDepBranches.length > 0) {
          await this.workspace.integrateDependencyBranches(prepared.worktreePath, sameRepoDepBranches);
        }
        return prepared;
      });
      workspaces.push(ws);
    }

    const prompt = await this.buildEnrichedWorkerPrompt(ticket, repo, "implement");
    const implementingTicket: Ticket = {
      ...ticket,
      status: "implementing",
      currentStage: "implement",
      activeEngine: engineA,
      updatedAt: nowIso(),
    };
    await this.stateStore.saveTicket(implementingTicket);
    this.emitEvent({ type: "ticket_updated", ticket: implementingTicket, timestamp: implementingTicket.updatedAt });

    const abortController = new AbortController();
    this.abortControllers.set(ticket.id, abortController);

    const runSingleCandidate = async (
      idx: number,
    ): Promise<Omit<ArenaCandidateResult, "score" | "recommended">> => {
      const spec = candSpec[idx]!;
      const ws = workspaces[idx]!;
      const startedMs = Date.now();
      const stageRun: StageRun = {
        id: newId("run"),
        ticketId: ticket.id,
        stage: "implement",
        engine: spec.engine,
        status: "running",
        costUsd: 0,
        startedAt: nowIso(),
      };
      await this.stateStore.saveStageRun(stageRun);
      this.emitEvent({
        type: "stage_started",
        ticketId: ticket.id,
        stageRun,
        timestamp: stageRun.startedAt,
      });

      const events: WorkerStreamEvent[] = [];
      let completed: Extract<WorkerStreamEvent, { type: "completed" }> | null = null;
      let costUsd = 0;

      try {
        for await (const ev of spec.driver.runTurn(
          {
            ticketId: ticket.id,
            stageRunId: stageRun.id,
            stage: "implement",
            worktreePath: ws.worktreePath,
            prompt,
            mandate: ticket.mandate,
            isResume: false,
            sandboxMode: repo.sandboxMode ?? "balanced",
            rootRepoPath: repo.rootPath,
          },
          abortController.signal,
        )) {
          events.push(ev);
          this.emitEvent({
            type: "worker_event",
            ticketId: ticket.id,
            stageRunId: stageRun.id,
            engine: spec.engine,
            event: ev,
            timestamp: ev.timestamp,
          });
          if (ev.type === "usage") costUsd = Math.max(costUsd, ev.costUsd);
          if (ev.type === "completed") {
            completed = ev;
            if (typeof ev.costUsd === "number") costUsd = Math.max(costUsd, ev.costUsd);
          }
        }
      } catch (err) {
        events.push({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
          fatal: true,
          timestamp: nowIso(),
        });
      }

      const rawChanged = await this.workspace.getChangedFiles(ws.worktreePath, effectiveBaseBranch);
      const mandateCheck = validateChangedFilesAgainstMandate(rawChanged, ticket.mandate);
      if (!mandateCheck.ok) {
        await this.workspace.revertPaths(ws.worktreePath, mandateCheck.violations);
      }

      const changedFiles = await this.workspace.getChangedFiles(ws.worktreePath, effectiveBaseBranch);
      const diffText = await this.workspace.getDiff(ws.worktreePath, effectiveBaseBranch);
      const { addedLines, deletedLines } = countDiffLines(diffText);

      const gate = mandateCheck.ok
        ? await this.runRepoVerificationGate(ticket, repo, stageRun, ws.worktreePath, {
            isFinalDeliveryGate: false,
          })
        : { passed: false, artifacts: [] as SpillArtifact[], result: undefined };

      const lastErr = [...events].reverse().find((e) => e.type === "error");
      const verificationPassed = mandateCheck.ok && !lastErr && gate.passed;
      const verificationSummary = !mandateCheck.ok
        ? `Mandate violation: ${mandateCheck.violations.join(", ")}`
        : lastErr && lastErr.type === "error"
          ? `Turn error: ${lastErr.message}`
          : gate.result?.summary ?? (gate.passed ? "Verification passed" : "Verification failed");

      const textSummary =
        completed?.summary ||
        events
          .filter((e): e is Extract<WorkerStreamEvent, { type: "text" }> => e.type === "text")
          .map((e) => e.text)
          .join("\n") ||
        `${spec.engine} candidate`;

      const finishedRun: StageRun = {
        ...stageRun,
        status: verificationPassed ? "completed" : "failed",
        costUsd,
        completedAt: nowIso(),
        summary: `[Arena ${spec.id}] ${verificationSummary}`,
      };

      const { note } = await this.memory.recordStageSpillAndNote({
        ticket,
        stageRun: finishedRun,
        events,
        changedFiles,
        diffText,
        summary: textSummary,
        verificationPassed,
        extraArtifacts: gate.artifacts.length > 0 ? gate.artifacts : undefined,
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

      const diffArtifactId = note.spillArtifactIds.find((aid, i) => i > 0 && aid);
      let recordedDiffId = diffArtifactId;
      if (!recordedDiffId && diffText.trim()) {
        const diffArt = await this.artifactStore.writeSpill(
          {
            ticketId: ticket.id,
            stageRunId: stageRun.id,
            kind: "diff",
            summary: `Arena ${spec.engine} candidate diff`,
            ext: "patch",
          },
          diffText,
        );
        await this.stateStore.saveArtifact(diffArt, changedFiles.join(" "));
        recordedDiffId = diffArt.id;
      }

      const screenshotArtifactIds = gate.artifacts
        .filter((a) => a.kind === "screenshot")
        .map((a) => a.id);

      return {
        candidateId: spec.id,
        engine: spec.engine,
        branchName: ws.branchName,
        worktreePath: ws.worktreePath,
        stageRunId: stageRun.id,
        verificationPassed,
        verificationSummary,
        changedFiles,
        addedLines,
        deletedLines,
        durationMs: Math.max(1, Date.now() - startedMs),
        costUsd,
        summary: textSummary.slice(0, 400),
        diffArtifactId: recordedDiffId,
        ...(screenshotArtifactIds.length > 0 ? { screenshotArtifactIds } : {}),
      };
    };

    const [rawA, rawB] = await Promise.all([runSingleCandidate(0), runSingleCandidate(1)]);
    const totalArenaCost = rawA.costUsd + rawB.costUsd;
    let scored = scoreArenaCandidates(rawA, rawB);

    if (scored[0].verificationPassed && scored[1].verificationPassed && this.llm.judgeArenaCandidates) {
      try {
        const judgment = await this.llm.judgeArenaCandidates({
          repo,
          ticket: implementingTicket,
          candidates: scored,
        });
        if (judgment && (judgment.winnerCandidateId === "cand_a" || judgment.winnerCandidateId === "cand_b")) {
          scored = scored.map((c) => ({
            ...c,
            recommended: c.candidateId === judgment.winnerCandidateId,
            rationale:
              c.candidateId === judgment.winnerCandidateId
                ? `${judgment.rationale} (${c.rationale ?? ""})`.trim()
                : c.rationale,
          })) as [ArenaCandidateResult, ArenaCandidateResult];
        }
      } catch {
        // Keep deterministic score winner
      }
    }

    const updatedWithCost: Ticket = {
      ...implementingTicket,
      costUsd: ticket.costUsd + totalArenaCost,
      arenaCandidates: scored,
      updatedAt: nowIso(),
    };

    const passCount = scored.filter((c) => c.verificationPassed).length;
    const recommended = scored.find((c) => c.recommended) ?? scored[0];

    if (passCount === 1 || (passCount === 2 && repo.mode === "auto")) {
      await this.adoptArenaCandidateWinner(updatedWithCost, repo, recommended, scored, false);
      return true;
    }

    if (passCount === 2 && repo.mode === "observe") {
      await this.stateStore.saveTicket({
        ...updatedWithCost,
        status: "needs_human",
        activeEngine: undefined,
        errorMessage: "Arena duel finished with two passing candidates; choose winner in Inbox.",
      });
      this.emitEvent({
        type: "ticket_updated",
        ticket: { ...updatedWithCost, status: "needs_human", activeEngine: undefined },
        timestamp: nowIso(),
      });
      const inboxItem: InboxItem = {
        id: newId("inb"),
        repoId: repo.id,
        ticketId: ticket.id,
        kind: "arena_tiebreak",
        status: "pending",
        title: `Arena Duel Ready: ${ticket.title}`,
        summary: `Both ${scored[0].engine} (score ${scored[0].score}) and ${scored[1].engine} (score ${scored[1].score}) passed all verification gates. Compare diffs and adopt the winning branch.`,
        contextPayload: {
          recommendedCandidateId: recommended.candidateId,
          candidates: scored,
        },
        createdAt: nowIso(),
      };
      await this.stateStore.saveInboxItem(inboxItem);
      this.emitEvent({ type: "inbox_created", item: inboxItem, timestamp: inboxItem.createdAt });
      return true;
    }

    // Both candidates failed: retain higher-scored workspace for inspection and escalate
    await this.cleanupArenaCandidateWorktrees(scored, repo.rootPath, recommended.candidateId);
    await this.escalateTicket(
      {
        ...updatedWithCost,
        worktreePath: recommended.worktreePath,
        branchName: recommended.branchName,
      },
      "watchdog_escalation",
      `Both Arena candidates failed verification:\n- ${scored[0].engine}: ${scored[0].verificationSummary}\n- ${scored[1].engine}: ${scored[1].verificationSummary}`,
      { candidates: scored },
    );
    return true;
  }

  // --- C.1 Adaptive Epic Re-planning ---
  private async maybeEvaluateEpicReplan(epicId: string, completedSubtask: Ticket): Promise<void> {
    const epic = await this.stateStore.getTicket(epicId);
    if (!epic || !epic.isEpic) return;
    if ((epic.epicReplanCount ?? 0) >= 2 || epic.pendingEpicReplan) return;
    const repo = await this.stateStore.getRepo(epic.repoId);
    if (!repo) return;

    const digest = completedSubtask.handoverDigest;
    if (!digest) return;

    const allTickets = await this.stateStore.listTickets();
    const allSubtasks = allTickets.filter((t) => t.parentTicketId === epic.id);
    const unstartedSubtasks = allSubtasks.filter((t) => t.status === "waiting_deps");
    if (unstartedSubtasks.length === 0) return;

    let proposal: EpicReplanProposal | null = null;
    if (this.llm.proposeEpicReplan) {
      try {
        proposal = await this.llm.proposeEpicReplan({
          repo,
          epic,
          completedSubtask,
          digest,
          unstartedSubtasks,
          allSubtasks,
        });
      } catch {
        proposal = null;
      }
    }
    if (!proposal) {
      proposal = evaluateHeuristicEpicReplan({
        epic,
        completedSubtask,
        digest,
        unstartedSubtasks,
        allSubtasks,
      });
    }

    if (!proposal.shouldReplan || proposal.mutations.length === 0) {
      return;
    }

    // Hard enforce graded permission boundary deterministically in kernel
    const classification = classifyEpicReplanApproval({
      epic,
      repo,
      mutations: proposal.mutations,
    });
    const enforcedProposal: EpicReplanProposal = {
      ...proposal,
      requiresHumanApproval: classification.requiresHumanApproval,
      triggeredByTicketId: completedSubtask.id,
      createdAt: proposal.createdAt || nowIso(),
    };

    if (!enforcedProposal.requiresHumanApproval) {
      await this.applyEpicReplanProposal(epic, enforcedProposal, { humanApproved: false });
      return;
    }

    const ts = nowIso();
    const pausedEpic: Ticket = {
      ...epic,
      status: "needs_human",
      pendingEpicReplan: enforcedProposal,
      errorMessage: `Pending adaptive Epic re-plan approval: ${enforcedProposal.summary}`,
      updatedAt: ts,
    };
    await this.stateStore.saveTicket(pausedEpic);
    this.emitEvent({ type: "ticket_updated", ticket: pausedEpic, timestamp: ts });

    const inboxItem: InboxItem = {
      id: newId("inb"),
      repoId: epic.repoId,
      ticketId: epic.id,
      kind: "epic_replan",
      status: "pending",
      title: `Epic Re-Plan Approval: ${epic.title}`,
      summary: enforcedProposal.summary,
      contextPayload: {
        proposal: enforcedProposal,
        reasons: classification.reasons,
      },
      createdAt: ts,
    };
    await this.stateStore.saveInboxItem(inboxItem);
    this.emitEvent({ type: "inbox_created", item: inboxItem, timestamp: ts });
  }

  private async applyEpicReplanProposal(
    epic: Ticket,
    proposal: EpicReplanProposal,
    options: { humanApproved: boolean },
  ): Promise<Ticket> {
    const repo = await this.stateStore.getRepo(epic.repoId);
    const allRepos = await this.stateStore.listRepos();
    const reposById = new Map(allRepos.map((r) => [r.id, r]));
    const allTickets = await this.stateStore.listTickets();
    let children = allTickets.filter((t) => t.parentTicketId === epic.id);

    const byKey = new Map<string, Ticket>();
    const byId = new Map<string, Ticket>();
    for (const c of children) {
      byId.set(c.id, c);
      if (c.subtaskKey) byKey.set(c.subtaskKey, c);
    }

    const ts = nowIso();
    let addedCount = 0;
    const addedMax = 3;
    const expandedEpicAllowed = new Set(epic.mandate.allowedPaths);

    for (const mut of proposal.mutations) {
      if (mut.kind === "update_subtask") {
        const target =
          (mut.targetTicketId ? byId.get(mut.targetTicketId) : undefined) ??
          (mut.targetSubtaskKey ? byKey.get(mut.targetSubtaskKey) : undefined);
        if (!target || (target.status !== "waiting_deps" && target.status !== "queued")) continue;

        const nextAllowed =
          mut.allowedPaths && mut.allowedPaths.length > 0
            ? mut.allowedPaths
            : target.mandate.allowedPaths;
        if (options.humanApproved) {
          for (const p of nextAllowed) expandedEpicAllowed.add(p);
        }
        const updatedChild: Ticket = {
          ...target,
          title: mut.title?.trim() || target.title,
          description: mut.description?.trim() || target.description,
          mandate: {
            ...target.mandate,
            allowedPaths: nextAllowed,
          },
          inlineMemory: {
            ...target.inlineMemory,
            goal: mut.description?.trim() || target.inlineMemory.goal,
            acceptanceCriteria:
              mut.acceptanceCriteria && mut.acceptanceCriteria.length > 0
                ? mut.acceptanceCriteria
                : target.inlineMemory.acceptanceCriteria,
          },
          updatedAt: ts,
        };
        await this.stateStore.saveTicket(updatedChild);
        this.emitEvent({ type: "ticket_updated", ticket: updatedChild, timestamp: ts });
        byId.set(updatedChild.id, updatedChild);
        if (updatedChild.subtaskKey) byKey.set(updatedChild.subtaskKey, updatedChild);
      } else if (mut.kind === "skip_subtask") {
        const target =
          (mut.targetTicketId ? byId.get(mut.targetTicketId) : undefined) ??
          (mut.targetSubtaskKey ? byKey.get(mut.targetSubtaskKey) : undefined);
        if (!target || target.status !== "waiting_deps") continue;

        const skipped: Ticket = {
          ...target,
          status: "cancelled",
          errorMessage: `Skipped by Adaptive Epic Re-plan: ${mut.reason}`,
          updatedAt: ts,
        };
        await this.stateStore.saveTicket(skipped);
        this.emitEvent({ type: "ticket_updated", ticket: skipped, timestamp: ts });
        byId.set(skipped.id, skipped);

        // Rewire every remaining sibling that depended on `skipped.id` so DAG stays connected and deadlock-free
        for (const sib of children) {
          if (sib.id === skipped.id || !sib.dependsOn.includes(skipped.id)) continue;
          const rewiredDeps = Array.from(
            new Set([
              ...sib.dependsOn.filter((d) => d !== skipped.id),
              ...skipped.dependsOn,
            ]),
          );
          const updatedSib: Ticket = {
            ...sib,
            dependsOn: rewiredDeps,
            updatedAt: ts,
          };
          await this.stateStore.saveTicket(updatedSib);
          this.emitEvent({ type: "ticket_updated", ticket: updatedSib, timestamp: ts });
          byId.set(updatedSib.id, updatedSib);
        }
      } else if (mut.kind === "add_subtask" && addedCount < addedMax && children.length < 10) {
        const targetRepo =
          (mut.repoId ? reposById.get(mut.repoId) : undefined) ?? repo;
        if (!targetRepo) continue;
        addedCount += 1;

        const [sanitizedSpec] = sanitizeEpicSubtasks(
          [
            {
              key: mut.targetSubtaskKey ?? `replan_${(epic.epicReplanCount ?? 0) + 1}_${addedCount}`,
              repoId: targetRepo.id,
              title: mut.title ?? `Adaptive step ${addedCount}`,
              description: mut.description ?? mut.reason,
              template: mut.template ?? epic.template,
              allowedPaths: mut.allowedPaths ?? ["**"],
              dependsOnKeys: mut.dependsOnKeys ?? [],
              acceptanceCriteria: mut.acceptanceCriteria ?? [mut.reason],
            },
          ],
          epic.template,
          { defaultRepoId: targetRepo.id },
        );
        if (!sanitizedSpec) continue;

        let subKey = sanitizedSpec.key;
        let suffix = 2;
        while (byKey.has(subKey)) {
          subKey = `${sanitizedSpec.key}_${suffix++}`;
        }

        const depIds = (mut.dependsOnKeys ?? [])
          .map((k) => byKey.get(k)?.id ?? byId.get(k)?.id)
          .filter((id): id is string => Boolean(id));
        if (depIds.length === 0 && byId.has(proposal.triggeredByTicketId)) {
          depIds.push(proposal.triggeredByTicketId);
        }

        const subThreadKey = `epic:${epic.id}:${subKey}`;
        const subThread: Thread = {
          id: newId("thr"),
          repoId: targetRepo.id,
          threadKey: subThreadKey,
          metadata: { source: "epic_replan", epicId: epic.id, subtaskKey: subKey },
          createdAt: ts,
          updatedAt: ts,
        };
        await this.stateStore.upsertThread(subThread);

        const newChildId = newId("tkt");
        const childMandate = createDefaultMandate({
          allowedPaths: sanitizedSpec.allowedPaths,
          forbiddenPaths: targetRepo.forbiddenPaths ?? [],
          maxCostUsd: 2.0,
        });
        if (options.humanApproved) {
          for (const p of childMandate.allowedPaths) expandedEpicAllowed.add(p);
        }

        let allDepsDelivered = depIds.length === 0;
        if (depIds.length > 0) {
          allDepsDelivered = depIds.every((id) => byId.get(id)?.status === "delivered");
        }

        const newChild: Ticket = {
          id: newChildId,
          repoId: targetRepo.id,
          threadId: subThread.id,
          sourceTriggerId: epic.sourceTriggerId,
          title: sanitizedSpec.title,
          description: sanitizedSpec.description,
          status: allDepsDelivered ? "queued" : "waiting_deps",
          template: sanitizedSpec.template,
          currentStage: getFirstStage(sanitizedSpec.template),
          stageRetries: 0,
          mandate: childMandate,
          dependsOn: depIds,
          parentTicketId: epic.id,
          isEpic: false,
          subtaskKey: subKey,
          nativeSessions: {},
          preferredEngine: epic.preferredEngine,
          activeEngine: epic.preferredEngine,
          inlineMemory: {
            goal: sanitizedSpec.description,
            acceptanceCriteria: sanitizedSpec.acceptanceCriteria,
            stageNotes: [],
            threadUpdates: [],
          },
          costUsd: 0,
          priority: 1,
          createdAt: ts,
          updatedAt: ts,
        };
        await this.stateStore.saveTicket(newChild);
        await this.stateStore.upsertThread({ ...subThread, subscribedTicketId: newChild.id, updatedAt: ts });
        this.emitEvent({ type: "ticket_created", ticket: newChild, timestamp: ts });
        children.push(newChild);
        byId.set(newChild.id, newChild);
        byKey.set(subKey, newChild);
      }
    }

    const updatedEpic: Ticket = {
      ...epic,
      status: "implementing",
      pendingEpicReplan: undefined,
      epicReplanCount: (epic.epicReplanCount ?? 0) + 1,
      epicReplanHistory: [...(epic.epicReplanHistory ?? []), proposal],
      mandate: {
        ...epic.mandate,
        allowedPaths: Array.from(expandedEpicAllowed),
      },
      errorMessage: undefined,
      updatedAt: ts,
    };
    await this.stateStore.saveTicket(updatedEpic);
    this.emitEvent({ type: "ticket_updated", ticket: updatedEpic, timestamp: ts });
    this.emitEvent({
      type: "epic_replanned",
      repoId: updatedEpic.repoId,
      epicId: updatedEpic.id,
      proposal,
      autoApplied: !options.humanApproved,
      timestamp: ts,
    });
    return updatedEpic;
  }
}
