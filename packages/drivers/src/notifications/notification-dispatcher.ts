import type {
  KernelEvent,
  NotificationConfig,
  StateStore,
  SuperWorkKernel,
  SystemSetupConfig,
} from "@super-work/core";
import { nowIso } from "@super-work/core";

export interface NotificationPayload {
  eventType: "inbox_pending" | "delivery_complete" | "ticket_failed" | "test";
  title: string;
  body: string;
  repoId?: string;
  ticketId?: string;
  inboxId?: string;
  prUrl?: string;
  timestamp: string;
}

export interface NotificationDispatchResult {
  channel: "macos" | "webhook";
  ok: boolean;
  detail?: string;
}

export type MacosNotifyFn = (title: string, message: string) => Promise<void>;
export type FetchFn = (
  input: string,
  init?: RequestInit,
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export function detectWebhookPlatform(url: string): "feishu" | "slack" | "discord" | "generic" {
  const lower = url.toLowerCase();
  if (lower.includes("open.feishu.cn") || lower.includes("larksuite.com")) {
    return "feishu";
  }
  if (lower.includes("hooks.slack.com")) {
    return "slack";
  }
  if (lower.includes("discord.com/api/webhooks") || lower.includes("discordapp.com/api/webhooks")) {
    return "discord";
  }
  return "generic";
}

export function buildWebhookRequest(
  url: string,
  payload: NotificationPayload,
  secret?: string,
): { body: string; headers: Record<string, string>; platform: "feishu" | "slack" | "discord" | "generic" } {
  const platform = detectWebhookPlatform(url);
  const formattedText = `[super-work] ${payload.title}\n${payload.body}${payload.prUrl ? `\nPR: ${payload.prUrl}` : ""}`;

  let rawPayload: unknown;
  if (platform === "feishu") {
    rawPayload = {
      msg_type: "text",
      content: { text: formattedText },
    };
  } else if (platform === "slack") {
    rawPayload = { text: formattedText };
  } else if (platform === "discord") {
    rawPayload = { content: formattedText };
  } else {
    rawPayload = payload;
  }

  const body = JSON.stringify(rawPayload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (secret?.trim()) {
    const sig = new Bun.CryptoHasher("sha256", secret.trim()).update(body).digest("hex");
    headers["X-Super-Work-Signature"] = `sha256=${sig}`;
  }
  return { body, headers, platform };
}

export async function defaultMacosNotify(title: string, message: string): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }
  const osascriptBin = Bun.which("osascript");
  if (!osascriptBin) {
    return;
  }
  const proc = Bun.spawn(
    [
      osascriptBin,
      "-e",
      "on run argv",
      "-e",
      "display notification (item 2 of argv) with title (item 1 of argv)",
      "-e",
      "end run",
      "--",
      title.slice(0, 120),
      message.slice(0, 240),
    ],
    {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    },
  );
  await proc.exited;
}

export const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
  macosEnabled: false,
  webhookEnabled: false,
  notifyOnInbox: true,
  notifyOnDelivery: true,
  notifyOnFailure: true,
};

export class NotificationDispatcher {
  private readonly macosSender: MacosNotifyFn;
  private readonly fetchImpl: FetchFn;
  private readonly notifiedFailureTickets = new Set<string>();
  private readonly notifiedDeliveryKeys = new Set<string>();

  constructor(
    private readonly stateStore: StateStore,
    options?: {
      macosSender?: MacosNotifyFn;
      fetchImpl?: FetchFn;
    },
  ) {
    this.macosSender = options?.macosSender ?? defaultMacosNotify;
    this.fetchImpl = options?.fetchImpl ?? (fetch as unknown as FetchFn);
  }

  attachToKernel(kernel: SuperWorkKernel): () => void {
    return kernel.subscribe((event) => {
      void this.handleKernelEvent(event);
    });
  }

  async getConfig(): Promise<NotificationConfig> {
    const setup = await this.stateStore.getSystemSetting<SystemSetupConfig>("setup_config");
    return {
      ...DEFAULT_NOTIFICATION_CONFIG,
      ...(setup?.notifications ?? {}),
    };
  }

