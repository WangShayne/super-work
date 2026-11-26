import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import { api } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { CasebookTab } from "./repo-settings/CasebookTab.tsx";
import { ContractSettingsSection } from "./repo-settings/ContractSettingsSection.tsx";
import { PlaybookTab } from "./repo-settings/PlaybookTab.tsx";
import { RuntimeSettingsSection } from "./repo-settings/RuntimeSettingsSection.tsx";
import { SettingsTabBar } from "./repo-settings/SettingsTabBar.tsx";
import type { SettingsTab } from "./repo-settings/shared.ts";
import type {
  BrowserInteractionStep,
  CasebookEntry,
  DeliveryChannel,
  DeliveryGatePolicy,
  EnginePreference,
  LifecycleHooksConfig,
  OperatingMode,
  PipelineTemplateId,
  PlaybookEntry,
  RepoConfig,
  RepoKnowledgeBundle,
  SandboxMode,
  SmokeCheckConfig,
  SmokeTriggerMode,
  TaskBlueprint,
  VerificationStrategy,
  VisualDiffMode,
  WorkerEngineId,
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
  /** Render inline (Engine Room) instead of as a fixed modal overlay. */
  embedded?: boolean;
  /** Restrict which tabs are offered (embedded Engine Room uses two groups). */
  visibleTabs?: SettingsTab[];
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

export function RepoSettingsModal({
  open,
  repo,
  initialTab = "runtime",
  embedded = false,
  visibleTabs,
  availableEngines,
  onClose,
  onRefresh,
  onSubmit,
}: RepoSettingsModalProps) {
  const { t } = useI18n();
  const [savedNotice, setSavedNotice] = useState(false);
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
    // Keyed on id/updatedAt (not object identity) so SSE refreshes don't wipe in-progress edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, repo?.id, repo?.updatedAt, initialTab]);

  useEscapeKey(open && !embedded, onClose);

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
      if (embedded) setSavedNotice(true);
      else onClose();
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
        if (!embedded && e.target === e.currentTarget) onClose();
      }}
      className={
        embedded ? "" : "fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4"
      }
    >
      <div
        className={`w-full flex flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 ${
          embedded ? "max-h-[70vh]" : "max-w-2xl max-h-[90vh] shadow-2xl"
        }`}
      >
        <div className="shrink-0 px-5 pt-5 space-y-4 border-b border-zinc-800">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-zinc-100">{t("modal.repoSettings.title")}</h3>
              <div className="font-mono text-[10px] text-zinc-500 mt-0.5 truncate max-w-md">
                {repo.rootPath}
              </div>
            </div>
            {!embedded && (
              <button type="button" onClick={onClose} className="text-zinc-500 hover:text-zinc-200">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Settings Tab Bar */}
          <SettingsTabBar
            settingsTab={settingsTab}
            setSettingsTab={setSettingsTab}
            playbook={playbook}
            casebook={casebook}
            visibleTabs={visibleTabs}
          />
        </div>

        {(settingsTab === "runtime" || settingsTab === "contract") ? (
          <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0 overflow-hidden text-xs">
            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3">
              {settingsTab === "runtime" && (
              <>
                <RuntimeSettingsSection
                  name={name}
                  setName={setName}
                  baseBranch={baseBranch}
                  setBaseBranch={setBaseBranch}
                  githubRepo={githubRepo}
                  setGithubRepo={setGithubRepo}
                  mode={mode}
                  setMode={setMode}
                  defaultTemplate={defaultTemplate}
                  setDefaultTemplate={setDefaultTemplate}
                  defaultTddMode={defaultTddMode}
                  setDefaultTddMode={setDefaultTddMode}
                  deliveryGatePolicy={deliveryGatePolicy}
                  setDeliveryGatePolicy={setDeliveryGatePolicy}
                  riskThresholdInput={riskThresholdInput}
                  setRiskThresholdInput={setRiskThresholdInput}
                  sensitivePathsInput={sensitivePathsInput}
                  setSensitivePathsInput={setSensitivePathsInput}
                  implEngine={implEngine}
                  setImplEngine={setImplEngine}
                  reviewEngine={reviewEngine}
                  setReviewEngine={setReviewEngine}
                  fallbackEngines={fallbackEngines}
                  sandboxMode={sandboxMode}
                  setSandboxMode={setSandboxMode}
                  verificationStrategy={verificationStrategy}
                  setVerificationStrategy={setVerificationStrategy}
                  deliveryChannel={deliveryChannel}
                  setDeliveryChannel={setDeliveryChannel}
                  maxConcurrentInput={maxConcurrentInput}
                  setMaxConcurrentInput={setMaxConcurrentInput}
                  dailyBudgetInput={dailyBudgetInput}
                  setDailyBudgetInput={setDailyBudgetInput}
                  autoCleanupWorktree={autoCleanupWorktree}
                  setAutoCleanupWorktree={setAutoCleanupWorktree}
                  engineOptions={engineOptions}
                  toggleFallbackEngine={toggleFallbackEngine}
                />
              </>
            )}

            {settingsTab === "contract" && (
              <>
                <ContractSettingsSection
                  verificationInput={verificationInput}
                  setVerificationInput={setVerificationInput}
                  setupInput={setupInput}
                  setSetupInput={setSetupInput}
                  forbiddenInput={forbiddenInput}
                  setForbiddenInput={setForbiddenInput}
                  conventions={conventions}
                  setConventions={setConventions}
                  previewCommand={previewCommand}
                  setPreviewCommand={setPreviewCommand}
                  preDeliverHooksInput={preDeliverHooksInput}
                  setPreDeliverHooksInput={setPreDeliverHooksInput}
                  postDeliverHooksInput={postDeliverHooksInput}
                  setPostDeliverHooksInput={setPostDeliverHooksInput}
                  onEscalateHooksInput={onEscalateHooksInput}
                  setOnEscalateHooksInput={setOnEscalateHooksInput}
                  hookTimeoutInput={hookTimeoutInput}
                  setHookTimeoutInput={setHookTimeoutInput}
                  smokeEnabled={smokeEnabled}
                  setSmokeEnabled={setSmokeEnabled}
                  smokeStartCmd={smokeStartCmd}
                  setSmokeStartCmd={setSmokeStartCmd}
                  smokeReadyUrl={smokeReadyUrl}
                  setSmokeReadyUrl={setSmokeReadyUrl}
                  smokeTimeoutSec={smokeTimeoutSec}
                  setSmokeTimeoutSec={setSmokeTimeoutSec}
                  smokeTriggerMode={smokeTriggerMode}
                  setSmokeTriggerMode={setSmokeTriggerMode}
                  smokeCheckCmds={smokeCheckCmds}
                  setSmokeCheckCmds={setSmokeCheckCmds}
                  browserEnabled={browserEnabled}
                  setBrowserEnabled={setBrowserEnabled}
                  browserPaths={browserPaths}
                  setBrowserPaths={setBrowserPaths}
                  browserSelector={browserSelector}
                  setBrowserSelector={setBrowserSelector}
                  browserFailConsole={browserFailConsole}
                  setBrowserFailConsole={setBrowserFailConsole}
                  visualDiffMode={visualDiffMode}
                  setVisualDiffMode={setVisualDiffMode}
                  maxVisualDiffRatio={maxVisualDiffRatio}
                  setMaxVisualDiffRatio={setMaxVisualDiffRatio}
                  browserStepsText={browserStepsText}
                  setBrowserStepsText={setBrowserStepsText}
                  contractNotice={contractNotice}
                  syncingContract={syncingContract}
                  repo={repo}
                  handleSyncContract={handleSyncContract}
                  handleExportContract={handleExportContract}
                />
              </>
            )}
            </div>

            <div className="shrink-0 border-t border-zinc-800 bg-zinc-900/95 px-5 py-3 flex items-center justify-end gap-2">
              {savedNotice && <span className="text-emerald-300 text-[11px] mr-auto">{t("engineRoom.saved")}</span>}
              {!embedded && (
                <button
                  type="button"
                  onClick={onClose}
                  className="px-3 py-1.5 rounded-lg border border-zinc-800 text-zinc-400 hover:text-zinc-200"
                >
                  {t("modal.repo.cancel")}
                </button>
              )}
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
          <PlaybookTab
            playbook={playbook}
            playbookLoading={playbookLoading}
            pruningPlaybook={pruningPlaybook}
            pruneNotice={pruneNotice}
            newRule={newRule}
            setNewRule={setNewRule}
            newRuleScope={newRuleScope}
            setNewRuleScope={setNewRuleScope}
            newRulePinned={newRulePinned}
            setNewRulePinned={setNewRulePinned}
            bundleBusy={bundleBusy}
            bundleNotice={bundleNotice}
            onClose={embedded ? undefined : onClose}
            handleAddPlaybookRule={handleAddPlaybookRule}
            handleTogglePlaybook={handleTogglePlaybook}
            handleDeletePlaybook={handleDeletePlaybook}
            handlePrunePlaybook={handlePrunePlaybook}
            handleExportBundle={handleExportBundle}
            handleImportBundleFile={handleImportBundleFile}
            prunableCount={prunableCount}
            bundleInputRef={bundleInputRef}
          />
        ) : (
          <CasebookTab
            casebook={casebook}
            casebookLoading={casebookLoading}
            casebookQuery={casebookQuery}
            setCasebookQuery={setCasebookQuery}
            repo={repo}
            onClose={embedded ? undefined : onClose}
            handleDeleteCase={handleDeleteCase}
            loadCasebook={loadCasebook}
          />
        )}
      </div>
    </div>
  );
}
