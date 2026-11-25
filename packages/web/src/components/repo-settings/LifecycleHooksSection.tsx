import { ShieldCheck } from "lucide-react";

import { useI18n } from "../../i18n.tsx";

export interface LifecycleHooksSectionProps {
  preDeliverHooksInput: string;
  setPreDeliverHooksInput: (value: string) => void;
  postDeliverHooksInput: string;
  setPostDeliverHooksInput: (value: string) => void;
  onEscalateHooksInput: string;
  setOnEscalateHooksInput: (value: string) => void;
  hookTimeoutInput: string;
  setHookTimeoutInput: (value: string) => void;
}

export function LifecycleHooksSection({
  preDeliverHooksInput,
  setPreDeliverHooksInput,
  postDeliverHooksInput,
  setPostDeliverHooksInput,
  onEscalateHooksInput,
  setOnEscalateHooksInput,
  hookTimeoutInput,
  setHookTimeoutInput,
}: LifecycleHooksSectionProps) {
  const { t } = useI18n();
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3.5 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="font-semibold text-zinc-200 flex items-center gap-1.5">
          <ShieldCheck className="w-3.5 h-3.5 text-amber-400" />
          {t("hooks.title")}
        </span>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-zinc-400">timeoutSec</span>
          <input
            type="number"
            min={5}
            max={600}
            value={hookTimeoutInput}
            onChange={(e) => setHookTimeoutInput(e.target.value)}
            className="w-16 bg-zinc-900 border border-zinc-800 rounded px-2 py-0.5 font-mono text-[11px] text-zinc-100"
          />
        </div>
      </div>
      <p className="text-[11px] text-emerald-300/90 bg-emerald-500/10 border border-emerald-500/25 rounded-lg px-2.5 py-1.5">
        {t("hooks.immutableNote")}
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
        <div>
          <label className="block text-[11px] text-zinc-400 mb-1">
            pre_deliver (blocking)
          </label>
          <textarea
            rows={2}
            value={preDeliverHooksInput}
            onChange={(e) => setPreDeliverHooksInput(e.target.value)}
            placeholder="bun run typecheck"
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 font-mono text-[11px] text-zinc-100"
          />
        </div>
        <div>
          <label className="block text-[11px] text-zinc-400 mb-1">
            post_deliver (async)
          </label>
          <textarea
            rows={2}
            value={postDeliverHooksInput}
            onChange={(e) => setPostDeliverHooksInput(e.target.value)}
            placeholder="./scripts/notify.sh"
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 font-mono text-[11px] text-zinc-100"
          />
        </div>
        <div>
          <label className="block text-[11px] text-zinc-400 mb-1">
            on_escalate (async)
          </label>
          <textarea
            rows={2}
            value={onEscalateHooksInput}
            onChange={(e) => setOnEscalateHooksInput(e.target.value)}
            placeholder="./scripts/page.sh"
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 font-mono text-[11px] text-zinc-100"
          />
        </div>
      </div>
    </div>
  );
}
