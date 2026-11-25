import { matchesPathScope } from "./mandate.ts";
import type {
  DeliveryGatePolicy,
  RepoConfig,
  ReviewReport,
  RiskFactor,
  SmokeCheckResult,
  Ticket,
  TicketRiskAssessment,
} from "./types.ts";
import { nowIso } from "./utils.ts";

export const DEFAULT_SENSITIVE_PATHS: readonly string[] = [
  "**/auth/**",
  "*auth*",
  "*security*",
  "*secret*",
  "*token*",
  "*migration*",
  "**/migrations/**",
  "package.json",
  "super-work.json",
];

export const DEFAULT_RISK_THRESHOLD = 35;

export interface EvaluateTicketRiskInput {
  ticket: Ticket;
  repo?: RepoConfig;
  changedFiles: string[];
  addedLines?: number;
  deletedLines?: number;
  maxVisualDiffRatio?: number;
  reviewReport?: ReviewReport;
  smokeResult?: SmokeCheckResult;
  staticVerificationPassed?: boolean;
  hotspotFiles?: Array<{ filePath: string; lineCount: number }>;
}

export function resolveEffectiveDeliveryGatePolicy(
  ticket: Ticket,
  repo?: RepoConfig,
): DeliveryGatePolicy {
  return ticket.deliveryGatePolicy ?? repo?.deliveryGatePolicy ?? "always_auto";
}

export function resolveEffectiveRiskThreshold(
  ticket: Ticket,
  repo?: RepoConfig,
): number {
  const raw = ticket.riskThreshold ?? repo?.riskThreshold ?? DEFAULT_RISK_THRESHOLD;
  if (!Number.isFinite(raw)) return DEFAULT_RISK_THRESHOLD;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

export function evaluateTicketRisk(input: EvaluateTicketRiskInput): TicketRiskAssessment {
  const { ticket, repo, changedFiles } = input;
  const factors: RiskFactor[] = [];
  let rawScore = 10;

  const added = Math.max(0, input.addedLines ?? 0);
  const deleted = Math.max(0, input.deletedLines ?? 0);
  const totalLines = added + deleted;

  if (totalLines > 400) {
    rawScore += 28;
    factors.push({ key: "diff_size", label: "Large diff volume", delta: 28, detail: `${totalLines} lines changed` });
  } else if (totalLines > 120) {
    rawScore += 15;
    factors.push({ key: "diff_size", label: "Medium diff volume", delta: 15, detail: `${totalLines} lines changed` });
  } else if (totalLines > 0) {
    rawScore += 4;
    factors.push({ key: "diff_size", label: "Compact diff volume", delta: 4, detail: `${totalLines} lines changed` });
  }

  if (changedFiles.length > 8) {
    rawScore += 14;
    factors.push({ key: "file_spread", label: "Wide multi-file blast radius", delta: 14, detail: `${changedFiles.length} files` });
  } else if (changedFiles.length > 3) {
    rawScore += 6;
    factors.push({ key: "file_spread", label: "Multiple modified files", delta: 6, detail: `${changedFiles.length} files` });
  }

  const sensitivePatterns =
    repo?.sensitivePaths && repo.sensitivePaths.length > 0
      ? repo.sensitivePaths
      : [...DEFAULT_SENSITIVE_PATHS];
  const matchedSensitive = changedFiles.filter((filePath) =>
    matchesPathScope(filePath, sensitivePatterns),
  );
  if (matchedSensitive.length > 0) {
    rawScore += 26;
    factors.push({
      key: "sensitive_paths",
      label: "Sensitive paths touched",
      delta: 26,
      detail: matchedSensitive.slice(0, 4).join(", "),
    });
  }

  const directDeps = ticket.impactSummary?.directDependents.length ?? 0;
  const transitiveDeps = ticket.impactSummary?.transitiveDependents.length ?? 0;
  if (directDeps > 0 || transitiveDeps > 0) {
    const fanoutDelta = Math.min(24, directDeps * 5 + Math.min(8, transitiveDeps) * 2);
    rawScore += fanoutDelta;
    factors.push({
      key: "symbol_fanout",
      label: "Downstream symbol impact fanout",
      delta: fanoutDelta,
      detail: `${directDeps} direct, ${transitiveDeps} transitive`,
    });
  }

  if (input.hotspotFiles && input.hotspotFiles.length > 0) {
    rawScore += 8;
    factors.push({
      key: "hotspot_complexity",
      label: "Oversized hotspot files touched",
      delta: 8,
      detail: input.hotspotFiles
        .slice(0, 3)
        .map((h) => `${h.filePath} (${h.lineCount} lines)`)
        .join(", "),
    });
  }

  if (typeof input.maxVisualDiffRatio === "number" && input.maxVisualDiffRatio > 0.02) {
    rawScore += 18;
    factors.push({
      key: "visual_diff",
      label: "Visual pixel delta above 2%",
      delta: 18,
      detail: `${(input.maxVisualDiffRatio * 100).toFixed(2)}%`,
    });
  }

  if (ticket.stageRetries > 0) {
    const retryDelta = Math.min(16, ticket.stageRetries * 6);
    rawScore += retryDelta;
    factors.push({
      key: "stage_retries",
      label: "Stage retries occurred",
      delta: retryDelta,
      detail: `${ticket.stageRetries} retry(s)`,
    });
  }

  if ((ticket.conflictResolutionCount ?? 0) > 0) {
    rawScore += 12;
    factors.push({
      key: "conflict_resolved",
      label: "3-way merge conflict resolved",
      delta: 12,
      detail: "Post-rebase auto-resolution executed",
    });
  }

  if (ticket.tddMode && (ticket.lockedTestPaths?.length ?? 0) > 0) {
    rawScore -= 8;
    factors.push({
      key: "tdd_guard",
      label: "Red-Green Spec-Test Lock passed",
      delta: -8,
      detail: `${ticket.lockedTestPaths!.length} locked spec test(s)`,
    });
  }

  if (input.staticVerificationPassed) {
    rawScore -= 10;
    factors.push({
      key: "static_verify",
      label: "Verification commands passed",
      delta: -10,
    });
  }

  if (input.smokeResult?.ok) {
    rawScore -= 6;
    factors.push({
      key: "smoke_gate",
      label: "Runtime smoke/CDP gate passed",
      delta: -6,
    });
  }

  if (input.reviewReport) {
    if (input.reviewReport.verdict === "approved" && input.reviewReport.findings.length === 0) {
      rawScore -= 10;
      factors.push({
        key: "review_clean",
        label: "Clean cross-engine review",
        delta: -10,
        detail: `Reviewed by ${input.reviewReport.reviewedByEngine}`,
      });
    } else if (input.reviewReport.findings.length > 0) {
      const findingPenalty = Math.min(18, input.reviewReport.findings.length * 4);
      rawScore += findingPenalty;
      factors.push({
        key: "review_findings",
        label: "Review findings present",
        delta: findingPenalty,
        detail: `${input.reviewReport.findings.length} finding(s)`,
      });
    }
  }

  const score = Math.max(0, Math.min(100, Math.round(rawScore)));
  const level: TicketRiskAssessment["level"] =
    score >= 60 ? "high" : score > 30 ? "medium" : "low";
  const policy = resolveEffectiveDeliveryGatePolicy(ticket, repo);
  const threshold = resolveEffectiveRiskThreshold(ticket, repo);
  const requiresSignoff =
    policy === "always_signoff" || (policy === "risk_gated" && score > threshold);

  return {
    score,
    level,
    requiresSignoff,
    threshold,
    policy,
    factors,
    evaluatedAt: nowIso(),
  };
}
