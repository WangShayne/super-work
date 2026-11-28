import { useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { api } from "../../api.ts";
import { formatLlmProviderDisplay, useI18n } from "../../i18n.tsx";
import type { PublicModelProfile, PublicSetupStatus, RepoConfig, WorkerEngineId } from "../../types.ts";
import { activeRolesOfProfile, isAutoCandidate, type RoleBindings } from "../../utils/modelAdvisor.ts";
import { ModelProfileCard, type CardTestState } from "./ModelProfileCard.tsx";
import { ModelProfileForm } from "./ModelProfileForm.tsx";
import { ModelRoleBoard } from "./ModelRoleBoard.tsx";
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

/** Role-first studio: ① roles + smart recipes + advisor ② dual-track model pool (Native CLI / Built-in API harness). */
export function ModelRegistryStudio({ setupStatus, repo, onPatchRepo, onSetupSaved }: ModelRegistryStudioProps) {
  const { t, locale } = useI18n();
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

  // ---- Role bindings (dangling ids fall back to heuristic / auto) ----
  const known = new Set(profiles.map((p) => p.id));
  const roleValue = (role: Role): string => {
    const raw = role === "controlModelId" ? cfg.controlModelId : role === "implementModelId" ? (repo?.implementModelId ?? cfg.implementModelId) : (repo?.reviewModelId ?? cfg.reviewModelId);
    const special = role === "controlModelId" ? "heuristic" : "auto";
    return raw && (raw === special || known.has(raw)) ? raw : special;
  };
  const bindings: RoleBindings = {
    controlModelId: roleValue("controlModelId"),
    implementModelId: roleValue("implementModelId"),
    reviewModelId: roleValue("reviewModelId"),
  };

  /** Persist one or several roles with a single configureSetup (+ one repo patch) so recipes never race. */
  const applyRoles = (patch: Partial<RoleBindings>) =>
    guard(
      setBusy,
      async () => {
        const engineOf = (id?: string) => {
          const profile = profiles.find((p) => p.id === id);
          return profile ? (profileEngine(profile) as WorkerEngineId) : undefined;
        };
        const payload: SetupPayload = { ...patch };
        // derived engines never clobber 'auto': only a concrete model pins an engine
        const implEngine = engineOf(patch.implementModelId);
        const revEngine = engineOf(patch.reviewModelId);
        if (implEngine) payload.preferredImplementEngine = implEngine;
        if (revEngine) payload.preferredReviewEngine = revEngine;
        const touchesWorkers = patch.implementModelId !== undefined || patch.reviewModelId !== undefined;
        await apply({ ...payload, ...(repo || !touchesWorkers ? {} : { syncRepos: true }) });
        if (repo && onPatchRepo && touchesWorkers) {
          const repoPatch: RepoPatch = {
            ...(patch.implementModelId !== undefined ? { implementModelId: patch.implementModelId, preferredImplementEngine: implEngine ?? "auto" } : {}),
            ...(patch.reviewModelId !== undefined ? { reviewModelId: patch.reviewModelId, ...(revEngine ? { preferredReviewEngine: revEngine } : {}) } : {}),
          };
          await onPatchRepo(repo.id, repoPatch);
        }
      },
      true,
    );

  const controlProfile = profiles.find((p) => p.id === bindings.controlModelId);

  return (
    <div className="space-y-4 text-xs">
      {/* Section ① — Role-first board: roles, recipes, advisor */}
      <ModelRoleBoard profiles={profiles} bindings={bindings} busy={busy} msg={msg} onApplyRoles={(p) => void applyRoles(p)} />

      {/* Section ② — Model Pool (dual-track peer harnesses) */}
      <section className="space-y-3 pt-4 border-t border-zinc-800/80" aria-labelledby="model-pool-title">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 mr-auto">
            <h4 id="model-pool-title" className="font-semibold text-zinc-100">{t("models.pool.title")}</h4>
            <p className="text-[11px] text-zinc-500 mt-0.5">{t("models.pool.hint")}</p>
          </div>
          <span className="px-2 py-0.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 text-[11px] font-mono">
            {readyProfiles.length}/{profiles.length} {t("models.readyCount")}
          </span>
          <span className="text-[11px] text-zinc-400 truncate max-w-[14rem]">
            {t("models.controlActive")}:{" "}
            <span className="text-zinc-200">{controlProfile?.name ?? formatLlmProviderDisplay(setupStatus.activeLlmProvider, locale)}</span>
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
                roles={activeRolesOfProfile(p.id, bindings)}
                autoCandidate={isAutoCandidate(p, bindings)}
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
    </div>
  );
}
