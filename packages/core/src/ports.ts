import type {
  CodeHotspotItem,
  RefactorGuardConfig,
  ArenaCandidateResult,
  ArtifactKind,
  CampaignDirection,
  CasebookEntry,
  ChainOfRecall,
  ConflictFileHunk,
  ControlProbeRequest,
  ControlProbeStep,
  DagNodeMutationInput,
  DeliveryGatePolicy,
  EnginePreference,
  EpicDecompositionPlan,
  EpicDeliveryMode,
  EpicReplanProposal,
  EpicSubtaskSpec,
  EvalCase,
  EvalRunRecord,
  FlightEvent,
  GoalCampaign,
  GoalCampaignWave,
  Milestone,
  HandoverDigest,
  InboxItem,
  InboxItemStatus,
  Mandate,
  MemorySearchHit,
  MergeTrainEntry,
  MergeTrainEntryStatus,
  OutboxAction,
  OutboxEntry,
  OutboxStatus,
  PipelineTemplateId,
  PlaybookEntry,
  PreviewSession,
  ReasoningEffort,
  RepoConfig,
  RepoContractFile,
  RepoMetricsSummary,
  RepoProbeContextPack,
  RequirementIntakePlan,
  RestoreCheckpointInput,
  RevertResult,
  ReviewCommentStatus,
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
  TicketReviewComment,
  TicketStatus,
  TriageProposal,
  Trigger,
  VerificationRunResult,
  WatchdogDecision,
  WatchdogSignal,
  WorkerEngineId,
  WorkerStreamEvent,
  WorkerTurnInput,
  EngineHealthRecord,
} from "./types.ts";

export type RepoProbeExecutor = (req: ControlProbeRequest) => Promise<ControlProbeStep>;

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
    probeContext?: RepoProbeContextPack;
    probeExecutor?: RepoProbeExecutor;
  }): Promise<TriageProposal>;
  diagnoseWatchdog(input: {
    ticket: Ticket;
    stageRun: StageRun;
    signal: WatchdogSignal;
    recentEvents: WorkerStreamEvent[];
    availableEngines: WorkerEngineId[];
    probeContext?: RepoProbeContextPack;
    probeExecutor?: RepoProbeExecutor;
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
    probeContext?: RepoProbeContextPack;
    probeExecutor?: RepoProbeExecutor;
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
    probeContext?: RepoProbeContextPack;
    probeExecutor?: RepoProbeExecutor;
  }): Promise<SpecClarificationResult>;
  answerChiefQuestion?(input: {
    question: string;
    contextSummary: string;
    probeContext?: RepoProbeContextPack;
    probeExecutor?: RepoProbeExecutor;
  }): Promise<{ answer: string; highlights?: string[]; probeSteps?: ControlProbeStep[] }>;
  planRequirementIntake?(input: {
    repo: RepoConfig;
    title: string;
    requirement: string;
    defaultTemplate: PipelineTemplateId;
    defaultTddMode?: boolean;
    repoStructure?: string;
    playbookRules?: string;
    conventions?: string;
    availableRepos?: Array<{ id: string; name: string; structure?: string }>;
    probeContext?: RepoProbeContextPack;
    probeExecutor?: RepoProbeExecutor;
    metricHint?: {
      metricCommand?: string;
      targetValue?: number;
      direction?: CampaignDirection;
      metricUnit?: string;
      metricRegex?: string;
    };
  }): Promise<RequirementIntakePlan>;
}

export interface CanaryBootResult {
  ok: boolean;
  buildOk: boolean;
  canaryPort?: number;
  durationMs: number;
  summary: string;
  errorOutput?: string;
}

export interface SelfHostRunner {
  readonly selfRepoRoot: string;
  verifyBuildAndCanaryBoot(options?: {
    commitSha?: string;
    timeoutMs?: number;
  }): Promise<CanaryBootResult>;
  triggerProcessReload(reason: string): Promise<void>;
}

export interface WorkerDriver {
  readonly engine: WorkerEngineId;
  isAvailable(): Promise<boolean>;
  runTurn(input: WorkerTurnInput, signal: AbortSignal): AsyncGenerator<WorkerStreamEvent>;
}

