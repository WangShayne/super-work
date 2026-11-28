import {
  buildHeuristicSpecClarification,
  heuristicDecomposeEpic,
  heuristicDistillPlaybookLesson,
  heuristicPlanRequirementIntake,
} from "@super-work/core";
import type {
  CampaignDirection,
  ControlPlaneLLM,
  ControlProbeStep,
  EpicDecompositionPlan,
  LlmProviderPreset,
  MemorySearchHit,
  ModelProfile,
  PipelineTemplateId,
  ReasoningEffort,
  RepoConfig,
  RepoProbeContextPack,
  RepoProbeExecutor,
  RequirementIntakePlan,
  SpecClarificationResult,
  StageRun,
  SystemSetupConfig,
  Ticket,
  TriageProposal,
  Trigger,
  WatchdogDecision,
  WatchdogSignal,
  WorkerEngineId,
  WorkerStreamEvent,
} from "@super-work/core";
import {
  createSanitizedClaudeEnv,
  runSpawnWithTimeout,
  sanitizeCliModelName,
} from "./control-plane-helpers.ts";
import { OpenAICompatibleControlLLM } from "./control-plane-openai.ts";
import { CliFallbackControlLLM, CodexCliControlLLM } from "./control-plane-cli-llms.ts";
import { HeuristicControlLLM } from "./control-plane-heuristic.ts";
import { createControlLLMFromProfile } from "./control-plane-symmetric.ts";

export type { OpenAICompatibleConfig } from "./control-plane-helpers.ts";
export {
  sanitizeCliModelName,
  createSanitizedClaudeEnv,
  buildClaudeControlPlaneArgs,
  runWithOptionalProbes,
} from "./control-plane-helpers.ts";
export { OpenAICompatibleControlLLM } from "./control-plane-openai.ts";
export { CliFallbackControlLLM, CodexCliControlLLM } from "./control-plane-cli-llms.ts";
export { HeuristicControlLLM } from "./control-plane-heuristic.ts";

export class CompositeControlPlaneLLM implements ControlPlaneLLM {
  readonly providerName: string;

  constructor(private readonly chain: ControlPlaneLLM[]) {
    this.providerName = chain[0]?.providerName ?? "heuristic:local";
  }

  async triageTrigger(input: {
    repo: RepoConfig;
    trigger: Trigger;
    activeTickets: Ticket[];
    relatedMemory: MemorySearchHit[];
    repoStructure?: string;
    playbookRules?: string;
    conventions?: string;
  }): Promise<TriageProposal> {
    for (const provider of this.chain) {
      try {
        return await provider.triageTrigger(input);
      } catch {
        // Fallback to next control-plane provider
      }
    }
    throw new Error("All ControlPlaneLLM providers failed");
  }

  async diagnoseWatchdog(input: {
    ticket: Ticket;
    stageRun: StageRun;
    signal: WatchdogSignal;
    recentEvents: WorkerStreamEvent[];
    availableEngines: WorkerEngineId[];
  }): Promise<WatchdogDecision> {
    for (const provider of this.chain) {
      try {
        return await provider.diagnoseWatchdog(input);
      } catch {
        // Fallback to next control-plane provider
      }
    }
    throw new Error("All ControlPlaneLLM providers failed");
  }

  async planEpicDecomposition(input: {
    repo: RepoConfig;
    title: string;
    description: string;
    defaultTemplate: PipelineTemplateId;
    repoStructure?: string;
    playbookRules?: string;
    conventions?: string;
    availableRepos?: Array<{ id: string; name: string; structure?: string }>;
  }): Promise<EpicDecompositionPlan> {
    for (const provider of this.chain) {
      if (!provider.planEpicDecomposition) continue;
      try {
        return await provider.planEpicDecomposition(input);
      } catch {
        // Fallback to next control-plane provider
      }
    }
    return heuristicDecomposeEpic(input);
  }

