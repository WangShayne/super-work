import { describe, expect, it } from "bun:test";
import type { LiveEventLogEntry, StageRun } from "../src/types.ts";
import {
  appendBoundedTicketEvent,
  formatElapsedClock,
  parseKernelLiveEvent,
  summarizeToolInput,
  synthesizeStageRunActivities,
} from "../src/utils/liveStream.ts";
import {
  INITIAL_STARTER_STATE,
  isScaffoldOnlyText,
  reduceStarterComposer,
  type StarterComposerState,
} from "../src/utils/starterComposer.ts";

const SCAFFOLDS = ["Bug:\n- ", "Feature:\n- ", "Refactor:\n- ", "v1.0.0\n- "];
const reduce = (s: StarterComposerState, a: Parameters<typeof reduceStarterComposer>[1]) =>
  reduceStarterComposer(s, a, SCAFFOLDS);

describe("starterComposer", () => {
  it("detects scaffold-only text", () => {
    expect(isScaffoldOnlyText("  ", SCAFFOLDS)).toBe(true);
    expect(isScaffoldOnlyText("Bug:\n- ", SCAFFOLDS)).toBe(true);
    expect(isScaffoldOnlyText("- \n- \n- ", SCAFFOLDS)).toBe(true);
    expect(isScaffoldOnlyText("fix login", SCAFFOLDS)).toBe(false);
  });

  it("release starter with an empty scaffold enters release mode and keeps the box empty", () => {
    const rel = reduceStarterComposer(INITIAL_STARTER_STATE, { type: "toggle", id: "release", scaffold: "" }, [
      "Bug:\n- ",
      "Feature:\n- ",
      "Refactor:\n- ",
      "",
    ]);
    expect(rel.releaseMode && rel.optionsOpen).toBe(true);
    expect(rel.text.trim()).toBe("");
  });

  it("toggles on then off, clearing scaffold text", () => {
    const on = reduce(INITIAL_STARTER_STATE, { type: "toggle", id: "bug", scaffold: SCAFFOLDS[0]! });
    expect(on.activeStarter).toBe("bug");
    expect(on.text).toBe(SCAFFOLDS[0]);
    const off = reduce(on, { type: "toggle", id: "bug", scaffold: SCAFFOLDS[0]! });
    expect(off.activeStarter).toBeNull();
    expect(off.text).toBe("");
  });

  it("keeps custom text on cancel and prepends scaffold on activate", () => {
    const typed = reduce(INITIAL_STARTER_STATE, { type: "text", value: "login 500s" });
    const on = reduce(typed, { type: "toggle", id: "bug", scaffold: "Bug:" });
    expect(on.text).toBe("Bug:\n\nlogin 500s");
    const off = reduce(on, { type: "toggle", id: "bug", scaffold: "Bug:" });
    expect(off.text).toBe("Bug:\n\nlogin 500s");
  });

  it("switches starters and resets release state", () => {
    const rel = reduce(INITIAL_STARTER_STATE, { type: "toggle", id: "release", scaffold: SCAFFOLDS[3]! });
    expect(rel.releaseMode && rel.optionsOpen).toBe(true);
    const withVer = reduce(rel, { type: "version", value: "v1.2.3" });
    const sw = reduce(withVer, { type: "toggle", id: "feature", scaffold: SCAFFOLDS[1]! });
    expect(sw.activeStarter).toBe("feature");
    expect(sw.releaseMode).toBe(false);
    expect(sw.version).toBe("");
    expect(sw.optionsOpen).toBe(false);
    expect(sw.text).toBe(SCAFFOLDS[1]);
  });

  it("cancelling release unlocks release mode but keeps options with custom values", () => {
    const rel = reduce({ ...INITIAL_STARTER_STATE, hasCustomOptions: true }, {
      type: "toggle",
      id: "release",
      scaffold: SCAFFOLDS[3]!,
    });
    const off = reduce(rel, { type: "toggle", id: "release", scaffold: SCAFFOLDS[3]! });
    expect(off.releaseMode).toBe(false);
    expect(off.text).toBe("");
    expect(off.optionsOpen).toBe(true);
    const plain = reduce(INITIAL_STARTER_STATE, { type: "toggle", id: "release", scaffold: SCAFFOLDS[3]! });
    expect(reduce(plain, { type: "toggle", id: "release", scaffold: SCAFFOLDS[3]! }).optionsOpen).toBe(false);
  });

  it("clear resets everything", () => {
    const rel = reduce(INITIAL_STARTER_STATE, { type: "toggle", id: "release", scaffold: SCAFFOLDS[3]! });
    const cleared = reduce({ ...rel, text: "ship it", version: "v2.0.0", milestoneTitle: "x" }, { type: "clear" });
    expect(cleared).toEqual(INITIAL_STARTER_STATE);
  });

  it("text emptied deactivates non-release starters; release checkbox off cancels release", () => {
    const bug = reduce(INITIAL_STARTER_STATE, { type: "toggle", id: "bug", scaffold: SCAFFOLDS[0]! });
    expect(reduce(bug, { type: "text", value: "" }).activeStarter).toBeNull();
    const rel = reduce(INITIAL_STARTER_STATE, { type: "toggle", id: "release", scaffold: SCAFFOLDS[3]! });
    expect(reduce(rel, { type: "text", value: "" }).activeStarter).toBe("release");
    const unchecked = reduce(rel, { type: "release_checkbox", checked: false });
    expect(unchecked.activeStarter).toBeNull();
    expect(unchecked.releaseMode).toBe(false);
    expect(unchecked.text).toBe("");
  });
});

const ts = "2026-01-01T00:00:10.000Z";

