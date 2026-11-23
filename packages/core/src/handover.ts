import type { HandoverDigest, Ticket } from "./types.ts";

function cleanSignatureLine(line: string, maxLen = 110): string {
  const collapsed = line
    .replace(/\s+/g, " ")
    .replace(/\s*\{\s*$/, "")
    .trim();
  if (collapsed.length <= maxLen) return collapsed;
  return `${collapsed.slice(0, maxLen - 3)}...`;
}

/**
 * Deterministically parses unified diff additions (`+...` lines) to extract
 * newly added/modified exported API symbols and HTTP/RPC/CLI contract lines.
 */
export function extractDiffContracts(diffText: string): {
  exportedSymbols: string[];
  contractSnippets: string[];
} {
  const exportedSymbols: string[] = [];
  const contractSnippets: string[] = [];
  const seenSymbols = new Set<string>();
  const seenContracts = new Set<string>();

  const pushSymbol = (raw: string) => {
    const cleaned = cleanSignatureLine(raw);
    if (!cleaned || seenSymbols.has(cleaned)) return;
    seenSymbols.add(cleaned);
    exportedSymbols.push(cleaned);
  };

  const pushContract = (raw: string) => {
    const cleaned = cleanSignatureLine(raw);
    if (!cleaned || seenContracts.has(cleaned)) return;
    seenContracts.add(cleaned);
    contractSnippets.push(cleaned);
  };

  for (const rawLine of diffText.split("\n")) {
    if (!rawLine.startsWith("+") || rawLine.startsWith("+++ ")) continue;
    const line = rawLine.slice(1).trim();
    if (!line || line.startsWith("//") || line.startsWith("#") || line.startsWith("/*")) {
      continue;
    }

    // TypeScript / JavaScript exports
    if (
      /^export\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|enum)\s+[A-Za-z0-9_$]+/.test(
        line,
      )
    ) {
      pushSymbol(line);
    } else if (/^export\s*\{[^}]+\}/.test(line)) {
      pushSymbol(line);
    } else if (/^(?:async\s+)?def\s+[A-Za-z0-9_]+\s*\(/.test(line) || /^class\s+[A-Za-z0-9_]+/.test(line)) {
      // Python top-level / exported methods & classes
      pushSymbol(line);
    } else if (/^func\s+(?:\([^)]+\)\s*)?[A-Z][A-Za-z0-9_]*\s*\(/.test(line) || /^type\s+[A-Z][A-Za-z0-9_]*\s+/.test(line)) {
      // Go exported funcs and types
      pushSymbol(line);
    } else if (/^pub(?:\([^)]+\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|type)\s+[A-Za-z0-9_]+/.test(line)) {
      // Rust public items
      pushSymbol(line);
    }

    // HTTP routes (Hono, Express, FastAPI, Gin, etc.), schemas, CLI flags
    if (
      /\.(?:get|post|put|patch|delete|options|head)\s*\(\s*["'`][^"'`]+["'`]/.test(line) ||
      /@(?:app|router|blueprint)\.(?:get|post|put|patch|delete|route)\s*\(/.test(line) ||
      /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+[A-Za-z0-9_]+/i.test(line) ||
      /(?:interface|type)\s+\w*(?:Request|Response|Payload|Schema|Config|Input|Output)\b/.test(line) ||
      /--[a-z0-9][a-z0-9-]+/.test(line)
    ) {
      pushContract(line);
    }

    if (exportedSymbols.length >= 12 && contractSnippets.length >= 8) {
      break;
    }
  }

  return {
    exportedSymbols: exportedSymbols.slice(0, 12),
    contractSnippets: contractSnippets.slice(0, 8),
  };
}

export function buildHandoverDigest(input: {
  ticket: Ticket;
  repoName?: string;
  changedFiles: string[];
  diffText: string;
  stageSummary: string;
  version?: number;
  llmRefinement?: {
    summary?: string;
    exportedSymbols?: string[];
    contractSnippets?: string[];
  } | null;
}): HandoverDigest {
  const extracted = extractDiffContracts(input.diffText);
  const exportedSymbols =
    input.llmRefinement?.exportedSymbols && input.llmRefinement.exportedSymbols.length > 0
      ? Array.from(
          new Set([
            ...input.llmRefinement.exportedSymbols.map((s) => cleanSignatureLine(s)),
            ...extracted.exportedSymbols,
          ]),
        ).slice(0, 12)
      : extracted.exportedSymbols;

  const contractSnippets =
    input.llmRefinement?.contractSnippets && input.llmRefinement.contractSnippets.length > 0
      ? Array.from(
          new Set([
            ...input.llmRefinement.contractSnippets.map((s) => cleanSignatureLine(s)),
            ...extracted.contractSnippets,
          ]),
        ).slice(0, 8)
      : extracted.contractSnippets;

  const changedFiles = Array.from(new Set(input.changedFiles.map((f) => f.trim()).filter(Boolean))).slice(
    0,
    24,
  );
  const rawSummary = (input.llmRefinement?.summary?.trim() || input.stageSummary || input.ticket.title)
    .replace(/\s+/g, " ")
    .trim();
  const summary = rawSummary.length <= 360 ? rawSummary : `${rawSummary.slice(0, 357)}...`;
  const repoLabel = input.repoName ? `${input.repoName} · ` : "";

  const lines: string[] = [
    `### [${repoLabel}${input.ticket.id}] ${input.ticket.title}`,
    `- Summary: ${summary}`,
  ];
  if (changedFiles.length > 0) {
    lines.push(`- Changed Files: ${changedFiles.slice(0, 12).join(", ")}`);
  }
  if (exportedSymbols.length > 0) {
    lines.push(`- Exported Symbols:\n  - ${exportedSymbols.slice(0, 10).join("\n  - ")}`);
  }
  if (contractSnippets.length > 0) {
    lines.push(`- Contracts / Routes:\n  - ${contractSnippets.slice(0, 6).join("\n  - ")}`);
  }

  let formattedMarkdown = lines.join("\n");
  if (formattedMarkdown.length > 1200) {
    formattedMarkdown = `${formattedMarkdown.slice(0, 1197)}...`;
  }

  return {
    ticketId: input.ticket.id,
    repoId: input.ticket.repoId,
    repoName: input.repoName,
    title: input.ticket.title,
    summary,
    changedFiles,
    exportedSymbols,
    contractSnippets,
    formattedMarkdown,
    version: input.version ?? 1,
    generatedAt: new Date().toISOString(),
  };
}

export function formatUpstreamHandoversForPrompt(
  digests: HandoverDigest[],
  maxTotalChars = 3200,
): string {
  if (digests.length === 0) return "";
  const blocks: string[] = [];
  let total = 0;

  for (const digest of digests) {
    const rawBlock =
      digest.formattedMarkdown.length <= 1200
        ? digest.formattedMarkdown
        : `${digest.formattedMarkdown.slice(0, 1197)}...`;
    if (blocks.length > 0 && total + rawBlock.length + 2 > maxTotalChars) {
      break;
    }
    const clamped =
      rawBlock.length > maxTotalChars
        ? `${rawBlock.slice(0, Math.max(24, maxTotalChars - 3))}...`
        : rawBlock;
    blocks.push(clamped);
    total += clamped.length + 2;
  }

  return blocks.join("\n\n");
}
