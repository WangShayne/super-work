import { CheckCircle2, Cloud, Loader2, Pencil, Terminal, Trash2, XCircle, Zap } from "lucide-react";
import { useI18n, type TranslationKey } from "../../i18n.tsx";
import type { PublicModelProfile } from "../../types.ts";
import { formatModelStatusHuman, type ModelRole } from "../../utils/modelAdvisor.ts";
import { hostOf } from "./modelTemplates.ts";

const ROLE_BADGE: Record<ModelRole, { key: TranslationKey; cls: string }> = {
  control: { key: "models.badge.control", cls: "border-indigo-500/40 bg-indigo-500/15 text-indigo-200" },
  implement: { key: "models.badge.implement", cls: "border-sky-500/40 bg-sky-500/15 text-sky-200" },
  review: { key: "models.badge.review", cls: "border-violet-500/40 bg-violet-500/15 text-violet-200" },
};

export interface CardTestState {
  running: boolean;
  ok?: boolean;
  text?: string;
}

interface ModelProfileCardProps {
  profile: PublicModelProfile;
  busy: boolean;
  /** Roles this profile is explicitly pinned to. */
  roles: ModelRole[];
  /** Unpinned but eligible for Auto routing. */
  autoCandidate: boolean;
  test?: CardTestState;
  confirmingDelete: boolean;
  onToggleAutoPool: () => void;
  onTest: () => void;
  onEdit: () => void;
  onAskDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}

const ACTION =
  "inline-flex items-center gap-1 px-2 py-1 rounded-md border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-[11px] disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400";

/** One peer card of the Model Pool: identical layout for CLI and API profiles. */
export function ModelProfileCard({
  profile: p,
  busy,
  roles,
  autoCandidate,
  test,
  confirmingDelete,
  onToggleAutoPool,
  onTest,
  onEdit,
  onAskDelete,
  onConfirmDelete,
  onCancelDelete,
}: ModelProfileCardProps) {
  const { t, locale } = useI18n();
  const KindIcon = p.kind === "cli" ? Terminal : Cloud;
  const engine = p.kind === "cli" ? p.cliEngine : p.apiProtocol;
  const relay = p.kind === "cli" && Boolean(p.baseUrl || p.hasApiKey);
  const meta = [p.model || t("setup.followLocalDefault"), p.effort, hostOf(p.baseUrl)].filter(Boolean).join(" · ");
  const needsCompletion = !p.ready && !p.builtinCli;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3 space-y-2 min-w-0">
      <div className="flex items-start justify-between gap-2 min-w-0">
        <div className="min-w-0">
          <div className="font-semibold text-zinc-100 truncate">{p.name}</div>
          <span className="inline-flex items-center gap-1 mt-0.5 text-[10px] font-mono text-zinc-400">
            <KindIcon className="w-3 h-3" aria-hidden="true" />
            {t(p.kind === "cli" ? "models.track.cli" : "models.track.api")} · {engine}
          </span>
        </div>
        <div className="flex flex-wrap justify-end gap-1 shrink-0">
          {roles.map((r) => (
            <span key={r} className={`px-1.5 py-0.5 rounded-full border text-[10px] font-medium ${ROLE_BADGE[r].cls}`}>
              {t(ROLE_BADGE[r].key)}
            </span>
          ))}
          {roles.length === 0 && autoCandidate && (
            <span className="px-1.5 py-0.5 rounded-full border border-zinc-700 bg-zinc-800/60 text-zinc-400 text-[10px]">
              {t("models.badge.auto")}
            </span>
          )}
          {relay && (
            <span className="px-1.5 py-0.5 rounded border border-sky-500/30 bg-sky-500/10 text-sky-300 text-[10px]">
              {t("models.relay")}
            </span>
          )}
          <span
            className={`px-1.5 py-0.5 rounded border text-[10px] ${
              p.ready ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-amber-500/30 bg-amber-500/10 text-amber-300"
            }`}
          >
            {p.ready ? t("models.status.ready") : t("models.status.notReady")}
          </span>
        </div>
      </div>

      <div className="text-[11px] text-zinc-400 font-mono truncate" title={meta}>{meta}</div>
      <div className={`text-[11px] break-words ${p.ready ? "text-zinc-400" : "text-amber-300/90"}`}>{formatModelStatusHuman(p, locale)}</div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <label title={t("models.autoPoolTip")} className="inline-flex items-center gap-1.5 text-[11px] text-zinc-300 cursor-pointer select-none">
          <button
            type="button"
            role="switch"
            aria-checked={p.workerAutoPool}
            disabled={busy}
            onClick={onToggleAutoPool}
            className={`relative w-8 h-[18px] rounded-full transition disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
              p.workerAutoPool ? "bg-indigo-500" : "bg-zinc-700"
            }`}
          >
            <span className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-all ${p.workerAutoPool ? "left-[16px]" : "left-0.5"}`} />
          </button>
          {t("models.autoPool")}
        </label>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <button type="button" onClick={onTest} disabled={busy || test?.running} className={ACTION}>
            {test?.running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
            {t("models.test")}
          </button>
          <button
            type="button"
            onClick={onEdit}
            disabled={busy}
            className={needsCompletion ? `${ACTION} !border-amber-500/50 !bg-amber-500/10 !text-amber-200 hover:!bg-amber-500/20` : ACTION}
          >
            <Pencil className="w-3 h-3" />
            {needsCompletion ? t("models.complete") : t("models.edit")}
          </button>
          {!p.builtinCli &&
            (confirmingDelete ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/40 bg-rose-500/10 pl-1 pr-1 py-0.5">
                <button type="button" onClick={onConfirmDelete} disabled={busy} className="px-1.5 text-[11px] text-rose-300 hover:text-rose-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 rounded">
                  {t("models.confirmDelete")}
                </button>
                <button type="button" onClick={onCancelDelete} className="px-1.5 text-[11px] text-zinc-400 hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 rounded">
                  {t("models.cancel")}
                </button>
              </span>
            ) : (
              <button type="button" onClick={onAskDelete} disabled={busy} className={`${ACTION} hover:text-rose-300`}>
                <Trash2 className="w-3 h-3" />
                {t("models.delete")}
              </button>
            ))}
        </div>
      </div>

      {test?.text && (
        <div
          role="status"
          className={`flex items-start gap-1.5 text-[11px] break-words ${test.ok ? "text-emerald-300" : "text-rose-300"}`}
        >
          {test.ok ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <XCircle className="w-3.5 h-3.5 shrink-0" />}
          <span className="min-w-0">{test.text}</span>
        </div>
      )}
    </div>
  );
}
