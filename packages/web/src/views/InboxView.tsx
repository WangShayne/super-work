import { useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  DollarSign,
  ExternalLink,
  Eye,
  FileCode2,
  FileJson2,
  GitMerge,
  GitPullRequest,
  HelpCircle,
  Kanban,
  Layers,
  Play,
  Plus,
  Send,
  ShieldAlert,
  ShieldPlus,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { api } from "../api.ts";
import { formatInboxKind, formatInboxStatus, useI18n } from "../i18n.tsx";
import type {
  ArenaCandidateResult,
  ConflictSemanticContext,
  EpicReplanProposal,
  InboxItem,
  PreviewSession,
  Ticket,
  TicketRiskAssessment,
  WorkerClarificationRequest,
} from "../types.ts";

interface InboxViewProps {
  items: InboxItem[];
  ticketsById: Map<string, Ticket>;
  selectedRepoId?: string;
  totalTicketCount?: number;
  runningTicketCount?: number;
  onResolve: (
    id: string,
    decision: "approved" | "rejected",
    note?: string,
    deliveryAction?: "local_merge" | "push_and_create_pr",
    options?: {
      expandMandate?: boolean;
      budgetIncreaseUsd?: number;
      arenaWinnerId?: string;
      selectedOption?: string;
    },
  ) => Promise<void>;
  onRefresh?: () => void;
  onInspectTicket: (ticketId: string) => void;
  onOpenDispatch?: () => void;
  onSwitchToBoard?: () => void;
  onOpenContractSettings?: () => void;
}

const KIND_STYLE: Record<InboxItem["kind"], { color: string; icon: typeof Eye }> = {
  mandate_violation: {
    color: "bg-rose-500/15 text-rose-300 border-rose-500/30",
    icon: ShieldAlert,
  },
  watchdog_escalation: {
    color: "bg-orange-500/15 text-orange-300 border-orange-500/30",
    icon: AlertTriangle,
  },
  merge_conflict: {
    color: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    icon: GitMerge,
  },
  plan_approval: {
    color: "bg-sky-500/15 text-sky-300 border-sky-500/30",
    icon: FileCode2,
  },
  outbox_signoff: {
    color: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    icon: Send,
  },
  observe_proposal: {
    color: "bg-indigo-500/15 text-indigo-300 border-indigo-500/30",
    icon: Eye,
  },
  budget_cap: {
    color: "bg-yellow-500/15 text-yellow-300 border-yellow-500/30",
    icon: DollarSign,
  },
  pr_followup: {
    color: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
    icon: GitPullRequest,
  },
  arena_tiebreak: {
    color: "bg-teal-500/15 text-teal-300 border-teal-500/30",
    icon: Sparkles,
  },
  epic_replan: {
    color: "bg-purple-500/15 text-purple-300 border-purple-500/30",
    icon: Layers,
  },
  clarification_request: {
    color: "bg-violet-500/15 text-violet-300 border-violet-500/30",
    icon: HelpCircle,
  },
  campaign_paused: {
    color: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    icon: AlertTriangle,
  },
  milestone_ready: {
    color: "bg-teal-500/15 text-teal-300 border-teal-500/30",
    icon: Layers,
  },
};

export function InboxView({
  items,
  ticketsById,
  selectedRepoId,
  totalTicketCount = 0,
  runningTicketCount = 0,
  onResolve,
  onRefresh,
  onInspectTicket,
  onOpenDispatch,
  onSwitchToBoard,
  onOpenContractSettings,
}: InboxViewProps) {
  const { locale, t } = useI18n();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [clarifyChoices, setClarifyChoices] = useState<Record<string, string>>({});
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchNotice, setBatchNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [previewBusyKey, setPreviewBusyKey] = useState<string | null>(null);
  const [previewsByKey, setPreviewsByKey] = useState<Record<string, PreviewSession>>({});
  const [previewErrors, setPreviewErrors] = useState<Record<string, string>>({});

  const pending = items.filter((i) => i.status === "pending");
  const resolved = items.filter((i) => i.status !== "pending").slice(0, 10);
  const pendingIdSet = new Set(pending.map((i) => i.id));
  const activeSelectedIds = selectedIds.filter((id) => pendingIdSet.has(id));

  const isLowRiskBatchable = (item: InboxItem): boolean => {
    const tkt = ticketsById.get(item.ticketId);
    const highRisk = tkt?.riskAssessment?.level === "high";
    return (
      !highRisk &&
      (item.kind === "observe_proposal" ||
        item.kind === "outbox_signoff" ||
        item.kind === "clarification_request")
    );
  };

  const toggleSelectItem = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  };

  const handleBatchResolve = async (decision: "approved" | "rejected") => {
    if (activeSelectedIds.length === 0) return;
    setBatchBusy(true);
    setBatchNotice(null);
    try {
      const res = await api.batchResolveInbox({
        inboxIds: activeSelectedIds,
        repoId: selectedRepoId,
        onlyLowRisk: false,
        decision,
      });
      setSelectedIds([]);
      setBatchNotice(
        `${decision === "approved" ? t("inbox.batchApprove") : t("inbox.batchReject")}: ${res.resolvedCount} ok, ${res.skippedCount} skipped`,
      );
      onRefresh?.();
    } finally {
      setBatchBusy(false);
    }
  };

  const handleLaunchPreview = async (
    pKey: string,
    ticketId: string,
    candidateId?: string,
  ) => {
    setPreviewBusyKey(pKey);
    setPreviewErrors((prev) => {
      const next = { ...prev };
      delete next[pKey];
      return next;
    });
    try {
      const res = await api.startPreview({ ticketId, candidateId });
      setPreviewsByKey((prev) => ({ ...prev, [pKey]: res.preview }));
    } catch (err) {
      setPreviewErrors((prev) => ({
        ...prev,
        [pKey]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setPreviewBusyKey(null);
    }
  };

  const handleStopPreview = async (pKey: string, previewId: string) => {
    setPreviewBusyKey(pKey);
    setPreviewErrors((prev) => {
      const next = { ...prev };
      delete next[pKey];
      return next;
    });
    try {
      await api.stopPreview(previewId);
      setPreviewsByKey((prev) => {
        const next = { ...prev };
        delete next[pKey];
        return next;
      });
    } catch (err) {
      setPreviewErrors((prev) => ({
        ...prev,
        [pKey]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setPreviewBusyKey(null);
    }
  };

  const handleAction = async (
    id: string,
    decision: "approved" | "rejected",
    deliveryAction?: "local_merge" | "push_and_create_pr",
    options?: {
      expandMandate?: boolean;
      budgetIncreaseUsd?: number;
      arenaWinnerId?: string;
      selectedOption?: string;
    },
  ) => {
    setBusyId(id);
    try {
      await onResolve(id, decision, notes[id]?.trim() || undefined, deliveryAction, options);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">{t("inbox.title")}</h2>
          <p className="text-xs text-zinc-400 mt-0.5">
            {t("inbox.subtitle")}
          </p>
        </div>
        <span className="text-xs font-mono px-2.5 py-1 rounded-full bg-zinc-900 border border-zinc-800 text-zinc-300">
          {pending.length} {t("inbox.pendingSuffix")}
        </span>
      </div>

      {pending.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 p-10 text-center space-y-5">
          <div>
            <CheckCircle2 className="w-10 h-10 text-emerald-400/80 mx-auto mb-3" />
            <h3 className="text-sm font-medium text-zinc-200">{t("inbox.emptyTitle")}</h3>
            <p className="text-xs text-zinc-500 mt-1 max-w-md mx-auto leading-relaxed">
              {t("inbox.emptyDesc")}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2.5 text-xs">
            {onOpenDispatch && (
              <button
                type="button"
                onClick={onOpenDispatch}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition shadow-sm shadow-indigo-950"
              >
                <Plus className="w-3.5 h-3.5" />
                {t("inbox.ctaDispatch")}
              </button>
            )}
            {onSwitchToBoard && (
              <button
                type="button"
                onClick={onSwitchToBoard}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 font-medium transition"
              >
                <Kanban className="w-3.5 h-3.5 text-sky-400" />
                <span>{t("inbox.ctaBoard")}</span>
                <span className="font-mono text-[11px] text-zinc-400">({totalTicketCount})</span>
                {runningTicketCount > 0 && (
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                )}
              </button>
            )}
            {onOpenContractSettings && (
              <button
                type="button"
                onClick={onOpenContractSettings}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg border border-zinc-800 bg-zinc-950 hover:bg-zinc-900 text-zinc-400 hover:text-zinc-200 transition"
              >
                <FileJson2 className="w-3.5 h-3.5 text-emerald-400" />
                {t("inbox.ctaContract")}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Batch Triage Action Bar (v1.1.0 A.2) */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-2.5 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  setSelectedIds(
                    activeSelectedIds.length === pending.length ? [] : pending.map((i) => i.id),
                  )
                }
                className="px-2.5 py-1 rounded-md border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 text-[11px] transition"
              >
                {t("inbox.batchSelectAll")}
              </button>
              <button
                type="button"
                onClick={() => setSelectedIds(pending.filter(isLowRiskBatchable).map((i) => i.id))}
                className="px-2.5 py-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-200 text-[11px] transition"
              >
                {t("inbox.batchSelectLowRisk")}
              </button>
              {activeSelectedIds.length > 0 && (
                <span className="font-mono text-[11px] text-indigo-300">
                  {activeSelectedIds.length} / {pending.length}
                </span>
              )}
              {batchNotice && (
                <span className="text-[11px] text-emerald-300 font-mono">{batchNotice}</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={batchBusy || activeSelectedIds.length === 0}
                onClick={() => void handleBatchResolve("rejected")}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 text-[11px] font-medium disabled:opacity-40 transition"
              >
                <X className="w-3 h-3" />
                {t("inbox.batchReject")}
              </button>
              <button
                type="button"
                disabled={batchBusy || activeSelectedIds.length === 0}
                onClick={() => void handleBatchResolve("approved")}
                className="inline-flex items-center gap-1 px-3 py-1 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-medium disabled:opacity-40 transition"
              >
                <Check className="w-3 h-3" />
                {t("inbox.batchApprove")}
              </button>
            </div>
          </div>

          {pending.map((item) => {
            const style = KIND_STYLE[item.kind];
            const Icon = style.icon;
            const ticket = ticketsById.get(item.ticketId);
            const isBusy = busyId === item.id;
            const clarification =
              item.kind === "clarification_request"
                ? (item.contextPayload.clarification as WorkerClarificationRequest | undefined)
                : undefined;
            const activeClarifyChoice = clarification
              ? (clarifyChoices[item.id] ??
                clarification.recommendedOption ??
                clarification.options[0])
              : undefined;

            return (
              <div
                key={item.id}
                className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 space-y-4 hover:border-zinc-700 transition"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <input
                        type="checkbox"
                        checked={activeSelectedIds.includes(item.id)}
                        onChange={() => toggleSelectItem(item.id)}
                        aria-label={`Select ${item.title}`}
                        className="rounded border-zinc-700 bg-zinc-950 text-indigo-500 cursor-pointer"
                      />
                      <span
                        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-mono font-semibold border ${style.color}`}
                      >
                        <Icon className="w-3 h-3" />
                        {formatInboxKind(item.kind, locale)}
                      </span>
                      <span className="text-xs font-mono text-zinc-500">{item.ticketId}</span>
                      {item.kind === "plan_approval" &&
                        item.contextPayload.isDagBreakpoint === true && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[10px] font-mono">
                            {t("inbox.dagBreakpointTag")}
                          </span>
                        )}
                      {ticket && (
                        <span className="text-[11px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 font-mono">
                          {ticket.template} · {ticket.mandate.allowedPaths.join(", ")}
                        </span>
                      )}
                    </div>
                    <h3 className="text-sm font-semibold text-zinc-100">{item.title}</h3>
                  </div>

                  <button
                    onClick={() => onInspectTicket(item.ticketId)}
                    className="text-xs text-indigo-400 hover:text-indigo-300 font-medium"
                  >
                    {t("inbox.inspectDeepDive")}
                  </button>
                </div>

                <p className="text-xs text-zinc-300 whitespace-pre-wrap leading-relaxed bg-zinc-950/60 border border-zinc-800/80 rounded-lg p-3">
                  {item.summary}
                </p>

                {item.kind === "milestone_ready" &&
                  (() => {
                    const notes = String(
                      (locale === "zh"
                        ? item.contextPayload.releaseNotesZh
                        : item.contextPayload.releaseNotesEn) ?? "",
                    );
                    if (!notes) return null;
                    return (
                      <div className="rounded-lg border border-teal-500/25 bg-teal-500/5 p-3 space-y-1.5">
                        <div className="text-[11px] font-semibold uppercase tracking-wider text-teal-300">
                          {t("milestone.inboxNotes")}
                        </div>
                        <pre className="max-h-56 overflow-auto whitespace-pre-wrap text-xs text-zinc-300 leading-relaxed font-sans">
                          {notes}
                        </pre>
                      </div>
                    );
                  })()}

                {item.kind === "outbox_signoff" &&
                  (() => {
                    const risk =
                      (item.contextPayload.riskAssessment as TicketRiskAssessment | undefined) ??
                      ticket?.riskAssessment;
                    if (!risk) return null;
                    const badgeCls =
                      risk.level === "high"
                        ? "border-rose-500/40 bg-rose-500/15 text-rose-300"
                        : risk.level === "medium"
                          ? "border-amber-500/40 bg-amber-500/15 text-amber-200"
                          : "border-emerald-500/40 bg-emerald-500/15 text-emerald-300";
                    return (
                      <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3 space-y-2 text-xs">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-semibold text-zinc-200">
                            {t("inbox.riskCardTitle")}
                          </span>
                          <div className="flex items-center gap-2 font-mono text-[11px]">
                            <span className={`px-2 py-0.5 rounded border ${badgeCls}`}>
                              {risk.score}/100 ({risk.level.toUpperCase()})
                            </span>
                            <span className="text-zinc-400">
                              {t("inbox.riskThreshold")}: {risk.threshold} · {risk.policy}
                            </span>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {risk.factors.map((f) => (
                            <span
                              key={f.key}
                              title={f.detail}
                              className={`px-2 py-0.5 rounded border font-mono text-[10px] ${
                                f.delta > 0
                                  ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
                                  : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                              }`}
                            >
                              {f.delta > 0 ? `+${f.delta}` : f.delta} {f.label}
                              {f.detail ? ` (${f.detail})` : ""}
                            </span>
                          ))}
                        </div>
                      </div>
                    );
                  })()}

                {item.kind === "merge_conflict" &&
                  (() => {
                    const ctx =
                      (item.contextPayload.conflictContext as ConflictSemanticContext | undefined) ??
                      ticket?.conflictContext;
                    if (!ctx) return null;
                    return (
                      <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 space-y-2 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-rose-200">
                            {t("inbox.conflictCardTitle")} ({ctx.conflictFiles.length})
                          </span>
                          <span className="font-mono text-[10px] text-zinc-400">
                            {ctx.baseBranch} @ {ctx.mergeBaseSha.slice(0, 8)}
                          </span>
                        </div>
                        {ctx.upstreamCommitSummaries.length > 0 && (
                          <div className="text-[11px] text-zinc-400 space-y-0.5">
                            <div className="font-medium text-zinc-300">
                              {t("inbox.conflictUpstreamCommits")}:
                            </div>
                            {ctx.upstreamCommitSummaries.slice(0, 3).map((c, idx) => (
                              <div key={idx} className="font-mono text-[10px] truncate">
                                • {c}
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="space-y-1.5">
                          {ctx.fileHunks.slice(0, 3).map((h) => (
                            <div
                              key={h.filePath}
                              className="rounded border border-zinc-800 bg-zinc-950/80 p-2 space-y-1 font-mono text-[10px]"
                            >
                              <div className="text-zinc-200 font-semibold">{h.filePath}</div>
                              {h.oursSummary && (
                                <pre className="text-sky-300/90 whitespace-pre-wrap overflow-x-auto max-h-24">
                                  ours ({ctx.baseBranch}): {h.oursSummary}
                                </pre>
                              )}
                              {h.theirsSummary && (
                                <pre className="text-amber-300/90 whitespace-pre-wrap overflow-x-auto max-h-24">
                                  theirs (ticket): {h.theirsSummary}
                                </pre>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}

                {item.kind === "mandate_violation" && item.contextPayload.canExpandMandate === true && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200 flex flex-wrap items-center gap-2">
                    <ShieldPlus className="w-3.5 h-3.5 shrink-0" />
                    <span>{t("inbox.pendingViolationNotice")}:</span>
                    {Array.isArray(item.contextPayload.scopeViolations) &&
                      (item.contextPayload.scopeViolations as string[]).map((p) => (
                        <code
                          key={p}
                          className="px-1.5 py-0.5 rounded bg-zinc-950/70 border border-amber-500/30 font-mono text-[10px]"
                        >
                          {p}
                        </code>
                      ))}
                  </div>
                )}

                {item.kind === "arena_tiebreak" &&
                  Array.isArray(item.contextPayload.candidates) && (
                    <div className="space-y-2 rounded-lg border border-teal-500/30 bg-teal-500/5 p-3">
                      <div className="text-[11px] font-semibold text-teal-300">
                        {t("inbox.arenaTitle")}
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                        {(item.contextPayload.candidates as ArenaCandidateResult[]).map((cand) => (
                          <div
                            key={cand.candidateId}
                            className={`rounded-lg border p-2.5 text-xs space-y-1.5 ${
                              cand.recommended
                                ? "border-emerald-500/40 bg-emerald-500/10"
                                : "border-zinc-800 bg-zinc-950/80"
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-mono font-semibold text-zinc-100">
                                {cand.engine} ({cand.candidateId})
                              </span>
                              <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-teal-200">
                                {t("inbox.arenaScorePrefix")}: {cand.score}
                                {cand.recommended ? " ★" : ""}
                              </span>
                            </div>
                            <div className="font-mono text-[10px] text-zinc-400">
                              +{cand.addedLines}/-{cand.deletedLines} · {cand.changedFiles.length} file(s) · ${cand.costUsd.toFixed(3)} · {(cand.durationMs / 1000).toFixed(1)}s
                            </div>
                            {cand.rationale && (
                              <p className="text-[11px] text-zinc-300">{cand.rationale}</p>
                            )}
                            {cand.screenshotArtifactIds && cand.screenshotArtifactIds.length > 0 && (
                              <div className="grid grid-cols-1 gap-1.5 pt-1">
                                {cand.screenshotArtifactIds.slice(0, 2).map((aid) => (
                                  <a
                                    key={aid}
                                    href={api.getArtifactRawUrl(aid)}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="block rounded border border-zinc-800 overflow-hidden bg-zinc-900 hover:border-indigo-500/50 transition"
                                  >
                                    <img
                                      src={api.getArtifactRawUrl(aid)}
                                      alt={`${cand.engine} screenshot`}
                                      className="w-full max-h-36 object-cover object-top"
                                    />
                                  </a>
                                ))}
                              </div>
                            )}
                            {cand.visualDiffArtifactIds && cand.visualDiffArtifactIds.length > 0 && (
                              <div className="space-y-1 pt-1">
                                <div className="text-[10px] font-mono text-rose-300">
                                  {t("inbox.visualDiffsTitle")}
                                </div>
                                <div className="grid grid-cols-1 gap-1.5">
                                  {cand.visualDiffArtifactIds.slice(0, 2).map((aid) => (
                                    <a
                                      key={aid}
                                      href={api.getArtifactRawUrl(aid)}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="block rounded border border-rose-500/30 overflow-hidden bg-zinc-900 hover:border-rose-400 transition"
                                    >
                                      <img
                                        src={api.getArtifactRawUrl(aid)}
                                        alt={`${cand.engine} visual diff`}
                                        className="w-full max-h-36 object-contain bg-zinc-950"
                                      />
                                    </a>
                                  ))}
                                </div>
                              </div>
                            )}
                            {cand.worktreePath && (() => {
                              const pKey = `${item.ticketId}:${cand.candidateId}`;
                              const activePrv = previewsByKey[pKey];
                              const pErr = previewErrors[pKey];
                              return (
                                <div className="pt-1 space-y-1">
                                  {activePrv ? (
                                    <div className="flex items-center justify-between gap-2 rounded bg-zinc-900 border border-sky-500/30 px-2 py-1 text-[10px]">
                                      <a
                                        href={activePrv.url}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="inline-flex items-center gap-1 font-mono text-sky-300 hover:underline truncate"
                                      >
                                        {activePrv.url}
                                        <ExternalLink className="w-2.5 h-2.5" />
                                      </a>
                                      <button
                                        type="button"
                                        disabled={previewBusyKey === pKey}
                                        onClick={() => void handleStopPreview(pKey, activePrv.id)}
                                        className="inline-flex items-center gap-1 text-rose-300 hover:text-rose-200 shrink-0"
                                      >
                                        <Square className="w-2.5 h-2.5" />
                                        {t("preview.stopBtn")}
                                      </button>
                                    </div>
                                  ) : (
                                    <button
                                      type="button"
                                      disabled={previewBusyKey === pKey}
                                      onClick={() =>
                                        void handleLaunchPreview(pKey, item.ticketId, cand.candidateId)
                                      }
                                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-[10px] text-sky-300 disabled:opacity-50"
                                    >
                                      <Play className="w-2.5 h-2.5" />
                                      {previewBusyKey === pKey
                                        ? t("preview.starting")
                                        : t("preview.startBtn")}
                                    </button>
                                  )}
                                  {pErr && <div className="text-[10px] text-rose-400">{pErr}</div>}
                                </div>
                              );
                            })()}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                {item.kind === "epic_replan" &&
                  Boolean(item.contextPayload.proposal) && (
                    <div className="space-y-2 rounded-lg border border-purple-500/30 bg-purple-500/5 p-3">
                      <div className="text-[11px] font-semibold text-purple-300">
                        {t("inbox.epicReplanTitle")}
                      </div>
                      <div className="space-y-1.5">
                        {((item.contextPayload.proposal as EpicReplanProposal).mutations ?? []).map(
                          (m, mIdx) => (
                            <div
                              key={mIdx}
                              className="flex flex-wrap items-center gap-2 text-[11px] rounded bg-zinc-950/70 border border-zinc-800 px-2.5 py-1.5"
                            >
                              <span
                                className={`px-1.5 py-0.2 rounded font-mono text-[10px] border ${
                                  m.kind === "add_subtask"
                                    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                                    : m.kind === "skip_subtask"
                                      ? "bg-rose-500/15 text-rose-300 border-rose-500/30"
                                      : "bg-sky-500/15 text-sky-300 border-sky-500/30"
                                }`}
                              >
                                {m.kind === "add_subtask"
                                  ? "+ add"
                                  : m.kind === "skip_subtask"
                                    ? "✂ skip"
                                    : "✎ update"}
                              </span>
                              <span className="font-medium text-zinc-200">
                                {m.title ?? m.targetSubtaskKey ?? m.targetTicketId}
                              </span>
                              {m.allowedPaths && m.allowedPaths.length > 0 && (
                                <code className="text-[10px] text-emerald-300">
                                  [{m.allowedPaths.join(", ")}]
                                </code>
                              )}
                              <span className="text-zinc-400">— {m.reason}</span>
                            </div>
                          ),
                        )}
                      </div>
                    </div>
                  )}

                {clarification && (
                  <div className="space-y-2 rounded-lg border border-violet-500/35 bg-violet-500/5 p-3.5 text-xs">
                    <div className="flex items-center gap-1.5 font-semibold text-violet-200">
                      <HelpCircle className="w-3.5 h-3.5 text-violet-400" />
                      <span>{t("inbox.clarificationTitle")}</span>
                    </div>
                    <p className="text-zinc-100 font-medium">{clarification.question}</p>
                    {clarification.context && (
                      <p className="text-[11px] text-zinc-400 leading-relaxed">
                        {clarification.context}
                      </p>
                    )}
                    <div className="space-y-1.5 pt-1">
                      {clarification.options.map((opt) => {
                        const selected = activeClarifyChoice === opt;
                        const isRec = clarification.recommendedOption === opt;
                        return (
                          <button
                            key={opt}
                            type="button"
                            onClick={() =>
                              setClarifyChoices((prev) => ({ ...prev, [item.id]: opt }))
                            }
                            className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border text-left transition ${
                              selected
                                ? "border-violet-400 bg-violet-500/20 text-violet-100"
                                : "border-zinc-800 bg-zinc-950/70 text-zinc-300 hover:bg-zinc-900"
                            }`}
                          >
                            <span className="inline-flex items-center gap-2">
                              <span
                                className={`w-3 h-3 rounded-full border inline-flex items-center justify-center ${
                                  selected
                                    ? "border-violet-300 bg-violet-400"
                                    : "border-zinc-600"
                                }`}
                              />
                              <span>{opt}</span>
                            </span>
                            {isRec && (
                              <span className="px-1.5 py-0.2 rounded bg-emerald-500/15 border border-emerald-500/30 font-mono text-[10px] text-emerald-300 shrink-0">
                                ★ recommended
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2.5">
                  <input
                    type="text"
                    placeholder={t("inbox.notePlaceholder")}
                    value={notes[item.id] ?? ""}
                    onChange={(e) => setNotes((prev) => ({ ...prev, [item.id]: e.target.value }))}
                    className="flex-1 min-w-[220px] bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500"
                  />
                  <button
                    disabled={isBusy}
                    onClick={() => handleAction(item.id, "rejected")}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 text-xs font-medium disabled:opacity-50 transition"
                  >
                    <X className="w-3.5 h-3.5" />
                    {t("inbox.reject")}
                  </button>
                  {item.kind === "outbox_signoff" && (
                    <button
                      disabled={isBusy}
                      onClick={() => handleAction(item.id, "approved", "local_merge")}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-sky-500/40 bg-sky-500/15 hover:bg-sky-500/25 text-sky-200 text-xs font-medium disabled:opacity-50 transition"
                    >
                      <GitMerge className="w-3.5 h-3.5" />
                      {t("inbox.approveLocalMerge")}
                    </button>
                  )}
                  {item.kind === "mandate_violation" && item.contextPayload.canExpandMandate === true && (
                    <button
                      disabled={isBusy}
                      onClick={() =>
                        handleAction(item.id, "approved", undefined, { expandMandate: true })
                      }
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium disabled:opacity-50 transition"
                    >
                      <ShieldPlus className="w-3.5 h-3.5" />
                      {t("inbox.expandMandate")}
                    </button>
                  )}
                  {item.kind === "arena_tiebreak" &&
                  Array.isArray(item.contextPayload.candidates) ? (
                    (item.contextPayload.candidates as ArenaCandidateResult[]).map((cand) => (
                      <button
                        key={cand.candidateId}
                        disabled={isBusy}
                        onClick={() =>
                          handleAction(item.id, "approved", undefined, {
                            arenaWinnerId: cand.candidateId,
                          })
                        }
                        className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-white text-xs font-medium disabled:opacity-50 transition ${
                          cand.recommended
                            ? "bg-emerald-600 hover:bg-emerald-500"
                            : "bg-indigo-600 hover:bg-indigo-500"
                        }`}
                      >
                        <Check className="w-3.5 h-3.5" />
                        {t("inbox.arenaAdoptPrefix")} {cand.engine}
                      </button>
                    ))
                  ) : item.kind === "budget_cap" ? (
                    <button
                      disabled={isBusy}
                      onClick={() =>
                        handleAction(item.id, "approved", undefined, { budgetIncreaseUsd: 5 })
                      }
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium disabled:opacity-50 transition"
                    >
                      <DollarSign className="w-3.5 h-3.5" />
                      {t("inbox.approveBudgetBoost")}
                    </button>
                  ) : (
                    <button
                      disabled={isBusy}
                      onClick={() =>
                        handleAction(
                          item.id,
                          "approved",
                          undefined,
                          clarification && activeClarifyChoice
                            ? { selectedOption: activeClarifyChoice }
                            : undefined,
                        )
                      }
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium disabled:opacity-50 transition"
                    >
                      <Check className="w-3.5 h-3.5" />
                      {clarification
                        ? t("inbox.clarificationConfirm")
                        : item.kind === "epic_replan"
                          ? t("inbox.epicReplanApprove")
                          : item.kind === "campaign_paused"
                            ? t("campaigns.startBtn")
                            : t("inbox.approve")}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {resolved.length > 0 && (
        <div className="space-y-3 pt-4 border-t border-zinc-900">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            {t("inbox.recentTitle")}
          </h3>
          <div className="space-y-2">
            {resolved.map((item) => (
              <div
                key={item.id}
                onClick={() => onInspectTicket(item.ticketId)}
                className="flex items-center justify-between px-4 py-2.5 rounded-lg border border-zinc-800/60 bg-zinc-900/30 hover:bg-zinc-900/60 cursor-pointer text-xs"
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`px-2 py-0.5 rounded font-mono text-[10px] ${
                      item.status === "approved"
                        ? "bg-emerald-500/15 text-emerald-300"
                        : "bg-rose-500/15 text-rose-300"
                    }`}
                  >
                    {formatInboxStatus(item.status, locale)}
                  </span>
                  <span className="text-zinc-200">{item.title}</span>
                  {item.resolutionNote && (
                    <span className="text-zinc-500 italic truncate max-w-xs">
                      “{item.resolutionNote}”
                    </span>
                  )}
                </div>
                <span className="text-zinc-500 font-mono text-[11px]">{item.ticketId}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
