import { existsSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  PluginEvent,
  PluginLoaderPort,
  PluginManifest,
  PluginStatus,
} from "@super-work/core";
import { validateConfig, validateManifest } from "./manifest.ts";
import type { PersistedPlugin, PluginStateStore } from "./plugin-state-store.ts";
import { InMemoryPluginRegistry } from "./registry.ts";

/** Runtime shape a plugin entry must export (as `default` or as named exports). */
export interface PluginModule {
  /** Create the plugin's runtime instance; called on enable. */
  activate(config: Record<string, unknown>): unknown | Promise<unknown>;
  /** Release resources; called on disable/unload with the activated instance. */
  deactivate?(instance: unknown): void | Promise<void>;
}

export type PluginImporter = (absEntryPath: string, cacheBust: number) => Promise<unknown>;

export interface PluginLoaderOptions {
  /** Directory scanned by `discover()`: `<dir>/<name>/plugin.json`. */
  pluginsDir?: string;
  registry?: InMemoryPluginRegistry;
  stateStore?: PluginStateStore;
  importer?: PluginImporter;
  activateTimeoutMs?: number;
}

const BUILTIN_PREFIX = "builtin:";
const DEFAULT_ENTRIES = ["index.ts", "index.js", "index.mjs"];
const defaultImporter: PluginImporter = (p, n) => import(`${pathToFileURL(p).href}?v=${n}`);

