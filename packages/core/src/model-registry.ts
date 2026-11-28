// v1.8.1 Unified peer ModelProfile registry — pure, browser-safe (no node:* imports).
import type {
  ApiModelProtocol,
  ApiWorkerPreset,
  ApiWorkerProfile,
  CliEngineId,
  EngineModelProfile,
  EnginePreference,
  ModelProfile,
  PublicModelProfile,
  WorkerEngineId,
} from "./domain-types/engine.ts";
import type { StageKind } from "./domain-types/pipeline.ts";
import type { RepoConfig } from "./domain-types/repo.ts";
import type { CliScanReport, SystemSetupConfig } from "./domain-types/system.ts";
import type { Ticket } from "./domain-types/ticket.ts";

export const BUILTIN_CLI_PROFILE_IDS = ["cli_claude", "cli_codex", "cli_opencode", "cli_gemini"] as const;

const BUILTIN_CLI_META: ReadonlyArray<{ id: string; engine: CliEngineId; name: string }> = [
  { id: "cli_claude", engine: "claude", name: "Claude Code" },
  { id: "cli_codex", engine: "codex", name: "Codex CLI" },
  { id: "cli_opencode", engine: "opencode", name: "OpenCode" },
  { id: "cli_gemini", engine: "gemini", name: "Gemini CLI" },
];

export const LEGACY_API_WORKER_PROFILE_ID = "api_worker_default";

const DEFAULT_MODELS: Record<ApiModelProtocol, string> = {
  deepseek: "deepseek-chat",
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-5",
  ollama: "llama3.1",
};

export function protocolDefaultBaseUrl(protocol: ApiModelProtocol): string {
  switch (protocol) {
    case "deepseek":
      return "https://api.deepseek.com/v1";
    case "openai":
      return "https://api.openai.com/v1";
    case "anthropic":
      return "https://api.anthropic.com";
    case "ollama":
      return "http://localhost:11434/v1";
  }
}

export function protocolDefaultModel(protocol: ApiModelProtocol): string {
  return DEFAULT_MODELS[protocol];
}

export function mapProtocolToApiPreset(protocol: ApiModelProtocol): ApiWorkerPreset {
  return protocol === "ollama" ? "openai" : protocol;
}

export function isLocalModelEndpoint(baseUrl?: string): boolean {
  const raw = baseUrl?.trim();
  if (!raw) return false;
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host === "host.docker.internal"
  );
}

export function profileDriverEngine(profile: Pick<ModelProfile, "kind" | "cliEngine">): WorkerEngineId {
  return profile.kind === "cli" ? (profile.cliEngine ?? "claude") : "api";
}

