import type { PluginKind } from "@super-work/core";
import { ClaudeCodeDriver } from "../workers/claude-code-driver.ts";
import { CodexDriver } from "../workers/codex-driver.ts";
import { MockWorkerDriver } from "../workers/mock-driver.ts";
import { OpenCodeDriver } from "../workers/opencode-driver.ts";
import { GhOutboxExecutor } from "../sources/gh-cli-source.ts";
import { HeuristicControlLLM } from "../llm/control-plane-llm.ts";
import type { PluginLoader, PluginModule } from "./plugin-loader.ts";

interface BuiltinSpec {
  id: string;
  name: string;
  kind: PluginKind;
  capabilities: string[];
  create: (config: Record<string, unknown>) => unknown;
  binaryConfig?: boolean;
}

const binarySchema = {
  type: "object",
  properties: { binary: { type: "string", description: "CLI binary path" } },
} as const;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const SPECS: BuiltinSpec[] = [
  {
    id: "worker-claude-code",
    name: "Claude Code worker",
    kind: "driver",
    capabilities: ["run_turn"],
    binaryConfig: true,
    create: (c) => new ClaudeCodeDriver(str(c.binary)),
  },
  {
    id: "worker-codex",
    name: "Codex worker",
    kind: "driver",
    capabilities: ["run_turn"],
    binaryConfig: true,
    create: (c) => new CodexDriver(str(c.binary)),
  },
  {
    id: "worker-opencode",
    name: "OpenCode worker",
    kind: "driver",
    capabilities: ["run_turn"],
    binaryConfig: true,
    create: (c) => new OpenCodeDriver(str(c.binary)),
  },
  {
    id: "worker-mock",
    name: "Mock worker",
    kind: "driver",
    capabilities: ["run_turn"],
    create: () => new MockWorkerDriver(),
  },
  {
    id: "llm-heuristic",
    name: "Heuristic control-plane LLM",
    kind: "llm",
    capabilities: ["triage", "watchdog"],
    create: () => new HeuristicControlLLM(),
  },
  {
    id: "outbox-gh",
    name: "GitHub CLI outbox executor",
    kind: "outbox",
    capabilities: ["execute"],
    create: () => new GhOutboxExecutor(),
  },
];

/**
 * Register built-in drivers through the plugin contract. Purely additive: the original
 * classes and exports are untouched, so callers that construct drivers directly keep working.
 * Stateful drivers needing runtime wiring (e.g. GhCliPollingSource needs a kernel) are
 * registered by the host via `loader.loadModule` with its own factory.
 */
export async function registerBuiltinPlugins(loader: PluginLoader): Promise<void> {
  for (const spec of SPECS) {
    const mod: PluginModule = { activate: (config) => spec.create(config) };
    try {
      await loader.loadModule(
        {
          id: spec.id,
          name: spec.name,
          version: "0.2.0",
          kind: spec.kind,
          capabilities: spec.capabilities,
          ...(spec.binaryConfig ? { configSchema: binarySchema } : {}),
        },
        mod,
      );
    } catch (e) {
      // Already registered (e.g. called twice) or invalid: isolate, never abort the rest.
      console.warn(`[plugins] built-in '${spec.id}' not registered: ${e instanceof Error ? e.message : e}`);
    }
  }
}
