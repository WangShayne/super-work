import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import type { PluginState } from "@super-work/core";

export interface PersistedPlugin {
  id: string;
  source: string;
  state: PluginState;
  /** Non-secret config only. */
  config?: Record<string, unknown>;
  error?: string;
  updatedAt: string;
}

export interface PluginStateStore {
  load(): Promise<PersistedPlugin[]>;
  save(record: PersistedPlugin): Promise<void>;
  remove(id: string): Promise<void>;
}

export class SqlitePluginStateStore implements PluginStateStore {
  constructor(private readonly db: Database) {
    db.run(`
      CREATE TABLE IF NOT EXISTS plugins (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        state TEXT NOT NULL,
        config_json TEXT,
        error TEXT,
        updated_at TEXT NOT NULL
      );
    `);
  }

  async load(): Promise<PersistedPlugin[]> {
    const rows = this.db.query("SELECT * FROM plugins ORDER BY id").all() as Array<Record<string, string | null>>;
    return rows.map((r) => ({
      id: r.id as string,
      source: r.source as string,
      state: r.state as PluginState,
      config: r.config_json ? (JSON.parse(r.config_json) as Record<string, unknown>) : undefined,
      error: r.error ?? undefined,
      updatedAt: r.updated_at as string,
    }));
  }

  async save(p: PersistedPlugin): Promise<void> {
    this.db
      .query(
        `INSERT INTO plugins (id, source, state, config_json, error, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET source=?2, state=?3, config_json=?4, error=?5, updated_at=?6`,
      )
      .run(p.id, p.source, p.state, p.config ? JSON.stringify(p.config) : null, p.error ?? null, p.updatedAt);
  }

  async remove(id: string): Promise<void> {
    this.db.query("DELETE FROM plugins WHERE id = ?1").run(id);
  }
}

export class FilePluginStateStore implements PluginStateStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  private async read(): Promise<Record<string, PersistedPlugin>> {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as Record<string, PersistedPlugin>;
    } catch {
      return {};
    }
  }

  private mutate(fn: (data: Record<string, PersistedPlugin>) => void): Promise<void> {
    const run = async () => {
      const data = await this.read();
      fn(data);
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, JSON.stringify(data, null, 2));
      await rename(tmp, this.path);
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async load(): Promise<PersistedPlugin[]> {
    await this.queue;
    return Object.values(await this.read());
  }

  save(p: PersistedPlugin): Promise<void> {
    return this.mutate((d) => {
      d[p.id] = p;
    });
  }

  remove(id: string): Promise<void> {
    return this.mutate((d) => {
      delete d[id];
    });
  }
}
