import type {
  PluginEvent,
  PluginEventListener,
  PluginListFilter,
  PluginRegistry,
  PluginStatus,
} from "@super-work/core";

export class InMemoryPluginRegistry implements PluginRegistry {
  private readonly items = new Map<string, PluginStatus>();
  private readonly listeners = new Set<PluginEventListener>();

  get(id: string): PluginStatus | undefined {
    return this.items.get(id);
  }

  list(filter?: PluginListFilter): PluginStatus[] {
    return [...this.items.values()].filter(
      (s) => (!filter?.kind || s.manifest.kind === filter.kind) && (!filter?.state || s.state === filter.state),
    );
  }

  register(status: PluginStatus): void {
    this.items.set(status.manifest.id, status);
  }

  unregister(id: string): boolean {
    return this.items.delete(id);
  }

  subscribe(listener: PluginEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Emit to listeners; a throwing listener never affects others or the caller. */
  emit(event: PluginEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch {
        // isolated
      }
    }
  }
}
