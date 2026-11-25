import type { TicketStatus } from "./pipeline.ts";
import type { TaskBlueprint } from "./repo.ts";
import type { SpillArtifact, StageRun, Thread, Ticket, Trigger } from "./ticket.ts";

export type PlaybookSource = "human" | "auto_healed" | "repo_contract";

export type PlaybookHealthStatus = "healthy" | "stale" | "zombie_path" | "suspect";

export interface PlaybookEntry {
  id: string;
  repoId: string;
  rule: string;
  scopePaths: string[];
  source: PlaybookSource;
  sourceTicketId?: string;
  enabled: boolean;
  pinned: boolean;
  hitCount?: number;
  lastMatchedAt?: string;
  suspect?: boolean;
  healthStatus?: PlaybookHealthStatus;
  prunable?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CasebookEntry {
  id: string;
  repoId: string;
  ticketId: string;
  title: string;
  goalSummary: string;
  solutionSummary: string;
  pitfallsAndFixes?: string;
  changedFiles: string[];
  scopePaths: string[];
  exportedSymbols: string[];
  reverted: boolean;
  hitCount: number;
  lastMatchedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RepoKnowledgeBundle {
  version: 1;
  exportedAt: string;
  sourceRepoName: string;
  playbook: Array<{ rule: string; scopePaths: string[]; pinned: boolean }>;
  casebook: Array<{
    title: string;
    goalSummary: string;
    solutionSummary: string;
    pitfallsAndFixes?: string;
    changedFiles: string[];
    scopePaths: string[];
    exportedSymbols: string[];
    reverted: boolean;
  }>;
  blueprints: TaskBlueprint[];
}

export interface ImportKnowledgeBundleResult {
  importedPlaybook: number;
  importedCasebook: number;
  importedBlueprints: number;
  skippedDuplicates: number;
}

export interface ChainOfRecall {
  trigger: Trigger | null;
  thread: Thread | null;
  ticket: Ticket;
  threadTriggers: Trigger[];
  stageRuns: StageRun[];
  artifacts: SpillArtifact[];
  relatedTickets: Array<{
    ticketId: string;
    title: string;
    status: TicketStatus;
    snippet: string;
  }>;
  matchedCases?: CasebookEntry[];
}

export interface MemorySearchHit {
  entityType: string;
  entityId: string;
  ticketId: string;
  repoId: string;
  title: string;
  snippet: string;
}
