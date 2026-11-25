import { useEffect, useState } from "react";
import {
  Award,
  Ban,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Compass,
  Copy,
  Database,
  ExternalLink,
  FileCode2,
  FileDiff,
  FolderGit2,
  GitBranch,
  GitFork,
  GitMerge,
  GitPullRequest,
  History,
  Image,
  Layers,
  Link2,
  Lock,
  Play,
  RotateCcw,
  Search,
  Send,
  Shield,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { api } from "../api.ts";
import { DagCanvas } from "./DagCanvas.tsx";
import { DiffStudio } from "./DiffStudio.tsx";
import {
  formatOutboxStatus,
  formatStage,
  formatTicketStatus,
  useI18n,
} from "../i18n.tsx";
import type {
  ChainOfRecall,
  EnginePreference,
  HandoverDigest,
  LiveEventLogEntry,
  MemorySearchHit,
  RepoConfig,
  ReviewCommentStatus,
  ScopedVerificationInfo,
  SubmitReviewCommentsInput,
  Ticket,
  TicketDetailResponse,
  VerificationRunResult,
} from "../types.ts";

/**
 * Reads the scoped-gate record of a stage run from the live SSE trail
 * (`verification_completed` carries `{ stageRunId, result }`). Newest event wins.
 */
function scopedVerificationForRun(
  events: LiveEventLogEntry[],
  stageRunId: string,
): ScopedVerificationInfo | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!ev || ev.kind !== "verification_completed") continue;
    const raw = ev.raw as { stageRunId?: string; result?: VerificationRunResult } | undefined;
    if (raw?.stageRunId === stageRunId) return raw.result?.scopedVerification;
  }
  return undefined;
}

function HandoverDigestView({ digest }: { digest: HandoverDigest }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    const payload = digest.formattedMarkdown || digest.summary;
    if (!payload) return;
    navigator.clipboard
      ?.writeText(payload)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      })
      .catch(() => {
        setCopied(false);
      });
  };

  const hasStructuredItems =
    Boolean(digest.summary) ||
    digest.changedFiles.length > 0 ||
    digest.exportedSymbols.length > 0 ||
    digest.contractSnippets.length > 0;

  return (
    <div className="space-y-2.5 text-xs">
      <div className="flex items-start justify-between gap-2">
        {digest.summary ? (
          <p className="text-zinc-200 leading-relaxed flex-1">{digest.summary}</p>
        ) : (
          <span className="text-zinc-500 font-mono text-[11px]">
            v{digest.version} · {digest.repoName ?? digest.repoId}
          </span>
        )}
        <button
          type="button"
          onClick={handleCopy}
          className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-[11px] transition"
        >
          {copied ? (
            <>
              <Check className="w-3 h-3 text-emerald-400" />
              <span className="text-emerald-300">{t("drawer.handoverCopied")}</span>
            </>
          ) : (
            <>
              <Copy className="w-3 h-3" />
              <span>{t("drawer.handoverCopy")}</span>
            </>
          )}
        </button>
      </div>

      {digest.changedFiles.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
            {t("drawer.handoverFiles")} ({digest.changedFiles.length})
          </div>
          <div className="flex flex-wrap gap-1">
            {digest.changedFiles.map((file) => (
              <span
                key={file}
                className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 font-mono text-[11px] text-zinc-200 break-all"
              >
                {file}
              </span>
            ))}
          </div>
        </div>
      )}

      {digest.exportedSymbols.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-indigo-300/90">
            {t("drawer.handoverSymbols")} ({digest.exportedSymbols.length})
          </div>
          <div className="flex flex-wrap gap-1">
            {digest.exportedSymbols.map((sym) => (
              <span
                key={sym}
                className="px-1.5 py-0.5 rounded bg-indigo-500/10 border border-indigo-500/25 font-mono text-[11px] text-indigo-200"
              >
                {sym}
              </span>
            ))}
          </div>
        </div>
      )}

      {digest.contractSnippets.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-amber-300/90">
            {t("drawer.handoverContracts")} ({digest.contractSnippets.length})
          </div>
          <div className="space-y-1">
            {digest.contractSnippets.map((snippet, idx) => (
              <pre
                key={`${idx}-${snippet.slice(0, 24)}`}
                className="px-2 py-1 rounded bg-amber-500/10 border border-amber-500/25 font-mono text-[11px] text-amber-200 whitespace-pre-wrap break-words"
              >
                {snippet}
              </pre>
            ))}
          </div>
        </div>
      )}

      {digest.formattedMarkdown && (
        <details
          open={!hasStructuredItems}
          className="group rounded border border-zinc-800/80 bg-zinc-950/90"
        >
          <summary className="cursor-pointer select-none px-2.5 py-1.5 text-[11px] text-zinc-400 hover:text-zinc-200 flex items-center gap-1.5 list-none">
            <ChevronRight className="w-3 h-3 group-open:hidden shrink-0" />
            <ChevronDown className="w-3 h-3 hidden group-open:block shrink-0" />
            <span>{t("drawer.handoverRawToggle")}</span>
          </summary>
          <pre className="px-2.5 pb-2.5 pt-1 border-t border-zinc-800/80 text-[11px] font-mono text-zinc-300 whitespace-pre-wrap leading-relaxed overflow-x-auto">
            {digest.formattedMarkdown}
          </pre>
        </details>
      )}
    </div>
  );
}

interface DeepDiveDrawerProps {
  ticketId: string | null;
  allTickets?: Ticket[];
  repos?: RepoConfig[];
  repo?: RepoConfig;
  liveEvents: LiveEventLogEntry[];
  onClose: () => void;
  onSelectTicket?: (ticketId: string) => void;
  onRefresh: () => void;
}

type DrawerTab = "stream" | "diff" | "recall" | "outbox" | "checkpoints";

