import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type {
  EnginePreference,
  InboxItem,
  OutboxEntry,
  PipelineTemplateId,
  StageKind,
  TicketStatus,
  WorkerEngineId,
} from "./types.ts";
import { en } from "./locales/en.ts";
import { zh } from "./locales/zh.ts";

export type Locale = "zh" | "en";

const STORAGE_KEY = "super-work:locale";

const MESSAGES = { zh, en } as const;

export type TranslationKey = keyof typeof MESSAGES.zh;

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  toggleLocale: () => void;
  t: (key: TranslationKey) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function readInitialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    // Ignore storage access errors
  }
  return "zh";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(readInitialLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Ignore storage access errors
    }
  }, []);

  const toggleLocale = useCallback(() => {
    setLocale(locale === "zh" ? "en" : "zh");
  }, [locale, setLocale]);

  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
    document.title = MESSAGES[locale]["app.title"];
  }, [locale]);

  const t = useCallback((key: TranslationKey): string => MESSAGES[locale][key], [locale]);

  return (
    <I18nContext.Provider value={{ locale, setLocale, toggleLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used inside I18nProvider");
  }
  return ctx;
}

const TICKET_STATUS_LABELS: Record<TicketStatus, { zh: string; en: string }> = {
  triaging: { zh: "评估中", en: "triaging" },
  proposed: { zh: "拟单待批", en: "proposed" },
  queued: { zh: "排队中", en: "queued" },
  waiting_deps: { zh: "等待依赖", en: "waiting_deps" },
  planning: { zh: "规划中", en: "planning" },
  spec_testing: { zh: "编写测试锁", en: "spec_testing" },
  awaiting_plan_approval: { zh: "待批方案", en: "awaiting_plan_approval" },
  implementing: { zh: "编码实现", en: "implementing" },
  reviewing: { zh: "交叉审查", en: "reviewing" },
  rebasing: { zh: "变基验证", en: "rebasing" },
  watchdog_intervention: { zh: "看门狗介入", en: "watchdog_intervention" },
  needs_human: { zh: "待人工介入", en: "needs_human" },
  outbox_pending: { zh: "待发件交付", en: "outbox_pending" },
  delivered: { zh: "已交付", en: "delivered" },
  failed: { zh: "已失败", en: "failed" },
  cancelled: { zh: "已取消", en: "cancelled" },
};

const STAGE_LABELS: Record<StageKind, { zh: string; en: string }> = {
  plan: { zh: "规划 (plan)", en: "plan" },
  spec_test: { zh: "测试锁 (spec_test)", en: "spec_test" },
  implement: { zh: "实现 (implement)", en: "implement" },
  review: { zh: "审查 (review)", en: "review" },
  rebase: { zh: "变基 (rebase)", en: "rebase" },
};

const TEMPLATE_LABELS: Record<PipelineTemplateId, { zh: string; en: string }> = {
  fast: { zh: "fast · 快速修复", en: "fast" },
  standard: { zh: "standard · 标准流程", en: "standard" },
  strict: { zh: "strict · 严格门禁", en: "strict" },
};

const INBOX_KIND_LABELS: Record<InboxItem["kind"], { zh: string; en: string }> = {
  mandate_violation: { zh: "越界授权拦截", en: "MANDATE VIOLATION" },
  watchdog_escalation: { zh: "看门狗升级告警", en: "WATCHDOG ESCALATION" },
  merge_conflict: { zh: "合并冲突待解", en: "MERGE CONFLICT" },
  plan_approval: { zh: "方案审批门禁", en: "PLAN APPROVAL" },
  outbox_signoff: { zh: "PR 交付签发", en: "PR SIGNOFF" },
  observe_proposal: { zh: "观察模式拟单", en: "OBSERVE PROPOSAL" },
  budget_cap: { zh: "每日预算触顶", en: "BUDGET CAP" },
  pr_followup: { zh: "PR 评审/CI 返修", en: "PR FOLLOW-UP" },
  arena_tiebreak: { zh: "Arena 双引擎竞速择优", en: "ARENA TIE-BREAK" },
  epic_replan: { zh: "Epic 自适应重规划审批", en: "EPIC RE-PLAN" },
  clarification_request: { zh: "Worker 设计歧义提问", en: "CLARIFICATION" },
  campaign_paused: { zh: "目标战役熔断暂停", en: "CAMPAIGN PAUSED" },
  milestone_ready: { zh: "里程碑待发布", en: "MILESTONE READY" },
};

const INBOX_STATUS_LABELS: Record<InboxItem["status"], { zh: string; en: string }> = {
  pending: { zh: "待处理", en: "PENDING" },
  approved: { zh: "已批准", en: "APPROVED" },
  rejected: { zh: "已驳回", en: "REJECTED" },
};

const OUTBOX_STATUS_LABELS: Record<OutboxEntry["status"], { zh: string; en: string }> = {
  awaiting_approval: { zh: "待签发", en: "awaiting_approval" },
  pending: { zh: "待投递", en: "pending" },
  processing: { zh: "投递中", en: "processing" },
  sent: { zh: "已投递", en: "sent" },
  failed: { zh: "投递失败", en: "failed" },
  cancelled: { zh: "已取消", en: "cancelled" },
};

export function formatTicketStatus(status: TicketStatus, locale: Locale): string {
  return TICKET_STATUS_LABELS[status][locale];
}

export function formatStage(stage: StageKind, locale: Locale): string {
  return STAGE_LABELS[stage][locale];
}

export function formatTemplate(template: PipelineTemplateId, locale: Locale): string {
  return TEMPLATE_LABELS[template][locale];
}

export function formatInboxKind(kind: InboxItem["kind"], locale: Locale): string {
  return INBOX_KIND_LABELS[kind][locale];
}

export function formatInboxStatus(status: InboxItem["status"], locale: Locale): string {
  return INBOX_STATUS_LABELS[status][locale];
}

export function formatOutboxStatus(status: OutboxEntry["status"], locale: Locale): string {
  return OUTBOX_STATUS_LABELS[status][locale];
}

export function formatEngineDisplayName(engine: EnginePreference, locale: Locale): string {
  switch (engine) {
    case "auto":
      return locale === "zh" ? "Auto Bandit" : "Auto Bandit";
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "opencode":
      return "OpenCode";
    case "gemini":
      return "Gemini CLI";
    case "api":
      return locale === "zh" ? "API 直连 Worker" : "API Worker";
    case "mock":
      return locale === "zh" ? "Mock 演练" : "Mock";
  }
}

export function formatLlmProviderDisplay(rawProvider: string | undefined, locale: Locale): string {
  if (!rawProvider) {
    return locale === "zh" ? "未检测" : "Unknown";
  }
  if (rawProvider === "heuristic:local") {
    return locale === "zh" ? "本地规则 (免配置)" : "Local Heuristic";
  }
  if (rawProvider === "cli:claude-restricted" || rawProvider.startsWith("cli:claude")) {
    return rawProvider.includes("(") ? rawProvider.replace("cli:claude", "Claude CLI ") : "Claude CLI";
  }
  if (rawProvider.startsWith("cli:codex")) {
    return rawProvider.includes("(") ? rawProvider.replace("cli:codex", "Codex CLI ") : "Codex CLI";
  }
  if (rawProvider.startsWith("deepseek:")) {
    return `DeepSeek (${rawProvider.slice("deepseek:".length)})`;
  }
  if (rawProvider.startsWith("openai:")) {
    return `OpenAI (${rawProvider.slice("openai:".length)})`;
  }
  if (rawProvider.startsWith("custom:")) {
    return rawProvider.slice("custom:".length);
  }
  return rawProvider;
}
