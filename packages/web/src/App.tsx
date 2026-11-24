import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, Clock, Inbox, Kanban } from "lucide-react";
import { api, getAuthToken } from "./api.ts";
import { HeaderBar } from "./components/HeaderBar.tsx";
import { useI18n } from "./i18n.tsx";
import type {
  HealthResponse,
  InboxItem,
  LiveEventLogEntry,
  OperatingMode,
  PublicSetupStatus,
  RepoConfig,
  RepoMetricsSummary,
  Ticket,
} from "./types.ts";
import { InboxView } from "./views/InboxView.tsx";

const BoardView = lazy(() =>
  import("./views/BoardView.tsx").then((m) => ({ default: m.BoardView })),
);
const RoutinesView = lazy(() =>
  import("./views/RoutinesView.tsx").then((m) => ({ default: m.RoutinesView })),
);
const MetricsView = lazy(() =>
  import("./views/MetricsView.tsx").then((m) => ({ default: m.MetricsView })),
);
const DeepDiveDrawer = lazy(() =>
  import("./components/DeepDiveDrawer.tsx").then((m) => ({ default: m.DeepDiveDrawer })),
);
const DispatchTaskModal = lazy(() =>
  import("./components/DispatchTaskModal.tsx").then((m) => ({ default: m.DispatchTaskModal })),
);
const RepoSettingsModal = lazy(() =>
  import("./components/RepoSettingsModal.tsx").then((m) => ({ default: m.RepoSettingsModal })),
);
const SetupWizardModal = lazy(() =>
  import("./components/SetupWizardModal.tsx").then((m) => ({ default: m.SetupWizardModal })),
);
const SimulateEventModal = lazy(() =>
  import("./components/Modals.tsx").then((m) => ({ default: m.SimulateEventModal })),
);
const AddRepoModal = lazy(() =>
  import("./components/Modals.tsx").then((m) => ({ default: m.AddRepoModal })),
);
const WorktreeManagerModal = lazy(() =>
  import("./components/Modals.tsx").then((m) => ({ default: m.WorktreeManagerModal })),
);

type MainTab = "inbox" | "board" | "routines" | "metrics";

