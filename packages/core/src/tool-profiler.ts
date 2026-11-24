import type {
  StageToolProfile,
  ToolUsageStat,
  WorkerClarificationRequest,
  WorkerStreamEvent,
} from "./types.ts";

interface PendingToolUse {
  toolName: string;
  tsMs: number;
}

export function buildStageToolProfile(events: WorkerStreamEvent[]): StageToolProfile {
  const stats = new Map<string, ToolUsageStat>();
  const pending: PendingToolUse[] = [];
  let totalToolCalls = 0;
  let totalToolErrors = 0;

  const ensureStat = (toolName: string): ToolUsageStat => {
    const clean = toolName.trim() || "tool";
    let existing = stats.get(clean);
    if (!existing) {
      existing = {
        toolName: clean,
        calls: 0,
        errors: 0,
        approxDurationMs: 0,
      };
      stats.set(clean, existing);
    }
    return existing;
  };

  for (const ev of events) {
    if (ev.type === "tool_use") {
      const tsMs = Date.parse(ev.timestamp);
      const cleanName = ev.toolName.trim() || "tool";
      pending.push({ toolName: cleanName, tsMs: Number.isFinite(tsMs) ? tsMs : 0 });
      const row = ensureStat(cleanName);
      row.calls += 1;
      totalToolCalls += 1;
      continue;
    }

    if (ev.type === "tool_result") {
      const resultTs = Date.parse(ev.timestamp);
      let matchedIndex = pending.findIndex((p) => p.toolName === ev.toolName);
      if (matchedIndex === -1 && pending.length > 0) {
        // Claude Code uses tool_use_id (e.g. toolu_...) on tool_result blocks; pair FIFO
        matchedIndex = 0;
      }
      let resolvedName = ev.toolName.trim() || "tool";
      let deltaMs = 0;
      if (matchedIndex >= 0) {
        const [matched] = pending.splice(matchedIndex, 1);
        if (matched) {
          resolvedName = matched.toolName;
          if (Number.isFinite(resultTs) && matched.tsMs > 0) {
            deltaMs = Math.max(0, resultTs - matched.tsMs);
          }
        }
      }

      const row = ensureStat(resolvedName);
      if (row.calls === 0) {
        row.calls = 1;
        totalToolCalls += 1;
      }
      row.approxDurationMs += deltaMs;
      if (ev.isError) {
        row.errors += 1;
        totalToolErrors += 1;
        const snippet = ev.outputSummary.replace(/\s+/g, " ").trim().slice(0, 160);
        if (snippet && !row.sampleError) {
          row.sampleError = snippet;
        }
      }
    }
  }

  const byTool = Array.from(stats.values()).sort(
    (a, b) => b.calls - a.calls || b.errors - a.errors || b.approxDurationMs - a.approxDurationMs,
  );

  return {
    totalToolCalls,
    totalToolErrors,
    byTool,
  };
}

function normalizeClarificationPayload(
  raw: unknown,
): WorkerClarificationRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const question = typeof obj.question === "string" ? obj.question.trim() : "";
  if (!question) return null;

  const rawOptions = Array.isArray(obj.options)
    ? obj.options.map((o) => String(o ?? "").trim()).filter(Boolean)
    : [];
  const options = Array.from(new Set(rawOptions)).slice(0, 5);
  if (options.length < 2) return null;

  const rawRec =
    typeof obj.recommendedOption === "string" ? obj.recommendedOption.trim() : "";
  const recommendedOption =
    rawRec && options.includes(rawRec) ? rawRec : options[0]!;
  const context =
    typeof obj.context === "string" && obj.context.trim()
      ? obj.context.trim().slice(0, 400)
      : undefined;

  return {
    question: question.slice(0, 300),
    options,
    recommendedOption,
    context,
  };
}

function extractBalancedJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return null;
}

export function extractWorkerClarificationRequest(
  eventsOrText: WorkerStreamEvent[] | string,
  structured?: WorkerClarificationRequest,
): WorkerClarificationRequest | null {
  const direct = normalizeClarificationPayload(structured);
  if (direct) return direct;

  const text =
    typeof eventsOrText === "string"
      ? eventsOrText
      : eventsOrText
          .map((ev) => {
            if (ev.type === "text") return ev.text;
            if (ev.type === "completed") return ev.summary;
            return "";
          })
          .filter(Boolean)
          .join("\n");

  const markerIdx = text.indexOf("[ASK_HUMAN]");
  if (markerIdx === -1) return null;
  const tail = text.slice(markerIdx);
  const fenced = tail.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? extractBalancedJsonObject(fenced[1]!) : extractBalancedJsonObject(tail);
  if (!candidate) return null;

  try {
    return normalizeClarificationPayload(JSON.parse(candidate));
  } catch {
    return null;
  }
}
