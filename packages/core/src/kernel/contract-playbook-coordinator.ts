import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAutonomyPresetPatch, normalizeAutonomyPreset } from "../autonomy-preset.ts";
import { buildCasebookEntryFromTicket } from "../casebook.ts";
import { buildHandoverDigest, extractDiffContracts } from "../handover.ts";
import {
  classifyPlaybookHealth,
  contractRuleDeterministicId,
  heuristicDistillPlaybookLesson,
  normalizePlaybookRuleText,
  playbookDedupeKey,
} from "../playbook.ts";
import { auditPlaybookEntries, type PlaybookHygieneReport } from "../playbook-hygiene.ts";
import type { WorkspaceProvider } from "../ports.ts";
import type {
  CasebookEntry,
  PlaybookEntry,
  RepoConfig,
  RepoContractFile,
  Ticket,
} from "../types.ts";
import {
  isTerminalTicketStatus,
  newId,
  normalizeSmokeCheckConfig,
  normalizeVerificationStrategy,
  nowIso,
} from "../utils.ts";
import type { KernelCoordinatorContext } from "./context.ts";

export async function syncRepoContractOp(
  ctx: KernelCoordinatorContext,
  repoId: string,
  force = false,
): Promise<RepoConfig | null> {
  const repo = await ctx.stateStore.getRepo(repoId);
  if (!repo || !ctx.workspace.loadRepoContract) return repo;

  let loaded: Awaited<ReturnType<NonNullable<WorkspaceProvider["loadRepoContract"]>>> = null;
  try {
    loaded = await ctx.workspace.loadRepoContract(repo.rootPath);
  } catch {
    return repo;
  }
  if (!loaded) return repo;
  if (!force && repo.contractSyncedHash === loaded.rawHash) {
    return repo;
  }

  const { contract, rawHash } = loaded;
  const ts = nowIso();
  const normalizedHooks = contract.hooks
    ? {
        preDeliver: (contract.hooks.preDeliver ?? []).map((s) => String(s).trim()).filter(Boolean),
        postDeliver: (contract.hooks.postDeliver ?? []).map((s) => String(s).trim()).filter(Boolean),
        onEscalate: (contract.hooks.onEscalate ?? []).map((s) => String(s).trim()).filter(Boolean),
        ...(contract.hooks.timeoutSec !== undefined
          ? { timeoutSec: Number(contract.hooks.timeoutSec) }
          : {}),
      }
    : repo.hooks;

  // v1.8.0: contract 中的 autonomyPreset 作为底，contract 显式字段优先，其次才是现有 repo 值。
  // 预设仅在首次同步或显式 force 同步时展开，避免后续自动同步回退用户经 PATCH 做的显式覆盖（与 mode 规则一致）。
  const contractPreset = normalizeAutonomyPreset(contract.autonomyPreset);
  const preset = contractPreset && (!repo.contractSyncedHash || force) ? contractPreset : undefined;
  const presetPatch = preset ? getAutonomyPresetPatch(preset) : undefined;

  const updatedRepo: RepoConfig = {
    ...repo,
    autonomyPreset: preset ?? repo.autonomyPreset,
    mode:
      !repo.contractSyncedHash && (contract.defaultMode ?? presetPatch?.mode)
        ? (contract.defaultMode ?? presetPatch!.mode)
        : repo.mode,
    autoCleanupWorktree:
      presetPatch && repo.autoCleanupWorktree === undefined
        ? presetPatch.autoCleanupWorktree
        : repo.autoCleanupWorktree,
    defaultDeliveryChannel:
      contract.defaultDeliveryChannel !== undefined
        ? contract.defaultDeliveryChannel
        : repo.defaultDeliveryChannel,
    defaultTemplate: contract.defaultTemplate ?? repo.defaultTemplate,
    defaultTddMode:
      contract.defaultTddMode !== undefined ? Boolean(contract.defaultTddMode) : repo.defaultTddMode,
    deliveryGatePolicy:
      contract.deliveryGatePolicy !== undefined
        ? contract.deliveryGatePolicy
        : (presetPatch?.deliveryGatePolicy ?? repo.deliveryGatePolicy),
    riskThreshold:
      contract.riskThreshold !== undefined
        ? contract.riskThreshold
        : presetPatch
          ? presetPatch.riskThreshold
          : repo.riskThreshold,
    sensitivePaths:
      contract.sensitivePaths !== undefined
        ? contract.sensitivePaths.map((s) => String(s).trim()).filter(Boolean)
        : repo.sensitivePaths,
    blueprints: Array.isArray(contract.blueprints)
      ? contract.blueprints.filter((b) => Boolean(b?.id?.trim()))
      : repo.blueprints,
    verificationCommands:
      contract.verificationCommands !== undefined
        ? contract.verificationCommands.map((s) => String(s).trim()).filter(Boolean)
        : repo.verificationCommands,
    verificationStrategy:
      normalizeVerificationStrategy(contract.verificationStrategy) ??
      presetPatch?.verificationStrategy ??
      repo.verificationStrategy,
    setupCommands:
      contract.setupCommands !== undefined
        ? contract.setupCommands.map((s) => String(s).trim()).filter(Boolean)
        : repo.setupCommands,
    hooks: normalizedHooks,
    smokeCheck:
      contract.smokeCheck !== undefined
        ? normalizeSmokeCheckConfig(contract.smokeCheck)
        : repo.smokeCheck,
    previewCommand:
      contract.previewCommand !== undefined
        ? contract.previewCommand.trim() || undefined
        : repo.previewCommand,
    sandboxMode:
      contract.sandboxMode !== undefined
        ? contract.sandboxMode
        : (presetPatch?.sandboxMode ?? repo.sandboxMode),
    forbiddenPaths:
      contract.forbiddenPaths !== undefined
        ? contract.forbiddenPaths.map((s) => String(s).trim()).filter(Boolean)
        : repo.forbiddenPaths,
    conventions:
      contract.conventions !== undefined
        ? contract.conventions.trim() || undefined
        : repo.conventions,
    contractSyncedHash: rawHash,
    contractSyncedAt: ts,
    updatedAt: ts,
  };

  await ctx.stateStore.upsertRepo(updatedRepo);

  if (Array.isArray(contract.playbook)) {
    const existingEntries = await ctx.stateStore.listPlaybookEntries(repo.id);
    const keepContractIds = new Set<string>();

    for (const spec of contract.playbook) {
      const cleanRule = normalizePlaybookRuleText(String(spec.rule ?? ""));
      if (!cleanRule) continue;
      const entryId = contractRuleDeterministicId(repo.id, { ...spec, rule: cleanRule });
      keepContractIds.add(entryId);
      const existing = existingEntries.find((e) => e.id === entryId);
      const entry: PlaybookEntry = {
        id: entryId,
        repoId: repo.id,
        rule: cleanRule,
        scopePaths:
          Array.isArray(spec.scopePaths) && spec.scopePaths.length > 0
            ? spec.scopePaths.map((p) => String(p).trim()).filter(Boolean)
            : ["**"],
        source: "repo_contract",
        enabled: existing ? existing.enabled : true,
        pinned: spec.pinned ?? existing?.pinned ?? false,
        createdAt: existing?.createdAt ?? ts,
        updatedAt: ts,
      };
      await ctx.stateStore.savePlaybookEntry(entry);
      ctx.emitEvent({ type: "playbook_updated", repoId: repo.id, entry, timestamp: ts });
    }

    for (const existing of existingEntries) {
      if (existing.source === "repo_contract" && !keepContractIds.has(existing.id)) {
        await ctx.stateStore.deletePlaybookEntry(existing.id);
        ctx.emitEvent({
          type: "playbook_updated",
          repoId: repo.id,
          deletedId: existing.id,
          timestamp: ts,
        });
      }
    }
  }

  ctx.emitEvent({ type: "repo_updated", repo: updatedRepo, timestamp: ts });
  return updatedRepo;
}