  async distillPlaybookLesson(input: {
    repo: RepoConfig;
    ticket: Ticket;
    failureKind: "verification" | "smoke" | "review";
    failureSummary: string;
    fixSummary: string;
    changedFiles: string[];
  }): Promise<{ rule: string; scopePaths: string[] } | null> {
    for (const provider of this.chain) {
      if (!provider.distillPlaybookLesson) continue;
      try {
        const res = await provider.distillPlaybookLesson(input);
        if (res) return res;
      } catch {
        // Fallback to next control-plane provider
      }
    }
    return heuristicDistillPlaybookLesson({
      failureKind: input.failureKind,
      failureSummary: input.failureSummary,
      fixSummary: input.fixSummary,
      changedFiles: input.changedFiles,
      allowedPaths: input.ticket.mandate.allowedPaths,
    });
  }

  async distillHandoverDigest(input: {
    repo: RepoConfig;
    ticket: Ticket;
    changedFiles: string[];
    exportedSymbols: string[];
    contractSnippets: string[];
    diffExcerpt: string;
    stageSummary: string;
  }): Promise<{ summary: string; exportedSymbols?: string[]; contractSnippets?: string[] } | null> {
    for (const provider of this.chain) {
      if (!provider.distillHandoverDigest) continue;
      try {
        const res = await provider.distillHandoverDigest(input);
        if (res) return res;
      } catch {
        // Fallback to next control-plane provider
      }
    }
    return null;
  }

  async clarifySpec(input: {
    repo: RepoConfig;
    title: string;
    description: string;
    defaultTemplate: PipelineTemplateId;
    repoStructure?: string;
    playbookRules?: string;
    casebookContext?: string;
    conventions?: string;
    probeContext?: RepoProbeContextPack;
    probeExecutor?: RepoProbeExecutor;
  }): Promise<SpecClarificationResult> {
    for (const provider of this.chain) {
      if (!provider.clarifySpec) continue;
      try {
        return await provider.clarifySpec(input);
      } catch {
        // Fallback to next control-plane provider
      }
    }
    return buildHeuristicSpecClarification(input);
  }

  async answerChiefQuestion(input: {
    question: string;
    contextSummary: string;
    probeContext?: RepoProbeContextPack;
    probeExecutor?: RepoProbeExecutor;
  }): Promise<{ answer: string; highlights?: string[]; probeSteps?: ControlProbeStep[] }> {
    for (const provider of this.chain) {
      if (!provider.answerChiefQuestion) continue;
      try {
        return await provider.answerChiefQuestion(input);
      } catch {
        // Fallback to next control-plane provider
      }
    }
    return {
      answer: input.contextSummary,
      probeSteps: input.probeContext?.probeSteps,
    };
  }

  async planRequirementIntake(input: {
    repo: RepoConfig;
    title: string;
    requirement: string;
    defaultTemplate: PipelineTemplateId;
    defaultTddMode?: boolean;
    repoStructure?: string;
    playbookRules?: string;
    conventions?: string;
    availableRepos?: Array<{ id: string; name: string; structure?: string }>;
    probeContext?: RepoProbeContextPack;
    probeExecutor?: RepoProbeExecutor;
    metricHint?: {
      metricCommand?: string;
      targetValue?: number;
      direction?: CampaignDirection;
      metricUnit?: string;
      metricRegex?: string;
    };
  }): Promise<RequirementIntakePlan> {
    for (const provider of this.chain) {
      if (!provider.planRequirementIntake) continue;
      try {
        return await provider.planRequirementIntake(input);
      } catch {
        // Fallback to next control-plane provider
      }
    }
    return heuristicPlanRequirementIntake(input);
  }
}

export function createControlPlaneLLMFromEnv(): ControlPlaneLLM {
  const chain: ControlPlaneLLM[] = [];

  const apiKey =
    process.env.SUPER_WORK_LLM_API_KEY ||
    process.env.DEEPSEEK_API_KEY ||
    process.env.OPENAI_API_KEY;

  if (apiKey) {
    const isDeepSeek = Boolean(process.env.DEEPSEEK_API_KEY && !process.env.SUPER_WORK_LLM_BASE_URL);
    const baseUrl =
      process.env.SUPER_WORK_LLM_BASE_URL ??
      (isDeepSeek ? "https://api.deepseek.com/v1" : "https://api.openai.com/v1");
    const model =
      process.env.SUPER_WORK_LLM_MODEL ??
      (isDeepSeek ? "deepseek-chat" : "gpt-4o-mini");

    chain.push(
      new OpenAICompatibleControlLLM({
        apiKey,
        baseUrl,
        model,
        providerLabel: isDeepSeek ? `deepseek:${model}` : `openai:${model}`,
      }),
    );
  }

  if (process.env.SUPER_WORK_ENABLE_CLI_LLM === "1") {
    chain.push(new CliFallbackControlLLM());
  }

  chain.push(new HeuristicControlLLM());
  return new CompositeControlPlaneLLM(chain);
}