const nowIso = () => new Date().toISOString();
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function isPluginModule(m: unknown): m is PluginModule {
  return typeof m === "object" && m !== null && typeof (m as PluginModule).activate === "function";
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

interface Entry {
  source: string;
  module?: PluginModule;
  instance?: unknown;
}

export class PluginLoader implements PluginLoaderPort {
  readonly registry: InMemoryPluginRegistry;
  private readonly entries = new Map<string, Entry>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly importer: PluginImporter;
  private readonly timeoutMs: number;
  private importCounter = 0;

  constructor(private readonly options: PluginLoaderOptions = {}) {
    this.registry = options.registry ?? new InMemoryPluginRegistry();
    this.importer = options.importer ?? defaultImporter;
    this.timeoutMs = options.activateTimeoutMs ?? 10_000;
  }

  // ---- PluginLoaderPort -------------------------------------------------

  async load(source: string): Promise<PluginManifest> {
    const { manifestPath, dir } = this.resolveSource(source);
    let manifest: PluginManifest | undefined;
    let placeholderId = basename(dir);
    try {
      const raw = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown> & { main?: unknown };
      if (typeof raw.id === "string") placeholderId = raw.id;
      const checked = validateManifest(raw);
      if (!checked.ok) throw new Error(`invalid manifest: ${checked.error}`);
      manifest = checked.manifest;
      this.assertNotLoaded(manifest.id);
      const entryPath = this.resolveEntry(dir, raw.main);
      const mod = this.extractModule(await this.importer(entryPath, ++this.importCounter));
      return await this.finishLoad(manifest, source, mod);
    } catch (e) {
      // Do not clobber an already-healthy plugin when a duplicate load is rejected.
      const existing = this.registry.get(manifest?.id ?? placeholderId);
      if (!existing || existing.state === "failed") {
        await this.recordFailure(manifest ?? this.placeholder(placeholderId), source, errMsg(e));
      }
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  /** Register an in-memory module (e.g. built-in drivers) through the same validation/isolation path. */
  async loadModule(rawManifest: unknown, mod: PluginModule, source?: string): Promise<PluginManifest> {
    const checked = validateManifest(rawManifest);
    if (!checked.ok) throw new Error(`invalid manifest: ${checked.error}`);
    const manifest = checked.manifest;
    this.assertNotLoaded(manifest.id);
    return this.finishLoad(manifest, source ?? `${BUILTIN_PREFIX}${manifest.id}`, mod);
  }

  async unload(id: string): Promise<void> {
    return this.serial(id, async () => {
      this.requireEntry(id);
      await this.deactivate(id);
      this.registry.unregister(id);
      this.entries.delete(id);
      await this.persistSafe(() => this.options.stateStore?.remove(id));
      this.registry.emit({ type: "plugin_unloaded", pluginId: id, timestamp: nowIso() });
    });
  }

  async list(): Promise<PluginStatus[]> {
    return this.registry.list();
  }

  async enable(id: string, config?: Record<string, unknown>): Promise<PluginStatus> {
    return this.serial(id, () => this.enableInternal(id, config));
  }

  async disable(id: string): Promise<PluginStatus> {
    return this.serial(id, async () => {
      this.requireEntry(id);
      const err = await this.deactivate(id);
      const status = this.setStatus(id, { state: "disabled" });
      if (err) console.warn(`[plugins] deactivate of '${id}' failed: ${err}`);
      await this.persist(id);
      this.registry.emit({ type: "plugin_disabled", pluginId: id, timestamp: nowIso() });
      return status;
    });
  }

  // ---- Discovery / restore ---------------------------------------------

  /** Scan `pluginsDir`; each plugin is isolated — failures become `failed` statuses, never throw. */
  async discover(dir = this.options.pluginsDir): Promise<PluginStatus[]> {
    if (!dir || !existsSync(dir)) return [];
    const names = (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
    for (const name of names) {
      const pluginDir = join(dir, name);
      if (!existsSync(join(pluginDir, "plugin.json"))) continue;
      try {
        await this.load(pluginDir);
      } catch {
        // already recorded as failed in load()
      }
    }
    return this.registry.list();
  }

  /** Reload persisted non-builtin plugins (restores enabled/disabled state via load). */
  async restore(): Promise<PluginStatus[]> {
    const persisted = (await this.options.stateStore?.load()) ?? [];
    for (const rec of persisted) {
      if (rec.source.startsWith(BUILTIN_PREFIX) || this.entries.has(rec.id)) continue;
      try {
        await this.load(rec.source);
      } catch {
        // recorded as failed
      }
    }
    return this.registry.list();
  }

  /** Runtime instance of an enabled plugin (undefined otherwise). */
  getInstance<T = unknown>(id: string): T | undefined {
    return this.entries.get(id)?.instance as T | undefined;
  }

  // ---- Internals ---------------------------------------------------------

  private async finishLoad(manifest: PluginManifest, source: string, mod: PluginModule): Promise<PluginManifest> {
    const existing = this.entries.get(manifest.id);
    if (existing) await this.deactivate(manifest.id); // replacing a failed entry
    this.entries.set(manifest.id, { source, module: mod });
    this.registry.register({ manifest, state: "loaded", updatedAt: nowIso() });
    this.registry.emit({ type: "plugin_loaded", pluginId: manifest.id, manifest, timestamp: nowIso() });

    const saved = (await this.options.stateStore?.load().catch(() => []))?.find((p) => p.id === manifest.id);
    if (saved?.state === "enabled") {
      await this.serial(manifest.id, () => this.enableInternal(manifest.id, saved.config));
    } else if (saved?.state === "disabled") {
      this.setStatus(manifest.id, { state: "disabled", config: saved.config });
    }
    await this.persist(manifest.id);
    return manifest;
  }

  private async enableInternal(id: string, config?: Record<string, unknown>): Promise<PluginStatus> {
    const entry = this.requireEntry(id);
    const current = this.registry.get(id) as PluginStatus;
    if (current.state === "enabled") return current;

    const effective = config ?? current.config ?? {};
    const configError = validateConfig(current.manifest.configSchema, effective);
    try {
      if (configError) throw new Error(`invalid config: ${configError}`);
      if (!entry.module) throw new Error("plugin module unavailable");
      entry.instance = await withTimeout(
        Promise.resolve(entry.module.activate(effective)),
        this.timeoutMs,
        "activate",
      );
    } catch (e) {
      entry.instance = undefined;
      return this.recordFailure(current.manifest, entry.source, errMsg(e));
    }
    const status = this.setStatus(id, { state: "enabled", config: effective });
    await this.persist(id);
    this.registry.emit({ type: "plugin_enabled", pluginId: id, timestamp: nowIso() });
    return status;
  }

  /** Call `deactivate` if an instance exists; returns an error message instead of throwing. */
  private async deactivate(id: string): Promise<string | null> {
    const entry = this.entries.get(id);
    if (!entry || entry.instance === undefined) return null;
    const instance = entry.instance;
    entry.instance = undefined;
    try {
      await withTimeout(Promise.resolve(entry.module?.deactivate?.(instance)), this.timeoutMs, "deactivate");
      return null;
    } catch (e) {
      return errMsg(e);
    }
  }

  private setStatus(id: string, patch: { state: "loaded" | "enabled" | "disabled"; config?: Record<string, unknown> }): PluginStatus {
    const cur = this.registry.get(id) as PluginStatus;
    const next: PluginStatus = {
      manifest: cur.manifest,
      config: patch.config ?? cur.config,
      state: patch.state,
      updatedAt: nowIso(),
    };
    this.registry.register(next);
    return next;
  }

  private async recordFailure(manifest: PluginManifest, source: string, error: string): Promise<PluginStatus> {
    const status: PluginStatus = { manifest, state: "failed", error, updatedAt: nowIso() };
    if (!this.entries.has(manifest.id)) this.entries.set(manifest.id, { source });
    this.registry.register(status);
    await this.persist(manifest.id);
    this.registry.emit({ type: "plugin_failed", pluginId: manifest.id, error, timestamp: nowIso() } satisfies PluginEvent);
    return status;
  }

  private placeholder(id: string): PluginManifest {
    return { id, name: id, version: "0.0.0", kind: "tool", capabilities: [] };
  }

  /** Persist status; secret config properties are never written to disk. */
  private async persist(id: string): Promise<void> {
    const store = this.options.stateStore;
    const status = this.registry.get(id);
    const entry = this.entries.get(id);
    if (!store || !status || !entry) return;
    const secrets = new Set(
      Object.entries(status.manifest.configSchema?.properties ?? {})
        .filter(([, p]) => p.secret)
        .map(([k]) => k),
    );
    const config = status.config
      ? Object.fromEntries(Object.entries(status.config).filter(([k]) => !secrets.has(k)))
      : undefined;
    const record: PersistedPlugin = {
      id,
      source: entry.source,
      state: status.state,
      config,
      error: status.error,
      updatedAt: status.updatedAt,
    };
    await this.persistSafe(() => store.save(record));
  }

  /** State-store failures must never break lifecycle operations. */
  private async persistSafe(fn: () => Promise<void> | undefined): Promise<void> {
    try {
      await fn();
    } catch (e) {
      console.warn(`[plugins] state persistence failed: ${errMsg(e)}`);
    }
  }

  private assertNotLoaded(id: string): void {
    const cur = this.registry.get(id);
    if (cur && cur.state !== "failed") throw new Error(`plugin '${id}' is already loaded`);
  }

  private requireEntry(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry || !this.registry.get(id)) throw new Error(`unknown plugin '${id}'`);
    return entry;
  }

  private resolveSource(source: string): { manifestPath: string; dir: string } {
    const abs = resolve(source);
    if (existsSync(abs) && statSync(abs).isDirectory()) return { manifestPath: join(abs, "plugin.json"), dir: abs };
    return { manifestPath: abs, dir: dirname(abs) };
  }

  private resolveEntry(dir: string, main: unknown): string {
    if (main !== undefined && typeof main !== "string") throw new Error("manifest 'main' must be a string");
    const candidates = main ? [main] : DEFAULT_ENTRIES;
    for (const c of candidates) {
      const abs = resolve(dir, c);
      const rel = relative(dir, abs);
      if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`plugin entry '${c}' escapes plugin directory`);
      if (existsSync(abs)) return abs;
    }
    throw new Error(`plugin entry not found (tried ${candidates.join(", ")})`);
  }

  private extractModule(ns: unknown): PluginModule {
    const candidate = (ns as { default?: unknown })?.default ?? ns;
    if (isPluginModule(candidate)) return candidate;
    if (isPluginModule(ns)) return ns;
    throw new Error("plugin entry must export an 'activate' function");
  }

  /** Serialize operations per plugin id. */
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.queues.set(id, tail);
    void tail.then(() => {
      if (this.queues.get(id) === tail) this.queues.delete(id);
    });
    return next;
  }
}
