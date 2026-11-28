import { join } from "node:path";
import {
  buildHeuristicSpecClarification,
  normalizeEpicDecompositionPlan,
  normalizeRequirementIntakePlan,
} from "@super-work/core";
import type {
  CampaignDirection,
  ControlPlaneLLM,
  ControlProbeStep,
  EpicDecompositionPlan,
  MemorySearchHit,
  PipelineTemplateId,
  RepoConfig,
  RepoProbeContextPack,
  RepoProbeExecutor,
  RequirementIntakePlan,
  SpecClarificationResult,
  StageRun,
  Ticket,
  TriageProposal,
  Trigger,
  WatchdogDecision,
  WatchdogSignal,
  WorkerEngineId,
  WorkerStreamEvent,
} from "@super-work/core";
import {
  DEFAULT_HTTP_LLM_TIMEOUT_MS,
  EPIC_DECOMPOSITION_SCHEMA,
  DISTILL_LESSON_SCHEMA,
  HANDOVER_DIGEST_SCHEMA,
  CHIEF_ANSWER_SCHEMA,
  REQUIREMENT_INTAKE_SCHEMA,
  PROBE_PROMPT_GUIDE,
  TRIAGE_SCHEMA,
  WATCHDOG_SCHEMA,
  extractJsonObject,
  normalizeTriageProposal,
  normalizeWatchdogDecision,
  runWithOptionalProbes,
} from "./control-plane-helpers.ts";
import type { OpenAICompatibleConfig } from "./control-plane-helpers.ts";

export class OpenAICompatibleControlLLM implements ControlPlaneLLM {
  readonly providerName: string;

