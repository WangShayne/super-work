import type {
  CasebookEntry,
  PipelineTemplateId,
  PlaybookEntry,
  RepoConfig,
  SpecClarificationQuestion,
  SpecClarificationResult,
} from "./types.ts";

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "when",
  "then",
  "should",
  "must",
  "need",
  "add",
  "fix",
  "update",
  "create",
  "implement",
  "make",
  "support",
  "check",
  "test",
  "file",
  "files",
  "code",
]);

function extractSearchTokens(text: string): string[] {
  const ascii = text
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  const cjk = text.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  return Array.from(new Set([...ascii, ...cjk])).slice(0, 20);
}

function parseStructurePaths(repoStructure?: string): string[] {
  if (!repoStructure?.trim()) return [];
  const paths: string[] = [];
  for (const rawLine of repoStructure.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("Root") || line.startsWith("Top")) {
      continue;
    }
    const cleaned = line
      .replace(/^[-*•\d.)\s]+/, "")
      .replace(/\s+\(.*\)$/, "")
      .trim();
    if (!cleaned || cleaned.includes(" ")) continue;
    paths.push(cleaned.replace(/^\.?\//, ""));
  }
  return Array.from(new Set(paths));
}

function toScopePattern(pathStr: string): string {
  const clean = pathStr.replace(/^\.?\//, "").replace(/\/+$/, "");
  if (!clean) return "**";
  if (clean.includes("*")) return clean;
  const segments = clean.split("/");
  const last = segments[segments.length - 1] ?? "";
  if (last.includes(".") && segments.length >= 2) {
    return `${segments.slice(0, -1).join("/")}/**`;
  }
  if (!last.includes(".")) {
    return `${clean}/**`;
  }
  return clean;
}

export function buildHeuristicSpecClarification(input: {
  repo: RepoConfig;
  title: string;
  description: string;
  defaultTemplate?: PipelineTemplateId;
  repoStructure?: string;
  casebookEntries?: CasebookEntry[];
  playbookEntries?: PlaybookEntry[];
}): SpecClarificationResult {
  const combined = `${input.title}\n${input.description}`.trim();
  const lower = combined.toLowerCase();
  const tokens = extractSearchTokens(combined);
  const structurePaths = parseStructurePaths(input.repoStructure);

  // Also capture explicit path literals mentioned directly in user prompt
  const explicitMatches =
    combined.match(/(?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.*-]+/g)?.map((p) => p.replace(/^\.\//, "")) ??
    [];

  const scoredPaths: Array<{ path: string; score: number }> = [];
  for (const p of structurePaths) {
    const pl = p.toLowerCase();
    let score = 0;
    for (const tok of tokens) {
      if (pl.includes(tok)) score += 2;
    }
    if (explicitMatches.some((em) => pl.includes(em.toLowerCase()) || em.toLowerCase().includes(pl))) {
      score += 4;
    }
    if (score > 0) scoredPaths.push({ path: p, score });
  }
  scoredPaths.sort((a, b) => b.score - a.score);

  const matchedFiles = Array.from(
    new Set([
      ...explicitMatches.slice(0, 6),
      ...scoredPaths.slice(0, 8).map((s) => s.path),
    ]),
  ).slice(0, 8);

  const matchedCases = (input.casebookEntries ?? [])
    .map((entry) => {
      const hay = `${entry.title} ${entry.goalSummary} ${entry.changedFiles.join(" ")}`.toLowerCase();
      const score = tokens.reduce((acc, tok) => (hay.includes(tok) ? acc + 1 : acc), 0);
      return { entry, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  const suggestedScopes = Array.from(
    new Set([
      ...explicitMatches.map(toScopePattern),
      ...scoredPaths.slice(0, 4).map((s) => toScopePattern(s.path)),
      ...matchedCases.flatMap((c) => c.entry.scopePaths).filter((s) => s !== "**"),
    ]),
  ).slice(0, 5);

  const suggestedAllowedPaths = suggestedScopes.length > 0 ? suggestedScopes : ["**"];

  // Complexity estimation: Epic vs Single Ticket
  const topLevelBuckets = new Set(
    suggestedAllowedPaths
      .filter((s) => s !== "**")
      .map((s) => s.split("/").slice(0, 2).join("/")),
  );
  const hasMultiStepFormat =
    /(?:^|\n)\s*(?:\d+\.|[-*])\s+\S+/m.test(input.description) &&
    (input.description.match(/(?:^|\n)\s*(?:\d+\.|[-*])\s+\S+/gm)?.length ?? 0) >= 3;
  const mentionsCrossModule =
    /(?:全栈|端到端|前后端|重构|epic|multi-?module|across|both\s+api\s+and\s+ui)/i.test(lower);
  const recommendedDispatchMode: "single" | "epic" =
    topLevelBuckets.size >= 3 || hasMultiStepFormat || mentionsCrossModule ? "epic" : "single";

  // Recommended pipeline template
  let recommendedTemplate: PipelineTemplateId =
    input.defaultTemplate ?? input.repo.defaultTemplate ?? "standard";
  if (/(?:typo|copy|readme|docs|comment|rename|文案|注释|文档)/i.test(lower)) {
    recommendedTemplate = "fast";
  } else if (
    /(?:auth|security|secret|token|payment|billing|migration|schema|permission|沙盒|鉴权|安全|迁移)/i.test(
      lower,
    )
  ) {
    recommendedTemplate = "strict";
  }

  const verificationHint =
    input.repo.verificationCommands && input.repo.verificationCommands.length > 0
      ? `Pass repo verification commands: ${input.repo.verificationCommands.join(" && ")}`
      : "Pass typecheck and automated unit/integration tests for modified modules";

  const acceptanceCriteria: string[] = [
    `Implement requested behavior for "${input.title.trim() || "task"}" strictly within authorized paths`,
    verificationHint,
  ];
  if (input.repo.smokeCheck?.enabled) {
    acceptanceCriteria.push(
      `Pass runtime smoke${input.repo.smokeCheck.browserCheck?.enabled ? " & headless browser UI" : ""} checks cleanly`,
    );
  }
  const relevantRule = (input.playbookEntries ?? []).find((e) => e.enabled && !e.suspect);
  if (relevantRule) {
    acceptanceCriteria.push(`Respect repo playbook constraint: ${relevantRule.rule.slice(0, 110)}`);
  }

  // Up to 3 concise clarification questions with recommended option first
  const questions: SpecClarificationQuestion[] = [];
  const scopeDesc = suggestedAllowedPaths.join(", ");
  questions.push({
    id: "scope_boundary",
    question: "确认变更影响范围（Mandate allowedPaths）与拆单策略：",
    options: [
      `聚焦推荐范围 (${scopeDesc})，按 ${recommendedDispatchMode === "epic" ? "Epic 多子任务" : "单工单"} 执行`,
      "放宽至全仓库 (**)，允许跨模块顺带重构",
      `严格锁定单一目录 (${suggestedAllowedPaths[0] ?? "src/**"})，禁止修改其余模块`,
    ],
    recommendedIndex: 0,
  });

  if (input.description.trim().length < 80 || !/(?:test|测试|spec|verify|验收)/i.test(lower)) {
    questions.push({
      id: "verification_depth",
      question: "补充验收深度要求：",
      options: [
        "补齐对应单元测试与边界校验，确保现有测试与类型检查全绿",
        "高风险核心逻辑：追加端到端集成测试并采用 Strict 严格审查流",
        "轻量快速交付：保持最小改动与快速验证通过即可",
      ],
      recommendedIndex: 0,
    });
  }

  if (matchedCases.length > 0) {
    questions.push({
      id: "historical_pattern",
      question: `检测到相似历史判例「${matchedCases[0]!.entry.title}」，如何复用既有实现模式？`,
      options: [
        `延续历史判例模式与文件组织（${matchedCases[0]!.entry.scopePaths.join(", ")}）`,
        "引入全新重构设计，不沿用历史实现约束",
      ],
      recommendedIndex: 0,
    });
  }

  const rationaleParts = [
    `Scanned ${structurePaths.length} workspace path hints`,
    matchedFiles.length > 0 ? `matched ${matchedFiles.length} path(s)` : "no narrow path match (fallback **)",
    matchedCases.length > 0 ? `recalled ${matchedCases.length} prior Casebook case(s)` : "no matching Casebook hits",
    `recommended ${recommendedDispatchMode}/${recommendedTemplate}`,
  ];

  return {
    ready: true,
    recommendedDispatchMode,
    recommendedTemplate,
    refinedTitle: input.title.trim(),
    refinedDescription: input.description.trim(),
    suggestedAllowedPaths,
    acceptanceCriteria,
    matchedFiles,
    matchedCaseTitles: matchedCases.map((c) => c.entry.title),
    questions: questions.slice(0, 3),
    rationale: rationaleParts.join(" · "),
  };
}

export function applyClarificationAnswers(
  spec: SpecClarificationResult,
  answers?: Record<string, string>,
): SpecClarificationResult {
  if (!answers || Object.keys(answers).length === 0) {
    return spec;
  }

  const notes: string[] = [];
  let nextPaths = [...spec.suggestedAllowedPaths];
  let nextTemplate = spec.recommendedTemplate;
  const nextCriteria = [...spec.acceptanceCriteria];

  for (const [qid, rawAns] of Object.entries(answers)) {
    const ans = String(rawAns ?? "").trim();
    if (!ans) continue;
    notes.push(`- [${qid}] ${ans}`);
    if (ans.includes("(**)") || ans.includes("全仓库")) {
      nextPaths = ["**"];
    }
    if (/strict|严格/i.test(ans)) {
      nextTemplate = "strict";
    } else if (/轻量快速|fast/i.test(ans)) {
      nextTemplate = "fast";
    }
    if (!nextCriteria.includes(ans)) {
      nextCriteria.push(`Clarified requirement (${qid}): ${ans}`);
    }
  }

  const marker = "## Clarified Spec Decisions";
  const baseDesc = spec.refinedDescription.split(marker)[0]?.trim() ?? spec.refinedDescription;
  const refinedDescription =
    notes.length > 0 ? `${baseDesc}\n\n${marker}\n${notes.join("\n")}` : spec.refinedDescription;

  return {
    ...spec,
    recommendedTemplate: nextTemplate,
    suggestedAllowedPaths: nextPaths,
    refinedDescription,
    acceptanceCriteria: nextCriteria.slice(0, 8),
  };
}
