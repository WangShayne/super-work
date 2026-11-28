import { AlertTriangle, Bot, Check, CheckCircle2, Cloud, Coins, Info, Layers, Zap, type LucideIcon } from "lucide-react";
import { useI18n, type TranslationKey } from "../../i18n.tsx";
import type { PublicModelProfile } from "../../types.ts";
import {
  buildSmartModelRecipes,
  diagnoseModelBindings,
  type RecipeId,
  type RoleBindings,
} from "../../utils/modelAdvisor.ts";

const SELECT =
  "w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500 focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:opacity-60";

const RECIPE_ICON: Record<RecipeId, LucideIcon> = {
  hybrid_best: Coins,
  cli_heterogeneous: Zap,
  pure_api: Cloud,
  smart_auto: Bot,
};

type RoleKey = keyof RoleBindings;

interface RoleCardDef {
  role: RoleKey;
  label: TranslationKey;
  hint: TranslationKey;
  track: TranslationKey;
  special: { value: string; label: TranslationKey };
}

const ROLE_CARDS: RoleCardDef[] = [
  { role: "controlModelId", label: "models.roles.control", hint: "models.roles.controlHint", track: "models.roles.controlTrack", special: { value: "heuristic", label: "models.roles.heuristic" } },
  { role: "implementModelId", label: "models.roles.implement", hint: "models.roles.implementHint", track: "models.roles.implementTrack", special: { value: "auto", label: "models.roles.autoImplement" } },
  { role: "reviewModelId", label: "models.roles.review", hint: "models.roles.reviewHint", track: "models.roles.reviewTrack", special: { value: "auto", label: "models.roles.autoReview" } },
];

interface ModelRoleBoardProps {
  profiles: PublicModelProfile[];
  /** Effective (dangling-id-resolved) bindings. */
  bindings: RoleBindings;
  busy: boolean;
  msg: { ok: boolean; text: string } | null;
  /** Persist one or several roles in a single request. */
  onApplyRoles: (patch: Partial<RoleBindings>) => void;
}

/** Section ① — three role cards, 1-click smart recipes and the live anti-pattern advisor. */
export function ModelRoleBoard({ profiles, bindings, busy, msg, onApplyRoles }: ModelRoleBoardProps) {
  const { t } = useI18n();
  const ready = profiles.filter((p) => p.ready);
  const recipes = buildSmartModelRecipes(profiles, bindings);
  const advice = diagnoseModelBindings(profiles, bindings);

  return (
    <section className="space-y-3" aria-labelledby="model-roles-title">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 id="model-roles-title" className="font-semibold text-zinc-100 flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-indigo-400" aria-hidden="true" />
            {t("models.roles.title")}
          </h4>
          <p className="text-[11px] text-zinc-500 mt-0.5">{t("models.roles.hint")}</p>
        </div>
        {msg?.ok && (
          <span role="status" className="inline-flex items-center gap-1 text-[11px] text-emerald-300 shrink-0">
            <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
            {msg.text}
          </span>
        )}
      </div>

      {recipes.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("models.recipes.title")}>
          <span className="text-[11px] text-zinc-500 mr-1">{t("models.recipes.title")}</span>
          {recipes.map((r) => {
            const Icon = RECIPE_ICON[r.id];
            return (
              <button
                key={r.id}
                type="button"
                disabled={busy}
                aria-pressed={r.isActive}
                onClick={() => onApplyRoles({ controlModelId: r.controlModelId, implementModelId: r.implementModelId, reviewModelId: r.reviewModelId })}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] transition disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
                  r.isActive
                    ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-200"
                    : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-indigo-500/50 hover:text-zinc-100"
                }`}
              >
                {r.isActive ? <Check className="w-3 h-3 text-emerald-400" aria-hidden="true" /> : <Icon className="w-3 h-3" aria-hidden="true" />}
                {t(`models.recipe.${r.id}` as TranslationKey)}
              </button>
            );
          })}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {ROLE_CARDS.map(({ role, label, hint, track, special }) => {
          const value = bindings[role];
          const saved = profiles.find((p) => p.id === value);
          return (
            <div key={role} className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-900/50 p-3 space-y-1.5">
              <label htmlFor={`role-${role}`} className="block text-zinc-200 font-medium">{t(label)}</label>
              <p className="text-[10px] text-zinc-500 break-words">{t(hint)}</p>
              <span className="inline-block px-1.5 py-0.5 rounded border border-zinc-700/70 bg-zinc-800/60 text-[10px] text-zinc-400">{t(track)}</span>
              <select id={`role-${role}`} value={value} disabled={busy} onChange={(e) => onApplyRoles({ [role]: e.target.value })} className={SELECT}>
                <option value={special.value}>{t(special.label)}</option>
                {saved && !saved.ready && <option value={saved.id}>{saved.name} {t("models.notReadyOption")}</option>}
                {ready.map((p) => (
                  <option key={p.id} value={p.id}>{`${p.name} · ${p.kind === "cli" ? "CLI" : "API"}`}</option>
                ))}
              </select>
            </div>
          );
        })}
      </div>

      {advice.length > 0 && (
        <ul className="space-y-1.5" aria-label="advisor">
          {advice.map((a) => {
            const warn = a.severity === "warn";
            const Icon = warn ? AlertTriangle : Info;
            const fixKey: TranslationKey = a.kind === "heuristic_control" ? "models.advice.fixControl" : "models.advice.fixReview";
            return (
              <li
                key={a.kind}
                className={`flex flex-wrap items-center gap-2 px-2.5 py-1.5 rounded-lg border text-[11px] ${
                  warn ? "border-amber-500/30 bg-amber-500/10 text-amber-200" : "border-sky-500/25 bg-sky-500/5 text-sky-200"
                }`}
              >
                <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 break-words">{t(`models.advice.${a.kind}` as TranslationKey)}</span>
                {a.suggestedPatch && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onApplyRoles(a.suggestedPatch!)}
                    className="px-2 py-0.5 rounded-md border border-current/40 bg-zinc-950/40 hover:bg-zinc-950/70 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                  >
                    {t(fixKey)}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {msg && !msg.ok && <div role="alert" className="text-[11px] text-rose-400 break-words">{msg.text}</div>}
    </section>
  );
}
