import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  AUTONOMY_PRESET_DEFAULTS,
  SuperWorkKernel,
  classifyInboxHumanAction,
} from "@super-work/core";
import type { InboxItem } from "@super-work/core/types";
import {
  FsArtifactStore,
  GhOutboxExecutor,
  GitWorktreeProvider,
  HeuristicControlLLM,
  MockWorkerDriver,
  SqliteStateStore,
} from "@super-work/drivers";
import { createServerApp } from "../src/app.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// Resolve once: kernel flows may rewrite process.env.PATH during the run.
const GIT = Bun.which("git") ?? "git";

async function sh(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn([GIT, ...args], { cwd, stdout: "ignore", stderr: "ignore" });
  await proc.exited;
}

describe("v1.8.0 Wave 3 End-to-End (Super-Agent First: quick-start, detect, presets, scoped intake, taxonomy, doctor)", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const d of tempDirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  async function setup() {
    const dir = await mkdtemp(join(tmpdir(), "sw-v180-e2e-"));
    tempDirs.push(dir);
    const store = new SqliteStateStore(join(dir, "state.db"));
    const artifacts = new FsArtifactStore(join(dir, "artifacts"));
    const workspace = new GitWorktreeProvider(join(dir, "worktrees"));
    const kernel = new SuperWorkKernel({
      stateStore: store,
      artifactStore: artifacts,
      workspace,
      llm: new HeuristicControlLLM(),
      drivers: [new MockWorkerDriver({ engine: "mock", stepDelayMs: 1 })],
      outboxExecutor: new GhOutboxExecutor(workspace),
      dataDir: dir,
    });
    const app = createServerApp({ kernel, stateStore: store, artifactStore: artifacts });
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as Json };
    };
    const mkProject = async (name: string, files: Record<string, string>) => {
      const root = join(dir, name);
      await mkdir(root, { recursive: true });
      for (const [f, content] of Object.entries(files)) {
        await writeFile(join(root, f), content);
      }
      return root;
    };
    return { dir, call, mkProject, kernel };
  }

  it("POST /api/setup/quick-start initializes setup status", async () => {
    const { call } = await setup();
    const res = await call("POST", "/api/setup/quick-start", {});
    expect(res.status).toBe(200);
    expect(res.json.initialized).toBe(true);
    const status = await call("GET", "/api/setup/status");
    expect(status.status).toBe(200);
    expect(status.json.initialized).toBe(true);
  });

  it("POST /api/repos/detect identifies Bun / Node / Rust / Python / Go defaults", async () => {
    const { call, mkProject } = await setup();
    const pkg = JSON.stringify({
      name: "@acme/demo",
      scripts: { typecheck: "tsc", test: "bun test", build: "vite build" },
    });
    const cases: Array<{ label: string; files: Record<string, string>; commands: string[] }> = [
      {
        label: "bun",
        files: { "package.json": pkg, "bun.lock": "" },
        commands: ["bun run typecheck", "bun run test", "bun run build"],
      },
      {
        label: "node",
        files: { "package.json": pkg },
        commands: ["npm run typecheck", "npm run test", "npm run build"],
      },
      { label: "rust", files: { "Cargo.toml": "[package]" }, commands: ["cargo check", "cargo test"] },
      { label: "python", files: { "pyproject.toml": "[project]" }, commands: ["pytest"] },
      { label: "go", files: { "go.mod": "module x" }, commands: ["go vet ./...", "go test ./..."] },
    ];
    for (const c of cases) {
      const root = await mkProject(`detect-${c.label}`, c.files);
      const res = await call("POST", "/api/repos/detect", { rootPath: root });
      expect(res.status).toBe(200);
      expect(res.json.detected.stackLabel).toBe(c.label);
      expect(res.json.detected.verificationCommands).toEqual(c.commands);
      expect(res.json.detected.autonomyPreset).toBe("smart");
      expect(res.json.detected.verificationStrategy).toBe("smart_tiered");
    }
    const bun = await call("POST", "/api/repos/detect", {
      rootPath: await mkProject("detect-name", { "package.json": pkg }),
    });
    expect(bun.json.detected.name).toBe("demo");

    expect((await call("POST", "/api/repos/detect", {})).status).toBe(400);
    expect((await call("POST", "/api/repos/detect", { rootPath: join("/nonexistent", "sw-v180") })).status).toBe(400);
    // detect is read-only: no repo was registered.
    expect((await call("GET", "/api/repos")).json.repos).toHaveLength(0);
  });

  it("zero-config POST /api/repos applies the smart preset + detected verification; PATCH switches presets", async () => {
    const { call, mkProject } = await setup();
    const root = await mkProject("zero-config", {
      "package.json": JSON.stringify({ name: "zc", scripts: { typecheck: "tsc", test: "bun test" } }),
      "bun.lock": "",
    });
    await sh(root, "init", "-q", "-b", "main");
    await sh(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");

    const created = await call("POST", "/api/repos", { name: "zc", rootPath: root });
    expect(created.status).toBe(201);
    const repo = created.json.repo;
    expect(repo.autonomyPreset).toBe("smart");
    expect(repo.mode).toBe(AUTONOMY_PRESET_DEFAULTS.smart.mode);
    expect(repo.deliveryGatePolicy).toBe("risk_gated");
    expect(repo.riskThreshold).toBe(35);
    expect(repo.verificationCommands).toEqual(["bun run typecheck", "bun run test"]);

    for (const preset of ["guarded", "autonomous", "smart"] as const) {
      const patched = await call("PATCH", `/api/repos/${repo.id}`, { autonomyPreset: preset });
      expect(patched.status).toBe(200);
      expect(patched.json.repo.autonomyPreset).toBe(preset);
      expect(patched.json.repo.deliveryGatePolicy).toBe(AUTONOMY_PRESET_DEFAULTS[preset].deliveryGatePolicy);
      const listed = await call("GET", "/api/repos");
      expect(listed.json.repos.find((r: Json) => r.id === repo.id).autonomyPreset).toBe(preset);
    }
  });

  it("GET /api/system/doctor reports healthy=true with 0 code hotspots", async () => {
    const { call, mkProject } = await setup();
    const root = await mkProject("doctor", { "package.json": JSON.stringify({ name: "doc" }) });
    await sh(root, "init", "-q", "-b", "main");
    await sh(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    await call("POST", "/api/repos", { name: "doc", rootPath: root });

    const res = await call("GET", "/api/system/doctor");
    expect(res.status).toBe(200);
    expect(res.json.healthy).toBe(true);
    expect(res.json.hotspots ?? []).toHaveLength(0);
  });

  it("POST /api/intake with explicit scope: creates a scoped ticket; inbox kinds classify into approve / answer / unblock", async () => {
    const { call, mkProject, kernel } = await setup();
    // POST /api/intake fires an un-awaited kernel.tick(); this test only needs ticket creation, so neutralize it
    // (otherwise the background run outlives the temp dir and pollutes later test files).
    kernel.tick = async () => 0;
    const root = await mkProject("intake", { "package.json": JSON.stringify({ name: "in" }) });
    await sh(root, "init", "-q", "-b", "main");
    await sh(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    const repo = (await call("POST", "/api/repos", { name: "in", rootPath: root, mode: "observe" })).json.repo;

    const intake = await call("POST", "/api/intake", {
      repoId: repo.id,
      requirement: "Tighten validation in the core parser scope:packages/core/**",
    });
    expect(intake.status).toBe(201);
    const ticket = intake.json.ticket as Json;
    expect(ticket).toBeTruthy();
    expect(ticket.mandate.allowedPaths).toContain("packages/core/**");


    const groups: Record<"approve" | "answer" | "unblock", InboxItem["kind"][]> = {
      approve: ["outbox_signoff", "plan_approval", "observe_proposal", "milestone_ready", "arena_tiebreak"],
      answer: ["clarification_request", "epic_replan"],
      unblock: [
        "mandate_violation",
        "watchdog_escalation",
        "merge_conflict",
        "budget_cap",
        "pr_followup",
        "campaign_paused",
      ],
    };
    for (const [verb, kinds] of Object.entries(groups)) {
      for (const kind of kinds) {
        expect(classifyInboxHumanAction(kind)).toBe(verb as keyof typeof groups);
      }
    }
  });

});
