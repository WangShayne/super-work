import { useEffect, useRef, useState } from "react";
import { Loader2, ScanSearch, X } from "lucide-react";
import { api } from "../api.ts";
import { useI18n, type TranslationKey } from "../i18n.tsx";
import type { AutonomyPreset, RepoAutoDetectResult } from "../types.ts";
import { AUTONOMY_PRESETS, normalizeAutonomyPreset } from "../utils/superAgent.ts";

function useEscapeKey(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);
}

interface AddRepoModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: {
    name: string;
    rootPath: string;
    baseBranch: string;
    githubRepo?: string;
    autonomyPreset: AutonomyPreset;
  }) => Promise<void>;
}

const FIELD =
  "w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100 focus:outline-none focus:border-indigo-500";

export function AddRepoModal({ open, onClose, onSubmit }: AddRepoModalProps) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [githubRepo, setGithubRepo] = useState("");
  const [preset, setPreset] = useState<AutonomyPreset>("smart");
  const [detected, setDetected] = useState<RepoAutoDetectResult | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Fields the user edited by hand are never overwritten by auto-detect.
  const touched = useRef({ name: false, baseBranch: false });
  const detectSeq = useRef(0);
  const lastDetectedPath = useRef("");

  useEscapeKey(open, onClose);

  useEffect(() => {
    if (!open) return;
    setName("");
    setRootPath("");
    setBaseBranch("main");
    setGithubRepo("");
    setPreset("smart");
    setDetected(null);
    setError("");
    touched.current = { name: false, baseBranch: false };
    lastDetectedPath.current = "";
  }, [open]);

  if (!open) return null;

  const detect = async () => {
    const path = rootPath.trim();
    if (!path) return;
    const seq = ++detectSeq.current;
    lastDetectedPath.current = path;
    setDetecting(true);
    setError("");
    try {
      const res = await api.detectRepo(path);
      if (seq !== detectSeq.current) return;
      setDetected(res);
      if (!touched.current.name) setName(res.name);
      if (!touched.current.baseBranch) setBaseBranch(res.baseBranch);
      setPreset(normalizeAutonomyPreset(res.autonomyPreset) ?? "smart");
    } catch (err) {
      if (seq !== detectSeq.current) return;
      setDetected(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === detectSeq.current) setDetecting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !rootPath.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      await onSubmit({
        name: name.trim(),
        rootPath: rootPath.trim(),
        baseBranch: baseBranch.trim() || "main",
        githubRepo: githubRepo.trim() || undefined,
        autonomyPreset: preset,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4"
    >
      <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 p-5 space-y-4 shadow-2xl">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-100">{t("modal.repo.title")}</h3>
          <button type="button" onClick={onClose} aria-label={t("modal.repo.cancel")} className="text-zinc-500 hover:text-zinc-200">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3 text-xs">
          <div>
            <label className="block text-zinc-400 mb-1">{t("modal.repo.path")}</label>
            <div className="flex gap-2">
              <input
                required
                value={rootPath}
                onChange={(e) => setRootPath(e.target.value)}
                onBlur={() => {
                  const path = rootPath.trim();
                  if (path && path !== lastDetectedPath.current) void detect();
                }}
                placeholder={t("modal.repo.pathPlaceholder")}
                className={`${FIELD} font-mono`}
              />
              <button
                type="button"
                disabled={detecting || !rootPath.trim()}
                onClick={() => void detect()}
                className="shrink-0 inline-flex items-center gap-1.5 px-3 rounded-lg border border-indigo-500/35 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-200 disabled:opacity-40"
              >
                {detecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ScanSearch className="w-3.5 h-3.5" />}
                {t("modal.repo.detect")}
              </button>
            </div>
            {detected && (
              <div className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-200 text-[11px]">
                {detected.stackLabel} · {detected.verificationCommands.length} {t("modal.repo.detectChecks")}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-zinc-400 mb-1">{t("modal.repo.name")}</label>
              <input
                required
                value={name}
                onChange={(e) => {
                  touched.current.name = true;
                  setName(e.target.value);
                }}
                placeholder={t("modal.repo.namePlaceholder")}
                className={FIELD}
              />
            </div>
            <div>
              <label className="block text-zinc-400 mb-1">{t("modal.repo.baseBranch")}</label>
              <input
                value={baseBranch}
                onChange={(e) => {
                  touched.current.baseBranch = true;
                  setBaseBranch(e.target.value);
                }}
                className={`${FIELD} font-mono`}
              />
            </div>
          </div>

          <div>
            <label className="block text-zinc-400 mb-1">{t("header.presetLabel")}</label>
            <div role="group" className="grid grid-cols-3 gap-1.5">
              {AUTONOMY_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={preset === p}
                  title={t(`preset.${p}Desc` as TranslationKey)}
                  onClick={() => setPreset(p)}
                  className={`px-2 py-1.5 rounded-lg border text-[11px] font-medium transition ${
                    preset === p
                      ? "border-indigo-500/50 bg-indigo-500/20 text-indigo-100"
                      : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {t(`preset.${p}` as TranslationKey)}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-zinc-400 mb-1">{t("modal.repo.githubRepo")}</label>
            <input
              value={githubRepo}
              onChange={(e) => setGithubRepo(e.target.value)}
              placeholder={t("modal.repo.githubPlaceholder")}
              className={`${FIELD} font-mono`}
            />
          </div>

          {error && <div className="text-rose-400 break-words">{error}</div>}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg border border-zinc-800 text-zinc-400 hover:text-zinc-200"
            >
              {t("modal.repo.cancel")}
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium disabled:opacity-50"
            >
              {t("modal.repo.submit")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