/** Any CLI/API ModelProfile as ControlPlaneLLM, with the heuristic planner as last-resort fallback. */
export function buildControlPlaneLLMFromProfile(profile: ModelProfile): ControlPlaneLLM {
  return new CompositeControlPlaneLLM([createControlLLMFromProfile(profile), new HeuristicControlLLM()]);
}

export function buildControlPlaneLLMFromSetup(config?: SystemSetupConfig | null): ControlPlaneLLM {
  if (!config || !config.initialized) {
    return createControlPlaneLLMFromEnv();
  }

  if (config.controlModelId === "heuristic") {
    return new HeuristicControlLLM();
  }
  const controlProfile = config.controlModelId
    ? config.modelProfiles?.find((p) => p.id === config.controlModelId && p.enabled !== false)
    : undefined;
  if (controlProfile) {
    return buildControlPlaneLLMFromProfile(controlProfile);
  }

  if (
    (config.llmPreset === "deepseek" ||
      config.llmPreset === "openai" ||
      config.llmPreset === "custom") &&
    config.llmApiKey?.trim()
  ) {
    const baseUrl =
      config.llmBaseUrl.trim() ||
      (config.llmPreset === "deepseek"
        ? "https://api.deepseek.com/v1"
        : "https://api.openai.com/v1");
    const model =
      config.llmModel.trim() ||
      (config.llmPreset === "deepseek" ? "deepseek-chat" : "gpt-4o-mini");

    return new CompositeControlPlaneLLM([
      new OpenAICompatibleControlLLM({
        apiKey: config.llmApiKey.trim(),
        baseUrl,
        model,
        providerLabel: `${config.llmPreset}:${model}`,
      }),
      new HeuristicControlLLM(),
    ]);
  }

  if (config.llmPreset === "claude_cli") {
    return new CompositeControlPlaneLLM([
      new CliFallbackControlLLM({
        model: sanitizeCliModelName(config.llmModel),
        effort: config.llmEffort ?? "low",
      }),
      new HeuristicControlLLM(),
    ]);
  }

  if (config.llmPreset === "codex_cli") {
    return new CompositeControlPlaneLLM([
      new CodexCliControlLLM({
        model: sanitizeCliModelName(config.llmModel),
        effort: config.llmEffort ?? "low",
      }),
      new HeuristicControlLLM(),
    ]);
  }

  return new HeuristicControlLLM();
}

export class MutableControlPlaneLLM implements ControlPlaneLLM {
  private current: ControlPlaneLLM;

  constructor(initial: ControlPlaneLLM) {
    this.current = initial;
  }

  get providerName(): string {
    return this.current.providerName;
  }

  reconfigure(next: ControlPlaneLLM): void {
    this.current = next;
  }

  triageTrigger(input: {
    repo: RepoConfig;
    trigger: Trigger;
    activeTickets: Ticket[];
    relatedMemory: MemorySearchHit[];
    repoStructure?: string;
    playbookRules?: string;
    conventions?: string;
    probeContext?: RepoProbeContextPack;
    probeExecutor?: RepoProbeExecutor;
  }): Promise<TriageProposal> {
    return this.current.triageTrigger(input);
  }

  diagnoseWatchdog(input: {
    ticket: Ticket;
    stageRun: StageRun;
    signal: WatchdogSignal;
    recentEvents: WorkerStreamEvent[];
    availableEngines: WorkerEngineId[];
    probeContext?: RepoProbeContextPack;
    probeExecutor?: RepoProbeExecutor;
  }): Promise<WatchdogDecision> {
    return this.current.diagnoseWatchdog(input);
  }

