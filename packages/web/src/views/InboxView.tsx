import { useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  DollarSign,
  Eye,
  FileCode2,
  GitMerge,
  GitPullRequest,
  Send,
  ShieldAlert,
  ShieldPlus,
  X,
} from "lucide-react";
import { formatInboxKind, formatInboxStatus, useI18n } from "../i18n.tsx";
import type { InboxItem, Ticket } from "../types.ts";

interface InboxViewProps {
  items: InboxItem[];
  ticketsById: Map<string, Ticket>;
  onResolve: (
    id: string,
    decision: "approved" | "rejected",
    note?: string,
    deliveryAction?: "local_merge" | "push_and_create_pr",
    options?: { expandMandate?: boolean; budgetIncreaseUsd?: number },
  ) => Promise<void>;
  onInspectTicket: (ticketId: string) => void;
}

const KIND_STYLE: Record<InboxItem["kind"], { color: string; icon: typeof Eye }> = {
  mandate_violation: {
    color: "bg-rose-500/15 text-rose-300 border-rose-500/30",
    icon: ShieldAlert,
  },
  watchdog_escalation: {
    color: "bg-orange-500/15 text-orange-300 border-orange-500/30",
    icon: AlertTriangle,
  },
  merge_conflict: {
    color: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    icon: GitMerge,
  },
  plan_approval: {
    color: "bg-sky-500/15 text-sky-300 border-sky-500/30",
    icon: FileCode2,
  },
  outbox_signoff: {
    color: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    icon: Send,
  },
  observe_proposal: {
    color: "bg-indigo-500/15 text-indigo-300 border-indigo-500/30",
    icon: Eye,
  },
  budget_cap: {
    color: "bg-yellow-500/15 text-yellow-300 border-yellow-500/30",
    icon: DollarSign,
  },
  pr_followup: {
    color: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
    icon: GitPullRequest,
  },
};

