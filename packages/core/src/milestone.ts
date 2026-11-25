import type { Milestone, MilestoneItem, RunDigestReport, Ticket } from "./types.ts";

export interface PlannedMilestoneItem {
  id: string;
  index: number;
  requirement: string;
  title: string;
  route: MilestoneItem["route"];
  allowedPaths: string[];
}

function stripGlobTail(pattern: string): string {
  return pattern
    .trim()
    .replace(/^\.\//, "")
    .replace(/\/?\*\*?(\/.*)?$/, "")
    .replace(/\/+$/, "");
}

/** Conservative overlap check between two allowedPaths sets (empty / "**" overlap everything). */
export function milestonePathsOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  for (const pa of a) {
    const ba = stripGlobTail(pa);
    for (const pb of b) {
      const bb = stripGlobTail(pb);
      if (ba === "" || bb === "") return true;
      if (ba === bb || ba.startsWith(`${bb}/`) || bb.startsWith(`${ba}/`)) return true;
    }
  }
  return false;
}

/**
 * Deterministic topological wave planning: items whose allowedPaths do not overlap any earlier
 * item share wave 0; an overlap puts the later item one wave after its deepest overlapping
 * predecessor and records those predecessors in dependsOnIndices.
 */
export function planMilestoneWaves(planned: PlannedMilestoneItem[]): MilestoneItem[] {
  const ordered = [...planned].sort((x, y) => x.index - y.index);
  const out: MilestoneItem[] = [];
  for (const item of ordered) {
    const dependsOnIndices: number[] = [];
    let waveIndex = 0;
    for (const prior of out) {
      if (milestonePathsOverlap(item.allowedPaths, prior.allowedPaths)) {
        dependsOnIndices.push(prior.index);
        waveIndex = Math.max(waveIndex, prior.waveIndex + 1);
      }
    }
    out.push({
      id: item.id,
      index: item.index,
      requirement: item.requirement,
      title: item.title,
      route: item.route,
      waveIndex,
      allowedPaths: item.allowedPaths,
      dependsOnIndices,
      status: "pending",
    });
  }
  return out;
}

export function synthesizeMilestoneReleaseNotes(input: {
  milestone: Milestone;
  tickets: Ticket[];
  digest?: RunDigestReport;
}): { releaseNotesZh: string; releaseNotesEn: string; digestSummary: string } {
  const { milestone, tickets, digest } = input;
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const waves = new Map<number, MilestoneItem[]>();
  for (const item of milestone.items) {
    const list = waves.get(item.waveIndex) ?? [];
    list.push(item);
    waves.set(item.waveIndex, list);
  }
  const waveKeys = [...waves.keys()].sort((a, b) => a - b);
  const delivered = milestone.items.filter((i) => i.status === "delivered");
  const version = milestone.targetVersion ? ` v${milestone.targetVersion}` : "";

  const renderItem = (item: MilestoneItem, lang: "zh" | "en"): string => {
    const ticket = byId.get(item.epicId ?? item.ticketId ?? "");
    const summary = ticket?.handoverDigest?.summary ?? item.summary ?? "";
    const risk = ticket?.riskAssessment;
    const riskText = risk
      ? lang === "zh"
        ? `风险 ${risk.score} (${risk.level})`
        : `risk ${risk.score} (${risk.level})`
      : "";
    const files = ticket?.handoverDigest?.changedFiles.length;
    const filesText = files ? (lang === "zh" ? `${files} 个文件` : `${files} file(s)`) : "";
    const meta = [riskText, filesText].filter(Boolean).join(" · ");
    return `- ${item.title}${meta ? ` — ${meta}` : ""}${
      summary ? `\n  ${summary.replace(/\n+/g, " ").slice(0, 300)}` : ""
    }`;
  };

  const section = (lang: "zh" | "en"): string =>
    waveKeys
      .map((w) => {
        const items = (waves.get(w) ?? []).filter((i) => i.status === "delivered");
        if (items.length === 0) return "";
        const head = lang === "zh" ? `### 第 ${w + 1} 波` : `### Wave ${w + 1}`;
        return `${head}\n${items.map((i) => renderItem(i, lang)).join("\n")}`;
      })
      .filter(Boolean)
      .join("\n\n");

  const ts = digest?.ticketSummary;
  const telemetryZh = digest
    ? `\n\n### 运行遥测\n- 工单: ${ts?.delivered}/${ts?.total} 已交付, 成本 $${ts?.totalCostUsd.toFixed(2)}\n- 增量门禁: ${digest.gateSavings.scopedRuns} 次, 节省 ${Math.round(digest.gateSavings.totalSavedMs / 1000)}s\n- 自托管: 金丝雀通过 ${digest.selfHost.canaryPassed}, 重载 ${digest.selfHost.reloadsCompleted}, 回滚 ${digest.selfHost.canaryRolledBack}`
    : "";
  const telemetryEn = digest
    ? `\n\n### Run Telemetry\n- Tickets: ${ts?.delivered}/${ts?.total} delivered, cost $${ts?.totalCostUsd.toFixed(2)}\n- Scoped gate: ${digest.gateSavings.scopedRuns} run(s), saved ${Math.round(digest.gateSavings.totalSavedMs / 1000)}s\n- Self-host: canary passed ${digest.selfHost.canaryPassed}, reloads ${digest.selfHost.reloadsCompleted}, rollbacks ${digest.selfHost.canaryRolledBack}`
    : "";

  const releaseNotesZh = `## ${milestone.name}${version} 发布说明\n\n共交付 ${delivered.length}/${milestone.items.length} 项。\n\n${section("zh")}${telemetryZh}\n`;
  const releaseNotesEn = `## ${milestone.name}${version} Release Notes\n\n${delivered.length}/${milestone.items.length} item(s) delivered.\n\n${section("en")}${telemetryEn}\n`;
  const digestSummary = `${delivered.length}/${milestone.items.length} delivered across ${waveKeys.length} wave(s)${
    ts ? `; cost $${ts.totalCostUsd.toFixed(2)}` : ""
  }`;
  return { releaseNotesZh, releaseNotesEn, digestSummary };
}
