import { describe, expect, it } from "bun:test";
import type { PublicModelProfile } from "../src/types.ts";
import {
  activeRolesOfProfile,
  buildSmartModelRecipes,
  diagnoseModelBindings,
  formatModelStatusHuman,
  isAutoCandidate,
  isLocalhostUrl,
  type RoleBindings,
} from "../src/utils/modelAdvisor.ts";

const mk = (over: Partial<PublicModelProfile> & { id: string }): PublicModelProfile =>
  ({
    name: over.id,
    kind: "api",
    workerAutoPool: true,
    enabled: true,
    hasApiKey: false,
    ready: true,
    ...over,
  }) as PublicModelProfile;

const claude = mk({ id: "cli-claude", kind: "cli", cliEngine: "claude", builtinCli: true });
const codex = mk({ id: "cli-codex", kind: "cli", cliEngine: "codex", builtinCli: true });
const gemini = mk({ id: "cli-gemini", kind: "cli", cliEngine: "gemini", builtinCli: true });
const deepseek = mk({ id: "api-ds", apiProtocol: "deepseek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", hasApiKey: true });
const anthropic = mk({ id: "api-an", apiProtocol: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-5", hasApiKey: true });
const B = (c: string, i: string, r: string): RoleBindings => ({ controlModelId: c, implementModelId: i, reviewModelId: r });

describe("formatModelStatusHuman", () => {
  const RAW = /oauth|firstParty|Logged in|cli:claude|providers:/i;

  it("CLI branches (zh + en) never leak raw detail", () => {
    const raw = "Logged in using ChatGPT oauth_token / firstParty providers: openai";
    const notInstalled = mk({ id: "x", kind: "cli", ready: false, readyDetail: "claude not installed" });
    const notSigned = mk({ id: "x", kind: "cli", ready: false, readyDetail: raw });
    const relay = mk({ id: "x", kind: "cli", baseUrl: "https://relay.example", readyDetail: raw });
    const sub = mk({ id: "x", kind: "cli", readyDetail: raw });
    expect(formatModelStatusHuman(notInstalled, "en")).toBe("CLI not installed");
    expect(formatModelStatusHuman(notInstalled, "zh")).toBe("本机未安装该 CLI");
    expect(formatModelStatusHuman(notSigned, "en")).toBe("CLI not signed in — log in or set a relay key");
    expect(formatModelStatusHuman(notSigned, "zh")).toContain("尚未登录本机 CLI");
    expect(formatModelStatusHuman(relay, "en")).toBe("Native CLI harness · custom relay/key active");
    expect(formatModelStatusHuman({ ...sub, hasApiKey: true }, "zh")).toBe("原厂 CLI 基座 · 已启用自定义中转/密钥");
    expect(formatModelStatusHuman(sub, "en")).toBe("Native CLI harness · local subscription ready");
    expect(formatModelStatusHuman(sub, "zh")).toBe("原厂 CLI 基座 · 本机订阅已就绪（免额外 Token 费）");
    for (const p of [notInstalled, notSigned, relay, sub]) for (const l of ["zh", "en"] as const) expect(formatModelStatusHuman(p, l)).not.toMatch(RAW);
  });

  it("API branches in spec order", () => {
    expect(formatModelStatusHuman(mk({ id: "a", ready: false }), "en")).toBe("Base URL required");
    expect(formatModelStatusHuman(mk({ id: "a", ready: false, baseUrl: "https://x" }), "zh")).toBe("待填写模型名称");
    expect(formatModelStatusHuman(mk({ id: "a", ready: false, baseUrl: "https://x", model: "m" }), "en")).toBe("API Key required — click Edit to activate");
    expect(formatModelStatusHuman(mk({ id: "a", apiProtocol: "ollama", baseUrl: "http://localhost:11434/v1", model: "q" }), "en")).toBe("Built-in API harness · local keyless model ready");
    expect(formatModelStatusHuman(mk({ id: "a", baseUrl: "http://127.0.0.1:8080/v1", model: "q" }), "zh")).toBe("内置 API 基座 · 本地免密模型已就绪");
    expect(formatModelStatusHuman(deepseek, "en")).toBe("Built-in API harness · API key ready");
    expect(formatModelStatusHuman(deepseek, "zh")).toBe("内置 API 基座 · 密钥已就绪");
  });

  it("isLocalhostUrl", () => {
    expect(isLocalhostUrl("http://localhost:11434/v1")).toBe(true);
    expect(isLocalhostUrl("https://api.openai.com/v1")).toBe(false);
    expect(isLocalhostUrl(undefined)).toBe(false);
  });
});

describe("activeRolesOfProfile / isAutoCandidate", () => {
  it("matches each role", () => {
    expect(activeRolesOfProfile("a", B("a", "a", "b"))).toEqual(["control", "implement"]);
    expect(activeRolesOfProfile("b", B("a", "a", "b"))).toEqual(["review"]);
    expect(activeRolesOfProfile("z", B("a", "a", "b"))).toEqual([]);
  });
  it("auto candidate only when unpinned, ready, pooled and an auto role exists", () => {
    expect(isAutoCandidate(deepseek, B("heuristic", "auto", "auto"))).toBe(true);
    expect(isAutoCandidate(deepseek, B(deepseek.id, "auto", "auto"))).toBe(false);
    expect(isAutoCandidate(deepseek, B("heuristic", "cli-claude", "cli-codex"))).toBe(false);
    expect(isAutoCandidate({ ...deepseek, workerAutoPool: false }, B("heuristic", "auto", "auto"))).toBe(false);
    expect(isAutoCandidate({ ...deepseek, ready: false }, B("heuristic", "auto", "auto"))).toBe(false);
  });
});

describe("buildSmartModelRecipes", () => {
  const none = B("heuristic", "auto", "auto");
  const ids = (r: ReturnType<typeof buildSmartModelRecipes>) => r.map((x) => x.id);

  it("no ready profiles → no recipes", () => {
    expect(buildSmartModelRecipes([{ ...claude, ready: false }], none)).toEqual([]);
  });

  it("single CLI → only cli_heterogeneous with auto review", () => {
    const r = buildSmartModelRecipes([claude], none);
    expect(ids(r)).toEqual(["cli_heterogeneous"]);
    expect(r[0]).toMatchObject({ controlModelId: claude.id, implementModelId: claude.id, reviewModelId: "auto" });
  });

  it("two CLIs → claude codes, codex blind-reviews, claude beats codex", () => {
    const r = buildSmartModelRecipes([gemini, codex, claude], none).find((x) => x.id === "cli_heterogeneous")!;
    expect(r).toMatchObject({ implementModelId: claude.id, reviewModelId: codex.id });
  });

  it("API + CLI → hybrid_best controls via API, codes via best CLI", () => {
    const r = buildSmartModelRecipes([codex, claude, deepseek], none);
    expect(ids(r)).toEqual(["hybrid_best", "cli_heterogeneous", "pure_api", "smart_auto"]);
    const h = r.find((x) => x.id === "hybrid_best")!;
    expect(h).toMatchObject({ controlModelId: deepseek.id, implementModelId: claude.id });
    expect(h.reviewModelId).not.toBe(claude.id);
  });

  it("hybrid control prefers deepseek over anthropic; review is another API", () => {
    const h = buildSmartModelRecipes([anthropic, deepseek, claude], none).find((x) => x.id === "hybrid_best")!;
    expect(h).toMatchObject({ controlModelId: deepseek.id, implementModelId: claude.id, reviewModelId: anthropic.id });
  });

  it("pure_api prefers anthropic for coding and a distinct API for review", () => {
    const p = buildSmartModelRecipes([deepseek, anthropic], none).find((x) => x.id === "pure_api")!;
    expect(p).toMatchObject({ controlModelId: deepseek.id, implementModelId: anthropic.id, reviewModelId: deepseek.id });
    const single = buildSmartModelRecipes([deepseek], none).find((x) => x.id === "pure_api")!;
    expect(single.reviewModelId).toBe("auto");
  });

  it("smart_auto requires >=2 ready and a pooled profile", () => {
    expect(ids(buildSmartModelRecipes([deepseek], none))).not.toContain("smart_auto");
    const unpooled = [{ ...deepseek, workerAutoPool: false }, { ...claude, workerAutoPool: false }];
    expect(ids(buildSmartModelRecipes(unpooled, none))).not.toContain("smart_auto");
    const s = buildSmartModelRecipes([deepseek, claude], none).find((x) => x.id === "smart_auto")!;
    expect(s).toMatchObject({ controlModelId: deepseek.id, implementModelId: "auto", reviewModelId: "auto" });
  });

  it("marks isActive only when all three roles match", () => {
    const profiles = [claude, codex];
    const target = buildSmartModelRecipes(profiles, none).find((x) => x.id === "cli_heterogeneous")!;
    const active = buildSmartModelRecipes(profiles, B(target.controlModelId, target.implementModelId, target.reviewModelId));
    expect(active.find((x) => x.id === "cli_heterogeneous")!.isActive).toBe(true);
    expect(buildSmartModelRecipes(profiles, none).some((x) => x.isActive)).toBe(false);
    expect(buildSmartModelRecipes(profiles, B(claude.id, claude.id, "auto")).find((x) => x.id === "cli_heterogeneous")!.isActive).toBe(false);
  });
});

describe("diagnoseModelBindings", () => {
  const kinds = (a: ReturnType<typeof diagnoseModelBindings>) => a.map((x) => x.kind);

  it("no ready models → warn", () => {
    const a = diagnoseModelBindings([{ ...claude, ready: false }], B("heuristic", "auto", "auto"));
    expect(a[0]).toMatchObject({ kind: "no_ready_models", severity: "warn" });
  });

  it("same-model self review → warn with distinct-model patch", () => {
    const a = diagnoseModelBindings([claude, codex], B(claude.id, claude.id, claude.id));
    const hit = a.find((x) => x.kind === "same_model_self_review")!;
    expect(hit.severity).toBe("warn");
    expect(hit.suggestedPatch).toEqual({ reviewModelId: codex.id });
  });

  it("self review not flagged for auto, distinct, or single ready profile", () => {
    expect(kinds(diagnoseModelBindings([claude, codex], B(claude.id, "auto", "auto")))).not.toContain("same_model_self_review");
    expect(kinds(diagnoseModelBindings([claude, codex], B(claude.id, claude.id, codex.id)))).not.toContain("same_model_self_review");
    expect(kinds(diagnoseModelBindings([claude], B(claude.id, claude.id, claude.id)))).not.toContain("same_model_self_review");
  });

  it("empty auto pool → warn", () => {
    const off = [{ ...claude, workerAutoPool: false }, { ...deepseek, workerAutoPool: false }];
    expect(kinds(diagnoseModelBindings(off, B(claude.id, "auto", claude.id)))).toContain("empty_auto_pool");
    expect(kinds(diagnoseModelBindings([claude], B(claude.id, "auto", "auto")))).not.toContain("empty_auto_pool");
    expect(kinds(diagnoseModelBindings(off, B(claude.id, claude.id, deepseek.id)))).not.toContain("empty_auto_pool");
  });

  it("heuristic control → info with AI-control patch (API preferred)", () => {
    const hit = diagnoseModelBindings([claude, deepseek], B("heuristic", "auto", "auto")).find((x) => x.kind === "heuristic_control")!;
    expect(hit.severity).toBe("info");
    expect(hit.suggestedPatch).toEqual({ controlModelId: deepseek.id });
    expect(diagnoseModelBindings([claude], B("heuristic", "auto", "auto")).find((x) => x.kind === "heuristic_control")!.suggestedPatch).toEqual({ controlModelId: claude.id });
    expect(kinds(diagnoseModelBindings([], B("heuristic", "auto", "auto")))).not.toContain("heuristic_control");
  });

  it("unready custom profile → info; builtin CLI is exempt", () => {
    const custom = mk({ id: "api-x", ready: false });
    expect(kinds(diagnoseModelBindings([claude, custom], B(claude.id, "auto", "auto")))).toContain("unready_custom");
    expect(kinds(diagnoseModelBindings([{ ...claude, ready: false }], B("heuristic", "auto", "auto")))).not.toContain("unready_custom");
  });

  it("healthy setup yields no advice", () => {
    expect(diagnoseModelBindings([claude, codex, deepseek], B(deepseek.id, claude.id, codex.id))).toEqual([]);
  });
});
