export type SmokeTriggerMode = "every_gate" | "delivery_only";

export type SandboxMode = "off" | "balanced" | "strict";

export type VerificationStrategy = "always_full" | "impact_scoped";

export type VisualDiffMode = "off" | "auto" | "enforce" | "informational";

export interface BrowserInteractionStep {
  action: "click" | "fill" | "press" | "waitForSelector" | "waitForText";
  selector?: string;
  value?: string;
  timeoutMs?: number;
}

export interface BrowserCheckConfig {
  enabled: boolean;
  paths?: string[];
  viewportWidth?: number;
  viewportHeight?: number;
  waitForSelector?: string;
  failOnConsoleError?: boolean;
  timeoutMs?: number;
  steps?: BrowserInteractionStep[];
  visualDiffMode?: VisualDiffMode;
  maxVisualDiffRatio?: number;
}

export interface BrowserRouteCheckResult {
  path: string;
  url: string;
  ok: boolean;
  status?: number;
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  stepErrors?: string[];
  missingSelector?: string;
  screenshotArtifactId?: string;
  diffRatio?: number;
  visualDiffArtifactId?: string;
  baselineMatched?: boolean;
  durationMs: number;
}

export interface BrowserCheckSummary {
  executed: boolean;
  skippedReason?: string;
  ok: boolean;
  routes: BrowserRouteCheckResult[];
  summary: string;
}

export interface SmokeCheckConfig {
  enabled: boolean;
  startCommand: string;
  readyUrl?: string;
  startupTimeoutSec?: number;
  checkCommands?: string[];
  triggerMode?: SmokeTriggerMode;
  browserCheck?: BrowserCheckConfig;
}

export interface SmokeCheckResult {
  ok: boolean;
  port: number;
  readyUrl: string;
  startupDurationMs: number;
  probeStatus?: number;
  checkResults: VerificationCommandOutput[];
  serverOutputTail: string;
  failedStep?: string;
  summary: string;
  browserResult?: BrowserCheckSummary;
  rawScreenshots?: Array<{ routeIndex: number; path: string; bytes: Uint8Array }>;
  rawVisualDiffs?: Array<{ routeIndex: number; path: string; diffRatio: number; bytes: Uint8Array }>;
}

export interface VerificationCommandOutput {
  command: string;
  exitCode: number;
  durationMs: number;
  output: string;
}

export interface ScopedVerificationInfo {
  usedScoped: boolean;
  commandsRun: string[];
  skippedFullCommands?: string[];
  estimatedSavedMs?: number;
  reason: string;
}

export interface VerificationRunResult {
  ok: boolean;
  results: VerificationCommandOutput[];
  failedCommand?: string;
  summary: string;
  smokeResult?: SmokeCheckResult;
  scopedVerification?: ScopedVerificationInfo;
}

export type LifecycleHookEvent = "pre_deliver" | "post_deliver" | "on_escalate";

export interface LifecycleHooksConfig {
  preDeliver?: string[];
  postDeliver?: string[];
  onEscalate?: string[];
  timeoutSec?: number;
}

export interface HookExecutionRecord {
  event: LifecycleHookEvent;
  ok: boolean;
  results: VerificationCommandOutput[];
  failedCommand?: string;
  summary: string;
  executedAt: string;
}
