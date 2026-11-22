import { useCallback, useEffect, useMemo, useState } from "react";
import { Inbox, Kanban } from "lucide-react";
import { api } from "./api.ts";
import { DeepDiveDrawer } from "./components/DeepDiveDrawer.tsx";
import { HeaderBar } from "./components/HeaderBar.tsx";
import { AddRepoModal, DispatchTaskModal, SimulateEventModal } from "./components/Modals.tsx";
import { useI18n } from "./i18n.tsx";
import type {
  HealthResponse,
  InboxItem,
  LiveEventLogEntry,
  OperatingMode,
  RepoConfig,
  Ticket,
} from "./types.ts";
import { BoardView } from "./views/BoardView.tsx";
import { InboxView } from "./views/InboxView.tsx";

type MainTab = "inbox" | "board";

export function App() {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<MainTab>("inbox");
  const [repos, setRepos] = useState<RepoConfig[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState<string>("");
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [inboxItems, setInboxItems] = useState<InboxItem[]>([]);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [sseConnected, setSseConnected] = useState(false);

  const [inspectedTicketId, setInspectedTicketId] = useState<string | null>(null);
  const [liveEvents, setLiveEvents] = useState<LiveEventLogEntry[]>([]);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [simulateOpen, setSimulateOpen] = useState(false);
  const [addRepoOpen, setAddRepoOpen] = useState(false);

  const refreshAll = useCallback(async (repoFilter?: string) => {
    const [h, r] = await Promise.all([api.getHealth(), api.listRepos()]);
    setHealth(h);
    setRepos(r.repos);

    const activeRepo = repoFilter || r.repos[0]?.id || "";
    if (!repoFilter && activeRepo) {
      setSelectedRepoId((prev) => prev || activeRepo);
    }

    const [t, i] = await Promise.all([
      api.listTickets(activeRepo || undefined),
      api.listInbox(activeRepo || undefined),
    ]);
    setTickets(t.tickets);
    setInboxItems(i.items);
  }, []);

  useEffect(() => {
    void refreshAll(selectedRepoId || undefined);
  }, [selectedRepoId, refreshAll]);

  // Subscribe to real-time Kernel SSE bus
  useEffect(() => {
    const es = new EventSource("/api/events");

    es.onopen = () => setSseConnected(true);
    es.onerror = () => setSseConnected(false);

    const pushLog = (ticketId: string, kind: string, summary: string, raw: unknown) => {
      setLiveEvents((prev) => [
        ...prev.slice(-199),
        {
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          ticketId,
          kind,
          summary,
          timestamp: new Date().toISOString(),
          raw,
        },
      ]);
    };

    const handleRefreshEvent = () => {
      void refreshAll(selectedRepoId || undefined);
    };

    const eventNames = [
      "ticket_created",
      "ticket_updated",
      "stage_started",
      "stage_completed",
      "thread_routed",
      "watchdog_signal",
      "watchdog_decision",
      "inbox_created",
      "inbox_resolved",
      "outbox_queued",
      "outbox_sent",
      "outbox_failed",
    ];

    for (const name of eventNames) {
      es.addEventListener(name, (e: MessageEvent) => {
        try {
          const parsed = JSON.parse(e.data) as Record<string, unknown>;
          const tId =
            (parsed.ticketId as string | undefined) ||
            ((parsed.ticket as { id?: string } | undefined)?.id) ||
            ((parsed.item as { ticketId?: string } | undefined)?.ticketId) ||
            ((parsed.entry as { ticketId?: string } | undefined)?.ticketId) ||
            ((parsed.signal as { ticketId?: string } | undefined)?.ticketId);
          if (tId) {
            pushLog(tId, name, JSON.stringify(parsed).slice(0, 180), parsed);
          }
        } catch {
          // Ignore parse errors
        }
        handleRefreshEvent();
      });
    }

    es.addEventListener("worker_event", (e: MessageEvent) => {
      try {
        const parsed = JSON.parse(e.data) as {
          ticketId: string;
          engine: string;
          event: { type: string; text?: string; toolName?: string; inputSummary?: string; summary?: string; message?: string };
        };
        const ev = parsed.event;
        const msg =
          ev.text || ev.summary || ev.message || (ev.toolName ? `${ev.toolName}: ${ev.inputSummary ?? ""}` : ev.type);
        pushLog(parsed.ticketId, `${parsed.engine}:${ev.type}`, msg, parsed);
      } catch {
        // Ignore
      }
    });

    return () => {
      es.close();
    };
  }, [selectedRepoId, refreshAll]);

  const ticketsById = useMemo(() => {
    const map = new Map<string, Ticket>();
    for (const t of tickets) map.set(t.id, t);
    return map;
  }, [tickets]);

  const pendingInboxCount = useMemo(
    () => inboxItems.filter((i) => i.status === "pending").length,
    [inboxItems],
  );

  const activeRepo = repos.find((r) => r.id === selectedRepoId) ?? repos[0];

  const handleChangeMode = async (repoId: string, mode: OperatingMode) => {
    await api.patchRepo(repoId, { mode });
    await refreshAll(repoId);
  };

  const handleResolveInbox = async (
    id: string,
    decision: "approved" | "rejected",
    note?: string,
  ) => {
    await api.resolveInbox(id, decision, note);
    await refreshAll(selectedRepoId || undefined);
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      <HeaderBar
        repos={repos}
        selectedRepoId={selectedRepoId}
        onSelectRepo={(id) => setSelectedRepoId(id)}
        onChangeMode={handleChangeMode}
        health={health}
        sseConnected={sseConnected}
        onOpenDispatch={() => setDispatchOpen(true)}
        onOpenSimulate={() => setSimulateOpen(true)}
        onOpenAddRepo={() => setAddRepoOpen(true)}
      />

      {/* Primary View Switcher */}
      <nav className="border-b border-zinc-800/80 bg-zinc-950 px-5 flex items-center gap-2">
        <button
          onClick={() => setActiveTab("inbox")}
          className={`inline-flex items-center gap-2 px-3 py-2.5 text-xs font-medium border-b-2 transition ${
            activeTab === "inbox"
              ? "border-indigo-500 text-zinc-100"
              : "border-transparent text-zinc-500 hover:text-zinc-300"
          }`}
        >
          <Inbox className="w-3.5 h-3.5" />
          {t("nav.inbox")}
          {pendingInboxCount > 0 && (
            <span className="px-1.5 py-0.2 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[10px] font-mono">
              {pendingInboxCount}
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveTab("board")}
          className={`inline-flex items-center gap-2 px-3 py-2.5 text-xs font-medium border-b-2 transition ${
            activeTab === "board"
              ? "border-indigo-500 text-zinc-100"
              : "border-transparent text-zinc-500 hover:text-zinc-300"
          }`}
        >
          <Kanban className="w-3.5 h-3.5" />
          {t("nav.board")}
          <span className="px-1.5 py-0.2 rounded-full bg-zinc-800 text-zinc-400 text-[10px] font-mono">
            {tickets.length}
          </span>
        </button>
      </nav>

      <main className="flex-1">
        {activeTab === "inbox" ? (
          <InboxView
            items={inboxItems}
            ticketsById={ticketsById}
            onResolve={handleResolveInbox}
            onInspectTicket={(id) => setInspectedTicketId(id)}
          />
        ) : (
          <BoardView
            tickets={tickets}
            onSelectTicket={(id) => setInspectedTicketId(id)}
          />
        )}
      </main>

      <DeepDiveDrawer
        ticketId={inspectedTicketId}
        liveEvents={liveEvents}
        onClose={() => setInspectedTicketId(null)}
        onRefresh={() => void refreshAll(selectedRepoId || undefined)}
      />

      {activeRepo && (
        <>
          <DispatchTaskModal
            open={dispatchOpen}
            availableEngines={health?.availableEngines ?? ["mock"]}
            defaultTemplate={activeRepo.defaultTemplate}
            defaultEngine={activeRepo.preferredImplementEngine}
            onClose={() => setDispatchOpen(false)}
            onSubmit={async (data) => {
              await api.createTicket({ repoId: activeRepo.id, ...data });
              await refreshAll(activeRepo.id);
              setActiveTab("board");
            }}
          />

          <SimulateEventModal
            open={simulateOpen}
            onClose={() => setSimulateOpen(false)}
            onSubmit={async (data) => {
              await api.simulateTrigger({ repoId: activeRepo.id, ...data });
              await refreshAll(activeRepo.id);
            }}
          />
        </>
      )}

      <AddRepoModal
        open={addRepoOpen}
        onClose={() => setAddRepoOpen(false)}
        onSubmit={async (data) => {
          const res = await api.createRepo(data);
          setSelectedRepoId(res.repo.id);
          await refreshAll(res.repo.id);
        }}
      />
    </div>
  );
}
