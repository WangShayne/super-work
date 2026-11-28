import { useState } from "react";
import { CheckCircle2, Plus, RefreshCw } from "lucide-react";
import { api } from "../../api.ts";
import { useI18n } from "../../i18n.tsx";
import type { PublicModelProfile, PublicSetupStatus, RepoConfig, WorkerEngineId } from "../../types.ts";
import { ModelProfileCard, type CardTestState } from "./ModelProfileCard.tsx";
import { ModelProfileForm } from "./ModelProfileForm.tsx";
import {
  MODEL_TEMPLATES,
  draftFromProfile,
  draftFromTemplate,
  draftToPatch,
  profileEngine,
  type ProfileDraft,
} from "./modelTemplates.ts";

type RepoPatch = Parameters<typeof api.patchRepo>[1];
type SetupPayload = Parameters<typeof api.configureSetup>[0];
type Role = "controlModelId" | "implementModelId" | "reviewModelId";

interface ModelRegistryStudioProps {
  setupStatus: PublicSetupStatus;
  /** When set, implement/review role changes are also written to this repo. */
  repo?: RepoConfig;
  onPatchRepo?: (repoId: string, patch: RepoPatch) => Promise<void>;
  /** Receives the fresh setup status; the host also refreshes /api/health (engine availability). */
  onSetupSaved: (next: PublicSetupStatus) => void | Promise<void>;
}

const SELECT =
  "w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500 focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:opacity-60";

