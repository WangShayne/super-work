import type {
  ApiModelProtocol,
  CliEngineId,
  ModelProfileKind,
  ModelProfilePatch,
  PublicModelProfile,
  ReasoningEffort,
} from "../../types.ts";
import type { TranslationKey } from "../../i18n.tsx";

/** One of the 8 peer templates offered by "+ Add Model" (4 API protocols + 4 CLI engines). */
export interface ModelTemplate {
  id: string;
  titleKey: TranslationKey;
  kind: ModelProfileKind;
  cliEngine?: CliEngineId;
  apiProtocol?: ApiModelProtocol;
  name: string;
  baseUrl: string;
  model: string;
  /** Model-name hints rendered as <datalist> options (API templates only). */
  suggestions: string[];
}

export const MODEL_TEMPLATES: ModelTemplate[] = [
  { id: "deepseek", titleKey: "models.tpl.deepseek", kind: "api", apiProtocol: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", suggestions: ["deepseek-chat", "deepseek-reasoner"] },
  { id: "openai", titleKey: "models.tpl.openai", kind: "api", apiProtocol: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", suggestions: ["gpt-4.1", "o4-mini"] },
  { id: "anthropic", titleKey: "models.tpl.anthropic", kind: "api", apiProtocol: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-5", suggestions: ["claude-sonnet-4-5", "claude-opus-4-5"] },
  { id: "ollama", titleKey: "models.tpl.ollama", kind: "api", apiProtocol: "ollama", name: "Ollama", baseUrl: "http://localhost:11434/v1", model: "qwen2.5-coder", suggestions: ["qwen2.5-coder", "llama3.3"] },
  { id: "claude", titleKey: "models.tpl.claude", kind: "cli", cliEngine: "claude", name: "Claude CLI", baseUrl: "", model: "", suggestions: [] },
  { id: "codex", titleKey: "models.tpl.codex", kind: "cli", cliEngine: "codex", name: "Codex CLI", baseUrl: "", model: "", suggestions: [] },
  { id: "opencode", titleKey: "models.tpl.opencode", kind: "cli", cliEngine: "opencode", name: "OpenCode CLI", baseUrl: "", model: "", suggestions: [] },
  { id: "gemini", titleKey: "models.tpl.gemini", kind: "cli", cliEngine: "gemini", name: "Gemini CLI", baseUrl: "", model: "", suggestions: [] },
];

/** The two labeled track groups shown by "+ Add Model". */
export const TEMPLATE_GROUPS: Array<{ track: ModelProfileKind; titleKey: TranslationKey; templates: ModelTemplate[] }> = [
  { track: "api", titleKey: "models.form.groupApi", templates: MODEL_TEMPLATES.filter((t) => t.kind === "api") },
  { track: "cli", titleKey: "models.form.groupCli", templates: MODEL_TEMPLATES.filter((t) => t.kind === "cli") },
];

/** Editable form state for one ModelProfile (apiKey is write-only: blank keeps the saved key). */
export interface ProfileDraft {
  id?: string;
  name: string;
  kind: ModelProfileKind;
  cliEngine?: CliEngineId;
  apiProtocol?: ApiModelProtocol;
  baseUrl: string;
  model: string;
  effort: ReasoningEffort | "";
  apiKey: string;
  clearApiKey: boolean;
  workerAutoPool: boolean;
  builtinCli: boolean;
  hasApiKey: boolean;
  maskedApiKey?: string;
}

export function draftFromTemplate(tpl: ModelTemplate): ProfileDraft {
  return {
    name: tpl.name,
    kind: tpl.kind,
    cliEngine: tpl.cliEngine,
    apiProtocol: tpl.apiProtocol,
    baseUrl: tpl.baseUrl,
    model: tpl.model,
    effort: "",
    apiKey: "",
    clearApiKey: false,
    // every new profile joins the Auto pool so it works out of the box in Auto mode
    workerAutoPool: true,
    builtinCli: false,
    hasApiKey: false,
  };
}

export function draftFromProfile(p: PublicModelProfile): ProfileDraft {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    cliEngine: p.cliEngine,
    apiProtocol: p.apiProtocol,
    baseUrl: p.baseUrl ?? "",
    model: p.model ?? "",
    effort: p.effort ?? "",
    apiKey: "",
    clearApiKey: false,
    workerAutoPool: p.workerAutoPool,
    builtinCli: Boolean(p.builtinCli),
    hasApiKey: p.hasApiKey,
    maskedApiKey: p.maskedApiKey,
  };
}

/** Wire payload: blank apiKey is omitted so the saved key survives; clearApiKey removes it. */
export function draftToPatch(d: ProfileDraft): ModelProfilePatch {
  return {
    ...(d.id ? { id: d.id } : {}),
    name: d.name.trim() || undefined,
    kind: d.kind,
    ...(d.cliEngine ? { cliEngine: d.cliEngine } : {}),
    ...(d.apiProtocol ? { apiProtocol: d.apiProtocol } : {}),
    baseUrl: d.baseUrl.trim(),
    model: d.model.trim(),
    ...(d.effort ? { effort: d.effort } : {}),
    ...(d.apiKey.trim() ? { apiKey: d.apiKey.trim() } : {}),
    ...(d.clearApiKey ? { clearApiKey: true } : {}),
    workerAutoPool: d.workerAutoPool,
  };
}

/** Test payload mirrors the draft; a saved key is reused unless a new one is typed or cleared. */
export function draftToTestPayload(d: ProfileDraft): ModelProfilePatch & { useSavedKey?: boolean } {
  const { clearApiKey: _clear, ...patch } = draftToPatch(d);
  return { ...patch, useSavedKey: d.hasApiKey && !d.apiKey.trim() && !d.clearApiKey };
}

/** Driver engine a profile maps to (used to derive repo preferred*Engine from a role binding). */
export function profileEngine(p: Pick<PublicModelProfile, "kind" | "cliEngine">): CliEngineId | "api" {
  return p.kind === "cli" ? (p.cliEngine ?? "claude") : "api";
}

export function hostOf(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
