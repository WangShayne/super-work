import { formatUpstreamHandoversForPrompt } from "./handover.ts";
import type { ArtifactStore, StateStore } from "./ports.ts";
import type {
  ChainOfRecall,
  HandoverDigest,
  InlineStageNote,
  MemorySearchHit,
  ReviewFinding,
  SmokeCheckConfig,
  SpillArtifact,
  StageKind,
  StageRun,
  Ticket,
  WorkerStreamEvent,
} from "./types.ts";

export interface WorkerPromptOptions {
  verificationCommands?: string[];
  smokeCheck?: SmokeCheckConfig;
  repoConventions?: string;
  playbookContext?: string;
  upstreamHandovers?: HandoverDigest[];
}

export class MemoryManager {
  constructor(
    private readonly stateStore: StateStore,
    private readonly artifactStore: ArtifactStore,
  ) {}

  buildWorkerPromptContext(
    ticket: Ticket,
    stage: StageKind,
    relatedMemory: MemorySearchHit[],
    optionsOrCommands?: string[] | WorkerPromptOptions,
  ): string {
    const opts: WorkerPromptOptions = Array.isArray(optionsOrCommands)
      ? { verificationCommands: optionsOrCommands }
      : (optionsOrCommands ?? {});
    const verificationCommands = opts.verificationCommands;
    const sections: string[] = [];

    sections.push(`# Super-Work Task Context`);
    sections.push(`Ticket: ${ticket.id} — ${ticket.title}`);
    sections.push(`Stage: ${stage.toUpperCase()} (Template: ${ticket.template})`);
    sections.push(`Goal: ${ticket.inlineMemory.goal}`);

    if (ticket.description && ticket.description !== ticket.inlineMemory.goal) {
      sections.push(`\n## Description\n${ticket.description}`);
    }

    if (ticket.inlineMemory.acceptanceCriteria.length > 0) {
      sections.push(
        `\n## Acceptance Criteria\n${ticket.inlineMemory.acceptanceCriteria
          .map((c) => `- ${c}`)
          .join("\n")}`,
      );
    }

    sections.push(`\n## Mandate (Immutable Scope & Constraints)`);
    sections.push(`- Allowed paths: ${ticket.mandate.allowedPaths.join(", ") || "**"}`);
    sections.push(`- Forbidden paths: ${ticket.mandate.forbiddenPaths.join(", ")}`);
    sections.push(`- External side effects prohibited: NEVER run git push, gh pr create, or external API mutations directly; super-work handles delivery via Outbox.`);
    if (verificationCommands && verificationCommands.length > 0) {
      sections.push(
        `- Deterministic verification gate: ${verificationCommands.join(" && ")} (executed automatically by super-work after implement and rebase)`,
      );
    }
    if (opts.smokeCheck?.enabled && opts.smokeCheck.startCommand?.trim()) {
      sections.push(
        `- Ephemeral runtime smoke gate: \`${opts.smokeCheck.startCommand}\` probed at \`${opts.smokeCheck.readyUrl || "http://127.0.0.1:$PORT"}\` (dynamic $PORT env injected by super-work)`,
      );
    }

    if (opts.repoConventions?.trim()) {
      sections.push(`\n## Repository Engineering Conventions\n${opts.repoConventions.trim()}`);
    }

    if (opts.playbookContext?.trim()) {
      sections.push(`\n## Repository Playbook (Learned Rules & Guardrails)\n${opts.playbookContext.trim()}`);
    }

    if (opts.upstreamHandovers && opts.upstreamHandovers.length > 0) {
      const handoverBlock = formatUpstreamHandoversForPrompt(opts.upstreamHandovers);
      if (handoverBlock) {
        sections.push(`\n## Upstream Dependency Contracts (Handover Digest)\n${handoverBlock}`);
      }
    }

    if (ticket.inlineMemory.planSummary) {
      sections.push(`\n## Approved Plan Summary (Inline)\n${ticket.inlineMemory.planSummary}`);
    }

    if (ticket.inlineMemory.stageNotes.length > 0) {
      const recentNotes = ticket.inlineMemory.stageNotes.slice(-4);
      const formattedNotes = recentNotes
        .map(
          (note) =>
            `- [${note.stage.toUpperCase()} via ${note.engine}] ${note.summary}` +
            (note.changedFiles.length > 0 ? ` (Files: ${note.changedFiles.join(", ")})` : "") +
            (note.spillArtifactIds.length > 0 ? ` [Spill IDs: ${note.spillArtifactIds.join(", ")}]` : ""),
        )
        .join("\n");
      sections.push(`\n## Prior Stage Handover (Inline Memory)\n${formattedNotes}`);
    }

    if (ticket.inlineMemory.threadUpdates.length > 0) {
      const recentUpdates = ticket.inlineMemory.threadUpdates.slice(-5);
      sections.push(
        `\n## Follow-Up Thread Updates\n${recentUpdates
          .map((u) => `- (${u.createdAt}) ${u.message}`)
          .join("\n")}`,
      );
    }

    if (ticket.inlineMemory.activeHint) {
      sections.push(`\n## Active Guidance / Feedback (Address This First)\n${ticket.inlineMemory.activeHint}`);
    }

    if (relatedMemory.length > 0) {
      const pointers = relatedMemory
        .filter((m) => m.ticketId !== ticket.id)
        .slice(0, 3)
        .map((m) => `- [${m.ticketId}] ${m.title}: ${m.snippet}`);
      if (pointers.length > 0) {
        sections.push(`\n## Related Historical Recall (Chain of Recall)\n${pointers.join("\n")}`);
      }
    }

    sections.push(`\n## Stage Instructions (${stage})`);
    sections.push(stageInstructionFor(stage));

    return sections.join("\n");
  }

