import type { WorkerEngineId } from "./engine.ts";

export interface ReviewEvidencePacket {
  baseBranch: string;
  diffStat: string;
  changedFiles: string[];
  gatePassed: boolean;
  gateCommands: string[];
  gateDurationMs?: number;
  gateSummary: string;
  refactorParity?: {
    targetFile: string;
    lineCountBefore?: number;
    lineCountAfter: number;
    maxLines: number;
    exportsPreserved: boolean;
    migratedSymbolsCount: number;
    newModuleFiles: string[];
    symbolMigrationSummary?: string;
  };
}

export interface RefactorGuardConfig {
  targetHotspotPath?: string;
  maxLinesAfter?: number;
  enforceExportParity?: boolean;
}

export type ReviewSeverity = "blocker" | "major" | "nit";

export interface ReviewFinding {
  severity: ReviewSeverity;
  file?: string;
  line?: number;
  message: string;
  suggestion?: string;
}

export interface ReviewReport {
  verdict: "approved" | "changes_requested";
  summary: string;
  findings: ReviewFinding[];
  reviewedByEngine: WorkerEngineId;
  createdAt: string;
}

export interface RevertResult {
  ok: boolean;
  revertCommitSha?: string;
  conflictFiles?: string[];
  error?: string;
}

export type DeliveryGatePolicy = "always_auto" | "risk_gated" | "always_signoff";

export interface RiskFactor {
  key: string;
  label: string;
  delta: number;
  detail?: string;
}

export interface TicketRiskAssessment {
  score: number;
  level: "low" | "medium" | "high";
  requiresSignoff: boolean;
  threshold: number;
  policy: DeliveryGatePolicy;
  factors: RiskFactor[];
  evaluatedAt: string;
}

export type ReviewCommentAuthor = "human" | "ai";

export type ReviewCommentStatus = "open" | "resolved" | "dismissed";

export interface TicketReviewComment {
  id: string;
  ticketId: string;
  repoId: string;
  filePath: string;
  line: number;
  side?: "new" | "old";
  codeSnippet?: string;
  author: ReviewCommentAuthor;
  severity?: ReviewSeverity;
  body: string;
  status: ReviewCommentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SubmitReviewCommentsInput {
  mode: "comment_only" | "request_changes";
  comments?: Array<{
    filePath: string;
    line: number;
    side?: "new" | "old";
    codeSnippet?: string;
    severity?: ReviewSeverity;
    body: string;
  }>;
  statusUpdates?: Array<{
    id: string;
    status: ReviewCommentStatus;
  }>;
  summaryNote?: string;
}
