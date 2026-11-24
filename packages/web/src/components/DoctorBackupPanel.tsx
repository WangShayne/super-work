import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  HardDriveDownload,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Stethoscope,
} from "lucide-react";
import { useI18n } from "../i18n.tsx";
import { api } from "../api.ts";
import type { BackupArchiveInfo, SystemDoctorReport } from "../types.ts";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function DoctorBackupPanel() {
  const { t } = useI18n();
  const [report, setReport] = useState<SystemDoctorReport | null>(null);
  const [backups, setBackups] = useState<BackupArchiveInfo[]>([]);
  const [loadingDoctor, setLoadingDoctor] = useState(false);
  const [fixingDoctor, setFixingDoctor] = useState(false);
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoadingDoctor(true);
    setError(null);
    try {
      const [doc, bk] = await Promise.all([api.runDoctor(false), api.listBackups()]);
      setReport(doc);
      setBackups(bk.backups);
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
                <div className="text-right font-mono text-[10px] text-zinc-400 shrink-0">
                  <div>{formatBytes(b.byteSize)}</div>
                  <div>{new Date(b.createdAt).toLocaleString()}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
