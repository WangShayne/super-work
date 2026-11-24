import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  FileCode2,
  MessageSquarePlus,
  Plus,
  RotateCcw,
  Send,
  ShieldAlert,
  Trash2,
  User,
} from "lucide-react";
import { useI18n } from "../i18n.tsx";
import type {
  InlineStageNote,
  ReviewCommentStatus,
  ReviewFinding,
  ReviewSeverity,
  SubmitReviewCommentsInput,
  TicketReviewComment,
} from "../types.ts";

export interface ParsedDiffLine {
  kind: "hunk" | "add" | "del" | "context" | "meta";
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface ParsedDiffFile {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  lines: ParsedDiffLine[];
}

export function parseUnifiedDiff(rawDiff: string): ParsedDiffFile[] {
  if (!rawDiff || !rawDiff.trim()) return [];
  const rawLines = rawDiff.split("\n");
  const files: ParsedDiffFile[] = [];
  let current: ParsedDiffFile | null = null;
  let oldCursor = 0;
  let newCursor = 0;

  const flush = () => {
    if (current) {
      files.push(current);
      current = null;
    }
  };

  for (let idx = 0; idx < rawLines.length; idx += 1) {
    const line = rawLines[idx] ?? "";
    if (line.startsWith("diff --git ")) {
      flush();
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      const oldPath = match?.[1];
      const newPath = match?.[2] ?? line.replace("diff --git ", "").trim();
      current = {
        path: newPath,
        oldPath: oldPath !== newPath ? oldPath : undefined,
        status: "modified",
        additions: 0,
        deletions: 0,
        lines: [],
      };
      oldCursor = 0;
      newCursor = 0;
      continue;
    }

    if (!current) {
      current = {
        path: "patch.diff",
        status: "modified",
        additions: 0,
        deletions: 0,
        lines: [],
      };
    }

    if (line.startsWith("new file mode")) {
      current.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      current.status = "deleted";
      continue;
    }
    if (line.startsWith("rename from ") || line.startsWith("rename to ")) {
      current.status = "renamed";
      continue;
    }
    if (
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("similarity index")
    ) {
      if (line.startsWith("+++ b/") && current.path === "patch.diff") {
        current.path = line.slice("+++ b/".length);
      }
      continue;
    }

    if (line.startsWith("@@")) {
      const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldCursor = hunkMatch ? Number(hunkMatch[1]) : 1;
      newCursor = hunkMatch ? Number(hunkMatch[2]) : 1;
      current.lines.push({ kind: "hunk", text: line });
      continue;
    }

    if (line.startsWith("+")) {
      current.additions += 1;
      current.lines.push({ kind: "add", text: line.slice(1), newLine: newCursor });
      newCursor += 1;
      continue;
    }
    if (line.startsWith("-")) {
      current.deletions += 1;
      current.lines.push({ kind: "del", text: line.slice(1), oldLine: oldCursor });
      oldCursor += 1;
      continue;
    }
    if (line.startsWith("\\")) {
      current.lines.push({ kind: "meta", text: line });
      continue;
    }

    current.lines.push({
      kind: "context",
      text: line.startsWith(" ") ? line.slice(1) : line,
      oldLine: oldCursor > 0 ? oldCursor : undefined,
      newLine: newCursor > 0 ? newCursor : undefined,
    });
    if (oldCursor > 0) oldCursor += 1;
    if (newCursor > 0) newCursor += 1;
  }

  flush();
  return files;
}

interface DraftLineComment {
  id: string;
  filePath: string;
  line: number;
  side: "new" | "old";
  codeSnippet: string;
  severity: ReviewSeverity;
  body: string;
}

interface DiffStudioProps {
  diff: string;
  stageNotes: InlineStageNote[];
  reviewComments?: TicketReviewComment[];
  onSendFileFeedback: (filePath: string, comment: string) => Promise<void>;
  onSubmitReview?: (input: SubmitReviewCommentsInput) => Promise<void>;
  onToggleCommentStatus?: (commentId: string, status: ReviewCommentStatus) => Promise<void>;
}

const SEVERITY_STYLE = {
  blocker: "border-rose-500/40 bg-rose-500/10 text-rose-200",
  major: "border-amber-500/40 bg-amber-500/10 text-amber-200",
  nit: "border-sky-500/35 bg-sky-500/10 text-sky-200",
} as const;

export function DiffStudio({
  diff,
  stageNotes,
  reviewComments = [],
  onSendFileFeedback,
  onSubmitReview,
  onToggleCommentStatus,
}: DiffStudioProps) {
  const { t } = useI18n();
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);

