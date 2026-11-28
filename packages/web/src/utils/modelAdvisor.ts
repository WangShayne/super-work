import type { PublicModelProfile } from "../types.ts";

/** Pure, dependency-free helpers behind the Role-First Model Studio (no runtime @super-work/core imports). */

export type ModelRole = "control" | "implement" | "review";

export interface RoleBindings {
  controlModelId: string;
  implementModelId: string;
  reviewModelId: string;
}

export type RecipeId = "hybrid_best" | "cli_heterogeneous" | "pure_api" | "smart_auto";

export interface SmartRecipe extends RoleBindings {
  id: RecipeId;
  isActive: boolean;
}

export type AdviceKind = "no_ready_models" | "same_model_self_review" | "empty_auto_pool" | "heuristic_control" | "unready_custom";

export interface ModelAdvice {
  kind: AdviceKind;
  severity: "warn" | "info";
  suggestedPatch?: Partial<RoleBindings>;
}

const CLI_RANK = ["claude", "codex", "opencode", "gemini"];
const CONTROL_API_RANK = ["deepseek", "openai", "ollama"];

const LOCALHOST_RE = /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i;

export function isLocalhostUrl(url?: string): boolean {
  return Boolean(url && LOCALHOST_RE.test(url.trim()));
}

/** A model that needs no API key: Ollama protocol or a localhost endpoint. */
export function isKeylessApi(p: Pick<PublicModelProfile, "apiProtocol" | "baseUrl">): boolean {
  return p.apiProtocol === "ollama" || isLocalhostUrl(p.baseUrl);
}

const rank = (list: string[], key?: string): number => {
  const i = key ? list.indexOf(key) : -1;
  return i < 0 ? list.length : i;
};

const readyOf = (profiles: PublicModelProfile[]) => profiles.filter((p) => p.ready);
const readyApis = (profiles: PublicModelProfile[]) => readyOf(profiles).filter((p) => p.kind === "api");
const readyClis = (profiles: PublicModelProfile[]) =>
  readyOf(profiles)
    .filter((p) => p.kind === "cli")
    .sort((a, b) => rank(CLI_RANK, a.cliEngine) - rank(CLI_RANK, b.cliEngine));

/** First ready API, preferring deepseek / openai / ollama (stable for ties). */
function pickControlApi(profiles: PublicModelProfile[]): PublicModelProfile | undefined {
  const apis = readyApis(profiles);
  return [...apis].sort((a, b) => rank(CONTROL_API_RANK, a.apiProtocol) - rank(CONTROL_API_RANK, b.apiProtocol))[0];
}

/** Best API for coding: anthropic > reasoner model > first ready API. */
function pickCodingApi(profiles: PublicModelProfile[]): PublicModelProfile | undefined {
  const apis = readyApis(profiles);
  return (
    apis.find((p) => p.apiProtocol === "anthropic") ??
    apis.find((p) => /reason|o\d|think/i.test(p.model ?? "")) ??
    apis[0]
  );
}

function bestControlCandidate(profiles: PublicModelProfile[]): PublicModelProfile | undefined {
  return pickControlApi(profiles) ?? readyClis(profiles)[0];
}

export function formatModelStatusHuman(p: PublicModelProfile, locale: "zh" | "en"): string {
  const zh = locale === "zh";
  if (p.kind === "cli") {
    if (!p.ready) {
      if (/not installed/i.test(p.readyDetail ?? "")) return zh ? "本机未安装该 CLI" : "CLI not installed";
      return zh ? "尚未登录本机 CLI（可在终端登录，或点编辑配置中转密钥）" : "CLI not signed in — log in or set a relay key";
    }
    if (p.baseUrl || p.hasApiKey) return zh ? "原厂 CLI 基座 · 已启用自定义中转/密钥" : "Native CLI harness · custom relay/key active";
    return zh ? "原厂 CLI 基座 · 本机订阅已就绪（免额外 Token 费）" : "Native CLI harness · local subscription ready";
  }
  if (!p.ready) {
    if (!p.baseUrl) return zh ? "待填写接口地址 (Base URL)" : "Base URL required";
    if (!p.model) return zh ? "待填写模型名称" : "Model name required";
    return zh ? "待填写 API Key — 点「编辑」补全后即可启用" : "API Key required — click Edit to activate";
  }
  if (isKeylessApi(p) && !p.hasApiKey) return zh ? "内置 API 基座 · 本地免密模型已就绪" : "Built-in API harness · local keyless model ready";
  return zh ? "内置 API 基座 · 密钥已就绪" : "Built-in API harness · API key ready";
}

