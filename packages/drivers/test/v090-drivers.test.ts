import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { createDefaultMandate, type RepoConfig, type Ticket } from "@super-work/core";
import {
  GitWorktreeProvider,
  analyzeRepoSymbolImpact,
  clearSymbolGraphCache,
  comparePngVisualDiff,
  decodePngToRgba,
  detectLocalBrowserBinary,
  encodeRgbaPng,
  runCdpBrowserCheck,
  runGit,
  wrapCommandWithOsSandbox,
} from "../src/index.ts";

async function createTempGitRepo(baseDir: string, name: string): Promise<string> {
  const repoDir = join(baseDir, name);
  await runGit(["init", "-b", "main", repoDir], baseDir);
  await runGit(["config", "user.name", "Test User"], repoDir);
  await runGit(["config", "user.email", "test@example.com"], repoDir);
  await mkdir(join(repoDir, "src"), { recursive: true });
  await mkdir(join(repoDir, "test"), { recursive: true });
  await writeFile(join(repoDir, "README.md"), `# ${name}\n`, "utf8");
  await writeFile(join(repoDir, "src/core.ts"), "export function calcSum(a: number, b: number): number { return a + b; }\n", "utf8");
  await writeFile(
    join(repoDir, "src/service.ts"),
    'import { calcSum } from "./core.ts";\nexport function runService(): number { return calcSum(1, 2); }\n',
    "utf8",
  );
  await writeFile(
    join(repoDir, "src/controller.ts"),
    'import { runService } from "./service.ts";\nexport function handleReq(): number { return runService(); }\n',
    "utf8",
  );
  await writeFile(join(repoDir, "test/spec.test.ts"), "export const lockedSpec = true;\n", "utf8");
  await runGit(["add", "."], repoDir);
  await runGit(["commit", "-m", "initial commit"], repoDir);
  return repoDir;
}

