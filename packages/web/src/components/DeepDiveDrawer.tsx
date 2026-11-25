import { useEffect, useState } from "react";
import {
  Award,
  Ban,
  CheckCircle2,
  Clock,
  Database,
  ExternalLink,
  FileDiff,
  GitBranch,
  GitMerge,
  GitPullRequest,
  History,
  Layers,
  Play,
  RotateCcw,
  Send,
  Square,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../api.ts";
import { formatTicketStatus, useI18n } from "../i18n.tsx";
import { CheckpointsTab } from "./deep-dive/CheckpointsTab.tsx";
import { DiffTab } from "./deep-dive/DiffTab.tsx";
import { OutboxTab } from "./deep-dive/OutboxTab.tsx";
import { RecallTab } from "./deep-dive/RecallTab.tsx";
import { StreamTab } from "./deep-dive/StreamTab.tsx";
import type {
  ChainOfRecall,
  EnginePreference,
  LiveEventLogEntry,
  MemorySearchHit,
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
            <StreamTab
              ticketId={ticketId}
              ticket={ticket}
              detail={detail}
              repos={repos}
              reposById={reposById}
              childSubtasks={childSubtasks}
              ticketLiveEvents={ticketLiveEvents}
              deliveryError={deliveryError}
              evalNotice={evalNotice}
              steerInstruction={steerInstruction}
              setSteerInstruction={setSteerInstruction}
              steerEngine={steerEngine}
              setSteerEngine={setSteerEngine}
              steering={steering}
              handleLiveSteer={handleLiveSteer}
              setDetail={setDetail}
              onRefresh={onRefresh}
              onSelectTicket={onSelectTicket}
            />
          )}

          {tab === "diff" && ticket && (
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
