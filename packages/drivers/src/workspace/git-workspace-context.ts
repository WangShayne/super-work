import type { BrowserCheckConfig } from "@super-work/core";
import type { BrowserCheckExecutionResult } from "../browser/cdp-browser-check.ts";
import type { runVerificationCommandsImpl } from "./git-verification-runner.ts";

export type BrowserCheckRunner = (
  baseUrl: string,
  config: BrowserCheckConfig,
) => Promise<BrowserCheckExecutionResult>;

/** Tail parameters of an extracted helper after its leading `ctx` argument. */
export type ImplArgs<F> = F extends (ctx: never, ...args: infer A) => unknown ? A : never;

/**
 * Provider capabilities the extracted helpers call back into. Every member delegates to the live
 * GitWorktreeProvider instance, so subclass overrides and test spies keep taking effect.
 */
export interface GitWorkspaceContext {
  readonly worktreesDir: string;
  readonly browserRunner: BrowserCheckRunner;
  cleanupWorkspace(worktreePath: string, rootRepoPath?: string): Promise<void>;
  getHeadCommitSha(repoOrWorktreePath: string, rev?: string): Promise<string>;
  linkRepoNodeModules(repoRoot: string, worktreePath: string): Promise<void>;
  runVerificationCommands(
    ...args: Parameters<typeof runVerificationCommandsImpl>
  ): ReturnType<typeof runVerificationCommandsImpl>;
  worktreeBaseRef(worktreePath: string): string;
}