  constructor(protected readonly config: OpenAICompatibleConfig) {
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
    probeContext?: RepoProbeContextPack;
    probeExecutor?: RepoProbeExecutor;
  }): Promise<TriageProposal> {
    const { result: parsed, probeSteps } = await runWithOptionalProbes<TriageProposal>({
      probeContext: input.probeContext,
      probeExecutor: input.probeExecutor,
      invoke: async (probeTranscript, allowProbes) => {
        const sys = [
          "You are the Super-agent MasterAssessor / Router.",
          "Decide whether an incoming repository event warrants creating a coding Ticket.",
          "Prefer exact module paths from repoStructure and probeEvidence for allowedPaths when available.",
          allowProbes ? PROBE_PROMPT_GUIDE : "",
          "Output ONLY valid JSON matching the schema:",
          JSON.stringify(TRIAGE_SCHEMA),
        ]
          .filter(Boolean)
          .join("\n");

        const user = JSON.stringify({
          repo: {
            name: input.repo.name,
            defaultTemplate: input.repo.defaultTemplate,
          },
          repoStructure: input.repoStructure,
          conventions: input.conventions,
          playbookRules: input.playbookRules,
          probeEvidence: input.probeContext?.deterministicSummary,
          extraProbeFindings: probeTranscript || undefined,
          trigger: {
            source: input.trigger.source,
            title: input.trigger.title,
            rawText: input.trigger.rawText,
          },
          activeTicketCount: input.activeTickets.length,
          relatedMemory: input.relatedMemory.slice(0, 3),
        });
        return this.chatJson<TriageProposal>(sys, user);
      },
    });
    const normalized = normalizeTriageProposal(parsed, input.trigger, input.repo.defaultTemplate);
    return probeSteps.length > 0 ? { ...normalized, probeSteps } : normalized;
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
    const { result: parsed, probeSteps } = await runWithOptionalProbes<WatchdogDecision>({
      probeContext: input.probeContext,
      probeExecutor: input.probeExecutor,
      invoke: async (probeTranscript, allowProbes) => {
        const sys = [
          "You are the Super-agent L2 Watchdog semantic supervisor.",
          "Analyze why a coding worker triggered an L1 health alert and choose CONTINUE, INJECT_HINT, SWITCH_ENGINE, or ESCALATE_HUMAN.",
          allowProbes ? PROBE_PROMPT_GUIDE : "",
          "Output ONLY valid JSON matching the schema:",
          JSON.stringify(WATCHDOG_SCHEMA),
        ]
          .filter(Boolean)
          .join("\n");

        const user = JSON.stringify({
          ticket: {
            id: input.ticket.id,
            title: input.ticket.title,
            stageRetries: input.ticket.stageRetries,
            allowedPaths: input.ticket.mandate.allowedPaths,
          },
          stage: input.stageRun.stage,
          currentEngine: input.stageRun.engine,
          availableEngines: input.availableEngines,
          signal: input.signal,
          recentEvents: input.recentEvents.slice(-8),
          probeEvidence: input.probeContext?.deterministicSummary,
          extraProbeFindings: probeTranscript || undefined,
        });
        return this.chatJson<WatchdogDecision>(sys, user);
      },
    });
    const normalized = normalizeWatchdogDecision(
      parsed,
      input.stageRun.engine,
      input.availableEngines,
    );
    return probeSteps.length > 0 ? { ...normalized, probeSteps } : normalized;
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
    const { result: parsed, probeSteps } = await runWithOptionalProbes<
      Partial<EpicDecompositionPlan>
    >({
      probeContext: input.probeContext,
      probeExecutor: input.probeExecutor,
      invoke: async (probeTranscript, allowProbes) => {
        const sys = [
          "You are the Super-agent Epic Architect.",
          "Decompose a complex software requirement into 2-6 focused subtasks with disjoint Mandate allowedPaths matching the real repository structure whenever possible so independent workers execute concurrently in separate worktrees.",
          "When availableRepos contains multiple repositories and the requirement spans repositories, assign subtask.repoId to the target repo ID and use paths inside that repository.",
          "Only add dependsOnKeys when a subtask genuinely consumes contracts/APIs built by another subtask.",
          allowProbes ? PROBE_PROMPT_GUIDE : "",
          "Output ONLY valid JSON matching the schema:",
          JSON.stringify(EPIC_DECOMPOSITION_SCHEMA),
        ]
          .filter(Boolean)
          .join("\n");

        const user = JSON.stringify({
          repo: { id: input.repo.id, name: input.repo.name, baseBranch: input.repo.baseBranch },
          availableRepos: input.availableRepos,
          repoStructure: input.repoStructure,
          conventions: input.conventions,
          playbookRules: input.playbookRules,
          probeEvidence: input.probeContext?.deterministicSummary,
          extraProbeFindings: probeTranscript || undefined,
          title: input.title,
          description: input.description,
          defaultTemplate: input.defaultTemplate,
        });
        return this.chatJson<Partial<EpicDecompositionPlan>>(sys, user);
      },
    });
    const normalized = normalizeEpicDecompositionPlan(parsed, input);
    return probeSteps.length > 0 ? { ...normalized, probeSteps } : normalized;
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
    probeContext?: RepoProbeContextPack;
    probeExecutor?: RepoProbeExecutor;
  }): Promise<SpecClarificationResult> {
    const baseline = buildHeuristicSpecClarification(input);
    const { result: parsed, probeSteps } = await runWithOptionalProbes<
      Partial<SpecClarificationResult>
    >({
      probeContext: input.probeContext,
      probeExecutor: input.probeExecutor,
      invoke: async (probeTranscript, allowProbes) => {
        const sys = [
          "You are the Super-agent Pre-Flight Spec Architect.",
          "Clarify an engineering task using real repository paths, conventions, playbook rules, probe findings, and historical cases.",
          allowProbes ? PROBE_PROMPT_GUIDE : "",
          "Output ONLY valid JSON with keys: recommendedDispatchMode ('single'|'epic'), recommendedTemplate ('fast'|'standard'|'strict'), refinedTitle, refinedDescription, suggestedAllowedPaths (string[]), acceptanceCriteria (string[]), matchedFiles (string[]), questions (array of {id, question, options, recommendedIndex}, max 3), rationale.",
        ]
          .filter(Boolean)
          .join("\n");
        const user = JSON.stringify({
          repo: { id: input.repo.id, name: input.repo.name, defaultTemplate: input.defaultTemplate },
          repoStructure: input.repoStructure,
          conventions: input.conventions,
          playbookRules: input.playbookRules,
          casebookContext: input.casebookContext,
          probeEvidence: input.probeContext?.deterministicSummary,
          extraProbeFindings: probeTranscript || undefined,
          title: input.title,
          description: input.description,
        });
        return this.chatJson<Partial<SpecClarificationResult>>(sys, user);
      },
    });
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
      ...(probeSteps.length > 0 ? { probeSteps } : {}),
    };
  }

  async answerChiefQuestion(input: {
    question: string;
    contextSummary: string;
    probeContext?: RepoProbeContextPack;
    probeExecutor?: RepoProbeExecutor;
  }): Promise<{ answer: string; highlights?: string[]; probeSteps?: ControlProbeStep[] }> {
    const { result: parsed, probeSteps } = await runWithOptionalProbes<{
      answer?: string;
      highlights?: string[];
    }>({
      probeContext: input.probeContext,
      probeExecutor: input.probeExecutor,
      invoke: async (probeTranscript, allowProbes) => {
        const sys = [
          "You are the Super-agent Chief-of-Staff engineering advisor.",
          "Answer the user's question concisely and accurately using live system telemetry and read-only repo probes.",
          allowProbes ? PROBE_PROMPT_GUIDE : "",
          "Output ONLY valid JSON matching:",
          JSON.stringify(CHIEF_ANSWER_SCHEMA),
        ]
          .filter(Boolean)
          .join("\n");
        const user = JSON.stringify({
          question: input.question,
          contextSummary: input.contextSummary,
          extraProbeFindings: probeTranscript || undefined,
        });
        return this.chatJson<{ answer?: string; highlights?: string[] }>(sys, user);
      },
    });
    return {
      answer: parsed.answer?.trim() || input.contextSummary,
      highlights: Array.isArray(parsed.highlights) ? parsed.highlights.map(String) : undefined,
      probeSteps: probeSteps.length > 0 ? probeSteps : undefined,
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
    const { result: parsed, probeSteps } = await runWithOptionalProbes<
      Partial<RequirementIntakePlan>
    >({
      probeContext: input.probeContext,
      probeExecutor: input.probeExecutor,
      invoke: async (probeTranscript, allowProbes) => {
        const sys = [
          "You are the Super-agent Unified Requirement Router.",
          "Decide the best execution route for a raw software requirement:",
          "- `single_ticket`: coherent single feature/fix cleanly executable on one branch; provide narrowed `singleSpec.allowedPaths` aligned to real files/modules.",
          "- `epic_dag`: complex or multi-package/multi-repo feature requiring 2-6 concurrent or staged subtasks with disjoint `allowedPaths` in `epicPlan`.",
          "- `goal_campaign`: quantitative optimization ONLY when an executable `metricCommand` and numeric `targetValue` exist.",
          allowProbes ? PROBE_PROMPT_GUIDE : "",
          "Output ONLY valid JSON matching the schema:",
          JSON.stringify(REQUIREMENT_INTAKE_SCHEMA),
        ]
          .filter(Boolean)
          .join("\n");
        const user = JSON.stringify({
          repo: { id: input.repo.id, name: input.repo.name, defaultTemplate: input.defaultTemplate },
          availableRepos: input.availableRepos,
          repoStructure: input.repoStructure,
          conventions: input.conventions,
          playbookRules: input.playbookRules,
          probeEvidence: input.probeContext?.deterministicSummary,
          extraProbeFindings: probeTranscript || undefined,
          metricHint: input.metricHint,
          title: input.title,
          requirement: input.requirement,
        });
        return this.chatJson<Partial<RequirementIntakePlan>>(sys, user);
      },
    });
    const norm = normalizeRequirementIntakePlan(parsed, input);
    return probeSteps.length > 0 ? { ...norm, probeSteps } : norm;
  }

  protected async chatJson<T>(systemPrompt: string, userPrompt: string): Promise<T> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const apiKey = this.config.apiKey?.trim();
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Keyless endpoints (ollama / localhost) must not receive "Bearer ".
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
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