export async function exportRepoContractOp(
  ctx: KernelCoordinatorContext,
  repoId: string,
): Promise<{ repo: RepoConfig; contract: RepoContractFile; filePath: string }> {
  const repo = await ctx.stateStore.getRepo(repoId);
  if (!repo) {
    throw new Error(`Repository not found: ${repoId}`);
  }
  if (!ctx.workspace.writeRepoContract) {
    throw new Error("WorkspaceProvider does not support writing super-work.json contract.");
  }

  const entries = await ctx.stateStore.listPlaybookEntries(repoId, { onlyEnabled: true });
  const hasHooks = Boolean(
    repo.hooks &&
      ((repo.hooks.preDeliver?.length ?? 0) > 0 ||
        (repo.hooks.postDeliver?.length ?? 0) > 0 ||
        (repo.hooks.onEscalate?.length ?? 0) > 0 ||
        repo.hooks.timeoutSec !== undefined),
  );

  const contract: RepoContractFile = {
    version: 1,
    ...(repo.autonomyPreset ? { autonomyPreset: repo.autonomyPreset } : {}),
    defaultMode: repo.mode,
    ...(repo.defaultDeliveryChannel ? { defaultDeliveryChannel: repo.defaultDeliveryChannel } : {}),
    defaultTemplate: repo.defaultTemplate,
    ...(repo.defaultTddMode !== undefined ? { defaultTddMode: repo.defaultTddMode } : {}),
    ...(repo.deliveryGatePolicy ? { deliveryGatePolicy: repo.deliveryGatePolicy } : {}),
    ...(repo.riskThreshold !== undefined ? { riskThreshold: repo.riskThreshold } : {}),
    ...(repo.sensitivePaths && repo.sensitivePaths.length > 0
      ? { sensitivePaths: repo.sensitivePaths }
      : {}),
    verificationCommands: repo.verificationCommands ?? [],
    ...(repo.verificationStrategy ? { verificationStrategy: repo.verificationStrategy } : {}),
    setupCommands: repo.setupCommands ?? [],
    ...(hasHooks ? { hooks: repo.hooks } : {}),
    ...(repo.smokeCheck ? { smokeCheck: repo.smokeCheck } : {}),
    ...(repo.previewCommand?.trim() ? { previewCommand: repo.previewCommand.trim() } : {}),
    ...(repo.sandboxMode ? { sandboxMode: repo.sandboxMode } : {}),
    forbiddenPaths: repo.forbiddenPaths ?? [],
    ...(repo.conventions?.trim() ? { conventions: repo.conventions.trim() } : {}),
    playbook: entries.map((e) => ({
      id: e.id,
      rule: e.rule,
      scopePaths: e.scopePaths,
      pinned: e.pinned,
    })),
    ...(repo.blueprints && repo.blueprints.length > 0 ? { blueprints: repo.blueprints } : {}),
  };

  const written = await ctx.workspace.writeRepoContract(repo.rootPath, contract);
  const ts = nowIso();
  const updatedRepo: RepoConfig = {
    ...repo,
    contractSyncedHash: written.rawHash,
    contractSyncedAt: ts,
    updatedAt: ts,
  };
  await ctx.stateStore.upsertRepo(updatedRepo);
  ctx.emitEvent({ type: "repo_updated", repo: updatedRepo, timestamp: ts });
  return { repo: updatedRepo, contract, filePath: written.filePath };
}

