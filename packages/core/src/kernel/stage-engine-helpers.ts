import { classifyEngineError, getCooldownMsForFailureKind, isEngineTripped } from "../engine-health.ts";
import { mapProtocolToApiPreset, profileDriverEngine, resolveStageModelSelection } from "../model-registry.ts";
import type {
  ApiWorkerPreset,
  EngineModelProfile,
  ModelProfile,
  ReasoningEffort,
  RepoConfig,
  StageKind,
  StageRun,
  SystemSetupConfig,
  Ticket,
  WorkerEngineId,
} from "../types.ts";
import type { KernelCoordinatorContext } from "./context.ts";

export interface TurnWorkerAuthAndModel {
  model?: string;
  effort?: ReasoningEffort;
  baseUrl?: string;
  apiKey?: string;
  apiPreset?: ApiWorkerPreset;
}

/** v1.8.1: picks the ModelProfile (if any) for a stage; `legacyEngine` is returned when no profile applies. */
export async function selectStageProfile(
  ctx: KernelCoordinatorContext,
  input: {
    ticket: Ticket;
    repo: RepoConfig;
    stage: StageKind;
    setupConfig: SystemSetupConfig | null | undefined;
    availableEngines: WorkerEngineId[];
    trippedEngines: WorkerEngineId[];
    legacyEngine: WorkerEngineId;
  },
): Promise<{ engine: WorkerEngineId; profile?: ModelProfile }> {
  const { ticket, repo, stage, setupConfig } = input;
  if (!setupConfig?.modelProfiles?.length) return { engine: input.legacyEngine };
  let implementProfileId: string | undefined;
  let implementEngine: WorkerEngineId | undefined;
  if (stage === "review") {
    const runs = await ctx.stateStore.listStageRuns(ticket.id);
    const last = [...runs].reverse().find((r) => r.stage === "implement" && r.status === "completed");
    implementProfileId = last?.modelProfileId;
    implementEngine = last?.engine;
  }
  const pref = ticket.preferredEngine ?? repo.preferredImplementEngine;
  return resolveStageModelSelection({
    stage,
    ticket,
    repo,
    setupConfig,
    availableEngines: input.availableEngines,
    trippedEngines: input.trippedEngines,
    implementProfileId,
    implementEngine,
    legacyEngine: input.legacyEngine,
    explicitEngine: pref !== undefined && pref !== "auto",
  });
}

/** Resolves model/effort overrides plus relay baseUrl/apiKey/preset for a worker turn. */
export function resolveTurnWorkerAuthAndModel(
  driverEngine: WorkerEngineId,
  ticket: Pick<Ticket, "modelOverride" | "effortOverride" | "preferredEngine">,
  setupConfig: SystemSetupConfig | null | undefined,
  stage?: StageKind,
  selectedProfile?: ModelProfile,
): TurnWorkerAuthAndModel {
  if (selectedProfile && profileDriverEngine(selectedProfile) === driverEngine) {
    const canOverride = Boolean(
      ticket.modelOverride &&
        stage !== "review" &&
        (!ticket.preferredEngine || ticket.preferredEngine === driverEngine),
    );
    const baseUrl = selectedProfile.baseUrl?.trim() || undefined;
    const apiKey = selectedProfile.apiKey?.trim() || undefined;
    return {
      model: canOverride ? ticket.modelOverride : selectedProfile.model,
      effort: stage !== "review" && ticket.effortOverride ? ticket.effortOverride : selectedProfile.effort,
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(selectedProfile.kind === "api"
        ? { apiPreset: mapProtocolToApiPreset(selectedProfile.apiProtocol ?? "openai") }
        : {}),
    };
  }
  const apiProfile = driverEngine === "api" ? setupConfig?.apiWorkerProfile : undefined;
  const cliProfile =
    driverEngine === "claude"
      ? setupConfig?.claudeProfile
      : driverEngine === "codex"
        ? setupConfig?.codexProfile
        : driverEngine === "opencode"
          ? setupConfig?.opencodeProfile
          : driverEngine === "gemini"
            ? setupConfig?.geminiProfile
            : undefined;
  const profile: EngineModelProfile | undefined = apiProfile ?? cliProfile;
  const canApplyModelOverride = Boolean(
    ticket.modelOverride &&
      stage !== "review" &&
      (!ticket.preferredEngine || ticket.preferredEngine === driverEngine),
  );
  const model = canApplyModelOverride ? ticket.modelOverride : profile?.model;
  const effort =
    stage !== "review" && ticket.effortOverride ? ticket.effortOverride : profile?.effort;
  const baseUrl = profile?.baseUrl?.trim() || undefined;
  const apiKey = profile?.apiKey?.trim() || undefined;
  return {
    model,
    effort,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(apiProfile ? { apiPreset: apiProfile.preset } : {}),
  };
}

