// v1.8.1 Symmetric control-plane LLMs: any ModelProfile (CLI or API) can act as ControlPlaneLLM.
import {
  isLocalModelEndpoint,
  protocolDefaultBaseUrl,
  protocolDefaultModel,
} from "@super-work/core";
import type { ControlPlaneLLM, ModelProfile, ReasoningEffort } from "@super-work/core";
import { buildRelayEnv } from "../workers/relay-env.ts";
import { CliFallbackControlLLM, CodexCliControlLLM } from "./control-plane-cli-llms.ts";
import {
  DEFAULT_HTTP_LLM_TIMEOUT_MS,
  createSanitizedClaudeEnv,
  extractJsonObject,
  resolveExecutable,
  runSpawnWithTimeout,
  sanitizeCliModelName,
} from "./control-plane-helpers.ts";
import type { OpenAICompatibleConfig } from "./control-plane-helpers.ts";
import { OpenAICompatibleControlLLM } from "./control-plane-openai.ts";

export interface ModelConnectionResult {
  ok: boolean;
  providerName: string;
  latencyMs: number;
  message: string;
}

/** Removes the literal key and any bearer-looking token from text that may reach logs/UI. */
export function redactSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) {
    const v = s?.trim();
    if (v && v.length >= 4) out = out.split(v).join("[redacted]");
  }
  return out.replace(/(Bearer\s+)[A-Za-z0-9._\-]{8,}/gi, "$1[redacted]");
}

/** `${baseUrl}/v1/messages` without duplicating a trailing `/v1`. */
export function anthropicMessagesUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return `${trimmed.replace(/\/v1$/i, "")}/v1/messages`;
}

function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    ...(apiKey ? { "x-api-key": apiKey, Authorization: `Bearer ${apiKey}` } : {}),
  };
}

/** Anthropic Messages API control plane; reuses every prompt/normalizer of the OpenAI-compatible class. */
export class AnthropicCompatibleControlLLM extends OpenAICompatibleControlLLM {
  constructor(config: OpenAICompatibleConfig) {
    super({ ...config, providerLabel: config.providerLabel ?? `anthropic:${config.model}` });
  }