export function DeepDiveDrawer({
  ticketId,
  allTickets = [],
  repos = [],
  repo,
  liveEvents,
  onClose,
  onSelectTicket,
  onRefresh,
}: DeepDiveDrawerProps) {
  const { locale, t } = useI18n();
  const [tab, setTab] = useState<DrawerTab>("stream");
  const [detail, setDetail] = useState<TicketDetailResponse | null>(null);
  const [recall, setRecall] = useState<ChainOfRecall | null>(null);
  const [loading, setLoading] = useState(false);
  const [followUp, setFollowUp] = useState("");
  const [sendingMsg, setSendingMsg] = useState(false);
  const [delivering, setDelivering] = useState<"local_merge" | "push_and_create_pr" | null>(null);
  const [reverting, setReverting] = useState(false);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);

  const [artifactContent, setArtifactContent] = useState<{ id: string; text: string } | null>(null);
  const [searchQ, setSearchQ] = useState("");
  const [searchHits, setSearchHits] = useState<MemorySearchHit[] | null>(null);
  const [selectedArenaCandId, setSelectedArenaCandId] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [checkpointDiff, setCheckpointDiff] = useState<{ cpId: string; diff: string } | null>(null);
  const [resteerPrompt, setResteerPrompt] = useState("");
  const [checkpointBusy, setCheckpointBusy] = useState<string | null>(null);
  const [checkpointNotice, setCheckpointNotice] = useState<string | null>(null);
  const [steerInstruction, setSteerInstruction] = useState("");
  const [steerEngine, setSteerEngine] = useState<EnginePreference | "">("");
  const [steering, setSteering] = useState(false);
  const [savingEval, setSavingEval] = useState(false);
  const [evalNotice, setEvalNotice] = useState<string | null>(null);

  useEffect(() => {
    setSelectedArenaCandId(null);
    setPreviewErr(null);
    setCheckpointDiff(null);
    setCheckpointNotice(null);
    setResteerPrompt("");
    setSteerInstruction("");
    setSteerEngine("");
    setEvalNotice(null);
  }, [ticketId]);

  useEffect(() => {
    if (!ticketId) {
      setDetail(null);
      setRecall(null);
      setArtifactContent(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all([api.getTicketDetail(ticketId), api.getRecall(ticketId)])
      .then(([d, r]) => {
        if (!cancelled) {
          setDetail(d);
          setRecall(r.chain);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ticketId, liveEvents.length]);

  useEffect(() => {
    if (!ticketId) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [ticketId, onClose]);

  if (!ticketId) return null;

  const ticket = detail?.ticket;
  const ticketLiveEvents = liveEvents.filter((e) => e.ticketId === ticketId);

  const handleSendFollowUp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!followUp.trim()) return;
    setSendingMsg(true);
    try {
      await api.sendThreadMessage(ticketId, followUp.trim());
      setFollowUp("");
      const [d, r] = await Promise.all([api.getTicketDetail(ticketId), api.getRecall(ticketId)]);
      setDetail(d);
      setRecall(r.chain);
      onRefresh();
    } finally {
      setSendingMsg(false);
    }
  };

  const handleCancel = async () => {
    await api.cancelTicket(ticketId);
    const d = await api.getTicketDetail(ticketId);
    setDetail(d);
    onRefresh();
  };

  const handleCleanupWorktree = async () => {
    await api.cleanupTicketWorktree(ticketId);
    const d = await api.getTicketDetail(ticketId);
    setDetail(d);
    onRefresh();
  };

  const handleDeliver = async (action: "local_merge" | "push_and_create_pr") => {
    setDelivering(action);
    setDeliveryError(null);
    try {
      await api.deliverTicket(ticketId, action);
      const [d, r] = await Promise.all([api.getTicketDetail(ticketId), api.getRecall(ticketId)]);
      setDetail(d);
      setRecall(r.chain);
      onRefresh();
    } catch (err) {
      setDeliveryError(err instanceof Error ? err.message : String(err));
    } finally {
      setDelivering(null);
    }
  };

  const handleRevert = async () => {
    setReverting(true);
    setDeliveryError(null);
    try {
      await api.revertTicket(ticketId);
      const [d, r] = await Promise.all([api.getTicketDetail(ticketId), api.getRecall(ticketId)]);
      setDetail(d);
      setRecall(r.chain);
      onRefresh();
    } catch (err) {
      setDeliveryError(err instanceof Error ? err.message : String(err));
    } finally {
      setReverting(false);
    }
  };

  const handleSendFileFeedback = async (filePath: string, comment: string) => {
    await api.sendThreadMessage(ticketId, `[File: ${filePath}] ${comment}`);
    const [d, r] = await Promise.all([api.getTicketDetail(ticketId), api.getRecall(ticketId)]);
    setDetail(d);
    setRecall(r.chain);
    onRefresh();
  };

  const handleSubmitReview = async (input: SubmitReviewCommentsInput) => {
    await api.submitReviewComments(ticketId, input);
    const [d, r] = await Promise.all([api.getTicketDetail(ticketId), api.getRecall(ticketId)]);
    setDetail(d);
    setRecall(r.chain);
    onRefresh();
  };

  const handleToggleCommentStatus = async (commentId: string, status: ReviewCommentStatus) => {
    await api.updateReviewCommentStatus(commentId, status);
    const d = await api.getTicketDetail(ticketId);
    setDetail(d);
  };

  const handleLiveSteer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!steerInstruction.trim()) return;
    setSteering(true);
    setDeliveryError(null);
    try {
      await api.steerTicket(ticketId, {
        instruction: steerInstruction.trim(),
        preferredEngine: steerEngine || undefined,
      });
      setSteerInstruction("");
      setSteerEngine("");
      const [d, r] = await Promise.all([api.getTicketDetail(ticketId), api.getRecall(ticketId)]);
      setDetail(d);
      setRecall(r.chain);
      onRefresh();
    } catch (err) {
      setDeliveryError(err instanceof Error ? err.message : String(err));
    } finally {
      setSteering(false);
    }
  };

  const handleSaveEval = async () => {
    if (!ticket) return;
    setSavingEval(true);
    setDeliveryError(null);
    setEvalNotice(null);
    try {
      const res = await api.saveEvalCaseFromTicket(ticket.id);
      setEvalNotice(`Golden Eval saved: ${res.evalCase.id} (${res.evalCase.title})`);
    } catch (err) {
      setDeliveryError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingEval(false);
    }
  };

  const reposById = new Map(repos.map((r) => [r.id, r]));
  const childSubtasks =
    detail?.subtasks ??
    (ticket?.isEpic ? allTickets.filter((c) => c.parentTicketId === ticket.id) : []);
  const parentEpic = ticket?.parentTicketId
    ? allTickets.find((p) => p.id === ticket.parentTicketId)
    : undefined;
  const isUnifiedSubtask = Boolean(
    parentEpic?.isEpic && parentEpic.epicDeliveryMode !== "per_subtask",
  );
  const hasMergedLocally = Boolean(
    detail?.outboxEntries.some((e) => e.action === "local_merge" && e.status === "sent"),
  );
  const hasPushedPr = Boolean(
    ticket?.prNumber ||
      detail?.outboxEntries.some(
        (e) =>
          e.action === "push_and_create_pr" &&
          e.status === "sent" &&
          (e.resultPayload as { mode?: string } | undefined)?.mode === "github_pr",
      ),
  );
  const canDeliverActions = Boolean(
    ticket &&
      (!ticket.isEpic || ticket.epicDeliveryMode !== "per_subtask") &&
      !isUnifiedSubtask &&
      ticket.branchName &&
      (ticket.status === "delivered" || ticket.status === "outbox_pending") &&
      !hasMergedLocally,
  );

  const handleLoadArtifact = async (id: string) => {
    if (artifactContent?.id === id) {
      setArtifactContent(null);
      return;
    }
    const res = await api.getArtifact(id);
    setArtifactContent({ id, text: res.content });
  };

  const handleMemorySearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQ.trim()) {
      setSearchHits(null);
      return;
    }
    const res = await api.searchMemory(searchQ.trim(), ticket?.repoId);
    setSearchHits(res.hits);
  };

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/60 backdrop-blur-xs"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-3xl bg-zinc-950 border-l border-zinc-800 h-full flex flex-col shadow-2xl">
        {/* Header */}
        <div className="px-5 py-4 border-b border-zinc-800 flex items-start justify-between gap-4">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-mono text-indigo-400">{ticketId}</span>
              {ticket && (
                <>
                  <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-200">
                    {formatTicketStatus(ticket.status, locale)}
                  </span>
                  {ticket.branchName && (
                    <span className="inline-flex items-center gap-1 text-[11px] font-mono text-zinc-400">
                      <GitBranch className="w-3 h-3" />
                      {ticket.branchName}
                    </span>
                  )}
                  {ticket.prNumber && (
                    ticket.prUrl ? (
                      <a
                        href={ticket.prUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-500/15 border border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/25"
                      >
                        <GitPullRequest className="w-2.5 h-2.5" />
                        PR #{ticket.prNumber}
                      </a>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-500/15 border border-cyan-500/30 text-cyan-300">
                        <GitPullRequest className="w-2.5 h-2.5" />
                        PR #{ticket.prNumber}
                      </span>
                    )
                  )}
                  {ticket.parentTicketId && (
                    <button
                      type="button"
                      onClick={() => onSelectTicket?.(ticket.parentTicketId!)}
                      className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-purple-500/15 border border-purple-500/30 text-purple-300 hover:bg-purple-500/25"
                    >
                      <Layers className="w-2.5 h-2.5" />
                      {t("drawer.parentEpicPrefix")} {ticket.parentTicketId}
                    </button>
                  )}
                  {hasMergedLocally && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300">
                      <CheckCircle2 className="w-2.5 h-2.5" />
                      {t("drawer.localMergedTag")}
                    </span>
                  )}
                  {ticket.revertedAt && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-amber-300">
                      <RotateCcw className="w-2.5 h-2.5" />
                      {t("drawer.revertedBadge")}{" "}
                      {ticket.revertCommitSha ? `(${ticket.revertCommitSha.slice(0, 7)})` : ""}
                    </span>
                  )}
                  {ticket.worktreePath ? (
                    <span className="inline-flex items-center gap-1.5 text-[10px] font-mono px-2 py-0.5 rounded bg-sky-500/10 border border-sky-500/30 text-sky-300">
                      {t("drawer.worktreeActive")}
                      {["delivered", "failed", "cancelled"].includes(ticket.status) && (
                        <button
                          type="button"
                          onClick={() => void handleCleanupWorktree()}
                          className="inline-flex items-center gap-1 pl-1.5 border-l border-sky-500/30 text-amber-300 hover:text-amber-200"
                        >
                          <Trash2 className="w-2.5 h-2.5" />
                          {t("drawer.reclaimWorktree")}
                        </button>
                      )}
                    </span>
                  ) : ticket.worktreeCleanedAt ? (
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-500">
                      {t("drawer.worktreeCleaned")}
                    </span>
                  ) : null}
                </>
              )}
            </div>
            <h2 className="text-base font-semibold text-zinc-100 truncate">
              {ticket?.title ?? (loading ? t("drawer.loading") : ticketId)}
            </h2>
          </div>

          <div className="flex items-center gap-2 flex-wrap justify-end">
            {ticket?.worktreePath && (() => {
              const activePrv = detail?.previews?.find(
                (p) => p.status === "starting" || p.status === "ready",
              );
              if (activePrv) {
                return (
                  <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-sky-500/40 bg-sky-500/10 text-xs">
                    <a
                      href={activePrv.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 font-mono text-[11px] text-sky-200 hover:underline"
                    >
                      <ExternalLink className="w-3 h-3" />
                      {t("preview.openBtn")} ({activePrv.port})
                    </a>
                    <button
                      type="button"
                      disabled={previewBusy}
                      onClick={() => {
                        setPreviewBusy(true);
                        void api
                          .stopPreview(activePrv.id)
                          .then(() => api.getTicketDetail(ticket.id))
                          .then((d) => {
                            setDetail(d);
                            onRefresh();
                          })
                          .finally(() => setPreviewBusy(false));
                      }}
                      className="pl-1.5 border-l border-sky-500/30 text-rose-300 hover:text-rose-200 inline-flex items-center gap-1"
                    >
                      <Square className="w-2.5 h-2.5" />
                      {t("preview.stopBtn")}
                    </button>
                  </div>
                );
              }
              return (
                <button
                  type="button"
                  disabled={previewBusy}
                  onClick={() => {
                    setPreviewBusy(true);
                    setPreviewErr(null);
                    void api
                      .startPreview({ ticketId: ticket.id })
                      .then(() => api.getTicketDetail(ticket.id))
                      .then((d) => {
                        setDetail(d);
                        onRefresh();
                      })
                      .catch((err) =>
                        setPreviewErr(err instanceof Error ? err.message : String(err)),
                      )
                      .finally(() => setPreviewBusy(false));
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-sky-500/40 bg-sky-500/15 text-sky-200 hover:bg-sky-500/25 text-xs disabled:opacity-50"
                >
                  <Play className="w-3 h-3" />
                  {previewBusy ? t("preview.starting") : t("preview.startBtn")}
                </button>
              );
            })()}
            {hasMergedLocally && !ticket?.revertedAt && (
              <button
                type="button"
                disabled={reverting}
                onClick={() => void handleRevert()}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-amber-500/40 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25 text-xs disabled:opacity-50"
              >
                <RotateCcw className={`w-3 h-3 ${reverting ? "animate-spin" : ""}`} />
                {reverting ? t("drawer.reverting") : t("drawer.revertButton")}
              </button>
            )}
            {canDeliverActions && (
              <button
                type="button"
                disabled={delivering !== null}
                onClick={() => void handleDeliver("local_merge")}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-emerald-500/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25 text-xs disabled:opacity-50"
              >
                <GitMerge className="w-3 h-3" />
                {delivering === "local_merge" ? t("drawer.merging") : t("drawer.localMergeButton")}
              </button>
            )}
            {canDeliverActions && repo?.githubRepo && !hasPushedPr && (
              <button
                type="button"
                disabled={delivering !== null}
                onClick={() => void handleDeliver("push_and_create_pr")}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-indigo-500/40 bg-indigo-500/15 text-indigo-200 hover:bg-indigo-500/25 text-xs disabled:opacity-50"
              >
                <GitPullRequest className="w-3 h-3" />
                {delivering === "push_and_create_pr"
                  ? t("drawer.pushingPr")
                  : t("drawer.pushPrButton")}
              </button>
            )}
            {ticket && ticket.status === "delivered" && !ticket.isEpic && (
              <button
                type="button"
                disabled={savingEval}
                onClick={() => void handleSaveEval()}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-teal-500/40 bg-teal-500/15 text-teal-200 hover:bg-teal-500/25 text-xs disabled:opacity-50"
              >
                <Award className="w-3 h-3" />
                {t("drawer.saveEvalBtn")}
              </button>
            )}
            {ticket && !["delivered", "cancelled", "failed"].includes(ticket.status) && (
              <button
                onClick={handleCancel}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-rose-500/30 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 text-xs"
              >
                <Ban className="w-3 h-3" />
                {t("drawer.cancelTask")}
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Tabs */}
        {previewErr && (
          <div className="px-5 py-2 bg-rose-500/10 border-b border-rose-500/20 text-[11px] text-rose-300">
            {previewErr}
          </div>
        )}
        <div className="px-5 border-b border-zinc-800 flex items-center gap-1 bg-zinc-950">
          {[
            { id: "stream" as const, label: t("drawer.tab.stream"), icon: Terminal },
            { id: "diff" as const, label: t("drawer.tab.diff"), icon: FileDiff },
            { id: "recall" as const, label: t("drawer.tab.recall"), icon: History },
            {
              id: "outbox" as const,
              label: `${t("drawer.tab.outbox")} (${detail?.outboxEntries.length ?? 0})`,
              icon: Database,
            },
            {
              id: "checkpoints" as const,
              label: `${t("drawer.tab.checkpoints")} (${detail?.checkpoints?.length ?? 0})`,
              icon: Clock,
            },
          ].map((tabItem) => {
            const Icon = tabItem.icon;
            const active = tab === tabItem.id;
            return (
              <button
                key={tabItem.id}
                onClick={() => setTab(tabItem.id)}
                className={`inline-flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 transition ${
                  active
                    ? "border-indigo-500 text-indigo-300"
                    : "border-transparent text-zinc-500 hover:text-zinc-300"
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {tabItem.label}
              </button>
            );
          })}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {tab === "stream" && (
            <div className="space-y-5">
              {ticket?.errorMessage && (
                <div className="p-3 rounded-lg border border-rose-500/30 bg-rose-500/10 text-xs text-rose-200">
                  <strong>{t("drawer.attention")}</strong> {ticket.errorMessage}
                </div>
              )}
              {deliveryError && (
                <div className="p-3 rounded-lg border border-rose-500/30 bg-rose-500/10 text-xs text-rose-200">
                  <strong>{t("drawer.attention")}</strong> {deliveryError}
                </div>
              )}
              {evalNotice && (
                <div className="p-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-xs text-emerald-200">
                  {evalNotice}
                </div>
              )}

              {ticket &&
                ["planning", "spec_testing", "implementing", "reviewing"].includes(
                  ticket.status,
                ) && (
                  <form
                    onSubmit={handleLiveSteer}
                    className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3 space-y-2 text-xs"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Compass className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                      <input
                        type="text"
                        value={steerInstruction}
                        onChange={(e) => setSteerInstruction(e.target.value)}
                        placeholder={t("drawer.liveSteerPlaceholder")}
                        className="flex-1 min-w-[200px] bg-zinc-950 border border-zinc-800 rounded-md px-2.5 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-sky-500"
                      />
                      <select
                        value={steerEngine}
                        onChange={(e) => setSteerEngine(e.target.value as EnginePreference | "")}
                        className="bg-zinc-950 border border-zinc-800 rounded-md px-2 py-1.5 text-[11px] font-mono text-zinc-300"
                      >
                        <option value="">keep engine</option>
                        <option value="auto">auto</option>
                        <option value="claude">claude</option>
                        <option value="codex">codex</option>
                        <option value="opencode">opencode</option>
                        <option value="gemini">gemini</option>
                        <option value="mock">mock</option>
                      </select>
                      <button
                        type="submit"
                        disabled={steering || !steerInstruction.trim()}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-sky-600 hover:bg-sky-500 text-white text-[11px] font-medium disabled:opacity-40 transition"
                      >
                        <Compass className="w-3 h-3" />
                        {t("drawer.liveSteerBtn")}
                      </button>
                    </div>
                  </form>
                )}

              {ticket &&
                (ticket.routingRationale ||
                  (ticket.lockedTestPaths && ticket.lockedTestPaths.length > 0) ||
                  ticket.impactSummary) && (
                  <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 text-xs space-y-2">
                    {ticket.routingRationale && (
                      <div className="flex items-start gap-2">
                        <Sparkles className="w-3.5 h-3.5 text-indigo-400 shrink-0 mt-0.5" />
                        <div>
                          <span className="text-zinc-400 font-medium mr-1.5">
                            {t("drawer.routingRationaleLabel")}:
                          </span>
                          <span className="text-zinc-200 font-mono text-[11px]">
                            {ticket.routingRationale}
                          </span>
                        </div>
                      </div>
                    )}
                    {ticket.lockedTestPaths && ticket.lockedTestPaths.length > 0 && (
                      <div className="flex items-start gap-2">
                        <Lock className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" />
                        <div>
                          <span className="text-zinc-400 font-medium mr-1.5">
                            {t("drawer.lockedTestsLabel")}:
                          </span>
                          <span className="text-rose-200 font-mono text-[11px]">
                            {ticket.lockedTestPaths.join(", ")}
                          </span>
                        </div>
                      </div>
                    )}
                    {ticket.impactSummary && (
                      <div className="flex items-start gap-2">
                        <GitFork className="w-3.5 h-3.5 text-cyan-400 shrink-0 mt-0.5" />
                        <div>
                          <span className="text-zinc-400 font-medium mr-1.5">
                            {t("drawer.impactSummaryLabel")}:
                          </span>
                          <span className="text-cyan-200 font-mono text-[11px]">
                            {ticket.impactSummary.directDependents.join(", ") || "—"} /{" "}
                            {ticket.impactSummary.transitiveDependents.join(", ") || "—"}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                )}

              {ticket?.isEpic && (ticket.epicReplanHistory?.length || ticket.pendingEpicReplan) && (
                <div className="rounded-lg border border-purple-500/30 bg-purple-500/5 p-3 text-xs space-y-1.5">
                  <div className="font-semibold text-purple-300 flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5" />
                    {t("drawer.epicReplanSection")} ({ticket.epicReplanHistory?.length ?? 0}/2)
                  </div>
                  {ticket.pendingEpicReplan && (
                    <p className="text-amber-300 text-[11px]">
                      ⏳ {ticket.pendingEpicReplan.summary}
                    </p>
                  )}
                  {ticket.epicReplanHistory?.map((rep, idx) => (
                    <p key={idx} className="text-zinc-300 text-[11px]">
                      #{idx + 1} · {rep.summary}
                    </p>
                  ))}
                </div>
              )}

              {ticket?.isEpic && childSubtasks.length > 0 && (
                <div className="space-y-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-purple-300 flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5" />
                    {t("drawer.epicDagTitle")} ({childSubtasks.length})
                  </h3>
                  <DagCanvas
                    tickets={childSubtasks}
                    repos={repos}
                    onInspectTicket={(id) => onSelectTicket?.(id)}
                    onMutated={() => {
                      if (ticketId) {
                        api.getTicketDetail(ticketId).then(setDetail).catch(() => {});
                      }
                      onRefresh();
                    }}
                  />
                  <div className="space-y-2">
                    {childSubtasks.map((sub) => {
                      const subRepoName = reposById.get(sub.repoId)?.name;
                      return (
                        <div
                          key={sub.id}
                          onClick={() => onSelectTicket?.(sub.id)}
                          className="rounded-lg border border-zinc-800 bg-zinc-900/60 hover:border-indigo-500/50 p-3 text-xs flex items-center justify-between gap-3 cursor-pointer transition"
                        >
                          <div className="min-w-0 space-y-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              {sub.subtaskKey && (
                                <span className="px-1.5 py-0.5 rounded bg-purple-500/15 border border-purple-500/30 text-purple-200 font-mono text-[10px]">
                                  {sub.subtaskKey}
                                </span>
                              )}
                              {subRepoName && (repos.length > 1 || sub.repoId !== ticket.repoId) && (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-sky-500/15 border border-sky-500/30 text-sky-300 font-mono text-[10px]">
                                  <FolderGit2 className="w-2.5 h-2.5" />
                                  {subRepoName}
                                </span>
                              )}
                              <span className="font-medium text-zinc-100 truncate">{sub.title}</span>
                            </div>
                            <div className="text-[10px] font-mono text-zinc-400">
                              {sub.mandate.allowedPaths.join(", ")}
                              {sub.dependsOn.length > 0
                                ? ` · deps: ${sub.dependsOn.join(", ")}`
                                : ""}
                            </div>
                          </div>
                          <span className="shrink-0 px-2 py-0.5 rounded bg-zinc-800 border border-zinc-700 font-mono text-[10px] text-zinc-200">
                            {formatTicketStatus(sub.status, locale)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {(detail?.upstreamDependencies?.length ?? 0) > 0 && (
                <div className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-teal-300 flex items-center gap-1.5">
                    <Link2 className="w-3.5 h-3.5" />
                    {t("drawer.upstreamHandoverTitle")} ({detail!.upstreamDependencies!.length})
                  </h3>
                  <div className="space-y-2">
                    {detail!.upstreamDependencies!.map((dep) => (
                      <div
                        key={dep.id}
                        className="rounded-lg border border-teal-500/25 bg-teal-500/5 p-3 text-xs space-y-2"
                      >
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <button
                            type="button"
                            onClick={() => onSelectTicket?.(dep.id)}
                            className="inline-flex items-center gap-1.5 text-left font-medium text-teal-200 hover:text-teal-100"
                          >
                            <span className="px-1.5 py-0.5 rounded bg-sky-500/15 border border-sky-500/30 font-mono text-[10px] text-sky-300">
                              {dep.repoName ?? dep.repoId}
                            </span>
                            <span>{dep.title}</span>
                            <span className="font-mono text-[10px] text-zinc-400">({dep.id})</span>
                          </button>
                          <span className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 font-mono text-[10px] text-zinc-300">
                            {formatTicketStatus(dep.status, locale)}
                          </span>
                        </div>
                        {dep.handoverDigest && (
                          <HandoverDigestView digest={dep.handoverDigest} />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {ticket?.handoverDigest && (
                <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/5 p-3.5 text-xs space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-indigo-300 flex items-center gap-1.5">
                      <FileCode2 className="w-3.5 h-3.5" />
                      {t("drawer.exportedHandoverTitle")}
                    </span>
                    <span className="px-1.5 py-0.5 rounded bg-indigo-500/15 border border-indigo-500/30 font-mono text-[10px] text-indigo-200">
                      v{ticket.handoverDigest.version}
                    </span>
                  </div>
                  <HandoverDigestView digest={ticket.handoverDigest} />
                </div>
              )}

              {ticket?.riskAssessment && (
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 text-xs space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-zinc-200">{t("drawer.riskTitle")}</span>
                    <span
                      className={`px-2 py-0.5 rounded border font-mono text-[10px] ${
                        ticket.riskAssessment.level === "high"
                          ? "border-rose-500/40 bg-rose-500/15 text-rose-300"
                          : ticket.riskAssessment.level === "medium"
                            ? "border-amber-500/40 bg-amber-500/15 text-amber-200"
                            : "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                      }`}
                    >
                      {ticket.riskAssessment.score}/100 ({ticket.riskAssessment.level}) · {ticket.riskAssessment.policy}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {ticket.riskAssessment.factors.map((f) => (
                      <span
                        key={f.key}
                        className={`px-1.5 py-0.5 rounded border font-mono text-[10px] ${
                          f.delta > 0
                            ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
                            : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                        }`}
                      >
                        {f.delta > 0 ? `+${f.delta}` : f.delta} {f.label}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {ticket?.conflictContext && (
                <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3 text-xs space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-sky-200">{t("drawer.conflictTitle")}</span>
                    <span
                      className={`px-1.5 py-0.5 rounded border font-mono text-[10px] ${
                        ticket.conflictContext.resolvedAutomatically
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                          : "border-amber-500/30 bg-amber-500/10 text-amber-200"
                      }`}
                    >
                      {ticket.conflictContext.resolvedAutomatically
                        ? t("drawer.conflictAutoResolved")
                        : t("drawer.conflictEscalated")}
                    </span>
                  </div>
                  <div className="font-mono text-[10px] text-zinc-400">
                    {ticket.conflictContext.baseBranch} ({ticket.conflictContext.mergeBaseSha.slice(0, 8)}) ·{" "}
                    {ticket.conflictContext.conflictFiles.join(", ")}
                  </div>
                  {ticket.conflictContext.resolutionSummary && (
                    <p className="text-[11px] text-zinc-300">{ticket.conflictContext.resolutionSummary}</p>
                  )}
                </div>
              )}

              <div className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  {t("drawer.stageRunsTitle")}
                </h3>
                {detail?.stageRuns.length === 0 ? (
                  <p className="text-xs text-zinc-500">{t("drawer.noStageRuns")}</p>
                ) : (
                  <div className="space-y-2">
                    {detail?.stageRuns.map((run) => {
                      const spans = run.spans ?? [];
                      const scopedGate = scopedVerificationForRun(ticketLiveEvents, run.id);
                      const totalSpanMs = Math.max(
                        1,
                        spans.reduce((acc, sp) => acc + Math.max(1, sp.durationMs), 0),
                      );
                      const spanBarColor = (kind: string, status: string) => {
                        if (status === "failed") return "bg-rose-500";
                        if (kind === "workspace_prep") return "bg-slate-400";
                        if (kind === "worker_turn") return "bg-indigo-500";
                        if (kind === "static_verify") return "bg-emerald-500";
                        if (kind === "smoke_cdp") return "bg-cyan-500";
                        if (kind === "visual_diff") return "bg-amber-500";
                        return "bg-sky-400";
                      };

                      return (
                        <div
                          key={run.id}
                          className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 text-xs space-y-1.5"
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className="font-mono font-semibold text-indigo-300">
                                {formatStage(run.stage, locale)}
                              </span>
                              <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 font-mono text-[10px]">
                                {run.engine}
                              </span>
                              <span
                                className={`px-1.5 py-0.5 rounded font-mono text-[10px] ${
                                  run.status === "completed"
                                    ? "bg-emerald-500/15 text-emerald-300"
                                    : run.status === "running"
                                      ? "bg-amber-500/15 text-amber-300"
                                      : run.steered
                                        ? "bg-sky-500/15 text-sky-300"
                                        : "bg-rose-500/15 text-rose-300"
                                }`}
                              >
                                {run.steered ? "steered" : run.status}
                              </span>
                              {scopedGate?.usedScoped && (
                                <span
                                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 font-mono text-[10px]"
                                  title={[scopedGate.reason, ...scopedGate.commandsRun].join("\n")}
                                >
                                  <Zap className="w-3 h-3" />
                                  {t("drawer.scopedGate")}
                                  {(scopedGate.estimatedSavedMs ?? 0) > 0 && (
                                    <span>
                                      {" · "}
                                      {t("drawer.scopedGateSaved")}
                                      {Math.round((scopedGate.estimatedSavedMs ?? 0) / 1000)}s
                                    </span>
                                  )}
                                </span>
                              )}
                            </div>
                            <span className="font-mono text-zinc-500">${run.costUsd.toFixed(3)}</span>
                          </div>
                          {spans.length > 0 && (
                            <div className="space-y-1 pt-0.5">
                              <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500">
                                <span>{t("drawer.spansTitle")}</span>
                                <span>{(totalSpanMs / 1000).toFixed(2)}s</span>
                              </div>
                              <div className="w-full h-2 rounded-full bg-zinc-950 border border-zinc-800 overflow-hidden flex gap-px">
                                {spans.map((sp, idx) => (
                                  <div
                                    key={`${sp.kind}_${idx}`}
                                    title={`${sp.label}: ${sp.durationMs}ms (${sp.status})`}
                                    style={{
                                      width: `${Math.max(4, (Math.max(1, sp.durationMs) / totalSpanMs) * 100)}%`,
                                    }}
                                    className={`h-full ${spanBarColor(sp.kind, sp.status)}`}
                                  />
                                ))}
                              </div>
                              <div className="flex flex-wrap gap-1.5">
                                {spans.map((sp, idx) => (
                                  <span
                                    key={`${sp.kind}_lbl_${idx}`}
                                    className="px-1.5 py-0.2 rounded bg-zinc-950 border border-zinc-800 font-mono text-[10px] text-zinc-400"
                                  >
                                    {sp.kind}:{sp.durationMs}ms
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                          {run.toolProfile && run.toolProfile.totalToolCalls > 0 && (
                            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                              <span className="inline-flex items-center gap-1 text-[10px] font-mono text-zinc-500">
                                <Wrench className="w-2.5 h-2.5 text-zinc-400" />
                                {t("drawer.toolProfileTitle")}:
                              </span>
                              {run.toolProfile.byTool.slice(0, 8).map((tp) => (
                                <span
                                  key={tp.toolName}
                                  title={tp.sampleError ?? `${tp.approxDurationMs}ms`}
                                  className={`px-1.5 py-0.2 rounded border font-mono text-[10px] ${
                                    tp.errors > 0
                                      ? "border-rose-500/35 bg-rose-500/10 text-rose-300"
                                      : "border-zinc-800 bg-zinc-950 text-zinc-300"
                                  }`}
                                >
                                  {tp.toolName} ×{tp.calls}
                                  {tp.errors > 0 ? ` (${tp.errors} err)` : ""}
                                </span>
                              ))}
                            </div>
                          )}
                          {run.summary && (
                            <p className="text-zinc-300 whitespace-pre-wrap leading-relaxed">
                              {run.summary}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  {t("drawer.liveEventsTitle")}
                </h3>
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3 font-mono text-[11px] space-y-1.5 max-h-80 overflow-y-auto">
                  {ticketLiveEvents.length === 0 ? (
                    <span className="text-zinc-600">
                      {t("drawer.listeningEvents")}
                    </span>
                  ) : (
                    ticketLiveEvents.map((ev) => (
                      <div key={ev.id} className="flex gap-2">
                        <span className="text-zinc-600 shrink-0">
                          {ev.timestamp.slice(11, 19)}
                        </span>
                        <span className="text-indigo-400 shrink-0">[{ev.kind}]</span>
                        <span className="text-zinc-300 break-all">{ev.summary}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}

          {tab === "diff" && ticket && (
            <div className="space-y-4">
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 space-y-2 text-xs">
                <div className="flex items-center gap-2 font-semibold text-zinc-200">
                  <Shield className="w-4 h-4 text-emerald-400" />
                  {t("drawer.mandateTitle")}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                  <div>
                    <span className="text-zinc-500 block mb-1">{t("drawer.allowedPaths")}</span>
                    <div className="flex flex-wrap gap-1">
                      {ticket.mandate.allowedPaths.map((p) => (
                        <code
                          key={p}
                          className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20"
                        >
                          {p}
                        </code>
                      ))}
                    </div>
                  </div>
                  <div>
                    <span className="text-zinc-500 block mb-1">{t("drawer.forbiddenPaths")}</span>
                    <div className="flex flex-wrap gap-1">
                      {ticket.mandate.forbiddenPaths.map((p) => (
                        <code
                          key={p}
                          className="px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-300 border border-rose-500/20"
                        >
                          {p}
                        </code>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {ticket.arenaCandidates && ticket.arenaCandidates.length > 0 && (
                <div className="rounded-lg border border-teal-500/30 bg-teal-500/5 p-3 space-y-2 text-xs">
                  <div className="text-[11px] font-semibold text-teal-300">
                    {t("drawer.arenaDiffTitle")}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {ticket.arenaCandidates.map((cand) => {
                      const activeCandId =
                        selectedArenaCandId ??
                        ticket.arenaWinnerId ??
                        ticket.arenaCandidates!.find((c) => c.recommended)?.candidateId ??
                        ticket.arenaCandidates![0]!.candidateId;
                      const selected = activeCandId === cand.candidateId;
                      const isWinner = ticket.arenaWinnerId === cand.candidateId;
                      return (
                        <button
                          key={cand.candidateId}
                          type="button"
                          onClick={() => setSelectedArenaCandId(cand.candidateId)}
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border font-mono text-[11px] transition ${
                            selected
                              ? "border-teal-400 bg-teal-500/20 text-teal-100"
                              : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200"
                          }`}
                        >
                          <span>{cand.engine}</span>
                          <span className="text-zinc-400">({cand.score}pts)</span>
                          <span>
                            +{cand.addedLines}/-{cand.deletedLines}
                          </span>
                          {isWinner && (
                            <span className="px-1 rounded bg-emerald-500/20 text-emerald-300 text-[10px]">
                              {t("drawer.arenaWinnerTag")}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  {t("drawer.diffTitle")}
                </h3>
                <DiffStudio
                  diff={(() => {
                    if (ticket.arenaCandidates && ticket.arenaCandidates.length > 0 && detail?.arenaCandidateDiffs) {
                      const activeCandId =
                        selectedArenaCandId ??
                        ticket.arenaWinnerId ??
                        ticket.arenaCandidates.find((c) => c.recommended)?.candidateId ??
                        ticket.arenaCandidates[0]!.candidateId;
                      return detail.arenaCandidateDiffs[activeCandId] ?? detail?.diff ?? "";
                    }
                    return detail?.diff ?? "";
                  })()}
                  stageNotes={ticket.inlineMemory.stageNotes}
                  reviewComments={detail?.reviewComments}
                  onSendFileFeedback={handleSendFileFeedback}
                  onSubmitReview={handleSubmitReview}
                  onToggleCommentStatus={handleToggleCommentStatus}
                />
              </div>
            </div>
          )}

          {tab === "recall" && recall && (
            <div className="space-y-5">
              {/* FTS5 Search */}
              <form onSubmit={handleMemorySearch} className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-2.5" />
                  <input
                    type="text"
                    value={searchQ}
                    onChange={(e) => setSearchQ(e.target.value)}
                    placeholder={t("drawer.searchPlaceholder")}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-8 pr-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <button
                  type="submit"
                  className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-200"
                >
                  {t("drawer.recallButton")}
                </button>
              </form>

              {searchHits && (
                <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/5 p-3 space-y-2">
                  <div className="text-[11px] font-semibold text-indigo-300">
                    {t("drawer.ftsHitsTitle")} ({searchHits.length})
                  </div>
                  {searchHits.map((hit, idx) => (
                    <div key={idx} className="text-xs border-t border-zinc-800/60 pt-1.5">
                      <span className="font-mono text-zinc-400">[{hit.ticketId}]</span>{" "}
                      <span className="text-zinc-200 font-medium">{hit.title}</span>
                      <p className="text-zinc-400 text-[11px] mt-0.5">{hit.snippet}</p>
                    </div>
                  ))}
                </div>
              )}

              {recall.matchedCases && recall.matchedCases.length > 0 && (
                <div className="space-y-2 text-xs">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-teal-300">
                    {t("drawer.recallCasebookTitle")} ({recall.matchedCases.length})
                  </h3>
                  <div className="space-y-2">
                    {recall.matchedCases.map((c) => (
                      <div
                        key={c.id}
                        className={`rounded-lg border p-3 space-y-1 ${
                          c.reverted
                            ? "border-rose-500/35 bg-rose-500/5"
                            : "border-teal-500/25 bg-teal-500/5"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-zinc-100">{c.title}</span>
                          <span
                            className={`px-1.5 py-0.2 rounded font-mono text-[10px] ${
                              c.reverted
                                ? "bg-rose-500/20 text-rose-300"
                                : "bg-emerald-500/15 text-emerald-300"
                            }`}
                          >
                            {c.reverted
                              ? t("modal.repoSettings.casebookRevertedBadge")
                              : t("modal.repoSettings.casebookVerifiedBadge")}
                          </span>
                        </div>
                        <p className="text-zinc-300 text-[11px]">{c.solutionSummary}</p>
                        {c.pitfallsAndFixes && (
                          <p className="text-amber-300 text-[11px]">{c.pitfallsAndFixes}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Lineage: Trigger -> Thread -> Inline -> Spill */}
              <div className="space-y-3 text-xs">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  {t("drawer.lineageTitle")}
                </h3>
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 space-y-2">
                  <div>
                    <span className="text-zinc-500">{t("drawer.originTrigger")}</span>{" "}
                    <span className="font-mono text-zinc-300">
                      {recall.trigger?.source} ({recall.thread?.threadKey})
                    </span>
                  </div>
                  {recall.ticket.inlineMemory.planSummary && (
                    <div>
                      <span className="text-zinc-500 block">{t("drawer.planSummary")}</span>
                      <p className="text-zinc-300 mt-0.5 whitespace-pre-wrap">
                        {recall.ticket.inlineMemory.planSummary}
                      </p>
                    </div>
                  )}
                  {recall.ticket.inlineMemory.threadUpdates.length > 0 && (
                    <div>
                      <span className="text-zinc-500 block">{t("drawer.threadUpdates")}</span>
                      <ul className="list-disc pl-4 text-zinc-300 mt-1 space-y-1">
                        {recall.ticket.inlineMemory.threadUpdates.map((u) => (
                          <li key={u.triggerId}>
                            <span className="font-mono text-zinc-500 text-[10px]">
                              {u.createdAt.slice(11, 19)}
                            </span>{" "}
                            {u.message}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 pt-2">
                  {t("drawer.spillTitle")}
                </h3>
                {recall.artifacts.length === 0 ? (
                  <p className="text-zinc-500">{t("drawer.noSpill")}</p>
                ) : (
                  <div className="space-y-2">
                    {recall.artifacts.map((art) => (
                      <div
                        key={art.id}
                        className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 space-y-2"
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <span
                              className={`font-mono text-[10px] px-1.5 py-0.5 rounded mr-2 ${
                                art.kind === "test_log" || art.kind === "smoke_log"
                                  ? art.summary.startsWith("FAIL")
                                    ? "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                                    : "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                                  : art.kind === "handover"
                                    ? "bg-teal-500/20 text-teal-300 border border-teal-500/30"
                                    : art.kind === "screenshot"
                                      ? "bg-sky-500/20 text-sky-300 border border-sky-500/30"
                                      : art.kind === "visual_diff"
                                        ? "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                                        : "bg-zinc-800 text-zinc-300"
                              }`}
                            >
                              {art.kind === "test_log"
                                ? t("drawer.testLogTag")
                                : art.kind === "smoke_log"
                                  ? t("drawer.smokeLogTag")
                                  : art.kind === "handover"
                                    ? t("drawer.handoverTag")
                                    : art.kind === "screenshot"
                                      ? "Screenshot"
                                      : art.kind === "visual_diff"
                                        ? t("drawer.visualDiffTag")
                                        : art.kind}
                            </span>
                            <span className="text-zinc-200">{art.summary}</span>
                            <span className="text-zinc-500 text-[11px] ml-2">
                              ({art.byteSize} {t("drawer.bytes")})
                            </span>
                          </div>
                          {art.kind === "screenshot" || art.kind === "visual_diff" ? (
                            <a
                              href={api.getArtifactRawUrl(art.id)}
                              target="_blank"
                              rel="noreferrer"
                              className="text-sky-400 hover:text-sky-300 font-medium"
                            >
                              {t("preview.openBtn")}
                            </a>
                          ) : (
                            <button
                              onClick={() => handleLoadArtifact(art.id)}
                              className="text-indigo-400 hover:text-indigo-300 font-medium"
                            >
                              {artifactContent?.id === art.id
                                ? t("drawer.hideSpill")
                                : t("drawer.readSpill")}
                            </button>
                          )}
                        </div>
                        {(art.kind === "screenshot" || art.kind === "visual_diff") && (
                          <a
                            href={api.getArtifactRawUrl(art.id)}
                            target="_blank"
                            rel="noreferrer"
                            className="block rounded-lg border border-zinc-800 overflow-hidden bg-zinc-950 hover:border-sky-500/50 transition"
                          >
                            <img
                              src={api.getArtifactRawUrl(art.id)}
                              alt={art.summary || art.kind}
                              className="w-full max-h-64 object-contain bg-zinc-950"
                            />
                          </a>
                        )}
                        {artifactContent?.id === art.id && (
                          <pre className="p-2.5 rounded bg-zinc-950 border border-zinc-800 text-[11px] font-mono text-zinc-300 max-h-60 overflow-auto whitespace-pre-wrap">
                            {artifactContent.text}
                          </pre>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {tab === "outbox" && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  {t("drawer.outboxTitle")}
                </h3>
              </div>
              {detail?.outboxEntries.length === 0 ? (
                <p className="text-xs text-zinc-500">{t("drawer.noOutbox")}</p>
              ) : (
                detail?.outboxEntries.map((obx) => (
                  <div
                    key={obx.id}
                    className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3.5 text-xs space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-semibold text-zinc-200">{obx.action}</span>
                      <span className="font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 text-[10px]">
                        {formatOutboxStatus(obx.status, locale)}
                      </span>
                    </div>
                    <div className="font-mono text-[11px] text-zinc-500">
                      {t("drawer.outboxKey")}: {obx.idempotencyKey} · {t("drawer.outboxAttempts")}:{" "}
                      {obx.attempts}
                    </div>
                    {obx.resultPayload && (
                      <pre className="p-2 rounded bg-zinc-950 border border-zinc-800 text-[11px] text-emerald-300 overflow-x-auto">
                        {JSON.stringify(obx.resultPayload, null, 2)}
                      </pre>
                    )}
                    {obx.lastError && (
                      <div className="text-rose-300 text-[11px]">
                        {t("drawer.outboxError")} {obx.lastError}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}

          {tab === "checkpoints" && (
            <div className="space-y-4">
              <div className="flex flex-col gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  {t("drawer.tab.checkpoints")} ({detail?.checkpoints?.length ?? 0})
                </h3>
                <input
                  type="text"
                  value={resteerPrompt}
                  onChange={(e) => setResteerPrompt(e.target.value)}
                  placeholder={t("drawer.checkpointPromptPlaceholder")}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500"
                />
                {checkpointNotice && (
                  <div className="p-2.5 rounded-lg border border-indigo-500/30 bg-indigo-500/10 text-xs text-indigo-200">
                    {checkpointNotice}
                  </div>
                )}
              </div>

              {(detail?.checkpoints?.length ?? 0) === 0 ? (
                <p className="text-xs text-zinc-500">{t("drawer.checkpointsEmpty")}</p>
              ) : (
                <div className="space-y-2.5">
                  {detail!.checkpoints!.map((cp) => {
                    const isDiffOpen = checkpointDiff?.cpId === cp.id;
                    const busy = checkpointBusy === cp.id;
                    return (
                      <div
                        key={cp.id}
                        className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3.5 text-xs space-y-2.5"
                      >
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="px-1.5 py-0.5 rounded bg-indigo-500/15 border border-indigo-500/30 font-mono text-[10px] text-indigo-300">
                              {cp.stage === "baseline" ? "Baseline" : formatStage(cp.stage, locale)}
                            </span>
                            <span className="font-mono text-[11px] text-zinc-300">
                              {cp.commitSha.slice(0, 8)}
                            </span>
                            {Boolean(cp.cleanedAt) && (
                              <span className="px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 font-mono text-[10px] text-zinc-400">
                                {t("drawer.checkpointCleaned")}
                              </span>
                            )}
                          </div>
                          <span className="text-[11px] font-mono text-zinc-500">
                            {new Date(cp.createdAt).toLocaleTimeString()}
                          </span>
                        </div>
                        {cp.label && <p className="text-zinc-300 text-xs">{cp.label}</p>}
                        <div className="flex items-center gap-2 flex-wrap">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={async () => {
                              if (!ticketId) return;
                              if (isDiffOpen) {
                                setCheckpointDiff(null);
                                return;
                              }
                              setCheckpointBusy(cp.id);
                              try {
                                const res = await api.getCheckpointDiff(ticketId, cp.id);
                                setCheckpointDiff({ cpId: cp.id, diff: res.diff || "(empty diff)" });
                              } catch (err) {
                                setCheckpointNotice((err as Error).message);
                              } finally {
                                setCheckpointBusy(null);
                              }
                            }}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-zinc-700 bg-zinc-950 text-zinc-300 hover:text-white text-[11px] transition disabled:opacity-40"
                          >
                            <FileDiff className="w-3 h-3" />
                            {isDiffOpen ? t("drawer.checkpointHideDiff") : t("drawer.checkpointDiffBtn")}
                          </button>

                          {!cp.cleanedAt && (
                            <>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={async () => {
                                  if (!ticketId) return;
                                  setCheckpointBusy(cp.id);
                                  setCheckpointNotice(null);
                                  try {
                                    await api.restoreCheckpoint(ticketId, cp.id, {
                                      mode: "in_place",
                                      prompt: resteerPrompt.trim() || undefined,
                                    });
                                    setResteerPrompt("");
                                    const updated = await api.getTicketDetail(ticketId);
                                    setDetail(updated);
                                    onRefresh();
                                  } catch (err) {
                                    setCheckpointNotice((err as Error).message);
                                  } finally {
                                    setCheckpointBusy(null);
                                  }
                                }}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-amber-600/20 hover:bg-amber-600/30 border border-amber-500/30 text-amber-200 text-[11px] font-medium transition disabled:opacity-40"
                              >
                                <RotateCcw className="w-3 h-3" />
                                {t("drawer.checkpointRestoreBtn")}
                              </button>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={async () => {
                                  if (!ticketId) return;
                                  setCheckpointBusy(cp.id);
                                  setCheckpointNotice(null);
                                  try {
                                    const res = await api.restoreCheckpoint(ticketId, cp.id, {
                                      mode: "fork",
                                      prompt: resteerPrompt.trim() || undefined,
                                    });
                                    setResteerPrompt("");
                                    onRefresh();
                                    if (res.ticket?.id) {
                                      onSelectTicket?.(res.ticket.id);
                                    }
                                  } catch (err) {
                                    setCheckpointNotice((err as Error).message);
                                  } finally {
                                    setCheckpointBusy(null);
                                  }
                                }}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-indigo-600/20 hover:bg-indigo-600/30 border border-indigo-500/30 text-indigo-200 text-[11px] font-medium transition disabled:opacity-40"
                              >
                                <GitFork className="w-3 h-3" />
                                {t("drawer.checkpointForkBtn")}
                              </button>
                            </>
                          )}
                        </div>
                        {isDiffOpen && checkpointDiff && (
                          <pre className="p-2.5 rounded bg-zinc-950 border border-zinc-800 text-[11px] font-mono text-zinc-300 max-h-60 overflow-auto whitespace-pre-wrap">
                            {checkpointDiff.diff}
                          </pre>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Thread Subscription Follow-Up Input */}
        <form
          onSubmit={handleSendFollowUp}
          className="px-5 py-3 border-t border-zinc-800 bg-zinc-900/60 flex items-center gap-2"
        >
          <input
            type="text"
            value={followUp}
            onChange={(e) => setFollowUp(e.target.value)}
            placeholder={t("drawer.threadPlaceholder")}
            className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500"
          />
          <button
            type="submit"
            disabled={sendingMsg || !followUp.trim()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium disabled:opacity-40 transition"
          >
            <Send className="w-3.5 h-3.5" />
            {t("drawer.injectButton")}
          </button>
        </form>
      </div>
    </div>
  );
}
