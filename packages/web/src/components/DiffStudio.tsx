import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FileCode2,
  MessageSquarePlus,
  Send,
  ShieldAlert,
} from "lucide-react";
import { useI18n } from "../i18n.tsx";
import type { InlineStageNote, ReviewFinding } from "../types.ts";

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
    if (current) files.push(current);
  };

  for (const line of rawLines) {
    if (line.startsWith("diff --git ")) {
      flush();
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const oldPath = match?.[1] ?? "";
      const newPath = match?.[2] ?? oldPath;
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
      // Handle simplified unified diff without `diff --git` header
      if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("@@ ")) {
        current = {
          path: "patch",
          status: "modified",
          additions: 0,
          deletions: 0,
          lines: [],
        };
      } else {
        continue;
      }
    }

    if (line.startsWith("new file mode ")) {
      current.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      current.status = "deleted";
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.status = "renamed";
      current.oldPath = line.slice("rename from ".length).trim();
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.status = "renamed";
      current.path = line.slice("rename to ".length).trim();
      continue;
    }
    if (line.startsWith("index ") || line.startsWith("--- ")) {
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim().replace(/^b\//, "");
      if (p && p !== "/dev/null" && current.path === "patch") {
        current.path = p;
      }
      continue;
    }

    if (line.startsWith("@@ ")) {
      const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldCursor = hunkMatch ? Number.parseInt(hunkMatch[1]!, 10) : 1;
      newCursor = hunkMatch ? Number.parseInt(hunkMatch[2]!, 10) : 1;
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

interface DiffStudioProps {
  diff: string;
  stageNotes: InlineStageNote[];
  onSendFileFeedback: (filePath: string, comment: string) => Promise<void>;
}

const SEVERITY_STYLE = {
  blocker: "border-rose-500/40 bg-rose-500/10 text-rose-200",
  major: "border-amber-500/40 bg-amber-500/10 text-amber-200",
  nit: "border-sky-500/35 bg-sky-500/10 text-sky-200",
} as const;

export function DiffStudio({ diff, stageNotes, onSendFileFeedback }: DiffStudioProps) {
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

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [commentingFile, setCommentingFile] = useState<string | null>(null);
  const [commentText, setCommentText] = useState("");
  const [sendingComment, setSendingComment] = useState(false);

  const visibleFiles = selectedFile ? files.filter((f) => f.path === selectedFile) : files;

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
                  {f.suggestion && (
                    <div className="text-[10px] opacity-80">→ {f.suggestion}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
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
                    {fileFindings.length > 0 && (
                      <AlertTriangle className="w-3 h-3 text-amber-400" />
                    )}
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
                      return (
                        <div key={i} className={`flex ${rowCls} px-2`}>
                          <span className="w-10 shrink-0 text-right pr-2 select-none text-zinc-600">
                            {line.oldLine ?? ""}
                          </span>
                          <span className="w-10 shrink-0 text-right pr-2 select-none text-zinc-600 border-r border-zinc-800/60 mr-2">
                            {line.newLine ?? ""}
                          </span>
                          <span className="w-3 shrink-0 select-none opacity-75">{prefix}</span>
                          <span className="whitespace-pre">{line.text}</span>
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
