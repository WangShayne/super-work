import type {
  FlightEvent,
  RunDigestEngineBreakdown,
  RunDigestReport,
  StageRun,
  Ticket,
  WorkerEngineId,
} from "./types.ts";
import { isTerminalTicketStatus, nowIso } from "./utils.ts";

const DIGEST_ENGINES: WorkerEngineId[] = ["claude", "codex", "gemini", "opencode"];
const MAX_DIGEST_EVENTS = 50;

export interface BuildRunDigestInput {
  repoId?: string;
  /** Window in hours; <= 0 means "all time". */
  windowHours: number;
  tickets: Ticket[];
  stageRuns: StageRun[];
  flightEvents: FlightEvent[];
  /** Override "now" (ISO) for deterministic output/testing. */
  now?: string;
}

export function formatDigestDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  if (total < 1000) return `${total}ms`;
  const sec = total / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const rest = Math.round(sec % 60);
  if (min < 60) return `${min}m ${rest}s`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

function isFailedOrReverted(t: Ticket): boolean {
  return t.status === "failed" || Boolean(t.revertedAt);
}

function isDelivered(t: Ticket): boolean {
  return t.status === "delivered" && !t.revertedAt;
}

function resolveTicketEngine(t: Ticket, runsByTicket: Map<string, StageRun[]>): WorkerEngineId | undefined {
  if (t.activeEngine) return t.activeEngine;
  const runs = runsByTicket.get(t.id);
  return runs && runs.length > 0 ? runs[runs.length - 1]!.engine : undefined;
}

interface DigestLabels {
  title: string;
  window: (hours: number) => string;
  tickets: string;
  delivered: string;
  reverted: string;
  escalated: string;
  active: string;
  cost: string;
  gate: (runs: number, saved: string) => string;
  gateReuse: (n: number, s: string) => string;
  selfHost: (c: RunDigestReport["selfHost"]) => string;
  engineHeader: string[];
  events: string;
  none: string;
}

const LABELS_EN: DigestLabels = {
  title: "# Super-Work Run Digest",
  window: (h) => (h > 0 ? `Window: last ${h}h` : "Window: all time"),
  tickets: "Tickets",
  delivered: "Delivered",
  reverted: "Reverted",
  escalated: "Escalated",
  active: "Active",
  cost: "Cost (USD)",
  gate: (n, s) => `Impact-scoped gate: ${n} run(s), saved ${s}`,
  gateReuse: (n, s) => `Rebase gate reuse: ${n} run(s), saved ${s}`,
  selfHost: (c) =>
    `Self-host: ${c.canaryPassed} canary passed, ${c.reloadsCompleted} reloads, ${c.canaryRolledBack} rollbacks, ${c.watchdogSwitches} watchdog switches, ${c.engineTripped ?? 0} engine trips, ${c.spilloverQuarantined ?? 0} spillover quarantines`,
  engineHeader: ["Engine", "Tickets", "Delivered", "Failed/Reverted", "Pass rate", "Cost (USD)", "Avg duration"],
  events: "Recent flight events",
  none: "(none)",
};

const LABELS_ZH: DigestLabels = {
  title: "# Super-Work 运行摘要",
  window: (h) => (h > 0 ? `时间窗口：最近 ${h} 小时` : "时间窗口：全部"),
  tickets: "工单",
  delivered: "已交付",
  reverted: "已回滚",
  escalated: "待人工",
  active: "进行中",
  cost: "花费 (USD)",
  gate: (n, s) => `影响范围校验门：${n} 次运行，节省 ${s}`,
  gateReuse: (n, s) => `Rebase 校验门复用：${n} 次，节省 ${s}`,
  selfHost: (c) =>
    `自举：Canary 通过 ${c.canaryPassed} 次，重载 ${c.reloadsCompleted} 次，回滚 ${c.canaryRolledBack} 次，Watchdog 切换 ${c.watchdogSwitches} 次，引擎熔断 ${c.engineTripped ?? 0} 次，溢出隔离 ${c.spilloverQuarantined ?? 0} 次`,
  engineHeader: ["引擎", "工单", "已交付", "失败/回滚", "通过率", "花费 (USD)", "平均耗时"],
  events: "最近飞行事件",
  none: "（无）",
};

function renderMarkdown(report: Omit<RunDigestReport, "markdownZh" | "markdownEn">, L: DigestLabels): string {
  const s = report.ticketSummary;
  const lines: string[] = [
    L.title,
    "",
    `${L.window(report.windowHours)}${report.repoId ? ` · repo: ${report.repoId}` : ""}`,
    "",
    `- ${L.tickets}: ${s.total} | ${L.delivered}: ${s.delivered} | ${L.reverted}: ${s.reverted} | ${L.escalated}: ${s.escalated} | ${L.active}: ${s.active}`,
    `- ${L.cost}: ${s.totalCostUsd.toFixed(2)}`,
    `- ${L.gate(report.gateSavings.scopedRuns, formatDigestDuration(report.gateSavings.totalSavedMs))}`,
    ...(report.gateReuse && report.gateReuse.reusedRuns > 0
      ? [`- ${L.gateReuse(report.gateReuse.reusedRuns, formatDigestDuration(report.gateReuse.totalSavedMs))}`]
      : []),
    `- ${L.selfHost(report.selfHost)}`,
    "",
    `| ${L.engineHeader.join(" | ")} |`,
    `| ${L.engineHeader.map(() => "---").join(" | ")} |`,
  ];
  for (const e of report.engines) {
    lines.push(
      `| ${e.engine} | ${e.tickets} | ${e.delivered} | ${e.failedOrReverted} | ${(e.passRate * 100).toFixed(0)}% | ${e.totalCostUsd.toFixed(2)} | ${formatDigestDuration(e.avgDurationMs)} |`,
    );
  }
  lines.push("", `## ${L.events}`, "");
  if (report.events.length === 0) {
    lines.push(L.none);
  } else {
    for (const ev of report.events.slice(0, 20)) {
      lines.push(`- ${ev.createdAt} \`${ev.kind}\` ${ev.summary}`);
    }
  }
  return lines.join("\n");
}

