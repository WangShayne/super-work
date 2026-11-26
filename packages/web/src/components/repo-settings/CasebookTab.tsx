import { RotateCcw, Search, Trash2 } from "lucide-react";

import { useI18n } from "../../i18n.tsx";
import type { CasebookEntry, RepoConfig } from "../../types.ts";
import { CloseFooter } from "./CloseFooter.tsx";

export interface CasebookTabProps {
  casebook: CasebookEntry[];
  casebookLoading: boolean;
  casebookQuery: string;
  setCasebookQuery: (value: string) => void;
  repo: RepoConfig;
  onClose?: () => void;
  handleDeleteCase: (entryId: string) => Promise<void>;
  loadCasebook: (repoId: string, q?: string) => Promise<void>;
}

export function CasebookTab({
  casebook,
  casebookLoading,
  casebookQuery,
  setCasebookQuery,
  repo,
  onClose,
  handleDeleteCase,
  loadCasebook,
}: CasebookTabProps) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden text-xs">
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void loadCasebook(repo.id, casebookQuery.trim() || undefined);
          }}
          className="flex gap-2"
        >
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-2" />
            <input
              type="text"
              value={casebookQuery}
              onChange={(e) => setCasebookQuery(e.target.value)}
              placeholder={t("modal.repoSettings.casebookSearchPlaceholder")}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg pl-8 pr-3 py-1.5 text-zinc-200 focus:outline-none focus:border-indigo-500"
            />
          </div>
          <button
            type="submit"
            className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200"
          >
            <Search className="w-3.5 h-3.5" />
          </button>
        </form>

        {casebookLoading ? (
          <div className="py-6 text-center text-zinc-500">{t("drawer.loading")}</div>
        ) : casebook.length === 0 ? (
          <div className="py-6 px-4 text-center rounded-lg border border-dashed border-zinc-800 text-zinc-500">
            {t("modal.repoSettings.casebookEmpty")}
          </div>
        ) : (
          <div className="space-y-2.5">
            {casebook.map((c) => (
              <div
                key={c.id}
                className={`rounded-lg border p-3 space-y-1.5 ${
                  c.reverted
                    ? "border-rose-500/35 bg-rose-500/5"
                    : "border-zinc-800 bg-zinc-900/60"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span
                      className={`inline-flex items-center gap-1 px-1.5 py-0.2 rounded font-mono text-[10px] border ${
                        c.reverted
                          ? "bg-rose-500/15 text-rose-300 border-rose-500/30"
                          : "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                      }`}
                    >
                      {c.reverted && <RotateCcw className="w-2.5 h-2.5" />}
                      {c.reverted
                        ? t("modal.repoSettings.casebookRevertedBadge")
                        : t("modal.repoSettings.casebookVerifiedBadge")}
                    </span>
                    <span className="font-mono text-[10px] text-zinc-500">{c.ticketId}</span>
                    <span className="px-1.5 py-0.2 rounded font-mono text-[10px] bg-zinc-950 text-zinc-400 border border-zinc-800">
                      {t("modal.repoSettings.playbookHits")}: {c.hitCount}
                    </span>
                    <span className="font-mono text-[10px] text-emerald-300">
                      [{c.scopePaths.join(", ")}]
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleDeleteCase(c.id)}
                    className="p-1 rounded text-zinc-500 hover:text-rose-400 shrink-0"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
                <div className="font-medium text-zinc-100">{c.title}</div>
                <p className="text-zinc-300 leading-relaxed">{c.solutionSummary}</p>
                {c.pitfallsAndFixes && (
                  <p className="text-[11px] text-amber-300/90 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1">
                    {c.pitfallsAndFixes}
                  </p>
                )}
                {c.exportedSymbols.length > 0 && (
                  <div className="flex flex-wrap gap-1 pt-0.5">
                    {c.exportedSymbols.slice(0, 6).map((sym) => (
                      <code
                        key={sym}
                        className="px-1.5 py-0.2 rounded bg-indigo-500/10 border border-indigo-500/20 font-mono text-[10px] text-indigo-300"
                      >
                        {sym}
                      </code>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <CloseFooter onClose={onClose} />
    </div>
  );
}
