import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { BookOpen, Clock, FileJson2, Activity, Wrench } from "lucide-react";
import { api } from "../api.ts";
import { useI18n, type TranslationKey } from "../i18n.tsx";
import type { RepoConfig, RepoMetricsSummary, WorkerEngineId } from "../types.ts";

const RepoSettingsModal = lazy(() =>
  import("./RepoSettingsModal.tsx").then((m) => ({ default: m.RepoSettingsModal })),
);
const RoutinesView = lazy(() => import("../views/RoutinesView.tsx").then((m) => ({ default: m.RoutinesView })));
const MetricsView = lazy(() => import("../views/MetricsView.tsx").then((m) => ({ default: m.MetricsView })));
const DoctorBackupPanel = lazy(() =>
  import("./DoctorBackupPanel.tsx").then((m) => ({ default: m.DoctorBackupPanel })),
);
const WorktreePanel = lazy(() =>
  import("./OperationsPanels.tsx").then((m) => ({ default: m.WorktreePanel })),
);
const MergeTrainPanel = lazy(() =>
  import("./OperationsPanels.tsx").then((m) => ({ default: m.MergeTrainPanel })),
);
const SimulatePanel = lazy(() =>
  import("./OperationsPanels.tsx").then((m) => ({ default: m.SimulatePanel })),
);

export type EngineRoomTab = "contract" | "memory" | "automation" | "operations" | "observability";
export type EngineRoomSection =
  | "doctor"
  | "mergeTrain"
  | "worktrees"
  | "simulate"
  | "contract"
  | "memory"
  | "automation";

/** `nonce` makes repeated requests for the same section re-trigger expand + scroll. */
export interface EngineRoomTarget {
  section: EngineRoomSection;
  nonce: number;
}

const SECTION_TAB: Record<EngineRoomSection, EngineRoomTab> = {
  doctor: "observability",
  mergeTrain: "operations",
  worktrees: "operations",
  simulate: "operations",
  contract: "contract",
  memory: "memory",
  automation: "automation",
};

const TABS: Array<{ id: EngineRoomTab; labelKey: TranslationKey; icon: typeof Wrench }> = [
  { id: "contract", labelKey: "engineRoom.tab.contract", icon: FileJson2 },
  { id: "memory", labelKey: "engineRoom.tab.memory", icon: BookOpen },
  { id: "automation", labelKey: "engineRoom.tab.automation", icon: Clock },
  { id: "operations", labelKey: "engineRoom.tab.operations", icon: Wrench },
  { id: "observability", labelKey: "engineRoom.tab.observability", icon: Activity },
];

type RepoPatch = Parameters<typeof api.patchRepo>[1];

interface EngineRoomPanelProps {
  repo: RepoConfig | undefined;
  repos: RepoConfig[];
  availableEngines: WorkerEngineId[];
  target: EngineRoomTarget | null;
  metrics: RepoMetricsSummary | null;
  onInspectTicket: (ticketId: string) => void;
  onRefresh: () => void;
  onPatchRepo: (repoId: string, patch: RepoPatch) => Promise<void>;
}

const Fallback = () => <div className="py-10 text-center text-xs text-zinc-500">…</div>;

export function EngineRoomPanel({
  repo,
  repos,
  availableEngines,
  target,
  metrics,
  onInspectTicket,
  onRefresh,
  onPatchRepo,
}: EngineRoomPanelProps) {
  const { t } = useI18n();
  const [tab, setTab] = useState<EngineRoomTab>("contract");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sectionRef = useRef<EngineRoomSection | null>(null);

  useEffect(() => {
    if (!target) return;
    sectionRef.current = target.section;
    setTab(SECTION_TAB[target.section]);
    // Wait for lazy content to mount before scrolling to the requested section.
    const id = window.setTimeout(() => {
      const el =
        document.getElementById(`engine-room-${target.section}`) ?? rootRef.current;
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 250);
    return () => window.clearTimeout(id);
  }, [target]);

  const openDoctor = () => setTab("observability");

  return (
    <div ref={rootRef} className="rounded-xl border border-zinc-800 bg-zinc-900/30">
      <div role="tablist" className="flex flex-wrap items-center gap-1 border-b border-zinc-800 px-3">
        {TABS.map(({ id, labelKey, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`inline-flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 -mb-px transition ${
              tab === id
                ? "border-indigo-500 text-indigo-300"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {t(labelKey)}
          </button>
        ))}
      </div>

      <div className="p-4">
        <Suspense fallback={<Fallback />}>
          {tab === "contract" && (
            <div id="engine-room-contract">
              <RepoSettingsModal
                key="contract"
                open
                embedded
                repo={repo ?? null}
                initialTab="runtime"
                visibleTabs={["runtime", "contract"]}
                availableEngines={availableEngines}
                onClose={() => undefined}
                onRefresh={onRefresh}
                onSubmit={onPatchRepo}
              />
            </div>
          )}

          {tab === "memory" && (
            <div id="engine-room-memory">
              <RepoSettingsModal
                key="memory"
                open
                embedded
                repo={repo ?? null}
                initialTab="playbook"
                visibleTabs={["playbook", "casebook"]}
                availableEngines={availableEngines}
                onClose={() => undefined}
                onRefresh={onRefresh}
                onSubmit={onPatchRepo}
              />
            </div>
          )}

          {tab === "automation" && (
            <RoutinesView
              repo={repo}
              availableEngines={availableEngines}
              onInspectTicket={onInspectTicket}
              onRefreshParent={onRefresh}
            />
          )}

          {tab === "operations" && (
            <div className="space-y-4">
              <div id="engine-room-mergeTrain">
                <MergeTrainPanel
                  repoId={repo?.id}
                  repos={repos}
                  onInspectTicket={onInspectTicket}
                  onChanged={onRefresh}
                />
              </div>
              <div id="engine-room-worktrees">
                <WorktreePanel repoId={repo?.id} onChanged={onRefresh} onOpenDoctor={openDoctor} />
              </div>
              <div id="engine-room-simulate">
                <SimulatePanel repoId={repo?.id} onDone={onRefresh} />
              </div>
            </div>
          )}

          {tab === "observability" && (
            <div className="space-y-6">
              <div id="engine-room-doctor">
                <DoctorBackupPanel />
              </div>
              <MetricsView metrics={metrics} repo={repo} availableEngines={availableEngines} />
            </div>
          )}
        </Suspense>
      </div>
    </div>
  );
}
