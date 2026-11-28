import type { WorkerEngineId, WorkerTurnInput } from "@super-work/core";

/** Spread-friendly wrapper for `wrapCommandWithOsSandbox` options (`extraEnv` only when overriding). */
export function relayExtraEnv(
  engine: WorkerEngineId,
  input: Pick<WorkerTurnInput, "baseUrl" | "apiKey">,
): { extraEnv: NodeJS.ProcessEnv } | Record<string, never> {
  const env = buildRelayEnv(engine, input);
  return env ? { extraEnv: env } : {};
}

/**
 * Builds subprocess env overrides for a CLI worker routed through a custom relay.
 * Returns undefined when the turn carries no baseUrl/apiKey override.
 */
export function buildRelayEnv(
  engine: WorkerEngineId,
  input: Pick<WorkerTurnInput, "baseUrl" | "apiKey">,
): NodeJS.ProcessEnv | undefined {
  const baseUrl = input.baseUrl?.trim();
  const apiKey = input.apiKey?.trim();
  if (!baseUrl && !apiKey) return undefined;
  const env: NodeJS.ProcessEnv = {};
  switch (engine) {
    case "claude":
      if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
      if (apiKey) {
        env.ANTHROPIC_API_KEY = apiKey;
        env.ANTHROPIC_AUTH_TOKEN = apiKey;
      }
      break;
    case "codex":
    case "opencode":
      if (baseUrl) env.OPENAI_BASE_URL = baseUrl;
      if (apiKey) env.OPENAI_API_KEY = apiKey;
      break;
    case "gemini":
      if (apiKey) env.GEMINI_API_KEY = apiKey;
      if (baseUrl) env.GOOGLE_GEMINI_BASE_URL = baseUrl;
      break;
    default:
      return undefined;
  }
  return env;
}