describe("v0.9.0 Drivers (A.2 PNG Diff + B.1 Symbol Graph + A.1 Read-Only Sandbox + D.2 Git Checkpoints)", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("A.2: encodes/decodes RGBA PNGs losslessly and computes pixel diff ratio + heatmap", () => {
    const w = 4;
    const h = 4;
    const base = new Uint8Array(w * h * 4);
    const modified = new Uint8Array(w * h * 4);

    for (let i = 0; i < w * h; i += 1) {
      const off = i * 4;
      base[off] = 240;
      base[off + 1] = 240;
      base[off + 2] = 240;
      base[off + 3] = 255;

      modified[off] = i < 4 ? 20 : 240;
      modified[off + 1] = i < 4 ? 20 : 240;
      modified[off + 2] = i < 4 ? 20 : 240;
      modified[off + 3] = 255;
    }

    const basePng = encodeRgbaPng(w, h, base);
    const modPng = encodeRgbaPng(w, h, modified);
    expect(Array.from(basePng.slice(0, 4))).toEqual([137, 80, 78, 71]);

    const decoded = decodePngToRgba(basePng);
    expect(decoded.width).toBe(w);
    expect(decoded.height).toBe(h);
    expect(Array.from(decoded.rgba)).toEqual(Array.from(base));

    const sameDiff = comparePngVisualDiff(basePng, basePng);
    expect(sameDiff.diffPixels).toBe(0);
    expect(sameDiff.diffRatio).toBe(0);

    const changedDiff = comparePngVisualDiff(basePng, modPng);
    expect(changedDiff.totalPixels).toBe(16);
    expect(changedDiff.diffPixels).toBe(4);
    expect(changedDiff.diffRatio).toBeCloseTo(0.25, 5);
    const diffDecoded = decodePngToRgba(changedDiff.diffPngBytes);
    expect(diffDecoded.width).toBe(w);
    expect(diffDecoded.height).toBe(h);
  });

  it("A.2: runs optional CDP interactive steps when local Chrome binary is available", async () => {
    const browserBin = detectLocalBrowserBinary();
    if (!browserBin) {
      return;
    }

    const srv = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          `<!doctype html><html><body>
            <input id="q" />
            <button id="go" onclick="document.getElementById('out').textContent = 'hi:' + document.getElementById('q').value">Go</button>
            <div id="out">idle</div>
          </body></html>`,
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      },
    });

    try {
      const res = await runCdpBrowserCheck(`http://127.0.0.1:${srv.port}`, {
        enabled: true,
        paths: ["/"],
        steps: [
          { action: "fill", selector: "#q", value: "v090" },
          { action: "click", selector: "#go" },
          { action: "waitForText", selector: "#out", value: "hi:v090" },
        ],
      });
      if (res.summary.executed) {
        expect(res.summary.ok).toBe(true);
        expect(res.rawScreenshots.length).toBeGreaterThanOrEqual(1);
      }
    } finally {
      srv.stop(true);
    }
  }, 30_000);

  it("B.1: scans symbol graph to discover 1-hop direct and 2+ hop transitive dependents + context pack", async () => {
    clearSymbolGraphCache();
    const dir = await mkdtemp(join(tmpdir(), "sw-v090-impact-"));
    tempDirs.push(dir);
    const repoDir = await createTempGitRepo(dir, "impact-repo");

    const report = await analyzeRepoSymbolImpact(repoDir, ["src/core.ts"]);
    expect(report.targetFiles).toEqual(["src/core.ts"]);
    expect(report.directDependents).toEqual(["src/service.ts"]);
    expect(report.transitiveDependents).toEqual(["src/controller.ts"]);
    expect(report.neighborSignatures.some((n) => n.filePath === "src/core.ts")).toBe(true);
    expect(report.contextPackMarkdown).toContain("src/service.ts");
    expect(report.contextPackMarkdown).toContain("calcSum");
  });

  it("A.1: locks readOnlyPaths in OS sandbox and blocks writes while permitting reads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v090-ro-"));
    tempDirs.push(dir);
    const repoDir = await createTempGitRepo(dir, "sandbox-repo");
    const lockedRel = "test/spec.test.ts";

    const wrapped = wrapCommandWithOsSandbox({
      commandArgv: ["sh", "-c", `cat ${lockedRel} >/dev/null && echo mutated > ${lockedRel}`],
      worktreePath: repoDir,
      rootRepoPath: repoDir,
      mode: "balanced",
      readOnlyPaths: [lockedRel],
      engine: "mock",
    });

    if (wrapped.appliedBackend === "seatbelt") {
      expect(wrapped.profileText).toContain("deny file-write*");
      expect(wrapped.profileText).toContain(lockedRel);

      const proc = Bun.spawn(wrapped.argv, {
        cwd: repoDir,
        env: wrapped.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      expect(exitCode).not.toBe(0);
      const after = await readFile(join(repoDir, lockedRel), "utf8");
      expect(after).toBe("export const lockedSpec = true;\n");
    } else if (wrapped.appliedBackend === "bwrap") {
      expect(wrapped.argv).toContain("--ro-bind");
    }
  });

  it("D.2: captures, diffs, restores, and cleans up hidden-ref worktree checkpoints without branch clutter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-v090-cp-"));
    tempDirs.push(dir);
    const repoDir = await createTempGitRepo(dir, "cp-repo");
    const wsProvider = new GitWorktreeProvider(join(dir, "worktrees"));

    const repo: RepoConfig = {
      id: "repo_cp",
      name: "cp-repo",
      rootPath: repoDir,
      baseBranch: "main",
      mode: "auto",
      defaultTemplate: "fast",
      preferredImplementEngine: "mock",
      preferredReviewEngine: "mock",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const ticket: Ticket = {
      id: "tkt_cp_1",
      repoId: repo.id,
      threadId: "thr_1",
      sourceTriggerId: "trg_1",
      title: "Checkpoint test",
      description: "Test checkpoints",
      status: "implementing",
      template: "fast",
      currentStage: "implement",
      stageRetries: 0,
      mandate: createDefaultMandate({ allowedPaths: ["src/**"] }),
      dependsOn: [],
      branchName: "super-work/tkt_cp_1",
      nativeSessions: {},
      inlineMemory: { goal: "cp", acceptanceCriteria: [], stageNotes: [], threadUpdates: [] },
      costUsd: 0,
      priority: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const ws = await wsProvider.prepareWorkspace(ticket, repo);
    const baseSha = await wsProvider.getHeadCommitSha(ws.worktreePath, "HEAD");

    // Mutate file and capture checkpoint #1
    await writeFile(join(ws.worktreePath, "src/core.ts"), "export const v = 1;\n", "utf8");
    const cp1 = await wsProvider.captureWorktreeCheckpoint({
      worktreePath: ws.worktreePath,
      ticketId: ticket.id,
      checkpointId: "cp_001",
      label: "after spec_test",
    });
    expect(cp1.gitRef).toBe("refs/super-work/checkpoints/tkt_cp_1/cp_001");

    // Verify hidden ref does NOT appear in `git branch -a`
    const branchOut = await runGit(["branch", "-a"], repoDir);
    expect(branchOut.stdout).not.toContain("checkpoints");

    // Diff between base and cp1 shows src/core.ts
    const diff = await wsProvider.getCommitDiff(repoDir, baseSha, cp1.commitSha);
    expect(diff).toContain("src/core.ts");
    expect(diff).toContain("export const v = 1;");

    // Mutate further and create untracked file, then restore to cp1
    await writeFile(join(ws.worktreePath, "src/core.ts"), "export const v = 999;\n", "utf8");
    await writeFile(join(ws.worktreePath, "src/extra.ts"), "export const stray = true;\n", "utf8");
    await wsProvider.restoreWorktreeCheckpoint({
      worktreePath: ws.worktreePath,
      rootRepoPath: repoDir,
      commitSha: cp1.commitSha,
    });

    expect(await readFile(join(ws.worktreePath, "src/core.ts"), "utf8")).toBe("export const v = 1;\n");
    expect(existsSync(join(ws.worktreePath, "src/extra.ts"))).toBe(false);

    // Cleanup checkpoints removes hidden refs
    const deletedCount = await wsProvider.cleanupTicketCheckpoints(repoDir, ticket.id);
    expect(deletedCount).toBe(1);
    const verifyRef = await runGit(["show-ref", "--verify", cp1.gitRef], repoDir);
    expect(verifyRef.exitCode).not.toBe(0);
  });
});
