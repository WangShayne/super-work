import { Search } from "lucide-react";
import { api } from "../../api.ts";
import { useI18n } from "../../i18n.tsx";
import type { ChainOfRecall, MemorySearchHit } from "../../types.ts";

export interface RecallTabProps {
  recall: ChainOfRecall;
  searchQ: string;
  setSearchQ: (v: string) => void;
  searchHits: MemorySearchHit[] | null;
  handleMemorySearch: (e: React.FormEvent) => Promise<void>;
  artifactContent: { id: string; text: string } | null;
  handleLoadArtifact: (id: string) => Promise<void>;
}

export function RecallTab({
  recall,
  searchQ,
  setSearchQ,
  searchHits,
  handleMemorySearch,
  artifactContent,
  handleLoadArtifact,
}: RecallTabProps) {
  const { t } = useI18n();
  return (
    <div className="space-y-5">
      {/* FTS5 Search */}
      <form onSubmit={handleMemorySearch} className="flex gap-2">
        <div className="relative flex-1">
          <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-2.5" />
          <input
            type="text"
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            placeholder={t("drawer.searchPlaceholder")}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-8 pr-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500"
          />
        </div>
        <button
          type="submit"
          className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-200"
        >
          {t("drawer.recallButton")}
        </button>
      </form>

      {searchHits && (
        <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/5 p-3 space-y-2">
          <div className="text-[11px] font-semibold text-indigo-300">
            {t("drawer.ftsHitsTitle")} ({searchHits.length})
          </div>
          {searchHits.map((hit, idx) => (
            <div key={idx} className="text-xs border-t border-zinc-800/60 pt-1.5">
              <span className="font-mono text-zinc-400">[{hit.ticketId}]</span>{" "}
              <span className="text-zinc-200 font-medium">{hit.title}</span>
              <p className="text-zinc-400 text-[11px] mt-0.5">{hit.snippet}</p>
            </div>
          ))}
        </div>
      )}

      {recall.matchedCases && recall.matchedCases.length > 0 && (
        <div className="space-y-2 text-xs">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-teal-300">
            {t("drawer.recallCasebookTitle")} ({recall.matchedCases.length})
          </h3>
          <div className="space-y-2">
            {recall.matchedCases.map((c) => (
              <div
                key={c.id}
                className={`rounded-lg border p-3 space-y-1 ${
                  c.reverted
                    ? "border-rose-500/35 bg-rose-500/5"
                    : "border-teal-500/25 bg-teal-500/5"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-zinc-100">{c.title}</span>
                  <span
                    className={`px-1.5 py-0.2 rounded font-mono text-[10px] ${
                      c.reverted
                        ? "bg-rose-500/20 text-rose-300"
                        : "bg-emerald-500/15 text-emerald-300"
                    }`}
                  >
                    {c.reverted
                      ? t("modal.repoSettings.casebookRevertedBadge")
                      : t("modal.repoSettings.casebookVerifiedBadge")}
                  </span>
                </div>
                <p className="text-zinc-300 text-[11px]">{c.solutionSummary}</p>
                {c.pitfallsAndFixes && (
                  <p className="text-amber-300 text-[11px]">{c.pitfallsAndFixes}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Lineage: Trigger -> Thread -> Inline -> Spill */}
      <div className="space-y-3 text-xs">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
          {t("drawer.lineageTitle")}
        </h3>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 space-y-2">
          <div>
            <span className="text-zinc-500">{t("drawer.originTrigger")}</span>{" "}
            <span className="font-mono text-zinc-300">
              {recall.trigger?.source} ({recall.thread?.threadKey})
            </span>
          </div>
          {recall.ticket.inlineMemory.planSummary && (
            <div>
              <span className="text-zinc-500 block">{t("drawer.planSummary")}</span>
              <p className="text-zinc-300 mt-0.5 whitespace-pre-wrap">
                {recall.ticket.inlineMemory.planSummary}
              </p>
            </div>
          )}
          {recall.ticket.inlineMemory.threadUpdates.length > 0 && (
            <div>
              <span className="text-zinc-500 block">{t("drawer.threadUpdates")}</span>
              <ul className="list-disc pl-4 text-zinc-300 mt-1 space-y-1">
                {recall.ticket.inlineMemory.threadUpdates.map((u) => (
                  <li key={u.triggerId}>
                    <span className="font-mono text-zinc-500 text-[10px]">
                      {u.createdAt.slice(11, 19)}
                    </span>{" "}
                    {u.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 pt-2">
          {t("drawer.spillTitle")}
        </h3>
        {recall.artifacts.length === 0 ? (
          <p className="text-zinc-500">{t("drawer.noSpill")}</p>
        ) : (
          <div className="space-y-2">
            {recall.artifacts.map((art) => (
              <div
                key={art.id}
                className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 space-y-2"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <span
                      className={`font-mono text-[10px] px-1.5 py-0.5 rounded mr-2 ${
                        art.kind === "test_log" || art.kind === "smoke_log"
                          ? art.summary.startsWith("FAIL")
                            ? "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                            : "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                          : art.kind === "handover"
                            ? "bg-teal-500/20 text-teal-300 border border-teal-500/30"
                            : art.kind === "screenshot"
                              ? "bg-sky-500/20 text-sky-300 border border-sky-500/30"
                              : art.kind === "visual_diff"
                                ? "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                                : "bg-zinc-800 text-zinc-300"
                      }`}
                    >
                      {art.kind === "test_log"
                        ? t("drawer.testLogTag")
                        : art.kind === "smoke_log"
                          ? t("drawer.smokeLogTag")
                          : art.kind === "handover"
                            ? t("drawer.handoverTag")
                            : art.kind === "screenshot"
                              ? "Screenshot"
                              : art.kind === "visual_diff"
                                ? t("drawer.visualDiffTag")
                                : art.kind}
                    </span>
                    <span className="text-zinc-200">{art.summary}</span>
                    <span className="text-zinc-500 text-[11px] ml-2">
                      ({art.byteSize} {t("drawer.bytes")})
                    </span>
                  </div>
                  {art.kind === "screenshot" || art.kind === "visual_diff" ? (
                    <a
                      href={api.getArtifactRawUrl(art.id)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sky-400 hover:text-sky-300 font-medium"
                    >
                      {t("preview.openBtn")}
                    </a>
                  ) : (
                    <button
                      onClick={() => handleLoadArtifact(art.id)}
                      className="text-indigo-400 hover:text-indigo-300 font-medium"
                    >
                      {artifactContent?.id === art.id
                        ? t("drawer.hideSpill")
                        : t("drawer.readSpill")}
                    </button>
                  )}
                </div>
                {(art.kind === "screenshot" || art.kind === "visual_diff") && (
                  <a
                    href={api.getArtifactRawUrl(art.id)}
                    target="_blank"
                    rel="noreferrer"
                    className="block rounded-lg border border-zinc-800 overflow-hidden bg-zinc-950 hover:border-sky-500/50 transition"
                  >
                    <img
                      src={api.getArtifactRawUrl(art.id)}
                      alt={art.summary || art.kind}
                      className="w-full max-h-64 object-contain bg-zinc-950"
                    />
                  </a>
                )}
                {artifactContent?.id === art.id && (
                  <pre className="p-2.5 rounded bg-zinc-950 border border-zinc-800 text-[11px] font-mono text-zinc-300 max-h-60 overflow-auto whitespace-pre-wrap">
                    {artifactContent.text}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
