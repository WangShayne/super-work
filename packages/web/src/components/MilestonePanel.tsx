import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Layers, RefreshCw, Rocket } from "lucide-react";
import { api } from "../api.ts";
import { type TranslationKey, useI18n } from "../i18n.tsx";
import type { Milestone, MilestoneItem } from "../types.ts";

interface MilestonePanelProps {
  repoId?: string;
  onInspectTicket?: (ticketId: string) => void;
  onRefreshParent?: () => void;
}

const ITEM_BADGE: Record<MilestoneItem["status"], string> = {
  pending: "bg-zinc-800 text-zinc-300 border-zinc-700",
  running: "bg-indigo-500/15 text-indigo-300 border-indigo-500/30",
  delivered: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  failed: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  needs_human: "bg-amber-500/15 text-amber-300 border-amber-500/30",
};

function groupByWave(items: MilestoneItem[]): Array<[number, MilestoneItem[]]> {
  const map = new Map<number, MilestoneItem[]>();
  for (const item of items) {
    const list = map.get(item.waveIndex) ?? [];
    list.push(item);
    map.set(item.waveIndex, list);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]);
}

function MilestoneCard({
  milestone,
  onInspectTicket,
  onChanged,
}: {
  milestone: Milestone;
  onInspectTicket?: (ticketId: string) => void;
  onChanged: () => void;
}) {
  const { locale, t } = useI18n();
  const [notesLang, setNotesLang] = useState<"zh" | "en">(locale);
  const [bumpVersion, setBumpVersion] = useState(true);
  const [createTag, setCreateTag] = useState(false);
  const [pushRemote, setPushRemote] = useState(false);
  const [squash, setSquash] = useState(false);
  const [githubRelease, setGithubRelease] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [error, setError] = useState("");

  const ready = milestone.status === "ready_to_release";
  const notes = notesLang === "zh" ? milestone.releaseNotesZh : milestone.releaseNotesEn;
  const delivered = milestone.items.filter((i) => i.status === "delivered").length;

  const release = async () => {
    setReleasing(true);
    setError("");
    try {
      await api.releaseMilestone(milestone.id, {
        bumpVersion,
        createTag,
        pushRemote,
        squashReleaseCommit: squash,
        createGithubRelease: githubRelease && createTag && pushRemote,
      });
      setConfirming(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReleasing(false);
    }
  };

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3.5 space-y-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Layers className="w-4 h-4 text-teal-400 shrink-0" />
          <span className="font-semibold text-zinc-100 truncate">
            {milestone.name}
            {milestone.targetVersion ? ` v${milestone.targetVersion}` : ""}
          </span>
          <span
            className={`px-1.5 py-0.5 rounded border text-[10px] font-medium ${
              ready
                ? "bg-teal-500/15 text-teal-300 border-teal-500/30"
                : "bg-indigo-500/15 text-indigo-300 border-indigo-500/30"
            }`}
          >
            {t(`milestone.status.${milestone.status}` as TranslationKey)}
          </span>
          {milestone.stagingBranch && (
            <span
              title={milestone.stagingBranch}
              className="px-1.5 py-0.5 rounded border border-violet-500/30 bg-violet-500/15 text-[10px] font-mono text-violet-300 truncate max-w-[220px]"
            >
              {t("milestone.stagingBadge")}: {milestone.stagingBranch}
            </span>
          )}
        </div>
        <span className="text-zinc-500">
          {delivered}/{milestone.items.length}
        </span>
      </div>

      <div className="flex gap-3 overflow-x-auto pb-1">
        {groupByWave(milestone.items).map(([wave, items]) => (
          <div
            key={wave}
            className="min-w-[200px] flex-1 rounded-lg border border-zinc-800 bg-zinc-950/60 p-2 space-y-1.5"
          >
            <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              {t("milestone.wave").replace("{n}", String(wave + 1))}
            </div>
            {items.map((item) => {
              const ticketId = item.epicId ?? item.ticketId;
              return (
                <button
                  key={item.id}
                  type="button"
                  disabled={!ticketId || !onInspectTicket}
                  onClick={() => ticketId && onInspectTicket?.(ticketId)}
                  className="w-full text-left rounded-md border border-zinc-800 bg-zinc-900/70 p-2 space-y-1 hover:border-zinc-700 disabled:cursor-default"
                >
                  <div className="text-zinc-200 line-clamp-2">{item.title}</div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={`px-1.5 py-0.5 rounded border text-[10px] ${ITEM_BADGE[item.status]}`}
                    >
                      {t(`milestone.item.${item.status}` as TranslationKey)}
                    </span>
                    {item.dependsOnIndices.length > 0 && (
                      <span className="text-[10px] text-zinc-500">
                        {t("milestone.dependsOn").replace(
                          "{n}",
                          item.dependsOnIndices.map((d) => d + 1).join(",#"),
                        )}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {ready && (
        <div className="space-y-2.5 border-t border-zinc-800 pt-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
              {t("milestone.notes")}
            </span>
            <div className="inline-flex rounded-md border border-zinc-800 overflow-hidden">
              {(["zh", "en"] as const).map((lang) => (
                <button
                  key={lang}
                  type="button"
                  onClick={() => setNotesLang(lang)}
                  className={`px-2 py-0.5 text-[11px] ${
                    notesLang === lang
                      ? "bg-indigo-600 text-white"
                      : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {t(lang === "zh" ? "milestone.notesZh" : "milestone.notesEn")}
                </button>
              ))}
            </div>
          </div>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-950/70 p-3 text-zinc-300 leading-relaxed font-sans">
            {notes ?? ""}
          </pre>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-zinc-300">
            <label className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={bumpVersion}
                onChange={(e) => setBumpVersion(e.target.checked)}
              />
              {t("milestone.optBump")}
            </label>
            <label className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={createTag}
                onChange={(e) => {
                  setCreateTag(e.target.checked);
                  if (!e.target.checked) setGithubRelease(false);
                }}
              />
              {t("milestone.optTag")}
            </label>
            <label className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={pushRemote}
                onChange={(e) => {
                  setPushRemote(e.target.checked);
                  if (!e.target.checked) setGithubRelease(false);
                }}
              />
              {t("milestone.optPush")}
            </label>
            <label
              className={`inline-flex items-center gap-1.5 ${createTag && pushRemote ? "" : "opacity-50"}`}
              title={t("milestone.optGithubReleaseHint")}
            >
              <input
                type="checkbox"
                checked={githubRelease && createTag && pushRemote}
                disabled={!(createTag && pushRemote)}
                onChange={(e) => setGithubRelease(e.target.checked)}
              />
              {t("milestone.optGithubRelease")}
            </label>
            <label className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={squash}
                onChange={(e) => setSquash(e.target.checked)}
              />
              {t("milestone.optSquash")}
            </label>
          </div>

          {error && <div className="text-rose-400">{error}</div>}

          <div className="flex justify-end">
            {confirming ? (
              <div className="inline-flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="px-3 py-1.5 rounded-lg border border-zinc-800 text-zinc-400 hover:text-zinc-200"
                >
                  {t("modal.dispatch.cancel")}
                </button>
                <button
                  type="button"
                  disabled={releasing}
                  onClick={() => void release()}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium disabled:opacity-50"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  {releasing ? t("milestone.releasing") : t("milestone.releaseConfirm")}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-500 text-white font-medium"
              >
                <Rocket className="w-3.5 h-3.5" />
                {t("milestone.releaseBtn")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ReleasedMilestoneRow({ milestone }: { milestone: Milestone }) {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [notesLang, setNotesLang] = useState<"zh" | "en">(locale);
  const notes = notesLang === "zh" ? milestone.releaseNotesZh : milestone.releaseNotesEn;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 space-y-2 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex flex-wrap items-center justify-between gap-2 text-left"
      >
        <span className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-zinc-200 truncate">{milestone.name}</span>
          {milestone.targetVersion && (
            <span className="px-1.5 py-0.5 rounded border border-emerald-500/30 bg-emerald-500/15 text-[10px] text-emerald-300">
              v{milestone.targetVersion}
            </span>
          )}
          {milestone.releasedCommitSha && (
            <span
              className="font-mono text-[10px] text-zinc-500"
              title={`${t("milestone.releasedCommit")}: ${milestone.releasedCommitSha}`}
            >
              {milestone.releasedCommitSha.slice(0, 8)}
            </span>
          )}
        </span>
        <span className="text-[11px] text-zinc-500">
          {open ? t("milestone.historyHide") : t("milestone.historyShow")}
        </span>
      </button>
      {open && (
        <div className="space-y-2">
          <div className="inline-flex rounded-md border border-zinc-800 overflow-hidden">
            {(["zh", "en"] as const).map((lang) => (
              <button
                key={lang}
                type="button"
                onClick={() => setNotesLang(lang)}
                className={`px-2 py-0.5 text-[11px] ${
                  notesLang === lang ? "bg-indigo-600 text-white" : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {t(lang === "zh" ? "milestone.notesZh" : "milestone.notesEn")}
              </button>
            ))}
          </div>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-950/70 p-3 text-zinc-300 leading-relaxed font-sans">
            {notes || t("milestone.noNotes")}
          </pre>
        </div>
      )}
    </div>
  );
}

export default function MilestonePanel({
  repoId,
  onInspectTicket,
  onRefreshParent,
}: MilestonePanelProps) {
  const { t } = useI18n();
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [released, setReleased] = useState<Milestone[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.listMilestones(repoId);
      setMilestones(
        res.milestones.filter((m) => m.status === "active" || m.status === "ready_to_release"),
      );
      setReleased(res.milestones.filter((m) => m.status === "released"));
    } catch {
      // Milestones are optional; stay silent when the daemon predates v1.4.
    } finally {
      setLoading(false);
    }
  }, [repoId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  if (milestones.length === 0 && released.length === 0) return null;

  return (
    <section className="space-y-2.5">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          {t("milestone.panelTitle")}
        </h3>
        <button
          type="button"
          onClick={() => void load()}
          className="text-zinc-500 hover:text-zinc-200"
          aria-label="refresh"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>
      {milestones.map((m) => (
        <MilestoneCard
          key={m.id}
          milestone={m}
          onInspectTicket={onInspectTicket}
          onChanged={() => {
            void load();
            onRefreshParent?.();
          }}
        />
      ))}
      {released.length > 0 && (
        <div className="space-y-2 border-t border-zinc-800 pt-2.5">
          <button
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            aria-expanded={historyOpen}
            className="w-full flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-zinc-400 hover:text-zinc-200"
          >
            <span>
              {t("milestone.historyTitle")} ({released.length})
            </span>
            <span className="text-[11px] font-normal normal-case text-zinc-500">
              {historyOpen ? t("milestone.historyHide") : t("milestone.historyShow")}
            </span>
          </button>
          {historyOpen &&
            released.map((m) => <ReleasedMilestoneRow key={m.id} milestone={m} />)}
        </div>
      )}
    </section>
  );
}