  planEpicDecomposition(input: {
    repo: RepoConfig;
    title: string;
    description: string;
    defaultTemplate: PipelineTemplateId;
    repoStructure?: string;
    playbookRules?: string;
    conventions?: string;
    availableRepos?: Array<{ id: string; name: string; structure?: string }>;
    probeContext?: RepoProbeContextPack;
    probeExecutor?: RepoProbeExecutor;
  }): Promise<EpicDecompositionPlan> {
    if (this.current.planEpicDecomposition) {
      return this.current.planEpicDecomposition(input);
    }
    return Promise.resolve(heuristicDecomposeEpic(input));
  }

  distillPlaybookLesson(input: {
    repo: RepoConfig;
    ticket: Ticket;
    failureKind: "verification" | "smoke" | "review";
    failureSummary: string;
    fixSummary: string;
    changedFiles: string[];
  }): Promise<{ rule: string; scopePaths: string[] } | null> {
    if (this.current.distillPlaybookLesson) {
      return this.current.distillPlaybookLesson(input);
    }
    return Promise.resolve(
      heuristicDistillPlaybookLesson({
        failureKind: input.failureKind,
        failureSummary: input.failureSummary,
        fixSummary: input.fixSummary,
        changedFiles: input.changedFiles,
        allowedPaths: input.ticket.mandate.allowedPaths,
      }),
    );
  }

  distillHandoverDigest(input: {
    repo: RepoConfig;
    ticket: Ticket;
    changedFiles: string[];
    exportedSymbols: string[];
    contractSnippets: string[];
    diffExcerpt: string;
    stageSummary: string;
  }): Promise<{ summary: string; exportedSymbols?: string[]; contractSnippets?: string[] } | null> {
    if (this.current.distillHandoverDigest) {
      return this.current.distillHandoverDigest(input);
    }
    return Promise.resolve(null);
  }

  clarifySpec(input: {
    repo: RepoConfig;
    title: string;
    description: string;
    defaultTemplate: PipelineTemplateId;
    repoStructure?: string;
    playbookRules?: string;
    casebookContext?: string;
    conventions?: string;
    probeContext?: RepoProbeContextPack;
    probeExecutor?: RepoProbeExecutor;
  }): Promise<SpecClarificationResult> {
    if (this.current.clarifySpec) {
      return this.current.clarifySpec(input);
    }
    return Promise.resolve(buildHeuristicSpecClarification(input));
  }

  answerChiefQuestion(input: {
    question: string;
    contextSummary: string;
    probeContext?: RepoProbeContextPack;
    probeExecutor?: RepoProbeExecutor;
  }): Promise<{ answer: string; highlights?: string[]; probeSteps?: ControlProbeStep[] }> {
    if (this.current.answerChiefQuestion) {
      return this.current.answerChiefQuestion(input);
    }
    return Promise.resolve({
      answer: input.contextSummary,
      probeSteps: input.probeContext?.probeSteps,
    });
  }

  planRequirementIntake(input: {
    repo: RepoConfig;
    title: string;
    requirement: string;
    defaultTemplate: PipelineTemplateId;
    defaultTddMode?: boolean;
    repoStructure?: string;
    playbookRules?: string;
    conventions?: string;
    availableRepos?: Array<{ id: string; name: string; structure?: string }>;
    probeContext?: RepoProbeContextPack;
    probeExecutor?: RepoProbeExecutor;
    metricHint?: {
      metricCommand?: string;
      targetValue?: number;
      direction?: CampaignDirection;
      metricUnit?: string;
      metricRegex?: string;
    };
  }): Promise<RequirementIntakePlan> {
    if (this.current.planRequirementIntake) {
      return this.current.planRequirementIntake(input);
    }
    return Promise.resolve(heuristicPlanRequirementIntake(input));
  }
}

