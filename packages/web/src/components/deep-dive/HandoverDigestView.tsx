import { useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import { useI18n } from "../../i18n.tsx";
import type { HandoverDigest } from "../../types.ts";

export function HandoverDigestView({ digest }: { digest: HandoverDigest }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    const payload = digest.formattedMarkdown || digest.summary;
    if (!payload) return;
    navigator.clipboard
      ?.writeText(payload)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      })
      .catch(() => {
        setCopied(false);
      });
  };

  const hasStructuredItems =
    Boolean(digest.summary) ||
    digest.changedFiles.length > 0 ||
    digest.exportedSymbols.length > 0 ||
    digest.contractSnippets.length > 0;

  return (
    <div className="space-y-2.5 text-xs">
      <div className="flex items-start justify-between gap-2">
        {digest.summary ? (
          <p className="text-zinc-200 leading-relaxed flex-1">{digest.summary}</p>
        ) : (
          <span className="text-zinc-500 font-mono text-[11px]">
            v{digest.version} · {digest.repoName ?? digest.repoId}
          </span>
        )}
        <button
          type="button"
          onClick={handleCopy}
          className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-[11px] transition"
        >
          {copied ? (
            <>
              <Check className="w-3 h-3 text-emerald-400" />
              <span className="text-emerald-300">{t("drawer.handoverCopied")}</span>
            </>
          ) : (
            <>
              <Copy className="w-3 h-3" />
              <span>{t("drawer.handoverCopy")}</span>
            </>
          )}
        </button>
      </div>

      {digest.changedFiles.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
            {t("drawer.handoverFiles")} ({digest.changedFiles.length})
          </div>
          <div className="flex flex-wrap gap-1">
            {digest.changedFiles.map((file) => (
              <span
                key={file}
                className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 font-mono text-[11px] text-zinc-200 break-all"
              >
                {file}
              </span>
            ))}
          </div>
        </div>
      )}

      {digest.exportedSymbols.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-indigo-300/90">
            {t("drawer.handoverSymbols")} ({digest.exportedSymbols.length})
          </div>
          <div className="flex flex-wrap gap-1">
            {digest.exportedSymbols.map((sym) => (
              <span
                key={sym}
                className="px-1.5 py-0.5 rounded bg-indigo-500/10 border border-indigo-500/25 font-mono text-[11px] text-indigo-200"
              >
                {sym}
              </span>
            ))}
          </div>
        </div>
      )}

      {digest.contractSnippets.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-amber-300/90">
            {t("drawer.handoverContracts")} ({digest.contractSnippets.length})
          </div>
          <div className="space-y-1">
            {digest.contractSnippets.map((snippet, idx) => (
              <pre
                key={`${idx}-${snippet.slice(0, 24)}`}
                className="px-2 py-1 rounded bg-amber-500/10 border border-amber-500/25 font-mono text-[11px] text-amber-200 whitespace-pre-wrap break-words"
              >
                {snippet}
              </pre>
            ))}
          </div>
        </div>
      )}

      {digest.formattedMarkdown && (
        <details
          open={!hasStructuredItems}
          className="group rounded border border-zinc-800/80 bg-zinc-950/90"
        >
          <summary className="cursor-pointer select-none px-2.5 py-1.5 text-[11px] text-zinc-400 hover:text-zinc-200 flex items-center gap-1.5 list-none">
            <ChevronRight className="w-3 h-3 group-open:hidden shrink-0" />
            <ChevronDown className="w-3 h-3 hidden group-open:block shrink-0" />
            <span>{t("drawer.handoverRawToggle")}</span>
          </summary>
          <pre className="px-2.5 pb-2.5 pt-1 border-t border-zinc-800/80 text-[11px] font-mono text-zinc-300 whitespace-pre-wrap leading-relaxed overflow-x-auto">
            {digest.formattedMarkdown}
          </pre>
        </details>
      )}
    </div>
  );
}
