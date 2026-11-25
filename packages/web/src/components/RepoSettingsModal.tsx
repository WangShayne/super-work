import { useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BookOpen,
  ChevronDown,
  ChevronUp,
  Database,
  Download,
  ExternalLink,
  Eye,
  FileJson2,
  FolderGit2,
  GitBranch,
  Layers,
  Pin,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import { api } from "../api.ts";
import { formatTemplate, formatTicketStatus, useI18n } from "../i18n.tsx";
import type {
  BrowserInteractionStep,
  CasebookEntry,
  DeliveryChannel,
  DeliveryGatePolicy,
  EnginePreference,
  EpicDecompositionPlan,
  EpicDeliveryMode,
  EpicSubtaskSpec,
  LifecycleHooksConfig,
  ManagedWorktreeItem,
  OperatingMode,
  PipelineTemplateId,
  PlaybookEntry,
  PreviewSession,
  ReasoningEffort,
  RepoConfig,
  RepoKnowledgeBundle,
  SandboxMode,
  SmokeCheckConfig,
  SmokeTriggerMode,
  SpecClarificationResult,
  TaskBlueprint,
  Ticket,
  VerificationStrategy,
  VisualDiffMode,
  WorkerEngineId,
  WorktreeGcResult,
} from "../types.ts";


function useEscapeKey(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);
}

interface RepoSettingsModalProps {
  open: boolean;
  repo: RepoConfig | null;
  initialTab?: SettingsTab;
  availableEngines: WorkerEngineId[];
  onClose: () => void;
  onRefresh?: () => void;
  onSubmit: (
    repoId: string,
    patch: Omit<
      Partial<RepoConfig>,
      | "maxConcurrentWorkers"
      | "dailyBudgetUsd"
      | "conventions"
      | "smokeCheck"
      | "fallbackEngines"
      | "previewCommand"
      | "sandboxMode"
      | "deliveryGatePolicy"
      | "riskThreshold"
      | "sensitivePaths"
      | "blueprints"
      | "hooks"
    > & {
      maxConcurrentWorkers?: number | null;
      dailyBudgetUsd?: number | null;
      conventions?: string | null;
      smokeCheck?: SmokeCheckConfig | null;
      fallbackEngines?: WorkerEngineId[] | null;
      previewCommand?: string | null;
      sandboxMode?: SandboxMode | null;
      deliveryGatePolicy?: DeliveryGatePolicy | null;
      riskThreshold?: number | null;
      sensitivePaths?: string[] | null;
      blueprints?: TaskBlueprint[] | null;
      hooks?: LifecycleHooksConfig | null;
    },
  ) => Promise<void>;
}

type SettingsTab = "runtime" | "contract" | "playbook" | "casebook";

