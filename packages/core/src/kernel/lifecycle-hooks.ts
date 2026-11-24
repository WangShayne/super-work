import { existsSync } from "node:fs";
import type {
  HookExecutionRecord,
  LifecycleHookEvent,
  RepoConfig,
  Ticket,
} from "../types.ts";
import { nowIso } from "../utils.ts";
import type { KernelCoordinatorContext } from "./context.ts";

export function getHookCommands(repo: RepoConfig | undefined, event: LifecycleHookEvent): string[] {
  if (!repo?.hooks) return [];
  const raw =
    event === "pre_deliver"
      ? repo.hooks.preDeliver
      : event === "post_deliver"
        ? repo.hooks.postDeliver
        : repo.hooks.onEscalate;
  return (raw ?? []).map((c) => c.trim()).filter(Boolean);
}

export async function executeLifecycleHookOp(
  ctx: KernelCoordinatorContext,
  event: LifecycleHookEvent,
  ticket: Ticket,
  repo: RepoConfig,
  options?: { cwd?: string },
): Promise<HookExecutionRecord> {
  const executedAt = nowIso();
  const commands = getHookCommands(repo, event);
  if (commands.length === 0 || !ctx.workspace.runLifecycleHooks) {
    return {
      event,
      ok: true,
      results: [],
      summary: "No hooks configured",
      executedAt,
    };
  }

  const preferredCwd = options?.cwd?.trim();
  const cwd =
    preferredCwd && existsSync(preferredCwd)
      ? preferredCwd
      : ticket.worktreePath && existsSync(ticket.worktreePath)
        ? ticket.worktreePath
        : repo.rootPath;

  const hookEnv: Record<string, string> = {
    SUPER_WORK_HOOK_EVENT: event,
    SUPER_WORK_HOOK_REPO_ID: repo.id,
    SUPER_WORK_HOOK_TICKET_ID: ticket.id,
    SUPER_WORK_HOOK_BRANCH: ticket.branchName ?? "",
    SUPER_WORK_HOOK_BASE_BRANCH: ticket.targetBranch ?? repo.baseBranch,
    SUPER_WORK_REPO_ID: repo.id,
    SUPER_WORK_TICKET_ID: ticket.id,
    SUPER_WORK_BRANCH: ticket.branchName ?? "",
    SUPER_WORK_BASE_BRANCH: ticket.targetBranch ?? repo.baseBranch,
  };

  let res;
  try {
    res = await ctx.workspace.runLifecycleHooks({
      cwd,
      commands,
      timeoutSec: repo.hooks?.timeoutSec ?? 30,
      hookEnv,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const errRecord: HookExecutionRecord = {
      event,
      ok: false,
      results: [],
      failedCommand: commands[0],
      summary: `Lifecycle hook '${event}' errored: ${msg}`,
      executedAt,
    };
    ctx.emitEvent({
      type: "lifecycle_hook_executed",
      repoId: repo.id,
      ticketId: ticket.id,
      record: errRecord,
      timestamp: executedAt,
    });
    return errRecord;
  }

  const logBody = res.results
    .map(
      (r) =>
        `$ ${r.command}\n[exit=${r.exitCode}, duration=${r.durationMs}ms]\n${r.output || "(no output)"}\n`,
    )
    .join("\n---\n");

  const existingTicket = await ctx.stateStore.getTicket(ticket.id).catch(() => null);
  if (existingTicket) {
    try {
      const art = await ctx.artifactStore.writeSpill(
        {
          ticketId: ticket.id,
          kind: "test_log",
          summary: `Hook ${event}: ${res.ok ? "PASS" : "FAIL"} (${commands.join(" && ")})`,
          ext: "log",
        },
        logBody || res.summary,
      );
      await ctx.stateStore.saveArtifact(art, `hook ${event}\n${res.summary}\n${logBody}`);
    } catch {
      // Non-fatal if artifact persistence fails on best-effort hooks
    }
  }

  const record: HookExecutionRecord = {
    event,
    ok: res.ok,
    results: res.results,
    failedCommand: res.failedCommand,
    summary: res.summary,
    executedAt,
  };
  ctx.emitEvent({
    type: "lifecycle_hook_executed",
    repoId: repo.id,
    ticketId: ticket.id,
    record,
    timestamp: executedAt,
  });
  return record;
}
