import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { FlightEvent } from "@super-work/core";
import { SqliteStateStore } from "../src/index.ts";

function makeEvent(overrides: Partial<FlightEvent> & { id: string }): FlightEvent {
  return {
    kind: "canary_passed",
    summary: "ok",
    createdAt: "2026-06-10T10:00:00.000Z",
    ...overrides,
  };
}

describe("v1.4.0 SqliteStateStore flight_events", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const d of tempDirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  async function openStore(): Promise<{ dbPath: string; store: SqliteStateStore }> {
    const dir = await mkdtemp(join(tmpdir(), "sw-v140-flight-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "state.db");
    return { dbPath, store: new SqliteStateStore(dbPath) };
  }

  it("round-trips optional fields and metadata", async () => {
    const { store } = await openStore();
    await store.recordFlightEvent(
      makeEvent({
        id: "fev_1",
        repoId: "repo_a",
        ticketId: "tkt_1",
        kind: "scoped_gate_run",
        engine: "codex",
        summary: "scoped",
        savedMs: 12_345,
        metadata: { commandsRun: ["bun test a"], ok: true },
      }),
    );
    await store.recordFlightEvent(makeEvent({ id: "fev_2", createdAt: "2026-06-10T10:05:00.000Z" }));

    const events = await store.listFlightEvents();
    expect(events.map((e) => e.id)).toEqual(["fev_2", "fev_1"]);
    const full = events[1]!;
    expect(full).toEqual({
      id: "fev_1",
      repoId: "repo_a",
      ticketId: "tkt_1",
      kind: "scoped_gate_run",
      engine: "codex",
      summary: "scoped",
      savedMs: 12_345,
      metadata: { commandsRun: ["bun test a"], ok: true },
      createdAt: "2026-06-10T10:00:00.000Z",
    });
    const bare = events[0]!;
    expect(bare.repoId).toBeUndefined();
    expect(bare.metadata).toBeUndefined();
    expect(bare.savedMs).toBeUndefined();
  });

  it("filters by repoId, sinceIso and limit in descending time order", async () => {
    const { store } = await openStore();
    for (let i = 0; i < 6; i++) {
      await store.recordFlightEvent(
        makeEvent({
          id: `fev_${i}`,
          repoId: i % 2 === 0 ? "repo_a" : "repo_b",
          createdAt: `2026-06-10T10:0${i}:00.000Z`,
        }),
      );
    }

    const repoA = await store.listFlightEvents({ repoId: "repo_a" });
    expect(repoA.map((e) => e.id)).toEqual(["fev_4", "fev_2", "fev_0"]);

    const since = await store.listFlightEvents({ sinceIso: "2026-06-10T10:03:00.000Z" });
    expect(since.map((e) => e.id)).toEqual(["fev_5", "fev_4", "fev_3"]);

    const limited = await store.listFlightEvents({ limit: 2 });
    expect(limited.map((e) => e.id)).toEqual(["fev_5", "fev_4"]);

    const combined = await store.listFlightEvents({
      repoId: "repo_b",
      sinceIso: "2026-06-10T10:02:00.000Z",
      limit: 1,
    });
    expect(combined.map((e) => e.id)).toEqual(["fev_5"]);
  });

  it("upserts by id instead of duplicating", async () => {
    const { store } = await openStore();
    await store.recordFlightEvent(makeEvent({ id: "fev_dup", summary: "first" }));
    await store.recordFlightEvent(makeEvent({ id: "fev_dup", summary: "second" }));
    const events = await store.listFlightEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.summary).toBe("second");
  });

  it("persists across store restarts on the same database file", async () => {
    const { dbPath, store } = await openStore();
    await store.recordFlightEvent(
      makeEvent({ id: "fev_persist", kind: "canary_rolled_back", repoId: "repo_a", savedMs: 5 }),
    );
    store.close?.();

    const reopened = new SqliteStateStore(dbPath);
    const events = await reopened.listFlightEvents({ repoId: "repo_a" });
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe("fev_persist");
    expect(events[0]!.kind).toBe("canary_rolled_back");
    expect(events[0]!.savedMs).toBe(5);
    reopened.close?.();
  });
});