  async recordStageSpillAndNote(input: {
    ticket: Ticket;
    stageRun: StageRun;
    events: WorkerStreamEvent[];
    changedFiles: string[];
    diffText?: string;
    summary: string;
    verificationPassed: boolean;
    reviewApproved?: boolean;
    reviewFindings?: ReviewFinding[];
    extraArtifacts?: SpillArtifact[];
  }): Promise<{ note: InlineStageNote; artifacts: SpillArtifact[] }> {
    const artifacts: SpillArtifact[] = [...(input.extraArtifacts ?? [])];

    const transcriptContent = input.events.map((e) => JSON.stringify(e)).join("\n");
    const transcriptArtifact = await this.artifactStore.writeSpill(
      {
        ticketId: input.ticket.id,
        stageRunId: input.stageRun.id,
        kind: "transcript",
        summary: `${input.stageRun.stage} transcript (${input.stageRun.engine})`,
        ext: "jsonl",
      },
      transcriptContent || "{\"info\":\"empty_transcript\"}\n",
    );
    await this.stateStore.saveArtifact(transcriptArtifact, input.summary);
    artifacts.push(transcriptArtifact);

    if (input.diffText && input.diffText.trim().length > 0) {
      const diffArtifact = await this.artifactStore.writeSpill(
        {
          ticketId: input.ticket.id,
          stageRunId: input.stageRun.id,
          kind: "diff",
          summary: `${input.stageRun.stage} diff (${input.changedFiles.length} files)`,
          ext: "patch",
        },
        input.diffText,
      );
      await this.stateStore.saveArtifact(diffArtifact, input.changedFiles.join(" "));
      artifacts.push(diffArtifact);
    }

    const note: InlineStageNote = {
      stageRunId: input.stageRun.id,
      stage: input.stageRun.stage,
      engine: input.stageRun.engine,
      summary: truncateSummary(input.summary, 600),
      changedFiles: input.changedFiles,
      verificationPassed: input.verificationPassed,
      reviewApproved: input.reviewApproved,
      reviewFindings: input.reviewFindings && input.reviewFindings.length > 0 ? input.reviewFindings : undefined,
      spillArtifactIds: artifacts.map((a) => a.id),
      createdAt: new Date().toISOString(),
    };

    await this.stateStore.indexMemoryDocument({
      entityType: "stage_note",
      entityId: input.stageRun.id,
      ticketId: input.ticket.id,
      repoId: input.ticket.repoId,
      title: `${input.ticket.title} [${input.stageRun.stage}]`,
      body: `${input.summary}\nFiles: ${input.changedFiles.join(", ")}`,
    });

    return { note, artifacts };
  }

  async getChainOfRecall(ticketId: string): Promise<ChainOfRecall | null> {
    const base = await this.stateStore.recallChain(ticketId);
    if (!base) return null;

    if (base.relatedTickets.length === 0) {
      const hits = await this.stateStore.searchMemory(base.ticket.title, 6, base.ticket.repoId);
      const seen = new Set<string>([ticketId]);
      for (const hit of hits) {
        if (seen.has(hit.ticketId)) continue;
        seen.add(hit.ticketId);
        const rel = await this.stateStore.getTicket(hit.ticketId);
        if (rel) {
          base.relatedTickets.push({
            ticketId: rel.id,
            title: rel.title,
            status: rel.status,
            snippet: hit.snippet,
          });
        }
      }
    }

    return base;
  }
}

function stageInstructionFor(stage: StageKind): string {
  switch (stage) {
    case "plan":
      return [
        "Inspect the repository within the allowed paths in read-only mode.",
        "Produce a concise, actionable implementation plan covering files to modify, edge cases, and verification commands.",
        "Do NOT edit files or run destructive commands in this stage.",
      ].join("\n");
    case "implement":
      return [
        "Implement the requested changes strictly inside the allowed paths.",
        "Run relevant unit/typecheck tests locally to verify your implementation.",
        "Do NOT run git push or create PRs directly. Leave clean changes ready for review.",
      ].join("\n");
    case "review":
      return [
        "Perform an independent adversarial code review of the current worktree diff against the goal, acceptance criteria, Repository Conventions, Playbook, and Mandate.",
        "Check for correctness bugs, security leaks, missing edge cases, regression risks, or out-of-scope modifications.",
        "Classify each finding with severity: 'blocker' (must fix before ship), 'major' (bug/missing requirement/test gap), or 'nit' (minor non-blocking style/cleanup suggestion).",
        "Output a fenced JSON block with the structured findings followed by a final verdict line:",
        "```json",
        '{"verdict":"approved|changes_requested","findings":[{"severity":"blocker|major|nit","file":"path/to/file.ts","line":10,"message":"...","suggestion":"..."}]}',
        "```",
        "End your final summary with `VERDICT: APPROVED` or `VERDICT: REJECTED - <reason>`.",
      ].join("\n");
    case "rebase":
      return [
        "Verify the worktree branch is clean and ready for rebase onto the base branch.",
        "If resolving a merge conflict hint, resolve conflicted files cleanly and re-run verification tests.",
      ].join("\n");
  }
}

function truncateSummary(text: string, maxLen: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen - 3)}...`;
}
