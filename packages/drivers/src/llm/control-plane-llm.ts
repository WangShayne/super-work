import { getAlternateEngine } from "@super-work/core";
import type {
  ControlPlaneLLM,
  MemorySearchHit,
  PipelineTemplateId,
  RepoConfig,
  StageRun,
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
  }): Promise<TriageProposal> {
    const sys = [
      "You are the Super-agent MasterAssessor / Router.",
      "Decide whether an incoming repository event warrants creating a coding Ticket.",
      "Output ONLY valid JSON matching the schema:",
      JSON.stringify(TRIAGE_SCHEMA),
    ].join("\n");

    const user = JSON.stringify({
      repo: {
        name: input.repo.name,
        defaultTemplate: input.repo.defaultTemplate,
      },
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
  readonly providerName = "cli:claude-restricted";

  constructor(private readonly claudeBin = "claude") {}

  async triageTrigger(input: {
    repo: RepoConfig;
    trigger: Trigger;
    activeTickets: Ticket[];
    relatedMemory: MemorySearchHit[];
  }): Promise<TriageProposal> {
    const prompt = [
      "Evaluate this development trigger and return structured JSON triage proposal.",
      `Repo: ${input.repo.name}, DefaultTemplate: ${input.repo.defaultTemplate}`,
      `Source: ${input.trigger.source}, Title: ${input.trigger.title}`,
      `Body: ${input.trigger.rawText}`,
    ].join("\n");
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

  private async runClaudeJson<T>(prompt: string, schema: Record<string, unknown>): Promise<T> {
    if (!Bun.which(this.claudeBin)) {
      throw new Error("claude CLI not found on PATH");
    }
    const proc = Bun.spawn(
      [
        this.claudeBin,
        "-p",
        "--output-format",
        "json",
        "--tools",
        "",
        "--no-session-persistence",
        "--json-schema",
        JSON.stringify(schema),
        prompt,
      ],
      { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
    );

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      throw new Error(`CLI LLM failed (${code}): ${stderr.slice(0, 200)}`);
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

export class HeuristicControlLLM implements ControlPlaneLLM {
  readonly providerName = "heuristic:local";

  async triageTrigger(input: {
    repo: RepoConfig;
    trigger: Trigger;
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
    const allowedPaths = explicitScope
      ? [explicitScope]
      : pathMatches.length > 0
        ? Array.from(new Set(pathMatches)).slice(0, 4)
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
