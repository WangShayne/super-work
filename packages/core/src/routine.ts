import type { PipelineTemplateId, RoutineScheduleKind } from "./types.ts";

export interface RoutinePresetTemplate {
  id: string;
  nameZh: string;
  nameEn: string;
  descZh: string;
  descEn: string;
  scheduleKind: RoutineScheduleKind;
  cronExpr?: string;
  intervalMinutes?: number;
  activeHoursStart?: string;
  activeHoursEnd?: string;
  allowedPaths: string[];
  template: PipelineTemplateId;
  maxBudgetUsd: number;
  prompt: string;
}

export const ROUTINE_PRESET_TEMPLATES: RoutinePresetTemplate[] = [
  {
    id: "nightly_test_sweep",
    nameZh: "夜间测试与类型健康巡检",
    nameEn: "Nightly Test & Typecheck Patrol",
    descZh: "定期运行全仓测试与类型检查，无异常静默退出，发现回归时自动修复或生成修复提案。",
    descEn: "Run repository tests and typecheck on schedule. Exits cleanly when healthy; promotes fixes or proposals on failures.",
    scheduleKind: "cron",
    cronExpr: "0 2 * * *",
    activeHoursStart: "23:00",
    activeHoursEnd: "06:00",
    allowedPaths: ["**"],
    template: "standard",
    maxBudgetUsd: 1.5,
    prompt:
      "Run the repository typecheck and test suite to detect regressions, flaky tests, or broken builds. If everything passes cleanly, make no file changes and conclude with `ROUTINE_VERDICT: CLEAN`. Only edit files inside allowedPaths if you find a clear, minimal fix, or report `ROUTINE_VERDICT: ISSUE_FOUND - <summary>`.",
  },
  {
    id: "security_dep_audit",
    nameZh: "依赖安全与过期配置审计",
    nameEn: "Dependency & Config Security Audit",
    descZh: "扫描锁文件、敏感配置误提交与过期包风险，仅在命中高优隐患时告警或修补。",
    descEn: "Audit package manifests, lockfiles, and configuration hygiene. Quietly exits unless actionable risks exist.",
    scheduleKind: "interval",
    intervalMinutes: 720,
    allowedPaths: ["package.json", "packages/*/package.json", "*.md", "src/**", "packages/**"],
    template: "strict",
    maxBudgetUsd: 1.0,
    prompt:
      "Audit dependencies, scripts, and configuration files for known security risks, leaked tokens, or unsafe defaults. Do not perform unnecessary package upgrades. If no issue is found, leave files untouched and finish with `ROUTINE_VERDICT: CLEAN`.",
  },
  {
    id: "doc_contract_drift",
    nameZh: "近期提交与文档/契约漂移校准",
    nameEn: "Recent Commit & Doc/Contract Drift Sync",
    descZh: "检查最近提交是否导致 README / API 文档 / super-work.json 契约与实现脱节并自动校准。",
    descEn: "Verify README, API docs, and super-work.json remain aligned with recent code changes.",
    scheduleKind: "interval",
    intervalMinutes: 360,
    allowedPaths: ["README.md", "README.zh-CN.md", "USAGE.md", "ARCHITECTURE.md", "super-work.json", "docs/**"],
    template: "fast",
    maxBudgetUsd: 0.8,
    prompt:
      "Inspect recent commits and exported interfaces vs README/docs/super-work.json. Only update docs if an API, CLI flag, or architectural contract visibly drifted. Otherwise make zero edits and output `ROUTINE_VERDICT: CLEAN`.",
  },
];

function parseHourMinute(hhmm?: string): number | null {
  if (!hhmm || !hhmm.trim()) return null;
  const match = hhmm.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    return null;
  }
  return hh * 60 + mm;
}

export function isWithinActiveHours(
  now: Date,
  activeHoursStart?: string,
  activeHoursEnd?: string,
): boolean {
  const start = parseHourMinute(activeHoursStart);
  const end = parseHourMinute(activeHoursEnd);
  if (start === null || end === null) {
    return true;
  }
  const current = now.getHours() * 60 + now.getMinutes();
  if (start === end) {
    return true;
  }
  if (start < end) {
    return current >= start && current < end;
  }
  // Overnight wrap-around (e.g., 23:00 -> 06:00)
  return current >= start || current < end;
}

