import { describe, expect, it } from "bun:test";
import type { KernelEvent, StateStore, SuperWorkKernel } from "@super-work/core";
import { createServerApp } from "../src/app.ts";
import { createLiveEventBuffer } from "../src/live-event-buffer.ts";

const TS = "2026-01-01T00:00:00.000Z";

function workerEvent(ticketId: string, type: string, extra: Record<string, unknown> = {}): KernelEvent {
  return {
    type: "worker_event",
    ticketId,
    stageRunId: "run_1",
    engine: "mock",
    event: { type, timestamp: TS, ...extra },
    timestamp: TS,
  } as unknown as KernelEvent;
}

function stageStarted(ticketId: string): KernelEvent {
  return {
    type: "stage_started",
    ticketId,
    stageRun: { id: "run_1", ticketId, stage: "implement", engine: "mock", status: "running" },
    timestamp: TS,
  } as unknown as KernelEvent;
}

describe("v1.8.3 live event ring buffer", () => {
  it("skips noisy and state-sync events", () => {
    const buf = createLiveEventBuffer();
    buf.push(workerEvent("t1", "usage", { costUsd: 1 }));
    buf.push(workerEvent("t1", "session_started", { nativeSessionId: "s" }));
    buf.push({ type: "ticket_updated", ticket: { id: "t1" }, timestamp: TS } as unknown as KernelEvent);
    buf.push(workerEvent("t1", "thought", { text: "hmm" }));
    expect(buf.replay()).toHaveLength(1);
  });

  it("caps events per ticket at 60 and tickets at 40 (LRU)", () => {
    const buf = createLiveEventBuffer();
    for (let i = 0; i < 75; i++) buf.push(workerEvent("t1", "text", { text: `m${i}` }));
    const t1 = buf.replay();
    expect(t1).toHaveLength(60);
    expect((t1[0] as { event: { text: string } }).event.text).toBe("m15");

    for (let i = 0; i < 45; i++) buf.push(stageStarted(`tk_${i}`));
    const ids = new Set(buf.replay().map((e) => (e as { ticketId: string }).ticketId));
    expect(ids.size).toBe(40);
    expect(ids.has("t1")).toBe(false);
    expect(ids.has("tk_44")).toBe(true);
    expect(ids.has("tk_4")).toBe(false);
  });
});

describe("v1.8.3 GET /api/events replay", () => {
  function setup() {
    const listeners = new Set<(e: KernelEvent) => void>();
    const kernel = {
      subscribe(fn: (e: KernelEvent) => void) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    } as unknown as SuperWorkKernel;
    const tickets = [
      { id: "parent", repoId: "repoA" },
      { id: "child", repoId: "repoA", parentTicketId: "parent" },
      { id: "other", repoId: "repoB" },
    ];
    const stateStore = { listTickets: async () => tickets } as unknown as StateStore;
    const app = createServerApp({ kernel, stateStore, artifactStore: {} as never });
    const emit = (e: KernelEvent) => {
      for (const l of [...listeners]) l(e);
    };
    return { app, emit };
  }

  async function readFrames(app: ReturnType<typeof setup>["app"], query: string): Promise<string> {
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    const ac = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/events${query}`, {
        signal: ac.signal,
      });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let out = "";
      const pump = (async () => {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          out += dec.decode(value, { stream: true });
        }
      })().catch(() => {});
      await new Promise((r) => setTimeout(r, 120));
      ac.abort("done");
      await pump;
      return out;
    } finally {
      server.stop(true);
    }
  }

  it("replays buffered events right after `connected`", async () => {
    const { app, emit } = setup();
    emit(stageStarted("parent"));
    emit(workerEvent("parent", "tool_use", { toolName: "Bash", inputSummary: "{}" }));
    const out = await readFrames(app, "");
    const connectedAt = out.indexOf("event: connected");
    expect(connectedAt).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("event: stage_started")).toBeGreaterThan(connectedAt);
    expect(out.indexOf("event: worker_event")).toBeGreaterThan(out.indexOf("event: stage_started"));
  });

  it("honors ?ticketId (incl. child subtasks) and ?repoId filters", async () => {
    const { app, emit } = setup();
    emit(stageStarted("parent"));
    emit(stageStarted("child"));
    emit(stageStarted("other"));

    const byTicket = await readFrames(app, "?ticketId=parent");
    expect(byTicket).toContain('"ticketId":"parent"');
    expect(byTicket).toContain('"ticketId":"child"');
    expect(byTicket).not.toContain('"ticketId":"other"');

    const byRepo = await readFrames(app, "?repoId=repoB");
    expect(byRepo).toContain('"ticketId":"other"');
    expect(byRepo).not.toContain('"ticketId":"parent"');
    expect(byRepo).not.toContain('"ticketId":"child"');
  });
});
