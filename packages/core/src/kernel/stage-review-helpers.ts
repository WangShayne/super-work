import type { RepoConfig, ReviewEvidencePacket, Ticket } from "../types.ts";
import type { KernelCoordinatorContext } from "./context.ts";

export async function buildReviewEvidencePacketOp(
  ctx: KernelCoordinatorContext,
  ticket: Ticket,
  repo: RepoConfig,
  worktreePath: string,
  baseBranch: string,
): Promise<ReviewEvidencePacket | undefined> {
  try {
    const runs = await ctx.stateStore.listStageRuns(ticket.id);
    const implRun = [...runs]
      .reverse()
      .find((r) => r.stage === "implement" && (r.status === "completed" || r.status === "failed"));
    const implNote = implRun
      ? ticket.inlineMemory.stageNotes.find((n) => n.stageRunId === implRun.id)
      : [...ticket.inlineMemory.stageNotes].reverse().find((n) => n.stage === "implement");

    let changedFiles: string[] = [];
    try {
      changedFiles = await ctx.workspace.getChangedFiles(worktreePath, baseBranch);
    } catch {
      changedFiles = [];
    }
    if (changedFiles.length === 0 && implNote) changedFiles = implNote.changedFiles;

    let diffStat = "";
    try {
      diffStat = (await ctx.workspace.getDiffStat?.(worktreePath, baseBranch)) ?? "";
    } catch {
      diffStat = "";
    }

    const durationMs =
      implRun?.startedAt && implRun.completedAt
        ? Math.max(0, Date.parse(implRun.completedAt) - Date.parse(implRun.startedAt))
        : undefined;
    return {
      baseBranch,
      diffStat,
      changedFiles,
      gatePassed: implNote?.verificationPassed ?? implRun?.status === "completed",
      gateCommands: (repo.verificationCommands ?? []).map((c) => c.trim()).filter(Boolean),
      gateDurationMs: Number.isFinite(durationMs) ? durationMs : undefined,
      gateSummary: implRun?.summary ?? implNote?.summary ?? "No preceding implement gate record",
    };
  } catch {
    return undefined;
  }
}
