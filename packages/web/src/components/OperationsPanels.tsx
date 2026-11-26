import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  GitMerge,
  Layers,
  Play,
  RefreshCw,
  ShieldAlert,
  Square,
  Trash2,
  Zap,
} from "lucide-react";
import { api } from "../api.ts";
import { formatTicketStatus, useI18n } from "../i18n.tsx";
import type {
  ManagedWorktreeItem,
  MergeTrainEntry,
  MergeTrainEntryStatus,
  PreviewSession,
  RepoConfig,
  WorktreeGcResult,
} from "../types.ts";

const FIELD =
  "w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:border-indigo-500";

function PanelShell({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
          {subtitle && <p className="text-[11px] text-zinc-400 mt-0.5">{subtitle}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

function Banner({ tone, text }: { tone: "error" | "ok"; text: string }) {
  const cls =
    tone === "error"
      ? "border-rose-500/40 bg-rose-500/10 text-rose-200"
      : "border-emerald-500/40 bg-emerald-500/10 text-emerald-200";
  const Icon = tone === "error" ? AlertTriangle : CheckCircle2;
  return (
    <div className={`rounded-lg border px-3 py-2 text-xs flex items-center gap-2 ${cls}`}>
      <Icon className="w-3.5 h-3.5 shrink-0" />
      <span className="break-words">{text}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Worktrees
// ---------------------------------------------------------------------------

export function WorktreePanel({
  repoId,
  onChanged,
  onOpenDoctor,
}: {
  repoId?: string;
  onChanged: () => void;
  onOpenDoctor?: () => void;
}) {
  const { locale, t } = useI18n();
  const [items, setItems] = useState<ManagedWorktreeItem[]>([]);
  const [previews, setPreviews] = useState<PreviewSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [gcing, setGcing] = useState(false);
  const [gcResult, setGcResult] = useState<WorktreeGcResult | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [wt, prv] = await Promise.all([api.listWorktrees(repoId), api.listPreviews(repoId)]);
      setItems(wt.items);
      setPreviews(prv.previews);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [repoId]);

  useEffect(() => {
    setGcResult(null);
    void load();
  }, [load]);

  const reclaimable = items.filter((i) => i.reclaimable).length;

  const run = async (fn: () => Promise<void>) => {
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <PanelShell
      title={t("modal.worktrees.title")}
      subtitle={t("modal.worktrees.subtitle")}
      actions={
        <>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-800 text-zinc-300 hover:bg-zinc-900 text-xs disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
            {t("modal.worktrees.refresh")}
          </button>
          {onOpenDoctor && (
            <button
              type="button"
              onClick={onOpenDoctor}
              className="px-3 py-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-200 text-xs"
            >
              {t("doctor.title")}
            </button>
          )}
          <button
            type="button"
            disabled={gcing || reclaimable === 0}
            onClick={() =>
              void run(async () => {
                setGcing(true);
                try {
                  const res = await api.gcWorktrees(repoId);
                  setItems(res.items);
                  setGcResult(res.result);
                  onChanged();
                } finally {
                  setGcing(false);
                }
              })
            }
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium disabled:opacity-40"
          >
            <Trash2 className="w-3.5 h-3.5" />
            {gcing ? t("modal.worktrees.gcing") : `${t("modal.worktrees.gcButton")} (${reclaimable})`}
          </button>
        </>
      }
    >
      {error && <Banner tone="error" text={error} />}
      {gcResult && (
        <Banner
          tone="ok"
          text={t("modal.worktrees.gcResultBanner")
            .replace("{removed}", String(gcResult.removedPaths.length))
            .replace("{skipped}", String(gcResult.skippedActiveCount))}
        />
      )}

      {previews.length > 0 && (
        <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3 space-y-2 text-xs">
          <div className="font-semibold text-sky-300 flex items-center gap-1.5">
            <Play className="w-3.5 h-3.5" />
            {t("preview.activeTitle")} ({previews.length})
          </div>
          {previews.map((prv) => (
            <div
              key={prv.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded border border-zinc-800 bg-zinc-950/80 px-2.5 py-1.5"
            >
              <div className="min-w-0 flex items-center gap-2">
                <span className="px-1.5 rounded font-mono text-[10px] bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                  {prv.status}
                </span>
                <span className="text-zinc-200 truncate max-w-xs">{prv.label}</span>
                <a
                  href={prv.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-[11px] text-sky-300 hover:underline"
                >
                  {prv.url}
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => void run(() => api.renewPreview(prv.id).then(() => load()))}
                  className="px-2 py-0.5 rounded border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-[10px] text-zinc-200"
                >
                  {t("preview.renewBtn")}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void run(() =>
                      api.stopPreview(prv.id).then(() => {
                        void load();
                        onChanged();
                      }),
                    )
                  }
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500/20 text-[10px] text-rose-300"
                >
                  <Square className="w-2.5 h-2.5" />
                  {t("preview.stopBtn")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="max-h-80 overflow-y-auto space-y-2 text-xs">
        {items.length === 0 ? (
          <div className="py-8 text-center rounded-lg border border-dashed border-zinc-800 text-zinc-500">
            {loading ? t("drawer.loading") : t("modal.worktrees.empty")}
          </div>
        ) : (
          items.map((item) => (
            <div
              key={item.path}
              className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2.5"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] font-mono border ${
                      !item.reclaimable
                        ? "border-indigo-500/30 bg-indigo-500/15 text-indigo-300"
                        : item.isOrphan
                          ? "border-amber-500/30 bg-amber-500/15 text-amber-300"
                          : "border-emerald-500/30 bg-emerald-500/15 text-emerald-300"
                    }`}
                  >
                    {!item.reclaimable
                      ? t("modal.worktrees.activeBadge")
                      : item.isOrphan
                        ? t("modal.worktrees.orphanBadge")
                        : t("modal.worktrees.reclaimableBadge")}
                  </span>
                  {item.ticketId && <span className="font-mono text-[11px] text-indigo-300">{item.ticketId}</span>}
                  {item.ticketStatus && (
                    <span className="text-[11px] text-zinc-400">({formatTicketStatus(item.ticketStatus, locale)})</span>
                  )}
                  {item.ticketTitle && <span className="text-zinc-200 font-medium truncate max-w-xs">{item.ticketTitle}</span>}
                </div>
                <div className="font-mono text-[10px] text-zinc-500 truncate">{item.path}</div>
              </div>
              {item.reclaimable && item.ticketId && (
                <button
                  type="button"
                  onClick={() =>
                    void run(async () => {
                      await api.cleanupTicketWorktree(item.ticketId!);
                      await load();
                      onChanged();
                    })
                  }
                  className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 text-[11px]"
                >
                  <Trash2 className="w-3 h-3 text-amber-400" />
                  {t("modal.worktrees.reclaimOne")}
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </PanelShell>
  );
}

// ---------------------------------------------------------------------------
// Merge train
// ---------------------------------------------------------------------------

const TRAIN_STYLE: Record<MergeTrainEntryStatus, string> = {
  queued: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  barrier_waiting: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  validating: "bg-indigo-500/15 text-indigo-300 border-indigo-500/30",
  merged: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  ejected: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  barrier_blocked: "bg-rose-500/15 text-rose-300 border-rose-500/30",
};

export function MergeTrainPanel({
  repoId,
  repos,
  onInspectTicket,
  onChanged,
}: {
  repoId?: string;
  repos: RepoConfig[];
  onInspectTicket?: (ticketId: string) => void;
  onChanged?: () => void;
}) {
  const { t } = useI18n();
  const [filterRepoId, setFilterRepoId] = useState(repoId ?? "");
  const [entries, setEntries] = useState<MergeTrainEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [flushing, setFlushing] = useState(false);
  const [ejectingId, setEjectingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => setFilterRepoId(repoId ?? ""), [repoId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setEntries((await api.listMergeTrain(filterRepoId || undefined)).entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [filterRepoId]);

  useEffect(() => {
    void load();
  }, [load]);

  const repoName = new Map(repos.map((r) => [r.id, r.name]));

  const flush = async () => {
    setFlushing(true);
    setError("");
    setNotice("");
    try {
      const res = await api.flushMergeTrain(filterRepoId || undefined);
      setNotice(`${t("train.flushBtn")}: ${res.mergedCount}`);
      await load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFlushing(false);
    }
  };

  const eject = async (id: string) => {
    setEjectingId(id);
    setError("");
    try {
      await api.ejectMergeTrainEntry(id, "Ejected via Engine Room Merge Train panel");
      await load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setEjectingId(null);
    }
  };

  return (
    <PanelShell
      title={t("train.title")}
      subtitle={t("train.subtitle")}
      actions={
        <>
          <select
            value={filterRepoId}
            onChange={(e) => setFilterRepoId(e.target.value)}
            aria-label={t("train.filterAll")}
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
            onClick={() => void flush()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium disabled:opacity-50"
          >
            <Play className="w-3.5 h-3.5" />
            {t("train.flushBtn")}
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => void load()}
            aria-label={t("modal.worktrees.refresh")}
            className="p-1.5 rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </>
      }
    >
      {error && <Banner tone="error" text={error} />}
      {notice && <Banner tone="ok" text={notice} />}
      {entries.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-xs text-zinc-500">
          {t("train.empty")}
        </div>
      ) : (
        <div className="space-y-2.5">
          {entries.map((entry) => {
            const active =
              entry.status === "queued" || entry.status === "barrier_waiting" || entry.status === "validating";
            return (
              <div key={entry.id} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3.5 space-y-2 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <GitMerge className="w-3.5 h-3.5 text-sky-400" />
                    <span className="font-mono text-[11px] font-semibold text-zinc-300">#{entry.position}</span>
                    <span className={`px-2 py-0.5 rounded font-mono text-[10px] border ${TRAIN_STYLE[entry.status]}`}>
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
                    <span className="text-zinc-400">{repoName.get(entry.repoId) ?? entry.repoId}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {onInspectTicket && (
                      <button
                        type="button"
                        onClick={() => onInspectTicket(entry.ticketId)}
                        className="font-mono text-[11px] text-indigo-400 hover:text-indigo-300"
                      >
                        {entry.ticketId} →
                      </button>
                    )}
                    {active && (
                      <button
                        type="button"
                        disabled={ejectingId === entry.id}
                        onClick={() => void eject(entry.id)}
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
                  {entry.mergedCommitSha && <span className="text-emerald-300">merged: {entry.mergedCommitSha.slice(0, 8)}</span>}
                  {entry.speculativeCommitSha && !entry.mergedCommitSha && (
                    <span className="text-indigo-300">speculative: {entry.speculativeCommitSha.slice(0, 8)}</span>
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
    </PanelShell>
  );
}

// ---------------------------------------------------------------------------
// Simulate trigger
// ---------------------------------------------------------------------------

type TriggerSource = "github_issue" | "github_pr" | "github_ci" | "cli";

export function SimulatePanel({ repoId, onDone }: { repoId?: string; onDone: () => void }) {
  const { t } = useI18n();
  const [source, setSource] = useState<TriggerSource>("github_issue");
  const [threadKey, setThreadKey] = useState(`gh:issue:${Math.floor(100 + Math.random() * 899)}`);
  const [title, setTitle] = useState("");
  const [rawText, setRawText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!repoId || !title.trim() || !rawText.trim()) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.simulateTrigger({
        repoId,
        source,
        threadKey: threadKey.trim(),
        title: title.trim(),
        rawText: rawText.trim(),
      });
      setTitle("");
      setRawText("");
      setNotice(t("modal.simulate.submit"));
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PanelShell title={t("modal.simulate.title")}>
      <p className="text-[11px] text-zinc-400">
        {t("modal.simulate.descPrefix")} <code className="text-amber-300">observe</code>{" "}
        {t("modal.simulate.descMiddle")} <code className="text-emerald-300">auto</code>{" "}
        {t("modal.simulate.descSuffix")}
      </p>
      <form onSubmit={submit} className="space-y-3 text-xs">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-zinc-400 mb-1">{t("modal.simulate.source")}</label>
            <select value={source} onChange={(e) => setSource(e.target.value as TriggerSource)} className={FIELD}>
              <option value="github_issue">github_issue</option>
              <option value="github_pr">github_pr</option>
              <option value="github_ci">github_ci</option>
              <option value="cli">cli</option>
            </select>
          </div>
          <div>
            <label className="block text-zinc-400 mb-1">{t("modal.simulate.threadKey")}</label>
            <input required value={threadKey} onChange={(e) => setThreadKey(e.target.value)} className={`${FIELD} font-mono`} />
          </div>
        </div>
        <div>
          <label className="block text-zinc-400 mb-1">{t("modal.simulate.eventTitle")}</label>
          <input
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("modal.simulate.eventPlaceholder")}
            className={FIELD}
          />
        </div>
        <div>
          <label className="block text-zinc-400 mb-1">{t("modal.simulate.eventBody")}</label>
          <textarea
            required
            rows={3}
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            placeholder={t("modal.simulate.bodyPlaceholder")}
            className={FIELD}
          />
        </div>
        {error && <Banner tone="error" text={error} />}
        {notice && <Banner tone="ok" text={notice} />}
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={busy || !repoId}
            className="px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-medium disabled:opacity-50"
          >
            {busy ? t("modal.simulate.submitting") : t("modal.simulate.submit")}
          </button>
        </div>
      </form>
    </PanelShell>
  );
}
