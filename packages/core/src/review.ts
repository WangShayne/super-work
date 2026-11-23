import type {
  ReviewFinding,
  ReviewReport,
  ReviewSeverity,
  WorkerEngineId,
} from "./types.ts";

const VALID_SEVERITIES = new Set<ReviewSeverity>(["blocker", "major", "nit"]);

function normalizeSeverity(raw: unknown): ReviewSeverity {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "critical" || s === "high" || s === "error") return "blocker";
  if (s === "medium" || s === "warning" || s === "warn") return "major";
  if (s === "low" || s === "info" || s === "minor" || s === "style") return "nit";
  if (VALID_SEVERITIES.has(s as ReviewSeverity)) {
    return s as ReviewSeverity;
  }
  return "major";
}

function normalizeFilePath(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw.trim().replace(/^[ab]\//, "").replace(/^\.\//, "");
  return cleaned || undefined;
}

function normalizeFinding(raw: unknown): ReviewFinding | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const message = String(obj.message ?? obj.issue ?? obj.description ?? "").trim();
  if (!message) return null;

  const lineRaw = obj.line;
  const parsedLine =
    typeof lineRaw === "number" && Number.isFinite(lineRaw) && lineRaw > 0
      ? Math.floor(lineRaw)
      : typeof lineRaw === "string" && /^\d+$/.test(lineRaw.trim())
        ? Number.parseInt(lineRaw.trim(), 10)
        : undefined;

  const suggestion =
    typeof obj.suggestion === "string" && obj.suggestion.trim()
      ? obj.suggestion.trim()
      : undefined;

  return {
    severity: normalizeSeverity(obj.severity),
    file: normalizeFilePath(obj.file ?? obj.path),
    line: parsedLine,
    message,
    suggestion,
  };
}

function tryExtractJsonFindings(text: string): {
  findings: ReviewFinding[];
  explicitVerdict?: "approved" | "changes_requested";
} | null {
  const candidates: string[] = [];

  // 1. Fenced JSON blocks
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of text.matchAll(fenceRe)) {
    if (match[1]?.trim()) {
      candidates.push(match[1].trim());
    }
  }

  // 2. Top-level JSON object fallback if text contains "findings"
  if (candidates.length === 0 && text.includes("findings")) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      candidates.push(text.slice(start, end + 1));
    }
  }

  for (const rawJson of candidates) {
    try {
      const parsed = JSON.parse(rawJson) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object") continue;

      const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
      const findings = rawFindings
        .map(normalizeFinding)
        .filter((f): f is ReviewFinding => f !== null);

      const vRaw = String(parsed.verdict ?? "").trim().toLowerCase();
      const explicitVerdict =
        vRaw === "approved"
          ? "approved"
          : vRaw === "rejected" || vRaw === "changes_requested"
            ? "changes_requested"
            : undefined;

      if (findings.length > 0 || explicitVerdict) {
        return { findings, explicitVerdict };
      }
    } catch {
      // Ignore invalid JSON snippet
    }
  }

  return null;
}

function tryExtractTagFindings(text: string): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const tagRe =
    /(?:^|\n)\s*[-*]?\s*\[(BLOCKER|MAJOR|NIT)\]\s*(?:([^\s:()`]+?)(?::(\d+))?\s*[-—:]\s*)?(.+)/gi;
  for (const match of text.matchAll(tagRe)) {
    const severity = normalizeSeverity(match[1]);
    const file = normalizeFilePath(match[2]);
    const line = match[3] ? Number.parseInt(match[3], 10) : undefined;
    const message = (match[4] ?? "").trim();
    if (!message) continue;
    findings.push({ severity, file, line, message });
  }
  return findings;
}

export function parseReviewReport(input: {
  summary: string;
  textChunks?: string;
  structuredOutput?: {
    approved?: boolean;
    feedback?: string;
    reviewFindings?: ReviewFinding[];
  };
  engine: WorkerEngineId;
}): ReviewReport {
  const combinedText = [input.textChunks, input.summary].filter(Boolean).join("\n");
  let findings: ReviewFinding[] = [];
  let explicitVerdict: "approved" | "changes_requested" | undefined;

  if (Array.isArray(input.structuredOutput?.reviewFindings)) {
    findings = input.structuredOutput.reviewFindings
      .map(normalizeFinding)
      .filter((f): f is ReviewFinding => f !== null);
  }

  if (findings.length === 0) {
    const fromJson = tryExtractJsonFindings(combinedText);
    if (fromJson) {
      findings = fromJson.findings;
      explicitVerdict = fromJson.explicitVerdict;
    }
  }

  if (findings.length === 0) {
    findings = tryExtractTagFindings(combinedText);
  }

  const hasBlockingFinding = findings.some(
    (f) => f.severity === "blocker" || f.severity === "major",
  );

  let verdict: "approved" | "changes_requested";
  if (hasBlockingFinding) {
    verdict = "changes_requested";
  } else if (findings.length > 0) {
    // Nit-only findings do not block advancement; preserved as advisory review notes
    verdict = "approved";
  } else if (typeof input.structuredOutput?.approved === "boolean") {
    verdict = input.structuredOutput.approved ? "approved" : "changes_requested";
  } else if (explicitVerdict) {
    verdict = explicitVerdict;
  } else {
    const textRejected = /verdict:\s*[*_`]*\s*(rejected|changes_requested)/i.test(
      combinedText,
    );
    verdict = textRejected ? "changes_requested" : "approved";
  }

  if (verdict === "changes_requested" && findings.length === 0) {
    const fallbackMessage =
      input.structuredOutput?.feedback?.trim() ||
      input.summary
        .replace(/verdict:\s*[*_`]*\s*(rejected|changes_requested)\s*-?/gi, "")
        .trim() ||
      "Code review requested changes.";
    findings.push({
      severity: "major",
      message: fallbackMessage,
    });
  }

  return {
    verdict,
    summary: input.summary,
    findings,
    reviewedByEngine: input.engine,
    createdAt: new Date().toISOString(),
  };
}

export function formatBlockingFindingsForRework(findings: ReviewFinding[]): string {
  const blocking = findings.filter(
    (f) => f.severity === "blocker" || f.severity === "major",
  );
  if (blocking.length === 0) {
    return "Address code review feedback cleanly.";
  }
  return blocking
    .map((f) => {
      const loc = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ""}` : "";
      const sug = f.suggestion ? ` (Suggestion: ${f.suggestion})` : "";
      return `- [${f.severity.toUpperCase()}]${loc}: ${f.message}${sug}`;
    })
    .join("\n");
}

export function formatNitSummary(findings: ReviewFinding[]): string {
  const nits = findings.filter((f) => f.severity === "nit");
  if (nits.length === 0) return "";
  return nits
    .map((f) => {
      const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
      return `[NIT]${loc} ${f.message}`;
    })
    .join("; ");
}
