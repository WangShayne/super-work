import type { ControlPlaneLLM, RepoProbeExecutor } from "./ports.ts";
import type {
  ChiefActionSuggestion,
  ChiefAskResult,
  InboxItem,
  MemorySearchHit,
  RepoConfig,
  RepoMetricsSummary,
  RepoProbeContextPack,
  Ticket,
} from "./types.ts";
import { isTerminalTicketStatus, newId, nowIso } from "./utils.ts";

export async function runChiefOfStaffQuery(input: {
  question: string;
  repo?: RepoConfig;
  allRepos: RepoConfig[];
  tickets: Ticket[];
  inboxItems: InboxItem[];
  metrics: RepoMetricsSummary;
  memoryHits: MemorySearchHit[];
  probeContext?: RepoProbeContextPack;
  llm: ControlPlaneLLM;
  probeExecutor?: RepoProbeExecutor;
}): Promise<ChiefAskResult> {
  const question = input.question.trim();
  const qLower = question.toLowerCase();
  const scopedTickets = input.repo
    ? input.tickets.filter((t) => t.repoId === input.repo!.id)
    : input.tickets;
  const scopedInbox = input.repo
    ? input.inboxItems.filter((i) => i.repoId === input.repo!.id)
    : input.inboxItems;

  const activeTickets = scopedTickets.filter((t) => !isTerminalTicketStatus(t.status));
  const runningTickets = scopedTickets.filter((t) =>
    ["planning", "spec_testing", "implementing", "reviewing", "rebasing"].includes(t.status),
  );
  const failedOrAttention = scopedTickets.filter(
    (t) => t.status === "needs_human" || t.status === "failed",
  );
  const pendingInbox = scopedInbox.filter((i) => i.status === "pending");

  const ticketsById = new Map(scopedTickets.map((t) => [t.id, t]));
  const lowRiskPendingInbox = pendingInbox.filter((item) => {
    const tkt = ticketsById.get(item.ticketId);
    const highRisk = tkt?.riskAssessment?.level === "high";
    return (
      !highRisk &&
      (item.kind === "observe_proposal" ||
        item.kind === "outbox_signoff" ||
        item.kind === "clarification_request")
    );
  });

  const summaryLines = [
    `Scope: ${input.repo ? `${input.repo.name} (${input.repo.id}, mode=${input.repo.mode})` : `${input.allRepos.length} repositories`}`,
    `Tickets: ${scopedTickets.length} total, ${activeTickets.length} active (${runningTickets.length} executing), ${failedOrAttention.length} needing attention`,
    `Inbox: ${pendingInbox.length} pending (${lowRiskPendingInbox.length} low-risk batch-approvable)`,
    `Spend: today $${input.metrics.todayCostUsd.toFixed(3)}${input.metrics.effectiveDailyBudgetUsd ? ` / $${input.metrics.effectiveDailyBudgetUsd.toFixed(2)}` : ""}, cumulative $${input.metrics.totalCostUsd.toFixed(3)}, deliveryRate=${Math.round(input.metrics.deliveryRate * 100)}%`,
  ];

  if (activeTickets.length > 0) {
    summaryLines.push(
      `Active tickets:\n${activeTickets
        .slice(0, 8)
        .map(
          (t) =>
            `- [${t.id}] "${t.title}" status=${t.status} stage=${t.currentStage} engine=${t.activeEngine ?? t.preferredEngine ?? "auto"} cost=$${t.costUsd.toFixed(3)}${t.errorMessage ? ` err=${t.errorMessage.slice(0, 120)}` : ""}`,
        )
        .join("\n")}`,
    );
  }

  if (pendingInbox.length > 0) {
    summaryLines.push(
      `Pending inbox items:\n${pendingInbox
        .slice(0, 8)
        .map((i) => `- [${i.id}] (${i.kind}) ticket=${i.ticketId}: ${i.title}`)
        .join("\n")}`,
    );
  }

  if (input.memoryHits.length > 0) {
    summaryLines.push(
      `Memory hits:\n${input.memoryHits
        .slice(0, 5)
        .map((m) => `- ${m.title} (${m.ticketId}): ${m.snippet.slice(0, 120)}`)
        .join("\n")}`,
    );
  }

  if (input.probeContext?.deterministicSummary) {
    summaryLines.push(`Codebase probe evidence:\n${input.probeContext.deterministicSummary}`);
  }

  const contextSummary = summaryLines.join("\n\n");

  const suggestedActions: ChiefActionSuggestion[] = [];
  if (lowRiskPendingInbox.length > 0) {
    suggestedActions.push({
      id: newId("act"),
      kind: "batch_resolve_inbox",
      label: `批量批准 ${lowRiskPendingInbox.length} 项低风险待审批`,
      description: lowRiskPendingInbox.map((i) => i.title).slice(0, 3).join(" · "),
      payload: {
        ...(input.repo ? { repoId: input.repo.id } : {}),
        inboxIds: lowRiskPendingInbox.map((i) => i.id),
        onlyLowRisk: true,
        decision: "approved",
        note: "Batch-approved via Chief-of-Staff",
      },
    });
  }

  if (runningTickets.length > 0 && /(steer|纠偏|停|改|卡|stuck|focus|running|执行)/i.test(qLower)) {
    const target = runningTickets[0]!;
    suggestedActions.push({
      id: newId("act"),
      kind: "steer_ticket",
      label: `向执行中工单「${target.title}」发送实时纠偏`,
      description: `当前处于 ${target.status} / ${target.currentStage}，可注入指令并保留 Worktree 续跑`,
      payload: {
        ticketId: target.id,
        instruction: question,
      },
    });
  }

  if (failedOrAttention.length > 0) {
    const tkt = failedOrAttention[0]!;
    suggestedActions.push({
      id: newId("act"),
      kind: "open_ticket",
      label: `检查异常/待处理工单：${tkt.title}`,
      description: `${tkt.status} · ${tkt.errorMessage?.slice(0, 80) || tkt.currentStage}`,
      payload: { ticketId: tkt.id },
    });
  } else if (runningTickets.length > 0) {
    const tkt = runningTickets[0]!;
    suggestedActions.push({
      id: newId("act"),
      kind: "open_ticket",
      label: `查看运行中工单详情：${tkt.title}`,
      description: `${tkt.status} (${tkt.activeEngine ?? "auto"})`,
      payload: { ticketId: tkt.id },
    });
  }

  if (/(doctor|health|clean|orphan|worktree|体检|清理|诊断|备份|backup)/i.test(qLower)) {
    suggestedActions.push({
      id: newId("act"),
      kind: "run_doctor",
      label: "运行系统健康自检 (Doctor)",
      description: "检查 SQLite 完整性、孤儿 Worktree、失效预览与过期 Ref",
      payload: { fix: false },
    });
    suggestedActions.push({
      id: newId("act"),
      kind: "create_backup",
      label: "立即创建热备份快照 (VACUUM INTO)",
      description: "无锁生成一致性 SQLite 快照归档",
      payload: {},
    });
  }

  if (
    input.repo &&
    /(implement|fix|add|refactor|build|create|实现|修复|新增|重构|优化|补充)/i.test(qLower)
  ) {
    suggestedActions.push({
      id: newId("act"),
      kind: "dispatch_ticket",
      label: `派发新工单至 ${input.repo.name}`,
      description: question.slice(0, 90),
      payload: {
        repoId: input.repo.id,
        title: question.slice(0, 72),
        description: question,
        allowedPaths:
          input.probeContext && input.probeContext.matchedFiles.length > 0
            ? input.probeContext.matchedFiles.slice(0, 4)
            : ["**"],
      },
    });
  }

  if (input.llm.answerChiefQuestion) {
    try {
      const llmRes = await input.llm.answerChiefQuestion({
        question,
        contextSummary,
        probeContext: input.probeContext,
        probeExecutor: input.probeExecutor,
      });
      return {
        answer: llmRes.answer,
        highlights: llmRes.highlights ?? summaryLines.slice(0, 4),
        probeSteps: llmRes.probeSteps ?? input.probeContext?.probeSteps,
        suggestedActions: suggestedActions.slice(0, 4),
        generatedAt: nowIso(),
      };
    } catch {
      // Fallback cleanly to deterministic chief summary below
    }
  }

  const deterministicAnswerParts: string[] = [];
  deterministicAnswerParts.push(
    input.repo
      ? `当前聚焦仓库「${input.repo.name}」（模式：${input.repo.mode}），共有 ${activeTickets.length} 个进行中工单、${pendingInbox.length} 项待审批（其中 ${lowRiskPendingInbox.length} 项为低风险可批审）、今日花费 $${input.metrics.todayCostUsd.toFixed(3)}。`
      : `全局共有 ${input.allRepos.length} 个仓库，${activeTickets.length} 个进行中工单，${pendingInbox.length} 项待审批（${lowRiskPendingInbox.length} 项低风险），总交付率 ${Math.round(input.metrics.deliveryRate * 100)}%。`,
  );

  if (failedOrAttention.length > 0) {
    deterministicAnswerParts.push(
      `需重点关注：${failedOrAttention
        .slice(0, 3)
        .map((t) => `「${t.title}」(${t.status}${t.errorMessage ? `: ${t.errorMessage.slice(0, 60)}` : ""})`)
        .join("；")}。`,
    );
  } else if (runningTickets.length > 0) {
    deterministicAnswerParts.push(
      `正在执行的工单：${runningTickets
        .slice(0, 3)
        .map((t) => `「${t.title}」[${t.currentStage}]`)
        .join("、")}。`,
    );
  }

  if (input.probeContext && input.probeContext.matchedFiles.length > 0) {
    deterministicAnswerParts.push(
      `代码预探针命中的关联文件：${input.probeContext.matchedFiles.slice(0, 5).join(", ")}。`,
    );
  }

  if (input.memoryHits.length > 0) {
    deterministicAnswerParts.push(
      `FTS5 历史记忆相关工单：${input.memoryHits
        .slice(0, 3)
        .map((h) => `${h.title} (${h.ticketId})`)
        .join("、")}。`,
    );
  }

  return {
    answer: deterministicAnswerParts.join("\n\n"),
    highlights: summaryLines.slice(0, 4),
    probeSteps: input.probeContext?.probeSteps,
    suggestedActions: suggestedActions.slice(0, 4),
    generatedAt: nowIso(),
  };
}