/** Same mask shape as the server's maskApiKey (first 3 + **** + last 4). */
export function maskModelApiKey(key?: string): string | undefined {
  const trimmed = key?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}****`;
  return `${trimmed.slice(0, 3)}****${trimmed.slice(-4)}`;
}

type ReadinessInput = Pick<ModelProfile, "kind" | "cliEngine" | "apiProtocol" | "baseUrl" | "model" | "enabled"> & {
  hasApiKey?: boolean;
  apiKey?: string;
};

export function evaluateModelProfileReadiness(
  profile: ReadinessInput,
  scanReport?: CliScanReport | null,
): { ready: boolean; detail: string } {
  if (profile.enabled === false) return { ready: false, detail: "disabled" };
  const hasKey = Boolean(profile.hasApiKey || profile.apiKey?.trim());
  if (profile.kind === "cli") {
    const tool = scanReport?.tools.find((t) => t.id === (profile.cliEngine ?? "claude"));
    if (tool && !tool.installed) return { ready: false, detail: "CLI not installed" };
    if (hasKey) {
      return { ready: true, detail: profile.baseUrl?.trim() ? "CLI + custom relay" : "CLI + custom key" };
    }
    if (tool) {
      const ready = tool.authenticated !== false;
      return { ready, detail: tool.authSummary || (ready ? "CLI ready" : "CLI not logged in") };
    }
    return { ready: true, detail: "CLI ready" };
  }
  if (!profile.baseUrl?.trim()) return { ready: false, detail: "baseUrl required" };
  if (!profile.model?.trim()) return { ready: false, detail: "model required" };
  if (hasKey || profile.apiProtocol === "ollama" || isLocalModelEndpoint(profile.baseUrl)) {
    return { ready: true, detail: hasKey ? "API key configured" : "keyless local endpoint" };
  }
  return { ready: false, detail: "API key required" };
}

export function toPublicModelProfile(
  profile: ModelProfile,
  scanReport?: CliScanReport | null,
): PublicModelProfile {
  const { apiKey, ...rest } = profile;
  const readiness = evaluateModelProfileReadiness(profile, scanReport);
  const masked = maskModelApiKey(apiKey);
  return {
    ...rest,
    hasApiKey: Boolean(apiKey?.trim()),
    ...(masked ? { maskedApiKey: masked } : {}),
    ready: readiness.ready,
    readyDetail: readiness.detail,
  };
}

function cliProfileFromLegacy(
  meta: { id: string; engine: CliEngineId; name: string },
  legacy?: EngineModelProfile,
): ModelProfile {
  return {
    id: meta.id,
    name: meta.name,
    kind: "cli",
    cliEngine: meta.engine,
    ...(legacy?.baseUrl?.trim() ? { baseUrl: legacy.baseUrl.trim() } : {}),
    ...(legacy?.model?.trim() ? { model: legacy.model.trim() } : {}),
    ...(legacy?.effort ? { effort: legacy.effort } : {}),
    ...(legacy?.apiKey?.trim() ? { apiKey: legacy.apiKey.trim() } : {}),
    workerAutoPool: true,
    enabled: true,
    builtinCli: true,
  };
}

function legacyProtocol(preset: string): ApiModelProtocol {
  return preset === "deepseek" ? "deepseek" : preset === "anthropic" ? "anthropic" : "openai";
}

function sameEndpoint(a: ModelProfile, b: Pick<ModelProfile, "baseUrl" | "model" | "apiKey">): boolean {
  const norm = (u?: string) => (u ?? "").trim().replace(/\/+$/, "");
  return (
    a.kind === "api" &&
    norm(a.baseUrl) === norm(b.baseUrl) &&
    (a.model ?? "").trim() === (b.model ?? "").trim() &&
    (a.apiKey ?? "").trim() === (b.apiKey ?? "").trim()
  );
}

/**
 * Lossless, idempotent normalization: ensures the 4 builtin CLI profiles, migrates legacy
 * apiWorkerProfile / HTTP llmPreset into modelProfiles, and resolves the three role bindings.
 * Legacy fields are never dropped.
 */
export function normalizeSystemSetupConfig(
  raw: SystemSetupConfig | null | undefined,
  _scanReport?: CliScanReport | null,
): SystemSetupConfig {
  const base: SystemSetupConfig = raw ?? {
    initialized: false,
    llmPreset: "heuristic",
    llmBaseUrl: "",
    llmModel: "",
    preferredImplementEngine: "claude",
    preferredReviewEngine: "codex",
    updatedAt: new Date(0).toISOString(),
  };
  const profiles: ModelProfile[] = (base.modelProfiles ?? []).map((p) => ({ ...p }));
  const has = (id: string) => profiles.some((p) => p.id === id);

  const legacyByEngine: Record<CliEngineId, EngineModelProfile | undefined> = {
    claude: base.claudeProfile,
    codex: base.codexProfile,
    opencode: base.opencodeProfile,
    gemini: base.geminiProfile,
  };
  const builtins: ModelProfile[] = [];
  for (const meta of BUILTIN_CLI_META) {
    if (!has(meta.id)) builtins.push(cliProfileFromLegacy(meta, legacyByEngine[meta.engine]));
  }
  profiles.unshift(...builtins);

  const api = base.apiWorkerProfile;
  if (api && !has(LEGACY_API_WORKER_PROFILE_ID)) {
    profiles.push({
      id: LEGACY_API_WORKER_PROFILE_ID,
      name: "API Worker",
      kind: "api",
      apiProtocol: legacyProtocol(api.preset),
      baseUrl: api.baseUrl,
      model: api.model,
      ...(api.effort ? { effort: api.effort } : {}),
      ...(api.apiKey?.trim() ? { apiKey: api.apiKey.trim() } : {}),
      workerAutoPool: true,
      enabled: true,
    });
  }

  let migratedLlmId: string | undefined;
  const preset = base.llmPreset;
  if (
    (preset === "deepseek" || preset === "openai" || preset === "custom") &&
    (base.llmApiKey?.trim() || base.llmBaseUrl?.trim())
  ) {
    const protocol = legacyProtocol(preset);
    const candidate = {
      baseUrl: base.llmBaseUrl.trim() || protocolDefaultBaseUrl(protocol),
      model: base.llmModel.trim() || protocolDefaultModel(protocol),
      apiKey: base.llmApiKey?.trim() || undefined,
    };
    const dup = profiles.find((p) => sameEndpoint(p, candidate));
    if (dup) {
      migratedLlmId = dup.id;
    } else {
      const id = `api_llm_${preset}`;
      migratedLlmId = id;
      if (!has(id)) {
        profiles.push({
          id,
          name: preset === "deepseek" ? "DeepSeek" : preset === "openai" ? "OpenAI" : "Custom LLM",
          kind: "api",
          apiProtocol: protocol,
          ...candidate,
          ...(base.llmEffort ? { effort: base.llmEffort } : {}),
          // lightweight control-plane model: opt out of Worker 'auto' pool by default
          workerAutoPool: false,
          enabled: true,
        });
      }
    }
  }

  const known = new Set(profiles.map((p) => p.id));
  const legacyControl =
    preset === "claude_cli" ? "cli_claude" : preset === "codex_cli" ? "cli_codex" : migratedLlmId;
  const control =
    base.controlModelId === "heuristic" || (base.controlModelId && known.has(base.controlModelId))
      ? base.controlModelId
      : legacyControl && known.has(legacyControl)
        ? legacyControl
        : "heuristic";
  const roleOrAuto = (id?: string) => (id && id !== "auto" && known.has(id) ? id : "auto");

  return {
    ...base,
    modelProfiles: profiles,
    controlModelId: control,
    implementModelId: roleOrAuto(base.implementModelId),
    reviewModelId: roleOrAuto(base.reviewModelId),
  };
}

/** Legacy-shaped view of an API ModelProfile (what ApiWorkerDriver consumes as its fallback profile). */
export function toApiWorkerProfile(p: ModelProfile): ApiWorkerProfile {
  const protocol = p.apiProtocol ?? "openai";
  return {
    preset: mapProtocolToApiPreset(protocol),
    baseUrl: p.baseUrl?.trim() || protocolDefaultBaseUrl(protocol),
    model: p.model?.trim() ?? "",
    ...(p.apiKey?.trim() ? { apiKey: p.apiKey.trim() } : {}),
    ...(p.effort ? { effort: p.effort } : {}),
  };
}

/**
 * First usable API worker config: the legacy apiWorkerProfile when it is ready, otherwise the first
 * enabled, ready `kind === 'api'` ModelProfile. Drives ApiWorkerDriver.isAvailable().
 */
export function pickUsableApiWorkerProfile(
  setupConfig: SystemSetupConfig | null | undefined,
): ApiWorkerProfile | undefined {
  const legacy = setupConfig?.apiWorkerProfile;
  if (
    legacy &&
    evaluateModelProfileReadiness({
      kind: "api",
      apiProtocol: legacy.preset === "anthropic" ? "anthropic" : "openai",
      baseUrl: legacy.baseUrl,
      model: legacy.model,
      apiKey: legacy.apiKey,
      enabled: true,
    }).ready
  ) {
    return legacy;
  }
  const profile = setupConfig?.modelProfiles?.find(
    (p) => p.kind === "api" && evaluateModelProfileReadiness(p).ready,
  );
  return profile ? toApiWorkerProfile(profile) : legacy;
}

/**
 * Turns a user-supplied preferredModelId into ticket fields. Unknown/disabled ids are still
 * persisted (the profile may be re-enabled later) but do not pin an engine.
 */
export function resolveModelPreference(
  setupConfig: SystemSetupConfig | null | undefined,
  rawId: string | undefined,
): { preferredModelId?: string; preferredEngine?: WorkerEngineId; activeModelId?: string } {
  const id = rawId?.trim();
  if (!id) return {};
  const profile = setupConfig?.modelProfiles?.find((p) => p.id === id && p.enabled !== false);
  return profile
    ? { preferredModelId: id, preferredEngine: profileDriverEngine(profile), activeModelId: id }
    : { preferredModelId: id };
}

/**
 * Live-steer engine/model fields: a model id pins its profile + engine; a bare engine choice
 * (including 'auto') clears any stale model pin; no choice at all leaves the ticket untouched.
 */
export function resolveSteerModelFields(
  setupConfig: SystemSetupConfig | null | undefined,
  input: { preferredEngine?: EnginePreference; preferredModelId?: string },
): {
  enginePref?: EnginePreference;
  modelFields: { preferredModelId?: string; activeModelId?: string } | null;
} {
  if (input.preferredModelId?.trim()) {
    const pref = resolveModelPreference(setupConfig, input.preferredModelId);
    return {
      enginePref: pref.preferredEngine ?? input.preferredEngine,
      modelFields: { preferredModelId: pref.preferredModelId, activeModelId: pref.activeModelId },
    };
  }
  return {
    enginePref: input.preferredEngine,
    modelFields:
      input.preferredEngine !== undefined ? { preferredModelId: undefined, activeModelId: undefined } : null,
  };
}

export interface StageModelSelectionInput {
  stage: StageKind;
  ticket: Pick<Ticket, "activeModelId" | "preferredModelId" | "failedEngines">;
  repo: Pick<RepoConfig, "implementModelId" | "reviewModelId">;
  setupConfig?: SystemSetupConfig | null;
  availableEngines: WorkerEngineId[];
  trippedEngines?: WorkerEngineId[];
  failedEngines?: WorkerEngineId[];
  /** ModelProfile id of the last completed implement run (review cross-check). */
  implementProfileId?: string;
  /** Engine used by the implementer when no profile id is known. */
  implementEngine?: WorkerEngineId;
  /** Engine chosen by the legacy path; returned when no profile applies. */
  legacyEngine?: WorkerEngineId;
  /** True when a concrete (non-'auto') legacy engine was requested; suppresses profile auto-pool. */
  explicitEngine?: boolean;
  scanReport?: CliScanReport | null;
}

function archKey(p: ModelProfile): string {
  return p.kind === "cli" ? `cli:${p.cliEngine ?? "claude"}` : `api:${p.apiProtocol ?? "openai"}`;
}

/** Resolves {engine, profile?}; profile is undefined when the legacy engine path should apply. */
export function resolveStageModelSelection(
  input: StageModelSelectionInput,
): { engine: WorkerEngineId; profile?: ModelProfile } {
  const profiles = input.setupConfig?.modelProfiles ?? [];
  const fallback = input.legacyEngine ?? input.availableEngines[0] ?? "claude";
  if (profiles.length === 0) return { engine: fallback };

  const byId = (id?: string) => (id ? profiles.find((p) => p.id === id && p.enabled !== false) : undefined);
  const isReview = input.stage === "review";
  const tripped = new Set(input.trippedEngines ?? []);
  const failed = new Set(input.failedEngines ?? input.ticket.failedEngines ?? []);
  const usable = (p: ModelProfile): boolean => {
    const eng = profileDriverEngine(p);
    return (
      input.availableEngines.includes(eng) &&
      !tripped.has(eng) &&
      !failed.has(eng) &&
      evaluateModelProfileReadiness(p, input.scanReport).ready
    );
  };
  const hit = (p: ModelProfile) => ({ engine: profileDriverEngine(p), profile: p });
  /** Explicit picks bypass workerAutoPool but not tripped/failed engines (legacy failover handles those). */
  const pinned = (id?: string): ModelProfile | undefined => {
    const p = byId(id);
    if (!p) return undefined;
    const eng = profileDriverEngine(p);
    return tripped.has(eng) || failed.has(eng) ? undefined : p;
  };

  if (!isReview) {
    const explicit = pinned(input.ticket.activeModelId ?? input.ticket.preferredModelId);
    if (explicit) return hit(explicit);
    const roleId = input.repo.implementModelId ?? input.setupConfig?.implementModelId;
    const role = roleId && roleId !== "auto" ? pinned(roleId) : undefined;
    if (role) return hit(role);
    if (roleId !== "auto") return { engine: fallback };
    const pool = profiles.filter((p) => p.enabled !== false && p.workerAutoPool !== false && usable(p));
    // A concrete legacy engine preference narrows 'auto' to the profiles of that engine.
    const pick = input.explicitEngine ? pool.find((p) => profileDriverEngine(p) === fallback) : pool[0];
    return pick ? hit(pick) : { engine: fallback };
  }

  const roleId = input.repo.reviewModelId ?? input.setupConfig?.reviewModelId;
  const role = roleId && roleId !== "auto" ? pinned(roleId) : undefined;
  if (role) return hit(role);
  if (roleId !== "auto") return { engine: fallback };

  const pool = profiles.filter((p) => p.enabled !== false && p.workerAutoPool !== false && usable(p));
  if (pool.length === 0) return { engine: fallback };
  const impl = byId(input.implementProfileId);
  if (!impl) {
    const diffEngine = input.implementEngine
      ? pool.find((p) => profileDriverEngine(p) !== input.implementEngine)
      : undefined;
    return hit(diffEngine ?? pool[0]!);
  }
  const pick =
    pool.find((p) => archKey(p) !== archKey(impl)) ??
    pool.find((p) => p.id !== impl.id) ??
    pool[0]!;
  return hit(pick);
}
