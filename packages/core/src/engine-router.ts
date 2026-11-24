import type {
  CasebookEntry,
  EngineCategoryMetricRow,
  PipelineTemplateId,
  RepoConfig,
  StageRun,
  TaskCategory,
  Ticket,
  WorkerEngineId,
} from "./types.ts";
import { normalizeRelPath } from "./utils.ts";

export function isSpecTestFilePath(relPath: string): boolean {
  const norm = normalizeRelPath(relPath).toLowerCase();
  if (!norm) return false;
  if (/(?:^|\/)(?:__tests__|tests?|e2e)\//i.test(norm)) {
    return true;
  }
  if (/\.(?:test|spec)\.[a-z0-9]+$/i.test(norm)) {
    return true;
  }
  if (/(?:^|\/)test_[^/]+\.py$/i.test(norm) || /_test\.(?:py|go|rs)$/i.test(norm)) {
    return true;
  }
  return false;
}

export function parseSpecTestChallenge(text: string): string | null {
  const match = text.match(/SPEC_TEST_CHALLENGE\s*:\s*([^\n\r]+)/i);
  if (!match || !match[1]) return null;
  const reason = match[1].trim();
  return reason.length > 0 ? reason.slice(0, 400) : null;
}

export function isUiIntentTicket(input: {
  title: string;
  description: string;
  changedFiles?: string[];
}): boolean {
  const combined = `${input.title}\n${input.description}`;
  if (
    /(?:\b(?:ui|ux|css|tailwind|layout|theme|style|styling|redesign|modal|drawer|button|badge|header|canvas|dag|viewport|responsive)\b|界面|样式|布局|配色|主题|弹窗|按钮|组件|页面|改版|重做|排版|视觉)/i.test(
      combined,
    )
  ) {
    return true;
  }
  if (input.changedFiles && input.changedFiles.length > 0) {
    const allPureStyleOrSvg = input.changedFiles.every((f) =>
      /\.(?:css|scss|less|svg|html)$/i.test(f),
    );
    if (allPureStyleOrSvg) return true;
  }
  return false;
}