export function matchesCronField(fieldExpr: string, value: number, minVal: number, maxVal: number): boolean {
  const expr = fieldExpr.trim();
  if (!expr) return false;
  if (expr === "*") return true;

  const parts = expr.split(",");
  for (const partRaw of parts) {
    const part = partRaw.trim();
    if (!part) continue;
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart ? Math.max(1, Number(stepPart)) : 1;
    if (!Number.isFinite(step) || step <= 0) continue;

    let rangeStart = minVal;
    let rangeEnd = maxVal;
    if (rangePart && rangePart !== "*") {
      if (rangePart.includes("-")) {
        const [a, b] = rangePart.split("-").map(Number);
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        rangeStart = Math.max(minVal, Math.min(maxVal, a!));
        rangeEnd = Math.max(minVal, Math.min(maxVal, b!));
      } else {
        const single = Number(rangePart);
        if (!Number.isFinite(single)) continue;
        if (!stepPart) {
          if (single === value) return true;
          continue;
        }
        rangeStart = Math.max(minVal, Math.min(maxVal, single));
        rangeEnd = maxVal;
      }
    }

    if (value >= rangeStart && value <= rangeEnd && (value - rangeStart) % step === 0) {
      return true;
    }
  }
  return false;
}

export function matchesCronExpression(cronExpr: string, date: Date): boolean {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minF, hourF, domF, monthF, dowF] = fields;
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const month = date.getMonth() + 1;
  const dow = date.getDay();

  return (
    matchesCronField(minF!, minute, 0, 59) &&
    matchesCronField(hourF!, hour, 0, 23) &&
    matchesCronField(domF!, dom, 1, 31) &&
    matchesCronField(monthF!, month, 1, 12) &&
    matchesCronField(dowF!, dow, 0, 6)
  );
}

export function computeNextRoutineRunAt(
  spec: {
    scheduleKind: RoutineScheduleKind;
    intervalMinutes?: number;
    cronExpr?: string;
  },
  fromDate = new Date(),
): string {
  if (spec.scheduleKind === "cron" && spec.cronExpr?.trim()) {
    const fields = spec.cronExpr.trim().split(/\s+/);
    if (fields.length === 5) {
      // Search minute by minute up to 31 days ahead
      const cursor = new Date(fromDate.getTime());
      cursor.setSeconds(0, 0);
      cursor.setMinutes(cursor.getMinutes() + 1);
      const maxSteps = 60 * 24 * 31;
      for (let i = 0; i < maxSteps; i++) {
        if (matchesCronExpression(spec.cronExpr, cursor)) {
          return cursor.toISOString();
        }
        cursor.setMinutes(cursor.getMinutes() + 1);
      }
    }
  }

  const mins =
    typeof spec.intervalMinutes === "number" && Number.isFinite(spec.intervalMinutes) && spec.intervalMinutes >= 1
      ? Math.floor(spec.intervalMinutes)
      : 360;
  return new Date(fromDate.getTime() + mins * 60_000).toISOString();
}

export function parseRoutineProbeVerdict(
  outputText: string,
  changedFiles: string[],
): { action: "clean" | "promote"; summary: string; isIssueReportOnly: boolean } {
  const cleanSummary = outputText.trim().slice(0, 600);
  if (changedFiles.length > 0) {
    return {
      action: "promote",
      summary: cleanSummary || `Routine produced fixes in ${changedFiles.length} file(s).`,
      isIssueReportOnly: false,
    };
  }

  const issueMatch = outputText.match(/ROUTINE_(?:VERDICT:\s*ISSUE_FOUND|ALERT)\s*[-:]?\s*([^\n]*)/i);
  if (issueMatch) {
    const reason = issueMatch[1]?.trim() || cleanSummary || "Routine probe flagged an issue requiring attention.";
    return {
      action: "promote",
      summary: reason,
      isIssueReportOnly: true,
    };
  }

  return {
    action: "clean",
    summary: cleanSummary || "ROUTINE_VERDICT: CLEAN",
    isIssueReportOnly: false,
  };
}
