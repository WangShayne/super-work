import { Shield } from "lucide-react";
import { DiffStudio } from "../DiffStudio.tsx";
import { useI18n } from "../../i18n.tsx";
import type { ReviewCommentStatus, SubmitReviewCommentsInput, Ticket, TicketDetailResponse } from "../../types.ts";

export interface DiffTabProps {
  ticket: Ticket;
  detail: TicketDetailResponse | null;
  selectedArenaCandId: string | null;
  setSelectedArenaCandId: (id: string | null) => void;
  handleSendFileFeedback: (filePath: string, comment: string) => Promise<void>;
  handleSubmitReview: (input: SubmitReviewCommentsInput) => Promise<void>;
  handleToggleCommentStatus: (commentId: string, status: ReviewCommentStatus) => Promise<void>;
}

export function DiffTab({
  ticket,
  detail,
  selectedArenaCandId,
  setSelectedArenaCandId,
  handleSendFileFeedback,
  handleSubmitReview,
  handleToggleCommentStatus,
}: DiffTabProps) {
  const { t } = useI18n();
  return (
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

      {ticket.arenaCandidates && ticket.arenaCandidates.length > 0 && (
        <div className="rounded-lg border border-teal-500/30 bg-teal-500/5 p-3 space-y-2 text-xs">
          <div className="text-[11px] font-semibold text-teal-300">
            {t("drawer.arenaDiffTitle")}
          </div>
          <div className="flex flex-wrap gap-2">
            {ticket.arenaCandidates.map((cand) => {
              const activeCandId =
                selectedArenaCandId ??
                ticket.arenaWinnerId ??
                ticket.arenaCandidates!.find((c) => c.recommended)?.candidateId ??
                ticket.arenaCandidates![0]!.candidateId;
              const selected = activeCandId === cand.candidateId;
              const isWinner = ticket.arenaWinnerId === cand.candidateId;
              return (
                <button
                  key={cand.candidateId}
                  type="button"
                  onClick={() => setSelectedArenaCandId(cand.candidateId)}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border font-mono text-[11px] transition ${
                    selected
                      ? "border-teal-400 bg-teal-500/20 text-teal-100"
                      : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  <span>{cand.engine}</span>
                  <span className="text-zinc-400">({cand.score}pts)</span>
                  <span>
                    +{cand.addedLines}/-{cand.deletedLines}
                  </span>
                  {isWinner && (
                    <span className="px-1 rounded bg-emerald-500/20 text-emerald-300 text-[10px]">
                      {t("drawer.arenaWinnerTag")}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
          {t("drawer.diffTitle")}
        </h3>
        <DiffStudio
          diff={(() => {
            if (ticket.arenaCandidates && ticket.arenaCandidates.length > 0 && detail?.arenaCandidateDiffs) {
              const activeCandId =
                selectedArenaCandId ??
                ticket.arenaWinnerId ??
                ticket.arenaCandidates.find((c) => c.recommended)?.candidateId ??
                ticket.arenaCandidates[0]!.candidateId;
              return detail.arenaCandidateDiffs[activeCandId] ?? detail?.diff ?? "";
            }
            return detail?.diff ?? "";
          })()}
          stageNotes={ticket.inlineMemory.stageNotes}
          reviewComments={detail?.reviewComments}
          onSendFileFeedback={handleSendFileFeedback}
          onSubmitReview={handleSubmitReview}
          onToggleCommentStatus={handleToggleCommentStatus}
        />
      </div>
    </div>
  );
}