  protected override async chatJson<T>(systemPrompt: string, userPrompt: string): Promise<T> {
    const apiKey = this.config.apiKey?.trim() ?? "";
    try {
      const res = await fetch(anthropicMessagesUrl(this.config.baseUrl), {
        method: "POST",
        headers: anthropicHeaders(apiKey),
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: 4096,
          temperature: 0.1,
          system: `${systemPrompt}\nRespond with ONLY a valid JSON object, no prose or markdown.`,
          messages: [{ role: "user", content: userPrompt }],
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? DEFAULT_HTTP_LLM_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`ControlPlaneLLM HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
      const json = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
      const text = (json.content ?? [])
        .filter((b) => b.type === undefined || b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      if (!text) throw new Error("ControlPlaneLLM returned empty content");
      return extractJsonObject<T>(text);
    } catch (err) {
      throw new Error(redactSecrets(err instanceof Error ? err.message : String(err), [apiKey]));
    }
  }
}

function eventText(ev: unknown): string | undefined {
  if (!ev || typeof ev !== "object") return undefined;
  const o = ev as Record<string, unknown>;
  for (const k of ["response", "result", "text", "output", "content"]) {
    if (typeof o[k] === "string") return o[k] as string;
  }
  const part = o.part as Record<string, unknown> | undefined;
  return part && typeof part.text === "string" ? part.text : undefined;
}

/** Parses `gemini --output-format json` envelopes and `opencode run --format json` NDJSON events. */
export function parseCliJsonOutput<T>(stdout: string): T {
  const trimmed = stdout.trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const text = eventText(parsed);
    return text !== undefined ? extractJsonObject<T>(text) : (parsed as T);
  } catch {
    // fall through to NDJSON / fenced text handling
  }
  const texts: string[] = [];
  for (const line of trimmed.split("\n")) {
    try {
      const text = eventText(JSON.parse(line));
      if (text) texts.push(text);
    } catch {
      // non-JSON line
    }
  }
  return extractJsonObject<T>(texts.length > 0 ? texts.join("") : trimmed);
}

function withSchema(prompt: string, schema: Record<string, unknown>): string {
  return `${prompt}\n\nRespond with ONLY a JSON object (no prose, no markdown) matching this JSON schema:\n${JSON.stringify(schema)}`;
}

interface SymmetricCliOptions {
  bin?: string;
  model?: string;
  effort?: ReasoningEffort;
  timeoutMs?: number;
  baseUrl?: string;
  apiKey?: string;
}

async function runGenericCliJson<T>(input: {
  bin: string;
  label: string;
  buildArgs: (resolved: string, prompt: string) => string[];
  prompt: string;
  schema: Record<string, unknown>;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<T> {
  const resolved = resolveExecutable(input.bin);
  if (!resolved) throw new Error(`${input.bin} CLI not found on PATH`);
  const { stdout, stderr, exitCode } = await runSpawnWithTimeout(
    input.buildArgs(resolved, withSchema(input.prompt, input.schema)),
    {
      timeoutMs: input.timeoutMs,
      env: { ...createSanitizedClaudeEnv(), ...input.env },
      label: input.label,
    },
  );
  if (exitCode !== 0) throw new Error(`${input.label} failed (${exitCode}): ${stderr.slice(0, 200)}`);
  return parseCliJsonOutput<T>(stdout);
}

/** `gemini -p <prompt> --output-format json [-m model]`; reuses all prompts of the Claude CLI class. */
export class GeminiCliControlLLM extends CliFallbackControlLLM {
  override readonly providerName: string;

  constructor(options: SymmetricCliOptions = {}) {
    super({
      claudeBin: options.bin ?? "gemini",
      model: options.model,
      effort: options.effort,
      timeoutMs: options.timeoutMs,
      env: buildRelayEnv("gemini", { baseUrl: options.baseUrl, apiKey: options.apiKey }),
    });
    this.providerName = `cli:gemini(${this.model ?? "default"})`;
  }

  protected override runClaudeJson<T>(prompt: string, schema: Record<string, unknown>): Promise<T> {
    return runGenericCliJson<T>({
      bin: this.claudeBin,
      label: "Gemini CLI ControlPlaneLLM",
      buildArgs: (bin, p) => [bin, "-p", p, "--output-format", "json", ...(this.model ? ["-m", this.model] : [])],
      prompt,
      schema,
      timeoutMs: this.timeoutMs,
      env: this.extraEnv,
    });
  }
}

/** `opencode run --format json [-m model] <prompt>`. */
export class OpenCodeCliControlLLM extends CliFallbackControlLLM {
  override readonly providerName: string;

  constructor(options: SymmetricCliOptions = {}) {
    super({
      claudeBin: options.bin ?? "opencode",
      model: options.model,
      effort: options.effort,
      timeoutMs: options.timeoutMs,
      env: buildRelayEnv("opencode", { baseUrl: options.baseUrl, apiKey: options.apiKey }),
    });
    this.providerName = `cli:opencode(${this.model ?? "default"})`;
  }

  protected override runClaudeJson<T>(prompt: string, schema: Record<string, unknown>): Promise<T> {
    return runGenericCliJson<T>({
      bin: this.claudeBin,
      label: "OpenCode CLI ControlPlaneLLM",
      buildArgs: (bin, p) => [bin, "run", "--format", "json", ...(this.model ? ["-m", this.model] : []), p],
      prompt,
      schema,
      timeoutMs: this.timeoutMs,
      env: this.extraEnv,
    });
  }
}

/** Builds the bare (unwrapped) ControlPlaneLLM for a profile; callers add the heuristic fallback. */
export function createControlLLMFromProfile(profile: ModelProfile): ControlPlaneLLM {
  const model = profile.model?.trim() || undefined;
  const relay = { baseUrl: profile.baseUrl, apiKey: profile.apiKey };
  if (profile.kind === "cli") {
    const cli = {
      model: sanitizeCliModelName(model),
      effort: profile.effort ?? ("low" as ReasoningEffort),
      env: buildRelayEnv(profile.cliEngine ?? "claude", relay),
    };
    switch (profile.cliEngine ?? "claude") {
      case "codex":
        return new CodexCliControlLLM(cli);
      case "gemini":
        return new GeminiCliControlLLM({ ...cli, ...relay });
      case "opencode":
        return new OpenCodeCliControlLLM({ ...cli, ...relay });
      default:
        return new CliFallbackControlLLM(cli);
    }
  }
  const protocol = profile.apiProtocol ?? "openai";
  const config: OpenAICompatibleConfig = {
    apiKey: profile.apiKey?.trim() ?? "",
    baseUrl: profile.baseUrl?.trim() || protocolDefaultBaseUrl(protocol),
    model: model ?? protocolDefaultModel(protocol),
    providerLabel: `${protocol}:${model ?? protocolDefaultModel(protocol)}`,
  };
  return protocol === "anthropic"
    ? new AnthropicCompatibleControlLLM(config)
    : new OpenAICompatibleControlLLM(config);
}

async function testCliProfile(profile: ModelProfile, started: number): Promise<ModelConnectionResult> {
  const engine = profile.cliEngine ?? "claude";
  const providerName = `cli:${engine}(${profile.model?.trim() || "default"})`;
  const done = (ok: boolean, message: string): ModelConnectionResult => ({
    ok,
    providerName,
    latencyMs: Date.now() - started,
    message: redactSecrets(message, [profile.apiKey]),
  });
  const bin = Bun.which(engine);
  if (!bin) return done(false, `${engine} CLI not found on PATH.`);

  const baseUrl = profile.baseUrl?.trim();
  if (baseUrl) {
    try {
      const res = await fetch(baseUrl, { method: "GET", signal: AbortSignal.timeout(8_000) });
      return done(true, `${engine} CLI found; relay ${baseUrl} reachable (HTTP ${res.status}).`);
    } catch (err) {
      return done(false, `Relay ${baseUrl} unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (profile.apiKey?.trim()) return done(true, `${engine} CLI found; using custom API key.`);

  try {
    if (engine === "claude") {
      const { stdout, exitCode } = await runSpawnWithTimeout([bin, "auth", "status", "--json"], {
        timeoutMs: 10_000,
        env: createSanitizedClaudeEnv(),
        label: "claude auth status",
      });
      let loggedIn = exitCode === 0;
      try {
        loggedIn = Boolean((JSON.parse(stdout) as { loggedIn?: boolean }).loggedIn);
      } catch {
        // keep exit-code verdict
      }
      return loggedIn
        ? done(true, "claude CLI authenticated.")
        : done(false, "claude CLI is installed but not logged in (run `claude auth login`).");
    }
    if (engine === "codex") {
      const { stdout, stderr, exitCode } = await runSpawnWithTimeout([bin, "login", "status"], {
        timeoutMs: 10_000,
        label: "codex login status",
      });
      return exitCode === 0
        ? done(true, (stdout || stderr).trim() || "codex CLI authenticated.")
        : done(false, "codex CLI is installed but not logged in (run `codex login`).");
    }
    return done(true, `${engine} CLI found at ${bin} (login state not verified).`);
  } catch (err) {
    return done(false, err instanceof Error ? err.message : String(err));
  }
}

/** Unified connectivity test for ANY CLI or API ModelProfile. Never throws. */
export async function testModelProfileConnection(profile: ModelProfile): Promise<ModelConnectionResult> {
  const started = Date.now();
  if (profile.kind === "cli") return testCliProfile(profile, started);

  const protocol = profile.apiProtocol ?? "openai";
  const baseUrl = profile.baseUrl?.trim() || protocolDefaultBaseUrl(protocol);
  const model = profile.model?.trim() || protocolDefaultModel(protocol);
  const apiKey = profile.apiKey?.trim() ?? "";
  const providerName = `${protocol}:${model}`;
  const fail = (message: string): ModelConnectionResult => ({
    ok: false,
    providerName,
    latencyMs: Date.now() - started,
    message: redactSecrets(message, [apiKey]),
  });

  if (!apiKey && protocol !== "ollama" && !isLocalModelEndpoint(baseUrl)) {
    return fail("API Key is required for this provider.");
  }
  try {
    const anthropic = protocol === "anthropic";
    const res = await fetch(
      anthropic ? anthropicMessagesUrl(baseUrl) : `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: anthropic
          ? anthropicHeaders(apiKey)
          : { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({
          model,
          max_tokens: 16,
          temperature: 0,
          messages: [{ role: "user", content: 'Reply with JSON {"ok":true}' }],
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const latencyMs = Date.now() - started;
    if (!res.ok) return fail(`HTTP ${res.status}: ${(await res.text()).slice(0, 180)}`);
    return { ok: true, providerName, latencyMs, message: `Connected to ${model} in ${latencyMs}ms.` };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
