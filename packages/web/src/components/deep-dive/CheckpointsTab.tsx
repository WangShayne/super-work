import { FileDiff, GitFork, RotateCcw } from "lucide-react";
import { api } from "../../api.ts";
import { formatStage, useI18n } from "../../i18n.tsx";
import type { TicketDetailResponse } from "../../types.ts";

export interface CheckpointsTabProps {
  ticketId: string;
  detail: TicketDetailResponse | null;
  resteerPrompt: string;
  setResteerPrompt: (v: string) => void;
  checkpointDiff: { cpId: string; diff: string } | null;
  setCheckpointDiff: (v: { cpId: string; diff: string } | null) => void;
  checkpointBusy: string | null;
  setCheckpointBusy: (v: string | null) => void;
  checkpointNotice: string | null;
  setCheckpointNotice: (v: string | null) => void;
  setDetail: (d: TicketDetailResponse) => void;
  onRefresh: () => void;
  onSelectTicket?: (ticketId: string) => void;
}

export function CheckpointsTab({
  ticketId,
  detail,
  resteerPrompt,
  setResteerPrompt,
  checkpointDiff,
  setCheckpointDiff,
  checkpointBusy,
  setCheckpointBusy,
  checkpointNotice,
  setCheckpointNotice,
  setDetail,
  onRefresh,
  onSelectTicket,
}: CheckpointsTabProps) {
  const { locale, t } = useI18n();
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
          {t("drawer.tab.checkpoints")} ({detail?.checkpoints?.length ?? 0})
        </h3>
        <input
          type="text"
          value={resteerPrompt}
          onChange={(e) => setResteerPrompt(e.target.value)}
          placeholder={t("drawer.checkpointPromptPlaceholder")}
          className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500"
        />
        {checkpointNotice && (
          <div className="p-2.5 rounded-lg border border-indigo-500/30 bg-indigo-500/10 text-xs text-indigo-200">
            {checkpointNotice}
          </div>
        )}
      </div>

      {(detail?.checkpoints?.length ?? 0) === 0 ? (
        <p className="text-xs text-zinc-500">{t("drawer.checkpointsEmpty")}</p>
      ) : (
        <div className="space-y-2.5">
          {detail!.checkpoints!.map((cp) => {
            const isDiffOpen = checkpointDiff?.cpId === cp.id;
            const busy = checkpointBusy === cp.id;
            return (
              <div
                key={cp.id}
                className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3.5 text-xs space-y-2.5"
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="px-1.5 py-0.5 rounded bg-indigo-500/15 border border-indigo-500/30 font-mono text-[10px] text-indigo-300">
                      {cp.stage === "baseline" ? "Baseline" : formatStage(cp.stage, locale)}
                    </span>
                    <span className="font-mono text-[11px] text-zinc-300">
                      {cp.commitSha.slice(0, 8)}
                    </span>
                    {Boolean(cp.cleanedAt) && (
                      <span className="px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 font-mono text-[10px] text-zinc-400">
                        {t("drawer.checkpointCleaned")}
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] font-mono text-zinc-500">
                    {new Date(cp.createdAt).toLocaleTimeString()}
                  </span>
                </div>
                {cp.label && <p className="text-zinc-300 text-xs">{cp.label}</p>}
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      if (!ticketId) return;
                      if (isDiffOpen) {
                        setCheckpointDiff(null);
                        return;
                      }
                      setCheckpointBusy(cp.id);
                      try {
                        const res = await api.getCheckpointDiff(ticketId, cp.id);
                        setCheckpointDiff({ cpId: cp.id, diff: res.diff || "(empty diff)" });
                      } catch (err) {
                        setCheckpointNotice((err as Error).message);
                      } finally {
                        setCheckpointBusy(null);
                      }
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-zinc-700 bg-zinc-950 text-zinc-300 hover:text-white text-[11px] transition disabled:opacity-40"
                  >
                    <FileDiff className="w-3 h-3" />
                    {isDiffOpen ? t("drawer.checkpointHideDiff") : t("drawer.checkpointDiffBtn")}
                  </button>

                  {!cp.cleanedAt && (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={async () => {
                          if (!ticketId) return;
                          setCheckpointBusy(cp.id);
                          setCheckpointNotice(null);
                          try {
                            await api.restoreCheckpoint(ticketId, cp.id, {
                              mode: "in_place",
                              prompt: resteerPrompt.trim() || undefined,
                            });
                            setResteerPrompt("");
                            const updated = await api.getTicketDetail(ticketId);
                            setDetail(updated);
                            onRefresh();
                          } catch (err) {
                            setCheckpointNotice((err as Error).message);
                          } finally {
                            setCheckpointBusy(null);
                          }
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-amber-600/20 hover:bg-amber-600/30 border border-amber-500/30 text-amber-200 text-[11px] font-medium transition disabled:opacity-40"
                      >
                        <RotateCcw className="w-3 h-3" />
                        {t("drawer.checkpointRestoreBtn")}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={async () => {
                          if (!ticketId) return;
                          setCheckpointBusy(cp.id);
                          setCheckpointNotice(null);
                          try {
                            const res = await api.restoreCheckpoint(ticketId, cp.id, {
                              mode: "fork",
                              prompt: resteerPrompt.trim() || undefined,
                            });
                            setResteerPrompt("");
                            onRefresh();
                            if (res.ticket?.id) {
                              onSelectTicket?.(res.ticket.id);
                            }
                          } catch (err) {
                            setCheckpointNotice((err as Error).message);
                          } finally {
                            setCheckpointBusy(null);
                          }
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-indigo-600/20 hover:bg-indigo-600/30 border border-indigo-500/30 text-indigo-200 text-[11px] font-medium transition disabled:opacity-40"
                      >
                        <GitFork className="w-3 h-3" />
                        {t("drawer.checkpointForkBtn")}
                      </button>
                    </>
                  )}
                </div>
                {isDiffOpen && checkpointDiff && (
                  <pre className="p-2.5 rounded bg-zinc-950 border border-zinc-800 text-[11px] font-mono text-zinc-300 max-h-60 overflow-auto whitespace-pre-wrap">
                    {checkpointDiff.diff}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
