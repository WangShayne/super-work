import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAlternateEngine } from "@super-work/core";
import type {
  ControlPlaneLLM,
  ControlProbeRequest,
  ControlProbeStep,
  ControlProbeToolName,
  PipelineTemplateId,
  ReasoningEffort,
  RepoProbeContextPack,
  RepoProbeExecutor,
  TriageProposal,
  Trigger,
  WatchdogDecision,
  WorkerEngineId,
} from "@super-work/core";

export interface OpenAICompatibleConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  providerLabel?: string;
  timeoutMs?: number;
}

export const DEFAULT_CONTROL_PLANE_TIMEOUT_MS = 20_000;
export const DEFAULT_HTTP_LLM_TIMEOUT_MS = 25_000;
export const PLACEHOLDER_CLI_MODELS = new Set(["claude-cli", "codex-cli", "heuristic", "default"]);

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

export function resolveExecutable(bin: string): string | null {
  if (bin.includes("/")) {
    return existsSync(bin) ? bin : null;
  }
  return Bun.which(bin);
}

export async function runSpawnWithTimeout(
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

export const TRIAGE_SCHEMA = {
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

export const WATCHDOG_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["CONTINUE", "INJECT_HINT", "SWITCH_ENGINE", "ESCALATE_HUMAN"],
    },
    reason: { type: "string" },
    hint: { type: "string" },
    targetEngine: { type: "string", enum: ["claude", "codex", "opencode", "gemini", "mock"] },
  },
  required: ["action", "reason"],
};

export const EPIC_DECOMPOSITION_SCHEMA = {
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

export const DISTILL_LESSON_SCHEMA = {
  type: "object",
  properties: {
    rule: { type: "string" },
    scopePaths: { type: "array", items: { type: "string" } },
  },
  required: ["rule", "scopePaths"],
};

export const HANDOVER_DIGEST_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    exportedSymbols: { type: "array", items: { type: "string" } },
    contractSnippets: { type: "array", items: { type: "string" } },
  },
  required: ["summary"],
};

export const CHIEF_ANSWER_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    highlights: { type: "array", items: { type: "string" } },
  },
  required: ["answer"],
};

export const REQUIREMENT_INTAKE_SCHEMA = {
  type: "object",
  properties: {
    route: { type: "string", enum: ["single_ticket", "epic_dag", "goal_campaign"] },
    confidence: { type: "number" },
    rationale: { type: "string" },
    title: { type: "string" },
    summary: { type: "string" },
    singleSpec: {
      type: "object",
      properties: {
        description: { type: "string" },
        template: { type: "string", enum: ["fast", "standard", "strict"] },
        tddMode: { type: "boolean" },
        allowedPaths: { type: "array", items: { type: "string" } },
        acceptanceCriteria: { type: "array", items: { type: "string" } },
        priority: { type: "number" },
      },
    },
    epicPlan: EPIC_DECOMPOSITION_SCHEMA,
    campaignSpec: {
      type: "object",
      properties: {
        name: { type: "string" },
        goalPrompt: { type: "string" },
        metricCommand: { type: "string" },
        metricRegex: { type: "string" },
        metricUnit: { type: "string" },
        direction: { type: "string", enum: ["increase", "decrease"] },
        targetValue: { type: "number" },
        deliveryMode: { type: "string", enum: ["staging_branch", "per_wave_merge"] },
        allowedPaths: { type: "array", items: { type: "string" } },
        maxIterations: { type: "number" },
        maxTotalBudgetUsd: { type: "number" },
      },
    },
  },
  required: ["route", "confidence", "rationale", "title", "summary"],
};

export const PROBE_PROMPT_GUIDE = [
  "Read-Only Probe Protocol (max 2 rounds, zero write risk):",
  "If you need to inspect specific files, symbols, literals, or git history before deciding,",
  'reply with JSON {"probeRequests":[{"tool":"search_symbols"|"read_file_slice"|"grep_literals"|"git_recent_commits","path"?:string,"query"?:string,"startLine"?:number,"endLine"?:number,"limit"?:number}]} (max 3 calls/round).',
  "Once you have enough evidence, reply with ONLY the final schema JSON.",
].join(" ");

export const VALID_PROBE_TOOLS = new Set<ControlProbeToolName>([
  "search_symbols",
  "read_file_slice",
  "grep_literals",
  "git_recent_commits",
]);

export async function runWithOptionalProbes<T extends object>(input: {
  probeContext?: RepoProbeContextPack;
  probeExecutor?: RepoProbeExecutor;
  maxRounds?: number;
  probeBudgetMs?: number;
  invoke: (probeTranscript: string, allowProbes: boolean) => Promise<T & { probeRequests?: unknown[] }>;
}): Promise<{ result: T; probeSteps: ControlProbeStep[] }> {
  const probeSteps: ControlProbeStep[] = [...(input.probeContext?.probeSteps ?? [])];
  const maxRounds = input.probeExecutor ? (input.maxRounds ?? 2) : 0;
  const deadline = Date.now() + (input.probeBudgetMs ?? 12_000);
  const findings: string[] = [];

  for (let round = 0; round <= maxRounds; round += 1) {
    const canProbe = Boolean(input.probeExecutor) && round < maxRounds && Date.now() < deadline;
    const raw = await input.invoke(findings.join("\n\n"), canProbe);
    const reqs = canProbe && Array.isArray(raw.probeRequests) ? raw.probeRequests.slice(0, 3) : [];

    if (reqs.length > 0 && input.probeExecutor) {
      let ranAny = false;
      for (const candidate of reqs) {
        if (!candidate || typeof candidate !== "object") continue;
        const obj = candidate as Record<string, unknown>;
        const tool = String(obj.tool ?? "") as ControlProbeToolName;
        if (!VALID_PROBE_TOOLS.has(tool)) continue;
        const req: ControlProbeRequest = {
          tool,
          path: typeof obj.path === "string" ? obj.path : undefined,
          query: typeof obj.query === "string" ? obj.query : undefined,
          startLine: typeof obj.startLine === "number" ? obj.startLine : undefined,
          endLine: typeof obj.endLine === "number" ? obj.endLine : undefined,
          limit: typeof obj.limit === "number" ? obj.limit : undefined,
        };
        const step = await input.probeExecutor(req).catch((err) => ({
          step: probeSteps.length + 1,
          tool,
          inputSummary: req.path ?? req.query ?? "",
          outputSummary: `Probe error: ${err instanceof Error ? err.message : String(err)}`,
          matchedPaths: [],
          durationMs: 1,
        }));
        const numbered: ControlProbeStep = { ...step, step: round + 1 };
        probeSteps.push(numbered);
        findings.push(
          `[Round ${round + 1} ${numbered.tool}(${numbered.inputSummary})]\n${numbered.outputSummary}`,
        );
        ranAny = true;
      }
      if (ranAny) continue;
    }

    return { result: raw, probeSteps };
  }

  const finalRes = await input.invoke(findings.join("\n\n"), false);
  return { result: finalRes, probeSteps };
}

export function extractJsonObject<T>(raw: string): T {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  return JSON.parse(candidate) as T;
}

export function normalizeTriageProposal(
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

export function normalizeWatchdogDecision(
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