  const latestReviewFindings = useMemo(() => {
    const rev = [...stageNotes]
      .reverse()
      .find((n) => n.stage === "review" && Array.isArray(n.reviewFindings) && n.reviewFindings.length > 0);
    return rev?.reviewFindings ?? [];
  }, [stageNotes]);

  const findingsByFile = useMemo(() => {
    const map = new Map<string, ReviewFinding[]>();
    for (const f of latestReviewFindings) {
      const key = f.file ?? "__global__";
      const arr = map.get(key) ?? [];
      arr.push(f);
      map.set(key, arr);
    }
    return map;
  }, [latestReviewFindings]);

  const commentsByFileLine = useMemo(() => {
    const map = new Map<string, TicketReviewComment[]>();
    for (const c of reviewComments) {
      const key = `${c.filePath}:${c.line}`;
      const arr = map.get(key) ?? [];
      arr.push(c);
      map.set(key, arr);
    }
    return map;
  }, [reviewComments]);

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [commentingFile, setCommentingFile] = useState<string | null>(null);
  const [commentText, setCommentText] = useState("");
  const [sendingComment, setSendingComment] = useState(false);

  const [activeLineTarget, setActiveLineTarget] = useState<{
    filePath: string;
    line: number;
    side: "new" | "old";
    codeSnippet: string;
  } | null>(null);
  const [lineDraftBody, setLineDraftBody] = useState("");
  const [lineDraftSeverity, setLineDraftSeverity] = useState<ReviewSeverity>("major");
  const [drafts, setDrafts] = useState<DraftLineComment[]>([]);
  const [summaryNote, setSummaryNote] = useState("");
  const [submittingBasket, setSubmittingBasket] = useState(false);

  const visibleFiles = selectedFile ? files.filter((f) => f.path === selectedFile) : files;
  const openPersistedCount = reviewComments.filter((c) => c.status === "open").length;

  const toggleAll = (collapse: boolean) => {
    const next: Record<string, boolean> = {};
    for (const f of files) next[f.path] = collapse;
    setCollapsed(next);
  };

  const handleSubmitFileComment = async (filePath: string, e: React.FormEvent) => {
    e.preventDefault();
    if (!commentText.trim()) return;
    setSendingComment(true);
    try {
      await onSendFileFeedback(filePath, commentText.trim());
      setCommentingFile(null);
      setCommentText("");
    } finally {
      setSendingComment(false);
    }
  };

