import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  AUTONOMY_PRESET_DEFAULTS,
  classifyInboxHumanAction,
  detectRepoDefaults,
  getAutonomyPresetPatch,
  inferAutonomyPreset,
  isAutonomyPreset,
  normalizeAutonomyPreset,
  type InboxHumanAction,
  type InboxItemKind,
} from "../src/index.ts";

const tempDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sw-v180-"));
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("v1.8.0 AutonomyPreset", () => {
  it("maps each preset to the documented defaults", () => {
    expect(getAutonomyPresetPatch("guarded")).toMatchObject({
      mode: "auto",
      deliveryGatePolicy: "always_signoff",
      sandboxMode: "balanced",
      autoCleanupWorktree: true,
    });
    expect(getAutonomyPresetPatch("smart")).toMatchObject({
      deliveryGatePolicy: "risk_gated",
      riskThreshold: 35,
    });
    expect(getAutonomyPresetPatch("autonomous").deliveryGatePolicy).toBe("always_auto");
  });

  it("returns a copy so callers cannot mutate defaults", () => {
    const p = getAutonomyPresetPatch("smart");
    p.riskThreshold = 99;
    expect(AUTONOMY_PRESET_DEFAULTS.smart.riskThreshold).toBe(35);
  });

  it("infers presets from explicit preset or delivery gate policy", () => {
    expect(inferAutonomyPreset({ autonomyPreset: "autonomous", deliveryGatePolicy: "always_signoff" })).toBe(
      "autonomous",
    );
    expect(inferAutonomyPreset({ deliveryGatePolicy: "always_auto" })).toBe("autonomous");
    expect(inferAutonomyPreset({ deliveryGatePolicy: "always_signoff" })).toBe("guarded");
    expect(inferAutonomyPreset({ deliveryGatePolicy: "risk_gated" })).toBe("smart");
    expect(inferAutonomyPreset({})).toBe("smart");
  });

  it("normalizes canonical names and legacy aliases; rejects everything else", () => {
    for (const p of ["guarded", "smart", "autonomous"] as const) {
      expect(isAutonomyPreset(p)).toBe(true);
      expect(normalizeAutonomyPreset(p)).toBe(p);
    }
    expect(normalizeAutonomyPreset("copilot")).toBe("guarded");
    expect(normalizeAutonomyPreset("standard")).toBe("smart");
    expect(normalizeAutonomyPreset("autopilot")).toBe("autonomous");
    // isAutonomyPreset stays strict: legacy aliases are not canonical.
    expect(isAutonomyPreset("copilot")).toBe(false);
    for (const bad of ["bogus", "", "toString", "__proto__", null, undefined, 42, {}]) {
      expect(normalizeAutonomyPreset(bad)).toBeUndefined();
    }
  });

  it("keeps legacy stored presets working when inferring", () => {
    const legacy = (v: string) => ({ autonomyPreset: v }) as unknown as Parameters<typeof inferAutonomyPreset>[0];
    expect(inferAutonomyPreset(legacy("copilot"))).toBe("guarded");
    expect(inferAutonomyPreset(legacy("standard"))).toBe("smart");
    expect(inferAutonomyPreset(legacy("autopilot"))).toBe("autonomous");
  });
});

describe("v1.8.0 inbox taxonomy", () => {
  it("classifies every inbox kind into approve / answer / unblock", () => {
    const expected: Record<InboxItemKind, InboxHumanAction> = {
      outbox_signoff: "approve",
      plan_approval: "approve",
      observe_proposal: "approve",
      milestone_ready: "approve",
      arena_tiebreak: "approve",
      clarification_request: "answer",
      epic_replan: "answer",
      mandate_violation: "unblock",
      watchdog_escalation: "unblock",
      merge_conflict: "unblock",
      budget_cap: "unblock",
      pr_followup: "unblock",
      campaign_paused: "unblock",
    };
    for (const [kind, action] of Object.entries(expected)) {
      expect(classifyInboxHumanAction(kind as InboxItemKind)).toBe(action);
    }
  });
});

describe("v1.8.0 detectRepoDefaults", () => {
  it("detects Bun scripts and git branch from .git/HEAD", () => {
    const d = tmp();
    mkdirSync(join(d, ".git"));
    writeFileSync(join(d, ".git", "HEAD"), "ref: refs/heads/develop\n");
    writeFileSync(join(d, "bun.lock"), "");
    writeFileSync(
      join(d, "package.json"),
      JSON.stringify({ name: "@acme/app", scripts: { build: "x", test: "y", typecheck: "z", lint: "l" } }),
    );
    const r = detectRepoDefaults(d);
    expect(r.stackLabel).toBe("bun");
    expect(r.baseBranch).toBe("develop");
    expect(r.name).toBe("app");
    expect(r.verificationCommands).toEqual(["bun run typecheck", "bun run test", "bun run build"]);
    expect(r.autonomyPreset).toBe("smart");
    expect(r.preferredImplementEngine).toBe("auto");
  });

  it("detects Node projects without a bun lockfile and tolerates broken package.json", () => {
    const d = tmp();
    writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: "t" } }));
    const r = detectRepoDefaults(d);
    expect(r.stackLabel).toBe("node");
    expect(r.verificationCommands).toEqual(["npm run test"]);
    expect(r.baseBranch).toBe("main");

    const bad = tmp();
    writeFileSync(join(bad, "package.json"), "{ not json");
    expect(detectRepoDefaults(bad).verificationCommands).toEqual([]);
  });

  it("detects Rust, Python, Go and unknown stacks", () => {
    const rust = tmp();
    writeFileSync(join(rust, "Cargo.toml"), "[package]\nname='x'\n");
    expect(detectRepoDefaults(rust)).toMatchObject({
      stackLabel: "rust",
      verificationCommands: ["cargo check", "cargo test"],
    });

    const py = tmp();
    writeFileSync(join(py, "pyproject.toml"), "[project]\nname='x'\n");
    expect(detectRepoDefaults(py)).toMatchObject({ stackLabel: "python", verificationCommands: ["pytest"] });

    const go = tmp();
    writeFileSync(join(go, "go.mod"), "module x\n");
    expect(detectRepoDefaults(go)).toMatchObject({
      stackLabel: "go",
      verificationCommands: ["go vet ./...", "go test ./..."],
    });

    expect(detectRepoDefaults(tmp())).toMatchObject({ stackLabel: "unknown", verificationCommands: [] });
  });
});
