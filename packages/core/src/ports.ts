import type {
  ArtifactKind,
  ChainOfRecall,
  InboxItem,
  InboxItemStatus,
  Mandate,
  MemorySearchHit,
  OutboxEntry,
  OutboxStatus,
  RepoConfig,
  SpillArtifact,
  StageKind,
  StageRun,
  Thread,
  Ticket,
  TicketStatus,
  TriageProposal,
  Trigger,
  WatchdogDecision,
  WatchdogSignal,
  WorkerEngineId,
  WorkerStreamEvent,
  WorkerTurnInput,
} from "./types.ts";

export interface ControlPlaneLLM {
  readonly providerName: string;
  triageTrigger(input: {
    repo: RepoConfig;
    trigger: Trigger;
    activeTickets: Ticket[];
    relatedMemory: MemorySearchHit[];
  }): Promise<TriageProposal>;
  diagnoseWatchdog(input: {
    ticket: Ticket;
    stageRun: StageRun;
    signal: WatchdogSignal;
    recentEvents: WorkerStreamEvent[];
    availableEngines: WorkerEngineId[];
  }): Promise<WatchdogDecision>;
}

export interface WorkerDriver {
  readonly engine: WorkerEngineId;
  isAvailable(): Promise<boolean>;
  runTurn(input: WorkerTurnInput, signal: AbortSignal): AsyncGenerator<WorkerStreamEvent>;
}

export interface WorkspaceProvider {
  prepareWorkspace(ticket: Ticket, repo: RepoConfig): Promise<{ worktreePath: string; branchName: string }>;
  getChangedFiles(worktreePath: string, baseBranch: string): Promise<string[]>;
  getDiff(worktreePath: string, baseBranch: string): Promise<string>;
  commitAll(worktreePath: string, message: string): Promise<boolean>;
  rebaseOntoBase(worktreePath: string, baseBranch: string): Promise<{ ok: boolean; conflictSummary?: string }>;
  revertPaths(worktreePath: string, paths: string[]): Promise<void>;
  cleanupWorkspace(worktreePath: string, rootRepoPath?: string): Promise<void>;
}

export interface StateStore {
  // Repos
  upsertRepo(repo: RepoConfig): Promise<void>;
  getRepo(id: string): Promise<RepoConfig | null>;
  listRepos(): Promise<RepoConfig[]>;

  // Triggers & Threads
  saveTrigger(trigger: Trigger): Promise<void>;
  getTrigger(id: string): Promise<Trigger | null>;
  findTriggerByExternalRef(repoId: string, externalRef: string): Promise<Trigger | null>;
  listTriggersByThread(threadId: string): Promise<Trigger[]>;
  upsertThread(thread: Thread): Promise<void>;
  getThread(id: string): Promise<Thread | null>;
  getThreadByKey(repoId: string, threadKey: string): Promise<Thread | null>;

  // Tickets
  saveTicket(ticket: Ticket): Promise<void>;
  getTicket(id: string): Promise<Ticket | null>;
  listTickets(filter?: { repoId?: string; status?: TicketStatus }): Promise<Ticket[]>;
  listActiveTickets(repoId: string): Promise<Ticket[]>;

  // StageRuns & Spill Artifacts
  saveStageRun(stageRun: StageRun): Promise<void>;
  getStageRun(id: string): Promise<StageRun | null>;
  listStageRuns(ticketId: string): Promise<StageRun[]>;
  saveArtifact(artifact: SpillArtifact, indexBody?: string): Promise<void>;
  getArtifact(id: string): Promise<SpillArtifact | null>;
  listArtifacts(ticketId: string): Promise<SpillArtifact[]>;

  // Inbox
  saveInboxItem(item: InboxItem): Promise<void>;
  getInboxItem(id: string): Promise<InboxItem | null>;
  listInboxItems(filter?: { repoId?: string; status?: InboxItemStatus; ticketId?: string }): Promise<InboxItem[]>;

  // Transactional Outbox
  enqueueOutbox(entry: OutboxEntry): Promise<void>;
  getOutboxEntry(id: string): Promise<OutboxEntry | null>;
  listOutboxEntries(filter?: { repoId?: string; ticketId?: string; status?: OutboxStatus }): Promise<OutboxEntry[]>;
  updateOutboxEntry(entry: OutboxEntry): Promise<void>;
  claimNextOutboxEntries(limit: number, nowIso: string): Promise<OutboxEntry[]>;

  // Memory & Chain of Recall
  indexMemoryDocument(doc: {
    entityType: string;
    entityId: string;
    ticketId: string;
    repoId: string;
    title: string;
    body: string;
  }): Promise<void>;
  searchMemory(query: string, limit?: number, repoId?: string): Promise<MemorySearchHit[]>;
  recallChain(ticketId: string): Promise<ChainOfRecall | null>;
}

export interface ArtifactStore {
  writeSpill(
    meta: { ticketId: string; stageRunId?: string; kind: ArtifactKind; summary: string; ext?: string },
    content: string,
  ): Promise<SpillArtifact>;
  readSpill(storageUri: string): Promise<string>;
}

export interface OutboxExecutor {
  execute(
    entry: OutboxEntry,
    repo: RepoConfig,
    ticket: Ticket,
  ): Promise<Record<string, unknown>>;
}

export interface DirectTicketInput {
  repoId: string;
  title: string;
  description: string;
  template?: RepoConfig["defaultTemplate"];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  maxCostUsd?: number;
  maxDurationSec?: number;
  preferredEngine?: WorkerEngineId;
  acceptanceCriteria?: string[];
  threadKey?: string;
}

export interface IngestTriggerInput {
  repoId: string;
  source: Trigger["source"];
  externalRef?: string;
  threadKey: string;
  title: string;
  rawText: string;
  payload?: Record<string, unknown>;
}

export interface WatchdogConfig {
  silenceTimeoutMs: number;
  repeatedErrorThreshold: number;
  oscillationWindow: number;
  budgetBurnWarningRatio: number;
  pollIntervalMs: number;
}

export interface KernelConfig {
  maxConcurrentWorkers: number;
  schedulerIntervalMs: number;
  outboxIntervalMs: number;
  outboxMaxAttempts: number;
  watchdog: WatchdogConfig;
}
