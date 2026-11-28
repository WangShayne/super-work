import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.ts";
import type { EngineRoomSection, EngineRoomTarget } from "./components/EngineRoomPanel.tsx";
import type { ResolveHandler } from "./components/NeedsYouCard.tsx";
import { HeaderBar, type MainTab } from "./components/HeaderBar.tsx";
import { useKernelEvents } from "./hooks/useKernelEvents.ts";
import type {
  AutonomyPreset,
  EngineHealthRecord,
  HealthResponse,
  InboxItem,
  PublicSetupStatus,
  RepoConfig,
  RepoMetricsSummary,
  RequirementRouteKind,
  Ticket,
} from "./types.ts";

const HomeView = lazy(() => import("./views/HomeView.tsx").then((m) => ({ default: m.HomeView })));
const HistoryView = lazy(() => import("./views/HistoryView.tsx").then((m) => ({ default: m.HistoryView })));
const SettingsView = lazy(() => import("./views/SettingsView.tsx").then((m) => ({ default: m.SettingsView })));
const DeepDiveDrawer = lazy(() =>
  import("./components/DeepDiveDrawer.tsx").then((m) => ({ default: m.DeepDiveDrawer })),
);
const SetupWizardModal = lazy(() =>
  import("./components/SetupWizardModal.tsx").then((m) => ({ default: m.SetupWizardModal })),
);
const AddRepoModal = lazy(() =>
  import("./components/Modals.tsx").then((m) => ({ default: m.AddRepoModal })),
);
const CommandPaletteModal = lazy(() =>
  import("./components/CommandPaletteModal.tsx").then((m) => ({ default: m.CommandPaletteModal })),
);

type RepoPatch = Parameters<typeof api.patchRepo>[1];

/** SSE must stay offline this long after mount before the header raises an alert. */
const SSE_GRACE_MS = 2000;

