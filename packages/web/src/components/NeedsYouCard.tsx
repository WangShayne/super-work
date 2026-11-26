import { useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  DollarSign,
  ExternalLink,
  GitMerge,
  HelpCircle,
  Play,
  ShieldPlus,
  Square,
  X,
} from "lucide-react";
import { api } from "../api.ts";
import { formatInboxKind, useI18n } from "../i18n.tsx";
import type {
  ArenaCandidateResult,
  ConflictSemanticContext,
  EpicReplanProposal,
  InboxItem,
  PreviewSession,
  Ticket,
  TicketRiskAssessment,
  WorkerClarificationRequest,
} from "../types.ts";

export type ResolveOptions = {
  expandMandate?: boolean;
  budgetIncreaseUsd?: number;
  arenaWinnerId?: string;
  selectedOption?: string;
};

export type ResolveHandler = (
  id: string,
  decision: "approved" | "rejected",
  note?: string,
  deliveryAction?: "local_merge" | "push_and_create_pr",
  options?: ResolveOptions,
) => Promise<void>;

interface NeedsYouCardProps {
  item: InboxItem;
  ticket?: Ticket;
  selected: boolean;
  onToggleSelect: () => void;
  onResolve: ResolveHandler;
  onInspectTicket: (ticketId: string) => void;
}

const BTN_PRIMARY =
  "inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-white text-xs font-medium disabled:opacity-50 transition";

