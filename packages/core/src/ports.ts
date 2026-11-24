import type {
  ArenaCandidateResult,
  ArtifactKind,
  CasebookEntry,
  ChainOfRecall,
  DagNodeMutationInput,
  EnginePreference,
  EpicDecompositionPlan,
  EpicDeliveryMode,
  EpicReplanProposal,
  EpicSubtaskSpec,
  HandoverDigest,
  InboxItem,
  InboxItemStatus,
  Mandate,
  MemorySearchHit,
  OutboxEntry,
  OutboxStatus,
  PipelineTemplateId,
  PlaybookEntry,
  PreviewSession,
  ReasoningEffort,
  RepoConfig,
  RepoContractFile,
  RepoMetricsSummary,
  RestoreCheckpointInput,
  RevertResult,
  RoutineRun,
  RoutineSpec,
  SandboxMode,
  SmokeCheckConfig,
  SmokeCheckResult,
  SpecClarificationResult,
  SpillArtifact,
  StageKind,
  StageRun,
  SymbolImpactReport,
  Thread,
  Ticket,
  TicketCheckpoint,
  TicketStatus,
  TriageProposal,
  Trigger,
  VerificationRunResult,
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
    repoStructure?: string;
    playbookRules?: string;
    conventions?: string;
  }): Promise<TriageProposal>;
  diagnoseWatchdog(input: {
    ticket: Ticket;
    stageRun: StageRun;
    signal: WatchdogSignal;
    recentEvents: WorkerStreamEvent[];
    availableEngines: WorkerEngineId[];
  }): Promise<WatchdogDecision>;
  planEpicDecomposition?(input: {
    repo: RepoConfig;
    title: string;
    description: string;
    defaultTemplate: PipelineTemplateId;
    repoStructure?: string;
    playbookRules?: string;
    conventions?: string;
    availableRepos?: Array<{ id: string; name: string; structure?: string }>;
  }): Promise<EpicDecompositionPlan>;
  distillPlaybookLesson?(input: {
    repo: RepoConfig;
    ticket: Ticket;
    failureKind: "verification" | "smoke" | "review";
    failureSummary: string;
    fixSummary: string;
    changedFiles: string[];
  }): Promise<{ rule: string; scopePaths: string[] } | null>;
  distillHandoverDigest?(input: {
    repo: RepoConfig;
    ticket: Ticket;
    changedFiles: string[];
    exportedSymbols: string[];
    contractSnippets: string[];
    diffExcerpt: string;
    stageSummary: string;
  }): Promise<{
    summary: string;
    exportedSymbols?: string[];
    contractSnippets?: string[];
  } | null>;
  proposeEpicReplan?(input: {
    repo: RepoConfig;
    epic: Ticket;
    completedSubtask: Ticket;
    digest: HandoverDigest;
    unstartedSubtasks: Ticket[];
    allSubtasks: Ticket[];
  }): Promise<EpicReplanProposal | null>;
  judgeArenaCandidates?(input: {
    repo: RepoConfig;
    ticket: Ticket;
    candidates: ArenaCandidateResult[];
  }): Promise<{ winnerCandidateId: string; rationale: string } | null>;
  clarifySpec?(input: {
    repo: RepoConfig;
    title: string;
    description: string;
    defaultTemplate: PipelineTemplateId;
    repoStructure?: string;
    playbookRules?: string;
    casebookContext?: string;
    conventions?: string;
  }): Promise<SpecClarificationResult>;
}

export interface WorkerDriver {
  readonly engine: WorkerEngineId;
  isAvailable(): Promise<boolean>;
  runTurn(input: WorkerTurnInput, signal: AbortSignal): AsyncGenerator<WorkerStreamEvent>;
}