/** Unified two-stage studio: ① Model Pool (CLI + API peers) ② Role Model Binding (control / implement / review). */
export function ModelRegistryStudio({ setupStatus, repo, onPatchRepo, onSetupSaved }: ModelRegistryStudioProps) {
  const { t } = useI18n();
  const cfg = setupStatus.config;
  const profiles = cfg.modelProfiles ?? [];
  const readyProfiles = profiles.filter((p) => p.ready);
  const [editing, setEditing] = useState<{ draft: ProfileDraft; isNew: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, CardTestState>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const guard = async (setter: (v: boolean) => void, fn: () => Promise<void>, savedMsg = false) => {
    setter(true);
    setMsg(null);
    try {
      await fn();
      if (savedMsg) setMsg({ ok: true, text: t("models.saved") });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setter(false);
    }
  };

  /** Persist via configureSetup (never syncs repos unless a repo-less wizard changes roles) and refresh state. */
  const apply = async (payload: SetupPayload) => {
    const next = await api.configureSetup({ syncRepos: false, ...payload });
    await onSetupSaved(next);
  };

  const rescan = () =>
    guard(setScanning, async () => {
      await api.scanCliEnvironment();
      await onSetupSaved(await api.getSetupStatus());
    });

  const saveDraft = () =>
    guard(
      setBusy,
      async () => {
        if (!editing) return;
        await apply({ modelProfiles: [draftToPatch(editing.draft)] });
        setEditing(null);
      },
      true,
    );

  const toggleAutoPool = (p: PublicModelProfile) =>
    guard(setBusy, () => apply({ modelProfiles: [{ id: p.id, workerAutoPool: !p.workerAutoPool }] }));

  const deleteProfile = (p: PublicModelProfile) =>
    guard(
      setBusy,
      async () => {
        setConfirmId(null);
        await apply({ deleteModelProfileIds: [p.id] });
        if (editing?.draft.id === p.id) setEditing(null);
      },
      true,
    );

  const testProfile = async (p: PublicModelProfile) => {
    setTests((s) => ({ ...s, [p.id]: { running: true } }));
    try {
      const r = await api.testModelConnection({
        id: p.id,
        kind: p.kind,
        cliEngine: p.cliEngine,
        apiProtocol: p.apiProtocol,
        baseUrl: p.baseUrl,
        model: p.model,
        effort: p.effort,
        useSavedKey: p.hasApiKey,
      });
      setTests((s) => ({ ...s, [p.id]: { running: false, ok: r.ok, text: `${r.latencyMs}ms · ${r.message}` } }));
    } catch (err) {
      setTests((s) => ({ ...s, [p.id]: { running: false, ok: false, text: err instanceof Error ? err.message : String(err) } }));
    }
  };

  // ---- Stage 2: role bindings ----
  const known = new Set(profiles.map((p) => p.id));
  const roleValue = (role: Role): string => {
    const raw = role === "controlModelId" ? cfg.controlModelId : role === "implementModelId" ? (repo?.implementModelId ?? cfg.implementModelId) : (repo?.reviewModelId ?? cfg.reviewModelId);
    const special = role === "controlModelId" ? "heuristic" : "auto";
    return raw && (raw === special || known.has(raw)) ? raw : special;
  };

  const changeRole = (role: Role, value: string) =>
    guard(
      setBusy,
      async () => {
        const profile = profiles.find((p) => p.id === value);
        const engine = profile ? (profileEngine(profile) as WorkerEngineId) : undefined;
        const payload: SetupPayload = { [role]: value };
        // derived engines never clobber 'auto': only a concrete model pins an engine
        if (engine && role === "implementModelId") payload.preferredImplementEngine = engine;
        if (engine && role === "reviewModelId") payload.preferredReviewEngine = engine;
        await apply({ ...payload, ...(repo || role === "controlModelId" ? {} : { syncRepos: true }) });
        if (repo && onPatchRepo && role !== "controlModelId") {
          const patch: RepoPatch =
            role === "implementModelId"
              ? { implementModelId: value, preferredImplementEngine: engine ?? "auto" }
              : { reviewModelId: value, ...(engine ? { preferredReviewEngine: engine } : {}) };
          await onPatchRepo(repo.id, patch);
        }
      },
      true,
    );

  const roleSelects: Array<{ role: Role; label: string; hint: string; special: { value: string; label: string } }> = [
    { role: "controlModelId", label: t("models.roles.control"), hint: t("models.roles.controlHint"), special: { value: "heuristic", label: t("models.roles.heuristic") } },
    { role: "implementModelId", label: t("models.roles.implement"), hint: t("models.roles.implementHint"), special: { value: "auto", label: t("models.roles.autoImplement") } },
    { role: "reviewModelId", label: t("models.roles.review"), hint: t("models.roles.reviewHint"), special: { value: "auto", label: t("models.roles.autoReview") } },
  ];

  return (
    <div className="space-y-4 text-xs">
      {/* Stage 1 — Model Pool */}
      <section className="space-y-3" aria-labelledby="model-pool-title">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 mr-auto">
            <h4 id="model-pool-title" className="font-semibold text-zinc-100">{t("models.pool.title")}</h4>
            <p className="text-[11px] text-zinc-500 mt-0.5">{t("models.pool.hint")}</p>
          </div>
          <span className="px-2 py-0.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 text-[11px] font-mono">
            {readyProfiles.length}/{profiles.length} {t("models.readyCount")}
          </span>
          <span className="text-[11px] text-zinc-400 truncate max-w-[14rem]" title={setupStatus.activeLlmProvider}>
            {t("models.controlActive")}: <span className="font-mono text-zinc-200">{setupStatus.activeLlmProvider}</span>
          </span>
          <button
            type="button"
            onClick={() => void rescan()}
            disabled={scanning}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-[11px] disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
          >
            <RefreshCw className={`w-3 h-3 ${scanning ? "animate-spin" : ""}`} />
            {scanning ? t("setup.scanning") : t("models.rescan")}
          </button>
          <button
            type="button"
            onClick={() => setEditing({ draft: draftFromTemplate(MODEL_TEMPLATES[0]!), isNew: true })}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-indigo-500/50 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-200 text-[11px] disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
          >
            <Plus className="w-3 h-3" />
            {t("models.add")}
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {editing?.isNew && (
            <ModelProfileForm draft={editing.draft} isNew saving={busy} onChange={(draft) => setEditing({ draft, isNew: true })} onSave={() => void saveDraft()} onCancel={() => setEditing(null)} />
          )}
          {profiles.length === 0 && !editing && <p className="text-[11px] text-zinc-500 sm:col-span-2">{t("models.empty")}</p>}
          {profiles.map((p) =>
            editing && !editing.isNew && editing.draft.id === p.id ? (
              <ModelProfileForm key={p.id} draft={editing.draft} isNew={false} saving={busy} onChange={(draft) => setEditing({ draft, isNew: false })} onSave={() => void saveDraft()} onCancel={() => setEditing(null)} />
            ) : (
              <ModelProfileCard
                key={p.id}
                profile={p}
                busy={busy}
                test={tests[p.id]}
                confirmingDelete={confirmId === p.id}
                onToggleAutoPool={() => void toggleAutoPool(p)}
                onTest={() => void testProfile(p)}
                onEdit={() => setEditing({ draft: draftFromProfile(p), isNew: false })}
                onAskDelete={() => setConfirmId(p.id)}
                onConfirmDelete={() => void deleteProfile(p)}
                onCancelDelete={() => setConfirmId(null)}
              />
            ),
          )}
        </div>
      </section>

      {/* Stage 2 — Role Model Binding */}
      <section className="space-y-3 pt-4 border-t border-zinc-800/80" aria-labelledby="model-roles-title">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h4 id="model-roles-title" className="font-semibold text-zinc-100">{t("models.roles.title")}</h4>
            <p className="text-[11px] text-zinc-500 mt-0.5">{t("models.roles.hint")}</p>
          </div>
          {msg?.ok && (
            <span role="status" className="inline-flex items-center gap-1 text-[11px] text-emerald-300">
              <CheckCircle2 className="w-3.5 h-3.5" />
              {msg.text}
            </span>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {roleSelects.map(({ role, label, hint, special }) => {
            const value = roleValue(role);
            const saved = profiles.find((p) => p.id === value);
            return (
              <div key={role} className="min-w-0">
                <label htmlFor={`role-${role}`} className="block text-zinc-300 font-medium mb-0.5">{label}</label>
                <p className="text-[10px] text-zinc-500 mb-1">{hint}</p>
                <select id={`role-${role}`} value={value} disabled={busy} onChange={(e) => void changeRole(role, e.target.value)} className={SELECT}>
                  <option value={special.value}>{special.label}</option>
                  {saved && !saved.ready && (
                    <option value={saved.id}>{saved.name} {t("models.notReadyOption")}</option>
                  )}
                  {readyProfiles.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
        {msg && !msg.ok && <div role="alert" className="text-[11px] text-rose-400 break-words">{msg.text}</div>}
      </section>
    </div>
  );
}