export function App() {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<MainTab>("inbox");
  const [repos, setRepos] = useState<RepoConfig[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState<string>("");
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [allTickets, setAllTickets] = useState<Ticket[]>([]);
  const [inboxItems, setInboxItems] = useState<InboxItem[]>([]);
  const [metrics, setMetrics] = useState<RepoMetricsSummary | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [sseConnected, setSseConnected] = useState(false);

  const [inspectedTicketId, setInspectedTicketId] = useState<string | null>(null);
  const [liveEvents, setLiveEvents] = useState<LiveEventLogEntry[]>([]);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [simulateOpen, setSimulateOpen] = useState(false);
  const [addRepoOpen, setAddRepoOpen] = useState(false);
  const [repoSettingsOpen, setRepoSettingsOpen] = useState(false);
  const [repoSettingsInitialTab, setRepoSettingsInitialTab] = useState<
    "runtime" | "contract" | "playbook" | "casebook"
  >("runtime");
  const [worktreesOpen, setWorktreesOpen] = useState(false);
  const [setupStatus, setSetupStatus] = useState<PublicSetupStatus | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupInitialTab, setSetupInitialTab] = useState<"config" | "doctor">("config");
  const setupAutoCheckedRef = useRef(false);

  const refreshAll = useCallback(async (repoFilter?: string) => {
    const [h, r, s] = await Promise.all([api.getHealth(), api.listRepos(), api.getSetupStatus()]);
    setHealth(h);
    setRepos(r.repos);
    setSetupStatus(s);
    if (!setupAutoCheckedRef.current) {
      setupAutoCheckedRef.current = true;
      if (!s.initialized) {
        setSetupOpen(true);
      }
    }

    const activeRepo = repoFilter || r.repos[0]?.id || "";
    if (!repoFilter && activeRepo) {
      setSelectedRepoId((prev) => prev || activeRepo);
    }

    const [tAll, i, m] = await Promise.all([
      api.listTickets(),
      api.listInbox(activeRepo || undefined),
      api.getMetrics(activeRepo || undefined),
    ]);
    setAllTickets(tAll.tickets);
    const byId = new Map(tAll.tickets.map((tkt) => [tkt.id, tkt]));
    const scopedTickets = activeRepo
      ? tAll.tickets.filter(
          (tkt) =>
            tkt.repoId === activeRepo ||
            (tkt.parentTicketId && byId.get(tkt.parentTicketId)?.repoId === activeRepo),
        )
      : tAll.tickets;
    setTickets(scopedTickets);
    setInboxItems(i.items);
    setMetrics(m.metrics);
  }, []);

  useEffect(() => {
    void refreshAll(selectedRepoId || undefined);
  }, [selectedRepoId, refreshAll]);

  // Subscribe to real-time Kernel SSE bus
  useEffect(() => {
    const token = getAuthToken();
    const sseUrl = token ? `/api/events?token=${encodeURIComponent(token)}` : "/api/events";
    const es = new EventSource(sseUrl);

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
      "repo_updated",
      "playbook_updated",
      "routine_updated",
      "routine_run_updated",
      "casebook_updated",
      "epic_replanned",
      "preview_updated",
      "checkpoint_created",
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
      "worktrees_gc",
      "verification_completed",
      "review_comment_updated",
    ];

    for (const name of eventNames) {
      es.addEventListener(name, (e: MessageEvent) => {
        try {
          const parsed = JSON.parse(e.data) as Record<string, unknown>;
          const tId =
            (parsed.ticketId as string | undefined) ||
            ((parsed.ticket as { id?: string } | undefined)?.id) ||
            ((parsed.checkpoint as { ticketId?: string } | undefined)?.ticketId) ||
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
    for (const t of allTickets) map.set(t.id, t);
    return map;
  }, [allTickets]);

  const pendingInboxCount = useMemo(
    () => inboxItems.filter((i) => i.status === "pending").length,
    [inboxItems],
  );

  const runningTicketCount = useMemo(
    () =>
      tickets.filter((tkt) =>
        ["planning", "spec_testing", "implementing", "reviewing", "rebasing"].includes(tkt.status),
      ).length,
    [tickets],
  );

  const attentionTicketCount = useMemo(
    () =>
      tickets.filter((tkt) =>
        ["watchdog_intervention", "needs_human"].includes(tkt.status),
      ).length,
    [tickets],
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
    deliveryAction?: "local_merge" | "push_and_create_pr",
    options?: { expandMandate?: boolean; budgetIncreaseUsd?: number; arenaWinnerId?: string },
  ) => {
    await api.resolveInbox(id, decision, note, deliveryAction, options);
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
        runningTicketCount={runningTicketCount}
        attentionTicketCount={attentionTicketCount}
        onOpenDispatch={() => setDispatchOpen(true)}
        onOpenSimulate={() => setSimulateOpen(true)}
        onOpenAddRepo={() => setAddRepoOpen(true)}
        onOpenRepoSettings={() => {
          setRepoSettingsInitialTab("runtime");
          setRepoSettingsOpen(true);
        }}
        onOpenContractSettings={() => {
          setRepoSettingsInitialTab("contract");
          setRepoSettingsOpen(true);
        }}
        onOpenRoutines={() => setActiveTab("routines")}
        onOpenWorktrees={() => setWorktreesOpen(true)}
        onOpenSetup={() => {
          setSetupInitialTab("config");
          setSetupOpen(true);
        }}
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

        <button
          onClick={() => setActiveTab("routines")}
          className={`inline-flex items-center gap-2 px-3 py-2.5 text-xs font-medium border-b-2 transition ${
            activeTab === "routines"
              ? "border-indigo-500 text-zinc-100"
              : "border-transparent text-zinc-500 hover:text-zinc-300"
          }`}
        >
          <Clock className="w-3.5 h-3.5" />
          {t("nav.routines")}
          {(health?.counts.activeRoutines ?? 0) > 0 && (
            <span className="px-1.5 py-0.2 rounded-full bg-teal-500/20 text-teal-300 border border-teal-500/30 text-[10px] font-mono">
              {health?.counts.activeRoutines}
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveTab("metrics")}
          className={`inline-flex items-center gap-2 px-3 py-2.5 text-xs font-medium border-b-2 transition ${
            activeTab === "metrics"
              ? "border-indigo-500 text-zinc-100"
              : "border-transparent text-zinc-500 hover:text-zinc-300"
          }`}
        >
          <BarChart3 className="w-3.5 h-3.5" />
          {t("nav.metrics")}
          {metrics?.budgetExceeded && (
            <span className="w-1.5 h-1.5 rounded-full bg-rose-400 animate-pulse" />
          )}
        </button>
      </nav>

      <main className="flex-1">
        {activeTab === "inbox" ? (
          <InboxView
            items={inboxItems}
            ticketsById={ticketsById}
            totalTicketCount={tickets.length}
            runningTicketCount={runningTicketCount}
            onResolve={handleResolveInbox}
            onInspectTicket={(id) => setInspectedTicketId(id)}
            onOpenDispatch={activeRepo ? () => setDispatchOpen(true) : undefined}
            onSwitchToBoard={() => setActiveTab("board")}
            onOpenContractSettings={
              activeRepo
                ? () => {
                    setRepoSettingsInitialTab("contract");
                    setRepoSettingsOpen(true);
                  }
                : undefined
            }
          />
        ) : activeTab === "board" ? (
          <Suspense fallback={null}>
            <BoardView
              tickets={tickets}
              allTickets={allTickets}
              repos={repos}
              selectedRepoId={selectedRepoId}
              availableEngines={health?.availableEngines ?? ["mock"]}
              onSelectTicket={(id) => setInspectedTicketId(id)}
              onRefresh={() => void refreshAll(selectedRepoId || undefined)}
            />
          </Suspense>
        ) : activeTab === "routines" ? (
          <Suspense fallback={null}>
            <RoutinesView
              repo={activeRepo}
              availableEngines={health?.availableEngines ?? ["mock"]}
              onInspectTicket={(id) => setInspectedTicketId(id)}
              onRefreshParent={() => void refreshAll(selectedRepoId || undefined)}
            />
          </Suspense>
        ) : (
          <Suspense fallback={null}>
            <MetricsView metrics={metrics} repo={activeRepo} />
          </Suspense>
        )}
      </main>

      <Suspense fallback={null}>
        <DeepDiveDrawer
          ticketId={inspectedTicketId}
          allTickets={allTickets}
          repos={repos}
          repo={activeRepo}
          liveEvents={liveEvents}
          onClose={() => setInspectedTicketId(null)}
          onSelectTicket={(id) => setInspectedTicketId(id)}
          onRefresh={() => void refreshAll(selectedRepoId || undefined)}
        />

        {activeRepo && (
          <>
            <DispatchTaskModal
              open={dispatchOpen}
              repoId={activeRepo.id}
              repos={repos}
              allTickets={allTickets}
              availableEngines={health?.availableEngines ?? ["mock"]}
              defaultTemplate={activeRepo.defaultTemplate}
              defaultTddMode={activeRepo.defaultTddMode}
              defaultEngine={activeRepo.preferredImplementEngine}
              onClose={() => setDispatchOpen(false)}
              onSubmit={async (data) => {
                await api.createTicket({ repoId: activeRepo.id, ...data });
                await refreshAll(activeRepo.id);
                setActiveTab("board");
              }}
              onCreateEpic={async (epicPayload) => {
                await api.createEpic(epicPayload);
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

        <RepoSettingsModal
          open={repoSettingsOpen}
          repo={activeRepo ?? null}
          initialTab={repoSettingsInitialTab}
          availableEngines={health?.availableEngines ?? ["mock"]}
          onClose={() => setRepoSettingsOpen(false)}
          onRefresh={() => void refreshAll(selectedRepoId || undefined)}
          onSubmit={async (repoId, patch) => {
            await api.patchRepo(repoId, patch);
            await refreshAll(repoId);
          }}
        />

        <WorktreeManagerModal
          open={worktreesOpen}
          repoId={activeRepo?.id}
          onClose={() => setWorktreesOpen(false)}
          onChanged={() => void refreshAll(selectedRepoId || undefined)}
          onOpenDoctor={() => {
            setSetupInitialTab("doctor");
            setSetupOpen(true);
          }}
        />

        <SetupWizardModal
          open={setupOpen}
          setupStatus={setupStatus}
          availableEngines={health?.availableEngines ?? ["mock"]}
          initialTab={setupInitialTab}
          onClose={() => setSetupOpen(false)}
          onSaved={async (next) => {
            setSetupStatus(next);
            await refreshAll(selectedRepoId || undefined);
          }}
        />
      </Suspense>
    </div>
  );
}