export interface WorkspaceProvider {
  ensureBranch(rootRepoPath: string, branchName: string, startPoint: string): Promise<void>;
  prepareWorkspace(
    ticket: Ticket,
    repo: RepoConfig,
    options?: { startPoint?: string },
  ): Promise<{ worktreePath: string; branchName: string }>;
  integrateDependencyBranches(worktreePath: string, branchNames: string[]): Promise<void>;
  getChangedFiles(worktreePath: string, baseBranch: string): Promise<string[]>;
  getDiff(worktreePath: string, baseBranch: string): Promise<string>;
  getBranchDiff(rootRepoPath: string, baseBranch: string, branchName: string): Promise<string>;
  getRepoStructureSummary?(rootRepoPath: string): Promise<string>;
  runVerificationCommands(
    worktreePath: string,
    commands: string[],
    timeoutSec?: number,
    options?: {
      env?: NodeJS.ProcessEnv;
      sandboxMode?: SandboxMode;
      forbiddenPaths?: string[];
      readOnlyPaths?: string[];
      allowNetwork?: boolean;
      rootRepoPath?: string;
    },
  ): Promise<VerificationRunResult>;
  runSmokeCheck?(
    worktreePath: string,
    config: SmokeCheckConfig,
    options?: {
      baselineScreenshotsDir?: string;
      resolveBaselineScreenshotsDir?: () => Promise<string | undefined>;
    },
  ): Promise<SmokeCheckResult>;
  commitAll(worktreePath: string, message: string): Promise<boolean>;
  rebaseOntoBase(worktreePath: string, baseBranch: string): Promise<{ ok: boolean; conflictSummary?: string }>;
  mergeBranchToBase(input: {
    rootRepoPath: string;
    baseBranch: string;
    branchName: string;
    worktreePath?: string;
    commitMessage: string;
    deleteBranch?: boolean;
    noFf?: boolean;
  }): Promise<{ commitSha: string; beforeSha?: string; isMergeCommit?: boolean; branchCleaned: boolean }>;
  revertMergedCommit(input: {
    rootRepoPath: string;
    baseBranch: string;
    commitSha: string;
  }): Promise<RevertResult>;
  loadRepoContract?(
    rootRepoPath: string,
  ): Promise<{ contract: RepoContractFile; rawHash: string; filePath: string } | null>;
  writeRepoContract?(
    rootRepoPath: string,
    contract: RepoContractFile,
  ): Promise<{ filePath: string; rawHash: string }>;
  analyzeSymbolImpact?(rootRepoPath: string, scopePatterns: string[]): Promise<SymbolImpactReport>;
  getChangedFilesSince?(worktreePath: string, refOrSha: string): Promise<string[]>;
  revertPathsToCommit?(worktreePath: string, commitSha: string, paths: string[]): Promise<void>;
  getHeadCommitSha?(repoOrWorktreePath: string, rev?: string): Promise<string>;
  captureWorktreeCheckpoint?(input: {
    worktreePath: string;
    ticketId: string;
    checkpointId: string;
    label: string;
  }): Promise<{ gitRef: string; commitSha: string }>;
  restoreWorktreeCheckpoint?(input: {
    worktreePath: string;
    rootRepoPath: string;
    commitSha: string;
  }): Promise<void>;
  getCommitDiff?(repoOrWorktreePath: string, fromSha: string, toSha: string): Promise<string>;
  cleanupTicketCheckpoints?(rootRepoPath: string, ticketId: string): Promise<number>;
  revertPaths(worktreePath: string, paths: string[]): Promise<void>;
  deleteBranch?(rootRepoPath: string, branchName: string): Promise<void>;
  listWorktreeDirs(): Promise<string[]>;
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
  requeueInterruptedOutboxEntries(nowIso: string): Promise<number>;

  // Daily Budget & Metrics
  getDailyRepoSpendUsd(repoId: string, utcDatePrefix: string): Promise<number>;
  getMetricsSummary(repoId?: string, utcDatePrefix?: string): Promise<RepoMetricsSummary>;

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

