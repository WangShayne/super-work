import type {
  CampaignDirection,
  GoalCampaign,
  GoalCampaignWave,
} from "./types.ts";

/**
 * Extracts a numeric metric from command stdout/stderr.
 * Priority:
 *  1. Explicit `metricRegex` (capture group 1 if present, else full match), taking last match.
 *  2. `SUPER_WORK_METRIC=<number>` marker, taking last match.
 *  3. Last finite number token found in the output.
 */
export function parseMetricValueFromOutput(
  rawOutput: string,
  metricRegex?: string,
): number | null {
  const text = rawOutput.trim();
  if (!text) return null;

  if (metricRegex?.trim()) {
    try {
      const re = new RegExp(metricRegex.trim(), "g");
      let lastVal: number | null = null;
      for (const m of text.matchAll(re)) {
        const candidate = (m[1] ?? m[0] ?? "").trim();
        const num = Number(candidate);
        if (Number.isFinite(num)) {
          lastVal = num;
        }
      }
      if (lastVal !== null) return lastVal;
    } catch {
      // Fall back to standard extractors on invalid user regex
    }
  }

  const markerMatches = Array.from(
    text.matchAll(/SUPER_WORK_METRIC\s*[:=]\s*([+-]?\d+(?:\.\d+)?)/gi),
  );
  if (markerMatches.length > 0) {
    const val = Number(markerMatches.at(-1)![1]);
    if (Number.isFinite(val)) return val;
  }

  const numberMatches = Array.from(text.matchAll(/([+-]?\d+(?:\.\d+)?)/g));
  for (let i = numberMatches.length - 1; i >= 0; i--) {
    const num = Number(numberMatches[i]![1]);
    if (Number.isFinite(num)) return num;
  }

  return null;
}

export function evaluateMetricDelta(
  before: number,
  measured: number,
  direction: CampaignDirection,
  epsilon = 1e-9,
): { delta: number; outcome: "improved" | "regressed" | "unchanged" } {
  const rawDelta = measured - before;
  if (Math.abs(rawDelta) <= epsilon) {
    return { delta: 0, outcome: "unchanged" };
  }
  const improved = direction === "increase" ? rawDelta > epsilon : rawDelta < -epsilon;
  return {
    delta: Number(rawDelta.toFixed(6)),
    outcome: improved ? "improved" : "regressed",
  };
}

export function isCampaignTargetMet(
  value: number,
  target: number,
  direction: CampaignDirection,
  epsilon = 1e-9,
): boolean {
  return direction === "increase"
    ? value >= target - epsilon
    : value <= target + epsilon;
}

export function buildCampaignWavePrompt(input: {
  campaign: GoalCampaign;
  waveNumber: number;
  waves: GoalCampaignWave[];
  preProbeSummary?: string;
}): string {
  const { campaign, waveNumber, waves, preProbeSummary } = input;
  const unitSuffix = campaign.metricUnit ? ` ${campaign.metricUnit}` : "";
  const dirLabel = campaign.direction === "increase" ? "INCREASE (higher is better)" : "DECREASE (lower is better)";

  const improvedLines = waves
    .filter((w) => w.status === "improved")
    .slice(-4)
    .map(
      (w) =>
        `- Wave ${w.waveNumber}: ${w.beforeValue} -> ${w.measuredValue ?? w.beforeValue} (delta=${w.delta ?? 0}) :: ${w.summary}`,
    );

  const failedOrRegressed = waves
    .filter((w) => w.status === "regressed" || w.status === "unchanged" || w.status === "failed")
    .slice(-5)
    .map(
      (w) =>
        `- Wave ${w.waveNumber} [${w.status.toUpperCase()}${w.rolledBack ? ", ROLLED BACK" : ""}]: before=${w.beforeValue}, measured=${w.measuredValue ?? "N/A"} :: ${w.summary}`,
    );

  return [
    `# Goal-Driven Campaign: ${campaign.name} (Wave #${waveNumber}/${campaign.maxIterations})`,
    "",
    `## Objective`,
    campaign.goalPrompt,
    "",
    `## Quantitative Metric Contract`,
    `- Metric Command: \`${campaign.metricCommand}\``,
    `- Optimization Direction: ${dirLabel}`,
    `- Baseline Metric: ${campaign.baselineValue ?? "N/A"}${unitSuffix}`,
    `- Current Metric: ${campaign.currentValue ?? campaign.baselineValue ?? "N/A"}${unitSuffix}`,
    `- Target Metric: ${campaign.targetValue}${unitSuffix}`,
    `- Target Branch: ${campaign.deliveryMode === "staging_branch" ? (campaign.stagingBranch ?? "staging") : "baseBranch"}`,
    "",
    improvedLines.length > 0
      ? `## Previous Successful Improvements (Keep Preserved)\n${improvedLines.join("\n")}`
      : "",
    failedOrRegressed.length > 0
      ? `## Prior Pitfalls / Rolled-Back Attempts (DO NOT REPEAT)\n${failedOrRegressed.join("\n")}`
      : "",
    preProbeSummary ? `## Repo Context Probe\n${preProbeSummary}` : "",
    "",
    `## Wave Execution Discipline`,
    `Make ONE clean, focused incremental change that strictly moves the metric toward ${campaign.targetValue}${unitSuffix} while keeping all existing tests passing. Avoid broad speculative rewrites; regressions will automatically reset the campaign branch.`,
  ]
    .filter(Boolean)
    .join("\n");
}
