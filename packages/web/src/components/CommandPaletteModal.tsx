import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bot,
  CheckCircle2,
  Command,
  FileSearch,
  FolderGit2,
  Inbox,
  Kanban,
  Search,
  Send,
  Sparkles,
  Stethoscope,
  X,
} from "lucide-react";
import { api } from "../api.ts";
import { formatTicketStatus, useI18n } from "../i18n.tsx";
import type {
  ChiefActionSuggestion,
  ChiefAskResult,
  InboxItem,
  MemorySearchHit,
  RepoConfig,
  Ticket,
} from "../types.ts";

interface CommandPaletteModalProps {
  open: boolean;
  onClose: () => void;
  repos: RepoConfig[];
  selectedRepoId: string;
  tickets: Ticket[];
  inboxItems: InboxItem[];
  onSelectRepo: (repoId: string) => void;
  onSwitchTab: (tab: "inbox" | "board" | "routines" | "metrics") => void;
  onInspectTicket: (ticketId: string) => void;
  onOpenDispatch: () => void;
  onOpenDoctor: () => void;
  onRefresh: () => void;
}

export function CommandPaletteModal({
  open,
  onClose,
  repos,
  selectedRepoId,
  tickets,
  inboxItems,
  onSelectRepo,
  onSwitchTab,
  onInspectTicket,
  onOpenDispatch,
  onOpenDoctor,
  onRefresh,
}: CommandPaletteModalProps) {
  const { locale, t } = useI18n();
  const [mode, setMode] = useState<"search" | "chief">("search");
  const [query, setQuery] = useState("");
  const [memoryHits, setMemoryHits] = useState<MemorySearchHit[]>([]);
  const [chiefLoading, setChiefLoading] = useState(false);
  const [chiefResult, setChiefResult] = useState<ChiefAskResult | null>(null);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setActionNotice(null);
  }, [open]);

  useEffect(() => {
    if (query.startsWith("?") && mode !== "chief") {
      setMode("chief");
    }
  }, [query, mode]);

  useEffect(() => {
    if (!open || mode !== "search") return;
    const clean = query.trim();
    if (clean.length < 2) {
      setMemoryHits([]);
      return;
    }
    const timer = setTimeout(() => {
      void api
        .searchMemory(clean, selectedRepoId || undefined)
        .then((res) => setMemoryHits(res.hits.slice(0, 6)))
        .catch(() => setMemoryHits([]));
    }, 180);
    return () => clearTimeout(timer);
  }, [open, mode, query, selectedRepoId]);

  const cleanQuery = query.replace(/^\?/, "").trim();
  const qLower = cleanQuery.toLowerCase();

  const matchingTickets = useMemo(() => {
    if (!qLower) return tickets.slice(0, 6);
    return tickets
      .filter((tkt) =>
        `${tkt.id} ${tkt.title} ${tkt.status} ${tkt.branchName ?? ""}`
          .toLowerCase()
          .includes(qLower),
      )
      .slice(0, 8);
  }, [tickets, qLower]);

  const quickCommands = useMemo(() => {
    const items = [
      {
        id: "cmd_dispatch",
        label: t("header.dispatchTask"),
        hint: "Dispatch",
        icon: Sparkles,
        run: () => {
          onClose();
          onOpenDispatch();
        },
      },
      {
        id: "cmd_inbox",
        label: `${t("nav.inbox")} (${inboxItems.filter((i) => i.status === "pending").length})`,
        hint: "View",
        icon: Inbox,
        run: () => {
          onSwitchTab("inbox");
          onClose();
        },
      },
      {
        id: "cmd_board",
        label: t("nav.board"),
        hint: "View",
        icon: Kanban,
        run: () => {
          onSwitchTab("board");
          onClose();
        },
      },
      {
        id: "cmd_metrics",
        label: t("nav.metrics"),
        hint: "View / Eval",
        icon: Activity,
        run: () => {
          onSwitchTab("metrics");
          onClose();
        },
      },
      {
        id: "cmd_doctor",
        label: t("setup.tabDoctorBackup"),
        hint: "Doctor & Restore",
        icon: Stethoscope,
        run: () => {
          onClose();
          onOpenDoctor();
        },
      },
    ];
    if (!qLower) return items;
    return items.filter(
      (i) => i.label.toLowerCase().includes(qLower) || i.hint.toLowerCase().includes(qLower),
    );
  }, [qLower, inboxItems, t, onClose, onOpenDispatch, onSwitchTab, onOpenDoctor]);

  if (!open) return null;

  const handleAskChief = async () => {
    const question = cleanQuery || "总结当前仓库工单状态、待批项与卡点";
    setChiefLoading(true);
    setError(null);
    setActionNotice(null);
    try {
      const res = await api.askChief({
        repoId: selectedRepoId || undefined,
        question,
      });
      setChiefResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChiefLoading(false);
    }
  };

  const handleExecuteSuggestedAction = async (act: ChiefActionSuggestion) => {
    setActionBusyId(act.id);
    setError(null);
    setActionNotice(null);
    try {
      if (act.kind === "open_ticket") {
        const ticketId = String(act.payload.ticketId ?? "");
        if (ticketId) {
          onClose();
          onInspectTicket(ticketId);
        }
        return;
      }
      if (act.kind === "batch_resolve_inbox") {
        const res = await api.batchResolveInbox({
          inboxIds: Array.isArray(act.payload.inboxIds)
            ? act.payload.inboxIds.map(String)
            : undefined,
          repoId: act.payload.repoId ? String(act.payload.repoId) : undefined,
          onlyLowRisk: Boolean(act.payload.onlyLowRisk ?? true),
          decision: act.payload.decision === "rejected" ? "rejected" : "approved",
          note: act.payload.note ? String(act.payload.note) : undefined,
        });
        setActionNotice(`已批量处理 ${res.resolvedCount} 项（跳过 ${res.skippedCount} 项）`);
        onRefresh();
        return;
      }
      if (act.kind === "steer_ticket") {
        const ticketId = String(act.payload.ticketId ?? "");
        const instruction = String(act.payload.instruction ?? "");
        if (ticketId && instruction) {
          await api.steerTicket(ticketId, { instruction });
          setActionNotice(`已向工单 ${ticketId} 发送实时纠偏并重排队`);
          onRefresh();
        }
        return;
      }
      if (act.kind === "run_doctor") {
        const rep = await api.runDoctor(Boolean(act.payload.fix));
        setActionNotice(
          rep.healthy
            ? "System Doctor 自检全部通过"
            : `System Doctor 发现隐患：${rep.items.filter((i) => i.status !== "ok").map((i) => i.title).join(", ")}`,
        );
        return;
      }
      if (act.kind === "create_backup") {
        const { backup } = await api.createBackup();
        setActionNotice(`热备份完成：${backup.filename}`);
        return;
      }
      if (act.kind === "dispatch_ticket") {
        const { ticket } = await api.createTicket({
          repoId: String(act.payload.repoId ?? selectedRepoId),
          title: String(act.payload.title ?? "Chief Suggested Task"),
          description: String(act.payload.description ?? ""),
          allowedPaths: Array.isArray(act.payload.allowedPaths)
            ? act.payload.allowedPaths.map(String)
            : ["**"],
        });
        setActionNotice(`已派发工单 ${ticket.id}：${ticket.title}`);
        onRefresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusyId(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-start justify-center pt-16 px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-2xl border border-zinc-700/80 bg-zinc-950 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Input & Mode Toggle */}
        <div className="p-3 border-b border-zinc-800 space-y-2.5 bg-zinc-900/60">
          <div className="flex items-center gap-2">
            {mode === "chief" ? (
              <Bot className="w-4 h-4 text-indigo-400 shrink-0" />
            ) : (
              <Search className="w-4 h-4 text-zinc-400 shrink-0" />
            )}
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") onClose();
                if (e.key === "Enter" && mode === "chief") {
                  e.preventDefault();
                  void handleAskChief();
                }
              }}
              placeholder={t("cmd.placeholder")}
              className="flex-1 bg-transparent text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
            />
            {mode === "chief" && (
              <button
                type="button"
                onClick={() => void handleAskChief()}
                disabled={chiefLoading}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium disabled:opacity-50"
              >
                <Send className="w-3 h-3" />
                {chiefLoading ? t("cmd.asking") : t("cmd.askBtn")}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-center justify-between gap-2 text-[11px]">
            <div className="inline-flex items-center rounded-lg border border-zinc-800 bg-zinc-950 p-0.5">
              <button
                type="button"
                onClick={() => setMode("search")}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md transition ${
                  mode === "search"
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <Command className="w-3 h-3" />
                {t("cmd.modeSearch")}
              </button>
              <button
                type="button"
                onClick={() => setMode("chief")}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md transition ${
                  mode === "chief"
                    ? "bg-indigo-600/30 text-indigo-200 border border-indigo-500/30"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <Bot className="w-3 h-3" />
                {t("cmd.modeChief")}
              </button>
            </div>
            <span className="text-[10px] font-mono text-zinc-500">ESC to close · ? for Chief</span>
          </div>
        </div>

        {/* Body */}
        <div className="max-h-[65vh] overflow-y-auto p-3 space-y-4">
          {error && (
            <div className="p-2.5 rounded-lg border border-rose-500/40 bg-rose-500/10 text-rose-200 text-xs">
              {error}
            </div>
          )}
          {actionNotice && (
            <div className="p-2.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-emerald-200 text-xs inline-flex items-center gap-1.5 w-full">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
              <span>{actionNotice}</span>
            </div>
          )}

          {mode === "search" ? (
            <>
              {quickCommands.length > 0 && (
                <section className="space-y-1.5">
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500 px-1">
                    Commands
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    {quickCommands.map((c) => {
                      const Icon = c.icon;
                      return (
                        <button
                          key={c.id}
                          type="button"
                          onClick={c.run}
                          className="flex items-center justify-between px-3 py-2 rounded-lg border border-zinc-800/80 bg-zinc-900/50 hover:bg-zinc-800/80 text-left text-xs text-zinc-200 transition"
                        >
                          <span className="inline-flex items-center gap-2">
                            <Icon className="w-3.5 h-3.5 text-indigo-400" />
                            {c.label}
                          </span>
                          <span className="text-[10px] font-mono text-zinc-500">{c.hint}</span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              )}

              {matchingTickets.length > 0 && (
                <section className="space-y-1.5">
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500 px-1">
                    Tickets
                  </div>
                  <div className="space-y-1">
                    {matchingTickets.map((tkt) => (
                      <button
                        key={tkt.id}
                        type="button"
                        onClick={() => {
                          onClose();
                          onInspectTicket(tkt.id);
                        }}
                        className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-zinc-800/70 bg-zinc-900/40 hover:bg-zinc-800/70 text-left text-xs transition"
                      >
                        <div className="truncate">
                          <span className="font-mono text-[10px] text-zinc-500 mr-2">{tkt.id}</span>
                          <span className="text-zinc-200">{tkt.title}</span>
                        </div>
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 shrink-0">
                          {formatTicketStatus(tkt.status, locale)}
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {memoryHits.length > 0 && (
                <section className="space-y-1.5">
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500 px-1">
                    FTS5 Chain of Recall
                  </div>
                  <div className="space-y-1">
                    {memoryHits.map((hit) => (
                      <button
                        key={`${hit.entityType}_${hit.entityId}`}
                        type="button"
                        onClick={() => {
                          onClose();
                          onInspectTicket(hit.ticketId);
                        }}
                        className="w-full text-left px-3 py-2 rounded-lg border border-zinc-800/70 bg-zinc-900/30 hover:bg-zinc-800/60 text-xs transition"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-zinc-200 font-medium truncate">{hit.title}</span>
                          <span className="text-[10px] font-mono text-indigo-300">{hit.ticketId}</span>
                        </div>
                        <div className="text-[11px] text-zinc-400 truncate mt-0.5">{hit.snippet}</div>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {repos.length > 1 && (
                <section className="space-y-1.5">
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500 px-1">
                    Switch Repository
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {repos.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => {
                          onSelectRepo(r.id);
                          onClose();
                        }}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] ${
                          r.id === selectedRepoId
                            ? "border-indigo-500/50 bg-indigo-500/15 text-indigo-200"
                            : "border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
                        }`}
                      >
                        <FolderGit2 className="w-3 h-3" />
                        {r.name}
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </>
          ) : (
            <div className="space-y-3">
              {!chiefResult ? (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-xs text-zinc-400 space-y-2">
                  <p>输入任意全局问题或仓库提问后按回车，幕僚长将结合实时工单、预算、记忆检索与只读代码探针作答：</p>
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      "总结当前待批项和卡住的工单",
                      "运行状态如何？有需要低风险批量放行的吗？",
                      "帮我排查近期变更风险和系统健康状态",
                    ].map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => setQuery(`?${preset}`)}
                        className="px-2.5 py-1 rounded-md border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-[11px] text-zinc-200"
                      >
                        {preset}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="rounded-xl border border-indigo-500/30 bg-indigo-950/20 p-3.5 text-xs text-zinc-100 whitespace-pre-wrap leading-relaxed">
                    {chiefResult.answer}
                  </div>

                  {chiefResult.probeSteps && chiefResult.probeSteps.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="inline-flex items-center gap-1 text-[10px] font-mono text-zinc-400">
                        <FileSearch className="w-3 h-3 text-sky-400" />
                        Probes ({chiefResult.probeSteps.length}):
                      </span>
                      {chiefResult.probeSteps.map((p, idx) => (
                        <span
                          key={`${p.tool}_${idx}`}
                          title={p.outputSummary}
                          className="px-2 py-0.5 rounded border border-zinc-800 bg-zinc-900 text-[10px] font-mono text-zinc-300"
                        >
                          {p.tool}: {p.matchedPaths[0] ?? p.inputSummary.slice(0, 28)}
                        </span>
                      ))}
                    </div>
                  )}

                  {chiefResult.suggestedActions.length > 0 && (
                    <div className="space-y-1.5">
                      <div className="text-[10px] uppercase tracking-wider text-zinc-400">
                        Suggested Actions (Explicit Confirmation Required)
                      </div>
                      {chiefResult.suggestedActions.map((act) => (
                        <div
                          key={act.id}
                          className="flex items-center justify-between gap-3 p-2.5 rounded-lg border border-zinc-800 bg-zinc-900/70 text-xs"
                        >
                          <div className="min-w-0">
                            <div className="font-medium text-zinc-100 truncate">{act.label}</div>
                            <div className="text-[11px] text-zinc-400 truncate">{act.description}</div>
                          </div>
                          <button
                            type="button"
                            disabled={actionBusyId === act.id}
                            onClick={() => void handleExecuteSuggestedAction(act)}
                            className="shrink-0 px-2.5 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-medium disabled:opacity-50"
                          >
                            {t("cmd.confirmRun")}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
