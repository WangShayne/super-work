import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  HardDriveDownload,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Stethoscope,
} from "lucide-react";
import { useI18n } from "../i18n.tsx";
import { api } from "../api.ts";
import type {
  BackupArchiveInfo,
  CodeHotspotItem,
  EngineHealthRecord,
  PlaybookHygieneReport,
  SelfReloadState,
  ServiceStatusResponse,
  EngineHealthFailureKind,
  SystemDoctorReport,
} from "../types.ts";

/** Mirrors core `isPersistentEngineFailure` (kept local: web must not bundle core runtime). */
function isPersistentEngineFailure(kind?: EngineHealthFailureKind): boolean {
  return (
    kind === "model_unsupported" ||
    kind === "tier_ineligible" ||
    kind === "auth_invalid" ||
    kind === "quota_exhausted"
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function DoctorBackupPanel() {
  const { t } = useI18n();
  const [report, setReport] = useState<SystemDoctorReport | null>(null);
  const [backups, setBackups] = useState<BackupArchiveInfo[]>([]);
  const [serviceInfo, setServiceInfo] = useState<ServiceStatusResponse | null>(null);
  const [reloadState, setReloadState] = useState<SelfReloadState | null>(null);
  const [triggeringReload, setTriggeringReload] = useState(false);
  const [loadingDoctor, setLoadingDoctor] = useState(false);
  const [fixingDoctor, setFixingDoctor] = useState(false);
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [confirmRestoreId, setConfirmRestoreId] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [confirmHotspotPath, setConfirmHotspotPath] = useState<string | null>(null);
  const [spawningHotspot, setSpawningHotspot] = useState(false);
  const [engines, setEngines] = useState<EngineHealthRecord[]>([]);
  const [enginesBusy, setEnginesBusy] = useState(false);
  const [hygiene, setHygiene] = useState<PlaybookHygieneReport | null>(null);
  const [pruningNoisy, setPruningNoisy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoadingDoctor(true);
    setError(null);
    try {
      const [doc, bk, svc, rel, eng, hyg] = await Promise.all([
        api.runDoctor(false),
        api.listBackups(),
        api.getSystemService(20).catch(() => null),
        api.getSelfReloadStatus().catch(() => null),
        api.listEngineHealth().catch(() => null),
        api.getPlaybookHygiene().catch(() => null),
      ]);
      if (eng) setEngines(eng.engines);
      setHygiene(hyg);
      setReport(doc);
      setBackups(bk.backups);
      if (svc) setServiceInfo(svc);
      if (rel) setReloadState(rel.reload);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingDoctor(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const activeNoisyCount = hygiene ? hygiene.noisyEntries.filter((e) => e.enabled).length : 0;

  const handlePruneNoisy = async () => {
    setPruningNoisy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.prunePlaybookHygiene({ mode: "disable" });
      setNotice(t("doctor.playbook.disabledNotice").replace("{n}", String(res.affectedIds.length)));
      setHygiene(await api.getPlaybookHygiene());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPruningNoisy(false);
    }
  };

  const handleFix = async () => {
    setFixingDoctor(true);
    setError(null);
    setNotice(null);
    try {
      const fixedReport = await api.runDoctor(true);
      setReport(fixedReport);
      setNotice(`Applied ${fixedReport.fixesApplied} fix(es).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFixingDoctor(false);
    }
  };

  const handleCreateBackup = async () => {
    setCreatingBackup(true);
    setError(null);
    setNotice(null);
    try {
      const { backup } = await api.createBackup();
      setBackups((prev) => [backup, ...prev.filter((b) => b.id !== backup.id)]);
      setNotice(`Snapshot saved: ${backup.filename}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingBackup(false);
    }
  };

  const handleRestoreBackup = async (backupId: string) => {
    setRestoringId(backupId);
    setError(null);
    setNotice(null);
    try {
      const res = await api.restoreBackup(backupId);
      setConfirmRestoreId(null);
      setNotice(
        `Restored ${res.restoredBackup.filename}${
          res.preRestoreSafetyBackup
            ? ` (safety snapshot: ${res.preRestoreSafetyBackup.filename})`
            : ""
        }`,
      );
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRestoringId(null);
    }
  };

  const handleSpawnRefactor = async (h: CodeHotspotItem) => {
    if (!h.repoId) {
      setError("Missing repoId for hotspot");
      return;
    }
    setSpawningHotspot(true);
    setError(null);
    setNotice(null);
    try {
      const { ticket } = await api.createTicket({
        repoId: h.repoId,
        blueprintId: "safe-refactor",
        title: `Safe-refactor: split ${h.filePath} (${h.lineCount} lines)`,
        description: `Split oversized file ${h.filePath} (${h.lineCount} lines, ${h.exportedSymbolCount} exports, ${h.dependentCount} dependents) into cohesive modules without changing behavior. Keep public exports stable.`,
        allowedPaths: [h.packageDir === "." ? "**" : `${h.packageDir}/**`],
        refactorGuard: {
          targetHotspotPath: h.filePath,
          maxLinesAfter: 1200,
          enforceExportParity: true,
        },
      });
      setConfirmHotspotPath(null);
      setNotice(`${t("doctor.hotspot.created")}: ${ticket.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSpawningHotspot(false);
    }
  };

  const handleTriggerReload = async () => {
    setTriggeringReload(true);
    setError(null);
    setNotice(null);
    try {
      const { reload } = await api.triggerSelfReload();
      setReloadState(reload);
      if (reload.phase === "failed") {
        setError(reload.error ?? reload.summary ?? "Canary reload failed");
      } else {
        setNotice(reload.summary ?? `Reload phase: ${reload.phase}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTriggeringReload(false);
    }
  };

  const hasFixable = Boolean(report?.items.some((i) => i.status !== "ok" && i.fixable));

  const runEngineAction = async (action: () => Promise<unknown>, doneKey: "engines.resetDone" | "engines.reprobed") => {
    setEnginesBusy(true);
    setError(null);
    try {
      await action();
      setEngines((await api.listEngineHealth()).engines);
      setNotice(t(doneKey));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setEnginesBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      {error && (
        <div className="p-3 rounded-lg border border-rose-500/40 bg-rose-500/10 text-rose-200 text-xs">
          {error}
        </div>
      )}
      {notice && (
        <div className="p-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-emerald-200 text-xs">
          {notice}
        </div>
      )}

      {/* Engine Circuit Breaker */}
      <section className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-semibold text-zinc-100">
            <ShieldAlert className="w-4 h-4 text-amber-400" />
            <span>{t("engines.title")}</span>
          </div>
          <button
            type="button"
            disabled={enginesBusy || !engines.some((e) => e.status === "tripped")}
            onClick={() => void runEngineAction(() => api.probeEngineHealth(), "engines.reprobed")}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 text-[11px] disabled:opacity-40"
          >
            <RefreshCw className={`w-3 h-3 ${enginesBusy ? "animate-spin" : ""}`} />
            {t("engines.reprobeBtn")}
          </button>
        </div>
        {engines.length === 0 ? (
          <p className="text-xs text-zinc-400">{t("engines.allHealthy")}</p>
        ) : (
          <ul className="space-y-2">
            {engines.map((e) => (
              <li
                key={e.engine}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs"
              >
                <div className="space-y-0.5 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-zinc-100">{e.engine}</span>
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] border ${
                        e.status === "tripped"
                          ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
                          : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                      }`}
                    >
                      {e.status === "tripped" ? t("engines.statusTripped") : t("engines.statusHealthy")}
                    </span>
                    {e.failureKind && (
                      <span className="text-zinc-400">{t(`engines.kind.${e.failureKind}`)}</span>
                    )}
                    {e.status === "tripped" && isPersistentEngineFailure(e.failureKind) && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] border border-rose-500/40 bg-rose-500/10 text-rose-200">
                        {t("engines.persistentTrip")}
                      </span>
                    )}
                    {e.status === "tripped" && e.failureKind === "transient" && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] border border-sky-500/30 bg-sky-500/10 text-sky-200">
                        {t("engines.transientCooldown")}
                        {e.cooldownUntil ? ` · ${e.cooldownUntil}` : ""}
                      </span>
                    )}
                  </div>
                  <div className="text-zinc-500 truncate">
                    {t("engines.failures")}: {e.consecutiveFailures}
                    {e.cooldownUntil ? ` · ${t("engines.cooldownUntil")} ${e.cooldownUntil}` : ""}
                    {e.reason ? ` · ${e.reason}` : ""}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={enginesBusy}
                  onClick={() => void runEngineAction(() => api.resetEngineHealth(e.engine), "engines.resetDone")}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 text-[11px] disabled:opacity-40"
                >
                  <RotateCcw className="w-3 h-3" />
                  {t("engines.resetBtn")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Playbook Hygiene */}
      <section className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-semibold text-zinc-100">
            <Sparkles className="w-4 h-4 text-violet-400" />
            <span>{t("doctor.playbook.title")}</span>
          </div>
          <button
            type="button"
            onClick={() => void handlePruneNoisy()}
            disabled={pruningNoisy || activeNoisyCount === 0}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-violet-500/40 bg-violet-500/10 hover:bg-violet-500/20 text-violet-200 text-[11px] disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${pruningNoisy ? "animate-spin" : ""}`} />
            {t("doctor.playbook.disableBtn")}
          </button>
        </div>
        {hygiene ? (
          <>
            <div className="flex flex-wrap gap-4 text-xs font-mono text-zinc-300">
              <span>
                {t("doctor.playbook.clean")}: <span className="text-emerald-300">{hygiene.healthy}</span>
              </span>
              <span>
                {t("doctor.playbook.noisy")}:{" "}
                <span className={activeNoisyCount > 0 ? "text-amber-300" : "text-zinc-400"}>
                  {activeNoisyCount}
                </span>
              </span>
              <span className="text-zinc-500">
                {t("doctor.playbook.total")}: {hygiene.total}
              </span>
            </div>
            {activeNoisyCount === 0 ? (
              <div className="text-[11px] text-zinc-500">{t("doctor.playbook.allClean")}</div>
            ) : (
              <ul className="space-y-1 text-[11px] text-zinc-400 max-h-32 overflow-y-auto">
                {hygiene.noisyEntries
                  .filter((e) => e.enabled)
                  .slice(0, 5)
                  .map((e) => (
                    <li key={e.id} className="truncate" title={e.reasons.join("; ")}>
                      {e.rule}
                    </li>
                  ))}
              </ul>
            )}
          </>
        ) : (
          <div className="text-[11px] text-zinc-500">{t("doctor.playbook.unavailable")}</div>
        )}
      </section>

      {/* System Doctor */}
      <section className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-semibold text-zinc-100">
            <Stethoscope className="w-4 h-4 text-emerald-400" />
            <span>{t("doctor.title")}</span>
            {report && (
              <span
                className={`px-2 py-0.5 rounded-full text-[10px] font-mono border ${
                  report.healthy
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                    : "border-amber-500/40 bg-amber-500/10 text-amber-200"
                }`}
              >
                {report.healthy ? t("doctor.healthy") : t("doctor.issuesFound")}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void loadAll()}
              disabled={loadingDoctor}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 text-[11px] disabled:opacity-50"
            >
              <RefreshCw className={`w-3 h-3 ${loadingDoctor ? "animate-spin" : ""}`} />
              {t("doctor.runBtn")}
            </button>
            <button
              type="button"
              onClick={() => void handleFix()}
              disabled={fixingDoctor || !hasFixable}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-[11px] font-medium disabled:opacity-40"
            >
              <Sparkles className="w-3 h-3" />
              {t("doctor.fixBtn")}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {(report?.items ?? []).map((item) => {
            const tone =
              item.status === "ok"
                ? "border-emerald-500/25 bg-emerald-500/5"
                : item.status === "warn"
                  ? "border-amber-500/35 bg-amber-500/10"
                  : "border-rose-500/40 bg-rose-500/10";
            return (
              <div key={item.id} className={`rounded-lg border p-3 space-y-1 text-xs ${tone}`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 font-medium text-zinc-100">
                    {item.status === "ok" ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    ) : item.status === "warn" ? (
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    ) : (
                      <ShieldAlert className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                    )}
                    <span>{item.title}</span>
                  </div>
                  <span className="px-1.5 py-0.5 rounded bg-zinc-950 border border-zinc-800 font-mono text-[10px] text-zinc-400">
                    {item.category}
                  </span>
                </div>
                <p className="text-[11px] text-zinc-400 leading-relaxed">{item.detail}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Codebase Hotspot Radar */}
      {(report?.hotspots?.length ?? 0) > 0 && (
        <section className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
          <div className="flex items-center gap-2 font-semibold text-zinc-100">
            <AlertTriangle className="w-4 h-4 text-amber-400" />
            <span>{t("doctor.hotspot.title")}</span>
          </div>
          <p className="text-[11px] text-zinc-400">{t("doctor.hotspot.subtitle")}</p>
          <div className="space-y-2">
            {report!.hotspots!.map((h) => (
              <div
                key={`${h.repoId ?? ""}:${h.filePath}`}
                className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs space-y-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-mono text-zinc-100 truncate">{h.filePath}</div>
                    <div className="text-[11px] text-zinc-400">
                      {h.lineCount} {t("doctor.hotspot.lines")} · {h.exportedSymbolCount}{" "}
                      {t("doctor.hotspot.symbols")} · {h.dependentCount} {t("doctor.hotspot.dependents")}
                    </div>
                    <div className="text-[11px] text-amber-300/80">{t("doctor.hotspot.targetHint")}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setConfirmHotspotPath(h.filePath)}
                    disabled={spawningHotspot || !h.repoId}
                    className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-[11px] font-medium disabled:opacity-40"
                  >
                    {t("doctor.hotspot.spawn")}
                  </button>
                </div>
                {confirmHotspotPath === h.filePath && (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-amber-100">
                    <span>{t("doctor.hotspot.confirmBanner")}</span>
                    <span className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => void handleSpawnRefactor(h)}
                        disabled={spawningHotspot}
                        className="px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white disabled:opacity-40"
                      >
                        {t("doctor.hotspot.confirm")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmHotspotPath(null)}
                        className="px-2.5 py-1 rounded border border-zinc-700 text-zinc-200 hover:bg-zinc-800"
                      >
                        {t("doctor.hotspot.cancel")}
                      </button>
                    </span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* SQLite Hot Backups */}
      <section className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-semibold text-zinc-100">
            <Database className="w-4 h-4 text-sky-400" />
            <span>{t("doctor.backupTitle")}</span>
          </div>
          <button
            type="button"
            onClick={() => void handleCreateBackup()}
            disabled={creatingBackup}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-medium disabled:opacity-50"
          >
            <HardDriveDownload className="w-3.5 h-3.5" />
            {t("doctor.backupBtn")}
          </button>
        </div>

        {backups.length === 0 ? (
          <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/50 p-3 text-[11px] text-zinc-500">
            {t("doctor.emptyBackups")}
          </div>
        ) : (
          <div className="space-y-2 max-h-52 overflow-y-auto">
            {backups.map((b) => (
              <div
                key={b.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-[11px]"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-medium text-zinc-100 truncate">{b.filename}</span>
                    {b.dbIntegrityOk !== false && (
                      <span className="px-1.5 py-0.2 rounded bg-emerald-500/15 text-emerald-300 font-mono text-[10px]">
                        integrity OK
                      </span>
                    )}
                  </div>
                  <div className="font-mono text-[10px] text-zinc-500 truncate">{b.filePath}</div>
                </div>
                <div className="flex items-center gap-2.5 shrink-0">
                  <div className="text-right font-mono text-[10px] text-zinc-400">
                    <div>{formatBytes(b.byteSize)}</div>
                    <div>{new Date(b.createdAt).toLocaleString()}</div>
                  </div>
                  {confirmRestoreId === b.id ? (
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] text-amber-200 max-w-44">
                        {t("doctor.restoreConfirm")}
                      </span>
                      <button
                        type="button"
                        disabled={restoringId === b.id}
                        onClick={() => void handleRestoreBackup(b.id)}
                        className="px-2 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white text-[10px] font-medium disabled:opacity-50"
                      >
                        {t("cmd.confirmRun")}
                      </button>
                      <button
                        type="button"
                        disabled={restoringId === b.id}
                        onClick={() => setConfirmRestoreId(null)}
                        className="px-2 py-1 rounded border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-[10px]"
                      >
                        ×
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={restoringId !== null}
                      onClick={() => setConfirmRestoreId(b.id)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded border border-amber-500/35 bg-amber-500/10 hover:bg-amber-500/20 text-amber-200 text-[10px] font-medium disabled:opacity-40 transition"
                    >
                      <RotateCcw className="w-3 h-3" />
                      {t("doctor.restoreBtn")}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3.5 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-sky-400" />
            <h4 className="text-xs font-semibold text-zinc-100">{t("service.title")}</h4>
            {serviceInfo && (
              <span
                className={`px-2 py-0.5 rounded-full text-[10px] font-mono border ${
                  serviceInfo.status.running
                    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                    : "bg-zinc-800 text-zinc-400 border-zinc-700"
                }`}
              >
                {serviceInfo.status.manager} ·{" "}
                {serviceInfo.status.running ? "running" : serviceInfo.status.installed ? "stopped" : "not installed"}
              </span>
            )}
          </div>
          {serviceInfo && (
            <span className="font-mono text-[10px] text-zinc-400">
              {serviceInfo.status.host}:{serviceInfo.status.port}
            </span>
          )}
        </div>
        {serviceInfo && (
          <div className="text-[11px] font-mono text-zinc-400 space-y-0.5">
            <div>{serviceInfo.status.detail}</div>
            <div className="text-[10px] text-zinc-500 truncate">
              dataDir: {serviceInfo.status.dataDir} · webUI: {serviceInfo.status.webUiBuilt ? "built" : "dev-only"}
            </div>
          </div>
        )}
        <p className="text-[10px] font-mono text-zinc-500">{t("service.installHint")}</p>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3.5 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <RefreshCw className="w-4 h-4 text-indigo-400" />
            <h4 className="text-xs font-semibold text-zinc-100">{t("selfHost.title")}</h4>
            {reloadState && (
              <span
                className={`px-2 py-0.5 rounded-full text-[10px] font-mono border ${
                  reloadState.phase === "rolled_back" || reloadState.phase === "failed"
                    ? "bg-rose-500/15 text-rose-300 border-rose-500/35"
                    : reloadState.phase === "idle"
                      ? "bg-zinc-800 text-zinc-300 border-zinc-700"
                      : "bg-amber-500/15 text-amber-200 border-amber-500/35"
                }`}
              >
                {t(`selfHost.phase.${reloadState.phase}` as Parameters<typeof t>[0])}
              </span>
            )}
          </div>
          <button
            type="button"
            disabled={triggeringReload || !reloadState?.selfRepoRoot}
            onClick={() => void handleTriggerReload()}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-indigo-500/40 bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-200 text-[11px] font-medium disabled:opacity-40 transition"
          >
            <RefreshCw className={`w-3 h-3 ${triggeringReload ? "animate-spin" : ""}`} />
            {triggeringReload ? t("selfHost.reloadingBtn") : t("selfHost.reloadBtn")}
          </button>
        </div>
        <p className="text-[11px] text-zinc-400">{t("selfHost.desc")}</p>
        {reloadState?.summary && (
          <div className="text-[10px] font-mono text-zinc-300 bg-zinc-950/70 border border-zinc-800 rounded px-2.5 py-1.5">
            {reloadState.summary}
          </div>
        )}
      </section>
    </div>
  );
}
