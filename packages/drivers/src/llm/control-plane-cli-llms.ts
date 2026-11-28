import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeEpicDecompositionPlan, normalizeRequirementIntakePlan } from "@super-work/core";
import type {
  CampaignDirection,
  ControlPlaneLLM,
  ControlProbeStep,
  EpicDecompositionPlan,
  MemorySearchHit,
  PipelineTemplateId,
  ReasoningEffort,
  RepoConfig,
  RepoProbeContextPack,
  RepoProbeExecutor,
  RequirementIntakePlan,
  StageRun,
  Ticket,
  TriageProposal,
  Trigger,
  WatchdogDecision,
  WatchdogSignal,
  WorkerEngineId,
  WorkerStreamEvent,
} from "@super-work/core";
import { WORKER_MANDATE_ROUTER_RULE } from "./worker-mandate-rule.ts";
import {
  DEFAULT_CONTROL_PLANE_TIMEOUT_MS,
  EPIC_DECOMPOSITION_SCHEMA,
  DISTILL_LESSON_SCHEMA,
  HANDOVER_DIGEST_SCHEMA,
  CHIEF_ANSWER_SCHEMA,
  REQUIREMENT_INTAKE_SCHEMA,
  TRIAGE_SCHEMA,
  WATCHDOG_SCHEMA,
  buildClaudeControlPlaneArgs,
  createSanitizedClaudeEnv,
  extractJsonObject,
  normalizeTriageProposal,
  normalizeWatchdogDecision,
  resolveExecutable,
  runSpawnWithTimeout,
  sanitizeCliModelName,
} from "./control-plane-helpers.ts";

export class CliFallbackControlLLM implements ControlPlaneLLM {
  readonly providerName: string;
  protected readonly claudeBin: string;
  protected readonly model?: string;
  protected readonly effort: ReasoningEffort;
  protected readonly timeoutMs: number;
  /** Relay overrides (custom baseUrl/apiKey) merged onto the sanitized process env. */
  protected readonly extraEnv?: NodeJS.ProcessEnv;

  constructor(options?: {
    claudeBin?: string;
    model?: string;
    effort?: ReasoningEffort;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  }) {
    this.extraEnv = options?.env;
    this.claudeBin = options?.claudeBin ?? "claude";
    this.model = sanitizeCliModelName(options?.model);
    this.effort = options?.effort ?? "low";
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_CONTROL_PLANE_TIMEOUT_MS;
    this.providerName = `cli:claude(${this.model ?? "default"},${this.effort})`;
  }

