import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHeuristicSpecClarification,
  getAlternateEngine,
  heuristicDecomposeEpic,
  heuristicDistillPlaybookLesson,
  normalizeEpicDecompositionPlan,
} from "@super-work/core";
import type {
  ControlPlaneLLM,
  EpicDecompositionPlan,
  LlmProviderPreset,
  MemorySearchHit,
  PipelineTemplateId,
  ReasoningEffort,
  RepoConfig,
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

export interface OpenAICompatibleConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  providerLabel?: string;
  timeoutMs?: number;
}

const DEFAULT_CONTROL_PLANE_TIMEOUT_MS = 20_000;
const DEFAULT_HTTP_LLM_TIMEOUT_MS = 25_000;
const PLACEHOLDER_CLI_MODELS = new Set(["claude-cli", "codex-cli", "heuristic", "default"]);

export function sanitizeCliModelName(model?: string): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  if (PLACEHOLDER_CLI_MODELS.has(trimmed.toLowerCase())) return undefined;
  return trimmed;
}

export function createSanitizedClaudeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

export function buildClaudeControlPlaneArgs(input: {
  prompt: string;
  schema: Record<string, unknown>;
  model?: string;
  effort: ReasoningEffort;
}): string[] {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--tools",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--effort",
    input.effort,
    "--json-schema",
    JSON.stringify(input.schema),
  ];
  const cleanModel = sanitizeCliModelName(input.model);
  if (cleanModel) {
    args.push("--model", cleanModel);
  }
  args.push(input.prompt);
  return args;
}

function resolveExecutable(bin: string): string | null {
  if (bin.includes("/")) {
    return existsSync(bin) ? bin : null;
  }
  return Bun.which(bin);
}