export async function testControlPlaneLLMConnection(input: {
  llmPreset: LlmProviderPreset;
  llmBaseUrl: string;
  llmModel: string;
  llmEffort?: ReasoningEffort;
  llmApiKey?: string;
}): Promise<{ ok: boolean; providerName: string; latencyMs: number; message: string }> {
  const started = Date.now();

  if (input.llmPreset === "heuristic") {
    return {
      ok: true,
      providerName: "heuristic:local",
      latencyMs: Date.now() - started,
      message: "Built-in heuristic control plane is ready (zero API cost).",
    };
  }

  if (input.llmPreset === "claude_cli") {
    const cleanModel = sanitizeCliModelName(input.llmModel);
    const label = `cli:claude(${cleanModel ?? "default"},${input.llmEffort ?? "low"})`;
    const bin = Bun.which("claude");
    if (!bin) {
      return {
        ok: false,
        providerName: label,
        latencyMs: Date.now() - started,
        message: "claude CLI not found on PATH.",
      };
    }
    try {
      const { stdout, exitCode: code } = await runSpawnWithTimeout(
        [bin, "auth", "status", "--json"],
        { timeoutMs: 10_000, env: createSanitizedClaudeEnv(), label: "claude auth status" },
      );
      try {
        const parsed = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string };
        if (parsed.loggedIn) {
          return {
            ok: true,
            providerName: label,
            latencyMs: Date.now() - started,
            message: `claude CLI authenticated (${parsed.authMethod ?? "ok"}).`,
          };
        }
      } catch {
        if (code === 0) {
          return {
            ok: true,
            providerName: label,
            latencyMs: Date.now() - started,
            message: "claude CLI authenticated.",
          };
        }
      }
      return {
        ok: false,
        providerName: label,
        latencyMs: Date.now() - started,
        message: "claude CLI is installed but not logged in (run `claude auth login`).",
      };
    } catch (err) {
      return {
        ok: false,
        providerName: label,
        latencyMs: Date.now() - started,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (input.llmPreset === "codex_cli") {
    const rawEffort = input.llmEffort ?? "low";
    const normEffort = rawEffort === "max" ? "xhigh" : rawEffort;
    const cleanModel = sanitizeCliModelName(input.llmModel);
    const label = `cli:codex(${cleanModel ?? "default"},${normEffort})`;
    const bin = Bun.which("codex");
    if (!bin) {
      return {
        ok: false,
        providerName: label,
        latencyMs: Date.now() - started,
        message: "codex CLI not found on PATH.",
      };
    }
    try {
      const { stdout, stderr, exitCode: code } = await runSpawnWithTimeout(
        [bin, "login", "status"],
        { timeoutMs: 10_000, label: "codex login status" },
      );
      if (code === 0) {
        return {
          ok: true,
          providerName: label,
          latencyMs: Date.now() - started,
          message: (stdout || stderr).trim() || "codex CLI authenticated.",
        };
      }
      return {
        ok: false,
        providerName: label,
        latencyMs: Date.now() - started,
        message: "codex CLI is installed but not logged in (run `codex login`).",
      };
    } catch (err) {
      return {
        ok: false,
        providerName: label,
        latencyMs: Date.now() - started,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const apiKey = input.llmApiKey?.trim();
  if (!apiKey) {
    return {
      ok: false,
      providerName: `${input.llmPreset}:${input.llmModel}`,
      latencyMs: Date.now() - started,
      message: "API Key is required for this provider.",
    };
  }

  const baseUrl =
    input.llmBaseUrl.trim().replace(/\/$/, "") ||
    (input.llmPreset === "deepseek" ? "https://api.deepseek.com/v1" : "https://api.openai.com/v1");
  const model =
    input.llmModel.trim() || (input.llmPreset === "deepseek" ? "deepseek-chat" : "gpt-4o-mini");

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        temperature: 0,
        messages: [{ role: "user", content: 'Reply with JSON {"ok":true}' }],
      }),
      signal: AbortSignal.timeout(10_000),
    });

    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const errText = await res.text();
      return {
        ok: false,
        providerName: `${input.llmPreset}:${model}`,
        latencyMs,
        message: `HTTP ${res.status}: ${errText.slice(0, 180)}`,
      };
    }

    return {
      ok: true,
      providerName: `${input.llmPreset}:${model}`,
      latencyMs,
      message: `Connected to ${model} in ${latencyMs}ms.`,
    };
  } catch (err) {
    return {
      ok: false,
      providerName: `${input.llmPreset}:${model}`,
      latencyMs: Date.now() - started,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

