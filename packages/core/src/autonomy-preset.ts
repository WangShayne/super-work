import type { OperatingMode } from "./domain-types/engine.ts";
import type { AutonomyPreset, RepoConfig } from "./domain-types/repo.ts";
import type { DeliveryGatePolicy } from "./domain-types/review.ts";
import type { SandboxMode, VerificationStrategy } from "./domain-types/verification.ts";

export interface AutonomyPresetPatch {
  mode: OperatingMode;
  deliveryGatePolicy: DeliveryGatePolicy;
  riskThreshold?: number;
  sandboxMode: SandboxMode;
  verificationStrategy: VerificationStrategy;
  autoCleanupWorktree: boolean;
}

export const AUTONOMY_PRESETS: readonly AutonomyPreset[] = ["guarded", "smart", "autonomous"];

/** v1.8.0 前的旧预设名 → 规范名（旧 DB 记录 / .super-work.json 继续可用）。 */
const LEGACY_PRESET_ALIASES: Readonly<Record<string, AutonomyPreset>> = {
  copilot: "guarded",
  standard: "smart",
  autopilot: "autonomous",
};

const COMMON = {
  mode: "auto",
  sandboxMode: "balanced",
  verificationStrategy: "smart_tiered",
  autoCleanupWorktree: true,
} as const;

export const AUTONOMY_PRESET_DEFAULTS: Readonly<Record<AutonomyPreset, Readonly<AutonomyPresetPatch>>> = {
  guarded: { ...COMMON, deliveryGatePolicy: "always_signoff" },
  smart: { ...COMMON, deliveryGatePolicy: "risk_gated", riskThreshold: 35 },
  autonomous: { ...COMMON, deliveryGatePolicy: "always_auto" },
};

/** 仅接受规范名；需要兼容旧名请用 normalizeAutonomyPreset。 */
export function isAutonomyPreset(value: unknown): value is AutonomyPreset {
  return value === "guarded" || value === "smart" || value === "autonomous";
}

/** 规范名原样返回，旧别名（copilot/standard/autopilot）映射为新名，其余为 undefined。 */
export function normalizeAutonomyPreset(value: unknown): AutonomyPreset | undefined {
  if (isAutonomyPreset(value)) return value;
  if (typeof value === "string" && Object.hasOwn(LEGACY_PRESET_ALIASES, value)) {
    return LEGACY_PRESET_ALIASES[value];
  }
  return undefined;
}

/** 返回预设展开字段的副本，调用方可安全修改。 */
export function getAutonomyPresetPatch(preset: AutonomyPreset): AutonomyPresetPatch {
  return { ...AUTONOMY_PRESET_DEFAULTS[preset] };
}

/** 由现有 RepoConfig 字段反推最贴近的预设；无信息时为 smart。 */
export function inferAutonomyPreset(repo: Partial<RepoConfig>): AutonomyPreset {
  const stored = normalizeAutonomyPreset(repo.autonomyPreset);
  if (stored) return stored;
  switch (repo.deliveryGatePolicy) {
    case "always_auto":
      return "autonomous";
    case "always_signoff":
      return "guarded";
    default:
      return "smart";
  }
}