export function buildRunDigestReport(input: BuildRunDigestInput): RunDigestReport {
  const generatedAt = input.now ?? nowIso();
  const windowHours = Number.isFinite(input.windowHours) ? Math.max(0, input.windowHours) : 0;
  const sinceMs = windowHours > 0 ? Date.parse(generatedAt) - windowHours * 3_600_000 : Number.NEGATIVE_INFINITY;
  const inWindow = (iso: string | undefined): boolean => {
    if (windowHours <= 0) return true;
    const ms = iso ? Date.parse(iso) : Number.NaN;
    return Number.isFinite(ms) && ms >= sinceMs;
  };
  const repoOk = (repoId: string | undefined): boolean => !input.repoId || repoId === input.repoId;

  const tickets = input.tickets.filter((t) => repoOk(t.repoId) && inWindow(t.updatedAt ?? t.createdAt));
  const ticketIds = new Set(tickets.map((t) => t.id));
  const stageRuns = input.stageRuns.filter((r) => ticketIds.has(r.ticketId) && inWindow(r.startedAt));
  const events = input.flightEvents
    .filter((e) => repoOk(e.repoId) && inWindow(e.createdAt))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const runsByTicket = new Map<string, StageRun[]>();
  for (const r of stageRuns) {
    const list = runsByTicket.get(r.ticketId) ?? [];
    list.push(r);
    runsByTicket.set(r.ticketId, list);
  }

  const ticketSummary = {
    total: tickets.length,
    delivered: tickets.filter(isDelivered).length,
    reverted: tickets.filter((t) => Boolean(t.revertedAt)).length,
    escalated: tickets.filter((t) => t.status === "needs_human").length,
    active: tickets.filter((t) => !isTerminalTicketStatus(t.status)).length,
    totalCostUsd: tickets.reduce((sum, t) => sum + (t.costUsd ?? 0), 0),
  };

  const engines: RunDigestEngineBreakdown[] = DIGEST_ENGINES.map((engine) => {
    const engineTickets = tickets.filter((t) => resolveTicketEngine(t, runsByTicket) === engine);
    const delivered = engineTickets.filter(isDelivered).length;
    const failedOrReverted = engineTickets.filter(isFailedOrReverted).length;
    const settled = delivered + failedOrReverted;
    const runs = stageRuns.filter((r) => r.engine === engine);
    const timed = runs.filter((r) => r.completedAt);
    const durations = timed
      .map((r) => Date.parse(r.completedAt!) - Date.parse(r.startedAt))
      .filter((d) => Number.isFinite(d) && d >= 0);
    return {
      engine,
      tickets: engineTickets.length,
      delivered,
      failedOrReverted,
      passRate: settled > 0 ? delivered / settled : 0,
      totalCostUsd: runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0),
      avgDurationMs: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
    };
  });

  const count = (kind: FlightEvent["kind"]): number => events.filter((e) => e.kind === kind).length;
  const scoped = events.filter((e) => e.kind === "scoped_gate_run");
  const reused = events.filter((e) => e.kind === "gate_reused");

  const base: Omit<RunDigestReport, "markdownZh" | "markdownEn"> = {
    generatedAt,
    ...(input.repoId ? { repoId: input.repoId } : {}),
    windowHours,
    ticketSummary,
    gateSavings: {
      scopedRuns: scoped.length,
      totalSavedMs: scoped.reduce((sum, e) => sum + (e.savedMs ?? 0), 0),
    },
    gateReuse: {
      reusedRuns: reused.length,
      totalSavedMs: reused.reduce((sum, e) => sum + (e.savedMs ?? 0), 0),
    },
    resilience: {
      engineTrips: count("engine_tripped"),
      spilloverQuarantines: count("spillover_quarantined"),
    },
    selfHost: {
      canaryPassed: count("canary_passed"),
      reloadsCompleted: count("reload_completed"),
      canaryRolledBack: count("canary_rolled_back"),
      watchdogSwitches: count("watchdog_switch"),
      engineTripped: count("engine_tripped"),
      spilloverQuarantined: count("spillover_quarantined"),
    },
    engines,
    events: events.slice(0, MAX_DIGEST_EVENTS),
  };

  return {
    ...base,
    markdownZh: renderMarkdown(base, LABELS_ZH),
    markdownEn: renderMarkdown(base, LABELS_EN),
  };
}