export function NeedsYouCard({
  item,
  ticket,
  selected,
  onToggleSelect,
  onResolve,
  onInspectTicket,
}: NeedsYouCardProps) {
  const { locale, t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [choice, setChoice] = useState<string | undefined>();
  const [previews, setPreviews] = useState<Record<string, PreviewSession>>({});
  const [previewBusy, setPreviewBusy] = useState<string | null>(null);

  const payload = item.contextPayload;
  const clarification =
    item.kind === "clarification_request"
      ? (payload.clarification as WorkerClarificationRequest | undefined)
      : undefined;
  const activeChoice = clarification
    ? (choice ?? clarification.recommendedOption ?? clarification.options[0])
    : undefined;
  const candidates =
    item.kind === "arena_tiebreak" && Array.isArray(payload.candidates)
      ? (payload.candidates as ArenaCandidateResult[])
      : [];
  const risk =
    item.kind === "outbox_signoff"
      ? ((payload.riskAssessment as TicketRiskAssessment | undefined) ?? ticket?.riskAssessment)
      : undefined;
  const conflict =
    item.kind === "merge_conflict"
      ? ((payload.conflictContext as ConflictSemanticContext | undefined) ?? ticket?.conflictContext)
      : undefined;
  const replan =
    item.kind === "epic_replan" ? (payload.proposal as EpicReplanProposal | undefined) : undefined;
  const releaseNotes =
    item.kind === "milestone_ready"
      ? String((locale === "zh" ? payload.releaseNotesZh : payload.releaseNotesEn) ?? "")
      : "";
  const canExpandMandate = item.kind === "mandate_violation" && payload.canExpandMandate === true;
  const violations = Array.isArray(payload.scopeViolations) ? (payload.scopeViolations as string[]) : [];
  const hasDetails = Boolean(risk || conflict || replan || releaseNotes || violations.length > 0);

  const act = async (
    decision: "approved" | "rejected",
    deliveryAction?: "local_merge" | "push_and_create_pr",
    options?: ResolveOptions,
  ) => {
    setBusy(true);
    setError("");
    try {
      await onResolve(item.id, decision, note.trim() || undefined, deliveryAction, options);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const togglePreview = async (candidateId: string) => {
    const key = candidateId;
    setPreviewBusy(key);
    setError("");
    try {
      const existing = previews[key];
      if (existing) {
        await api.stopPreview(existing.id);
        setPreviews((p) => {
          const next = { ...p };
          delete next[key];
          return next;
        });
      } else {
        const res = await api.startPreview({ ticketId: item.ticketId, candidateId });
        setPreviews((p) => ({ ...p, [key]: res.preview }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewBusy(null);
    }
  };

  const primaryLabel = clarification
    ? t("inbox.clarificationConfirm")
    : item.kind === "epic_replan"
      ? t("inbox.epicReplanApprove")
      : item.kind === "campaign_paused"
        ? t("campaigns.startBtn")
        : item.kind === "budget_cap"
          ? t("inbox.approveBudgetBoost")
          : item.kind === "milestone_ready"
            ? t("milestone.releaseBtn")
            : t("inbox.approve");

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-3 hover:border-zinc-700 transition">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            aria-label={`Select ${item.title}`}
            className="mt-1 rounded border-zinc-700 bg-zinc-950 text-indigo-500 cursor-pointer"
          />
          <div className="min-w-0">
            <h4 className="text-sm font-semibold text-zinc-100 truncate">{item.title}</h4>
            <div className="text-[10px] font-mono text-zinc-500 mt-0.5">
              {formatInboxKind(item.kind, locale)} · {item.ticketId}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onInspectTicket(item.ticketId)}
          className="shrink-0 text-xs text-indigo-400 hover:text-indigo-300 font-medium"
        >
          {t("inbox.inspectDeepDive")}
        </button>
      </div>

      <p className="text-xs text-zinc-300 leading-relaxed line-clamp-3 whitespace-pre-wrap">{item.summary}</p>

      {clarification && (
        <div className="space-y-2 rounded-lg border border-violet-500/35 bg-violet-500/5 p-3 text-xs">
          <div className="flex items-center gap-1.5 font-semibold text-violet-200">
            <HelpCircle className="w-3.5 h-3.5 text-violet-400" />
            {t("inbox.clarificationTitle")}
          </div>
          <p className="text-zinc-100 font-medium">{clarification.question}</p>
          {clarification.context && <p className="text-[11px] text-zinc-400">{clarification.context}</p>}
          <div className="space-y-1.5">
            {clarification.options.map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setChoice(opt)}
                className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg border text-left transition ${
                  activeChoice === opt
                    ? "border-violet-400 bg-violet-500/20 text-violet-100"
                    : "border-zinc-800 bg-zinc-950/70 text-zinc-300 hover:bg-zinc-900"
                }`}
              >
                <span>{opt}</span>
                {clarification.recommendedOption === opt && (
                  <span className="px-1.5 rounded bg-emerald-500/15 border border-emerald-500/30 font-mono text-[10px] text-emerald-300">
                    ★
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {candidates.length > 0 && (
        <div className="space-y-2 rounded-lg border border-teal-500/30 bg-teal-500/5 p-3">
          <div className="text-[11px] font-semibold text-teal-300">{t("inbox.arenaTitle")}</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            {candidates.map((cand) => {
              const prv = previews[cand.candidateId];
              return (
                <div
                  key={cand.candidateId}
                  className={`rounded-lg border p-2.5 text-xs space-y-1.5 ${
                    cand.recommended ? "border-emerald-500/40 bg-emerald-500/10" : "border-zinc-800 bg-zinc-950/80"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono font-semibold text-zinc-100">
                      {cand.engine} ({cand.candidateId})
                    </span>
                    <span className="font-mono text-[10px] text-teal-200">
                      {t("inbox.arenaScorePrefix")}: {cand.score}
                      {cand.recommended ? " ★" : ""}
                    </span>
                  </div>
                  <div className="font-mono text-[10px] text-zinc-400">
                    +{cand.addedLines}/-{cand.deletedLines} · {cand.changedFiles.length} file(s) · $
                    {cand.costUsd.toFixed(3)} · {(cand.durationMs / 1000).toFixed(1)}s
                  </div>
                  {cand.rationale && <p className="text-[11px] text-zinc-300">{cand.rationale}</p>}
                  {cand.worktreePath && (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={previewBusy === cand.candidateId}
                        onClick={() => void togglePreview(cand.candidateId)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-[10px] text-sky-300 disabled:opacity-50"
                      >
                        {prv ? <Square className="w-2.5 h-2.5" /> : <Play className="w-2.5 h-2.5" />}
                        {prv ? t("preview.stopBtn") : t("preview.startBtn")}
                      </button>
                      {prv && (
                        <a
                          href={prv.url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 font-mono text-[10px] text-sky-300 hover:underline truncate"
                        >
                          {prv.url}
                          <ExternalLink className="w-2.5 h-2.5" />
                        </a>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {hasDetails && (
        <div>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-300"
          >
            {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            {t("needs.details")}
          </button>
          {expanded && (
            <div className="mt-2 space-y-2 text-xs">
              {releaseNotes && (
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-teal-500/25 bg-teal-500/5 p-3 text-zinc-300 font-sans">
                  {releaseNotes}
                </pre>
              )}
              {risk && (
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3 space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px]">
                    <span className="font-semibold text-zinc-200 font-sans">{t("inbox.riskCardTitle")}</span>
                    <span className="text-zinc-300">
                      {risk.score}/100 ({risk.level.toUpperCase()}) · {t("inbox.riskThreshold")}: {risk.threshold} ·{" "}
                      {risk.policy}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {risk.factors.map((f) => (
                      <span
                        key={f.key}
                        title={f.detail}
                        className={`px-2 py-0.5 rounded border font-mono text-[10px] ${
                          f.delta > 0
                            ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
                            : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                        }`}
                      >
                        {f.delta > 0 ? `+${f.delta}` : f.delta} {f.label}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {conflict && (
                <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 space-y-1.5">
                  <div className="font-semibold text-rose-200">
                    {t("inbox.conflictCardTitle")} ({conflict.conflictFiles.length}) · {conflict.baseBranch} @{" "}
                    {conflict.mergeBaseSha.slice(0, 8)}
                  </div>
                  {conflict.fileHunks.slice(0, 3).map((h) => (
                    <div key={h.filePath} className="rounded border border-zinc-800 bg-zinc-950/80 p-2 font-mono text-[10px]">
                      <div className="text-zinc-200 font-semibold">{h.filePath}</div>
                      {h.oursSummary && <pre className="text-sky-300/90 whitespace-pre-wrap max-h-24 overflow-auto">ours: {h.oursSummary}</pre>}
                      {h.theirsSummary && (
                        <pre className="text-amber-300/90 whitespace-pre-wrap max-h-24 overflow-auto">theirs: {h.theirsSummary}</pre>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {violations.length > 0 && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200 flex flex-wrap items-center gap-2">
                  <span>{t("inbox.pendingViolationNotice")}:</span>
                  {violations.map((p) => (
                    <code key={p} className="px-1.5 py-0.5 rounded bg-zinc-950/70 border border-amber-500/30 font-mono text-[10px]">
                      {p}
                    </code>
                  ))}
                </div>
              )}
              {replan && (
                <div className="rounded-lg border border-purple-500/30 bg-purple-500/5 p-3 space-y-1.5">
                  <div className="font-semibold text-purple-300">{t("inbox.epicReplanTitle")}</div>
                  {(replan.mutations ?? []).map((m, i) => (
                    <div key={i} className="text-[11px] rounded bg-zinc-950/70 border border-zinc-800 px-2.5 py-1.5 text-zinc-300">
                      <span className="font-mono text-purple-300">{m.kind}</span>{" "}
                      <span className="font-medium">{m.title ?? m.targetSubtaskKey ?? m.targetTicketId}</span>
                      <span className="text-zinc-400"> — {m.reason}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {error && <div className="text-xs text-rose-400 break-words">{error}</div>}

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          placeholder={t("inbox.notePlaceholder")}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="flex-1 min-w-[180px] bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500"
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => void act("rejected")}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 text-xs font-medium disabled:opacity-50 transition"
        >
          <X className="w-3.5 h-3.5" />
          {t("inbox.reject")}
        </button>
        {item.kind === "outbox_signoff" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act("approved", "local_merge")}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-sky-500/40 bg-sky-500/15 hover:bg-sky-500/25 text-sky-200 text-xs font-medium disabled:opacity-50 transition"
          >
            <GitMerge className="w-3.5 h-3.5" />
            {t("inbox.approveLocalMerge")}
          </button>
        )}
        {canExpandMandate && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act("approved", undefined, { expandMandate: true })}
            className={`${BTN_PRIMARY} bg-amber-600 hover:bg-amber-500`}
          >
            <ShieldPlus className="w-3.5 h-3.5" />
            {t("inbox.expandMandate")}
          </button>
        )}
        {candidates.length > 0 ? (
          candidates.map((cand) => (
            <button
              key={cand.candidateId}
              type="button"
              disabled={busy}
              onClick={() => void act("approved", undefined, { arenaWinnerId: cand.candidateId })}
              className={`${BTN_PRIMARY} ${cand.recommended ? "bg-emerald-600 hover:bg-emerald-500" : "bg-indigo-600 hover:bg-indigo-500"}`}
            >
              <Check className="w-3.5 h-3.5" />
              {t("inbox.arenaAdoptPrefix")} {cand.engine}
            </button>
          ))
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void act(
                "approved",
                undefined,
                item.kind === "budget_cap"
                  ? { budgetIncreaseUsd: 5 }
                  : clarification && activeChoice
                    ? { selectedOption: activeChoice }
                    : undefined,
              )
            }
            className={`${BTN_PRIMARY} bg-emerald-600 hover:bg-emerald-500`}
          >
            {item.kind === "budget_cap" ? <DollarSign className="w-3.5 h-3.5" /> : <Check className="w-3.5 h-3.5" />}
            {primaryLabel}
          </button>
        )}
      </div>
    </div>
  );
}