export function activeRolesOfProfile(profileId: string, b: RoleBindings): ModelRole[] {
  const roles: ModelRole[] = [];
  if (b.controlModelId === profileId) roles.push("control");
  if (b.implementModelId === profileId) roles.push("implement");
  if (b.reviewModelId === profileId) roles.push("review");
  return roles;
}

/** Ready pool member that may be picked by Auto routing but is not explicitly pinned to any role. */
export function isAutoCandidate(p: PublicModelProfile, b: RoleBindings): boolean {
  return (
    p.ready &&
    p.workerAutoPool &&
    activeRolesOfProfile(p.id, b).length === 0 &&
    (b.implementModelId === "auto" || b.reviewModelId === "auto")
  );
}

export function buildSmartModelRecipes(profiles: PublicModelProfile[], current: RoleBindings): SmartRecipe[] {
  const ready = readyOf(profiles);
  const apis = readyApis(profiles);
  const clis = readyClis(profiles);
  const out: Array<Omit<SmartRecipe, "isActive">> = [];

  if (apis.length >= 1 && clis.length >= 1) {
    const control = pickControlApi(profiles)!;
    const implement = clis[0]!;
    const review =
      apis.find((p) => p.id !== control.id && p.id !== implement.id) ??
      clis.find((p) => p.id !== implement.id) ??
      (control.id !== implement.id ? control : undefined);
    out.push({ id: "hybrid_best", controlModelId: control.id, implementModelId: implement.id, reviewModelId: review?.id ?? "auto" });
  }
  if (clis.length >= 1) {
    out.push({ id: "cli_heterogeneous", controlModelId: clis[0]!.id, implementModelId: clis[0]!.id, reviewModelId: clis[1]?.id ?? "auto" });
  }
  if (apis.length >= 1) {
    const control = pickControlApi(profiles)!;
    const implement = pickCodingApi(profiles)!;
    const review = apis.find((p) => p.id !== implement.id);
    out.push({ id: "pure_api", controlModelId: control.id, implementModelId: implement.id, reviewModelId: review?.id ?? "auto" });
  }
  if (ready.length >= 2 && ready.some((p) => p.workerAutoPool)) {
    out.push({ id: "smart_auto", controlModelId: bestControlCandidate(profiles)!.id, implementModelId: "auto", reviewModelId: "auto" });
  }
  return out.map((r) => ({
    ...r,
    isActive:
      r.controlModelId === current.controlModelId &&
      r.implementModelId === current.implementModelId &&
      r.reviewModelId === current.reviewModelId,
  }));
}

export function diagnoseModelBindings(profiles: PublicModelProfile[], b: RoleBindings): ModelAdvice[] {
  const ready = readyOf(profiles);
  const advice: ModelAdvice[] = [];

  if (ready.length === 0) advice.push({ kind: "no_ready_models", severity: "warn" });

  if (b.implementModelId !== "auto" && b.reviewModelId !== "auto" && b.implementModelId === b.reviewModelId && ready.length >= 2) {
    const distinct = ready.find((p) => p.id !== b.implementModelId);
    advice.push({ kind: "same_model_self_review", severity: "warn", suggestedPatch: { reviewModelId: distinct?.id ?? "auto" } });
  }

  if ((b.implementModelId === "auto" || b.reviewModelId === "auto") && ready.length > 0 && ready.every((p) => !p.workerAutoPool)) {
    advice.push({ kind: "empty_auto_pool", severity: "warn" });
  }

  const candidate = bestControlCandidate(profiles);
  if (b.controlModelId === "heuristic" && candidate) {
    advice.push({ kind: "heuristic_control", severity: "info", suggestedPatch: { controlModelId: candidate.id } });
  }

  if (profiles.some((p) => !p.builtinCli && !p.ready)) advice.push({ kind: "unready_custom", severity: "info" });

  return advice;
}