export async function addOrUpdatePlaybookRuleOp(
  ctx: KernelCoordinatorContext,
  input: {
    repoId: string;
    rule: string;
    scopePaths?: string[];
    source: PlaybookEntry["source"];
    sourceTicketId?: string;
    pinned?: boolean;
    enabled?: boolean;
  },
): Promise<PlaybookEntry | null> {
  const cleanRule = normalizePlaybookRuleText(input.rule);
  if (!cleanRule) return null;

  const ts = nowIso();
  const scopePaths =
    input.scopePaths && input.scopePaths.length > 0
      ? Array.from(new Set(input.scopePaths.map((s) => s.trim()).filter(Boolean)))
      : ["**"];

  const existing = await ctx.stateStore.listPlaybookEntries(input.repoId);
  const key = playbookDedupeKey(cleanRule);
  const dup = existing.find((e) => playbookDedupeKey(e.rule) === key);

  if (dup) {
    const mergedScopes = Array.from(new Set([...dup.scopePaths, ...scopePaths]));
    const updated: PlaybookEntry = {
      ...dup,
      rule: input.source === "human" ? cleanRule : dup.rule,
      scopePaths: mergedScopes,
      pinned: input.pinned ?? dup.pinned,
      enabled: input.enabled ?? dup.enabled,
      updatedAt: ts,
    };
    await ctx.stateStore.savePlaybookEntry(updated);
    ctx.emitEvent({ type: "playbook_updated", repoId: input.repoId, entry: updated, timestamp: ts });
    return updated;
  }

  const entry: PlaybookEntry = {
    id: newId("pbk"),
    repoId: input.repoId,
    rule: cleanRule,
    scopePaths,
    source: input.source,
    sourceTicketId: input.sourceTicketId,
    enabled: input.enabled ?? true,
    pinned: input.pinned ?? false,
    createdAt: ts,
    updatedAt: ts,
  };
  await ctx.stateStore.savePlaybookEntry(entry);
  ctx.emitEvent({ type: "playbook_updated", repoId: input.repoId, entry, timestamp: ts });
  return entry;
}

