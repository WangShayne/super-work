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
  SelfReloadState,
  ServiceStatusResponse,
  SystemDoctorReport,
} from "../types.ts";

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
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoadingDoctor(true);
    setError(null);
    try {
      const [doc, bk, svc, rel] = await Promise.all([
        api.runDoctor(false),
        api.listBackups(),
        api.getSystemService(20).catch(() => null),
        api.getSelfReloadStatus().catch(() => null),
      ]);
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
