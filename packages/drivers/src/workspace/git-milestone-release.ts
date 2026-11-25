import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit, runGh, type GitCommandResult } from "./git-command-runner.ts";

/**
 * Controlled Milestone release on the base branch. Version bump, tag and push are each
 * independently opt-in; nothing is tagged or pushed unless explicitly requested.
 */
export async function executeMilestoneReleaseImpl(input: {
  rootRepoPath: string;
  baseBranch: string;
  targetVersion?: string;
  bumpVersion: boolean;
  createTag: boolean;
  pushRemote: boolean;
  releaseNotes?: string;
  stagingBranch?: string;
  squashReleaseCommit?: boolean;
  releaseCommitMessage?: string;
  createGithubRelease?: boolean;
}): Promise<{
  commitSha?: string;
  tag?: string;
  bumpedFiles: string[];
  pushed: boolean;
  squashed?: boolean;
  githubReleaseUrl?: string;
}> {
  const { rootRepoPath, baseBranch } = input;
  const version = input.targetVersion?.trim().replace(/^v/i, "");
  const wantGithubRelease = input.createGithubRelease === true;
  // Fail fast, before any git mutation.
  if (wantGithubRelease) {
    if (!version || input.createTag !== true || input.pushRemote !== true) {
      throw new Error(
        "createGithubRelease requires a target version plus both createTag and pushRemote; " +
          "enable --tag and --push (and set a milestone target version), or disable the GitHub release.",
      );
    }
    const auth = await runGh(["auth", "status"], rootRepoPath);
    if (auth.exitCode !== 0) {
      throw new Error(
        `createGithubRelease requires an authenticated GitHub CLI (gh auth status failed: ${(auth.stderr || auth.stdout).trim() || "gh unavailable"}). Run \`gh auth login\` first.`,
      );
    }
  }
  const doBump = input.bumpVersion && Boolean(version);
  const doTag = input.createTag === true && Boolean(version);
  const doPush = input.pushRemote === true;
  const doSquash = input.squashReleaseCommit === true;
  const stagingBranch = input.stagingBranch?.trim() || undefined;
  const result: {
    commitSha?: string;
    tag?: string;
    bumpedFiles: string[];
    pushed: boolean;
    squashed?: boolean;
    githubReleaseUrl?: string;
  } = {
    bumpedFiles: [],
    pushed: false,
  };
  if (!doBump && !doTag && !doPush && !doSquash && !stagingBranch) return result;

  const must = async (args: string[], what: string): Promise<GitCommandResult> => {
    const res = await runGit(args, rootRepoPath);
    if (res.exitCode !== 0) {
      throw new Error(`${what} failed: ${(res.stderr || res.stdout).trim()}`);
    }
    return res;
  };

  const head = await must(["rev-parse", "--abbrev-ref", "HEAD"], "Resolve HEAD");
  if (head.stdout.trim() !== baseBranch) {
    await must(["checkout", baseBranch], `Checkout ${baseBranch}`);
  }
  const dirty = await must(["status", "--porcelain", "--untracked-files=no"], "Git status");
  if (dirty.stdout.trim()) {
    throw new Error(`Refusing milestone release: '${baseBranch}' has uncommitted tracked changes`);
  }

  const identity = ["-c", "user.name=super-work", "-c", "user.email=super-work@localhost"];
  const preReleaseSha = (await must(["rev-parse", "HEAD"], "Resolve pre-release HEAD")).stdout.trim();

  if (stagingBranch) {
    const exists = await runGit(
      ["show-ref", "--verify", "--quiet", `refs/heads/${stagingBranch}`],
      rootRepoPath,
    );
    if (exists.exitCode === 0) {
      const merged = await runGit(
        [
          ...identity,
          "merge",
          "--no-ff",
          "-m",
          `Merge milestone staging branch ${stagingBranch}`,
          stagingBranch,
        ],
        rootRepoPath,
      );
      if (merged.exitCode !== 0) {
        await runGit(["merge", "--abort"], rootRepoPath).catch(() => undefined);
        throw new Error(
          `Merge ${stagingBranch} into ${baseBranch} failed: ${(merged.stderr || merged.stdout).trim()}`,
        );
      }
      await runGit(["branch", "-D", stagingBranch], rootRepoPath);
    }
  }

  if (doBump && version) {
    const candidates = ["package.json"];
    const pkgDir = join(rootRepoPath, "packages");
    if (existsSync(pkgDir)) {
      const entries = await readdir(pkgDir, { withFileTypes: true });
      for (const e of entries.filter((d) => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        candidates.push(`packages/${e.name}/package.json`);
      }
    }
    const versionRe = /("version"\s*:\s*")[^"]*(")/;
    for (const rel of candidates) {
      const abs = join(rootRepoPath, rel);
      if (!existsSync(abs)) continue;
      const raw = await readFile(abs, "utf8");
      if (!versionRe.test(raw)) continue;
      const next = raw.replace(versionRe, `$1${version}$2`);
      if (next === raw) continue;
      await writeFile(abs, next, "utf8");
      result.bumpedFiles.push(rel);
    }
    if (result.bumpedFiles.length > 0) {
      await must(["add", "--", ...result.bumpedFiles], "Stage version bump");
      await must(
        [
          "-c",
          "user.name=super-work",
          "-c",
          "user.email=super-work@localhost",
          "commit",
          "-m",
          `chore(release): bump version to v${version}`,
        ],
        "Commit version bump",
      );
    }
  }

  if (doSquash) {
    const preSquashHead = (await must(["rev-parse", "HEAD"], "Resolve HEAD")).stdout.trim();
    if (preSquashHead !== preReleaseSha) {
      const preTree = (await must(["rev-parse", "HEAD^{tree}"], "Resolve tree")).stdout.trim();
      await must(["reset", "--soft", preReleaseSha], "Soft reset for squash");
      await must(
        [
          ...identity,
          "commit",
          "--allow-empty",
          "-m",
          input.releaseCommitMessage?.trim() || `feat: release v${version ?? "milestone"}`,
        ],
        "Commit squashed release",
      );
      const postTree = (await must(["rev-parse", "HEAD^{tree}"], "Resolve tree")).stdout.trim();
      if (postTree !== preTree) {
        await runGit(["reset", "--hard", preSquashHead], rootRepoPath);
        throw new Error(
          `Squash release tree mismatch (${postTree} != ${preTree}); restored ${preSquashHead}`,
        );
      }
      result.squashed = true;
    } else {
      result.squashed = false;
    }
  }

  const sha = await runGit(["rev-parse", "HEAD"], rootRepoPath);
  if (sha.exitCode === 0) result.commitSha = sha.stdout.trim();

  if (doTag && version) {
    const tag = `v${version}`;
    await must(
      [
        "-c",
        "user.name=super-work",
        "-c",
        "user.email=super-work@localhost",
        "tag",
        "-a",
        tag,
        "-m",
        input.releaseNotes?.trim() ? input.releaseNotes.trim().slice(0, 4000) : `Release ${tag}`,
      ],
      `Create tag ${tag}`,
    );
    result.tag = tag;
  }

  if (doPush) {
    await must(["push", "origin", baseBranch], `Push ${baseBranch}`);
    if (result.tag) await must(["push", "origin", result.tag], `Push ${result.tag}`);
    result.pushed = true;
  }

  if (wantGithubRelease && result.pushed && result.tag) {
    const notesDir = await mkdtemp(join(tmpdir(), "super-work-ghrelease-"));
    const notesFile = join(notesDir, "notes.md");
    try {
      await writeFile(notesFile, input.releaseNotes?.trim() || `Release ${result.tag}`, "utf8");
      const rel = await runGh(
        ["release", "create", result.tag, "--title", result.tag, "--notes-file", notesFile],
        rootRepoPath,
      );
      if (rel.exitCode !== 0) {
        throw new Error(
          `Tag ${result.tag} was pushed, but GitHub release creation failed: ${(rel.stderr || rel.stdout).trim()}`,
        );
      }
      const url = rel.stdout.match(/https?:\/\/\S+/)?.[0];
      if (url) result.githubReleaseUrl = url;
    } finally {
      await rm(notesDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  return result;
}