export async function prunePlaybookEntriesOp(
  ctx: KernelCoordinatorContext,
  repoId: string,
): Promise<{ prunedIds: string[]; keptCount: number }> {
  const repo = await ctx.stateStore.getRepo(repoId);
  if (!repo) {
    throw new Error(`Repository not found: ${repoId}`);
  }
  const entries = await ctx.stateStore.listPlaybookEntries(repoId);
  const pathExists = (relPath: string): boolean => existsSync(join(repo.rootPath, relPath));
  const prunedIds: string[] = [];
  let keptCount = 0;

  for (const entry of entries) {
    const health = classifyPlaybookHealth(entry, { pathExists });
    if (entry.source === "auto_healed" && !entry.pinned && health.prunable) {
      await ctx.stateStore.deletePlaybookEntry(entry.id);
      prunedIds.push(entry.id);
      ctx.emitEvent({
        type: "playbook_updated",
        repoId,
        deletedId: entry.id,
        timestamp: nowIso(),
      });
    } else {
      keptCount += 1;
    }
  }
  return { prunedIds, keptCount };
}

async function listPlaybookEntriesForScope(
  ctx: KernelCoordinatorContext,
  repoId?: string,
): Promise<PlaybookEntry[]> {
  if (repoId) {
    const repo = await ctx.stateStore.getRepo(repoId);
    if (!repo) throw new Error(`Repository not found: ${repoId}`);
    return ctx.stateStore.listPlaybookEntries(repoId);
  }
  const repos = await ctx.stateStore.listRepos();
  const all: PlaybookEntry[] = [];
  for (const r of repos) all.push(...(await ctx.stateStore.listPlaybookEntries(r.id)));
  return all;
}

export async function auditPlaybookHygieneOp(
  ctx: KernelCoordinatorContext,
  repoId?: string,
): Promise<PlaybookHygieneReport> {
  return auditPlaybookEntries(await listPlaybookEntriesForScope(ctx, repoId), repoId);
}

export async function pruneNoisyPlaybooksOp(
  ctx: KernelCoordinatorContext,
  repoId?: string,
  options?: { dryRun?: boolean; mode?: "disable" | "delete" },
): Promise<{
  audited: PlaybookHygieneReport;
  affectedIds: string[];
  mode: "disable" | "delete";
  dryRun: boolean;
}> {
  const mode = options?.mode === "delete" ? "delete" : "disable";
  const dryRun = options?.dryRun === true;
  const entries = await listPlaybookEntriesForScope(ctx, repoId);
  const audited = auditPlaybookEntries(entries, repoId);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const affectedIds: string[] = [];
  for (const noisy of audited.noisyEntries) {
    const entry = byId.get(noisy.id);
    if (!entry) continue;
    // In disable mode, already-disabled noisy entries need no further change.
    if (mode === "disable" && !entry.enabled && entry.suspect) continue;
    affectedIds.push(entry.id);
    if (dryRun) continue;
    const ts = nowIso();
    if (mode === "delete") {
      await ctx.stateStore.deletePlaybookEntry(entry.id);
      ctx.emitEvent({ type: "playbook_updated", repoId: entry.repoId, deletedId: entry.id, timestamp: ts });
    } else {
      const updated: PlaybookEntry = { ...entry, enabled: false, suspect: true, updatedAt: ts };
      await ctx.stateStore.savePlaybookEntry(updated);
      ctx.emitEvent({ type: "playbook_updated", repoId: entry.repoId, entry: updated, timestamp: ts });
    }
  }
  return { audited, affectedIds, mode, dryRun };
}

