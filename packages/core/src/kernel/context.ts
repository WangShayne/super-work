import type { MemoryManager } from "../memory.ts";
import type {
  ArtifactStore,
  ControlPlaneLLM,
  DirectTicketInput,
  PreviewProvider,
  StateStore,
  WorkerDriver,
  WorkspaceProvider,
} from "../ports.ts";
import type {
  InboxItemKind,
  KernelEvent,
  ManagedWorktreeItem,
  RepoConfig,
  SpillArtifact,
  StageKind,
  StageRun,
  StageSpan,
  Ticket,
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
  previewProvider?: PreviewProvider;
  dataDir: string;
  drivers: Map<WorkerEngineId, WorkerDriver>;
  activeTicketRuns: Map<string, Promise<void>>;
  activeRoutineRuns: Set<string>;
  abortControllers: Map<string, AbortController>;
  isStopped(): boolean;
  emitEvent(event: KernelEvent): void;
  getAvailableEngines(): Promise<WorkerEngineId[]>;
  getEffectiveDailyBudget(repo: RepoConfig, utcDate: string): number | undefined;
  runWithRepoWorkspaceLock<T>(repoId: string, fn: () => Promise<T>): Promise<T>;
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
  escalateTicket(
    ticket: Ticket,
    kind: InboxItemKind,
    summary: string,
    contextPayload: Record<string, unknown>,
  ): Promise<void>;
  createDirectTicket(input: DirectTicketInput): Promise<Ticket>;
  inspectWorktrees(repoId?: string): Promise<ManagedWorktreeItem[]>;
  gcWorktrees(options?: { repoId?: string }): Promise<WorktreeGcResult>;
}