export function InboxView({ items, ticketsById, onResolve, onInspectTicket }: InboxViewProps) {
  const { locale, t } = useI18n();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const pending = items.filter((i) => i.status === "pending");
  const resolved = items.filter((i) => i.status !== "pending").slice(0, 10);

  const handleAction = async (
    id: string,
    decision: "approved" | "rejected",
    deliveryAction?: "local_merge" | "push_and_create_pr",
    options?: { expandMandate?: boolean; budgetIncreaseUsd?: number },
  ) => {
    setBusyId(id);
    try {
      await onResolve(id, decision, notes[id]?.trim() || undefined, deliveryAction, options);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">{t("inbox.title")}</h2>
          <p className="text-xs text-zinc-400 mt-0.5">
            {t("inbox.subtitle")}
          </p>
        </div>
        <span className="text-xs font-mono px-2.5 py-1 rounded-full bg-zinc-900 border border-zinc-800 text-zinc-300">
          {pending.length} {t("inbox.pendingSuffix")}
        </span>
      </div>

      {pending.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 p-12 text-center">
          <CheckCircle2 className="w-10 h-10 text-emerald-400/80 mx-auto mb-3" />
          <h3 className="text-sm font-medium text-zinc-200">{t("inbox.emptyTitle")}</h3>
          <p className="text-xs text-zinc-500 mt-1 max-w-md mx-auto">
            {t("inbox.emptyDesc")}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {pending.map((item) => {
            const style = KIND_STYLE[item.kind];
            const Icon = style.icon;
            const ticket = ticketsById.get(item.ticketId);
            const isBusy = busyId === item.id;

            return (
              <div
                key={item.id}
                className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 space-y-4 hover:border-zinc-700 transition"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-mono font-semibold border ${style.color}`}
                      >
                        <Icon className="w-3 h-3" />
                        {formatInboxKind(item.kind, locale)}
                      </span>
                      <span className="text-xs font-mono text-zinc-500">{item.ticketId}</span>
                      {ticket && (
                        <span className="text-[11px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 font-mono">
                          {ticket.template} · {ticket.mandate.allowedPaths.join(", ")}
                        </span>
                      )}
                    </div>
                    <h3 className="text-sm font-semibold text-zinc-100">{item.title}</h3>
                  </div>

                  <button
                    onClick={() => onInspectTicket(item.ticketId)}
                    className="text-xs text-indigo-400 hover:text-indigo-300 font-medium"
                  >
                    {t("inbox.inspectDeepDive")}
                  </button>
                </div>

                <p className="text-xs text-zinc-300 whitespace-pre-wrap leading-relaxed bg-zinc-950/60 border border-zinc-800/80 rounded-lg p-3">
                  {item.summary}
                </p>

                {item.kind === "mandate_violation" && item.contextPayload.canExpandMandate === true && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200 flex flex-wrap items-center gap-2">
                    <ShieldPlus className="w-3.5 h-3.5 shrink-0" />
                    <span>{t("inbox.pendingViolationNotice")}:</span>
                    {Array.isArray(item.contextPayload.scopeViolations) &&
                      (item.contextPayload.scopeViolations as string[]).map((p) => (
                        <code
                          key={p}
                          className="px-1.5 py-0.5 rounded bg-zinc-950/70 border border-amber-500/30 font-mono text-[10px]"
                        >
                          {p}
                        </code>
                      ))}
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2.5">
                  <input
                    type="text"
                    placeholder={t("inbox.notePlaceholder")}
                    value={notes[item.id] ?? ""}
                    onChange={(e) => setNotes((prev) => ({ ...prev, [item.id]: e.target.value }))}
                    className="flex-1 min-w-[220px] bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500"
                  />
                  <button
                    disabled={isBusy}
                    onClick={() => handleAction(item.id, "rejected")}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 text-xs font-medium disabled:opacity-50 transition"
                  >
                    <X className="w-3.5 h-3.5" />
                    {t("inbox.reject")}
                  </button>
                  {item.kind === "outbox_signoff" && (
                    <button
                      disabled={isBusy}
                      onClick={() => handleAction(item.id, "approved", "local_merge")}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-sky-500/40 bg-sky-500/15 hover:bg-sky-500/25 text-sky-200 text-xs font-medium disabled:opacity-50 transition"
                    >
                      <GitMerge className="w-3.5 h-3.5" />
                      {t("inbox.approveLocalMerge")}
                    </button>
                  )}
                  {item.kind === "mandate_violation" && item.contextPayload.canExpandMandate === true && (
                    <button
                      disabled={isBusy}
                      onClick={() =>
                        handleAction(item.id, "approved", undefined, { expandMandate: true })
                      }
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium disabled:opacity-50 transition"
                    >
                      <ShieldPlus className="w-3.5 h-3.5" />
                      {t("inbox.expandMandate")}
                    </button>
                  )}
                  {item.kind === "budget_cap" ? (
                    <button
                      disabled={isBusy}
                      onClick={() =>
                        handleAction(item.id, "approved", undefined, { budgetIncreaseUsd: 5 })
                      }
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium disabled:opacity-50 transition"
                    >
                      <DollarSign className="w-3.5 h-3.5" />
                      {t("inbox.approveBudgetBoost")}
                    </button>
                  ) : (
                    <button
                      disabled={isBusy}
                      onClick={() => handleAction(item.id, "approved")}
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium disabled:opacity-50 transition"
                    >
                      <Check className="w-3.5 h-3.5" />
                      {t("inbox.approve")}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {resolved.length > 0 && (
        <div className="space-y-3 pt-4 border-t border-zinc-900">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            {t("inbox.recentTitle")}
          </h3>
          <div className="space-y-2">
            {resolved.map((item) => (
              <div
                key={item.id}
                onClick={() => onInspectTicket(item.ticketId)}
                className="flex items-center justify-between px-4 py-2.5 rounded-lg border border-zinc-800/60 bg-zinc-900/30 hover:bg-zinc-900/60 cursor-pointer text-xs"
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`px-2 py-0.5 rounded font-mono text-[10px] ${
                      item.status === "approved"
                        ? "bg-emerald-500/15 text-emerald-300"
                        : "bg-rose-500/15 text-rose-300"
                    }`}
                  >
                    {formatInboxStatus(item.status, locale)}
                  </span>
                  <span className="text-zinc-200">{item.title}</span>
                  {item.resolutionNote && (
                    <span className="text-zinc-500 italic truncate max-w-xs">
                      “{item.resolutionNote}”
                    </span>
                  )}
                </div>
                <span className="text-zinc-500 font-mono text-[11px]">{item.ticketId}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
