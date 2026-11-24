import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  ExternalLink,
  GitBranch,
  Lock,
  Pause,
  Play,
  RotateCcw,
  ShieldCheck,
  Sliders,
} from "lucide-react";
import { api } from "../api.ts";
import { formatEngineDisplayName, formatStage, formatTicketStatus, useI18n } from "../i18n.tsx";
import type { EnginePreference, RepoConfig, Ticket } from "../types.ts";

interface DagCanvasProps {
  tickets: Ticket[];
  repos?: RepoConfig[];
  availableEngines?: string[];
  onInspectTicket: (ticketId: string) => void;
  onMutated?: () => void;
}

const NODE_W = 248;
const NODE_H = 104;
const COL_GAP = 72;
const ROW_GAP = 20;
const PAD = 24;

function computeLayeredNodes(tickets: Ticket[]): {
  nodes: Array<{ ticket: Ticket; wave: number; row: number; x: number; y: number }>;
  edges: Array<{
    fromId: string;
    toId: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    semantic: boolean;
  }>;
  width: number;
  height: number;
} {
  const concrete = tickets.filter((t) => !t.isEpic);
  if (concrete.length === 0) {
    return { nodes: [], edges: [], width: 640, height: 220 };
  }

  const byId = new Map(concrete.map((t) => [t.id, t]));
  const waveMemo = new Map<string, number>();

  const calcWave = (id: string, stack = new Set<string>()): number => {
    const cached = waveMemo.get(id);
    if (cached !== undefined) return cached;
    if (stack.has(id)) return 0;
    stack.add(id);
    const t = byId.get(id);
    let maxUp = -1;
    for (const depId of t?.dependsOn ?? []) {
      if (byId.has(depId)) {
        maxUp = Math.max(maxUp, calcWave(depId, new Set(stack)));
      }
    }
    const wave = maxUp + 1;
    waveMemo.set(id, wave);
    return wave;
  };

  for (const t of concrete) {
    calcWave(t.id);
  }

  const columns = new Map<number, Ticket[]>();
  for (const t of concrete) {
    const w = waveMemo.get(t.id) ?? 0;
    const list = columns.get(w) ?? [];
    list.push(t);
    columns.set(w, list);
  }

  const maxWave = Math.max(0, ...Array.from(columns.keys()));
  const maxRows = Math.max(1, ...Array.from(columns.values()).map((c) => c.length));

  const nodes: Array<{ ticket: Ticket; wave: number; row: number; x: number; y: number }> = [];
  const posById = new Map<string, { x: number; y: number }>();

  for (let w = 0; w <= maxWave; w++) {
    const col = columns.get(w) ?? [];
    col.forEach((ticket, row) => {
      const x = PAD + w * (NODE_W + COL_GAP);
      const y = PAD + row * (NODE_H + ROW_GAP);
      posById.set(ticket.id, { x, y });
      nodes.push({ ticket, wave: w, row, x, y });
    });
  }

  const edges: Array<{
    fromId: string;
    toId: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    semantic: boolean;
  }> = [];

  for (const t of concrete) {
    const dst = posById.get(t.id);
    if (!dst) continue;
    const semanticDeps = new Set(t.impactSummary?.semanticDepTicketIds ?? []);
    for (const depId of t.dependsOn) {
      const src = posById.get(depId);
      if (!src) continue;
      edges.push({
        fromId: depId,
        toId: t.id,
        x1: src.x + NODE_W,
        y1: src.y + NODE_H / 2,
        x2: dst.x,
        y2: dst.y + NODE_H / 2,
        semantic: semanticDeps.has(depId),
      });
    }
  }

  return {
    nodes,
    edges,
    width: Math.max(680, PAD * 2 + (maxWave + 1) * NODE_W + maxWave * COL_GAP),
    height: Math.max(240, PAD * 2 + maxRows * NODE_H + Math.max(0, maxRows - 1) * ROW_GAP),
  };
}

