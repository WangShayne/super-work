import type {
  ApiWorkerProfile,
  EngineModelProfile,
  ModelProfile,
  PublicEngineProfile,
  PublicModelProfile,
  ReasoningEffort,
  WorkerEngineId,
} from "./engine.ts";
import type { TicketStatus } from "./pipeline.ts";

export interface NotificationConfig {
  macosEnabled: boolean;
  webhookEnabled: boolean;
  webhookUrl?: string;
  webhookSecret?: string;
  notifyOnInbox: boolean;
  notifyOnDelivery: boolean;
  notifyOnFailure: boolean;
  publicBaseUrl?: string;
  actionSecret?: string;
  githubWebhookSecret?: string;
  actionTtlMinutes?: number;
}

export interface DoctorCheckItem {
  id: string;
  category: "sqlite" | "worktree" | "preview" | "git_ref" | "code" | "playbook";
  status: "ok" | "warn" | "error";
  title: string;
  detail: string;
  fixable: boolean;
  fixed?: boolean;
  count?: number;
}

export interface CodeHotspotItem {
  filePath: string;
  lineCount: number;
  exportedSymbolCount: number;
  dependentCount: number;
  packageDir: string;
  repoId?: string;
}

export interface SystemDoctorReport {
  healthy: boolean;
  checkedAt: string;
  fixesApplied: number;
  items: DoctorCheckItem[];
  hotspots?: CodeHotspotItem[];
}

export interface BackupArchiveInfo {
  id: string;
  filename: string;
  filePath: string;
  byteSize: number;
  createdAt: string;
  dbIntegrityOk?: boolean;
}

export interface BackupRestoreResult {
  ok: boolean;
  restoredBackup: BackupArchiveInfo;
  preRestoreSafetyBackup?: BackupArchiveInfo;
  integrityDetail: string;
  restoredAt: string;
}

export type PreviewSessionStatus = "starting" | "ready" | "failed" | "stopped";

export interface PreviewSession {
  id: string;
  repoId: string;
  ticketId: string;
  candidateId?: string;
  label: string;
  worktreePath: string;
  command: string;
  port: number;
  url: string;
  status: PreviewSessionStatus;
  pid?: number;
  outputTail: string;
  error?: string;
  startedAt: string;
  expiresAt: string;
}

export interface ManagedWorktreeItem {
  path: string;
  ticketId?: string;
  ticketTitle?: string;
  ticketStatus?: TicketStatus;
  repoId?: string;
  repoName?: string;
  branchName?: string;
  reclaimable: boolean;
  isOrphan: boolean;
  activePreview?: PreviewSession;
}

export interface WorktreeGcResult {
  removedPaths: string[];
  cleanedTicketIds: string[];
  skippedActiveCount: number;
  timestamp: string;
}

export type CliToolId = "claude" | "codex" | "opencode" | "gemini" | "gh" | "git" | "bun";

export interface DetectedCliTool {
  id: CliToolId;
  name: string;
  installed: boolean;
  binaryPath?: string;
  version?: string;
  authenticated: boolean | null;
  authSummary?: string;
  localDefaultModel?: string;
  localDefaultEffort?: string;
  workerSupported: boolean;
}

export interface CliScanReport {
  scannedAt: string;
  tools: DetectedCliTool[];
  recommendedImplementEngine: WorkerEngineId;
  recommendedReviewEngine: WorkerEngineId;
}

export type LlmProviderPreset =
  | "deepseek"
  | "openai"
  | "custom"
  | "claude_cli"
  | "codex_cli"
  | "heuristic";

export interface SystemSetupConfig {
  initialized: boolean;
  llmPreset: LlmProviderPreset;
  llmBaseUrl: string;
  llmModel: string;
  llmEffort?: ReasoningEffort;
  llmApiKey?: string;
  preferredImplementEngine: WorkerEngineId;
  preferredReviewEngine: WorkerEngineId;
  claudeProfile?: EngineModelProfile;
  codexProfile?: EngineModelProfile;
  opencodeProfile?: EngineModelProfile;
  geminiProfile?: EngineModelProfile;
  apiWorkerProfile?: ApiWorkerProfile;
  /** v1.8.1 unified peer model registry. */
  modelProfiles?: ModelProfile[];
  /** 'heuristic' or a ModelProfile id. */
  controlModelId?: string;
  /** 'auto' or a ModelProfile id. */
  implementModelId?: string;
  /** 'auto' or a ModelProfile id. */
  reviewModelId?: string;
  notifications?: NotificationConfig;
  updatedAt: string;
}

export interface PublicSetupStatus {
  initialized: boolean;
  activeLlmProvider: string;
  config: Omit<
    SystemSetupConfig,
    | "llmApiKey"
    | "notifications"
    | "claudeProfile"
    | "codexProfile"
    | "opencodeProfile"
    | "geminiProfile"
    | "apiWorkerProfile"
    | "modelProfiles"
  > & {
    modelProfiles?: PublicModelProfile[];
    claudeProfile?: PublicEngineProfile<EngineModelProfile>;
    codexProfile?: PublicEngineProfile<EngineModelProfile>;
    opencodeProfile?: PublicEngineProfile<EngineModelProfile>;
    geminiProfile?: PublicEngineProfile<EngineModelProfile>;
    apiWorkerProfile?: PublicEngineProfile<ApiWorkerProfile>;
    hasApiKey: boolean;
    maskedApiKey?: string;
    notifications?: Omit<NotificationConfig, "webhookSecret" | "actionSecret" | "githubWebhookSecret"> & {
      hasWebhookSecret: boolean;
      maskedWebhookSecret?: string;
      hasActionSecret: boolean;
      maskedActionSecret?: string;
      hasGithubWebhookSecret: boolean;
      maskedGithubWebhookSecret?: string;
    };
  };
  scanReport: CliScanReport;
}

export interface ServiceDaemonStatus {
  platform: "darwin" | "linux" | "unsupported";
  manager: "launchd" | "systemd" | "none";
  installed: boolean;
  running: boolean;
  pid?: number;
  serviceFilePath?: string;
  dataDir: string;
  host: string;
  port: number;
  logFilePath: string;
  logByteSize?: number;
  webUiBuilt: boolean;
  detail: string;
}

export type SelfReloadPhase =
  | "idle"
  | "building"
  | "canary_probing"
  | "draining"
  | "reloading"
  | "rolled_back"
  | "failed";

export interface SelfReloadState {
  phase: SelfReloadPhase;
  selfRepoRoot?: string;
  ticketId?: string;
  commitSha?: string;
  revertCommitSha?: string;
  canaryPort?: number;
  canaryDurationMs?: number;
  activeRunsRemaining?: number;
  summary?: string;
  error?: string;
  updatedAt: string;
}

// --- Persistent Engine Circuit Breaker (v1.5.0 Direction A) ---
