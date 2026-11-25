import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDefaultMandate, type WorkerTurnInput } from "@super-work/core";
import {
  GitWorktreeProvider,
  buildCodexCliArgs,
  clearSymbolGraphCache,
  extractSymbolSpans,
  wrapCommandWithOsSandbox,
} from "../src/index.ts";

const tempDirs: string[] = [];

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sw-v140-"));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

afterEach(async () => {
  clearSymbolGraphCache();
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("v1.4.0 surgical drivers", () => {
  it("extracts accurate 1-based Lstart-Lend spans for TS, Python, Go and Rust", () => {
    const ts = [
      "import x from './x.ts';", // 1
      "", // 2
      "export function foo(", // 3
      "  a: string,", // 4
      "): string {", // 5
      '  const s = "}"; // brace in string', // 6
      "  return a + s;", // 7
      "}", // 8
      "", // 9
      "export interface Bar {", // 10
      "  id: string;", // 11
      "}", // 12
      "", // 13
      "export type Kind =", // 14
      '  | "a"', // 15
      '  | "b";', // 16
      "", // 17
      "export class Baz {", // 18
      "  run() {", // 19
      "    return 1;", // 20
      "  }", // 21
      "}", // 22
    ].join("\n");
    const spans = extractSymbolSpans("a.ts", ts);
    const get = (n: string) => spans.find((s) => s.name === n)!;
    expect([get("foo").startLine, get("foo").endLine]).toEqual([3, 8]);
    expect([get("Bar").startLine, get("Bar").endLine]).toEqual([10, 12]);
    expect([get("Kind").startLine, get("Kind").endLine]).toEqual([14, 16]);
    expect([get("Baz").startLine, get("Baz").endLine]).toEqual([18, 22]);
    expect(get("Baz").kind).toBe("class");

    const py = ["import os", "", "def hello():", "    return 1", "", "class Foo:", "    def m(self):", "        pass", "", "def _private():", "    pass"].join("\n");
    const pySpans = extractSymbolSpans("m.py", py);
    expect(pySpans.map((s) => [s.name, s.startLine, s.endLine])).toEqual([
      ["hello", 3, 4],
      ["Foo", 6, 8],
    ]);

    const go = ["package x", "", "func Do() {", "\treturn", "}", "", "type Thing struct {", "\tA int", "}", "", "func hidden() {}"].join("\n");
    expect(extractSymbolSpans("x.go", go).map((s) => [s.name, s.startLine, s.endLine])).toEqual([
      ["Do", 3, 5],
      ["Thing", 7, 9],
    ]);

    const rs = ["pub fn run<'a>(x: &'a str) -> &'a str {", "    x", "}", "", "pub struct S {", "    a: u8,", "}", "", "fn private() {}"].join("\n");
    expect(extractSymbolSpans("l.rs", rs).map((s) => [s.name, s.startLine, s.endLine])).toEqual([
      ["run", 1, 3],
      ["S", 5, 7],
    ]);
  });

  it("buildSurgicalContextPack formats spans, tests, dependents and honors scope and 2400-char cap", async () => {
    const files: Record<string, string> = {
      "packages/core/src/alpha.ts": "export function alpha() {\n  return 1;\n}\n",
      "packages/core/src/beta.ts": "import { alpha } from './alpha.ts';\nexport const beta = alpha;\n",
      "packages/core/test/alpha.test.ts": "import { alpha } from '../src/alpha.ts';\nalpha();\n",
      "packages/web/src/other.ts": "export function other() {}\n",
      "node_modules/dep/index.ts": "export function dep() {}\n",
    };
    for (let i = 0; i < 30; i++) {
      files[`packages/core/src/gen${i}.ts`] =
        Array.from({ length: 2 }, (_, k) => `export function fn_${i}_${k}() {\n  return ${k};\n}\n`).join("\n");
    }
    const dir = await makeRepo(files);
    const provider = new GitWorktreeProvider(join(dir, "wt"));

    const pack = await provider.buildSurgicalContextPack({
      worktreePath: dir,
      allowedPaths: ["packages/core/**"],
    });
    expect(pack).toBeDefined();
    expect(pack!.length).toBeLessThanOrEqual(2400);
    expect(pack).toContain("alpha.ts (3 lines)");
    expect(pack).toContain("function alpha L1-L3");
    expect(pack).toContain("tests: packages/core/test/alpha.test.ts");
    expect(pack).toContain("dependents: packages/core/src/beta.ts");
    expect(pack).not.toContain("other.ts");
    expect(pack).not.toContain("node_modules");
    expect(pack!.split("\n- ").length).toBeLessThanOrEqual(8);
    expect(pack!.startsWith("- packages/core/src/alpha.ts")).toBe(true);

    const tiny = await provider.buildSurgicalContextPack({
      worktreePath: dir,
      allowedPaths: ["packages/core/**"],
      maxChars: 200,
    });
    expect(tiny!.length).toBeLessThanOrEqual(200);

    expect(
      await provider.buildSurgicalContextPack({ worktreePath: dir, allowedPaths: ["nothing/**"] }),
    ).toBeUndefined();
  });

  it("scanCodeHotspots filters by threshold and sorts by lineCount desc", async () => {
    const big = (n: number) => `export function f() {}\n${"// pad\n".repeat(n - 1)}`;
    const dir = await makeRepo({
      "packages/a/src/huge.ts": big(2000),
      "packages/a/src/large.ts": big(1600),
      "packages/b/src/exact.ts": big(1500),
      "packages/b/src/small.ts": big(100),
      "packages/b/test/huge.test.ts": big(3000),
    });
    clearSymbolGraphCache();
    const provider = new GitWorktreeProvider(join(dir, "wt"));
    const hot = await provider.scanCodeHotspots(dir, 1500);
    expect(hot.map((h) => [h.filePath, h.lineCount])).toEqual([
      ["packages/a/src/huge.ts", 2000],
      ["packages/a/src/large.ts", 1600],
    ]);
    expect(hot[0]!.packageDir).toBe("packages/a");
    expect(hot[0]!.exportedSymbolCount).toBe(1);
    const lowered = await provider.scanCodeHotspots(dir, 1000);
    expect(lowered.length).toBe(3);
  });

  it("buildCodexCliArgs is codex 0.166.0 compatible (no -s with --approve-for-me)", () => {
    const base: WorkerTurnInput = {
      ticketId: "t",
      stageRunId: "run_1",
      stage: "plan",
      worktreePath: "/tmp/wt",
      prompt: "do it",
      mandate: createDefaultMandate({ maxCostUsd: 1 }),
      isResume: false,
    };
    for (const stage of ["plan", "review"] as const) {
      const args = buildCodexCliArgs({ ...base, stage });
      expect(args).toEqual(["exec", "--json", "-s", "read-only", "do it"]);
      expect(args).not.toContain("--approve-for-me");
    }
    const impl = buildCodexCliArgs({ ...base, stage: "implement" });
    expect(impl).toEqual(["exec", "--json", "--approve-for-me", "do it"]);
    expect(impl).not.toContain("-s");
  });

  it("skips nested Seatbelt wrapping when SUPER_WORK_IN_OS_SANDBOX=1 on darwin unless forced", () => {
    const common = {
      commandArgv: ["echo", "hi"],
      worktreePath: "/tmp/wt-nested",
      mode: "balanced" as const,
      engine: "mock" as const,
    };
    if (process.platform !== "darwin") {
      const nested = wrapCommandWithOsSandbox({ ...common, baseEnv: { PATH: "/usr/bin", SUPER_WORK_IN_OS_SANDBOX: "1" } });
      expect(nested.argv[0]).not.toBe("/usr/bin/sandbox-exec");
      return;
    }
    const outer = wrapCommandWithOsSandbox({ ...common, baseEnv: { PATH: "/usr/bin" } });
    expect(outer.appliedBackend).toBe("seatbelt");
    expect(outer.env.SUPER_WORK_IN_OS_SANDBOX).toBe("1");

    const nested = wrapCommandWithOsSandbox({
      ...common,
      baseEnv: { PATH: "/usr/bin", SUPER_WORK_IN_OS_SANDBOX: "1" },
    });
    expect(nested.appliedBackend).toBe("env_only");
    expect(nested.argv).toEqual(["echo", "hi"]);
    expect(nested.env.SUPER_WORK_IN_OS_SANDBOX).toBe("1");

    const forced = wrapCommandWithOsSandbox({
      ...common,
      skipOuterSandbox: false,
      baseEnv: { PATH: "/usr/bin", SUPER_WORK_IN_OS_SANDBOX: "1" },
    });
    expect(forced.appliedBackend).toBe("seatbelt");
  });
});