export interface WorkspaceProvider {
  snapshotRepoDirtyPaths?(rootRepoPath: string): Promise<string[]>;
  quarantineRepoSpillover?(input: {
    rootRepoPath: string;
    preTurnDirtyPaths: string[];
  }): Promise<{ quarantinedPaths: string[]; diffSummary: string }>;
  ensureBranch(rootRepoPath: string, branchName: string, startPoint: string): Promise<void>;
  ensureBranchExists?(input: {
    rootRepoPath: string;
    branchName: string;
    baseBranch: string;
  }): Promise<void>;
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
  buildSurgicalContextPack?(input: {
    worktreePath: string;
    allowedPaths: string[];
    maxFiles?: number;
    maxChars?: number;
  }): Promise<string | undefined>;
  scanCodeHotspots?(rootRepoPath: string, thresholdLines?: number): Promise<CodeHotspotItem[]>;
  getDiffStat?(worktreePath: string, baseBranch: string): Promise<string>;
  verifyHotspotRefactorParity?(input: {
    worktreePath: string;
    baseBranch: string;
    targetHotspotPath: string;
    maxLinesAfter: number;
    enforceExportParity: boolean;
  }): Promise<{
    ok: boolean;
    linesBefore: number;
    linesAfter: number;
    missingExports: string[];
    summary: string;
  }>;
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
  resolveScopedVerification?(input: {
    rootRepoPath: string;
    worktreePath: string;
    baseBranch: string;
    fullCommands: string[];
    sensitivePaths?: string[];
  }): Promise<{
    useScoped: boolean;
    commands: string[];
    estimatedSavedMs: number;
    reason: string;
  }>;
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
  listCheckpointRefs?(rootRepoPath: string): Promise<Array<{ ref: string; ticketId: string }>>;
  deleteGitRef?(rootRepoPath: string, ref: string): Promise<boolean>;
  prepareThreeWayConflictWorkspace?(input: {
    worktreePath: string;
    rootRepoPath: string;
    baseBranch: string;
  }): Promise<{
    mergeBaseSha: string;
    upstreamCommitSummaries: string[];
    conflictFiles: string[];
    fileHunks: ConflictFileHunk[];
  }>;
  revertPaths(worktreePath: string, paths: string[]): Promise<void>;
  deleteBranch?(rootRepoPath: string, branchName: string): Promise<void>;
  listWorktreeDirs(): Promise<string[]>;
  cleanupWorkspace(worktreePath: string, rootRepoPath?: string): Promise<void>;

  // Read-only Repo Probes & Golden Eval Worktrees (v1.1.0 A.1 / D.1)
  runRepoPreProbe?(
    rootRepoPath: string,
    queryText: string,
    forbiddenPaths?: string[],
  ): Promise<RepoProbeContextPack>;
  executeRepoProbeTool?(
    rootRepoPath: string,
    req: ControlProbeRequest,
    forbiddenPaths?: string[],
    stepIndex?: number,
  ): Promise<ControlProbeStep>;
  prepareDetachedWorktree?(
    rootRepoPath: string,
    commitSha: string,
    label: string,
  ): Promise<{ worktreePath: string }>;
  getWorktreeNumstat?(
    worktreePath: string,
    baseRef: string,
  ): Promise<{ addedLines: number; deletedLines: number; changedFiles: string[] }>;

  // Deterministic Lifecycle Hooks, Goal Campaigns & Speculative Merge Train (v1.2.0)
  runLifecycleHooks?(input: {
    cwd: string;
    commands: string[];
    timeoutSec?: number;
    hookEnv: Record<string, string>;
  }): Promise<VerificationRunResult>;
  measureMetricAtRef?(input: {
    rootRepoPath: string;
    gitRef: string;
    metricCommand: string;
    timeoutSec?: number;
    sandboxMode?: SandboxMode;
    forbiddenPaths?: string[];
  }): Promise<{ ok: boolean; rawOutput: string; exitCode: number; durationMs: number }>;
  executeMilestoneRelease?(input: {
    rootRepoPath: string;
    baseBranch: string;
    targetVersion?: string;
    bumpVersion: boolean;
    createTag: boolean;
    pushRemote: boolean;
    releaseNotes?: string;
    stagingBranch?: string;
    squashReleaseCommit?: boolean;
    releaseCommitMessage?: string;
  }): Promise<{
    commitSha?: string;
    tag?: string;
    bumpedFiles: string[];
    pushed: boolean;
    squashed?: boolean;
  }>;
  resetBranchRef?(rootRepoPath: string, branchName: string, targetCommitSha: string): Promise<void>;
  prepareSpeculativeMergeSlot?(input: {
    rootRepoPath: string;
    baseCommitSha: string;
    branchName: string;
    commitMessage: string;
    slotLabel: string;
  }): Promise<{ ok: boolean; worktreePath: string; mergedCommitSha?: string; conflictSummary?: string }>;
  fastForwardBranchToCommit?(input: {
    rootRepoPath: string;
    baseBranch: string;
    targetCommitSha: string;
    cleanupWorktrees?: string[];
    deleteBranches?: string[];
  }): Promise<string>;
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
  claimNextOutboxEntries(
    limit: number,
    nowIso: string,
    excludeActions?: OutboxAction[],
  ): Promise<OutboxEntry[]>;
  requeueInterruptedOutboxEntries(nowIso: string): Promise<number>;
  checkpointWal?(): Promise<void> | void;

