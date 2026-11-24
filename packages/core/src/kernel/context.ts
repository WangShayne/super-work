import type { MemoryManager } from "../memory.ts";
import type {
  ArtifactStore,
  ControlPlaneLLM,
  DirectTicketInput,
  OutboxExecutor,
  PreviewProvider,
  RepoProbeExecutor,
  StateStore,
  WorkerDriver,
  WorkspaceProvider,
} from "../ports.ts";
import type { TwoTierWatchdog } from "../watchdog.ts";
import type {
  HandoverDigest,
  InboxItemKind,
  KernelEvent,
  ManagedWorktreeItem,
  OutboxEntry,
  PlaybookEntry,
  RepoConfig,
  SpillArtifact,
  StageKind,
  StageRun,
  StageSpan,
  SteerTicketInput,
  Ticket,
  TicketCheckpoint,
  VerificationRunResult,
  WorkerEngineId,
  WorktreeGcResult,
} from "../types.ts";

export interface KernelCoordinatorContext {
  stateStore: StateStore;
  artifactStore: ArtifactStore;
  workspace: WorkspaceProvider;
  memory: MemoryManager;
  llm: ControlPlaneLLM;
  watchdog: TwoTierWatchdog;
  outboxExecutor: OutboxExecutor;
  previewProvider?: PreviewProvider;
  dataDir: string;
  drivers: Map<WorkerEngineId, WorkerDriver>;
  activeTicketRuns: Map<string, Promise<void>>;
  activeRoutineRuns: Set<string>;
  abortControllers: Map<string, AbortController>;
  pendingSteers: Map<string, SteerTicketInput>;
  finalizingEpics: Set<string>;
  isStopped(): boolean;
  emitEvent(event: KernelEvent): void;
  getAvailableEngines(): Promise<WorkerEngineId[]>;
  getEffectiveDailyBudget(repo: RepoConfig, utcDate: string): number | undefined;
  createRepoProbeExecutor(repo: RepoConfig): RepoProbeExecutor | undefined;
  runWithRepoWorkspaceLock<T>(repoId: string, fn: () => Promise<T>): Promise<T>;
  runWithEpicLock<T>(epicId: string, fn: () => Promise<T>): Promise<T>;
  getEffectiveBaseInfo(
    ticket: Ticket,
    repo: RepoConfig,
  ): Promise<{ effectiveBaseBranch: string; parentEpic?: Ticket }>;
  hasUnfinishedDependencies(ticket: Ticket): Promise<boolean>;
  buildEnrichedWorkerPrompt(
    ticket: Ticket,
    repo: RepoConfig,
    stage: StageKind,
    options?: { skipHitTracking?: boolean },
  ): Promise<string>;
  captureTicketCheckpoint(
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
  ): Promise<TicketCheckpoint | null>;
  runRepoVerificationGate(
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
  }>;
  enqueueDeliveryOutbox(ticket: Ticket, repoArg?: RepoConfig): Promise<void>;
  onOutboxTicketDelivered(ticket: Ticket, repo: RepoConfig, entry: OutboxEntry): Promise<void>;
  escalateTicket(
    ticket: Ticket,
    kind: InboxItemKind,
    summary: string,
    contextPayload: Record<string, unknown>,
  ): Promise<void>;
  createDirectTicket(input: DirectTicketInput): Promise<Ticket>;
  inspectWorktrees(repoId?: string): Promise<ManagedWorktreeItem[]>;
  gcWorktrees(options?: { repoId?: string }): Promise<WorktreeGcResult>;
  cleanupTicketWorktree(ticketId: string): Promise<Ticket | null>;
  addOrUpdatePlaybookRule(input: {
    repoId: string;
    rule: string;
    scopePaths?: string[];
    source: PlaybookEntry["source"];
    sourceTicketId?: string;
    pinned?: boolean;
    enabled?: boolean;
  }): Promise<PlaybookEntry | null>;
  maybeDistillClosedLoopLesson(ticket: Ticket, repoArg?: RepoConfig): Promise<void>;
  generateAndSaveHandoverDigest(
    ticket: Ticket,
    repo: RepoConfig,
    precomputed?: { changedFiles: string[]; diffText: string },
  ): Promise<Ticket>;
  recordDeliveredCasebookEntry(ticket: Ticket, repo?: RepoConfig): Promise<void>;
  maybeEvaluateEpicReplan(epicId: string, completedSubtask: Ticket): Promise<void>;
  onCampaignTicketSettled(ticket: Ticket, repo: RepoConfig): Promise<void>;
  ensureMergeTrainForOutbox(entry: OutboxEntry, ticket: Ticket, repo: RepoConfig): Promise<void>;
}