  async handleKernelEvent(event: KernelEvent): Promise<NotificationDispatchResult[]> {
    const cfg = await this.getConfig();
    if (!cfg.macosEnabled && !(cfg.webhookEnabled && cfg.webhookUrl?.trim())) {
      return [];
    }

    let payload: NotificationPayload | null = null;

    if (event.type === "inbox_created" && cfg.notifyOnInbox) {
      payload = {
        eventType: "inbox_pending",
        title: `Action Needed (${event.item.kind})`,
        body: `${event.item.title}\n${event.item.summary.slice(0, 240)}`,
        repoId: event.item.repoId,
        ticketId: event.item.ticketId,
        inboxId: event.item.id,
        timestamp: event.timestamp,
      };
    } else if (event.type === "outbox_sent" && cfg.notifyOnDelivery) {
      if (event.entry.action === "local_merge" || event.entry.action === "push_and_create_pr") {
        const key = `${event.entry.id}:${event.entry.updatedAt}`;
        if (this.notifiedDeliveryKeys.has(key)) return [];
        this.notifiedDeliveryKeys.add(key);

        const prUrl =
          typeof event.entry.resultPayload?.prUrl === "string"
            ? event.entry.resultPayload.prUrl
            : undefined;
        const ticket = await this.stateStore.getTicket(event.entry.ticketId);
        payload = {
          eventType: "delivery_complete",
          title:
            event.entry.action === "local_merge"
              ? `Merged Locally: ${ticket?.title ?? event.entry.ticketId}`
              : `Delivered: ${ticket?.title ?? event.entry.ticketId}`,
          body: prUrl
            ? `PR ready at ${prUrl}`
            : `Branch ${ticket?.branchName ?? ""} delivered cleanly (${event.entry.action}).`,
          repoId: event.entry.repoId,
          ticketId: event.entry.ticketId,
          prUrl,
          timestamp: event.timestamp,
        };
      }
    } else if (event.type === "ticket_updated" && cfg.notifyOnFailure) {
      if (event.ticket.status === "failed" && !event.ticket.parentTicketId) {
        if (this.notifiedFailureTickets.has(event.ticket.id)) return [];
        this.notifiedFailureTickets.add(event.ticket.id);
        payload = {
          eventType: "ticket_failed",
          title: `Task Failed: ${event.ticket.title}`,
          body: event.ticket.errorMessage ?? `Ticket ${event.ticket.id} failed.`,
          repoId: event.ticket.repoId,
          ticketId: event.ticket.id,
          timestamp: event.timestamp,
        };
      } else if (event.ticket.status !== "failed") {
        this.notifiedFailureTickets.delete(event.ticket.id);
      }
    }

    if (!payload) return [];
    return this.dispatch(payload, cfg);
  }

  async sendTestNotification(
    overrideConfig?: Partial<NotificationConfig>,
  ): Promise<NotificationDispatchResult[]> {
    const saved = await this.getConfig();
    const effective: NotificationConfig = {
      ...saved,
      ...overrideConfig,
      webhookSecret: overrideConfig?.webhookSecret?.trim() || saved.webhookSecret,
    };
    return this.dispatch(
      {
        eventType: "test",
        title: "Super-Work Test Notification",
        body: "Attention push channel verified (High-signal alerts only).",
        timestamp: nowIso(),
      },
      effective,
    );
  }

  async dispatch(
    payload: NotificationPayload,
    cfg: NotificationConfig,
  ): Promise<NotificationDispatchResult[]> {
    const results: NotificationDispatchResult[] = [];

    if (cfg.macosEnabled) {
      try {
        await this.macosSender(payload.title, payload.body);
        results.push({ channel: "macos", ok: true, detail: "sent" });
      } catch (err) {
        results.push({
          channel: "macos",
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (cfg.webhookEnabled && cfg.webhookUrl?.trim()) {
      const targetUrl = cfg.webhookUrl.trim();
      try {
        const req = buildWebhookRequest(targetUrl, payload, cfg.webhookSecret);
        const res = await this.fetchImpl(targetUrl, {
          method: "POST",
          headers: req.headers,
          body: req.body,
          signal: AbortSignal.timeout(8_000),
        });
        results.push({
          channel: "webhook",
          ok: res.ok,
          detail: res.ok
            ? `${req.platform} (${res.status})`
            : `${req.platform} HTTP ${res.status}`,
        });
      } catch (err) {
        results.push({
          channel: "webhook",
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }
}
