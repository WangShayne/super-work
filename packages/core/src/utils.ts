import type { SmokeCheckConfig, TicketStatus } from "./types.ts";

export function newId(prefix: string): string {
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return `${prefix}_${rand}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function normalizeRelPath(input: string): string {
  let p = input.replace(/\\/g, "/").trim();
  while (p.startsWith("./")) {
    p = p.slice(2);
  }
  while (p.startsWith("/")) {
    p = p.slice(1);
  }
  while (p.endsWith("/") && p.length > 1) {
    p = p.slice(0, -1);
  }
  return p;
}

export const TERMINAL_TICKET_STATUSES: ReadonlySet<TicketStatus> = new Set([
  "delivered",
  "failed",
  "cancelled",
]);

export function isTerminalTicketStatus(status: TicketStatus): boolean {
  return TERMINAL_TICKET_STATUSES.has(status);
}

export function normalizeErrorSignature(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\b\d+\b/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

export function normalizeSmokeCheckConfig(raw: unknown): SmokeCheckConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const startCommand = typeof r.startCommand === "string" ? r.startCommand.trim() : "";
  const readyUrl =
    typeof r.readyUrl === "string" && r.readyUrl.trim() ? r.readyUrl.trim() : undefined;
  const checkCommands = Array.isArray(r.checkCommands)
    ? r.checkCommands.map((s) => String(s).trim()).filter(Boolean)
    : undefined;
  const rawTimeout = typeof r.startupTimeoutSec === "number" ? r.startupTimeoutSec : Number(r.startupTimeoutSec);
  const startupTimeoutSec =
    Number.isFinite(rawTimeout) && rawTimeout > 0
      ? Math.max(2, Math.min(120, Math.floor(rawTimeout)))
      : undefined;
  const triggerMode = r.triggerMode === "delivery_only" ? "delivery_only" : "every_gate";
  const enabled = Boolean(r.enabled) && Boolean(startCommand);

  if (!startCommand && !readyUrl && (!checkCommands || checkCommands.length === 0) && r.enabled !== true) {
    return undefined;
  }

  return {
    enabled,
    startCommand,
    ...(readyUrl ? { readyUrl } : {}),
    ...(startupTimeoutSec !== undefined ? { startupTimeoutSec } : {}),
    ...(checkCommands && checkCommands.length > 0 ? { checkCommands } : {}),
    triggerMode,
  };
}