export function classifyTaskCategory(
  title: string,
  description: string,
  allowedPaths?: string[],
): TaskCategory {
  const combined = `${title}\n${description}`;
  if (
    /(?:\b(?:readme|docs?|documentation|typo|changelog|comments?)\b|文档|注释|错别字|说明)/i.test(
      combined,
    )
  ) {
    return "docs_chore";
  }
  if (
    /(?:\b(?:test|tests|unit test|spec|tdd|coverage|smoke|ci|workflow)\b|单测|测试|覆盖率|门禁|巡检)/i.test(
      combined,
    ) ||
    (allowedPaths &&
      allowedPaths.length > 0 &&
      !allowedPaths.includes("**") &&
      allowedPaths.every((p) => isSpecTestFilePath(p)))
  ) {
    return "test_ci";
  }
  if (
    isUiIntentTicket({ title, description }) ||
    (allowedPaths &&
      allowedPaths.some((p) => /(?:^|\/)(?:web|frontend|ui|components|views)\//i.test(p)))
  ) {
    return "ui";
  }
  if (
    /(?:\b(?:refactor|cleanup|split|extract|rename|migrate|architecture)\b|重构|拆分|清理|迁移|解耦)/i.test(
      combined,
    )
  ) {
    return "refactor";
  }
  return "backend";
}

function getCategoryPriorBonus(engine: WorkerEngineId, category: TaskCategory): number {
  switch (category) {
    case "ui":
      return engine === "claude" ? 0.06 : engine === "opencode" ? 0.02 : 0;
    case "backend":
      return engine === "codex" ? 0.06 : engine === "claude" ? 0.03 : 0;
    case "refactor":
      return engine === "claude" ? 0.05 : engine === "codex" ? 0.04 : 0;
    case "test_ci":
      return engine === "codex" ? 0.06 : engine === "claude" ? 0.03 : 0;
    case "docs_chore":
      return engine === "opencode" ? 0.06 : engine === "claude" ? 0.02 : 0;
  }
}

function inferTicketImplementEngine(
  ticket: Ticket,
  runsByTicket: Map<string, StageRun[]>,
): WorkerEngineId | null {
  const runs = runsByTicket.get(ticket.id) ?? [];
  const implRun = runs.find((r) => r.stage === "implement" || r.stage === "spec_test");
  if (implRun) return implRun.engine;
  if (ticket.preferredEngine && ticket.preferredEngine !== "auto") {
    return ticket.preferredEngine;
  }
  return ticket.activeEngine ?? null;
}

export function buildEngineCategoryMatrix(input: {
  tickets: Ticket[];
  stageRuns: StageRun[];
  casebookEntries: CasebookEntry[];
  engines?: WorkerEngineId[];
}): EngineCategoryMetricRow[] {
  const runsByTicket = new Map<string, StageRun[]>();
  for (const run of input.stageRuns) {
    const arr = runsByTicket.get(run.ticketId) ?? [];
    arr.push(run);
    runsByTicket.set(run.ticketId, arr);
  }
  const caseByTicket = new Map<string, CasebookEntry>();
  for (const c of input.casebookEntries) {
    caseByTicket.set(c.ticketId, c);
  }

  interface Bucket {
    engine: WorkerEngineId;
    category: TaskCategory;
    tickets: number;
    firstPass: number;
    delivered: number;
    reverted: number;
    retries: number;
    totalCostUsd: number;
  }

  const buckets = new Map<string, Bucket>();
  const finishedStatuses = new Set(["delivered", "failed", "cancelled", "needs_human"]);

  for (const ticket of input.tickets) {
    if (!finishedStatuses.has(ticket.status) || ticket.isEpic) continue;
    const engine = inferTicketImplementEngine(ticket, runsByTicket);
    if (!engine) continue;
    if (input.engines && input.engines.length > 0 && !input.engines.includes(engine)) {
      continue;
    }

    const category =
      ticket.taskCategory ??
      classifyTaskCategory(ticket.title, ticket.description, ticket.mandate.allowedPaths);
    const key = `${engine}::${category}`;
    const bucket = buckets.get(key) ?? {
      engine,
      category,
      tickets: 0,
      firstPass: 0,
      delivered: 0,
      reverted: 0,
      retries: 0,
      totalCostUsd: 0,
    };

    const runs = runsByTicket.get(ticket.id) ?? [];
    const implRuns = runs.filter((r) => r.stage === "implement");
    const firstImplPassed =
      implRuns.length > 0
        ? implRuns[0]!.status === "completed"
        : ticket.status === "delivered" && ticket.stageRetries === 0;
    const isReverted = Boolean(ticket.revertedAt) || Boolean(caseByTicket.get(ticket.id)?.reverted);
    const isDelivered = ticket.status === "delivered" && !isReverted;

    bucket.tickets += 1;
    if (firstImplPassed) bucket.firstPass += 1;
    if (isDelivered) bucket.delivered += 1;
    if (isReverted) bucket.reverted += 1;
    bucket.retries += Math.max(0, implRuns.length - 1);
    bucket.totalCostUsd += ticket.costUsd;

    buckets.set(key, bucket);
  }

  const rows: EngineCategoryMetricRow[] = [];
  for (const b of buckets.values()) {
    const firstPassRate = b.firstPass / b.tickets;
    const deliveryRate = b.delivered / b.tickets;
    const revertRate = b.reverted / b.tickets;
    const avgCostUsd = b.totalCostUsd / b.tickets;
    const retryRate = Math.min(1, b.retries / (b.tickets * 2));
    const compositeScore = Math.max(
      0,
      Math.min(
        1,
        0.55 * firstPassRate +
          0.45 * deliveryRate -
          0.18 * retryRate -
          0.5 * revertRate -
          Math.min(0.15, avgCostUsd * 0.05),
      ),
    );
    rows.push({
      engine: b.engine,
      category: b.category,
      tickets: b.tickets,
      firstPassRate,
      deliveryRate,
      revertRate,
      avgCostUsd,
      compositeScore,
    });
  }

  return rows.sort((a, b) => b.compositeScore - a.compositeScore || b.tickets - a.tickets);
}

export interface EngineRoutingDecision {
  chosenEngine: WorkerEngineId;
  competitorEngine?: WorkerEngineId;
  autoUpgradeArena: boolean;
  category: TaskCategory;
  confidence: number;
  rationale: string;
}

export function computeEngineRoutingDecision(input: {
  repo: RepoConfig;
  ticket: {
    title: string;
    description: string;
    template: PipelineTemplateId;
    mandate: { allowedPaths: string[] };
    arenaMode?: boolean;
  };
  availableEngines: WorkerEngineId[];
  historicalTickets: Ticket[];
  historicalStageRuns: StageRun[];
  casebookEntries: CasebookEntry[];
  todaySpendUsd: number;
  effectiveDailyBudgetUsd?: number;
  recentAutoArenaCountLastHour: number;
}): EngineRoutingDecision {
  const category = classifyTaskCategory(
    input.ticket.title,
    input.ticket.description,
    input.ticket.mandate.allowedPaths,
  );

  const realAvailable = input.availableEngines.filter((e) => e !== "mock");
  const candidates: WorkerEngineId[] =
    realAvailable.length > 0
      ? realAvailable
      : input.availableEngines.length > 0
        ? input.availableEngines
        : ["mock"];

  const matrix = buildEngineCategoryMatrix({
    tickets: input.historicalTickets,
    stageRuns: input.historicalStageRuns,
    casebookEntries: input.casebookEntries,
    engines: candidates,
  });

  const rowsByEngine = new Map<WorkerEngineId, EngineCategoryMetricRow>();
  let totalCategoryTrials = 0;
  for (const row of matrix) {
    if (row.category === category) {
      rowsByEngine.set(row.engine, row);
      totalCategoryTrials += row.tickets;
    }
  }

  const scored = candidates.map((engine) => {
    const row = rowsByEngine.get(engine);
    const trials = row?.tickets ?? 0;
    const prior = getCategoryPriorBonus(engine, category);
    const ucb = 0.16 * Math.sqrt(Math.log(totalCategoryTrials + 2) / (trials + 1));
    const baseConfidence =
      trials > 0 && row ? Math.max(0, Math.min(1, row.compositeScore + prior)) : 0.42 + prior;
    const ucbScore =
      totalCategoryTrials < 5
        ? 0.45 + prior + ucb
        : (trials > 0 && row ? row.compositeScore + prior : 0.42 + prior) + ucb;
    return { engine, trials, row, baseConfidence, ucbScore };
  });

  scored.sort((a, b) => b.ucbScore - a.ucbScore);
  const top = scored[0]!;
  const second = scored[1];

  const remainingBudgetRatio =
    input.effectiveDailyBudgetUsd && input.effectiveDailyBudgetUsd > 0
      ? (input.effectiveDailyBudgetUsd - input.todaySpendUsd) / input.effectiveDailyBudgetUsd
      : 1;
  const budgetAllows = remainingBudgetRatio >= 0.4;
  const rateAllows = input.recentAutoArenaCountLastHour < 2;
  const lowConfidence = top.baseConfidence < 0.52;
  const autoUpgradeArena = Boolean(
    !input.ticket.arenaMode &&
      candidates.length >= 2 &&
      second &&
      lowConfidence &&
      budgetAllows &&
      rateAllows,
  );

  const arenaNote = autoUpgradeArena
    ? `Auto-Arena ON (conf=${top.baseConfidence.toFixed(2)} < 0.52, competitor=${second!.engine})`
    : lowConfidence && candidates.length >= 2 && !input.ticket.arenaMode
      ? `Auto-Arena withheld (${!budgetAllows ? "budget<40%" : "hourly_cap>=2"})`
      : "Single-engine fast path";

  const statsNote =
    top.trials > 0 && top.row
      ? `${top.trials} sample(s), firstPass=${Math.round(top.row.firstPassRate * 100)}%, revert=${Math.round(top.row.revertRate * 100)}%`
      : `cold-start UCB prior (${totalCategoryTrials} category sample(s))`;

  return {
    chosenEngine: top.engine,
    ...(second ? { competitorEngine: second.engine } : {}),
    autoUpgradeArena,
    category,
    confidence: Number(top.baseConfidence.toFixed(3)),
    rationale: `category=${category} -> ${top.engine} (${statsNote}; ${arenaNote})`,
  };
}
