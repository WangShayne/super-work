import { Suspense, lazy, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, RefreshCw, Rocket, Wrench, X } from "lucide-react";
import { api } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import type { CliScanReport, PublicSetupStatus, WorkerEngineId } from "../types.ts";

const CustomizeSetupForm = lazy(() =>
  import("./setup/CustomizeSetupForm.tsx").then((m) => ({ default: m.CustomizeSetupForm })),
);

interface SetupWizardModalProps {
  open: boolean;
  setupStatus: PublicSetupStatus | null;
  availableEngines: WorkerEngineId[];
  onClose: () => void;
  onSaved: (next: PublicSetupStatus) => Promise<void>;
}

function toolMark(tool: CliScanReport["tools"][number]): { glyph: string; cls: string } {
  if (!tool.installed) return { glyph: "—", cls: "border-zinc-800 bg-zinc-900 text-zinc-500" };
  if (tool.authenticated === true) return { glyph: "✓", cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" };
  if (tool.authenticated === false) return { glyph: "!", cls: "border-amber-500/30 bg-amber-500/10 text-amber-300" };
  return { glyph: "✓", cls: "border-sky-500/30 bg-sky-500/10 text-sky-300" };
}

export function SetupWizardModal({ open, setupStatus, availableEngines, onClose, onSaved }: SetupWizardModalProps) {
  const { t } = useI18n();
  const [scanReport, setScanReport] = useState<CliScanReport | null>(null);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setCustomizeOpen(false);
    setError("");
    setScanReport(setupStatus?.scanReport ?? null);
  }, [open, setupStatus?.scanReport]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open || !setupStatus) return null;

  const isFirstRun = !setupStatus.initialized;
  const tools = scanReport?.tools ?? [];
  const readyTools = tools.filter((tool) => tool.installed && tool.authenticated === true);
  const brain = readyTools.find((x) => x.id === "claude")
    ? "Claude CLI"
    : readyTools.find((x) => x.id === "codex")
      ? "Codex CLI"
      : t("setup.preset.heuristic.title");

  const run = async (setBusy: (v: boolean) => void, fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const quickStart = () =>
    run(setStarting, async () => {
      const next = await api.quickStartSetup();
      await onSaved(next);
      onClose();
    });

  const rescan = () =>
    run(setScanning, async () => {
      const res = await api.scanCliEnvironment();
      setScanReport(res.scanReport);
    });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs p-4 overflow-y-auto">
      <div className="w-full max-w-2xl rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl overflow-hidden my-4">
        <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/40">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <Wrench className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">
                {isFirstRun ? t("setup.title") : t("setup.settingsTitle")}
              </h2>
              <p className="text-[11px] font-mono text-zinc-500">
                {t("header.controlPlanePrefix")}: {setupStatus.activeLlmProvider}
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label={t("setup.later")} className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-200">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-5 max-h-[80vh] overflow-y-auto text-xs">
          {/* Zero-config card */}
          <section className="rounded-2xl border border-indigo-500/30 bg-indigo-500/5 p-5 space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-zinc-100">{t("setup.zero.title")}</h3>
              <p className="text-[11px] text-zinc-400 mt-1 leading-relaxed">{t("setup.zero.desc")}</p>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[11px] text-zinc-400">{t("setup.zero.detected")}</span>
                <button
                  type="button"
                  onClick={() => void rescan()}
                  disabled={scanning}
                  className="inline-flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
                >
                  <RefreshCw className={`w-3 h-3 ${scanning ? "animate-spin" : ""}`} />
                  {scanning ? t("setup.scanning") : t("setup.rescan")}
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {tools.map((tool) => {
                  const mark = toolMark(tool);
                  return (
                    <span key={tool.id} className={`px-2.5 py-1 rounded-lg border font-mono text-[11px] ${mark.cls}`}>
                      {tool.id} {mark.glyph}
                    </span>
                  );
                })}
              </div>
            </div>

            <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3.5 py-2.5 text-[11px] text-zinc-300 space-y-0.5">
              <div className="text-zinc-400">{t("setup.zero.recommended")}</div>
              <div className="font-mono">
                {t("setup.zero.brain")}: <span className="text-indigo-300">{brain}</span>
              </div>
              <div className="font-mono">
                {t("setup.defaultImplEngine")}:{" "}
                <span className="text-indigo-300">{scanReport?.recommendedImplementEngine ?? "claude"}</span>
                {" · "}
                {t("setup.defaultReviewEngine")}:{" "}
                <span className="text-indigo-300">{scanReport?.recommendedReviewEngine ?? "codex"}</span>
              </div>
            </div>

            {error && <div className="text-rose-400 break-words">{error}</div>}

            <button
              type="button"
              onClick={() => void quickStart()}
              disabled={starting}
              className="w-full inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold disabled:opacity-60 transition"
            >
              {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Rocket className="w-4 h-4" />}
              {t("setup.zero.start")}
            </button>
          </section>

          {/* Manual customization accordion */}
          <section>
            <button
              type="button"
              onClick={() => setCustomizeOpen((v) => !v)}
              aria-expanded={customizeOpen}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-300 hover:text-zinc-100"
            >
              {customizeOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              {t("setup.zero.customize")} ▾
            </button>
            {customizeOpen && (
              <div className="mt-4">
                <Suspense fallback={<div className="py-6 text-center text-zinc-500">…</div>}>
                  <CustomizeSetupForm
                    setupStatus={setupStatus}
                    availableEngines={availableEngines}
                    onClose={onClose}
                    onSaved={onSaved}
                  />
                </Suspense>
              </div>
            )}
          </section>
        </div>

        <div className="px-6 py-3 border-t border-zinc-800 bg-zinc-900/40 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-2 rounded-lg border border-zinc-800 text-zinc-400 hover:text-zinc-200 text-xs"
          >
            {t("setup.later")}
          </button>
        </div>
      </div>
    </div>
  );
}