  const handleAddLineDraft = (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeLineTarget || !lineDraftBody.trim()) return;
    setDrafts((prev) => [
      ...prev,
      {
        id: `draft_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        filePath: activeLineTarget.filePath,
        line: activeLineTarget.line,
        side: activeLineTarget.side,
        codeSnippet: activeLineTarget.codeSnippet,
        severity: lineDraftSeverity,
        body: lineDraftBody.trim(),
      },
    ]);
    setActiveLineTarget(null);
    setLineDraftBody("");
  };

  const handleSubmitBasket = async (mode: "comment_only" | "request_changes") => {
    if (!onSubmitReview) return;
    if (drafts.length === 0 && mode === "comment_only") return;
    if (drafts.length === 0 && openPersistedCount === 0 && !summaryNote.trim()) return;
    setSubmittingBasket(true);
    try {
      await onSubmitReview({
        mode,
        summaryNote: summaryNote.trim() || undefined,
        comments: drafts.map((d) => ({
          filePath: d.filePath,
          line: d.line,
          side: d.side,
          codeSnippet: d.codeSnippet,
          severity: d.severity,
          body: d.body,
        })),
      });
      setDrafts([]);
      setSummaryNote("");
    } finally {
      setSubmittingBasket(false);
    }
  };

  return (
    <div className="space-y-4">
      {latestReviewFindings.length > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3.5 space-y-2 text-xs">
          <div className="flex items-center gap-2 font-semibold text-zinc-200">
            <ShieldAlert className="w-4 h-4 text-amber-400" />
            {t("drawer.reviewFindingsTitle")} ({latestReviewFindings.length})
          </div>
          <div className="space-y-1.5">
            {latestReviewFindings.map((f, idx) => (
              <div
                key={idx}
                className={`rounded-md border px-2.5 py-1.5 text-[11px] flex items-start gap-2 ${SEVERITY_STYLE[f.severity]}`}
              >
                <span className="font-mono uppercase font-bold shrink-0">[{f.severity}]</span>
                <div className="min-w-0 space-y-0.5">
                  <div>
                    {f.file && (
                      <code className="mr-1.5 px-1 py-0.2 rounded bg-black/30 font-mono text-[10px]">
                        {f.file}
                        {f.line ? `:${f.line}` : ""}
                      </code>
                    )}
                    <span>{f.message}</span>
                  </div>
                  {f.suggestion && <div className="text-[10px] opacity-80">→ {f.suggestion}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* B.1 Draft Review Basket */}
      {onSubmitReview && (
        <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/5 p-3 space-y-2.5 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-semibold text-indigo-200">
              <MessageSquarePlus className="w-4 h-4 text-indigo-400" />
              <span>{t("diff.basketTitle")}</span>
              <span className="px-1.5 py-0.2 rounded bg-indigo-500/20 border border-indigo-500/30 font-mono text-[10px]">
                {drafts.length} draft · {openPersistedCount} open
              </span>
            </div>
            {(drafts.length > 0 || openPersistedCount > 0) && (
              <div className="flex items-center gap-2">
                {drafts.length > 0 && (
                  <button
                    type="button"
                    disabled={submittingBasket}
                    onClick={() => void handleSubmitBasket("comment_only")}
                    className="px-2.5 py-1 rounded-md border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 text-[11px] disabled:opacity-50"
                  >
                    {t("diff.commentOnlyBtn")}
                  </button>
                )}
                <button
                  type="button"
                  disabled={submittingBasket}
                  onClick={() => void handleSubmitBasket("request_changes")}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-amber-600 hover:bg-amber-500 text-white text-[11px] font-medium disabled:opacity-50"
                >
                  <Send className="w-3 h-3" />
                  {t("diff.requestChangesBtn")}
                </button>
              </div>
            )}
          </div>

          {drafts.length === 0 ? (
            <p className="text-[11px] text-zinc-400">{t("diff.emptyBasket")}</p>
          ) : (
            <div className="space-y-1.5">
              {drafts.map((d) => (
                <div
                  key={d.id}
                  className="flex items-center justify-between gap-2 rounded border border-zinc-800 bg-zinc-950/70 px-2.5 py-1.5 text-[11px]"
                >
                  <div className="min-w-0">
                    <span className="font-mono text-indigo-300 mr-1.5">
                      {d.filePath}:{d.line}
                    </span>
                    <span className="font-mono uppercase text-[10px] text-amber-300 mr-1.5">
                      [{d.severity}]
                    </span>
                    <span className="text-zinc-200">{d.body}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDrafts((prev) => prev.filter((item) => item.id !== d.id))}
                    className="text-zinc-500 hover:text-rose-400 shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
              <input
                value={summaryNote}
                onChange={(e) => setSummaryNote(e.target.value)}
                placeholder={t("diff.summaryNotePlaceholder")}
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-[11px] text-zinc-100 focus:outline-none focus:border-indigo-500"
              />
            </div>
          )}
        </div>
      )}

      {files.length === 0 ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 text-xs text-zinc-500">
          {t("drawer.noDiff")}
        </div>
      ) : (
        <div className="space-y-3">
          {/* File tree bar & expand controls */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-[11px]">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-zinc-400">
                {files.length} {t("drawer.diffFilesCount")}
              </span>
              {files.map((f) => {
                const fileFindings = findingsByFile.get(f.path) ?? [];
                const active = selectedFile === f.path;
                return (
                  <button
                    key={f.path}
                    type="button"
                    onClick={() => setSelectedFile(active ? null : f.path)}
                    className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded border font-mono text-[10px] transition ${
                      active
                        ? "border-indigo-500 bg-indigo-500/20 text-indigo-200"
                        : "border-zinc-800 bg-zinc-950/70 text-zinc-300 hover:border-zinc-700"
                    }`}
                  >
                    <FileCode2 className="w-3 h-3 text-zinc-400" />
                    <span className="truncate max-w-44">{f.path}</span>
                    <span className="text-emerald-400">+{f.additions}</span>
                    <span className="text-rose-400">-{f.deletions}</span>
                    {fileFindings.length > 0 && <AlertTriangle className="w-3 h-3 text-amber-400" />}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => toggleAll(false)}
                className="px-2 py-0.5 rounded border border-zinc-800 text-zinc-400 hover:text-zinc-200 text-[10px]"
              >
                {t("drawer.expandAll")}
              </button>
              <button
                type="button"
                onClick={() => toggleAll(true)}
                className="px-2 py-0.5 rounded border border-zinc-800 text-zinc-400 hover:text-zinc-200 text-[10px]"
              >
                {t("drawer.collapseAll")}
              </button>
            </div>
          </div>

          {/* Per-file diff blocks */}
          {visibleFiles.map((file) => {
            const isCollapsed = Boolean(collapsed[file.path]);
            const fileFindings = findingsByFile.get(file.path) ?? [];
            const showCommentBox = commentingFile === file.path;

            return (
              <div
                key={file.path}
                className="rounded-lg border border-zinc-800 bg-zinc-900/70 overflow-hidden"
              >
                <div className="px-3 py-2 bg-zinc-900 border-b border-zinc-800 flex items-center justify-between gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() =>
                      setCollapsed((prev) => ({ ...prev, [file.path]: !prev[file.path] }))
                    }
                    className="flex items-center gap-2 min-w-0 text-left"
                  >
                    {isCollapsed ? (
                      <ChevronRight className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                    )}
                    <span
                      className={`px-1.5 py-0.2 rounded font-mono text-[10px] border shrink-0 ${
                        file.status === "added"
                          ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-300"
                          : file.status === "deleted"
                            ? "border-rose-500/30 bg-rose-500/15 text-rose-300"
                            : "border-sky-500/30 bg-sky-500/15 text-sky-300"
                      }`}
                    >
                      {file.status}
                    </span>
                    <span className="font-mono text-zinc-200 truncate">{file.path}</span>
                    <span className="font-mono text-[10px] text-emerald-400 shrink-0">
                      +{file.additions}
                    </span>
                    <span className="font-mono text-[10px] text-rose-400 shrink-0">
                      -{file.deletions}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setCommentingFile(showCommentBox ? null : file.path);
                      setCommentText("");
                    }}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-indigo-500/30 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-200 text-[10px] shrink-0"
                  >
                    <MessageSquarePlus className="w-3 h-3" />
                    {t("drawer.commentOnFile")}
                  </button>
                </div>

                {fileFindings.length > 0 && (
                  <div className="px-3 py-2 bg-zinc-950/70 border-b border-zinc-800 space-y-1">
                    {fileFindings.map((f, idx) => (
                      <div
                        key={idx}
                        className={`rounded border px-2 py-1 text-[11px] flex items-center gap-2 ${SEVERITY_STYLE[f.severity]}`}
                      >
                        <span className="font-mono uppercase font-semibold text-[10px]">
                          [{f.severity}
                          {f.line ? `:${f.line}` : ""}]
                        </span>
                        <span>{f.message}</span>
                      </div>
                    ))}
                  </div>
                )}

                {showCommentBox && (
                  <form
                    onSubmit={(e) => void handleSubmitFileComment(file.path, e)}
                    className="p-2.5 bg-zinc-950 border-b border-zinc-800 flex items-center gap-2"
                  >
                    <input
                      autoFocus
                      value={commentText}
                      onChange={(e) => setCommentText(e.target.value)}
                      placeholder={t("drawer.fileCommentPlaceholder")}
                      className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 text-xs text-zinc-100 focus:outline-none focus:border-indigo-500"
                    />
                    <button
                      type="submit"
                      disabled={sendingComment || !commentText.trim()}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] disabled:opacity-50"
                    >
                      <Send className="w-3 h-3" />
                      {t("drawer.fileCommentSend")}
                    </button>
                  </form>
                )}

                {!isCollapsed && (
                  <div className="overflow-x-auto bg-zinc-950/90 font-mono text-[11px] leading-relaxed">
                    {file.lines.map((line, i) => {
                      if (line.kind === "hunk") {
                        return (
                          <div
                            key={i}
                            className="px-3 py-0.5 bg-sky-500/10 text-sky-300 border-y border-zinc-800/60"
                          >
                            {line.text}
                          </div>
                        );
                      }
                      const rowCls =
                        line.kind === "add"
                          ? "bg-emerald-500/10 text-emerald-300"
                          : line.kind === "del"
                            ? "bg-rose-500/10 text-rose-300"
                            : "text-zinc-400";
                      const prefix = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
                      const anchorLine = line.newLine ?? line.oldLine;
                      const side: "new" | "old" = line.newLine !== undefined ? "new" : "old";
                      const anchoredPersisted = anchorLine
                        ? (commentsByFileLine.get(`${file.path}:${anchorLine}`) ?? [])
                        : [];
                      const anchoredDrafts = anchorLine
                        ? drafts.filter((d) => d.filePath === file.path && d.line === anchorLine)
                        : [];
                      const isComposingThisLine =
                        Boolean(activeLineTarget) &&
                        activeLineTarget?.filePath === file.path &&
                        activeLineTarget?.line === anchorLine &&
                        activeLineTarget?.side === side;

                      return (
                        <div key={i}>
                          <div className={`group flex items-center ${rowCls} px-2 hover:bg-zinc-900/70`}>
                            {onSubmitReview && anchorLine ? (
                              <button
                                type="button"
                                title={t("diff.addLineComment")}
                                onClick={() => {
                                  setActiveLineTarget({
                                    filePath: file.path,
                                    line: anchorLine,
                                    side,
                                    codeSnippet: line.text.slice(0, 120),
                                  });
                                  setLineDraftBody("");
                                }}
                                className="w-4 h-4 mr-1 shrink-0 rounded bg-indigo-600/80 hover:bg-indigo-500 text-white flex items-center justify-center opacity-35 group-hover:opacity-100 focus:opacity-100 transition"
                              >
                                <Plus className="w-3 h-3" />
                              </button>
                            ) : (
                              <span className="w-5 shrink-0" />
                            )}
                            <span className="w-10 shrink-0 text-right pr-2 select-none text-zinc-600">
                              {line.oldLine ?? ""}
                            </span>
                            <span className="w-10 shrink-0 text-right pr-2 select-none text-zinc-600 border-r border-zinc-800/60 mr-2">
                              {line.newLine ?? ""}
                            </span>
                            <span className="w-3 shrink-0 select-none opacity-75">{prefix}</span>
                            <span className="whitespace-pre">{line.text}</span>
                          </div>

                          {/* Persisted & Draft Line Comments */}
                          {(anchoredPersisted.length > 0 || anchoredDrafts.length > 0) && (
                            <div className="mx-6 my-1 space-y-1 font-sans">
                              {anchoredPersisted.map((c) => (
                                <div
                                  key={c.id}
                                  className={`rounded-md border px-2.5 py-1.5 text-[11px] flex items-start justify-between gap-2 ${
                                    c.status === "resolved"
                                      ? "border-emerald-500/25 bg-emerald-500/5 text-zinc-400"
                                      : c.severity
                                        ? SEVERITY_STYLE[c.severity]
                                        : "border-indigo-500/35 bg-indigo-500/10 text-zinc-200"
                                  }`}
                                >
                                  <div className="space-y-0.5 min-w-0">
                                    <div className="flex items-center gap-1.5 text-[10px]">
                                      {c.author === "ai" ? (
                                        <Bot className="w-3 h-3 text-indigo-300" />
                                      ) : (
                                        <User className="w-3 h-3 text-amber-300" />
                                      )}
                                      <span className="font-semibold">
                                        {c.author === "ai" ? t("diff.aiAuthor") : t("diff.humanAuthor")}
                                      </span>
                                      {c.severity && (
                                        <span className="font-mono uppercase">[{c.severity}]</span>
                                      )}
                                      {c.status === "resolved" && (
                                        <span className="px-1 rounded bg-emerald-500/20 text-emerald-300 font-mono">
                                          {t("diff.resolvedTag")}
                                        </span>
                                      )}
                                    </div>
                                    <p className="whitespace-pre-wrap">{c.body}</p>
                                  </div>
                                  {onToggleCommentStatus && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        void onToggleCommentStatus(
                                          c.id,
                                          c.status === "open" ? "resolved" : "open",
                                        )
                                      }
                                      className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 text-[10px]"
                                    >
                                      {c.status === "open" ? (
                                        <>
                                          <Check className="w-2.5 h-2.5 text-emerald-400" />
                                          {t("diff.resolveComment")}
                                        </>
                                      ) : (
                                        <>
                                          <RotateCcw className="w-2.5 h-2.5" />
                                          {t("diff.reopenComment")}
                                        </>
                                      )}
                                    </button>
                                  )}
                                </div>
                              ))}
                              {anchoredDrafts.map((d) => (
                                <div
                                  key={d.id}
                                  className="rounded-md border border-indigo-500/40 bg-indigo-500/15 px-2.5 py-1.5 text-[11px] text-indigo-100 flex items-center justify-between gap-2"
                                >
                                  <div>
                                    <span className="font-mono text-[10px] uppercase mr-1.5 text-amber-300">
                                      [DRAFT · {d.severity}]
                                    </span>
                                    {d.body}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}

                          {isComposingThisLine && (
                            <form
                              onSubmit={handleAddLineDraft}
                              className="mx-6 my-1.5 p-2.5 rounded-lg border border-indigo-500/40 bg-zinc-900 font-sans flex flex-wrap items-center gap-2 text-xs"
                            >
                              <select
                                value={lineDraftSeverity}
                                onChange={(e) => setLineDraftSeverity(e.target.value as ReviewSeverity)}
                                className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-[11px] text-zinc-200"
                              >
                                <option value="blocker">blocker</option>
                                <option value="major">major</option>
                                <option value="nit">nit</option>
                              </select>
                              <input
                                autoFocus
                                value={lineDraftBody}
                                onChange={(e) => setLineDraftBody(e.target.value)}
                                placeholder={`${file.path}:${anchorLine} — ${t("diff.addLineComment")}...`}
                                className="flex-1 min-w-[200px] bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1 text-xs text-zinc-100 focus:outline-none focus:border-indigo-500"
                              />
                              <button
                                type="button"
                                onClick={() => setActiveLineTarget(null)}
                                className="px-2 py-1 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 text-[11px]"
                              >
                                Cancel
                              </button>
                              <button
                                type="submit"
                                disabled={!lineDraftBody.trim()}
                                className="px-2.5 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] disabled:opacity-50"
                              >
                                + Basket
                              </button>
                            </form>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
