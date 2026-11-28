import type {
  ApiModelProtocol,
  ApiWorkerPreset,
  ApiWorkerProfile,
  CliEngineId,
  EngineModelProfile,
  ModelProfile,
  ModelProfileKind,
  ReasoningEffort,
  SystemSetupConfig,
  WorkerEngineId,
} from "@super-work/core";
import { testModelProfileConnection, testWorkerConnection } from "@super-work/drivers";
import type { ServerRouteContext } from "./context.ts";

export const API_PRESETS: readonly ApiWorkerPreset[] = ["deepseek", "openai", "anthropic", "custom"];
export const CLI_WORKER_ENGINES = ["claude", "codex", "opencode", "gemini"] as const;
export type CliWorkerEngine = (typeof CLI_WORKER_ENGINES)[number];

const PRESET_BASE_URLS: Partial<Record<ApiWorkerPreset, string>> = {
  deepseek: "https://api.deepseek.com/v1",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
};

export type EngineProfileInput = Partial<EngineModelProfile> & { clearApiKey?: boolean };
export type ApiWorkerProfileInput = Partial<ApiWorkerProfile> & { clearApiKey?: boolean };

export class SetupValidationError extends Error {}

function cleanBaseUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new SetupValidationError(`baseUrl '${trimmed}' is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SetupValidationError("baseUrl must use http or https");
  }
  return trimmed.replace(/\/+$/, "");
}

/** Saved apiKey is preserved when the request omits one, unless clearApiKey is set. */
function resolveKey(input: { apiKey?: string; clearApiKey?: boolean }, prev?: string): string | undefined {
  if (input.clearApiKey) return undefined;
  return input.apiKey?.trim() || prev;
}

export function cleanEngineProfile(input: EngineProfileInput | undefined, prev?: EngineModelProfile): EngineModelProfile {
  const apiKey = resolveKey(input ?? {}, prev?.apiKey);
  const baseUrl = cleanBaseUrl(input?.baseUrl);
  return {
    model: input?.model?.trim() || undefined,
    effort: input?.effort || undefined,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
}

export function cleanApiWorkerProfile(input: ApiWorkerProfileInput, prev?: ApiWorkerProfile): ApiWorkerProfile {
  const preset = input.preset ?? prev?.preset ?? "custom";
  if (!API_PRESETS.includes(preset)) throw new SetupValidationError(`unknown api preset '${preset}'`);
  const apiKey = resolveKey(input, prev?.apiKey);
  const effort: ReasoningEffort | undefined = input.effort ?? prev?.effort;
  return {
    preset,
    baseUrl: cleanBaseUrl(input.baseUrl) ?? PRESET_BASE_URLS[preset] ?? prev?.baseUrl ?? "",
    model: input.model?.trim() ?? prev?.model ?? "",
    ...(apiKey ? { apiKey } : {}),
    ...(effort ? { effort } : {}),
  };
}

/** Clears a tripped circuit breaker so freshly configured credentials are eligible immediately. */
export async function resetTrippedEngineHealth(
  ctx: ServerRouteContext,
  engines: WorkerEngineId[],
): Promise<WorkerEngineId[]> {
  const cleared: WorkerEngineId[] = [];
  for (const engine of engines) {
    const record = await ctx.stateStore.getEngineHealth?.(engine);
    if (record && (record.status === "tripped" || record.consecutiveFailures > 0)) {
      await ctx.kernel.resetEngineHealth(engine);
      cleared.push(engine);
    }
  }
  return cleared;
}

const MODEL_KINDS: readonly ModelProfileKind[] = ["cli", "api"];
const API_PROTOCOLS: readonly ApiModelProtocol[] = ["deepseek", "openai", "anthropic", "ollama"];

export type ModelProfileInput = Partial<ModelProfile> & { clearApiKey?: boolean };

/** Validates/merges a partial ModelProfile onto the saved one (same id); saved key survives blanks. */
export function cleanModelProfile(input: ModelProfileInput, prev?: ModelProfile): ModelProfile {
  const kind = prev?.builtinCli ? prev.kind : (input.kind ?? prev?.kind);
  if (!kind || !MODEL_KINDS.includes(kind)) {
    throw new SetupValidationError("model profile kind must be 'cli' or 'api'");
  }
  const cliEngine: CliEngineId | undefined =
    kind === "cli"
      ? prev?.builtinCli
        ? prev.cliEngine
        : (input.cliEngine ?? prev?.cliEngine ?? "claude")
      : undefined;
  if (cliEngine && !(CLI_WORKER_ENGINES as readonly string[]).includes(cliEngine)) {
    throw new SetupValidationError(`unknown cliEngine '${cliEngine}'`);
  }
  const apiProtocol: ApiModelProtocol | undefined =
    kind === "api" ? (input.apiProtocol ?? prev?.apiProtocol ?? "openai") : undefined;
  if (apiProtocol && !API_PROTOCOLS.includes(apiProtocol)) {
    throw new SetupValidationError(`unknown apiProtocol '${apiProtocol}'`);
  }
  const baseUrl = input.baseUrl !== undefined ? cleanBaseUrl(input.baseUrl) : prev?.baseUrl;
  const model = input.model !== undefined ? input.model.trim() || undefined : prev?.model;
  const effort = input.effort ?? prev?.effort;
  const apiKey = resolveKey(input, prev?.apiKey);
  const id = prev?.id ?? (input.id?.trim() || `model_${crypto.randomUUID().slice(0, 8)}`);
  return {
    id,
    name: input.name?.trim() || prev?.name || id,
    kind,
    ...(cliEngine ? { cliEngine } : {}),
    ...(apiProtocol ? { apiProtocol } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(apiKey ? { apiKey } : {}),
    workerAutoPool: input.workerAutoPool ?? prev?.workerAutoPool ?? true,
    enabled: input.enabled ?? prev?.enabled ?? true,
    ...(prev?.builtinCli ? { builtinCli: true } : {}),
  };
}

/** Upserts inputs by id into the saved list (unmentioned profiles are kept). */
export function mergeModelProfiles(
  saved: ModelProfile[],
  inputs: ModelProfileInput[],
): { profiles: ModelProfile[]; touched: ModelProfile[] } {
  const profiles = [...saved];
  const touched: ModelProfile[] = [];
  for (const input of inputs) {
    const wantedId = input.id?.trim();
    const idx = wantedId ? profiles.findIndex((p) => p.id === wantedId) : -1;
    const next = cleanModelProfile(input, idx >= 0 ? profiles[idx] : undefined);
    if (idx >= 0) profiles[idx] = next;
    else profiles.push(next);
    touched.push(next);
  }
  return { profiles, touched };
}

/**
 * Removes custom profiles by id. builtinCli profiles are protected (400); unknown ids are ignored
 * so repeated deletes stay idempotent.
 */
export function applyProfileDeletions(
  profiles: ModelProfile[],
  ids: unknown,
): { profiles: ModelProfile[]; deleted: Set<string> } {
  if (ids === undefined) return { profiles, deleted: new Set() };
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    throw new SetupValidationError("deleteModelProfileIds must be an array of strings");
  }
  const wanted = new Set((ids as string[]).map((id) => id.trim()).filter(Boolean));
  const deleted = new Set<string>();
  for (const p of profiles) {
    if (!wanted.has(p.id)) continue;
    if (p.builtinCli) throw new SetupValidationError(`builtin CLI profile '${p.id}' cannot be deleted`);
    deleted.add(p.id);
  }
  return { profiles: profiles.filter((p) => !deleted.has(p.id)), deleted };
}

/** Mirrors legacy claudeProfile..apiWorkerProfile edits onto their peer ModelProfiles (backward compat). */
export function syncLegacyIntoProfiles(
  profiles: ModelProfile[],
  opts: {
    claude?: EngineModelProfile;
    codex?: EngineModelProfile;
    opencode?: EngineModelProfile;
    gemini?: EngineModelProfile;
    api?: ApiWorkerProfile;
    refreshLegacyLlm: boolean;
    skipIds: Set<string>;
  },
): ModelProfile[] {
  let next = opts.refreshLegacyLlm
    ? profiles.filter((p) => !p.id.startsWith("api_llm_") || opts.skipIds.has(p.id))
    : [...profiles];
  const strip = (p: ModelProfile): ModelProfile => {
    const { baseUrl, model, effort, apiKey, ...rest } = p;
    return rest;
  };
  for (const engine of CLI_WORKER_ENGINES) {
    const legacy = opts[engine];
    const id = `cli_${engine}`;
    if (!legacy || opts.skipIds.has(id)) continue;
    next = next.map((p) =>
      p.id !== id
        ? p
        : {
            ...strip(p),
            ...(legacy.baseUrl ? { baseUrl: legacy.baseUrl } : {}),
            ...(legacy.model ? { model: legacy.model } : {}),
            ...(legacy.effort ? { effort: legacy.effort } : {}),
            ...(legacy.apiKey ? { apiKey: legacy.apiKey } : {}),
          },
    );
  }
  const apiId = "api_worker_default";
  if (opts.api && !opts.skipIds.has(apiId)) {
    const prev = next.find((p) => p.id === apiId);
    const synced: ModelProfile = {
      ...(prev ? strip(prev) : { id: apiId, name: "API Worker", workerAutoPool: true, enabled: true }),
      kind: "api",
      apiProtocol: opts.api.preset === "custom" ? "openai" : opts.api.preset,
      ...(opts.api.baseUrl ? { baseUrl: opts.api.baseUrl } : {}),
      ...(opts.api.model ? { model: opts.api.model } : {}),
      ...(opts.api.effort ? { effort: opts.api.effort } : {}),
      ...(opts.api.apiKey ? { apiKey: opts.api.apiKey } : {}),
    };
    next = prev ? next.map((p) => (p.id === apiId ? synced : p)) : [...next, synced];
  }
  return next;
}

/** role ids must be 'auto' (or 'heuristic' for control) or reference a saved profile. */
export function validateRoleId(
  role: "controlModelId" | "implementModelId" | "reviewModelId",
  value: string | undefined,
  profiles: ModelProfile[],
): void {
  if (value === undefined) return;
  const special = role === "controlModelId" ? "heuristic" : "auto";
  if (value === special || profiles.some((p) => p.id === value)) return;
  throw new SetupValidationError(`${role} '${value}' is not '${special}' or a known model profile id`);
}

export function registerTestModelRoute(ctx: ServerRouteContext): void {
  ctx.app.post("/api/setup/test-model", async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | (ModelProfileInput & { useSavedKey?: boolean })
      | null;
    if (!body || !body.kind || !MODEL_KINDS.includes(body.kind)) {
      return c.json({ error: "kind must be 'cli' or 'api'" }, 400);
    }
    let apiKey = body.apiKey?.trim();
    if (!apiKey && body.useSavedKey && body.id) {
      const saved = await ctx.stateStore.getSystemSetting<SystemSetupConfig>("setup_config");
      apiKey = saved?.modelProfiles?.find((p) => p.id === body.id)?.apiKey;
    }
    let profile: ModelProfile;
    try {
      profile = cleanModelProfile({ ...body, apiKey, id: body.id ?? "test" });
    } catch (err) {
      if (err instanceof SetupValidationError) return c.json({ error: err.message }, 400);
      throw err;
    }
    return c.json(await testModelProfileConnection({ ...profile, enabled: true }));
  });
}

export function registerTestWorkerRoute(ctx: ServerRouteContext): void {
  ctx.app.post("/api/setup/test-worker", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      engine?: string;
      preset?: ApiWorkerPreset;
      baseUrl?: string;
      model?: string;
      apiKey?: string;
      useSavedKey?: boolean;
    } | null;
    const engine = [...CLI_WORKER_ENGINES, "api" as const].find((e) => e === body?.engine);
    if (!body || !engine) {
      return c.json({ error: `engine must be one of api, ${CLI_WORKER_ENGINES.join(", ")}` }, 400);
    }
    if (body.preset !== undefined && !API_PRESETS.includes(body.preset)) {
      return c.json({ error: `unknown api preset '${body.preset}'` }, 400);
    }

    const saved = await ctx.stateStore.getSystemSetting<SystemSetupConfig>("setup_config");
    const savedApi = body.useSavedKey && engine === "api" ? saved?.apiWorkerProfile : undefined;
    const savedProfile: EngineModelProfile | ApiWorkerProfile | undefined =
      engine === "api" ? savedApi : body.useSavedKey ? saved?.[`${engine}Profile`] : undefined;
    const result = await testWorkerConnection({
      engine,
      preset: body.preset ?? savedApi?.preset,
      baseUrl: body.baseUrl?.trim() || savedProfile?.baseUrl,
      model: body.model?.trim() || savedProfile?.model,
      apiKey: body.apiKey?.trim() || savedProfile?.apiKey,
    });
    return c.json(result);
  });
}