async function runSpawnWithTimeout(
  cmd: string[],
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv; label: string },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: options.env,
  });

  const stdoutPromise = new Response(proc.stdout).text().catch(() => "");
  const stderrPromise = new Response(proc.stderr).text().catch(() => "");
  const completionPromise = Promise.all([stdoutPromise, stderrPromise, proc.exited]).then(
    ([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode }),
  );
  completionPromise.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {
        // Ignore already exited process
      }
      const killTimer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Ignore already exited process
        }
      }, 250);
      killTimer.unref?.();
      reject(new Error(`${options.label} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
  });

  try {
    return await Promise.race([completionPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    shouldCreateTicket: { type: "boolean" },
    reason: { type: "string" },
    title: { type: "string" },
    description: { type: "string" },
    template: { type: "string", enum: ["fast", "standard", "strict"] },
    allowedPaths: { type: "array", items: { type: "string" } },
    acceptanceCriteria: { type: "array", items: { type: "string" } },
    priority: { type: "number" },
  },
  required: [
    "shouldCreateTicket",
    "reason",
    "title",
    "description",
    "template",
    "allowedPaths",
    "acceptanceCriteria",
    "priority",
  ],
};

const WATCHDOG_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["CONTINUE", "INJECT_HINT", "SWITCH_ENGINE", "ESCALATE_HUMAN"],
    },
    reason: { type: "string" },
    hint: { type: "string" },
    targetEngine: { type: "string", enum: ["claude", "codex", "opencode", "mock"] },
  },
  required: ["action", "reason"],
};

const EPIC_DECOMPOSITION_SCHEMA = {
  type: "object",
  properties: {
    epicTitle: { type: "string" },
    summary: { type: "string" },
    subtasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          repoId: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          template: { type: "string", enum: ["fast", "standard", "strict"] },
          allowedPaths: { type: "array", items: { type: "string" } },
          dependsOnKeys: { type: "array", items: { type: "string" } },
          acceptanceCriteria: { type: "array", items: { type: "string" } },
        },
        required: ["key", "title", "description", "template", "allowedPaths", "dependsOnKeys"],
      },
    },
  },
  required: ["epicTitle", "summary", "subtasks"],
};

const DISTILL_LESSON_SCHEMA = {
  type: "object",
  properties: {
    rule: { type: "string" },
    scopePaths: { type: "array", items: { type: "string" } },
  },
  required: ["rule", "scopePaths"],
};

const HANDOVER_DIGEST_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    exportedSymbols: { type: "array", items: { type: "string" } },
    contractSnippets: { type: "array", items: { type: "string" } },
  },
  required: ["summary"],
};

export class OpenAICompatibleControlLLM implements ControlPlaneLLM {
  readonly providerName: string;

  constructor(private readonly config: OpenAICompatibleConfig) {
    this.providerName = config.providerLabel ?? `api:${config.model}`;
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
    const sys = [
      "You are the Super-agent MasterAssessor / Router.",
      "Decide whether an incoming repository event warrants creating a coding Ticket.",
      "Prefer exact module paths from repoStructure for allowedPaths when available.",
      "Output ONLY valid JSON matching the schema:",
      JSON.stringify(TRIAGE_SCHEMA),
    ].join("\n");

    const user = JSON.stringify({
      repo: {
        name: input.repo.name,
        defaultTemplate: input.repo.defaultTemplate,
      },
      repoStructure: input.repoStructure,
      conventions: input.conventions,
      playbookRules: input.playbookRules,
      trigger: {
        source: input.trigger.source,
        title: input.trigger.title,
        rawText: input.trigger.rawText,
      },
      activeTicketCount: input.activeTickets.length,
      relatedMemory: input.relatedMemory.slice(0, 3),
    });

    const parsed = await this.chatJson<TriageProposal>(sys, user);
    return normalizeTriageProposal(parsed, input.trigger, input.repo.defaultTemplate);
  }

  async diagnoseWatchdog(input: {
    ticket: Ticket;
    stageRun: StageRun;
    signal: WatchdogSignal;
    recentEvents: WorkerStreamEvent[];
    availableEngines: WorkerEngineId[];
  }): Promise<WatchdogDecision> {
    const sys = [
      "You are the Super-agent L2 Watchdog semantic supervisor.",
      "Analyze why a coding worker triggered an L1 health alert and choose CONTINUE, INJECT_HINT, SWITCH_ENGINE, or ESCALATE_HUMAN.",
      "Output ONLY valid JSON matching the schema:",
      JSON.stringify(WATCHDOG_SCHEMA),
    ].join("\n");

    const user = JSON.stringify({
      ticket: { id: input.ticket.id, title: input.ticket.title, stageRetries: input.ticket.stageRetries },
      stage: input.stageRun.stage,
      currentEngine: input.stageRun.engine,
      availableEngines: input.availableEngines,
      signal: input.signal,
      recentEvents: input.recentEvents.slice(-8),
    });

    const parsed = await this.chatJson<WatchdogDecision>(sys, user);
    return normalizeWatchdogDecision(parsed, input.stageRun.engine, input.availableEngines);
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
    const sys = [
      "You are the Super-agent Epic Architect.",
      "Decompose a complex software requirement into 2-6 focused subtasks with disjoint Mandate allowedPaths matching the real repository structure whenever possible so independent workers execute concurrently in separate worktrees.",
      "When availableRepos contains multiple repositories and the requirement spans repositories, assign subtask.repoId to the target repo ID and use paths inside that repository.",
      "Only add dependsOnKeys when a subtask genuinely consumes contracts/APIs built by another subtask.",
      "Output ONLY valid JSON matching the schema:",
      JSON.stringify(EPIC_DECOMPOSITION_SCHEMA),
    ].join("\n");

    const user = JSON.stringify({
      repo: { id: input.repo.id, name: input.repo.name, baseBranch: input.repo.baseBranch },
      availableRepos: input.availableRepos,
      repoStructure: input.repoStructure,
      conventions: input.conventions,
      playbookRules: input.playbookRules,
      title: input.title,
      description: input.description,
      defaultTemplate: input.defaultTemplate,
    });

    const parsed = await this.chatJson<Partial<EpicDecompositionPlan>>(sys, user);
    return normalizeEpicDecompositionPlan(parsed, input);
  }

  async distillPlaybookLesson(input: {
    repo: RepoConfig;
    ticket: Ticket;
    failureKind: "verification" | "smoke" | "review";
    failureSummary: string;
    fixSummary: string;
    changedFiles: string[];
  }): Promise<{ rule: string; scopePaths: string[] } | null> {
    const sys = [
      "Distill a single reusable, concise engineering guardrail rule (<= 180 chars) from a resolved verification, runtime smoke, or code review failure.",
      "Output ONLY valid JSON matching:",
      JSON.stringify(DISTILL_LESSON_SCHEMA),
    ].join("\n");
    const user = JSON.stringify({
      repo: input.repo.name,
      ticketTitle: input.ticket.title,
      failureKind: input.failureKind,
      failureSummary: input.failureSummary.slice(0, 500),
      fixSummary: input.fixSummary.slice(0, 400),
      changedFiles: input.changedFiles.slice(0, 8),
    });
    const parsed = await this.chatJson<{ rule?: string; scopePaths?: string[] }>(sys, user);
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
    const sys = [
      "Summarize the exported API, route, schema, or behavior contracts introduced by this completed engineering ticket in <= 300 chars so downstream tasks/repos integrate cleanly.",
      "Output ONLY valid JSON matching:",
      JSON.stringify(HANDOVER_DIGEST_SCHEMA),
    ].join("\n");
    const user = JSON.stringify({
      repo: input.repo.name,
      ticketTitle: input.ticket.title,
      changedFiles: input.changedFiles.slice(0, 12),
      exportedSymbols: input.exportedSymbols,
      contractSnippets: input.contractSnippets,
      stageSummary: input.stageSummary.slice(0, 500),
      diffExcerpt: input.diffExcerpt.slice(0, 3500),
    });
    const parsed = await this.chatJson<{
      summary?: string;
      exportedSymbols?: string[];
      contractSnippets?: string[];
    }>(sys, user);
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

  async clarifySpec(input: {
    repo: RepoConfig;
    title: string;
    description: string;
    defaultTemplate: PipelineTemplateId;
    repoStructure?: string;
    playbookRules?: string;
    casebookContext?: string;
    conventions?: string;
  }): Promise<SpecClarificationResult> {
    const baseline = buildHeuristicSpecClarification(input);
    const sys = [
      "You are the Super-agent Pre-Flight Spec Architect.",
      "Clarify an engineering task using real repository paths, conventions, playbook rules, and historical cases.",
      "Output ONLY valid JSON with keys: recommendedDispatchMode ('single'|'epic'), recommendedTemplate ('fast'|'standard'|'strict'), refinedTitle, refinedDescription, suggestedAllowedPaths (string[]), acceptanceCriteria (string[]), matchedFiles (string[]), questions (array of {id, question, options, recommendedIndex}, max 3), rationale.",
    ].join("\n");
    const user = JSON.stringify({
      repo: { id: input.repo.id, name: input.repo.name, defaultTemplate: input.defaultTemplate },
      repoStructure: input.repoStructure,
      conventions: input.conventions,
      playbookRules: input.playbookRules,
      casebookContext: input.casebookContext,
      title: input.title,
      description: input.description,
    });
    const parsed = await this.chatJson<Partial<SpecClarificationResult>>(sys, user);
    return {
      ...baseline,
      recommendedDispatchMode:
        parsed.recommendedDispatchMode === "epic" || parsed.recommendedDispatchMode === "single"
          ? parsed.recommendedDispatchMode
          : baseline.recommendedDispatchMode,
      recommendedTemplate:
        parsed.recommendedTemplate === "fast" ||
        parsed.recommendedTemplate === "standard" ||
        parsed.recommendedTemplate === "strict"
          ? parsed.recommendedTemplate
          : baseline.recommendedTemplate,
      refinedTitle: parsed.refinedTitle?.trim() || baseline.refinedTitle,
      refinedDescription: parsed.refinedDescription?.trim() || baseline.refinedDescription,
      suggestedAllowedPaths:
        Array.isArray(parsed.suggestedAllowedPaths) && parsed.suggestedAllowedPaths.length > 0
          ? parsed.suggestedAllowedPaths.map(String)
          : baseline.suggestedAllowedPaths,
      acceptanceCriteria:
        Array.isArray(parsed.acceptanceCriteria) && parsed.acceptanceCriteria.length > 0
          ? parsed.acceptanceCriteria.map(String)
          : baseline.acceptanceCriteria,
      matchedFiles:
        Array.isArray(parsed.matchedFiles) && parsed.matchedFiles.length > 0
          ? parsed.matchedFiles.map(String)
          : baseline.matchedFiles,
      questions:
        Array.isArray(parsed.questions) && parsed.questions.length > 0
          ? parsed.questions.slice(0, 3).map((q, idx) => ({
              id: String(q.id || `q_${idx + 1}`),
              question: String(q.question || "Confirm detail"),
              options: Array.isArray(q.options) && q.options.length > 0 ? q.options.map(String) : ["Yes"],
              recommendedIndex: typeof q.recommendedIndex === "number" ? q.recommendedIndex : 0,
            }))
          : baseline.questions,
      rationale: parsed.rationale?.trim() || baseline.rationale,
    };
  }

  private async chatJson<T>(systemPrompt: string, userPrompt: string): Promise<T> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? DEFAULT_HTTP_LLM_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`ControlPlaneLLM HTTP ${res.status}: ${body.slice(0, 300)}`);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("ControlPlaneLLM returned empty content");
    }
    return extractJsonObject<T>(content);
  }
}

export class CliFallbackControlLLM implements ControlPlaneLLM {
  readonly providerName: string;
  private readonly claudeBin: string;
  private readonly model?: string;
  private readonly effort: ReasoningEffort;
  private readonly timeoutMs: number;

  constructor(options?: {
    claudeBin?: string;
    model?: string;
    effort?: ReasoningEffort;
    timeoutMs?: number;
  }) {
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
  }): Promise<TriageProposal> {
    const prompt = [
      "Evaluate this development trigger and return structured JSON triage proposal.",
      `Repo: ${input.repo.name}, DefaultTemplate: ${input.repo.defaultTemplate}`,
      input.repoStructure ? `RepoStructure:\n${input.repoStructure}` : "",
      input.conventions ? `Conventions:\n${input.conventions}` : "",
      input.playbookRules ? `Playbook:\n${input.playbookRules}` : "",
      `Source: ${input.trigger.source}, Title: ${input.trigger.title}`,
      `Body: ${input.trigger.rawText}`,
    ]
      .filter(Boolean)
      .join("\n");
    const parsed = await this.runClaudeJson<TriageProposal>(prompt, TRIAGE_SCHEMA);
    return normalizeTriageProposal(parsed, input.trigger, input.repo.defaultTemplate);
  }

  async diagnoseWatchdog(input: {
    ticket: Ticket;
    stageRun: StageRun;
    signal: WatchdogSignal;
    recentEvents: WorkerStreamEvent[];
    availableEngines: WorkerEngineId[];
  }): Promise<WatchdogDecision> {
    const prompt = [
      "Evaluate Watchdog L1 alert and return JSON decision.",
      `Ticket: ${input.ticket.title}, Stage: ${input.stageRun.stage}, Engine: ${input.stageRun.engine}`,
      `Signal: ${input.signal.kind} — ${input.signal.details}`,
      `AvailableEngines: ${input.availableEngines.join(", ")}`,
    ].join("\n");
    const parsed = await this.runClaudeJson<WatchdogDecision>(prompt, WATCHDOG_SCHEMA);
    return normalizeWatchdogDecision(parsed, input.stageRun.engine, input.availableEngines);
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
    const prompt = [
      "Decompose this Epic requirement into a DAG of scoped subtasks with disjoint allowedPaths aligned to the real repository structure where independent. Assign repoId if spanning availableRepos.",
      `Repo: ${input.repo.name} (${input.repo.id}), DefaultTemplate: ${input.defaultTemplate}`,
      input.availableRepos && input.availableRepos.length > 1
        ? `AvailableRepos: ${JSON.stringify(input.availableRepos)}`
        : "",
      input.repoStructure ? `RepoStructure:\n${input.repoStructure}` : "",
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
    return normalizeEpicDecompositionPlan(parsed, input);
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

  private async runClaudeJson<T>(prompt: string, schema: Record<string, unknown>): Promise<T> {
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
      env: createSanitizedClaudeEnv(),
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

  constructor(options?: {
    codexBin?: string;
    model?: string;
    effort?: ReasoningEffort;
    timeoutMs?: number;
  }) {
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
  }): Promise<TriageProposal> {
    const prompt = [
      "Evaluate this development trigger and return structured JSON triage proposal.",
      `Repo: ${input.repo.name}, DefaultTemplate: ${input.repo.defaultTemplate}`,
      input.repoStructure ? `RepoStructure:\n${input.repoStructure}` : "",
      input.conventions ? `Conventions:\n${input.conventions}` : "",
      input.playbookRules ? `Playbook:\n${input.playbookRules}` : "",
      `Source: ${input.trigger.source}, Title: ${input.trigger.title}`,
      `Body: ${input.trigger.rawText}`,
    ]
      .filter(Boolean)
      .join("\n");
    const parsed = await this.runCodexJson<TriageProposal>(prompt, TRIAGE_SCHEMA);
    return normalizeTriageProposal(parsed, input.trigger, input.repo.defaultTemplate);
  }

  async diagnoseWatchdog(input: {
    ticket: Ticket;
    stageRun: StageRun;
    signal: WatchdogSignal;
    recentEvents: WorkerStreamEvent[];
    availableEngines: WorkerEngineId[];
  }): Promise<WatchdogDecision> {
    const prompt = [
      "Evaluate Watchdog L1 alert and return JSON decision.",
      `Ticket: ${input.ticket.title}, Stage: ${input.stageRun.stage}, Engine: ${input.stageRun.engine}`,
      `Signal: ${input.signal.kind} — ${input.signal.details}`,
      `AvailableEngines: ${input.availableEngines.join(", ")}`,
    ].join("\n");
    const parsed = await this.runCodexJson<WatchdogDecision>(prompt, WATCHDOG_SCHEMA);
    return normalizeWatchdogDecision(parsed, input.stageRun.engine, input.availableEngines);
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
    const prompt = [
      "Decompose this Epic requirement into a DAG of scoped subtasks with disjoint allowedPaths aligned to the real repository structure where independent. Assign repoId if spanning availableRepos.",
      `Repo: ${input.repo.name} (${input.repo.id}), DefaultTemplate: ${input.defaultTemplate}`,
      input.availableRepos && input.availableRepos.length > 1
        ? `AvailableRepos: ${JSON.stringify(input.availableRepos)}`
        : "",
      input.repoStructure ? `RepoStructure:\n${input.repoStructure}` : "",
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
    return normalizeEpicDecompositionPlan(parsed, input);
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

export class HeuristicControlLLM implements ControlPlaneLLM {
  readonly providerName = "heuristic:local";

  async triageTrigger(input: {
    repo: RepoConfig;
    trigger: Trigger;
    activeTickets?: Ticket[];
    relatedMemory?: MemorySearchHit[];
    repoStructure?: string;
  }): Promise<TriageProposal> {
    const text = `${input.trigger.title}\n${input.trigger.rawText}`;
    const lower = text.toLowerCase();

    // Skip trivial non-actionable noise comments
    if (/^(lgtm|thanks|thank you|\+1|ping)\s*[!.]*$/i.test(input.trigger.rawText.trim())) {
      return {
        shouldCreateTicket: false,
        reason: "Ignored conversational acknowledgement with no actionable engineering work",
        title: input.trigger.title,
        description: input.trigger.rawText,
        template: input.repo.defaultTemplate,
        allowedPaths: ["**"],
        acceptanceCriteria: [],
        priority: 1,
      };
    }

    const explicitScope = text.match(/scope:([^\s,;]+)/i)?.[1];
    const pathMatches = text.match(/(?:packages|src|apps|docs|test)\/[a-zA-Z0-9_./*-]+/g) ?? [];
    const structureMatches: string[] = [];
    if (!explicitScope && pathMatches.length === 0 && input.repoStructure) {
      const mods = Array.from(
        input.repoStructure.matchAll(/^\s*-\s+([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)?)/gm),
      ).map((m) => m[1]!.replace(/\/+$/, ""));
      for (const mod of mods) {
        const leaf = mod.split("/").pop() ?? mod;
        if (leaf.length >= 3 && new RegExp(`\\b${leaf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(lower)) {
          structureMatches.push(`${mod}/**`);
        }
      }
    }
    const allowedPaths = explicitScope
      ? [explicitScope]
      : pathMatches.length > 0
        ? Array.from(new Set(pathMatches)).slice(0, 4)
        : structureMatches.length > 0
          ? Array.from(new Set(structureMatches)).slice(0, 4)
          : ["**"];

    const isFast =
      lower.includes("typo") ||
      lower.includes("readme") ||
      lower.includes("quickfix") ||
      lower.includes("hotfix");
    const isStrict =
      lower.includes("security") ||
      lower.includes("auth") ||
      lower.includes("migration") ||
      lower.includes("payment");

    const template: PipelineTemplateId = isStrict
      ? "strict"
      : isFast
        ? "fast"
        : input.repo.defaultTemplate;

    const priority = lower.includes("ci") || lower.includes("urgent") || lower.includes("crash") ? 2 : 1;

    return {
      shouldCreateTicket: true,
      reason: `Triaged ${input.trigger.source} event into ${template} pipeline (scope: ${allowedPaths.join(", ")})`,
      title: input.trigger.title,
      description: input.trigger.rawText,
      template,
      allowedPaths,
      acceptanceCriteria: [
        "All changes remain inside authorized Mandate paths",
        "Relevant checks/tests pass before delivery",
      ],
      priority,
    };
  }

  async diagnoseWatchdog(input: {
    ticket: Ticket;
    stageRun: StageRun;
    signal: WatchdogSignal;
    availableEngines: WorkerEngineId[];
  }): Promise<WatchdogDecision> {
    if (input.signal.kind === "hard_budget_exceeded") {
      return { action: "ESCALATE_HUMAN", reason: input.signal.details };
    }

    const alt = getAlternateEngine(input.stageRun.engine, input.availableEngines);
    if (
      (input.signal.kind === "repeated_error" || input.signal.kind === "diff_oscillation") &&
      alt &&
      input.ticket.stageRetries === 0
    ) {
      return {
        action: "SWITCH_ENGINE",
        reason: `${input.signal.kind} detected on ${input.stageRun.engine}; switching to ${alt}`,
        targetEngine: alt,
        hint: `Previous engine (${input.stageRun.engine}) hit ${input.signal.kind}: ${input.signal.details}. Take a fresh approach.`,
      };
    }

    if (input.ticket.stageRetries < input.ticket.mandate.maxStageRetries) {
      return {
        action: "INJECT_HINT",
        reason: `Injecting corrective hint after ${input.signal.kind}`,
        hint: `Watchdog alert (${input.signal.kind}): ${input.signal.details}. Stop repeating failing steps and verify assumptions.`,
      };
    }

    return {
      action: "ESCALATE_HUMAN",
      reason: `Retries exhausted after ${input.signal.kind}: ${input.signal.details}`,
    };
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
    return heuristicDistillPlaybookLesson({
      failureKind: input.failureKind,
      failureSummary: input.failureSummary,
      fixSummary: input.fixSummary,
      changedFiles: input.changedFiles,
      allowedPaths: input.ticket.mandate.allowedPaths,
    });
  }

  async distillHandoverDigest(): Promise<null> {
    return null;
  }

  async clarifySpec(input: {
    repo: RepoConfig;
    title: string;
    description: string;
    defaultTemplate: PipelineTemplateId;
    repoStructure?: string;
  }): Promise<SpecClarificationResult> {
    return buildHeuristicSpecClarification(input);
  }
}

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

