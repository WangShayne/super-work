import { useEffect, useState } from "react";
import {
  Award,
  Ban,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Layers,
  Play,
  RotateCcw,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../api.ts";
import { formatTicketStatus, useI18n } from "../i18n.tsx";
import type { ResolveHandler } from "./NeedsYouCard.tsx";
import { CheckpointsTab } from "./deep-dive/CheckpointsTab.tsx";
import { DrawerTabBar, SteerBar, type DrawerTab } from "./deep-dive/DrawerChrome.tsx";
import { DiffTab } from "./deep-dive/DiffTab.tsx";
import { OutboxTab } from "./deep-dive/OutboxTab.tsx";
import { RecallTab } from "./deep-dive/RecallTab.tsx";
import { StreamTab } from "./deep-dive/StreamTab.tsx";
import type {
  ChainOfRecall,
  LiveEventLogEntry,
  MemorySearchHit,
  PublicModelProfile,
  RepoConfig,
  ReviewCommentStatus,
  SubmitReviewCommentsInput,
  Ticket,
  TicketDetailResponse,
} from "../types.ts";

interface DeepDiveDrawerProps {
  ticketId: string | null;
  allTickets?: Ticket[];
  repos?: RepoConfig[];
  repo?: RepoConfig;
  /** Peer model profiles offered by the steer bar's model picker (ready ones only). */
  modelProfiles?: PublicModelProfile[];
  liveEvents: LiveEventLogEntry[];
  sseConnected?: boolean;
  onClose: () => void;
  onSelectTicket?: (ticketId: string) => void;
  onRefresh: () => void;
  /** Answer pending inbox decisions (clarification / signoff / mandate) inline in the drawer. */
  onResolve?: ResolveHandler;
}

/** Statuses where a live steer instruction can still influence the running worker. */
const STEERABLE_STATUSES = ["planning", "spec_testing", "implementing", "reviewing"];

export function DeepDiveDrawer({
  ticketId,
  allTickets = [],
  repos = [],
  repo,
  modelProfiles = [],
  liveEvents,
  sseConnected = false,
  onClose,
  onSelectTicket,
  onRefresh,
  onResolve,
}: DeepDiveDrawerProps) {
  const { locale, t } = useI18n();
  const [tab, setTab] = useState<DrawerTab>("overview");
  const [moreOpen, setMoreOpen] = useState(false);
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
  const [steerModel, setSteerModel] = useState("");
  const [steering, setSteering] = useState(false);
  const [savingEval, setSavingEval] = useState(false);
  const [evalNotice, setEvalNotice] = useState<string | null>(null);

  useEffect(() => {
    setTab("overview");
    setMoreOpen(false);
    setSelectedArenaCandId(null);
    setPreviewErr(null);
    setCheckpointDiff(null);
    setCheckpointNotice(null);
    setResteerPrompt("");
    setSteerInstruction("");
    setSteerModel("");
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
    setDeliveryError(null);
    try {
      await api.sendThreadMessage(ticketId, followUp.trim());
      setFollowUp("");
      const [d, r] = await Promise.all([api.getTicketDetail(ticketId), api.getRecall(ticketId)]);
      setDetail(d);
      setRecall(r.chain);
      onRefresh();
    } catch (err) {
      setDeliveryError(err instanceof Error ? err.message : String(err));
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
        // 'auto' clears any pin; a profile id pins that model; '' leaves the current choice alone
        ...(steerModel === "auto" ? { preferredEngine: "auto" as const } : steerModel ? { preferredModelId: steerModel } : {}),
      });
      setSteerInstruction("");
      setSteerModel("");
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

  const isFinished = ticket ? ["delivered", "cancelled", "failed"].includes(ticket.status) : false;
  const canRevert = hasMergedLocally && !ticket?.revertedAt;
  // Exactly one primary contextual action lives in the header.
  const primary: "merge" | "revert" | "cancel" | null = canDeliverActions
    ? "merge"
    : canRevert
      ? "revert"
      : ticket && !isFinished
        ? "cancel"
        : null;
  const ACT = "inline-flex items-center gap-1 px-2.5 py-1 rounded-md border text-xs disabled:opacity-50 transition";

  const cancelButton = (
    <button
      type="button"
      onClick={handleCancel}
      className={`${ACT} border-rose-500/30 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20`}
    >
      <Ban className="w-3 h-3" aria-hidden="true" />
      {t("drawer.cancelTask")}
    </button>
  );
  const mergeButton = (
    <button
      type="button"
      disabled={delivering !== null}
      onClick={() => void handleDeliver("local_merge")}
      className={`${ACT} border-emerald-500/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25`}
    >
      <GitMerge className="w-3 h-3" aria-hidden="true" />
      {delivering === "local_merge" ? t("drawer.merging") : t("drawer.localMergeButton")}
    </button>
  );
  const revertButton = (
    <button
      type="button"
      disabled={reverting}
      onClick={() => void handleRevert()}
      className={`${ACT} border-amber-500/40 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25`}
    >
      <RotateCcw className={`w-3 h-3 ${reverting ? "animate-spin" : ""}`} aria-hidden="true" />
      {reverting ? t("drawer.reverting") : t("drawer.revertButton")}
    </button>
  );

  const activePreview = detail?.previews?.find((p) => p.status === "starting" || p.status === "ready");
  const previewControl = ticket?.worktreePath ? (
    activePreview ? (
      <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-sky-500/40 bg-sky-500/10 text-xs">
        <a
          href={activePreview.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-mono text-[11px] text-sky-200 hover:underline"
        >
          <ExternalLink className="w-3 h-3" aria-hidden="true" />
          {t("preview.openBtn")} ({activePreview.port})
        </a>
        <button
          type="button"
          disabled={previewBusy}
          onClick={() => {
            setPreviewBusy(true);
            void api
              .stopPreview(activePreview.id)
              .then(() => api.getTicketDetail(ticket.id))
              .then((d) => {
                setDetail(d);
                onRefresh();
              })
              .finally(() => setPreviewBusy(false));
          }}
          className="pl-1.5 border-l border-sky-500/30 text-rose-300 hover:text-rose-200 inline-flex items-center gap-1"
        >
          <Square className="w-2.5 h-2.5" aria-hidden="true" />
          {t("preview.stopBtn")}
        </button>
      </div>
    ) : (
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
            .catch((err) => setPreviewErr(err instanceof Error ? err.message : String(err)))
            .finally(() => setPreviewBusy(false));
        }}
        className={`${ACT} border-sky-500/40 bg-sky-500/15 text-sky-200 hover:bg-sky-500/25`}
      >
        <Play className="w-3 h-3" aria-hidden="true" />
        {previewBusy ? t("preview.starting") : t("preview.startBtn")}
      </button>
    )
  ) : null;

  const BADGE = "inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded border";

  // Low-frequency actions + diagnostics live in the More bar (DrawerChrome).
  const moreActions = ticket ? (
    <>
      {primary !== "cancel" && !isFinished && cancelButton}
      {primary !== "revert" && canRevert && revertButton}
      {canDeliverActions && repo?.githubRepo && !hasPushedPr && (
        <button
          type="button"
          disabled={delivering !== null}
          onClick={() => void handleDeliver("push_and_create_pr")}
          className={`${ACT} border-indigo-500/40 bg-indigo-500/15 text-indigo-200 hover:bg-indigo-500/25`}
        >
          <GitPullRequest className="w-3 h-3" aria-hidden="true" />
          {delivering === "push_and_create_pr" ? t("drawer.pushingPr") : t("drawer.pushPrButton")}
        </button>
      )}
      {previewControl}
      {ticket.status === "delivered" && !ticket.isEpic && (
        <button
          type="button"
          disabled={savingEval}
          onClick={() => void handleSaveEval()}
          className={`${ACT} border-teal-500/40 bg-teal-500/15 text-teal-200 hover:bg-teal-500/25`}
        >
          <Award className="w-3 h-3" aria-hidden="true" />
          {t("drawer.saveEvalBtn")}
        </button>
      )}
      {ticket.worktreePath && isFinished && (
        <button
          type="button"
          onClick={() => void handleCleanupWorktree()}
          className={`${ACT} border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20`}
        >
          <Trash2 className="w-3 h-3" aria-hidden="true" />
          {t("drawer.reclaimWorktree")}
        </button>
      )}
      {ticket.parentTicketId && (
        <button
          type="button"
          onClick={() => onSelectTicket?.(ticket.parentTicketId!)}
          className={`${BADGE} bg-purple-500/15 border-purple-500/30 text-purple-300 hover:bg-purple-500/25`}
        >
          <Layers className="w-2.5 h-2.5" aria-hidden="true" />
          {t("drawer.parentEpicPrefix")} {ticket.parentTicketId}
        </button>
      )}
      {hasMergedLocally && (
        <span className={`${BADGE} bg-emerald-500/15 border-emerald-500/30 text-emerald-300`}>
          <CheckCircle2 className="w-2.5 h-2.5" aria-hidden="true" />
          {t("drawer.localMergedTag")}
        </span>
      )}
      {ticket.revertedAt && (
        <span className={`${BADGE} bg-amber-500/15 border-amber-500/30 text-amber-300`}>
          <RotateCcw className="w-2.5 h-2.5" aria-hidden="true" />
          {t("drawer.revertedBadge")} {ticket.revertCommitSha ? `(${ticket.revertCommitSha.slice(0, 7)})` : ""}
        </span>
      )}
      {ticket.worktreePath ? (
        <span className={`${BADGE} bg-sky-500/10 border-sky-500/30 text-sky-300`}>{t("drawer.worktreeActive")}</span>
      ) : ticket.worktreeCleanedAt ? (
        <span className={`${BADGE} bg-zinc-900 border-zinc-800 text-zinc-500`}>{t("drawer.worktreeCleaned")}</span>
      ) : null}
    </>
  ) : null;

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/60 backdrop-blur-xs"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-3xl bg-zinc-950 border-l border-zinc-800 h-full flex flex-col shadow-2xl">
        {/* Header: title, status, branch / PR, ONE primary action, close */}
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
                      <GitBranch className="w-3 h-3" aria-hidden="true" />
                      {ticket.branchName}
                    </span>
                  )}
                  {ticket.prNumber &&
                    (ticket.prUrl ? (
                      <a
                        href={ticket.prUrl}
                        target="_blank"
                        rel="noreferrer"
                        className={`${BADGE} bg-cyan-500/15 border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/25`}
                      >
                        <GitPullRequest className="w-2.5 h-2.5" aria-hidden="true" />
                        PR #{ticket.prNumber}
                      </a>
                    ) : (
                      <span className={`${BADGE} bg-cyan-500/15 border-cyan-500/30 text-cyan-300`}>
                        <GitPullRequest className="w-2.5 h-2.5" aria-hidden="true" />
                        PR #{ticket.prNumber}
                      </span>
                    ))}
                </>
              )}
            </div>
            <h2 className="text-base font-semibold text-zinc-100 truncate">
              {ticket?.title ?? (loading ? t("drawer.loading") : ticketId)}
            </h2>
          </div>

          <div className="flex items-center gap-2 justify-end">
            {primary === "merge" && mergeButton}
            {primary === "revert" && revertButton}
            {primary === "cancel" && cancelButton}
            <button
              type="button"
              onClick={onClose}
              aria-label={t("drawer.close")}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900"
            >
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Tabs */}
        {previewErr && (
          <div className="px-5 py-2 bg-rose-500/10 border-b border-rose-500/20 text-[11px] text-rose-300">
            {previewErr}
          </div>
        )}
        <DrawerTabBar
          tab={tab}
          setTab={setTab}
          moreOpen={moreOpen}
          setMoreOpen={setMoreOpen}
          checkpointCount={detail?.checkpoints?.length ?? 0}
          outboxCount={detail?.outboxEntries.length ?? 0}
          moreActions={moreActions}
        />

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {tab === "overview" && (
            <StreamTab
              ticketId={ticketId}
              ticket={ticket}
              detail={detail}
              repos={repos}
              reposById={reposById}
              childSubtasks={childSubtasks}
              ticketLiveEvents={ticketLiveEvents}
              sseConnected={sseConnected}
              deliveryError={deliveryError}
              evalNotice={evalNotice}
              setDetail={setDetail}
              onRefresh={onRefresh}
              onSelectTicket={onSelectTicket}
              onResolve={onResolve}
            />
          )}

          {tab === "changes" && ticket && (
            <DiffTab
              ticket={ticket}
              detail={detail}
              selectedArenaCandId={selectedArenaCandId}
              setSelectedArenaCandId={setSelectedArenaCandId}
              handleSendFileFeedback={handleSendFileFeedback}
              handleSubmitReview={handleSubmitReview}
              handleToggleCommentStatus={handleToggleCommentStatus}
            />
          )}

          {tab === "recall" && recall && (
            <RecallTab
              recall={recall}
              searchQ={searchQ}
              setSearchQ={setSearchQ}
              searchHits={searchHits}
              handleMemorySearch={handleMemorySearch}
              artifactContent={artifactContent}
              handleLoadArtifact={handleLoadArtifact}
            />
          )}

          {tab === "outbox" && <OutboxTab detail={detail} />}

          {tab === "checkpoints" && (
            <CheckpointsTab
              ticketId={ticketId}
              detail={detail}
              resteerPrompt={resteerPrompt}
              setResteerPrompt={setResteerPrompt}
              checkpointDiff={checkpointDiff}
              setCheckpointDiff={setCheckpointDiff}
              checkpointBusy={checkpointBusy}
              setCheckpointBusy={setCheckpointBusy}
              checkpointNotice={checkpointNotice}
              setCheckpointNotice={setCheckpointNotice}
              setDetail={setDetail}
              onRefresh={onRefresh}
              onSelectTicket={onSelectTicket}
            />
          )}
        </div>

        {/* Permanent Steer Input Bar: live steer while the worker runs, thread follow-up otherwise */}
        {(() => {
          const steerable = Boolean(ticket && STEERABLE_STATUSES.includes(ticket.status));
          return (
            <SteerBar
              steerable={steerable}
              value={steerable ? steerInstruction : followUp}
              onChange={steerable ? setSteerInstruction : setFollowUp}
              busy={steerable ? steering : sendingMsg}
              model={steerModel}
              onModelChange={setSteerModel}
              modelProfiles={modelProfiles}
              onSubmit={steerable ? handleLiveSteer : handleSendFollowUp}
            />
          );
        })()}
      </div>
    </div>
  );
}
