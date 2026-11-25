import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, readlink, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { runGit } from "./git-command-runner.ts";

export async function linkRepoNodeModulesImpl(repoRoot: string, worktreePath: string): Promise<void> {
  const repoAbs = resolve(repoRoot);
  const worktreeAbs = resolve(worktreePath);
  if (repoAbs === worktreeAbs) return;

  const candidates: string[] = ["node_modules"];
  for (const container of ["packages", "apps"]) {
    const containerDir = join(repoAbs, container);
    if (!existsSync(containerDir)) continue;
    let entries: string[] = [];
    try {
      entries = await readdir(containerDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const relNm = join(container, entry, "node_modules");
      if (existsSync(join(repoAbs, relNm)) && existsSync(join(worktreeAbs, container, entry))) {
        candidates.push(relNm);
      }
    }
  }

  const rootNmPrefix = `${join(repoAbs, "node_modules")}/`;
  const linkEntry = async (srcEntry: string, dstEntry: string): Promise<void> => {
    try {
      await lstat(dstEntry);
      return; // Already present in worktree
    } catch {
      // Proceed to create symlink
    }

    const st = await lstat(srcEntry);
    if (st.isSymbolicLink()) {
      const rawTarget = await readlink(srcEntry);
      const absTarget = resolve(dirname(srcEntry), rawTarget);
      const isWorkspaceLink =
        (absTarget === repoAbs || absTarget.startsWith(`${repoAbs}/`)) &&
        !absTarget.startsWith(rootNmPrefix);
      await symlink(isWorkspaceLink ? rawTarget : absTarget, dstEntry);
      return;
    }

    await symlink(srcEntry, dstEntry, st.isDirectory() ? "dir" : "file");
  };

  for (const relNm of candidates) {
    const srcNm = join(repoAbs, relNm);
    if (!existsSync(srcNm)) continue;

    const ignoredRes = await runGit(["check-ignore", "--no-index", "-q", `${relNm}/`], worktreeAbs);
    if (ignoredRes.exitCode !== 0) {
      // Never inject untracked node_modules if not gitignored in target repository
      continue;
    }

    const dstNm = join(worktreeAbs, relNm);
    await mkdir(dstNm, { recursive: true });

    let items: string[] = [];
    try {
      items = await readdir(srcNm);
    } catch {
      continue;
    }

    for (const name of items) {
      const srcEntry = join(srcNm, name);
      const dstEntry = join(dstNm, name);
      const st = await lstat(srcEntry);
      if (name.startsWith("@") && !st.isSymbolicLink() && st.isDirectory()) {
        await mkdir(dstEntry, { recursive: true });
        const scopedItems = await readdir(srcEntry);
        for (const scopedName of scopedItems) {
          await linkEntry(join(srcEntry, scopedName), join(dstEntry, scopedName));
        }
      } else {
        await linkEntry(srcEntry, dstEntry);
      }
    }
  }

  await syncWorkspacePackageLinksImpl(worktreeAbs);
}

/**
 * Ensure all local monorepo workspace packages under `packages/*` and `apps/*` inside a
 * worktree (including newly added packages/workspace:* dependencies) are symlinked cleanly
 * into `node_modules/` without needing `bun install`.
 */
export async function syncWorkspacePackageLinksImpl(worktreeAbs: string): Promise<void> {
  if (
    !existsSync(join(worktreeAbs, "packages")) &&
    !existsSync(join(worktreeAbs, "apps"))
  ) {
    return;
  }

  const ignoredRes = await runGit(["check-ignore", "--no-index", "-q", "node_modules/"], worktreeAbs);
  if (ignoredRes.exitCode !== 0) return;

  const rootNm = join(worktreeAbs, "node_modules");
  await mkdir(rootNm, { recursive: true });

  for (const container of ["packages", "apps"]) {
    const containerDir = join(worktreeAbs, container);
    if (!existsSync(containerDir)) continue;
    let entries: string[] = [];
    try {
      entries = await readdir(containerDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const pkgDir = join(containerDir, entry);
      const pkgJsonPath = join(pkgDir, "package.json");
      if (!existsSync(pkgJsonPath)) continue;
      let pkgName = "";
      try {
        const parsed = JSON.parse(await readFile(pkgJsonPath, "utf8")) as { name?: unknown };
        if (typeof parsed.name === "string") pkgName = parsed.name.trim();
      } catch {
        continue;
      }
      if (!pkgName || pkgName.includes("..")) continue;

      const targetLink = join(rootNm, ...pkgName.split("/"));
      try {
        const st = await lstat(targetLink);
        if (st.isSymbolicLink()) {
          const existingRaw = await readlink(targetLink);
          const existingAbs = resolve(dirname(targetLink), existingRaw);
          if (existingAbs === pkgDir) continue;
          await rm(targetLink, { recursive: true, force: true });
        } else {
          continue;
        }
      } catch {
        // Missing symlink -> create below
      }

      await mkdir(dirname(targetLink), { recursive: true });
      await symlink(pkgDir, targetLink, "dir").catch(() => {});
    }
  }
}
