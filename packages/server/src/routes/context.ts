import type {
  ArtifactStore,
  CliScanReport,
  LifecycleHooksConfig,
  LlmProviderPreset,
  NotificationConfig,
  PublicSetupStatus,
  StateStore,
  SuperWorkKernel,
  SystemSetupConfig,
} from "@super-work/core";
import {
  CliEnvironmentScanner,
  DEFAULT_NOTIFICATION_CONFIG,
  MutableControlPlaneLLM,
  NotificationDispatcher,
  ServiceManager,
  sanitizeCliModelName,
} from "@super-work/drivers";
import type { Hono } from "hono";

export interface ServerRouteContext {
  app: Hono;
  kernel: SuperWorkKernel;
  stateStore: StateStore;
  artifactStore: ArtifactStore;
  scanner: CliEnvironmentScanner;
  notificationDispatcher: NotificationDispatcher;
  mutableLlm?: MutableControlPlaneLLM;
  getActiveProviderName: () => string;
  buildTicketDetail: (id: string) => Promise<Record<string, unknown> | null>;
  serviceManager: ServiceManager;
}

export function normalizeSetupModel(preset: LlmProviderPreset, model?: string): string {
  if (preset === "claude_cli" || preset === "codex_cli") {
    return sanitizeCliModelName(model) ?? "";
  }
  return model?.trim() ?? "";
}

export function maskApiKey(key?: string): string | undefined {
  const trimmed = key?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}****`;
  return `${trimmed.slice(0, 3)}****${trimmed.slice(-4)}`;
}

export function toPublicSetupStatus(
  savedConfig: SystemSetupConfig | null,
  scanReport: CliScanReport,
  activeLlmProvider: string,
): PublicSetupStatus {
  const cfg: SystemSetupConfig = savedConfig ?? {
    initialized: false,
    llmPreset: "deepseek",
    llmBaseUrl: "https://api.deepseek.com/v1",
    llmModel: "deepseek-chat",
    llmEffort: "low",
    preferredImplementEngine: scanReport.recommendedImplementEngine,
    preferredReviewEngine: scanReport.recommendedReviewEngine,
    claudeProfile: {},
    codexProfile: {},
    opencodeProfile: {},
    geminiProfile: {},
    notifications: { ...DEFAULT_NOTIFICATION_CONFIG },
    updatedAt: scanReport.scannedAt,
  };
  const { llmApiKey, notifications, ...rest } = cfg;
  const mergedNotifs: NotificationConfig = {
    ...DEFAULT_NOTIFICATION_CONFIG,
    ...(notifications ?? {}),
  };
  const { webhookSecret, actionSecret, githubWebhookSecret, ...notifRest } = mergedNotifs;
  return {
    initialized: cfg.initialized,
    activeLlmProvider,
    config: {
      ...rest,
      llmModel: normalizeSetupModel(cfg.llmPreset, rest.llmModel),
      hasApiKey: Boolean(llmApiKey?.trim()),
      maskedApiKey: maskApiKey(llmApiKey),
      notifications: {
        ...notifRest,
        hasWebhookSecret: Boolean(webhookSecret?.trim()),
        maskedWebhookSecret: maskApiKey(webhookSecret),
        hasActionSecret: Boolean(actionSecret?.trim()),
        maskedActionSecret: maskApiKey(actionSecret),
        hasGithubWebhookSecret: Boolean(githubWebhookSecret?.trim()),
        maskedGithubWebhookSecret: maskApiKey(githubWebhookSecret),
      },
    },
    scanReport,
  };
}

export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cleanHookList(val?: string[]): string[] | undefined {
  if (!Array.isArray(val)) return undefined;
  const cleaned = val.map((s) => String(s).trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : undefined;
}

export function normalizeHooksConfig(
  raw?: LifecycleHooksConfig | null,
): LifecycleHooksConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const preDeliver = cleanHookList(raw.preDeliver);
  const postDeliver = cleanHookList(raw.postDeliver);
  const onEscalate = cleanHookList(raw.onEscalate);
  const timeoutSec =
    typeof raw.timeoutSec === "number" && Number.isFinite(raw.timeoutSec) && raw.timeoutSec > 0
      ? Math.min(600, Math.max(5, Math.floor(raw.timeoutSec)))
      : undefined;
  if (!preDeliver && !postDeliver && !onEscalate && timeoutSec === undefined) {
    return undefined;
  }
  return {
    ...(preDeliver ? { preDeliver } : {}),
    ...(postDeliver ? { postDeliver } : {}),
    ...(onEscalate ? { onEscalate } : {}),
    ...(timeoutSec !== undefined ? { timeoutSec } : {}),
  };
}
