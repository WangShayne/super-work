import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Ticket } from "@super-work/core";
import { DaemonNotReachableError, SuperWorkHttpClient } from "../client.ts";
import { extractEventTicketId, formatEventLine } from "./cli-formatters.ts";

export function getStringFlag(flags: Record<string, string | boolean>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const val = flags[k];
    if (typeof val === "string" && val.trim().length > 0) {
      return val.trim();
    }
  }
  return undefined;
}

export function resolveServerEntryPath(): string {
  // This module lives in packages/cli/src/commands/, one level below the original index.ts.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../../server/src/index.ts");
}

export async function waitForHealth(
  baseUrl: string,
  timeoutMs = 10_000,
  token?: string,
): Promise<boolean> {
  const client = new SuperWorkHttpClient(baseUrl, token);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const h = await client.getHealth();
      if (h.ok) return true;
    } catch {
      // Daemon still booting
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export async function spawnDetachedDaemon(
  baseUrl: string,
  options?: { host?: string; port?: string; dataDir?: string; token?: string },
): Promise<number | undefined> {
  const parsedUrl = new URL(baseUrl);
  const port = options?.port ?? (parsedUrl.port || "4318");
  const serverEntry = resolveServerEntryPath();
  const proc = Bun.spawn(["bun", "run", serverEntry], {
    env: {
      ...process.env,
      HOST: options?.host ?? process.env.HOST ?? "127.0.0.1",
      PORT: String(port),
      ...(options?.dataDir ? { SUPER_WORK_DATA_DIR: options.dataDir } : {}),
      ...(options?.token ? { SUPER_WORK_TOKEN: options.token } : {}),
    },
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  proc.unref?.();
  const ready = await waitForHealth(baseUrl, 10_000, options?.token);
  if (!ready) {
    throw new Error(`Timed out waiting for daemon health at ${baseUrl}`);
  }
  return proc.pid;
}

export async function withAutoStart<T>(
  baseUrl: string,
  autoStart: boolean,
  fn: () => Promise<T>,
  stdout: (line: string) => void,
  token?: string,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DaemonNotReachableError && autoStart) {
      stdout(`Daemon offline at ${baseUrl}; starting background daemon...`);
      await spawnDetachedDaemon(baseUrl, { token });
      return fn();
    }
    throw err;
  }
}

export async function resolveTargetRepoId(client: SuperWorkHttpClient, requested?: string): Promise<string> {
  if (requested) return requested;
  const { repos } = await client.listRepos();
  if (repos.length === 0) {
    throw new Error("No repositories registered in super-work. Register a repo first via the Web UI or POST /api/repos.");
  }
  return repos[0]!.id;
}

export function isFinalForWait(status: Ticket["status"]): boolean {
  return status === "delivered" || status === "failed" || status === "cancelled" || status === "needs_human";
}

export async function waitForTicketCompletion(
  client: SuperWorkHttpClient,
  ticketId: string,
  stdout: (line: string) => void,
  timeoutMs = 300_000,
): Promise<Ticket> {
  const ac = new AbortController();
  const timeoutTimer = setTimeout(() => ac.abort("wait_timeout"), timeoutMs);

  let latestTicket = (await client.getTicketDetail(ticketId)).ticket;
  if (isFinalForWait(latestTicket.status)) {
    clearTimeout(timeoutTimer);
    return latestTicket;
  }

  const ssePromise = client
    .streamEvents(
      (ev) => {
        if (ev.event === "ping" || ev.event === "connected") return;
        const evTicketId = extractEventTicketId(ev.data);
        stdout(formatEventLine(ev, ticketId));
        if (ev.event === "ticket_updated" && evTicketId === ticketId) {
          const updated = ev.data.ticket as Ticket | undefined;
          if (updated && isFinalForWait(updated.status)) {
            latestTicket = updated;
            ac.abort("terminal");
          }
        }
      },
      ac.signal,
      { ticketId, reconnect: true, reconnectDelayMs: 500 },
    )
    .catch(() => {});

  const pollTimer = setInterval(() => {
    void client
      .getTicketDetail(ticketId)
      .then((detail) => {
        latestTicket = detail.ticket;
        if (isFinalForWait(detail.ticket.status)) {
          ac.abort("terminal");
        }
      })
      .catch(() => {});
  }, 600);

  try {
    await ssePromise;
    return (await client.getTicketDetail(ticketId)).ticket;
  } finally {
    clearTimeout(timeoutTimer);
    clearInterval(pollTimer);
  }
}
