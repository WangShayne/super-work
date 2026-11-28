// v1.8.2 Live `/models` | `/model` upstream model discovery (OpenAI/Anthropic/Ollama/LiteLLM/vLLM shapes).
import { isLocalModelEndpoint, protocolDefaultBaseUrl } from "@super-work/core";
import type {
  ApiModelProtocol,
  CliEngineId,
  DiscoveredModelItem,
  ModelDiscoveryResult,
  ModelProfileKind,
} from "@super-work/core";
import { redactSecrets } from "./control-plane-symmetric.ts";

const MAX_MODELS = 500;
const PROBE_TIMEOUT_MS = 8_000;

export interface ModelDiscoveryInput {
  kind: ModelProfileKind;
  protocol?: ApiModelProtocol;
  cliEngine?: CliEngineId;
  baseUrl?: string;
  apiKey?: string;
  /** Test seam: defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

function cleanBase(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/(chat\/completions|messages)$/i, "")
    .replace(/\/+$/, "");
}

/** Ordered, de-duplicated GET candidates for listing models on a base URL. */
export function buildModelDiscoveryUrls(
  baseUrl: string,
  protocol?: ApiModelProtocol,
  cliEngine?: CliEngineId,
): string[] {
  const clean = cleanBase(baseUrl);
  const hasV1 = clean.endsWith("/v1");
  const anthropicStyle = protocol === "anthropic" || cliEngine === "claude";
  const urls: string[] = anthropicStyle
    ? hasV1
      ? [`${clean}/models`, `${clean}/model`]
      : [`${clean}/v1/models`, `${clean}/models`, `${clean}/v1/model`, `${clean}/model`]
    : [
        `${clean}/models`,
        ...(hasV1 ? [] : [`${clean}/v1/models`]),
        `${clean}/model`,
        ...(hasV1 ? [] : [`${clean}/v1/model`]),
      ];
  if (protocol === "ollama" || isLocalModelEndpoint(clean)) {
    try {
      urls.push(`${new URL(clean).origin}/api/tags`);
    } catch {
      // invalid base: caller validates separately
    }
  }
  return [...new Set(urls)];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function parseEntry(entry: unknown): DiscoveredModelItem | null {
  if (typeof entry === "string") {
    const id = entry.trim();
    return id ? { id } : null;
  }
  if (!isRecord(entry)) return null;
  const explicit = str(entry.id) ?? str(entry.model_name) ?? str(entry.model);
  const name = str(entry.name);
  let id = explicit ?? name;
  if (!id) return null;
  if (!explicit && name) id = id.replace(/^models\//, "");
  if (!id) return null;
  const rawLabel = str(entry.display_name) ?? name;
  const label = rawLabel && rawLabel !== id ? rawLabel : undefined;
  const ownedBy = str(entry.owned_by) ?? str(entry.provider);
  return { id, ...(label ? { label } : {}), ...(ownedBy ? { ownedBy } : {}) };
}

/** True when the payload has a recognised model-list container (even if empty). */
function hasListShape(payload: unknown): boolean {
  if (Array.isArray(payload)) return true;
  if (!isRecord(payload)) return false;
  return (
    Array.isArray(payload.data) ||
    Array.isArray(payload.models) ||
    Array.isArray(payload.model_list) ||
    Boolean(str(payload.id) ?? str(payload.model))
  );
}

export function parseDiscoveredModels(payload: unknown): DiscoveredModelItem[] {
  let list: unknown[] = [];
  if (Array.isArray(payload)) list = payload;
  else if (isRecord(payload)) {
    if (Array.isArray(payload.data)) list = payload.data;
    else if (Array.isArray(payload.models)) list = payload.models;
    else if (Array.isArray(payload.model_list)) list = payload.model_list;
    else if (str(payload.id) ?? str(payload.model)) list = [payload];
  }
  const seen = new Set<string>();
  const out: DiscoveredModelItem[] = [];
  for (const entry of list) {
    const item = parseEntry(entry);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

function buildHeaders(
  apiKey: string,
  protocol?: ApiModelProtocol,
  cliEngine?: CliEngineId,
): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (!apiKey) return headers;
  if (protocol === "anthropic" || cliEngine === "claude") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    headers.Authorization = `Bearer ${apiKey}`;
  } else if (cliEngine === "gemini") {
    headers.Authorization = `Bearer ${apiKey}`;
    headers["x-goog-api-key"] = apiKey;
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

/** Probes candidate list endpoints; never throws and never leaks the apiKey. */
export async function discoverModelsFromEndpoint(input: ModelDiscoveryInput): Promise<ModelDiscoveryResult> {
  const started = Date.now();
  const apiKey = input.apiKey?.trim() ?? "";
  const redact = (s: string) => redactSecrets(s, [apiKey]);
  const fail = (message: string, endpoint?: string): ModelDiscoveryResult => ({
    ok: false,
    models: [],
    ...(endpoint ? { endpoint: redact(endpoint) } : {}),
    latencyMs: Date.now() - started,
    message: redact(message),
  });
  try {
    const protocol = input.kind === "api" ? (input.protocol ?? "openai") : input.protocol;
    const baseUrl = input.baseUrl?.trim() || (input.kind === "api" ? protocolDefaultBaseUrl(protocol ?? "openai") : "");
    if (!baseUrl) return fail("baseUrl is required");
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      return fail("baseUrl is not a valid URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return fail("baseUrl must use http: or https:");
    }
    if (!apiKey && protocol !== "ollama" && !isLocalModelEndpoint(baseUrl)) {
      return fail("API key is required to list models for this endpoint");
    }
    const doFetch = input.fetchImpl ?? fetch;
    const headers = buildHeaders(apiKey, protocol, input.cliEngine);
    let lastMessage = "No model list endpoint responded";
    for (const url of buildModelDiscoveryUrls(baseUrl, protocol, input.cliEngine)) {
      try {
        const res = await doFetch(url, { method: "GET", headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (res.status === 401 || res.status === 403) {
          return fail(`HTTP ${res.status}: authentication failed (check API key)`, url);
        }
        if (res.status === 404 || res.status === 405) {
          lastMessage = `HTTP ${res.status} at ${url}`;
          continue;
        }
        if (!res.ok) {
          lastMessage = `HTTP ${res.status} at ${url}`;
          continue;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(await res.text());
        } catch {
          lastMessage = `Non-JSON response at ${url}`;
          continue;
        }
        const models = parseDiscoveredModels(payload);
        if (models.length === 0 && !hasListShape(payload)) {
          lastMessage = `Unrecognised response shape at ${url}`;
          continue;
        }
        return {
          ok: true,
          models,
          endpoint: redact(url),
          latencyMs: Date.now() - started,
          message: redact(models.length ? `Found ${models.length} model(s)` : "Endpoint returned an empty model list"),
        };
      } catch (err) {
        lastMessage = `Request failed at ${url}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    return fail(lastMessage);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