export async function maybeDistillClosedLoopLessonOp(
  ctx: KernelCoordinatorContext,
  ticket: Ticket,
  repoArg?: RepoConfig,
): Promise<void> {
  if (ticket.isEpic) return;
  const stageRuns = await ctx.stateStore.listStageRuns(ticket.id);
  const failedImplRuns = stageRuns.filter(
    (r) => (r.stage === "implement" || r.stage === "rebase") && r.status === "failed",
  );
  const rejectedReviewNotes = ticket.inlineMemory.stageNotes.filter(
    (n) => n.stage === "review" && n.reviewApproved === false,
  );

  if (failedImplRuns.length === 0 && rejectedReviewNotes.length === 0) {
    return;
  }

  const repo = repoArg ?? (await ctx.stateStore.getRepo(ticket.repoId));
  if (!repo) return;

  const latestRejectedReview = rejectedReviewNotes.at(-1);
  const latestFailedImpl = failedImplRuns.at(-1);
  const useReviewFailure = Boolean(
    latestRejectedReview &&
      (!latestFailedImpl ||
        latestRejectedReview.createdAt >= (latestFailedImpl.completedAt ?? latestFailedImpl.startedAt)),
  );

  const isSmokeFailure = Boolean(latestFailedImpl?.summary?.includes("Smoke check failed"));
  const failureKind: "verification" | "smoke" | "review" = useReviewFailure
    ? "review"
    : isSmokeFailure
      ? "smoke"
      : "verification";
  const failureSummary = useReviewFailure
    ? latestRejectedReview?.summary || "Code review requested changes"
    : latestFailedImpl?.summary || "Verification check failed";

  const latestSuccessImpl = [...ticket.inlineMemory.stageNotes]
    .reverse()
    .find((n) => n.stage === "implement" && n.verificationPassed);
  const fixSummary =
    latestSuccessImpl?.summary ||
    ticket.inlineMemory.stageNotes.at(-1)?.summary ||
    "Fixed implementation and passed verification gate";
  const changedFiles = Array.from(
    new Set(ticket.inlineMemory.stageNotes.flatMap((n) => n.changedFiles)),
  );

  let lesson: { rule: string; scopePaths: string[] } | null = null;
  if (ctx.llm.distillPlaybookLesson) {
    try {
      lesson = await ctx.llm.distillPlaybookLesson({
        repo,
        ticket,
        failureKind,
        failureSummary,
        fixSummary,
        changedFiles,
      });
    } catch {
      lesson = null;
    }
  }
  if (!lesson || !lesson.rule.trim()) {
    lesson = heuristicDistillPlaybookLesson({
      failureKind,
      failureSummary,
      fixSummary,
      changedFiles,
      allowedPaths: ticket.mandate.allowedPaths,
    });
  }

  await addOrUpdatePlaybookRuleOp(ctx, {
    repoId: repo.id,
    rule: lesson.rule,
    scopePaths: lesson.scopePaths,
    source: "auto_healed",
    sourceTicketId: ticket.id,
    enabled: true,
    pinned: false,
  });
}