  // Flight Recorder (Direction D)
  saveEngineHealth?(record: EngineHealthRecord): Promise<void>;
  getEngineHealth?(engine: WorkerEngineId): Promise<EngineHealthRecord | null>;
  listEngineHealth?(): Promise<EngineHealthRecord[]>;
  recordFlightEvent?(event: FlightEvent): Promise<void>;
  listFlightEvents?(filter?: {
    repoId?: string;
    limit?: number;
    sinceIso?: string;
  }): Promise<FlightEvent[]>;

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

  // Line-Anchored Review Comments (v1.0.0 B.1)
  listReviewComments(ticketId: string): Promise<TicketReviewComment[]>;
  saveReviewComment(comment: TicketReviewComment): Promise<void>;
  updateReviewCommentStatus(
    id: string,
    status: ReviewCommentStatus,
    updatedAt: string,
  ): Promise<TicketReviewComment | null>;

  // System Maintenance (v1.0.0 C.1 + v1.1.0 D.1)
  checkDatabaseIntegrity?(): Promise<{ ok: boolean; detail: string; walPages?: number }>;
  vacuumIntoBackup?(destFilePath: string): Promise<void>;
  restoreFromBackup?(backupFilePath: string): Promise<{ ok: boolean; detail: string }>;

  // Golden Eval Suite (v1.1.0 D.1)
  saveEvalCase?(evalCase: EvalCase): Promise<void>;
  getEvalCase?(id: string): Promise<EvalCase | null>;
  listEvalCases?(repoId?: string): Promise<EvalCase[]>;
  deleteEvalCase?(id: string): Promise<boolean>;
  saveEvalRun?(run: EvalRunRecord): Promise<void>;
  getEvalRun?(id: string): Promise<EvalRunRecord | null>;
  listEvalRuns?(filter?: { repoId?: string; evalCaseId?: string; limit?: number }): Promise<EvalRunRecord[]>;

  // System Settings
  getSystemSetting<T>(key: string): Promise<T | null>;
  setSystemSetting<T>(key: string, value: T): Promise<void>;

  // Goal Campaigns (v1.2.0 Pillar A)
  saveCampaign?(campaign: GoalCampaign): Promise<void>;
  getCampaign?(id: string): Promise<GoalCampaign | null>;
  listCampaigns?(repoId?: string): Promise<GoalCampaign[]>;
  deleteCampaign?(id: string): Promise<boolean>;
  // Milestones (v1.4.0 Direction B)
  saveMilestone?(milestone: Milestone): Promise<void>;
  getMilestone?(id: string): Promise<Milestone | null>;
  listMilestones?(repoId?: string): Promise<Milestone[]>;
  saveCampaignWave?(wave: GoalCampaignWave): Promise<void>;
  listCampaignWaves?(campaignId: string): Promise<GoalCampaignWave[]>;

  // Speculative Merge Train (v1.2.0 Pillar B)
  saveMergeTrainEntry?(entry: MergeTrainEntry): Promise<void>;
  getMergeTrainEntry?(id: string): Promise<MergeTrainEntry | null>;
  listMergeTrainEntries?(filter?: {
    repoId?: string;
    barrierGroupId?: string;
    status?: MergeTrainEntryStatus;
  }): Promise<MergeTrainEntry[]>;
  nextMergeTrainPosition?(repoId: string): Promise<number>;
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
  refactorGuard?: RefactorGuardConfig;
  pauseBeforeRun?: boolean;
  blueprintId?: string;
  deliveryGatePolicy?: DeliveryGatePolicy;
  riskThreshold?: number;
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
  campaignId?: string;
  milestoneId?: string;
  campaignWave?: number;
  targetBranch?: string;
  barrierGroupId?: string;
}

export interface CreateEpicInput {
  repoId: string;
  title: string;
  description: string;
  template?: PipelineTemplateId;
  tddMode?: boolean;
  epicDeliveryMode?: EpicDeliveryMode;
  releaseBarrier?: boolean;
  barrierGroupId?: string;
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
