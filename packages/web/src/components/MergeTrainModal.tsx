import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  GitMerge,
  Layers,
  Play,
  RefreshCw,
  ShieldAlert,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { api } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import type { MergeTrainEntry, MergeTrainEntryStatus, RepoConfig } from "../types.ts";

interface MergeTrainModalProps {
  open: boolean;
  repoId?: string;
  repos: RepoConfig[];
  onClose: () => void;
  onInspectTicket?: (ticketId: string) => void;
  onChanged?: () => void;
}

const STATUS_STYLE: Record<MergeTrainEntryStatus, string> = {
  queued: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  barrier_waiting: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  validating: "bg-indigo-500/15 text-indigo-300 border-indigo-500/30",
  merged: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  ejected: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  barrier_blocked: "bg-rose-500/15 text-rose-300 border-rose-500/30",
};

export function MergeTrainModal({
  open,
  repoId,
  repos,
  onClose,
  onInspectTicket,
  onChanged,
}: MergeTrainModalProps) {
  const { t } = useI18n();
  const [filterRepoId, setFilterRepoId] = useState<string>(repoId ?? "");
  const [entries, setEntries] = useState<MergeTrainEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [flushing, setFlushing] = useState(false);
  const [ejectingId, setEjectingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setFilterRepoId(repoId ?? "");
      setError(null);
      setNotice(null);
    }
  }, [open, repoId]);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listMergeTrain(filterRepoId || undefined);
      setEntries(res.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [filterRepoId]);

  useEffect(() => {
    if (open) {
      void loadEntries();
    }
  }, [open, loadEntries]);

  if (!open) return null;

  const repoNameById = new Map(repos.map((r) => [r.id, r.name]));

  const handleFlush = async () => {
    setFlushing(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.flushMergeTrain(filterRepoId || undefined);
      setNotice(`Flushed merge train (${res.mergedCount} merged)`);
      await loadEntries();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFlushing(false);
    }
  };

  const handleEject = async (entryId: string) => {
    setEjectingId(entryId);
    setError(null);
    setNotice(null);
    try {
      await api.ejectMergeTrainEntry(entryId, "Ejected via Dashboard Merge Train view");
      await loadEntries();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setEjectingId(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[85vh] flex flex-col rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-zinc-800 bg-zinc-900/60 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-sky-500/15 border border-sky-500/30 flex items-center justify-center shrink-0">
              <GitMerge className="w-4 h-4 text-sky-400" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-zinc-100 truncate">{t("train.title")}</h3>
              <p className="text-[11px] text-zinc-400 truncate">{t("train.subtitle")}</p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <select
              value={filterRepoId}
              onChange={(e) => setFilterRepoId(e.target.value)}
              className="bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs text-zinc-200"
            >
              <option value="">{t("train.filterAll")}</option>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={flushing}
              onClick={() => void handleFlush()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium disabled:opacity-50"
            >
              <Play className="w-3.5 h-3.5" />
              {t("train.flushBtn")}
            </button>
            <button
              type="button"
              disabled={loading}
              onClick={() => void loadEntries()}
              className="p-1.5 rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-200"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-3">
          {error && (
            <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200 flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          {notice && (
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200 flex items-center gap-2">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
              <span>{notice}</span>
            </div>
          )}

          {entries.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-xs text-zinc-500">
              {t("train.empty")}
            </div>
          ) : (
            <div className="space-y-2.5">
              {entries.map((entry) => {
                const isActive =
                  entry.status === "queued" ||
                  entry.status === "barrier_waiting" ||
                  entry.status === "validating";
                return (
                  <div
                    key={entry.id}
                    className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3.5 space-y-2 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-[11px] font-semibold text-zinc-300">
                          #{entry.position}
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded font-mono text-[10px] border ${STATUS_STYLE[entry.status]}`}
                        >
                          {entry.status}
                        </span>
                        {entry.bypassedSpeculation && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-[10px] font-mono text-emerald-300">
                            <Zap className="w-3 h-3" />
                            Smart-Bypass
                          </span>
                        )}
                        {entry.barrierGroupId && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-[10px] font-mono text-amber-200">
                            <Layers className="w-3 h-3" />
                            Barrier {entry.barrierGroupId}
                          </span>
                        )}
                        <span className="text-zinc-400">
                          {repoNameById.get(entry.repoId) ?? entry.repoId}
                        </span>
                      </div>

                      <div className="flex items-center gap-2">
                        {onInspectTicket && (
                          <button
                            type="button"
                            onClick={() => {
                              onInspectTicket(entry.ticketId);
                              onClose();
                            }}
                            className="font-mono text-[11px] text-indigo-400 hover:text-indigo-300"
                          >
                            {entry.ticketId} →
                          </button>
                        )}
                        {isActive && (
                          <button
                            type="button"
                            disabled={ejectingId === entry.id}
                            onClick={() => void handleEject(entry.id)}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 text-[11px] disabled:opacity-50"
                          >
                            <Trash2 className="w-3 h-3" />
                            {t("train.ejectBtn")}
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-3 font-mono text-[11px] text-zinc-400">
                      <span>
                        {entry.branchName} → {entry.baseBranch}
                      </span>
                      {entry.mergedCommitSha && (
                        <span className="text-emerald-300">
                          merged: {entry.mergedCommitSha.slice(0, 8)}
                        </span>
                      )}
                      {entry.speculativeCommitSha && !entry.mergedCommitSha && (
                        <span className="text-indigo-300">
                          speculative: {entry.speculativeCommitSha.slice(0, 8)}
                        </span>
                      )}
                    </div>

                    {entry.errorSummary && (
                      <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 px-2.5 py-1.5 text-[11px] text-rose-200 flex items-start gap-1.5">
                        <ShieldAlert className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" />
                        <span className="break-all">{entry.errorSummary}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