export function buildControlPlaneLLMFromSetup(config?: SystemSetupConfig | null): ControlPlaneLLM {
  if (!config || !config.initialized) {
    return createControlPlaneLLMFromEnv();
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
  }): Promise<TriageProposal> {
    return this.current.triageTrigger(input);
  }

  diagnoseWatchdog(input: {
    ticket: Ticket;
    stageRun: StageRun;
    signal: WatchdogSignal;
    recentEvents: WorkerStreamEvent[];
    availableEngines: WorkerEngineId[];
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
  }): Promise<SpecClarificationResult> {
    if (this.current.clarifySpec) {
      return this.current.clarifySpec(input);
    }
    return Promise.resolve(buildHeuristicSpecClarification(input));
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

function extractJsonObject<T>(raw: string): T {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  return JSON.parse(candidate) as T;
}

function normalizeTriageProposal(
  raw: Partial<TriageProposal>,
  trigger: Trigger,
  defaultTemplate: PipelineTemplateId,
): TriageProposal {
  const tpl =
    raw.template === "fast" || raw.template === "standard" || raw.template === "strict"
      ? raw.template
      : defaultTemplate;
  return {
    shouldCreateTicket: raw.shouldCreateTicket ?? true,
    reason: raw.reason || "Triaged by ControlPlaneLLM",
    title: raw.title || trigger.title,
    description: raw.description || trigger.rawText,
    template: tpl,
    allowedPaths:
      Array.isArray(raw.allowedPaths) && raw.allowedPaths.length > 0
        ? raw.allowedPaths.map(String)
        : ["**"],
    acceptanceCriteria: Array.isArray(raw.acceptanceCriteria)
      ? raw.acceptanceCriteria.map(String)
      : [],
    priority: typeof raw.priority === "number" ? raw.priority : 1,
  };
}

function normalizeWatchdogDecision(
  raw: Partial<WatchdogDecision>,
  currentEngine: WorkerEngineId,
  availableEngines: WorkerEngineId[],
): WatchdogDecision {
  const validActions = new Set(["CONTINUE", "INJECT_HINT", "SWITCH_ENGINE", "ESCALATE_HUMAN"]);
  const action =
    raw.action && validActions.has(raw.action) ? raw.action : "ESCALATE_HUMAN";
  const targetEngine =
    raw.targetEngine && availableEngines.includes(raw.targetEngine)
      ? raw.targetEngine
      : action === "SWITCH_ENGINE"
        ? getAlternateEngine(currentEngine, availableEngines)
        : undefined;

  return {
    action,
    reason: raw.reason || "Watchdog semantic diagnosis",
    hint: raw.hint,
    targetEngine,
  };
}