export function utcTodayString(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Engines whose circuit breaker is currently open (tripped and still cooling down). */
export async function collectTrippedEngines(ctx: KernelCoordinatorContext): Promise<WorkerEngineId[]> {
  try {
    const records = (await ctx.stateStore.listEngineHealth?.()) ?? [];
    const now = Date.now();
    return records.filter((r) => isEngineTripped(r, now)).map((r) => r.engine);
  } catch {
    return [];
  }
}

/** Persists a tripped record when the error is a deterministic account/model failure. */
export async function tripEngineIfDeterministic(
  ctx: KernelCoordinatorContext,
  input: { engine: WorkerEngineId; message: string; repoId: string; ticketId: string; stage: StageKind },
): Promise<boolean> {
  if (input.engine === "mock") return false;
  const cls = classifyEngineError(input.message);
  if (!cls?.deterministic) return false;
  try {
    const prev = await ctx.stateStore.getEngineHealth?.(input.engine);
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    await ctx.stateStore.saveEngineHealth?.({
      engine: input.engine,
      status: "tripped",
      failureKind: cls.kind,
      reason: input.message.slice(0, 500),
      trippedAt: now,
      cooldownUntil: new Date(nowMs + getCooldownMsForFailureKind(cls.kind)).toISOString(),
      consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1,
      lastProbedAt: prev?.lastProbedAt,
      updatedAt: now,
    });
    await ctx.recordFlightEvent?.({
      repoId: input.repoId,
      ticketId: input.ticketId,
      kind: "engine_tripped",
      engine: input.engine,
      summary: `Engine ${input.engine} tripped (${cls.kind}): ${input.message.slice(0, 160)}`,
      metadata: { failureKind: cls.kind, stage: input.stage },
    });
  } catch {
    // Circuit breaker bookkeeping must never fail the stage
  }
  return true;
}

/** Reverts/isolates root-repo writes made by a worker turn that ran in an isolated worktree. */
export async function quarantineSpilloverAfterTurn(
  ctx: KernelCoordinatorContext,
  input: {
    ticket: Ticket;
    repo: RepoConfig;
    stageRun: StageRun;
    engine: WorkerEngineId;
    preTurnDirtyPaths: string[];
  },
): Promise<void> {
  try {
    const res = await ctx.workspace.quarantineRepoSpillover?.({
      rootRepoPath: input.repo.rootPath,
      preTurnDirtyPaths: input.preTurnDirtyPaths,
    });
    if (!res || res.quarantinedPaths.length === 0) return;
    const summary = `Root repo spillover quarantined (${res.quarantinedPaths.length} path(s))`;
    await ctx.artifactStore
      .writeSpill(
        {
          ticketId: input.ticket.id,
          stageRunId: input.stageRun.id,
          kind: "log",
          summary,
          ext: "log",
        },
        res.diffSummary,
      )
      .then((artifact) => ctx.stateStore.saveArtifact(artifact, res.diffSummary));
    console.warn(
      `[super-work] ${summary} for ticket ${input.ticket.id}: ${res.quarantinedPaths.slice(0, 5).join(", ")}`,
    );
    await ctx.recordFlightEvent?.({
      repoId: input.repo.id,
      ticketId: input.ticket.id,
      kind: "spillover_quarantined",
      engine: input.engine,
      summary: `${summary}: ${res.quarantinedPaths.slice(0, 5).join(", ")}`,
      metadata: { paths: res.quarantinedPaths, stageRunId: input.stageRun.id },
    });
  } catch {
    // Spillover shield is best-effort and must never fail the stage
  }
}
