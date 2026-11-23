import { describe, expect, it } from "bun:test";
import {
  buildHandoverDigest,
  extractDiffContracts,
  formatUpstreamHandoversForPrompt,
  sanitizeEpicSubtasks,
  type Ticket,
} from "../src/index.ts";

function makeTicket(overrides?: Partial<Ticket>): Ticket {
  const ts = "2026-11-23T00:00:00.000Z";
  return {
    id: "tkt_test1",
    repoId: "repo_backend",
    threadId: "thr_1",
    sourceTriggerId: "trg_1",
    title: "Add Orders Endpoint",
    description: "Expose orders POST endpoint and OrderPayload schema",
    status: "delivered",
    template: "standard",
    currentStage: "rebase",
    stageRetries: 0,
    mandate: {
      allowedPaths: ["src/**"],
      forbiddenPaths: [".env*"],
      allowNetwork: false,
      allowExternalSideEffects: false,
      maxCostUsd: 2,
      maxDurationSec: 300,
      maxStageRetries: 2,
    },
    dependsOn: [],
    nativeSessions: {},
    inlineMemory: {
      goal: "Expose orders POST endpoint",
      acceptanceCriteria: ["POST /api/orders returns 201"],
      stageNotes: [],
      threadUpdates: [],
    },
    costUsd: 0.1,
    priority: 1,
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

describe("Upstream Handover Digest Extraction & Prompt Formatting (v0.6.0)", () => {
  it("extracts TS, Python, Go, Rust exports and HTTP routes deterministically from unified diffs", () => {
    const diff = [
      "+++ b/src/orders.ts",
      "+export interface OrderRequest {",
      "+  itemId: string;",
      "+}",
      "+export async function createOrder(req: OrderRequest): Promise<string> {",
      "+app.post(\"/api/orders\", async (c) => c.json({ ok: true }));",
      "+++ b/service.py",
      "+async def fetch_order(order_id: str):",
      "+@router.get(\"/v1/orders/{order_id}\")",
      "+++ b/pkg/api.go",
      "+func HandleOrder(id string) error {",
      "+++ b/src/lib.rs",
      "+pub async fn submit_order(id: &str) -> Result<(), ()> {",
    ].join("\n");

    const contracts = extractDiffContracts(diff);
    expect(contracts.exportedSymbols.some((s) => s.includes("export interface OrderRequest"))).toBe(
      true,
    );
    expect(contracts.exportedSymbols.some((s) => s.includes("export async function createOrder"))).toBe(
      true,
    );
    expect(contracts.exportedSymbols.some((s) => s.includes("async def fetch_order"))).toBe(true);
    expect(contracts.exportedSymbols.some((s) => s.includes("func HandleOrder"))).toBe(true);
    expect(contracts.exportedSymbols.some((s) => s.includes("pub async fn submit_order"))).toBe(true);
    expect(contracts.contractSnippets.some((s) => s.includes('/api/orders'))).toBe(true);
    expect(contracts.contractSnippets.some((s) => s.includes('/v1/orders/{order_id}'))).toBe(true);
  });

  it("caps formattedMarkdown at <= 1200 chars and formats multiple upstreams within budget", () => {
    const hugeSummary = "A".repeat(500);
    const manyFiles = Array.from({ length: 20 }, (_, i) => `src/very/deep/module/path/file_${i}.ts`);
    const hugeDiff = manyFiles
      .map((f, i) => `+++ b/${f}\n+export function longExportedFunctionNameNumber_${i}_WithDetails(arg: string) {`)
      .join("\n");

    const digest1 = buildHandoverDigest({
      ticket: makeTicket({ id: "tkt_a" }),
      repoName: "backend",
      changedFiles: manyFiles,
      diffText: hugeDiff,
      stageSummary: hugeSummary,
      version: 1,
    });
    expect(digest1.formattedMarkdown.length).toBeLessThanOrEqual(1200);
    expect(digest1.version).toBe(1);

    const digest2 = buildHandoverDigest({
      ticket: makeTicket({ id: "tkt_b", repoId: "repo_auth", title: "Auth Tokens" }),
      repoName: "auth-svc",
      changedFiles: ["src/jwt.ts"],
      diffText: "+++ b/src/jwt.ts\n+export interface JwtClaims { sub: string; }",
      stageSummary: "Added JwtClaims validation",
    });

    const promptBlock = formatUpstreamHandoversForPrompt([digest1, digest2], 1400);
    expect(promptBlock.length).toBeLessThanOrEqual(1400);
    expect(promptBlock).toContain("[backend · tkt_a]");
  });

  it("does not serialize subtasks across different repositories even when allowedPaths overlap", () => {
    const subtasks = sanitizeEpicSubtasks(
      [
        {
          key: "backend_api",
          repoId: "repo_backend",
          title: "Backend API",
          description: "Build /api/orders",
          allowedPaths: ["src/**"],
          dependsOnKeys: [],
        },
        {
          key: "docs_or_admin",
          repoId: "repo_admin",
          title: "Admin Panel",
          description: "Build unrelated widget",
          allowedPaths: ["src/**"],
          dependsOnKeys: [],
        },
      ],
      "fast",
      {
        validRepoIds: new Set(["repo_backend", "repo_admin"]),
        defaultRepoId: "repo_backend",
      },
    );

    expect(subtasks).toHaveLength(2);
    expect(subtasks[0]!.dependsOnKeys).toEqual([]);
    expect(subtasks[1]!.dependsOnKeys).toEqual([]);
  });
});
