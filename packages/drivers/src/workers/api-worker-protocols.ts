import type { ApiWorkerPreset, ApiWorkerProfile } from "@super-work/core";
import type { ApiToolSpec } from "./api-worker-tools.ts";

export const ANTHROPIC_VERSION = "2023-06-01";
const REQUEST_TIMEOUT_MS = 180_000;
const MAX_RETRIES = 2;
const DEFAULT_MAX_TOKENS = 8192;

export interface ResolvedApiConfig {
  preset: ApiWorkerPreset;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface ModelToolCall {
  id: string;
  name: string;
  args: unknown;
  /** Set when the model emitted unparsable JSON arguments. */
  argsError?: string;
}

export interface ModelReply {
  text: string;
  thinking?: string;
  toolCalls: ModelToolCall[];
  inputTokens: number;
  outputTokens: number;
}

export interface ToolOutcome {
  id: string;
  name: string;
  output: string;
  isError: boolean;
}

/** A stateful multi-turn conversation over one wire protocol. */
export interface ProtocolSession {
  send(signal: AbortSignal): Promise<ModelReply>;
  addToolResults(results: ToolOutcome[]): void;
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

export function isApiConfigUsable(cfg: Partial<ApiWorkerProfile> | undefined): boolean {
  if (!cfg?.baseUrl?.trim() || !cfg.model?.trim()) return false;
  return Boolean(cfg.apiKey?.trim()) || isLocalBaseUrl(cfg.baseUrl.trim());
}

export function redactSecret(text: string, secret?: string): string {
  const s = secret?.trim();
  return s ? text.split(s).join("***") : text;
}

export function openAiUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}/chat/completions`;
}

export function anthropicUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
}

function requestHeaders(cfg: ResolvedApiConfig): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.preset === "anthropic") {
    headers["anthropic-version"] = ANTHROPIC_VERSION;
    if (cfg.apiKey) headers["x-api-key"] = cfg.apiKey;
  } else if (cfg.apiKey) {
    headers.authorization = `Bearer ${cfg.apiKey}`;
  }
  return headers;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((res) => {
    const t = setTimeout(res, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), res()), { once: true });
  });

/** POST JSON with bounded retries on 429/5xx/network errors. Secrets are redacted from errors. */
export async function postJson(
  cfg: ResolvedApiConfig,
  url: string,
  body: unknown,
  signal: AbortSignal,
  timeoutMs = REQUEST_TIMEOUT_MS,
  retries = MAX_RETRIES,
): Promise<Record<string, any>> {
  let lastErr: ApiRequestError | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal.aborted) throw new ApiRequestError("Request aborted");
    let retryable = true;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: requestHeaders(cfg),
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
      if (res.ok) return (await res.json()) as Record<string, any>;
      const detail = redactSecret((await res.text().catch(() => "")).slice(0, 500), cfg.apiKey);
      lastErr = new ApiRequestError(`HTTP ${res.status} from ${new URL(url).host}: ${detail}`, res.status);
      retryable = res.status === 429 || res.status >= 500;
    } catch (err) {
      if (signal.aborted) throw new ApiRequestError("Request aborted");
      lastErr = new ApiRequestError(redactSecret(`Request failed: ${(err as Error).message}`, cfg.apiKey));
    }
    if (!retryable) throw lastErr;
    if (attempt < retries) await sleep(1000 * 2 ** attempt, signal);
  }
  throw lastErr ?? new ApiRequestError("Request failed");
}

function parseArgs(raw: unknown): { args: unknown; argsError?: string } {
  if (typeof raw !== "string") return { args: raw ?? {} };
  if (!raw.trim()) return { args: {} };
  try {
    return { args: JSON.parse(raw) };
  } catch (err) {
    return { args: {}, argsError: `Invalid JSON arguments: ${(err as Error).message}` };
  }
}

export class OpenAiSession implements ProtocolSession {
  private readonly messages: Array<Record<string, unknown>>;

  constructor(
    private readonly cfg: ResolvedApiConfig,
    system: string,
    prompt: string,
    private readonly tools: ApiToolSpec[],
    private readonly maxTokens = DEFAULT_MAX_TOKENS,
  ) {
    this.messages = [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ];
  }

  async send(signal: AbortSignal): Promise<ModelReply> {
    const data = await postJson(
      this.cfg,
      openAiUrl(this.cfg.baseUrl),
      {
        model: this.cfg.model,
        messages: this.messages,
        max_tokens: this.maxTokens,
        ...(this.tools.length
          ? {
              tools: this.tools.map((t) => ({
                type: "function",
                function: { name: t.name, description: t.description, parameters: t.parameters },
              })),
              tool_choice: "auto",
            }
          : {}),
      },
      signal,
    );
    const message = data.choices?.[0]?.message;
    if (!message) throw new ApiRequestError("Malformed response: missing choices[0].message");
    const { reasoning_content: thinking, ...assistant } = message as Record<string, any>;
    this.messages.push(assistant);
    const toolCalls: ModelToolCall[] = (message.tool_calls ?? []).map((c: any, i: number) => ({
      id: String(c.id ?? `call_${this.messages.length}_${i}`),
      name: String(c.function?.name ?? ""),
      ...parseArgs(c.function?.arguments),
    }));
    return {
      text: typeof message.content === "string" ? message.content : "",
      ...(typeof thinking === "string" && thinking ? { thinking } : {}),
      toolCalls,
      inputTokens: Number(data.usage?.prompt_tokens) || 0,
      outputTokens: Number(data.usage?.completion_tokens) || 0,
    };
  }

  addToolResults(results: ToolOutcome[]): void {
    for (const r of results) {
      this.messages.push({ role: "tool", tool_call_id: r.id, content: r.output });
    }
  }
}

export class AnthropicSession implements ProtocolSession {
  private readonly messages: Array<Record<string, unknown>>;

  constructor(
    private readonly cfg: ResolvedApiConfig,
    private readonly system: string,
    prompt: string,
    private readonly tools: ApiToolSpec[],
    private readonly maxTokens = DEFAULT_MAX_TOKENS,
  ) {
    this.messages = [{ role: "user", content: prompt }];
  }

  async send(signal: AbortSignal): Promise<ModelReply> {
    const data = await postJson(
      this.cfg,
      anthropicUrl(this.cfg.baseUrl),
      {
        model: this.cfg.model,
        max_tokens: this.maxTokens,
        system: this.system,
        messages: this.messages,
        ...(this.tools.length
          ? {
              tools: this.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
            }
          : {}),
      },
      signal,
    );
    const blocks: any[] = Array.isArray(data.content) ? data.content : [];
    this.messages.push({ role: "assistant", content: blocks });
    return {
      text: blocks.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join(""),
      thinking: blocks.filter((b) => b.type === "thinking").map((b) => String(b.thinking ?? "")).join("") || undefined,
      toolCalls: blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: String(b.id), name: String(b.name), args: b.input ?? {} })),
      inputTokens: Number(data.usage?.input_tokens) || 0,
      outputTokens: Number(data.usage?.output_tokens) || 0,
    };
  }

  addToolResults(results: ToolOutcome[]): void {
    // All results of one assistant turn must come back in a single user message.
    this.messages.push({
      role: "user",
      content: results.map((r) => ({
        type: "tool_result",
        tool_use_id: r.id,
        content: r.output,
        ...(r.isError ? { is_error: true } : {}),
      })),
    });
  }
}

export function createProtocolSession(
  cfg: ResolvedApiConfig,
  system: string,
  prompt: string,
  tools: ApiToolSpec[],
): ProtocolSession {
  return cfg.preset === "anthropic"
    ? new AnthropicSession(cfg, system, prompt, tools)
    : new OpenAiSession(cfg, system, prompt, tools);
}

/** Minimal `max_tokens: 16` ping used for connectivity tests. */
export async function pingApi(cfg: ResolvedApiConfig, signal: AbortSignal, timeoutMs = 20_000): Promise<void> {
  const ping = [{ role: "user", content: "ping" }];
  if (cfg.preset === "anthropic") {
    await postJson(cfg, anthropicUrl(cfg.baseUrl), { model: cfg.model, max_tokens: 16, messages: ping }, signal, timeoutMs, 0);
  } else {
    await postJson(cfg, openAiUrl(cfg.baseUrl), { model: cfg.model, max_tokens: 16, messages: ping }, signal, timeoutMs, 0);
  }
}
