import { Check, ChevronRight } from "lucide-react";
import { formatTicketStatus, useI18n, type TranslationKey } from "../i18n.tsx";
import type { LiveEventLogEntry, Ticket } from "../types.ts";
import {
  PIPELINE_STAGES,
  formatUsd,
  humanTicketPhase,
  stageIndex,
  type HumanTicketPhase,
} from "../utils/superAgent.ts";

const PHASE_BADGE: Record<HumanTicketPhase, string> = {
  working: "bg-indigo-500/15 text-indigo-300 border-indigo-500/30",
  queued: "bg-zinc-800 text-zinc-300 border-zinc-700",
  attention: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  done: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  failed: "bg-rose-500/15 text-rose-300 border-rose-500/30",
};

function StatusIndicator({ phase, label }: { phase: HumanTicketPhase; label: string }) {
  if (phase === "done") {
    return (
      <span className="mt-0.5 shrink-0 text-emerald-400" role="img" aria-label={label}>
        <Check className="w-4 h-4" aria-hidden="true" />
      </span>
    );
  }
  const color =
    phase === "working"
      ? "bg-indigo-400 motion-safe:animate-pulse"
      : phase === "attention"
        ? "bg-amber-400"
        : phase === "failed"
          ? "bg-rose-400"
          : "bg-zinc-600";
  return (
    <span className="mt-1.5 shrink-0 w-4 flex justify-center" role="img" aria-label={label}>
      <span className={`w-2 h-2 rounded-full ${color}`} />
    </span>
  );
}

/** Compact Plan · Code · Review · Merge pipeline highlighting the current stage. */
function StagePipeline({ stage }: { stage: Ticket["currentStage"] }) {
  const { t } = useI18n();
  const current = stageIndex(stage);
  if (current < 0) return null;
  return (
    <ol className="flex flex-wrap items-center gap-x-1.5 text-[10px] font-mono" aria-label="pipeline">
      {PIPELINE_STAGES.map((id, i) => (
        <li key={id} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-zinc-700" aria-hidden="true">·</span>}
          <span
            aria-current={i === current ? "step" : undefined}
            className={
              i === current ? "text-indigo-300 font-semibold" : i < current ? "text-emerald-500/70" : "text-zinc-600"
            }
          >
            {t(`live.stage.${id}` as TranslationKey)}
          </span>
        </li>
      ))}
    </ol>
  );
}

interface MissionRowProps {
  ticket: Ticket;
  lastEvent?: LiveEventLogEntry;
  onInspect: (ticketId: string) => void;
}

export function MissionRow({ ticket: tk, lastEvent, onInspect }: MissionRowProps) {
  const { locale, t } = useI18n();
  const phase = humanTicketPhase(tk.status);
  const phaseLabel = t(`live.phase.${phase}` as TranslationKey);
  const engine = tk.activeEngine ?? tk.preferredEngine;
  const showPipeline = phase === "working" || phase === "attention";

  return (
    <button
      type="button"
      onClick={() => onInspect(tk.id)}
      className="group w-full text-left flex items-start gap-3 rounded-xl border border-zinc-800/80 bg-zinc-900/50 hover:bg-zinc-900/90 hover:border-zinc-700 px-4 py-3.5 transition"
    >
      <StatusIndicator phase={phase} label={phaseLabel} />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="text-sm font-medium text-zinc-100 break-words">{tk.title}</div>
        {phase === "working" && lastEvent && (
          <div className="text-[11px] text-zinc-500 truncate">{lastEvent.summary}</div>
        )}
        {showPipeline && <StagePipeline stage={tk.currentStage} />}
      </div>
      <div className="shrink-0 flex items-center gap-2 font-mono tabular-nums text-[11px] text-zinc-400">
        {engine && <span className="hidden sm:inline">{engine}</span>}
        <span>{formatUsd(tk.costUsd)}</span>
        <span className={`px-2 py-0.5 rounded-md border ${PHASE_BADGE[phase]}`}>
          {formatTicketStatus(tk.status, locale)}
        </span>
        <ChevronRight
          className="w-3.5 h-3.5 text-zinc-600 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition"
          aria-hidden="true"
        />
      </div>
    </button>
  );
}
