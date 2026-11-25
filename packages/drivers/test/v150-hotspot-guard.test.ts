import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GitWorktreeProvider } from "../src/index.ts";

const tempDirs: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
}

async function write(dir: string, rel: string, content: string): Promise<void> {
  const full = join(dir, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}

const HOT_LINES = 60;

function hotSource(): string {
  const body = Array.from({ length: HOT_LINES }, (_, i) => `// filler ${i}`).join("\n");
  return [
    "export function alpha(): number {",
    "  return 1;",
    "}",
    "export const beta = 2;",
    "export interface Gamma {",
    "  id: string;",
    "}",
    "export type Delta = string | number;",
    "export class Epsilon {}",
    body,
    "",
  ].join("\n");
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sw-v150-guard-"));
  tempDirs.push(dir);
  await git(dir, "init", "-q", "-b", "main");
  await write(dir, "src/hot.ts", hotSource());
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "base");
  return dir;
}

async function verify(dir: string, over: { maxLinesAfter?: number; enforceExportParity?: boolean } = {}) {
  return new GitWorktreeProvider(join(dir, ".sw-worktrees")).verifyHotspotRefactorParity({
    worktreePath: dir,
    baseBranch: "main",
    targetHotspotPath: "src/hot.ts",
    maxLinesAfter: over.maxLinesAfter ?? 40,
    enforceExportParity: over.enforceExportParity ?? true,
  });
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("v1.5.0 hotspot refactor parity guard (drivers)", () => {
  it("passes when exports are split into helpers re-exported from the target file", async () => {
    const dir = await makeRepo();
    await write(dir, "src/hot-a.ts", "export function alpha(): number {\n  return 1;\n}\nexport const beta = 2;\n");
    await write(
      dir,
      "src/hot-b.ts",
      "export interface Gamma {\n  id: string;\n}\nexport type Delta = string | number;\n",
    );
    await write(dir, "src/hot-c.ts", "export class Epsilon {}\n");
    await write(
      dir,
      "src/hot.ts",
      [
        'export { alpha, beta } from "./hot-a.ts";',
        'export type { Gamma } from "./hot-b.ts";',
        'export * from "./hot-b.ts";',
        'export * from "./hot-c";',
        "",
      ].join("\n"),
    );

    const res = await verify(dir);
    expect(res.missingExports).toEqual([]);
    expect(res.linesAfter).toBeLessThanOrEqual(40);
    expect(res.linesBefore).toBeGreaterThan(40);
    expect(res.ok).toBe(true);
  });

  it("fails and names the symbol when an export is dropped", async () => {
    const dir = await makeRepo();
    await write(dir, "src/hot-a.ts", "export function alpha(): number {\n  return 1;\n}\nexport const beta = 2;\n");
    await write(dir, "src/hot.ts", 'export { alpha, beta } from "./hot-a.ts";\nexport class Epsilon {}\n');

    const res = await verify(dir);
    expect(res.ok).toBe(false);
    expect(res.missingExports).toEqual(["Delta", "Gamma"]);
    expect(res.summary).toContain("Gamma");
  });

  it("fails when linesAfter exceeds maxLinesAfter even if exports are intact", async () => {
    const dir = await makeRepo();
    await write(dir, "src/hot.ts", `${hotSource()}// touched\n`);

    const res = await verify(dir, { maxLinesAfter: 40 });
    expect(res.missingExports).toEqual([]);
    expect(res.linesAfter).toBeGreaterThan(40);
    expect(res.ok).toBe(false);
    expect(res.summary).toContain("limit 40");
  });

  it("ignores missing exports when enforceExportParity is false", async () => {
    const dir = await makeRepo();
    await write(dir, "src/hot.ts", "export const beta = 2;\n");

    const res = await verify(dir, { enforceExportParity: false });
    expect(res.missingExports.length).toBeGreaterThan(0);
    expect(res.ok).toBe(true);
  });
});
