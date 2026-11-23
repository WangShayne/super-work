import { useEffect, useState } from "react";
import {
  Ban,
  CheckCircle2,
  Database,
  FileDiff,
  GitBranch,
  GitMerge,
  GitPullRequest,
  History,
  Layers,
  RotateCcw,
  Search,
  Send,
  Shield,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../api.ts";
import { DiffStudio } from "./DiffStudio.tsx";
import {
  formatOutboxStatus,
  formatStage,
  formatTicketStatus,
  useI18n,
} from "../i18n.tsx";
import type {
  ChainOfRecall,
  LiveEventLogEntry,
  MemorySearchHit,
  RepoConfig,
  Ticket,
  TicketDetailResponse,
} from "../types.ts";

interface DeepDiveDrawerProps {
  ticketId: string | null;
  allTickets?: Ticket[];
  repo?: RepoConfig;
  liveEvents: LiveEventLogEntry[];
  onClose: () => void;
  onSelectTicket?: (ticketId: string) => void;
  onRefresh: () => void;
}

type DrawerTab = "stream" | "diff" | "recall" | "outbox";

export function DeepDiveDrawer({
  ticketId,
  allTickets = [],
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

  const childSubtasks = ticket?.isEpic
    ? allTickets.filter((c) => c.parentTicketId === ticket.id)
    : [];
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
    <div className="fixed inset-0 z-40 flex justify-end bg-black/60 backdrop-blur-xs">
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

              {ticket?.isEpic && childSubtasks.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-purple-300 flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5" />
                    {t("drawer.epicDagTitle")} ({childSubtasks.length})
                  </h3>
                  <div className="space-y-2">
                    {childSubtasks.map((sub) => (
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
                    ))}
                  </div>
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
                    {detail?.stageRuns.map((run) => (
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
                                    : "bg-rose-500/15 text-rose-300"
                              }`}
                            >
                              {run.status}
                            </span>
                          </div>
                          <span className="font-mono text-zinc-500">${run.costUsd.toFixed(3)}</span>
                        </div>
                        {run.summary && (
                          <p className="text-zinc-300 whitespace-pre-wrap leading-relaxed">
                            {run.summary}
                          </p>
                        )}
                      </div>
                    ))}
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

              <div className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  {t("drawer.diffTitle")}
                </h3>
                <DiffStudio
                  diff={detail?.diff ?? ""}
                  stageNotes={ticket.inlineMemory.stageNotes}
                  onSendFileFeedback={handleSendFileFeedback}
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
                                art.kind === "test_log"
                                  ? art.summary.startsWith("FAIL")
                                    ? "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                                    : "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                                  : "bg-zinc-800 text-zinc-300"
                              }`}
                            >
                              {art.kind === "test_log" ? t("drawer.testLogTag") : art.kind}
                            </span>
                            <span className="text-zinc-200">{art.summary}</span>
                            <span className="text-zinc-500 text-[11px] ml-2">
                              ({art.byteSize} {t("drawer.bytes")})
                            </span>
                          </div>
                          <button
                            onClick={() => handleLoadArtifact(art.id)}
                            className="text-indigo-400 hover:text-indigo-300 font-medium"
                          >
                            {artifactContent?.id === art.id
                              ? t("drawer.hideSpill")
                              : t("drawer.readSpill")}
                          </button>
                        </div>
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
                {canDeliverActions && (
                  <button
                    type="button"
                    disabled={delivering !== null}
                    onClick={() => void handleDeliver("local_merge")}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-emerald-500/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25 text-[11px] disabled:opacity-50"
                  >
                    <GitMerge className="w-3 h-3" />
                    {delivering === "local_merge"
                      ? t("drawer.merging")
                      : t("drawer.localMergeButton")}
                  </button>
                )}
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