describe("parseKernelLiveEvent", () => {
  it("returns null for state-sync and noisy worker events", () => {
    expect(parseKernelLiveEvent("ticket_updated", { ticket: { id: "t" }, timestamp: ts })).toBeNull();
    expect(parseKernelLiveEvent("repo_updated", { timestamp: ts })).toBeNull();
    for (const type of ["usage", "session_started"]) {
      expect(
        parseKernelLiveEvent("worker_event", { ticketId: "t", engine: "claude", event: { type }, timestamp: ts }),
      ).toBeNull();
    }
  });

  it("formats tool_use by extracting command / path from JSON input", () => {
    const bash = parseKernelLiveEvent("worker_event", {
      ticketId: "t",
      engine: "claude",
      timestamp: ts,
      event: { type: "tool_use", toolName: "Bash", inputSummary: '{"command":"bun run typecheck"}', timestamp: ts },
    });
    expect(bash?.headline).toBe("Bash · bun run typecheck");
    expect(bash?.category).toBe("tool");
    expect(bash?.summary).not.toContain("{");
    expect(summarizeToolInput('{"file_path":"packages/web/src/App.tsx"}')).toBe("packages/web/src/App.tsx");
    expect(summarizeToolInput('{"path":"src"}')).toBe("src");
    expect(summarizeToolInput("plain text")).toBe("plain text");
  });

  it("formats tool_result, thought and error", () => {
    const res = parseKernelLiveEvent("worker_event", {
      ticketId: "t",
      engine: "claude",
      timestamp: ts,
      event: { type: "tool_result", toolName: "Bash", isError: true, outputSummary: "exit 1", timestamp: ts },
    });
    expect(res).toMatchObject({ category: "tool", isError: true, detail: "exit 1", headline: "Bash failed" });
    const thought = parseKernelLiveEvent("worker_event", {
      ticketId: "t",
      engine: "codex",
      timestamp: ts,
      event: { type: "thought", text: "Planning   the\nchange", timestamp: ts },
    });
    expect(thought).toMatchObject({ category: "thought", headline: "Planning the change", kind: "codex:thought" });
    const err = parseKernelLiveEvent("worker_event", {
      ticketId: "t",
      engine: "codex",
      timestamp: ts,
      event: { type: "error", message: "boom", timestamp: ts },
    });
    expect(err).toMatchObject({ category: "alert", isError: true });
  });

  it("keeps verification_completed kind and raw payload intact", () => {
    const payload = { type: "verification_completed", ticketId: "t", stageRunId: "r", result: { ok: false, summary: "tests failed" }, timestamp: ts };
    const e = parseKernelLiveEvent("verification_completed", payload);
    expect(e?.kind).toBe("verification_completed");
    expect(e?.raw).toBe(payload);
    expect(e).toMatchObject({ category: "gate", isError: true, headline: "Verification failed" });
  });

  it("formats stage events", () => {
    const e = parseKernelLiveEvent("stage_started", { ticketId: "t", stageRun: { stage: "plan", engine: "claude" }, timestamp: ts });
    expect(e).toMatchObject({ category: "stage", headline: "plan started", ticketId: "t" });
  });
});

describe("appendBoundedTicketEvent", () => {
  const mk = (i: number, ticketId = "t"): LiveEventLogEntry => ({
    id: `id${i}`,
    ticketId,
    kind: "k",
    summary: `s${i}`,
    timestamp: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
  });

  it("de-duplicates replayed events", () => {
    const a = appendBoundedTicketEvent([], mk(1));
    const b = appendBoundedTicketEvent(a, { ...mk(1), id: "other-id" });
    expect(b).toHaveLength(1);
  });

  it("bounds per ticket and in total", () => {
    let list: LiveEventLogEntry[] = [];
    for (let i = 0; i < 10; i++) list = appendBoundedTicketEvent(list, mk(i, "a"), 5, 100);
    expect(list.filter((e) => e.ticketId === "a").map((e) => e.summary)).toEqual(["s5", "s6", "s7", "s8", "s9"]);
    for (let i = 0; i < 10; i++) list = appendBoundedTicketEvent(list, mk(i, "b"), 100, 8);
    expect(list).toHaveLength(8);
    expect(list[list.length - 1]?.ticketId).toBe("b");
  });
});

describe("synthesizeStageRunActivities / formatElapsedClock", () => {
  it("builds a stage timeline from stage runs", () => {
    const runs = [
      {
        id: "r1",
        ticketId: "t",
        stage: "implement",
        engine: "claude",
        status: "completed",
        costUsd: 0,
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:01:00.000Z",
        summary: "done",
        spans: [
          { kind: "static_verify", label: "typecheck", startedAt: "2026-01-01T00:00:30.000Z", endedAt: "x", durationMs: 1, status: "ok" },
        ],
      },
    ] as unknown as StageRun[];
    const out = synthesizeStageRunActivities("t", runs);
    expect(out.map((e) => e.headline)).toEqual(["implement started", "typecheck", "implement completed"]);
    expect(out[1]?.category).toBe("gate");
    expect(out.every((e) => e.ticketId === "t")).toBe(true);
  });

  it("formats elapsed clocks", () => {
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    expect(formatElapsedClock("2026-01-01T00:00:00.000Z", base + 42_000)).toBe("00:42");
    expect(formatElapsedClock("2026-01-01T00:00:00.000Z", base + 725_000)).toBe("12:05");
    expect(formatElapsedClock("2026-01-01T00:00:00.000Z", base + 3_723_000)).toBe("1:02:03");
    expect(formatElapsedClock(undefined, base)).toBe("00:00");
  });
});