export async function generateAndSaveHandoverDigestOp(
  ctx: KernelCoordinatorContext,
  ticket: Ticket,
  repo: RepoConfig,
  precomputed?: { changedFiles: string[]; diffText: string },
): Promise<Ticket> {
  if (ticket.isEpic && ticket.epicDeliveryMode === "per_subtask") {
    return ticket;
  }

  let changedFiles = precomputed?.changedFiles ?? [];
  let diffText = precomputed?.diffText ?? "";

  if (!precomputed) {
    if (ticket.worktreePath && existsSync(ticket.worktreePath)) {
      try {
        const { effectiveBaseBranch } = await ctx.getEffectiveBaseInfo(ticket, repo);
        changedFiles = await ctx.workspace.getChangedFiles(ticket.worktreePath, effectiveBaseBranch);
        diffText = await ctx.workspace.getDiff(ticket.worktreePath, effectiveBaseBranch);
      } catch {
        // Fall back to latest recorded Spill diff artifact
      }
    }

    if (!diffText.trim()) {
      const artifacts = await ctx.stateStore.listArtifacts(ticket.id);
      const latestDiff = [...artifacts].reverse().find((a) => a.kind === "diff");
      if (latestDiff) {
        try {
          diffText = await ctx.artifactStore.readSpill(latestDiff.storageUri);
        } catch {
          diffText = "";
        }
      }
    }

    if (changedFiles.length === 0) {
      const latestFilesNote = [...ticket.inlineMemory.stageNotes]
        .reverse()
        .find((n) => n.changedFiles.length > 0 && n.verificationPassed);
      if (latestFilesNote) {
        changedFiles = latestFilesNote.changedFiles;
      } else if (diffText.trim()) {
        changedFiles = Array.from(
          new Set(
            Array.from(diffText.matchAll(/^\+\+\+\s+b\/(.+)$/gm))
              .map((m) => m[1]!.trim())
              .filter((p) => p !== "/dev/null"),
          ),
        );
      }
    }
  }

  const stageSummary =
    [...ticket.inlineMemory.stageNotes]
      .reverse()
      .find((n) => n.stage === "implement" || n.stage === "rebase")?.summary ??
    ticket.inlineMemory.stageNotes.at(-1)?.summary ??
    ticket.title;

  const extracted = extractDiffContracts(diffText);
  let llmRefinement: {
    summary?: string;
    exportedSymbols?: string[];
    contractSnippets?: string[];
  } | null = null;
  if (ctx.llm.distillHandoverDigest && (changedFiles.length > 0 || diffText.trim().length > 0)) {
    try {
      llmRefinement = await ctx.llm.distillHandoverDigest({
        repo,
        ticket,
        changedFiles,
        exportedSymbols: extracted.exportedSymbols,
        contractSnippets: extracted.contractSnippets,
        diffExcerpt: diffText.slice(0, 6000),
        stageSummary,
      });
    } catch {
      llmRefinement = null;
    }
  }

  const previousDigest = ticket.handoverDigest;
  const version = (previousDigest?.version ?? 0) + 1;
  const digest = buildHandoverDigest({
    ticket,
    repoName: repo.name,
    changedFiles,
    diffText,
    stageSummary,
    version,
    llmRefinement,
  });

  const handoverArtifact = await ctx.artifactStore.writeSpill(
    {
      ticketId: ticket.id,
      kind: "handover",
      summary: `Handover v${digest.version}: ${ticket.title}`,
      ext: "md",
    },
    digest.formattedMarkdown,
  );
  await ctx.stateStore.saveArtifact(handoverArtifact, digest.formattedMarkdown);

  const ts = nowIso();
  const updated: Ticket = {
    ...ticket,
    handoverDigest: digest,
    updatedAt: ts,
  };
  await ctx.stateStore.saveTicket(updated);
  ctx.emitEvent({ type: "ticket_updated", ticket: updated, timestamp: ts });

  if (previousDigest && previousDigest.formattedMarkdown !== digest.formattedMarkdown) {
    const allTickets = await ctx.stateStore.listTickets();
    for (const downstream of allTickets) {
      if (downstream.id === ticket.id || isTerminalTicketStatus(downstream.status)) continue;
      if (!downstream.dependsOn.includes(ticket.id)) continue;

      const driftTs = nowIso();
      const driftMsg = `[Upstream Contract Updated v${digest.version} from ${repo.name}/${ticket.id}] ${digest.summary}`;
      const updatedDownstream: Ticket = {
        ...downstream,
        inlineMemory: {
          ...downstream.inlineMemory,
          threadUpdates: [
            ...downstream.inlineMemory.threadUpdates,
            {
              triggerId: newId("drift"),
              message: driftMsg,
              createdAt: driftTs,
            },
          ],
          activeHint: [downstream.inlineMemory.activeHint?.trim(), driftMsg]
            .filter(Boolean)
            .join("\n\n"),
        },
        updatedAt: driftTs,
      };
      await ctx.stateStore.saveTicket(updatedDownstream);
      ctx.emitEvent({
        type: "thread_routed",
        ticketId: updatedDownstream.id,
        triggerId: ticket.id,
        message: driftMsg,
        timestamp: driftTs,
      });
      ctx.emitEvent({
        type: "ticket_updated",
        ticket: updatedDownstream,
        timestamp: driftTs,
      });
    }
  }

  return updated;
}

export async function recordDeliveredCasebookEntryOp(
  ctx: KernelCoordinatorContext,
  ticket: Ticket,
): Promise<void> {
  if (ticket.isEpic && ticket.epicDeliveryMode === "per_subtask") return;
  const priorCase = await ctx.stateStore.getCasebookEntryByTicket(ticket.id);
  const entry: CasebookEntry = buildCasebookEntryFromTicket({
    ticket,
    digest: ticket.handoverDigest,
    priorCase,
  });
  await ctx.stateStore.saveCasebookEntry(entry);
  await ctx.stateStore.indexMemoryDocument({
    entityType: "casebook",
    entityId: entry.id,
    ticketId: ticket.id,
    repoId: ticket.repoId,
    title: `Casebook: ${entry.title}`,
    body: [
      entry.goalSummary,
      entry.solutionSummary,
      entry.pitfallsAndFixes ?? "",
      entry.exportedSymbols.join(" "),
      entry.changedFiles.join(" "),
    ]
      .filter(Boolean)
      .join("\n"),
  });
  ctx.emitEvent({
    type: "casebook_updated",
    repoId: ticket.repoId,
    entry,
    timestamp: entry.updatedAt,
  });
}