export function RepoSettingsModal({
  open,
  repo,
  initialTab = "runtime",
  availableEngines,
  onClose,
  onRefresh,
  onSubmit,
}: RepoSettingsModalProps) {
  const { locale, t } = useI18n();
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(initialTab);
  const [name, setName] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [githubRepo, setGithubRepo] = useState("");
  const [mode, setMode] = useState<OperatingMode>("observe");
  const [defaultTemplate, setDefaultTemplate] = useState<PipelineTemplateId>("standard");
  const [defaultTddMode, setDefaultTddMode] = useState(false);
  const [deliveryGatePolicy, setDeliveryGatePolicy] = useState<DeliveryGatePolicy>("always_auto");
  const [riskThresholdInput, setRiskThresholdInput] = useState("35");
  const [sensitivePathsInput, setSensitivePathsInput] = useState("");
  const [implEngine, setImplEngine] = useState<EnginePreference>("claude");
  const [reviewEngine, setReviewEngine] = useState<WorkerEngineId>("codex");
  const [fallbackEngines, setFallbackEngines] = useState<WorkerEngineId[]>([]);
  const [sandboxMode, setSandboxMode] = useState<SandboxMode>("balanced");
  const [verificationStrategy, setVerificationStrategy] =
    useState<VerificationStrategy>("always_full");
  const [deliveryChannel, setDeliveryChannel] = useState<DeliveryChannel>("auto_pr_or_branch");
  const [verificationInput, setVerificationInput] = useState("");
  const [setupInput, setSetupInput] = useState("");
  const [forbiddenInput, setForbiddenInput] = useState("");
  const [conventions, setConventions] = useState("");
  const [previewCommand, setPreviewCommand] = useState("");
  const [preDeliverHooksInput, setPreDeliverHooksInput] = useState("");
  const [postDeliverHooksInput, setPostDeliverHooksInput] = useState("");
  const [onEscalateHooksInput, setOnEscalateHooksInput] = useState("");
  const [hookTimeoutInput, setHookTimeoutInput] = useState("60");
  const [smokeEnabled, setSmokeEnabled] = useState(false);
  const [smokeStartCmd, setSmokeStartCmd] = useState("");
  const [smokeReadyUrl, setSmokeReadyUrl] = useState("");
  const [smokeTimeoutSec, setSmokeTimeoutSec] = useState("20");
  const [smokeTriggerMode, setSmokeTriggerMode] = useState<SmokeTriggerMode>("every_gate");
  const [smokeCheckCmds, setSmokeCheckCmds] = useState("");
  const [browserEnabled, setBrowserEnabled] = useState(false);
  const [browserPaths, setBrowserPaths] = useState("/");
  const [browserSelector, setBrowserSelector] = useState("");
  const [browserFailConsole, setBrowserFailConsole] = useState(false);
  const [visualDiffMode, setVisualDiffMode] = useState<VisualDiffMode>("auto");
  const [maxVisualDiffRatio, setMaxVisualDiffRatio] = useState("0.02");
  const [browserStepsText, setBrowserStepsText] = useState("");
  const [maxConcurrentInput, setMaxConcurrentInput] = useState("");
  const [dailyBudgetInput, setDailyBudgetInput] = useState("");
  const [autoCleanupWorktree, setAutoCleanupWorktree] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [contractNotice, setContractNotice] = useState<string | null>(null);
  const [syncingContract, setSyncingContract] = useState(false);

  const [playbook, setPlaybook] = useState<PlaybookEntry[]>([]);
  const [playbookLoading, setPlaybookLoading] = useState(false);
  const [pruningPlaybook, setPruningPlaybook] = useState(false);
  const [pruneNotice, setPruneNotice] = useState<string | null>(null);
  const [newRule, setNewRule] = useState("");
  const [newRuleScope, setNewRuleScope] = useState("");
  const [newRulePinned, setNewRulePinned] = useState(false);

  const [casebook, setCasebook] = useState<CasebookEntry[]>([]);
  const [casebookLoading, setCasebookLoading] = useState(false);
  const [casebookQuery, setCasebookQuery] = useState("");
  const [bundleBusy, setBundleBusy] = useState(false);
  const [bundleNotice, setBundleNotice] = useState<string | null>(null);
  const bundleInputRef = useRef<HTMLInputElement | null>(null);

  const loadPlaybook = async (repoId: string) => {
    setPlaybookLoading(true);
    try {
      const res = await api.listPlaybook(repoId);
      setPlaybook(res.entries);
    } finally {
      setPlaybookLoading(false);
    }
  };

  const loadCasebook = async (repoId: string, q?: string) => {
    setCasebookLoading(true);
    try {
      const res = await api.listCasebook(repoId, q);
      setCasebook(res.entries);
    } finally {
      setCasebookLoading(false);
    }
  };

  useEffect(() => {
    if (!open || !repo) return;
    setSettingsTab(initialTab);
    setContractNotice(null);
    setPruneNotice(null);
    setCasebookQuery("");
    setName(repo.name);
    setBaseBranch(repo.baseBranch);
    setGithubRepo(repo.githubRepo ?? "");
    setMode(repo.mode);
    setDefaultTemplate(repo.defaultTemplate);
    setDefaultTddMode(Boolean(repo.defaultTddMode));
    setDeliveryGatePolicy(repo.deliveryGatePolicy ?? "always_auto");
    setRiskThresholdInput(repo.riskThreshold !== undefined ? String(repo.riskThreshold) : "35");
    setSensitivePathsInput((repo.sensitivePaths ?? []).join(", "));
    setImplEngine(repo.preferredImplementEngine);
    setReviewEngine(repo.preferredReviewEngine);
    setFallbackEngines(repo.fallbackEngines ?? []);
    setSandboxMode(repo.sandboxMode ?? "balanced");
    setVerificationStrategy(repo.verificationStrategy ?? "always_full");
    setDeliveryChannel(repo.defaultDeliveryChannel ?? "auto_pr_or_branch");
    setVerificationInput((repo.verificationCommands ?? []).join("\n"));
    setSetupInput((repo.setupCommands ?? []).join("\n"));
    setForbiddenInput((repo.forbiddenPaths ?? []).join(", "));
    setConventions(repo.conventions ?? "");
    setPreviewCommand(repo.previewCommand ?? "");
    setPreDeliverHooksInput((repo.hooks?.preDeliver ?? []).join("\n"));
    setPostDeliverHooksInput((repo.hooks?.postDeliver ?? []).join("\n"));
    setOnEscalateHooksInput((repo.hooks?.onEscalate ?? []).join("\n"));
    setHookTimeoutInput(String(repo.hooks?.timeoutSec ?? 60));
    setSmokeEnabled(Boolean(repo.smokeCheck?.enabled));
    setSmokeStartCmd(repo.smokeCheck?.startCommand ?? "");
    setSmokeReadyUrl(repo.smokeCheck?.readyUrl ?? "");
    setSmokeTimeoutSec(String(repo.smokeCheck?.startupTimeoutSec ?? 20));
    setSmokeTriggerMode(repo.smokeCheck?.triggerMode ?? "every_gate");
    setSmokeCheckCmds((repo.smokeCheck?.checkCommands ?? []).join("\n"));
    setBrowserEnabled(Boolean(repo.smokeCheck?.browserCheck?.enabled));
    setBrowserPaths((repo.smokeCheck?.browserCheck?.paths ?? ["/"]).join(", "));
    setBrowserSelector(repo.smokeCheck?.browserCheck?.waitForSelector ?? "");
    setBrowserFailConsole(Boolean(repo.smokeCheck?.browserCheck?.failOnConsoleError));
    setVisualDiffMode(repo.smokeCheck?.browserCheck?.visualDiffMode ?? "auto");
    setMaxVisualDiffRatio(
      repo.smokeCheck?.browserCheck?.maxVisualDiffRatio !== undefined
        ? String(repo.smokeCheck.browserCheck.maxVisualDiffRatio)
        : "0.02",
    );
    setBrowserStepsText(
      repo.smokeCheck?.browserCheck?.steps?.length
        ? JSON.stringify(repo.smokeCheck.browserCheck.steps)
        : "",
    );
    setMaxConcurrentInput(
      repo.maxConcurrentWorkers ? String(repo.maxConcurrentWorkers) : "",
    );
    setDailyBudgetInput(repo.dailyBudgetUsd ? String(repo.dailyBudgetUsd) : "");
    setAutoCleanupWorktree(repo.autoCleanupWorktree !== false);
    void loadPlaybook(repo.id);
    void loadCasebook(repo.id);
  }, [open, repo, initialTab]);

  useEscapeKey(open, onClose);

  if (!open || !repo) return null;

  const engineOptions = Array.from(
    new Set<WorkerEngineId>([
      ...availableEngines,
      ...(repo.preferredImplementEngine !== "auto" ? [repo.preferredImplementEngine] : []),
      repo.preferredReviewEngine,
      "mock",
    ]),
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      const verificationCommands = verificationInput
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const setupCommands = setupInput
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const forbiddenPaths = forbiddenInput
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const parsedMaxConcurrent = Number(maxConcurrentInput.trim());
      const parsedDailyBudget = Number(dailyBudgetInput.trim());
      const parsedCheckCmds = smokeCheckCmds
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const parsedTimeout = Number(smokeTimeoutSec.trim());
      const parsedBrowserPaths = browserPaths
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const parsedVisualRatio = Number(maxVisualDiffRatio.trim());
      let parsedSteps: BrowserInteractionStep[] | undefined;
      if (browserStepsText.trim()) {
        try {
          const rawParsed = JSON.parse(browserStepsText.trim());
          if (Array.isArray(rawParsed)) {
            parsedSteps = rawParsed.filter(
              (item): item is BrowserInteractionStep =>
                Boolean(item) && typeof item === "object" && typeof item.action === "string",
            );
          }
        } catch {
          // ignore malformed optional JSON during save
        }
      }
      const smokeCheckPayload: SmokeCheckConfig | null =
        smokeStartCmd.trim() || smokeEnabled
          ? {
              enabled: smokeEnabled && Boolean(smokeStartCmd.trim()),
              startCommand: smokeStartCmd.trim(),
              readyUrl: smokeReadyUrl.trim() || undefined,
              startupTimeoutSec:
                Number.isFinite(parsedTimeout) && parsedTimeout > 0
                  ? Math.max(2, Math.min(120, Math.floor(parsedTimeout)))
                  : 20,
              checkCommands: parsedCheckCmds.length > 0 ? parsedCheckCmds : undefined,
              triggerMode: smokeTriggerMode,
              ...(browserEnabled
                ? {
                    browserCheck: {
                      enabled: true,
                      paths: parsedBrowserPaths.length > 0 ? parsedBrowserPaths : ["/"],
                      waitForSelector: browserSelector.trim() || undefined,
                      failOnConsoleError: browserFailConsole,
                      visualDiffMode,
                      maxVisualDiffRatio:
                        Number.isFinite(parsedVisualRatio) &&
                        parsedVisualRatio >= 0 &&
                        parsedVisualRatio <= 1
                          ? parsedVisualRatio
                          : undefined,
                      steps: parsedSteps && parsedSteps.length > 0 ? parsedSteps : undefined,
                    },
                  }
                : {}),
            }
          : null;
      const parsedThreshold = Number(riskThresholdInput.trim());
      const parsedSensitivePaths = sensitivePathsInput
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
      await onSubmit(repo.id, {
        name: name.trim(),
        baseBranch: baseBranch.trim() || "main",
        githubRepo: githubRepo.trim(),
        mode,
        defaultTemplate,
        defaultTddMode,
        deliveryGatePolicy,
        riskThreshold:
          riskThresholdInput.trim() && Number.isFinite(parsedThreshold)
            ? Math.max(0, Math.min(100, Math.round(parsedThreshold)))
            : null,
        sensitivePaths: parsedSensitivePaths.length > 0 ? parsedSensitivePaths : null,
        preferredImplementEngine: implEngine,
        preferredReviewEngine: reviewEngine,
        fallbackEngines: fallbackEngines.length > 0 ? fallbackEngines : null,
        sandboxMode,
        verificationStrategy,
        defaultDeliveryChannel: deliveryChannel,
        verificationCommands,
        setupCommands,
        forbiddenPaths,
        conventions: conventions.trim() || null,
        previewCommand: previewCommand.trim() || null,
        hooks: (() => {
          const preDeliver = preDeliverHooksInput.split("\n").map((s) => s.trim()).filter(Boolean);
          const postDeliver = postDeliverHooksInput.split("\n").map((s) => s.trim()).filter(Boolean);
          const onEscalate = onEscalateHooksInput.split("\n").map((s) => s.trim()).filter(Boolean);
          const parsedHookTimeout = Number(hookTimeoutInput.trim());
          if (preDeliver.length === 0 && postDeliver.length === 0 && onEscalate.length === 0) {
            return null;
          }
          return {
            ...(preDeliver.length > 0 ? { preDeliver } : {}),
            ...(postDeliver.length > 0 ? { postDeliver } : {}),
            ...(onEscalate.length > 0 ? { onEscalate } : {}),
            timeoutSec:
              Number.isFinite(parsedHookTimeout) && parsedHookTimeout > 0
                ? Math.min(600, Math.max(5, Math.floor(parsedHookTimeout)))
                : 60,
          };
        })(),
        smokeCheck: smokeCheckPayload,
        maxConcurrentWorkers:
          maxConcurrentInput.trim() && Number.isFinite(parsedMaxConcurrent) && parsedMaxConcurrent > 0
            ? Math.floor(parsedMaxConcurrent)
            : null,
        dailyBudgetUsd:
          dailyBudgetInput.trim() && Number.isFinite(parsedDailyBudget) && parsedDailyBudget > 0
            ? parsedDailyBudget
            : null,
        autoCleanupWorktree,
      });
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  const handleSyncContract = async () => {
    setSyncingContract(true);
    setContractNotice(null);
    try {
      const res = await api.syncRepoContract(repo.id);
      setVerificationInput((res.repo.verificationCommands ?? []).join("\n"));
      setSetupInput((res.repo.setupCommands ?? []).join("\n"));
      setForbiddenInput((res.repo.forbiddenPaths ?? []).join(", "));
      setConventions(res.repo.conventions ?? "");
      setDefaultTemplate(res.repo.defaultTemplate);
      setDefaultTddMode(Boolean(res.repo.defaultTddMode));
      setSmokeEnabled(Boolean(res.repo.smokeCheck?.enabled));
      setSmokeStartCmd(res.repo.smokeCheck?.startCommand ?? "");
      setSmokeReadyUrl(res.repo.smokeCheck?.readyUrl ?? "");
      setSmokeTimeoutSec(String(res.repo.smokeCheck?.startupTimeoutSec ?? 20));
      setSmokeTriggerMode(res.repo.smokeCheck?.triggerMode ?? "every_gate");
      setSmokeCheckCmds((res.repo.smokeCheck?.checkCommands ?? []).join("\n"));
      setPreviewCommand(res.repo.previewCommand ?? "");
      setSandboxMode(res.repo.sandboxMode ?? "balanced");
      setVerificationStrategy(res.repo.verificationStrategy ?? "always_full");
      setBrowserEnabled(Boolean(res.repo.smokeCheck?.browserCheck?.enabled));
      setBrowserPaths((res.repo.smokeCheck?.browserCheck?.paths ?? ["/"]).join(", "));
      setBrowserSelector(res.repo.smokeCheck?.browserCheck?.waitForSelector ?? "");
      setBrowserFailConsole(Boolean(res.repo.smokeCheck?.browserCheck?.failOnConsoleError));
      setVisualDiffMode(res.repo.smokeCheck?.browserCheck?.visualDiffMode ?? "auto");
      setMaxVisualDiffRatio(
        res.repo.smokeCheck?.browserCheck?.maxVisualDiffRatio !== undefined
          ? String(res.repo.smokeCheck.browserCheck.maxVisualDiffRatio)
          : "0.02",
      );
      setBrowserStepsText(
        res.repo.smokeCheck?.browserCheck?.steps?.length
          ? JSON.stringify(res.repo.smokeCheck.browserCheck.steps)
          : "",
      );
      setPreDeliverHooksInput((res.repo.hooks?.preDeliver ?? []).join("\n"));
      setPostDeliverHooksInput((res.repo.hooks?.postDeliver ?? []).join("\n"));
      setOnEscalateHooksInput((res.repo.hooks?.onEscalate ?? []).join("\n"));
      setHookTimeoutInput(String(res.repo.hooks?.timeoutSec ?? 60));
      await loadPlaybook(repo.id);
      onRefresh?.();
      setContractNotice(`Synced super-work.json (${res.repo.contractSyncedAt ?? "ok"})`);
    } catch (err) {
      setContractNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncingContract(false);
    }
  };

  const handleExportContract = async () => {
    setSyncingContract(true);
    setContractNotice(null);
    try {
      const res = await api.exportRepoContract(repo.id);
      onRefresh?.();
      setContractNotice(`Exported super-work.json -> ${res.filePath}`);
    } catch (err) {
      setContractNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncingContract(false);
    }
  };

  const handleAddPlaybookRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRule.trim()) return;
    const scopePaths = newRuleScope
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    await api.addPlaybook(repo.id, {
      rule: newRule.trim(),
      scopePaths: scopePaths.length > 0 ? scopePaths : undefined,
      pinned: newRulePinned,
      enabled: true,
    });
    setNewRule("");
    setNewRuleScope("");
    setNewRulePinned(false);
    await loadPlaybook(repo.id);
    onRefresh?.();
  };

  const handleTogglePlaybook = async (entry: PlaybookEntry, field: "enabled" | "pinned") => {
    await api.patchPlaybook(entry.id, { [field]: !entry[field] });
    await loadPlaybook(repo.id);
    onRefresh?.();
  };

  const handleDeletePlaybook = async (entryId: string) => {
    await api.deletePlaybook(entryId);
    await loadPlaybook(repo.id);
    onRefresh?.();
  };

  const handlePrunePlaybook = async () => {
    setPruningPlaybook(true);
    setPruneNotice(null);
    try {
      const res = await api.prunePlaybook(repo.id);
      setPlaybook(res.entries);
      setPruneNotice(
        t("modal.repoSettings.playbookPrunedMsg")
          .replace("{removed}", String(res.prunedIds.length))
          .replace("{kept}", String(res.keptCount)),
      );
      onRefresh?.();
    } finally {
      setPruningPlaybook(false);
    }
  };

  const handleDeleteCase = async (entryId: string) => {
    await api.deleteCasebookEntry(entryId);
    await loadCasebook(repo.id, casebookQuery.trim() || undefined);
    onRefresh?.();
  };

  const handleExportBundle = async () => {
    setBundleBusy(true);
    setBundleNotice(null);
    try {
      const { bundle } = await api.exportKnowledgeBundle(repo.id);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${repo.name.replace(/[^a-zA-Z0-9._-]+/g, "-")}-knowledge-bundle.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setBundleNotice(
        `Exported ${bundle.playbook.length} rule(s), ${bundle.casebook.length} case(s), ${bundle.blueprints.length} blueprint(s)`,
      );
    } catch (err) {
      setBundleNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBundleBusy(false);
    }
  };

  const handleImportBundleFile = async (file: File) => {
    setBundleBusy(true);
    setBundleNotice(null);
    try {
      const rawText = await file.text();
      const parsed = JSON.parse(rawText) as
        | RepoKnowledgeBundle
        | { bundle?: RepoKnowledgeBundle };
      const bundle =
        "bundle" in parsed && parsed.bundle ? parsed.bundle : (parsed as RepoKnowledgeBundle);
      const res = await api.importKnowledgeBundle(repo.id, bundle);
      await Promise.all([
        loadPlaybook(repo.id),
        loadCasebook(repo.id, casebookQuery.trim() || undefined),
      ]);
      onRefresh?.();
      setBundleNotice(
        `Imported +${res.importedPlaybook} rules, +${res.importedCasebook} cases, +${res.importedBlueprints} blueprints (skipped ${res.skippedDuplicates})`,
      );
    } catch (err) {
      setBundleNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBundleBusy(false);
    }
  };

  const toggleFallbackEngine = (eng: WorkerEngineId) => {
    setFallbackEngines((prev) =>
      prev.includes(eng) ? prev.filter((item) => item !== eng) : [...prev, eng],
    );
  };

  const prunableCount = playbook.filter((e) => e.prunable).length;

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4"
    >
      <div className="w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl">
        <div className="shrink-0 px-5 pt-5 space-y-4 border-b border-zinc-800">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-zinc-100">{t("modal.repoSettings.title")}</h3>
              <div className="font-mono text-[10px] text-zinc-500 mt-0.5 truncate max-w-md">
                {repo.rootPath}
              </div>
            </div>
            <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200">
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Settings Tab Bar */}
          <div className="flex items-center gap-1 text-xs -mb-px">
            <button
              type="button"
              onClick={() => setSettingsTab("runtime")}
              className={`px-3 py-2 border-b-2 font-medium transition ${
                settingsTab === "runtime"
                  ? "border-indigo-500 text-indigo-300"
                  : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {t("modal.repoSettings.tab.runtime")}
            </button>
            <button
              type="button"
              onClick={() => setSettingsTab("contract")}
              className={`inline-flex items-center gap-1.5 px-3 py-2 border-b-2 font-medium transition ${
                settingsTab === "contract"
                  ? "border-indigo-500 text-indigo-300"
                  : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <FileJson2 className="w-3.5 h-3.5" />
              {t("modal.repoSettings.tab.contract")}
            </button>
            <button
              type="button"
              onClick={() => setSettingsTab("playbook")}
              className={`inline-flex items-center gap-1.5 px-3 py-2 border-b-2 font-medium transition ${
                settingsTab === "playbook"
                  ? "border-indigo-500 text-indigo-300"
                  : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <BookOpen className="w-3.5 h-3.5" />
              {t("modal.repoSettings.tab.playbook")} ({playbook.length})
            </button>
            <button
              type="button"
              onClick={() => setSettingsTab("casebook")}
              className={`inline-flex items-center gap-1.5 px-3 py-2 border-b-2 font-medium transition ${
                settingsTab === "casebook"
                  ? "border-indigo-500 text-indigo-300"
                  : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <Database className="w-3.5 h-3.5" />
              {t("modal.repoSettings.tab.casebook")} ({casebook.length})
            </button>
          </div>
        </div>

        {(settingsTab === "runtime" || settingsTab === "contract") ? (
          <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0 overflow-hidden text-xs">
            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3">
              {settingsTab === "runtime" && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-zinc-400 mb-1">{t("modal.repo.name")}</label>
                    <input
                      required
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100"
                    />
                  </div>
                  <div>
                    <label className="block text-zinc-400 mb-1">{t("modal.repo.baseBranch")}</label>
                    <input
                      required
                      value={baseBranch}
                      onChange={(e) => setBaseBranch(e.target.value)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-zinc-400 mb-1">
                      {t("modal.repoSettings.defaultTemplate")}
                    </label>
                    <select
                      value={defaultTemplate}
                      onChange={(e) => setDefaultTemplate(e.target.value as PipelineTemplateId)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 text-zinc-100"
                    >
                      <option value="fast">{formatTemplate("fast", locale)}</option>
                      <option value="standard">{formatTemplate("standard", locale)}</option>
                      <option value="strict">{formatTemplate("strict", locale)}</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-zinc-400 mb-1">{t("modal.repo.initialMode")}</label>
                    <select
                      value={mode}
                      onChange={(e) => setMode(e.target.value as OperatingMode)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 text-zinc-100"
                    >
                      <option value="observe">{t("header.mode.observe")} (observe)</option>
                      <option value="auto">{t("header.mode.auto")} (auto)</option>
                      <option value="off">{t("header.mode.off")} (off)</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-zinc-400 mb-1">
                      {t("modal.repoSettings.implEngine")}
                    </label>
                    <select
                      value={implEngine}
                      onChange={(e) => setImplEngine(e.target.value as EnginePreference)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 font-mono text-zinc-100"
                    >
                      <option value="auto">{t("modal.dispatch.engineAuto")}</option>
                      {engineOptions.map((eng) => (
                        <option key={eng} value={eng}>
                          {eng}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-zinc-400 mb-1">
                      {t("modal.repoSettings.reviewEngine")}
                    </label>
                    <select
                      value={reviewEngine}
                      onChange={(e) => setReviewEngine(e.target.value as WorkerEngineId)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 font-mono text-zinc-100"
                    >
                      {engineOptions.map((eng) => (
                        <option key={eng} value={eng}>
                          {eng}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-zinc-400 mb-1.5">
                    {t("modal.repoSettings.fallbackEngines")}
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {engineOptions.map((eng) => {
                      const orderIdx = fallbackEngines.indexOf(eng);
                      const active = orderIdx !== -1;
                      return (
                        <button
                          key={eng}
                          type="button"
                          onClick={() => toggleFallbackEngine(eng)}
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border font-mono text-[11px] transition ${
                            active
                              ? "border-indigo-500/40 bg-indigo-500/15 text-indigo-200"
                              : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200"
                          }`}
                        >
                          {active && (
                            <span className="px-1 rounded bg-indigo-500/30 text-[10px] text-indigo-100">
                              #{orderIdx + 1}
                            </span>
                          )}
                          <span>{eng}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label className="block text-zinc-400 mb-1">
                    {t("modal.repoSettings.sandboxTitle")}
                  </label>
                  <select
                    value={sandboxMode}
                    onChange={(e) => setSandboxMode(e.target.value as SandboxMode)}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 text-zinc-100"
                  >
                    <option value="balanced">{t("modal.repoSettings.sandboxBalanced")}</option>
                    <option value="strict">{t("modal.repoSettings.sandboxStrict")}</option>
                    <option value="off">{t("modal.repoSettings.sandboxOff")}</option>
                  </select>
                </div>

                <div>
                  <label className="block text-zinc-400 mb-1">
                    {t("modal.repoSettings.verificationStrategyTitle")}
                  </label>
                  <select
                    value={verificationStrategy}
                    onChange={(e) => setVerificationStrategy(e.target.value as VerificationStrategy)}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 text-zinc-100"
                  >
                    <option value="always_full">
                      {t("modal.repoSettings.verificationStrategyAlwaysFull")}
                    </option>
                    <option value="impact_scoped">
                      {t("modal.repoSettings.verificationStrategyImpactScoped")}
                    </option>
                  </select>
                  <p className="mt-1 text-[11px] text-zinc-500">
                    {t("modal.repoSettings.verificationStrategyHint")}
                  </p>
                </div>

                <div>
                  <label className="block text-zinc-400 mb-1">{t("modal.repo.githubRepo")}</label>
                  <input
                    value={githubRepo}
                    onChange={(e) => setGithubRepo(e.target.value)}
                    placeholder={t("modal.repo.githubPlaceholder")}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
                  />
                </div>

                <div>
                  <label className="block text-zinc-400 mb-1">
                    {t("modal.repoSettings.deliveryChannel")}
                  </label>
                  <select
                    value={deliveryChannel}
                    onChange={(e) => setDeliveryChannel(e.target.value as DeliveryChannel)}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 text-zinc-100"
                  >
                    <option value="auto_pr_or_branch">{t("modal.repoSettings.channel.auto")}</option>
                    <option value="local_merge">{t("modal.repoSettings.channel.localMerge")}</option>
                    <option value="github_pr">{t("modal.repoSettings.channel.githubPr")}</option>
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-zinc-400 mb-1">
                      {t("modal.repoSettings.maxConcurrent")}
                    </label>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={maxConcurrentInput}
                      onChange={(e) => setMaxConcurrentInput(e.target.value)}
                      placeholder={t("modal.repoSettings.quotaPlaceholder")}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
                    />
                  </div>
                  <div>
                    <label className="block text-zinc-400 mb-1">
                      {t("modal.repoSettings.dailyBudget")}
                    </label>
                    <input
                      type="number"
                      min="0.1"
                      step="0.5"
                      value={dailyBudgetInput}
                      onChange={(e) => setDailyBudgetInput(e.target.value)}
                      placeholder={t("modal.repoSettings.quotaPlaceholder")}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
                    />
                  </div>
                </div>

                <label className="flex items-start gap-2.5 rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={defaultTddMode}
                    onChange={(e) => setDefaultTddMode(e.target.checked)}
                    className="mt-0.5 rounded border-zinc-700 bg-zinc-950 text-rose-500 focus:ring-rose-500"
                  />
                  <div>
                    <div className="font-medium text-zinc-200">
                      {t("modal.repoSettings.defaultTddLabel")}
                    </div>
                    <p className="text-[11px] text-zinc-400 mt-0.5">
                      {t("modal.repoSettings.defaultTddDesc")}
                    </p>
                  </div>
                </label>

                <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-3 space-y-2.5">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-zinc-400 mb-1">
                        {t("modal.repoSettings.deliveryGateLabel")}
                      </label>
                      <select
                        value={deliveryGatePolicy}
                        onChange={(e) => setDeliveryGatePolicy(e.target.value as DeliveryGatePolicy)}
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-2 text-zinc-100"
                      >
                        <option value="always_auto">always_auto</option>
                        <option value="risk_gated">risk_gated (A.1 Risk Gate)</option>
                        <option value="always_signoff">always_signoff</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-zinc-400 mb-1">
                        {t("modal.repoSettings.riskThresholdLabel")}
                      </label>
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="5"
                        value={riskThresholdInput}
                        onChange={(e) => setRiskThresholdInput(e.target.value)}
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-zinc-400 mb-1">
                      {t("modal.repoSettings.sensitivePathsLabel")}
                    </label>
                    <input
                      value={sensitivePathsInput}
                      onChange={(e) => setSensitivePathsInput(e.target.value)}
                      placeholder="**/auth/**, *secret*, *migration*, package.json"
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 font-mono text-zinc-100"
                    />
                  </div>
                </div>

                <label className="flex items-start gap-2.5 rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={autoCleanupWorktree}
                    onChange={(e) => setAutoCleanupWorktree(e.target.checked)}
                    className="mt-0.5 rounded border-zinc-700 bg-zinc-950 text-indigo-500 focus:ring-indigo-500"
                  />
                  <div>
                    <div className="font-medium text-zinc-200">
                      {t("modal.repoSettings.autoCleanupLabel")}
                    </div>
                    <p className="text-[11px] text-zinc-400 mt-0.5">
                      {t("modal.repoSettings.autoCleanupDesc")}
                    </p>
                  </div>
                </label>
              </>
            )}

            {settingsTab === "contract" && (
              <>
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="text-[11px] text-zinc-400">
                    {repo.contractSyncedAt
                      ? `${t("modal.repoSettings.contractSyncedPrefix")} ${repo.contractSyncedAt}`
                      : "super-work.json"}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={syncingContract}
                      onClick={() => void handleSyncContract()}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-sky-500/40 bg-sky-500/15 hover:bg-sky-500/25 text-sky-200 text-[11px] disabled:opacity-50"
                    >
                      <Download className="w-3 h-3" />
                      {t("modal.repoSettings.syncContractBtn")}
                    </button>
                    <button
                      type="button"
                      disabled={syncingContract}
                      onClick={() => void handleExportContract()}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-indigo-500/40 bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-200 text-[11px] disabled:opacity-50"
                    >
                      <Upload className="w-3 h-3" />
                      {t("modal.repoSettings.exportContractBtn")}
                    </button>
                  </div>
                </div>

                {contractNotice && (
                  <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-200">
                    {contractNotice}
                  </div>
                )}

                <div>
                  <label className="block text-zinc-400 mb-1">
                    {t("modal.repoSettings.verificationCommands")}
                  </label>
                  <textarea
                    rows={2}
                    value={verificationInput}
                    onChange={(e) => setVerificationInput(e.target.value)}
                    placeholder={t("modal.repoSettings.verificationPlaceholder")}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100 leading-relaxed focus:outline-none focus:border-indigo-500"
                  />
                  <p className="text-[11px] text-zinc-500 mt-1">
                    {t("modal.repoSettings.verificationHint")}
                  </p>
                </div>

                <div>
                  <label className="block text-zinc-400 mb-1">
                    {t("modal.repoSettings.setupCommands")}
                  </label>
                  <textarea
                    rows={2}
                    value={setupInput}
                    onChange={(e) => setSetupInput(e.target.value)}
                    placeholder={t("modal.repoSettings.setupPlaceholder")}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100 leading-relaxed focus:outline-none focus:border-indigo-500"
                  />
                  <p className="text-[11px] text-zinc-500 mt-1">
                    {t("modal.repoSettings.setupHint")}
                  </p>
                </div>

                <div>
                  <label className="block text-zinc-400 mb-1">
                    {t("modal.repoSettings.forbiddenPaths")}
                  </label>
                  <input
                    value={forbiddenInput}
                    onChange={(e) => setForbiddenInput(e.target.value)}
                    placeholder={t("modal.repoSettings.forbiddenPlaceholder")}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
                  />
                </div>

                <div>
                  <label className="block text-zinc-400 mb-1">
                    {t("modal.repoSettings.conventions")}
                  </label>
                  <textarea
                    rows={4}
                    value={conventions}
                    onChange={(e) => setConventions(e.target.value)}
                    placeholder={t("modal.repoSettings.conventionsPlaceholder")}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100"
                  />
                </div>

                <div>
                  <label className="block text-zinc-400 mb-1">
                    {t("modal.repoSettings.previewCmd")}
                  </label>
                  <input
                    value={previewCommand}
                    onChange={(e) => setPreviewCommand(e.target.value)}
                    placeholder="bun run dev -- --port $PORT"
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
                  />
                </div>

                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3.5 space-y-3">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="font-semibold text-zinc-200 flex items-center gap-1.5">
                      <Activity className="w-3.5 h-3.5 text-emerald-400" />
                      {t("modal.repoSettings.smokeTitle")}
                    </span>
                    <label className="inline-flex items-center gap-1.5 text-zinc-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={smokeEnabled}
                        onChange={(e) => setSmokeEnabled(e.target.checked)}
                        className="rounded border-zinc-700 bg-zinc-950 text-indigo-500"
                      />
                      <span className="text-[11px]">{t("modal.repoSettings.smokeEnable")}</span>
                    </label>
                  </div>

                  {!smokeEnabled ? (
                    <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-950/50 px-3 py-2.5 text-[11px] text-zinc-500 flex flex-wrap items-center justify-between gap-2">
                      <span>{t("modal.repoSettings.smokeCollapsedHint")}</span>
                      {smokeStartCmd.trim() && (
                        <code className="font-mono text-[10px] text-zinc-400 bg-zinc-900 px-1.5 py-0.5 rounded">
                          {smokeStartCmd.trim()}
                        </code>
                      )}
                    </div>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setSmokeStartCmd("bun run src/index.ts");
                            setSmokeReadyUrl("http://127.0.0.1:$PORT/health");
                            setSmokeTimeoutSec("20");
                          }}
                          className="px-2 py-0.5 rounded border border-zinc-700 bg-zinc-950 hover:bg-zinc-900 text-[10px] font-mono text-zinc-300 transition"
                        >
                          {t("modal.repoSettings.smokePresetBun")}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setSmokeStartCmd("bun run preview --port $PORT --host 127.0.0.1");
                            setSmokeReadyUrl("http://127.0.0.1:$PORT/");
                            setSmokeTimeoutSec("20");
                          }}
                          className="px-2 py-0.5 rounded border border-zinc-700 bg-zinc-950 hover:bg-zinc-900 text-[10px] font-mono text-zinc-300 transition"
                        >
                          {t("modal.repoSettings.smokePresetWeb")}
                        </button>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                        <div>
                          <label className="block text-zinc-400 mb-1">
                            {t("modal.repoSettings.smokeStartCmd")}
                          </label>
                          <input
                            value={smokeStartCmd}
                            onChange={(e) => setSmokeStartCmd(e.target.value)}
                            placeholder="bun run src/server.ts"
                            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 font-mono text-zinc-100"
                          />
                        </div>
                        <div>
                          <label className="block text-zinc-400 mb-1">
                            {t("modal.repoSettings.smokeReadyUrl")}
                          </label>
                          <input
                            value={smokeReadyUrl}
                            onChange={(e) => setSmokeReadyUrl(e.target.value)}
                            placeholder="http://127.0.0.1:$PORT/health"
                            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 font-mono text-zinc-100"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2.5">
                        <div>
                          <label className="block text-zinc-400 mb-1">
                            {t("modal.repoSettings.smokeTimeout")}
                          </label>
                          <input
                            type="number"
                            min="2"
                            max="120"
                            value={smokeTimeoutSec}
                            onChange={(e) => setSmokeTimeoutSec(e.target.value)}
                            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 font-mono text-zinc-100"
                          />
                        </div>
                        <div>
                          <label className="block text-zinc-400 mb-1">
                            {t("modal.repoSettings.smokeTriggerMode")}
                          </label>
                          <select
                            value={smokeTriggerMode}
                            onChange={(e) => setSmokeTriggerMode(e.target.value as SmokeTriggerMode)}
                            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-100"
                          >
                            <option value="every_gate">{t("modal.repoSettings.smokeEveryGate")}</option>
                            <option value="delivery_only">{t("modal.repoSettings.smokeDeliveryOnly")}</option>
                          </select>
                        </div>
                      </div>

                      <div>
                        <label className="block text-zinc-400 mb-1">
                          {t("modal.repoSettings.smokeCheckCmds")}
                        </label>
                        <textarea
                          rows={2}
                          value={smokeCheckCmds}
                          onChange={(e) => setSmokeCheckCmds(e.target.value)}
                          placeholder="curl -fsS $SUPER_WORK_SMOKE_URL/api/health"
                          className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 font-mono text-zinc-100 leading-relaxed focus:outline-none focus:border-indigo-500"
                        />
                      </div>

                      <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-2.5 space-y-2">
                        <label className="inline-flex items-center gap-1.5 text-zinc-200 cursor-pointer font-medium">
                          <input
                            type="checkbox"
                            checked={browserEnabled}
                            onChange={(e) => setBrowserEnabled(e.target.checked)}
                            className="rounded border-zinc-700 bg-zinc-950 text-indigo-500"
                          />
                          <Eye className="w-3.5 h-3.5 text-sky-400" />
                          <span className="text-[11px]">{t("modal.repoSettings.browserGateEnable")}</span>
                        </label>
                        {browserEnabled && (
                          <div className="space-y-2 pt-1 pl-5">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                              <input
                                value={browserPaths}
                                onChange={(e) => setBrowserPaths(e.target.value)}
                                placeholder={t("modal.repoSettings.browserPaths")}
                                className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1 font-mono text-[11px] text-zinc-100"
                              />
                              <input
                                value={browserSelector}
                                onChange={(e) => setBrowserSelector(e.target.value)}
                                placeholder={t("modal.repoSettings.browserSelector")}
                                className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1 font-mono text-[11px] text-zinc-100"
                              />
                            </div>
                            <label className="inline-flex items-center gap-1.5 text-[11px] text-zinc-300 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={browserFailConsole}
                                onChange={(e) => setBrowserFailConsole(e.target.checked)}
                                className="rounded border-zinc-700 bg-zinc-950 text-indigo-500"
                              />
                              {t("modal.repoSettings.browserFailConsole")}
                            </label>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                              <div>
                                <label className="block text-[10px] text-zinc-400 mb-1">
                                  {t("modal.repoSettings.visualDiffMode")}
                                </label>
                                <select
                                  value={visualDiffMode}
                                  onChange={(e) =>
                                    setVisualDiffMode(e.target.value as VisualDiffMode)
                                  }
                                  className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1 font-mono text-[11px] text-zinc-100"
                                >
                                  <option value="auto">auto</option>
                                  <option value="enforce">enforce</option>
                                  <option value="informational">informational</option>
                                  <option value="off">off</option>
                                </select>
                              </div>
                              <div>
                                <label className="block text-[10px] text-zinc-400 mb-1">
                                  {t("modal.repoSettings.maxVisualDiffRatio")}
                                </label>
                                <input
                                  type="number"
                                  step="0.005"
                                  min="0"
                                  max="1"
                                  value={maxVisualDiffRatio}
                                  onChange={(e) => setMaxVisualDiffRatio(e.target.value)}
                                  className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1 font-mono text-[11px] text-zinc-100"
                                />
                              </div>
                            </div>
                            <div>
                              <label className="block text-[10px] text-zinc-400 mb-1">
                                {t("modal.repoSettings.browserStepsLabel")}
                              </label>
                              <input
                                value={browserStepsText}
                                onChange={(e) => setBrowserStepsText(e.target.value)}
                                placeholder={t("modal.repoSettings.browserStepsPlaceholder")}
                                className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1 font-mono text-[11px] text-zinc-100"
                              />
                            </div>
                          </div>
                        )}
                      </div>

                      <p className="text-[11px] text-zinc-500">{t("modal.repoSettings.smokeHint")}</p>
                    </>
                  )}
                </div>

                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3.5 space-y-3">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="font-semibold text-zinc-200 flex items-center gap-1.5">
                      <ShieldCheck className="w-3.5 h-3.5 text-amber-400" />
                      {t("hooks.title")}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] text-zinc-400">timeoutSec</span>
                      <input
                        type="number"
                        min={5}
                        max={600}
                        value={hookTimeoutInput}
                        onChange={(e) => setHookTimeoutInput(e.target.value)}
                        className="w-16 bg-zinc-900 border border-zinc-800 rounded px-2 py-0.5 font-mono text-[11px] text-zinc-100"
                      />
                    </div>
                  </div>
                  <p className="text-[11px] text-emerald-300/90 bg-emerald-500/10 border border-emerald-500/25 rounded-lg px-2.5 py-1.5">
                    {t("hooks.immutableNote")}
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    <div>
                      <label className="block text-[11px] text-zinc-400 mb-1">
                        pre_deliver (blocking)
                      </label>
                      <textarea
                        rows={2}
                        value={preDeliverHooksInput}
                        onChange={(e) => setPreDeliverHooksInput(e.target.value)}
                        placeholder="bun run typecheck"
                        className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 font-mono text-[11px] text-zinc-100"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-zinc-400 mb-1">
                        post_deliver (async)
                      </label>
                      <textarea
                        rows={2}
                        value={postDeliverHooksInput}
                        onChange={(e) => setPostDeliverHooksInput(e.target.value)}
                        placeholder="./scripts/notify.sh"
                        className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 font-mono text-[11px] text-zinc-100"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-zinc-400 mb-1">
                        on_escalate (async)
                      </label>
                      <textarea
                        rows={2}
                        value={onEscalateHooksInput}
                        onChange={(e) => setOnEscalateHooksInput(e.target.value)}
                        placeholder="./scripts/page.sh"
                        className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 font-mono text-[11px] text-zinc-100"
                      />
                    </div>
                  </div>
                </div>
              </>
            )}
            </div>

            <div className="shrink-0 border-t border-zinc-800 bg-zinc-900/95 px-5 py-3 flex justify-end gap-2">
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
                {submitting ? t("modal.repoSettings.saving") : t("modal.repoSettings.save")}
              </button>
            </div>
          </form>
        ) : settingsTab === "playbook" ? (
          <div className="flex flex-col flex-1 min-h-0 overflow-hidden text-xs">
            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                {bundleNotice || pruneNotice ? (
                  <span className="text-[11px] text-emerald-300">{bundleNotice ?? pruneNotice}</span>
                ) : (
                  <span className="text-[11px] text-zinc-500">
                    {playbook.length} rule(s)
                  </span>
                )}
                <div className="flex flex-wrap items-center gap-1.5">
                  <input
                    ref={bundleInputRef}
                    type="file"
                    accept=".json,application/json"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (f) void handleImportBundleFile(f);
                    }}
                  />
                  <button
                    type="button"
                    disabled={bundleBusy}
                    onClick={() => void handleExportBundle()}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 text-[11px] disabled:opacity-40 transition"
                  >
                    <Download className="w-3 h-3" />
                    {t("bundle.exportBtn")}
                  </button>
                  <button
                    type="button"
                    disabled={bundleBusy}
                    onClick={() => bundleInputRef.current?.click()}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 text-[11px] disabled:opacity-40 transition"
                  >
                    <Upload className="w-3 h-3" />
                    {t("bundle.importBtn")}
                  </button>
                  <button
                    type="button"
                    disabled={pruningPlaybook || prunableCount === 0}
                    onClick={() => void handlePrunePlaybook()}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-amber-500/35 bg-amber-500/15 hover:bg-amber-500/25 text-amber-200 text-[11px] font-medium disabled:opacity-40 transition"
                  >
                    <Sparkles className="w-3 h-3" />
                    {pruningPlaybook
                      ? t("modal.repoSettings.playbookPruning")
                      : `${t("modal.repoSettings.playbookPruneBtn")} (${prunableCount})`}
                  </button>
                </div>
              </div>

              <form onSubmit={(e) => void handleAddPlaybookRule(e)} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 space-y-2">
                <input
                  required
                  value={newRule}
                  onChange={(e) => setNewRule(e.target.value)}
                  placeholder={t("modal.repoSettings.playbookAddPlaceholder")}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-zinc-100"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    value={newRuleScope}
                    onChange={(e) => setNewRuleScope(e.target.value)}
                    placeholder={t("modal.repoSettings.playbookScopePlaceholder")}
                    className="flex-1 min-w-44 bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1 font-mono text-[11px] text-emerald-300"
                  />
                  <label className="inline-flex items-center gap-1.5 text-zinc-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={newRulePinned}
                      onChange={(e) => setNewRulePinned(e.target.checked)}
                      className="rounded border-zinc-700 bg-zinc-950 text-indigo-500"
                    />
                    {t("modal.repoSettings.playbookPin")}
                  </label>
                  <button
                    type="submit"
                    className="inline-flex items-center gap-1 px-3 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-medium"
                  >
                    <Plus className="w-3 h-3" />
                    {t("modal.repoSettings.playbookAddBtn")}
                  </button>
                </div>
              </form>

              <div className="space-y-2">
                {playbookLoading ? (
                  <div className="py-6 text-center text-zinc-500">{t("drawer.loading")}</div>
                ) : playbook.length === 0 ? (
                  <div className="py-6 px-4 text-center rounded-lg border border-dashed border-zinc-800 text-zinc-500">
                    {t("modal.repoSettings.playbookEmpty")}
                  </div>
                ) : (
                  playbook.map((entry) => (
                    <div
                      key={entry.id}
                      className={`rounded-lg border p-2.5 space-y-1.5 ${
                        entry.enabled
                          ? "border-zinc-800 bg-zinc-900/60"
                          : "border-zinc-800/50 bg-zinc-900/20 opacity-60"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="space-y-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="px-1.5 py-0.2 rounded font-mono text-[10px] bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">
                              {entry.source}
                            </span>
                            {entry.pinned && (
                              <span className="px-1.5 py-0.2 rounded font-mono text-[10px] bg-amber-500/15 text-amber-300 border border-amber-500/30">
                                PIN
                              </span>
                            )}
                            {entry.healthStatus && entry.healthStatus !== "healthy" && (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded font-mono text-[10px] bg-rose-500/15 text-rose-300 border border-rose-500/30">
                                <AlertTriangle className="w-2.5 h-2.5" />
                                {t(`modal.repoSettings.health.${entry.healthStatus}` as const)}
                              </span>
                            )}
                            <span className="px-1.5 py-0.2 rounded font-mono text-[10px] bg-zinc-950 text-zinc-400 border border-zinc-800">
                              {t("modal.repoSettings.playbookHits")}: {entry.hitCount ?? 0}
                            </span>
                            <span className="font-mono text-[10px] text-emerald-300">
                              [{entry.scopePaths.join(", ")}]
                            </span>
                          </div>
                          <p className="text-zinc-200 leading-relaxed">{entry.rule}</p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => void handleTogglePlaybook(entry, "pinned")}
                            title={entry.pinned ? t("modal.repoSettings.playbookUnpin") : t("modal.repoSettings.playbookPin")}
                            className={`p-1 rounded border ${
                              entry.pinned
                                ? "border-amber-500/40 bg-amber-500/15 text-amber-300"
                                : "border-zinc-800 text-zinc-500 hover:text-zinc-200"
                            }`}
                          >
                            <Pin className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleTogglePlaybook(entry, "enabled")}
                            className="px-2 py-0.5 rounded border border-zinc-800 text-[10px] text-zinc-300 hover:bg-zinc-800"
                          >
                            {entry.enabled
                              ? t("modal.repoSettings.playbookDisable")
                              : t("modal.repoSettings.playbookEnable")}
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeletePlaybook(entry.id)}
                            className="p-1 rounded text-zinc-500 hover:text-rose-400"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="shrink-0 border-t border-zinc-800 bg-zinc-900/95 px-5 py-3 flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 rounded-lg border border-zinc-800 text-zinc-400 hover:text-zinc-200"
              >
                {t("modal.worktrees.close")}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col flex-1 min-h-0 overflow-hidden text-xs">
            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void loadCasebook(repo.id, casebookQuery.trim() || undefined);
                }}
                className="flex gap-2"
              >
                <div className="relative flex-1">
                  <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-2" />
                  <input
                    type="text"
                    value={casebookQuery}
                    onChange={(e) => setCasebookQuery(e.target.value)}
                    placeholder={t("modal.repoSettings.casebookSearchPlaceholder")}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg pl-8 pr-3 py-1.5 text-zinc-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <button
                  type="submit"
                  className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200"
                >
                  <Search className="w-3.5 h-3.5" />
                </button>
              </form>

              {casebookLoading ? (
                <div className="py-6 text-center text-zinc-500">{t("drawer.loading")}</div>
              ) : casebook.length === 0 ? (
                <div className="py-6 px-4 text-center rounded-lg border border-dashed border-zinc-800 text-zinc-500">
                  {t("modal.repoSettings.casebookEmpty")}
                </div>
              ) : (
                <div className="space-y-2.5">
                  {casebook.map((c) => (
                    <div
                      key={c.id}
                      className={`rounded-lg border p-3 space-y-1.5 ${
                        c.reverted
                          ? "border-rose-500/35 bg-rose-500/5"
                          : "border-zinc-800 bg-zinc-900/60"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span
                            className={`inline-flex items-center gap-1 px-1.5 py-0.2 rounded font-mono text-[10px] border ${
                              c.reverted
                                ? "bg-rose-500/15 text-rose-300 border-rose-500/30"
                                : "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                            }`}
                          >
                            {c.reverted && <RotateCcw className="w-2.5 h-2.5" />}
                            {c.reverted
                              ? t("modal.repoSettings.casebookRevertedBadge")
                              : t("modal.repoSettings.casebookVerifiedBadge")}
                          </span>
                          <span className="font-mono text-[10px] text-zinc-500">{c.ticketId}</span>
                          <span className="px-1.5 py-0.2 rounded font-mono text-[10px] bg-zinc-950 text-zinc-400 border border-zinc-800">
                            {t("modal.repoSettings.playbookHits")}: {c.hitCount}
                          </span>
                          <span className="font-mono text-[10px] text-emerald-300">
                            [{c.scopePaths.join(", ")}]
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleDeleteCase(c.id)}
                          className="p-1 rounded text-zinc-500 hover:text-rose-400 shrink-0"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                      <div className="font-medium text-zinc-100">{c.title}</div>
                      <p className="text-zinc-300 leading-relaxed">{c.solutionSummary}</p>
                      {c.pitfallsAndFixes && (
                        <p className="text-[11px] text-amber-300/90 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1">
                          {c.pitfallsAndFixes}
                        </p>
                      )}
                      {c.exportedSymbols.length > 0 && (
                        <div className="flex flex-wrap gap-1 pt-0.5">
                          {c.exportedSymbols.slice(0, 6).map((sym) => (
                            <code
                              key={sym}
                              className="px-1.5 py-0.2 rounded bg-indigo-500/10 border border-indigo-500/20 font-mono text-[10px] text-indigo-300"
                            >
                              {sym}
                            </code>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="shrink-0 border-t border-zinc-800 bg-zinc-900/95 px-5 py-3 flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 rounded-lg border border-zinc-800 text-zinc-400 hover:text-zinc-200"
              >
                {t("modal.worktrees.close")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
