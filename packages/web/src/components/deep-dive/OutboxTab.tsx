import { formatOutboxStatus, useI18n } from "../../i18n.tsx";
import type { TicketDetailResponse } from "../../types.ts";

export interface OutboxTabProps {
  detail: TicketDetailResponse | null;
}

export function OutboxTab({
  detail,
}: OutboxTabProps) {
  const { locale, t } = useI18n();
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
          {t("drawer.outboxTitle")}
        </h3>
      </div>
      {detail?.outboxEntries.length === 0 ? (
        <p className="text-xs text-zinc-500">{t("drawer.noOutbox")}</p>
      ) : (
        detail?.outboxEntries.map((obx) => (
          <div
            key={obx.id}
            className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3.5 text-xs space-y-2"
          >
            <div className="flex items-center justify-between">
              <span className="font-mono font-semibold text-zinc-200">{obx.action}</span>
              <span className="font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 text-[10px]">
                {formatOutboxStatus(obx.status, locale)}
              </span>
            </div>
            <div className="font-mono text-[11px] text-zinc-500">
              {t("drawer.outboxKey")}: {obx.idempotencyKey} · {t("drawer.outboxAttempts")}:{" "}
              {obx.attempts}
            </div>
            {obx.resultPayload && (
              <pre className="p-2 rounded bg-zinc-950 border border-zinc-800 text-[11px] text-emerald-300 overflow-x-auto">
                {JSON.stringify(obx.resultPayload, null, 2)}
              </pre>
            )}
            {obx.lastError && (
              <div className="text-rose-300 text-[11px]">
                {t("drawer.outboxError")} {obx.lastError}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