function nodeAccent(status: Ticket["status"]): string {
  switch (status) {
    case "delivered":
      return "border-emerald-500/45 bg-emerald-950/20";
    case "needs_human":
    case "failed":
      return "border-rose-500/45 bg-rose-950/20";
    case "spec_testing":
    case "planning":
    case "implementing":
    case "reviewing":
    case "rebasing":
      return "border-amber-500/45 bg-amber-950/20";
    case "waiting_deps":
    case "queued":
      return "border-indigo-500/35 bg-zinc-950/90";
    default:
      return "border-zinc-800 bg-zinc-950/85";
  }
}

export function DagCanvas({
  tickets,
  repos = [],
  availableEngines = ["claude", "codex", "opencode", "gemini", "mock"],
  onInspectTicket,
  onMutated,
}: DagCanvasProps) {
  const { locale, t } = useI18n();
  const layout = useMemo(() => computeLayeredNodes(tickets), [tickets]);
  const [selectedId, setSelectedId] = useState<string | null>(
    () => layout.nodes[0]?.ticket.id ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const selectedTicket = useMemo(
    () => layout.nodes.find((n) => n.ticket.id === selectedId)?.ticket ?? layout.nodes[0]?.ticket ?? null,
    [layout.nodes, selectedId],
  );

  const [editEngine, setEditEngine] = useState<string>("");
  const [editPaths, setEditPaths] = useState("");
  const [editDeps, setEditDeps] = useState("");
  const [editTdd, setEditTdd] = useState(false);
  const [editPause, setEditPause] = useState(false);

  useEffect(() => {
    if (!selectedTicket) return;
    setErrorMsg(null);
    setEditEngine(selectedTicket.preferredEngine ?? "");
    setEditPaths(selectedTicket.mandate.allowedPaths.join(", "));
    setEditDeps(selectedTicket.dependsOn.join(", "));
    setEditTdd(Boolean(selectedTicket.tddMode));
    setEditPause(Boolean(selectedTicket.pauseBeforeRun));
  }, [selectedTicket?.id, selectedTicket?.updatedAt]);

  if (layout.nodes.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 p-8 text-center text-xs text-zinc-500">
        {t("dag.empty")}
      </div>
    );
  }

  const reposById = new Map(repos.map((r) => [r.id, r]));
  const editableStatuses = new Set(["waiting_deps", "queued", "proposed", "needs_human"]);
  const canEditSelected = selectedTicket ? editableStatuses.has(selectedTicket.status) : false;

  const handleAction = async (action: "pause" | "resume" | "rerun") => {
    if (!selectedTicket) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      await api.mutateDagNode(selectedTicket.id, { action });
      onMutated?.();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSaveUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTicket) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      await api.mutateDagNode(selectedTicket.id, {
        action: "update",
        preferredEngine: editEngine ? (editEngine as EnginePreference) : undefined,
        allowedPaths: editPaths
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        dependsOn: editDeps
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        tddMode: editTdd,
        pauseBeforeRun: editPause,
      });
      onMutated?.();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Layered Topological SVG + HTML Canvas */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-950/90 overflow-auto">
        <div
          className="relative"
          style={{ width: `${layout.width}px`, height: `${layout.height}px` }}
        >
          <svg
            width={layout.width}
            height={layout.height}
            className="absolute inset-0 pointer-events-none"
          >
            <defs>
              <marker
                id="sw-dag-arrow"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 1 L 8 5 L 0 9 z" fill="#6366f1" />
              </marker>
              <marker
                id="sw-dag-arrow-teal"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 1 L 8 5 L 0 9 z" fill="#14b8a6" />
              </marker>
            </defs>
            {layout.edges.map((edge) => {
              const dx = Math.max(32, Math.abs(edge.x2 - edge.x1) * 0.5);
              const d = `M ${edge.x1} ${edge.y1} C ${edge.x1 + dx} ${edge.y1}, ${edge.x2 - dx} ${edge.y2}, ${edge.x2 - 4} ${edge.y2}`;
              return (
                <path
                  key={`${edge.fromId}->${edge.toId}`}
                  d={d}
                  fill="none"
                  stroke={edge.semantic ? "#14b8a6" : "#6366f1"}
                  strokeWidth={edge.semantic ? 2 : 1.75}
                  strokeDasharray={edge.semantic ? "5 3" : undefined}
                  strokeOpacity={0.78}
                  markerEnd={edge.semantic ? "url(#sw-dag-arrow-teal)" : "url(#sw-dag-arrow)"}
                />
              );
            })}
          </svg>

          {layout.nodes.map(({ ticket, wave, x, y }) => {
            const isSelected = selectedTicket?.id === ticket.id;
            const repoName = reposById.get(ticket.repoId)?.name;
            return (
              <div
                key={ticket.id}
                onClick={() => setSelectedId(ticket.id)}
                style={{ left: `${x}px`, top: `${y}px`, width: `${NODE_W}px`, height: `${NODE_H}px` }}
                className={`absolute rounded-lg border p-2.5 flex flex-col justify-between cursor-pointer transition shadow-sm ${nodeAccent(
                  ticket.status,
                )} ${isSelected ? "ring-2 ring-indigo-400 border-indigo-400" : "hover:border-zinc-600"}`}
              >
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex items-center gap-1 min-w-0">
                    <span className="px-1.5 py-0.2 rounded bg-zinc-900 border border-zinc-700 font-mono text-[9px] text-zinc-400 shrink-0">
                      {t("dag.wavePrefix")} {wave + 1}
                      {t("dag.waveSuffix")}
                    </span>
                    {ticket.subtaskKey && (
                      <span className="px-1.5 py-0.2 rounded bg-purple-500/15 border border-purple-500/30 font-mono text-[9px] text-purple-200 truncate">
                        {ticket.subtaskKey}
                      </span>
                    )}
                  </div>
                  <span className="px-1.5 py-0.2 rounded bg-zinc-900/90 border border-zinc-700/80 font-mono text-[9px] text-zinc-200 shrink-0">
                    {formatTicketStatus(ticket.status, locale)}
                  </span>
                </div>

                <div className="min-w-0">
                  <div className="text-[11px] font-medium text-zinc-100 truncate">{ticket.title}</div>
                  <div className="text-[10px] font-mono text-zinc-500 truncate">
                    {repoName ? `${repoName} · ` : ""}
                    {formatStage(ticket.currentStage, locale)}
                  </div>
                </div>

                <div className="flex items-center justify-between gap-1 text-[9px] font-mono">
                  <div className="flex items-center gap-1 flex-wrap min-w-0">
                    <span className="px-1 py-0.2 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/25">
                      {formatEngineDisplayName(
                        ticket.activeEngine ?? ticket.preferredEngine ?? "auto",
                        locale,
                      )}
                    </span>
                    {ticket.tddMode && (
                      <span className="inline-flex items-center gap-0.5 px-1 py-0.2 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                        <Lock className="w-2.5 h-2.5" />
                        TDD
                      </span>
                    )}
                    {ticket.pauseBeforeRun && (
                      <span className="inline-flex items-center gap-0.5 px-1 py-0.2 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
                        <Pause className="w-2.5 h-2.5" />
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onInspectTicket(ticket.id);
                    }}
                    className="text-zinc-400 hover:text-indigo-300 inline-flex items-center gap-0.5 shrink-0"
                  >
                    <ExternalLink className="w-2.5 h-2.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Selected Node Live Surgery Panel */}
      {selectedTicket && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 space-y-3 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <Sliders className="w-3.5 h-3.5 text-indigo-400" />
              <span className="font-semibold text-zinc-100">{t("dag.editTitle")}</span>
              <span className="font-mono text-[11px] text-indigo-300">{selectedTicket.id}</span>
              <span className="text-zinc-300 truncate max-w-md">{selectedTicket.title}</span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {selectedTicket.status === "needs_human" ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleAction("resume")}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-emerald-500/40 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 text-[11px] disabled:opacity-50"
                >
                  <Play className="w-3 h-3" />
                  {t("dag.resumeBtn")}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy || selectedTicket.status === "delivered"}
                  onClick={() => void handleAction("pause")}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-amber-500/40 bg-amber-500/15 hover:bg-amber-500/25 text-amber-200 text-[11px] disabled:opacity-40"
                >
                  <Pause className="w-3 h-3" />
                  {t("dag.pauseBtn")}
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleAction("rerun")}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-sky-500/40 bg-sky-500/15 hover:bg-sky-500/25 text-sky-200 text-[11px] disabled:opacity-50"
              >
                <RotateCcw className="w-3 h-3" />
                {t("dag.rerunBtn")}
              </button>
              <button
                type="button"
                onClick={() => onInspectTicket(selectedTicket.id)}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 text-[11px]"
              >
                <ExternalLink className="w-3 h-3" />
                {t("inbox.inspectDeepDive").replace(" →", "")}
              </button>
            </div>
          </div>

          {errorMsg && (
            <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200 flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          <form onSubmit={handleSaveUpdate} className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">{t("dag.engineLabel")}</label>
              <select
                disabled={!canEditSelected || busy}
                value={editEngine}
                onChange={(e) => setEditEngine(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 font-mono text-zinc-100 disabled:opacity-50"
              >
                <option value="auto">auto (Bandit)</option>
                {Array.from(new Set([...availableEngines, "claude", "codex", "opencode", "gemini", "mock"])).map(
                  (eng) => (
                    <option key={eng} value={eng}>
                      {eng}
                    </option>
                  ),
                )}
              </select>
            </div>
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">{t("dag.pathsLabel")}</label>
              <input
                disabled={!canEditSelected || busy}
                value={editPaths}
                onChange={(e) => setEditPaths(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 font-mono text-zinc-100 disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-[11px] text-zinc-400 mb-1">{t("dag.depsLabel")}</label>
              <div className="flex items-center gap-1.5">
                <GitBranch className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                <input
                  disabled={!canEditSelected || busy}
                  value={editDeps}
                  onChange={(e) => setEditDeps(e.target.value)}
                  placeholder="tkt_..."
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 font-mono text-zinc-100 disabled:opacity-50"
                />
              </div>
            </div>

            <div className="md:col-span-3 flex flex-wrap items-center justify-between gap-3 pt-1">
              <div className="flex flex-wrap items-center gap-4">
                <label className="inline-flex items-center gap-1.5 text-[11px] text-zinc-300 cursor-pointer">
                  <input
                    type="checkbox"
                    disabled={!canEditSelected || busy}
                    checked={editTdd}
                    onChange={(e) => setEditTdd(e.target.checked)}
                    className="rounded border-zinc-700 bg-zinc-950 text-indigo-500"
                  />
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                  {t("dag.tddLabel")}
                </label>
                <label className="inline-flex items-center gap-1.5 text-[11px] text-zinc-300 cursor-pointer">
                  <input
                    type="checkbox"
                    disabled={!canEditSelected || busy}
                    checked={editPause}
                    onChange={(e) => setEditPause(e.target.checked)}
                    className="rounded border-zinc-700 bg-zinc-950 text-indigo-500"
                  />
                  <Pause className="w-3.5 h-3.5 text-amber-400" />
                  {t("dag.breakpointLabel")}
                </label>
              </div>
              <button
                type="submit"
                disabled={!canEditSelected || busy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-medium disabled:opacity-40"
              >
                <Check className="w-3 h-3" />
                {t("dag.saveBtn")}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