export function App() {
  const [sseGraceElapsed, setSseGraceElapsed] = useState(false);
  const [activeTab, setActiveTab] = useState<MainTab>("home");
  const [repos, setRepos] = useState<RepoConfig[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState("");
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [allTickets, setAllTickets] = useState<Ticket[]>([]);
  const [inboxItems, setInboxItems] = useState<InboxItem[]>([]);
  const [metrics, setMetrics] = useState<RepoMetricsSummary | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [inspectedTicketId, setInspectedTicketId] = useState<string | null>(null);
  const [addRepoOpen, setAddRepoOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [setupStatus, setSetupStatus] = useState<PublicSetupStatus | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [engineRoomTarget, setEngineRoomTarget] = useState<EngineRoomTarget | null>(null);
  const [engineHealth, setEngineHealth] = useState<EngineHealthRecord[]>([]);
  const setupAutoCheckedRef = useRef(false);

  const refreshAll = useCallback(async (repoFilter?: string) => {
    const [h, r, s] = await Promise.all([api.getHealth(), api.listRepos(), api.getSetupStatus()]);
    setHealth(h);
    setRepos(r.repos);
    setSetupStatus(s);
    api
      .listEngineHealth()
      .then(({ engines }) => setEngineHealth(engines))
      .catch(() => undefined);
    if (!setupAutoCheckedRef.current) {
      setupAutoCheckedRef.current = true;
      if (!s.initialized) setSetupOpen(true);
    }

    const activeRepoId = repoFilter || r.repos[0]?.id || "";
    if (!repoFilter && activeRepoId) setSelectedRepoId((prev) => prev || activeRepoId);

    const [tAll, i, m] = await Promise.all([
      api.listTickets(),
      api.listInbox(activeRepoId || undefined),
      api.getMetrics(activeRepoId || undefined),
    ]);
    setAllTickets(tAll.tickets);
    const byId = new Map(tAll.tickets.map((tkt) => [tkt.id, tkt]));
    setTickets(
      activeRepoId
        ? tAll.tickets.filter(
            (tkt) =>
              tkt.repoId === activeRepoId ||
              (tkt.parentTicketId && byId.get(tkt.parentTicketId)?.repoId === activeRepoId),
          )
        : tAll.tickets,
    );
    setInboxItems(i.items);
    setMetrics(m.metrics);
  }, []);

  const refresh = useCallback(() => void refreshAll(selectedRepoId || undefined), [refreshAll, selectedRepoId]);

  useEffect(() => {
    void refreshAll(selectedRepoId || undefined);
  }, [selectedRepoId, refreshAll]);

  useEffect(() => {
    const timer = window.setTimeout(() => setSseGraceElapsed(true), SSE_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const { sseConnected, liveEvents } = useKernelEvents(refresh);

  const ticketsById = useMemo(() => new Map(allTickets.map((tkt) => [tkt.id, tkt])), [allTickets]);
  const pendingInboxCount = useMemo(() => inboxItems.filter((i) => i.status === "pending").length, [inboxItems]);
  const activeRepo = repos.find((r) => r.id === selectedRepoId) ?? repos[0];
  const availableEngines = health?.availableEngines ?? ["mock"];

  const openEngineRoom = useCallback((section: EngineRoomSection) => {
    setEngineRoomTarget({ section, nonce: Date.now() });
    setActiveTab("settings");
  }, []);

  const patchRepo = async (repoId: string, patch: RepoPatch) => {
    await api.patchRepo(repoId, patch);
    await refreshAll(repoId);
  };

  const handleChangeAutonomyPreset = (repoId: string, autonomyPreset: AutonomyPreset) => {
    // Optimistic UI; refreshAll restores server truth (including on failure).
    setRepos((prev) => prev.map((r) => (r.id === repoId ? { ...r, autonomyPreset } : r)));
    void api
      .patchRepo(repoId, { autonomyPreset })
      .catch(() => undefined)
      .then(() => refreshAll(repoId));
  };

  const handleResolveInbox: ResolveHandler = async (id, decision, note, deliveryAction, options) => {
    await api.resolveInbox(id, decision, note, deliveryAction, options);
    await refreshAll(selectedRepoId || undefined);
  };

  const handleComposerSubmitted = async (route: RequirementRouteKind | "milestone") => {
    await refreshAll(selectedRepoId || undefined);
    if (route === "goal_campaign") openEngineRoom("automation");
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      <HeaderBar
        activeTab={activeTab}
        onChangeTab={setActiveTab}
        pendingInboxCount={pendingInboxCount}
        historyCount={tickets.length}
        repos={repos}
        selectedRepoId={selectedRepoId}
        onSelectRepo={setSelectedRepoId}
        sseOffline={sseGraceElapsed && !sseConnected}
        engineHealth={engineHealth}
        availableEngines={availableEngines}
        selfReload={health?.selfReload}
        onOpenAddRepo={() => setAddRepoOpen(true)}
        onOpenCommandPalette={() => setCommandPaletteOpen(true)}
        onOpenEngineHealth={() => openEngineRoom("doctor")}
      />

      <main className="flex-1">
        <Suspense fallback={null}>
          {activeTab === "home" ? (
            <HomeView
              repo={activeRepo}
              repos={repos}
              selectedRepoId={selectedRepoId}
              onSelectRepo={setSelectedRepoId}
              onChangeAutonomyPreset={handleChangeAutonomyPreset}
              tickets={tickets}
              ticketsById={ticketsById}
              inboxItems={inboxItems}
              liveEvents={liveEvents}
              modelProfiles={setupStatus?.config.modelProfiles ?? []}
              onResolve={handleResolveInbox}
              onRefresh={refresh}
              onInspectTicket={setInspectedTicketId}
              onOpenAddRepo={() => setAddRepoOpen(true)}
              onComposerSubmitted={handleComposerSubmitted}
            />
          ) : activeTab === "history" ? (
            <HistoryView
              tickets={tickets}
              allTickets={allTickets}
              repos={repos}
              selectedRepoId={selectedRepoId}
              metrics={metrics}
              availableEngines={availableEngines}
              onInspectTicket={setInspectedTicketId}
              onRefresh={refresh}
            />
          ) : (
            <SettingsView
              repo={activeRepo}
              repos={repos}
              availableEngines={availableEngines}
              setupStatus={setupStatus}
              metrics={metrics}
              target={engineRoomTarget}
              onChangeAutonomyPreset={handleChangeAutonomyPreset}
              onPatchRepo={patchRepo}
              onOpenAddRepo={() => setAddRepoOpen(true)}
              onSetupSaved={(next) => {
                setSetupStatus(next);
                refresh();
              }}
              onInspectTicket={setInspectedTicketId}
              onRefresh={refresh}
            />
          )}
        </Suspense>
      </main>

      <Suspense fallback={null}>
        <DeepDiveDrawer
          ticketId={inspectedTicketId}
          allTickets={allTickets}
          repos={repos}
          repo={activeRepo}
          modelProfiles={setupStatus?.config.modelProfiles ?? []}
          liveEvents={liveEvents}
          onClose={() => setInspectedTicketId(null)}
          onSelectTicket={setInspectedTicketId}
          onRefresh={refresh}
        />

        <AddRepoModal
          open={addRepoOpen}
          onClose={() => setAddRepoOpen(false)}
          onSubmit={async (data) => {
            const res = await api.createRepo(data);
            setSelectedRepoId(res.repo.id);
            await refreshAll(res.repo.id);
          }}
        />

        <SetupWizardModal
          open={setupOpen}
          setupStatus={setupStatus}
          onClose={() => setSetupOpen(false)}
          onSaved={async (next) => {
            setSetupStatus(next);
            await refreshAll(selectedRepoId || undefined);
          }}
        />

        <CommandPaletteModal
          open={commandPaletteOpen}
          onClose={() => setCommandPaletteOpen(false)}
          repos={repos}
          selectedRepoId={selectedRepoId}
          tickets={tickets}
          inboxItems={inboxItems}
          onSelectRepo={setSelectedRepoId}
          onSwitchTab={setActiveTab}
          onInspectTicket={setInspectedTicketId}
          onOpenEngineRoom={openEngineRoom}
          onRefresh={refresh}
        />
      </Suspense>
    </div>
  );
}
