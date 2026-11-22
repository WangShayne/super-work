import type { TicketStatus } from "./types.ts";

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