  async triageTrigger(input: {
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
    const prompt = [
      "Evaluate this development trigger and return structured JSON triage proposal.",
      `Repo: ${input.repo.name}, DefaultTemplate: ${input.repo.defaultTemplate}`,
      input.repoStructure ? `RepoStructure:\n${input.repoStructure}` : "",
      input.probeContext?.deterministicSummary
        ? `ProbeEvidence:\n${input.probeContext.deterministicSummary}`
        : "",
      input.conventions ? `Conventions:\n${input.conventions}` : "",
      input.playbookRules ? `Playbook:\n${input.playbookRules}` : "",
      `Source: ${input.trigger.source}, Title: ${input.trigger.title}`,
      `Body: ${input.trigger.rawText}`,
    ]
      .filter(Boolean)
      .join("\n");
    const parsed = await this.runClaudeJson<TriageProposal>(prompt, TRIAGE_SCHEMA);
    const norm = normalizeTriageProposal(parsed, input.trigger, input.repo.defaultTemplate);
    return input.probeContext?.probeSteps.length
      ? { ...norm, probeSteps: input.probeContext.probeSteps }
      : norm;
  }

  async diagnoseWatchdog(input: {
    ticket: Ticket;
    stageRun: StageRun;
    signal: WatchdogSignal;
    recentEvents: WorkerStreamEvent[];
    availableEngines: WorkerEngineId[];
    probeContext?: RepoProbeContextPack;
    probeExecutor?: RepoProbeExecutor;
  }): Promise<WatchdogDecision> {
    const prompt = [
      "Evaluate Watchdog L1 alert and return JSON decision.",
      `Ticket: ${input.ticket.title}, Stage: ${input.stageRun.stage}, Engine: ${input.stageRun.engine}`,
      `Signal: ${input.signal.kind} — ${input.signal.details}`,
      `AvailableEngines: ${input.availableEngines.join(", ")}`,
      input.probeContext?.deterministicSummary
        ? `ProbeEvidence:\n${input.probeContext.deterministicSummary}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    const parsed = await this.runClaudeJson<WatchdogDecision>(prompt, WATCHDOG_SCHEMA);
    const norm = normalizeWatchdogDecision(parsed, input.stageRun.engine, input.availableEngines);
    return input.probeContext?.probeSteps.length
      ? { ...norm, probeSteps: input.probeContext.probeSteps }
      : norm;
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
    probeContext?: RepoProbeContextPack;
    probeExecutor?: RepoProbeExecutor;
  }): Promise<EpicDecompositionPlan> {
    const prompt = [
      "Decompose this Epic requirement into a DAG of scoped subtasks with disjoint allowedPaths aligned to the real repository structure where independent. Assign repoId if spanning availableRepos.",
      `Repo: ${input.repo.name} (${input.repo.id}), DefaultTemplate: ${input.defaultTemplate}`,
      input.availableRepos && input.availableRepos.length > 1
        ? `AvailableRepos: ${JSON.stringify(input.availableRepos)}`
        : "",
      input.repoStructure ? `RepoStructure:\n${input.repoStructure}` : "",
      input.probeContext?.deterministicSummary
        ? `ProbeEvidence:\n${input.probeContext.deterministicSummary}`
        : "",
      input.conventions ? `Conventions:\n${input.conventions}` : "",
      input.playbookRules ? `Playbook:\n${input.playbookRules}` : "",
      `Title: ${input.title}`,
      `Description: ${input.description}`,
    ]
      .filter(Boolean)
      .join("\n");
    const parsed = await this.runClaudeJson<Partial<EpicDecompositionPlan>>(
      prompt,
      EPIC_DECOMPOSITION_SCHEMA,
    );
    const norm = normalizeEpicDecompositionPlan(parsed, input);
    return input.probeContext?.probeSteps.length
      ? { ...norm, probeSteps: input.probeContext.probeSteps }
      : norm;
  }

  async distillPlaybookLesson(input: {
    repo: RepoConfig;
    ticket: Ticket;
    failureKind: "verification" | "smoke" | "review";
    failureSummary: string;
    fixSummary: string;
    changedFiles: string[];
  }): Promise<{ rule: string; scopePaths: string[] } | null> {
    const prompt = [
      "Distill a single concise engineering guardrail rule (<= 180 chars) from this resolved failure.",
      `Repo: ${input.repo.name}, Ticket: ${input.ticket.title}, Kind: ${input.failureKind}`,
      `Failure: ${input.failureSummary.slice(0, 400)}`,
      `Fix: ${input.fixSummary.slice(0, 300)}`,
      `Files: ${input.changedFiles.slice(0, 6).join(", ")}`,
    ].join("\n");
    const parsed = await this.runClaudeJson<{ rule?: string; scopePaths?: string[] }>(
      prompt,
      DISTILL_LESSON_SCHEMA,
    );
    if (!parsed.rule?.trim()) return null;
    return {
      rule: parsed.rule.trim(),
      scopePaths:
        Array.isArray(parsed.scopePaths) && parsed.scopePaths.length > 0
          ? parsed.scopePaths.map(String)
          : input.ticket.mandate.allowedPaths,
    };
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
    const prompt = [
      "Summarize the API/schema/behavior contract produced by this completed ticket in <= 300 chars for downstream integration.",
      `Repo: ${input.repo.name}, Ticket: ${input.ticket.title}`,
      `ChangedFiles: ${input.changedFiles.slice(0, 12).join(", ")}`,
      `ExportedSymbols: ${input.exportedSymbols.join(" | ")}`,
      `Contracts: ${input.contractSnippets.join(" | ")}`,
      `StageSummary: ${input.stageSummary.slice(0, 400)}`,
    ].join("\n");
    const parsed = await this.runClaudeJson<{
      summary?: string;
      exportedSymbols?: string[];
      contractSnippets?: string[];
    }>(prompt, HANDOVER_DIGEST_SCHEMA);
    if (!parsed.summary?.trim()) return null;
    return {
      summary: parsed.summary.trim(),
      exportedSymbols: Array.isArray(parsed.exportedSymbols)
        ? parsed.exportedSymbols.map(String)
        : undefined,
      contractSnippets: Array.isArray(parsed.contractSnippets)
        ? parsed.contractSnippets.map(String)
        : undefined,
    };
  }

  async answerChiefQuestion(input: {
    question: string;
    contextSummary: string;
    probeContext?: RepoProbeContextPack;
  }): Promise<{ answer: string; highlights?: string[]; probeSteps?: ControlProbeStep[] }> {
    const prompt = [
      "You are the Super-agent Chief-of-Staff engineering advisor. Answer accurately and concisely using telemetry and probe context.",
      `Question: ${input.question}`,
      `Context:\n${input.contextSummary}`,
    ].join("\n\n");
    const parsed = await this.runClaudeJson<{ answer?: string; highlights?: string[] }>(
      prompt,
      CHIEF_ANSWER_SCHEMA,
    );
    return {
      answer: parsed.answer?.trim() || input.contextSummary,
      highlights: Array.isArray(parsed.highlights) ? parsed.highlights.map(String) : undefined,
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
    metricHint?: {
      metricCommand?: string;
      targetValue?: number;
      direction?: CampaignDirection;
      metricUnit?: string;
      metricRegex?: string;
    };
  }): Promise<RequirementIntakePlan> {
    const prompt = [
      "Route a raw software requirement to `single_ticket`, `epic_dag`, or `goal_campaign` (only choose `goal_campaign` when a valid metricCommand and numeric targetValue exist). Narrow allowedPaths using real repo structure. " + WORKER_MANDATE_ROUTER_RULE,
      `Repo: ${input.repo.name} (${input.repo.id}), DefaultTemplate: ${input.defaultTemplate}`,
      input.availableRepos && input.availableRepos.length > 1
        ? `AvailableRepos: ${JSON.stringify(input.availableRepos)}`
        : "",
      input.repoStructure ? `RepoStructure:\n${input.repoStructure}` : "",
      input.probeContext?.deterministicSummary
        ? `ProbeEvidence:\n${input.probeContext.deterministicSummary}`
        : "",
      input.conventions ? `Conventions:\n${input.conventions}` : "",
      input.playbookRules ? `Playbook:\n${input.playbookRules}` : "",
      input.metricHint ? `MetricHint: ${JSON.stringify(input.metricHint)}` : "",
      `Title: ${input.title}`,
      `Requirement: ${input.requirement}`,
    ]
      .filter(Boolean)
      .join("\n");
    const parsed = await this.runClaudeJson<Partial<RequirementIntakePlan>>(
      prompt,
      REQUIREMENT_INTAKE_SCHEMA,
    );
    return normalizeRequirementIntakePlan(parsed, input);
  }

  protected async runClaudeJson<T>(prompt: string, schema: Record<string, unknown>): Promise<T> {
    const resolvedBin = resolveExecutable(this.claudeBin);
    if (!resolvedBin) {
      throw new Error("claude CLI not found on PATH");
    }
    const args = buildClaudeControlPlaneArgs({
      prompt,
      schema,
      model: this.model,
      effort: this.effort,
    });

    const { stdout, stderr, exitCode } = await runSpawnWithTimeout([resolvedBin, ...args], {
      timeoutMs: this.timeoutMs,
      env: { ...createSanitizedClaudeEnv(), ...this.extraEnv },
      label: "Claude CLI ControlPlaneLLM",
    });
    if (exitCode !== 0) {
      throw new Error(`CLI LLM failed (${exitCode}): ${stderr.slice(0, 200)}`);
    }
    const envelope = JSON.parse(stdout) as { structured_output?: T; result?: string };
    if (envelope.structured_output) {
      return envelope.structured_output;
    }
    if (envelope.result) {
      return extractJsonObject<T>(envelope.result);
    }
    throw new Error("CLI LLM returned no structured output");
  }
}

export class CodexCliControlLLM implements ControlPlaneLLM {
  readonly providerName: string;
  private readonly codexBin: string;
  private readonly model?: string;
  private readonly effort: "low" | "medium" | "high" | "xhigh";
  private readonly timeoutMs: number;
  private readonly extraEnv?: NodeJS.ProcessEnv;

  constructor(options?: {
    codexBin?: string;
    model?: string;
    effort?: ReasoningEffort;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  }) {
    this.extraEnv = options?.env;
    this.codexBin = options?.codexBin ?? "codex";
    this.model = sanitizeCliModelName(options?.model);
    const rawEffort = options?.effort ?? "low";
    this.effort = rawEffort === "max" ? "xhigh" : rawEffort;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_CONTROL_PLANE_TIMEOUT_MS;
    this.providerName = `cli:codex(${this.model ?? "default"},${this.effort})`;
  }

  async triageTrigger(input: {
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
    const prompt = [
      "Evaluate this development trigger and return structured JSON triage proposal.",
      `Repo: ${input.repo.name}, DefaultTemplate: ${input.repo.defaultTemplate}`,
      input.repoStructure ? `RepoStructure:\n${input.repoStructure}` : "",
      input.probeContext?.deterministicSummary
        ? `ProbeEvidence:\n${input.probeContext.deterministicSummary}`
        : "",
      input.conventions ? `Conventions:\n${input.conventions}` : "",
      input.playbookRules ? `Playbook:\n${input.playbookRules}` : "",
      `Source: ${input.trigger.source}, Title: ${input.trigger.title}`,
      `Body: ${input.trigger.rawText}`,
    ]
      .filter(Boolean)
      .join("\n");
    const parsed = await this.runCodexJson<TriageProposal>(prompt, TRIAGE_SCHEMA);
    const norm = normalizeTriageProposal(parsed, input.trigger, input.repo.defaultTemplate);
    return input.probeContext?.probeSteps.length
      ? { ...norm, probeSteps: input.probeContext.probeSteps }
      : norm;
  }

  async diagnoseWatchdog(input: {
    ticket: Ticket;
    stageRun: StageRun;
    signal: WatchdogSignal;
    recentEvents: WorkerStreamEvent[];
    availableEngines: WorkerEngineId[];
    probeContext?: RepoProbeContextPack;
    probeExecutor?: RepoProbeExecutor;
  }): Promise<WatchdogDecision> {
    const prompt = [
      "Evaluate Watchdog L1 alert and return JSON decision.",
      `Ticket: ${input.ticket.title}, Stage: ${input.stageRun.stage}, Engine: ${input.stageRun.engine}`,
      `Signal: ${input.signal.kind} — ${input.signal.details}`,
      `AvailableEngines: ${input.availableEngines.join(", ")}`,
      input.probeContext?.deterministicSummary
        ? `ProbeEvidence:\n${input.probeContext.deterministicSummary}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    const parsed = await this.runCodexJson<WatchdogDecision>(prompt, WATCHDOG_SCHEMA);
    const norm = normalizeWatchdogDecision(parsed, input.stageRun.engine, input.availableEngines);
    return input.probeContext?.probeSteps.length
      ? { ...norm, probeSteps: input.probeContext.probeSteps }
      : norm;
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
    probeContext?: RepoProbeContextPack;
    probeExecutor?: RepoProbeExecutor;
  }): Promise<EpicDecompositionPlan> {
    const prompt = [
      "Decompose this Epic requirement into a DAG of scoped subtasks with disjoint allowedPaths aligned to the real repository structure where independent. Assign repoId if spanning availableRepos.",
      `Repo: ${input.repo.name} (${input.repo.id}), DefaultTemplate: ${input.defaultTemplate}`,
      input.availableRepos && input.availableRepos.length > 1
        ? `AvailableRepos: ${JSON.stringify(input.availableRepos)}`
        : "",
      input.repoStructure ? `RepoStructure:\n${input.repoStructure}` : "",
      input.probeContext?.deterministicSummary
        ? `ProbeEvidence:\n${input.probeContext.deterministicSummary}`
        : "",
      input.conventions ? `Conventions:\n${input.conventions}` : "",
      input.playbookRules ? `Playbook:\n${input.playbookRules}` : "",
      `Title: ${input.title}`,
      `Description: ${input.description}`,
    ]
      .filter(Boolean)
      .join("\n");
    const parsed = await this.runCodexJson<Partial<EpicDecompositionPlan>>(
      prompt,
      EPIC_DECOMPOSITION_SCHEMA,
    );
    const norm = normalizeEpicDecompositionPlan(parsed, input);
    return input.probeContext?.probeSteps.length
      ? { ...norm, probeSteps: input.probeContext.probeSteps }
      : norm;
  }

  async distillPlaybookLesson(input: {
    repo: RepoConfig;
    ticket: Ticket;
    failureKind: "verification" | "smoke" | "review";
    failureSummary: string;
    fixSummary: string;
    changedFiles: string[];
  }): Promise<{ rule: string; scopePaths: string[] } | null> {
    const prompt = [
      "Distill a single concise engineering guardrail rule (<= 180 chars) from this resolved failure.",
      `Repo: ${input.repo.name}, Ticket: ${input.ticket.title}, Kind: ${input.failureKind}`,
      `Failure: ${input.failureSummary.slice(0, 400)}`,
      `Fix: ${input.fixSummary.slice(0, 300)}`,
      `Files: ${input.changedFiles.slice(0, 6).join(", ")}`,
    ].join("\n");
    const parsed = await this.runCodexJson<{ rule?: string; scopePaths?: string[] }>(
      prompt,
      DISTILL_LESSON_SCHEMA,
    );
    if (!parsed.rule?.trim()) return null;
    return {
      rule: parsed.rule.trim(),
      scopePaths:
        Array.isArray(parsed.scopePaths) && parsed.scopePaths.length > 0
          ? parsed.scopePaths.map(String)
          : input.ticket.mandate.allowedPaths,
    };
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
    const prompt = [
      "Summarize the API/schema/behavior contract produced by this completed ticket in <= 300 chars for downstream integration.",
      `Repo: ${input.repo.name}, Ticket: ${input.ticket.title}`,
      `ChangedFiles: ${input.changedFiles.slice(0, 12).join(", ")}`,
      `ExportedSymbols: ${input.exportedSymbols.join(" | ")}`,
      `Contracts: ${input.contractSnippets.join(" | ")}`,
      `StageSummary: ${input.stageSummary.slice(0, 400)}`,
    ].join("\n");
    const parsed = await this.runCodexJson<{
      summary?: string;
      exportedSymbols?: string[];
      contractSnippets?: string[];
    }>(prompt, HANDOVER_DIGEST_SCHEMA);
    if (!parsed.summary?.trim()) return null;
    return {
      summary: parsed.summary.trim(),
      exportedSymbols: Array.isArray(parsed.exportedSymbols)
        ? parsed.exportedSymbols.map(String)
        : undefined,
      contractSnippets: Array.isArray(parsed.contractSnippets)
        ? parsed.contractSnippets.map(String)
        : undefined,
    };
  }

  async answerChiefQuestion(input: {
    question: string;
    contextSummary: string;
    probeContext?: RepoProbeContextPack;
  }): Promise<{ answer: string; highlights?: string[]; probeSteps?: ControlProbeStep[] }> {
    const prompt = [
      "You are the Super-agent Chief-of-Staff engineering advisor. Answer accurately and concisely using telemetry and probe context.",
      `Question: ${input.question}`,
      `Context:\n${input.contextSummary}`,
    ].join("\n\n");
    const parsed = await this.runCodexJson<{ answer?: string; highlights?: string[] }>(
      prompt,
      CHIEF_ANSWER_SCHEMA,
    );
    return {
      answer: parsed.answer?.trim() || input.contextSummary,
      highlights: Array.isArray(parsed.highlights) ? parsed.highlights.map(String) : undefined,
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
    metricHint?: {
      metricCommand?: string;
      targetValue?: number;
      direction?: CampaignDirection;
      metricUnit?: string;
      metricRegex?: string;
    };
  }): Promise<RequirementIntakePlan> {
    const prompt = [
      "Route a raw software requirement to `single_ticket`, `epic_dag`, or `goal_campaign` (only choose `goal_campaign` when a valid metricCommand and numeric targetValue exist). Narrow allowedPaths using real repo structure. " + WORKER_MANDATE_ROUTER_RULE,
      `Repo: ${input.repo.name} (${input.repo.id}), DefaultTemplate: ${input.defaultTemplate}`,
      input.availableRepos && input.availableRepos.length > 1
        ? `AvailableRepos: ${JSON.stringify(input.availableRepos)}`
        : "",
      input.repoStructure ? `RepoStructure:\n${input.repoStructure}` : "",
      input.probeContext?.deterministicSummary
        ? `ProbeEvidence:\n${input.probeContext.deterministicSummary}`
        : "",
      input.conventions ? `Conventions:\n${input.conventions}` : "",
      input.playbookRules ? `Playbook:\n${input.playbookRules}` : "",
      input.metricHint ? `MetricHint: ${JSON.stringify(input.metricHint)}` : "",
      `Title: ${input.title}`,
      `Requirement: ${input.requirement}`,
    ]
      .filter(Boolean)
      .join("\n");
    const parsed = await this.runCodexJson<Partial<RequirementIntakePlan>>(
      prompt,
      REQUIREMENT_INTAKE_SCHEMA,
    );
    return normalizeRequirementIntakePlan(parsed, input);
  }

  private async runCodexJson<T>(prompt: string, schema: Record<string, unknown>): Promise<T> {
    const resolvedBin = resolveExecutable(this.codexBin);
    if (!resolvedBin) {
      throw new Error("codex CLI not found on PATH");
    }
    const dir = await mkdtemp(join(tmpdir(), "sw-codex-llm-"));
    const schemaPath = join(dir, "schema.json");
    const outPath = join(dir, "out.json");
    try {
      await writeFile(schemaPath, JSON.stringify({ ...schema, additionalProperties: false }), "utf8");
      const args = [
        resolvedBin,
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "-s",
        "read-only",
        "-c",
        `model_reasoning_effort="${this.effort}"`,
        "--output-schema",
        schemaPath,
        "-o",
        outPath,
      ];
      if (this.model) {
        args.push("-m", this.model);
      }
      args.push(prompt);

      const { stderr, exitCode } = await runSpawnWithTimeout(args, {
        timeoutMs: this.timeoutMs,
        ...(this.extraEnv ? { env: { ...createSanitizedClaudeEnv(), ...this.extraEnv } } : {}),
        label: "Codex CLI ControlPlaneLLM",
      });
      if (exitCode !== 0) {
        throw new Error(`Codex CLI LLM failed (${exitCode}): ${stderr.slice(0, 200)}`);
      }
      const rawOut = await readFile(outPath, "utf8");
      return extractJsonObject<T>(rawOut);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

