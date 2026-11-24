import { useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BookOpen,
  ChevronDown,
  ChevronUp,
  Database,
  Download,
  ExternalLink,
  Eye,
  FileJson2,
  FolderGit2,
  GitBranch,
  Layers,
  Pin,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import { api } from "../api.ts";
import { formatTemplate, formatTicketStatus, useI18n } from "../i18n.tsx";
import type {
  BrowserInteractionStep,
  CasebookEntry,
  DeliveryChannel,
  EnginePreference,
  EpicDecompositionPlan,
  EpicDeliveryMode,
  EpicSubtaskSpec,
  ManagedWorktreeItem,
  OperatingMode,
  PipelineTemplateId,
  PlaybookEntry,
  PreviewSession,
  ReasoningEffort,
  RepoConfig,
  SandboxMode,
  SmokeCheckConfig,
  SmokeTriggerMode,
  SpecClarificationResult,
  Ticket,
  VisualDiffMode,
  WorkerEngineId,
  WorktreeGcResult,
} from "../types.ts";


function useEscapeKey(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);
}

interface SimulateModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: {
    source: "github_issue" | "github_pr" | "github_ci" | "cli";
    threadKey: string;
    title: string;
    rawText: string;
  }) => Promise<void>;
}

export function SimulateEventModal({ open, onClose, onSubmit }: SimulateModalProps) {
  const { t } = useI18n();
  const [source, setSource] = useState<"github_issue" | "github_pr" | "github_ci" | "cli">(
    "github_issue",
  );
  const [threadKey, setThreadKey] = useState(`gh:issue:${Math.floor(100 + Math.random() * 899)}`);
  const [title, setTitle] = useState("");
  const [rawText, setRawText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEscapeKey(open, onClose);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !rawText.trim()) return;
    setSubmitting(true);
    try {
      await onSubmit({
        source,
        threadKey: threadKey.trim(),
        title: title.trim(),
        rawText: rawText.trim(),
      });
      setTitle("");
      setRawText("");
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4"
    >
      <div className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-950 p-5 space-y-4 shadow-2xl">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-100">{t("modal.simulate.title")}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-[11px] text-zinc-400">
          {t("modal.simulate.descPrefix")}{" "}
          <code className="text-amber-300">observe</code> {t("modal.simulate.descMiddle")}{" "}
          <code className="text-emerald-300">auto</code> {t("modal.simulate.descSuffix")}
        </p>

        <form onSubmit={handleSubmit} className="space-y-3 text-xs">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-zinc-400 mb-1">{t("modal.simulate.source")}</label>
              <select
                value={source}
                onChange={(e) => setSource(e.target.value as typeof source)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 text-zinc-100"
              >
                <option value="github_issue">github_issue</option>
                <option value="github_pr">github_pr</option>
                <option value="github_ci">github_ci</option>
                <option value="cli">cli</option>
              </select>
            </div>
            <div>
              <label className="block text-zinc-400 mb-1">{t("modal.simulate.threadKey")}</label>
              <input
                required
                value={threadKey}
                onChange={(e) => setThreadKey(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
              />
            </div>
          </div>
          <div>
            <label className="block text-zinc-400 mb-1">{t("modal.simulate.eventTitle")}</label>
            <input
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("modal.simulate.eventPlaceholder")}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100"
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
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg border border-zinc-800 text-zinc-400 hover:text-zinc-200"
            >
              {t("modal.simulate.cancel")}
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-medium disabled:opacity-50"
            >
              {submitting ? t("modal.simulate.submitting") : t("modal.simulate.submit")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface AddRepoModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: {
    name: string;
    rootPath: string;
    baseBranch: string;
    githubRepo?: string;
    mode: OperatingMode;
  }) => Promise<void>;
}

export function AddRepoModal({ open, onClose, onSubmit }: AddRepoModalProps) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [githubRepo, setGithubRepo] = useState("");
  const [mode, setMode] = useState<OperatingMode>("observe");
  const [submitting, setSubmitting] = useState(false);

  useEscapeKey(open, onClose);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !rootPath.trim()) return;
    setSubmitting(true);
    try {
      await onSubmit({
        name: name.trim(),
        rootPath: rootPath.trim(),
        baseBranch: baseBranch.trim() || "main",
        githubRepo: githubRepo.trim() || undefined,
        mode,
      });
      setName("");
      setRootPath("");
      setGithubRepo("");
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4"
    >
      <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 p-5 space-y-4 shadow-2xl">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-100">{t("modal.repo.title")}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3 text-xs">
          <div>
            <label className="block text-zinc-400 mb-1">{t("modal.repo.name")}</label>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("modal.repo.namePlaceholder")}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100"
            />
          </div>
          <div>
            <label className="block text-zinc-400 mb-1">{t("modal.repo.path")}</label>
            <input
              required
              value={rootPath}
              onChange={(e) => setRootPath(e.target.value)}
              placeholder={t("modal.repo.pathPlaceholder")}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-zinc-400 mb-1">{t("modal.repo.baseBranch")}</label>
              <input
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
              />
            </div>
            <div>
              <label className="block text-zinc-400 mb-1">{t("modal.repo.initialMode")}</label>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as OperatingMode)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 text-zinc-100"
              >
                <option value="observe">{t("header.mode.observe")} (observe)</option>
                <option value="auto">{t("header.mode.auto")} (auto)</option>
                <option value="off">{t("header.mode.off")} (off)</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-zinc-400 mb-1">{t("modal.repo.githubRepo")}</label>
            <input
              value={githubRepo}
              onChange={(e) => setGithubRepo(e.target.value)}
              placeholder={t("modal.repo.githubPlaceholder")}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg border border-zinc-800 text-zinc-400 hover:text-zinc-200"
            >
              {t("modal.repo.cancel")}
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium disabled:opacity-50"
            >
              {t("modal.repo.submit")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface WorktreeManagerModalProps {
  open: boolean;
  repoId?: string;
  onClose: () => void;
  onChanged: () => void;
  onOpenDoctor?: () => void;
}

export function WorktreeManagerModal({
  open,
  repoId,
  onClose,
  onChanged,
  onOpenDoctor,
}: WorktreeManagerModalProps) {
  const { locale, t } = useI18n();
  const [items, setItems] = useState<ManagedWorktreeItem[]>([]);
  const [previews, setPreviews] = useState<PreviewSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [gcing, setGcing] = useState(false);
  const [gcResult, setGcResult] = useState<WorktreeGcResult | null>(null);

  const loadWorktrees = async () => {
    setLoading(true);
    try {
      const [wtRes, prvRes] = await Promise.all([
        api.listWorktrees(repoId),
        api.listPreviews(repoId),
      ]);
      setItems(wtRes.items);
      setPreviews(prvRes.previews);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setGcResult(null);
    void loadWorktrees();
  }, [open, repoId]);

  useEscapeKey(open, onClose);

  if (!open) return null;

  const reclaimableCount = items.filter((item) => item.reclaimable).length;

  const handleGcAll = async () => {
    setGcing(true);
    try {
      const res = await api.gcWorktrees(repoId);
      setItems(res.items);
      setGcResult(res.result);
      onChanged();
    } finally {
      setGcing(false);
    }
  };

  const handleReclaimOne = async (ticketId: string) => {
    await api.cleanupTicketWorktree(ticketId);
    await loadWorktrees();
    onChanged();
  };

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4"
    >
      <div className="w-full max-w-2xl rounded-xl border border-zinc-800 bg-zinc-950 p-5 space-y-4 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-sky-500/15 border border-sky-500/30 flex items-center justify-center text-sky-400">
              <FolderGit2 className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-zinc-100">{t("modal.worktrees.title")}</h3>
              <p className="text-[11px] text-zinc-400">{t("modal.worktrees.subtitle")}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200">
            <X className="w-4 h-4" />
          </button>
        </div>

        {gcResult && (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
            {t("modal.worktrees.gcResultBanner")
              .replace("{removed}", String(gcResult.removedPaths.length))
              .replace("{skipped}", String(gcResult.skippedActiveCount))}
          </div>
        )}

        {previews.length > 0 && (
          <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3 space-y-2 text-xs">
            <div className="font-semibold text-sky-300 flex items-center gap-1.5">
              <Play className="w-3.5 h-3.5" />
              {t("preview.activeTitle")} ({previews.length})
            </div>
            <div className="space-y-1.5">
              {previews.map((prv) => (
                <div
                  key={prv.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded border border-zinc-800 bg-zinc-950/80 px-2.5 py-1.5"
                >
                  <div className="min-w-0 flex items-center gap-2">
                    <span className="px-1.5 py-0.2 rounded font-mono text-[10px] bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
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
                      onClick={() => void api.renewPreview(prv.id).then(() => loadWorktrees())}
                      className="px-2 py-0.5 rounded border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-[10px] text-zinc-200"
                    >
                      {t("preview.renewBtn")}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void api.stopPreview(prv.id).then(() => {
                          void loadWorktrees();
                          onChanged();
                        })
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
          </div>
        )}

        <div className="max-h-72 overflow-y-auto space-y-2 text-xs">
          {loading && items.length === 0 ? (
            <div className="py-8 text-center text-zinc-500">{t("drawer.loading")}</div>
          ) : items.length === 0 ? (
            <div className="py-8 text-center rounded-lg border border-dashed border-zinc-800 text-zinc-500">
              {t("modal.worktrees.empty")}
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
                    {item.ticketId && (
                      <span className="font-mono text-[11px] text-indigo-300">
                        {item.ticketId}
                      </span>
                    )}
                    {item.ticketStatus && (
                      <span className="text-[11px] text-zinc-400">
                        ({formatTicketStatus(item.ticketStatus, locale)})
                      </span>
                    )}
                    {item.ticketTitle && (
                      <span className="text-zinc-200 font-medium truncate max-w-xs">
                        {item.ticketTitle}
                      </span>
                    )}
                  </div>
                  <div className="font-mono text-[10px] text-zinc-500 truncate">{item.path}</div>
                </div>

                {item.reclaimable && item.ticketId && (
                  <button
                    type="button"
                    onClick={() => void handleReclaimOne(item.ticketId!)}
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

        <div className="flex items-center justify-between pt-2 border-t border-zinc-800/80 text-xs">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void loadWorktrees()}
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-800 text-zinc-300 hover:bg-zinc-900 disabled:opacity-50"
            >
              <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
              {t("modal.worktrees.refresh")}
            </button>
            {onOpenDoctor && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenDoctor();
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-200"
              >
                <ShieldCheck className="w-3 h-3 text-emerald-400" />
                {t("doctor.title")}
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg border border-zinc-800 text-zinc-400 hover:text-zinc-200"
            >
              {t("modal.worktrees.close")}
            </button>
            <button
              type="button"
              onClick={() => void handleGcAll()}
              disabled={gcing || reclaimableCount === 0}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-medium disabled:opacity-40"
            >
              <Trash2 className="w-3.5 h-3.5" />
              {gcing ? t("modal.worktrees.gcing") : `${t("modal.worktrees.gcButton")} (${reclaimableCount})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