  // Playbook
  savePlaybookEntry(entry: PlaybookEntry): Promise<void>;
  getPlaybookEntry(id: string): Promise<PlaybookEntry | null>;
  listPlaybookEntries(repoId: string, options?: { onlyEnabled?: boolean }): Promise<PlaybookEntry[]>;
  deletePlaybookEntry(id: string): Promise<boolean>;
  recordPlaybookHits(ids: string[], matchedAt: string): Promise<void>;

  // Routines (A.1)
  saveRoutine(routine: RoutineSpec): Promise<void>;
  getRoutine(id: string): Promise<RoutineSpec | null>;
  listRoutines(repoId?: string): Promise<RoutineSpec[]>;
  deleteRoutine(id: string): Promise<boolean>;
  saveRoutineRun(run: RoutineRun): Promise<void>;
  listRoutineRuns(filter?: { repoId?: string; routineId?: string; limit?: number }): Promise<RoutineRun[]>;

  // Casebook (C.2)
  saveCasebookEntry(entry: CasebookEntry): Promise<void>;
  getCasebookEntry(id: string): Promise<CasebookEntry | null>;
  getCasebookEntryByTicket(ticketId: string): Promise<CasebookEntry | null>;
  listCasebookEntries(repoId: string, options?: { includeReverted?: boolean }): Promise<CasebookEntry[]>;
  deleteCasebookEntry(id: string): Promise<boolean>;
  recordCasebookHits(ids: string[], matchedAt: string): Promise<void>;

  // Worktree Checkpoints (D.2)
  saveCheckpoint(checkpoint: TicketCheckpoint): Promise<void>;
  getCheckpoint(id: string): Promise<TicketCheckpoint | null>;
  listCheckpoints(ticketId: string): Promise<TicketCheckpoint[]>;
  markCheckpointsCleaned(ticketId: string, cleanedAt: string): Promise<void>;

  // System Settings
  getSystemSetting<T>(key: string): Promise<T | null>;
  setSystemSetting<T>(key: string, value: T): Promise<void>;
}

export interface ArtifactStore {
  writeSpill(
    meta: { ticketId: string; stageRunId?: string; kind: ArtifactKind; summary: string; ext?: string },
    content: string,
  ): Promise<SpillArtifact>;
  readSpill(storageUri: string): Promise<string>;
  writeBinarySpill?(
    meta: { ticketId: string; stageRunId?: string; kind: ArtifactKind; summary: string; ext?: string },
    data: Uint8Array,
  ): Promise<SpillArtifact>;
  readBinarySpill?(storageUri: string): Promise<Uint8Array>;
}

export interface PreviewProvider {
  subscribe?(listener: (session: PreviewSession) => void): () => void;
  startPreview(input: {
    repoId: string;
    ticketId: string;
    candidateId?: string;
    label: string;
    worktreePath: string;
    command: string;
    ttlMinutes?: number;
  }): Promise<PreviewSession>;
  stopPreview(previewId: string): Promise<PreviewSession | null>;
  stopPreviewsForTicket(ticketId: string): Promise<number>;
  renewPreview(previewId: string, ttlMinutes?: number): Promise<PreviewSession | null>;
  listPreviews(repoId?: string): Promise<PreviewSession[]>;
  stopAll(): Promise<void>;
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
  tddMode?: boolean;
  pauseBeforeRun?: boolean;
  startPoint?: string;
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  dependsOn?: string[];
  maxCostUsd?: number;
  maxDurationSec?: number;
  preferredEngine?: EnginePreference;
  arenaMode?: boolean;
  arenaCompetitorEngine?: WorkerEngineId;
  modelOverride?: string;
  effortOverride?: ReasoningEffort;
  acceptanceCriteria?: string[];
  threadKey?: string;
}

export interface CreateEpicInput {
  repoId: string;
  title: string;
  description: string;
  template?: PipelineTemplateId;
  tddMode?: boolean;
  epicDeliveryMode?: EpicDeliveryMode;
  preferredEngine?: EnginePreference;
  modelOverride?: string;
  effortOverride?: ReasoningEffort;
  maxCostUsdPerSubtask?: number;
  subtasks?: EpicSubtaskSpec[];
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
