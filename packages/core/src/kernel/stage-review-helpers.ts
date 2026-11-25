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
    const gatePassed = implNote?.verificationPassed ?? implRun?.status === "completed";
    const packet: ReviewEvidencePacket = {
      baseBranch,
      diffStat,
      changedFiles,
      gatePassed,
      gateCommands: (repo.verificationCommands ?? []).map((c) => c.trim()).filter(Boolean),
      gateDurationMs: Number.isFinite(durationMs) ? durationMs : undefined,
      gateSummary: implRun?.summary ?? implNote?.summary ?? "No preceding implement gate record",
    };
    const guard = ticket.refactorGuard;
    if (gatePassed && guard?.targetHotspotPath && ctx.workspace.verifyHotspotRefactorParity) {
      try {
        const parity = await ctx.workspace.verifyHotspotRefactorParity({
          worktreePath,
          baseBranch,
          targetHotspotPath: guard.targetHotspotPath,
          maxLinesAfter: guard.maxLinesAfter ?? 1200,
          enforceExportParity: guard.enforceExportParity ?? true,
        });
        if (parity.ok && parity.missingExports.length === 0) {
          const map = parity.symbolMigrationMap ?? [];
          packet.refactorParity = {
            targetFile: guard.targetHotspotPath,
            lineCountBefore: parity.linesBefore,
            lineCountAfter: parity.linesAfter,
            maxLines: guard.maxLinesAfter ?? 1200,
            exportsPreserved: true,
            migratedSymbolsCount: map.length,
            newModuleFiles: parity.newModuleFiles ?? [],
            symbolMigrationSummary: map.length
              ? `Moved: ${map
                  .slice(0, 12)
                  .map((m) => `${m.symbol}→${m.targetFile.split("/").pop()}`)
                  .join(", ")}${map.length > 12 ? ` (+${map.length - 12} more)` : ""}`
              : undefined,
          };
        }
      } catch {
        // parity evidence is advisory; fall back to the plain packet
      }
    }
    return packet;
  } catch {
    return undefined;
  }
}
