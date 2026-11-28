import { useState } from "react";
import { Bell, Copy, KeyRound, Plug, Send } from "lucide-react";
import { api } from "../../api.ts";
import { useI18n } from "../../i18n.tsx";
import { ModelRegistryStudio } from "./ModelRegistryStudio.tsx";
import type { PublicSetupStatus } from "../../types.ts";

interface CustomizeSetupFormProps {
  setupStatus: PublicSetupStatus;
  onClose: () => void;
  onSaved: (next: PublicSetupStatus) => Promise<void>;
}

const INPUT = "w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100 focus:outline-none focus:border-indigo-500";

function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer text-zinc-200">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="rounded border-zinc-700 bg-zinc-950 text-indigo-500"
      />
      {label}
    </label>
  );
}

/** Model Pool + Role Binding (ModelRegistryStudio), notification channels and MCP / remote webhook secrets. */
export function CustomizeSetupForm({ setupStatus, onClose, onSaved }: CustomizeSetupFormProps) {
  const { t } = useI18n();
  const n = setupStatus.config.notifications;
  const [macosEnabled, setMacosEnabled] = useState(n?.macosEnabled ?? false);
  const [webhookEnabled, setWebhookEnabled] = useState(n?.webhookEnabled ?? false);
  const [webhookUrl, setWebhookUrl] = useState(n?.webhookUrl ?? "");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [notifyOnInbox, setNotifyOnInbox] = useState(n?.notifyOnInbox ?? true);
  const [notifyOnDelivery, setNotifyOnDelivery] = useState(n?.notifyOnDelivery ?? true);
  const [notifyOnFailure, setNotifyOnFailure] = useState(n?.notifyOnFailure ?? true);
  const [publicBaseUrl, setPublicBaseUrl] = useState(n?.publicBaseUrl ?? "");
  const [actionSecret, setActionSecret] = useState("");
  const [githubWebhookSecret, setGithubWebhookSecret] = useState("");
  const [mcpCopied, setMcpCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testingNotify, setTestingNotify] = useState(false);
  const [notifyMsg, setNotifyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState("");

  const notificationPayload = () => ({
    macosEnabled,
    webhookEnabled,
    webhookUrl: webhookUrl.trim() || undefined,
    webhookSecret: webhookSecret.trim() || undefined,
    notifyOnInbox,
    notifyOnDelivery,
    notifyOnFailure,
  });

  const guard = async (setBusy: (v: boolean) => void, fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Models & roles persist immediately inside ModelRegistryStudio; this saves only notifications / secrets.
  const save = () =>
    guard(setSaving, async () => {
      const updated = await api.configureSetup({
        syncRepos: false,
        notifications: {
          ...notificationPayload(),
          publicBaseUrl: publicBaseUrl.trim() || undefined,
          actionSecret: actionSecret.trim() || undefined,
          githubWebhookSecret: githubWebhookSecret.trim() || undefined,
        },
      });
      await onSaved(updated);
      onClose();
    });

  const testNotification = () =>
    guard(setTestingNotify, async () => {
      setNotifyMsg(null);
      const res = await api.testNotification(notificationPayload());
      setNotifyMsg(
        res.results.length === 0
          ? { ok: false, text: t("setup.notifyEnableFirst") }
          : { ok: res.ok, text: res.results.map((r) => `${r.channel}: ${r.detail ?? (r.ok ? "ok" : "failed")}`).join(" | ") },
      );
    });

  const copyMcp = () => {
    const snippet = JSON.stringify(
      { mcpServers: { "super-work": { command: "bun", args: ["run", "packages/cli/src/index.ts", "mcp"] } } },
      null,
      2,
    );
    void navigator.clipboard?.writeText(snippet).then(() => {
      setMcpCopied(true);
      window.setTimeout(() => setMcpCopied(false), 1800);
    });
  };

  return (
    <div className="space-y-6 text-xs">
      <ModelRegistryStudio setupStatus={setupStatus} onSetupSaved={onSaved} />

      {/* Notifications */}
      <section className="space-y-3 pt-2 border-t border-zinc-800/80">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2 font-semibold text-zinc-200">
              <Bell className="w-4 h-4 text-amber-400" />
              {t("setup.notificationsTitle")}
            </div>
            <p className="text-[11px] text-zinc-400 mt-0.5">{t("setup.notificationsDesc")}</p>
          </div>
          <button
            type="button"
            onClick={() => void testNotification()}
            disabled={testingNotify}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-amber-500/40 bg-amber-500/15 hover:bg-amber-500/25 text-amber-200 text-[11px] disabled:opacity-50 shrink-0"
          >
            <Send className="w-3 h-3" />
            {testingNotify ? t("setup.testingNotification") : t("setup.testNotificationBtn")}
          </button>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
          <div className="flex flex-wrap gap-4">
            <Check checked={macosEnabled} onChange={setMacosEnabled} label={t("setup.macosNotifyLabel")} />
            <Check checked={webhookEnabled} onChange={setWebhookEnabled} label={t("setup.webhookNotifyLabel")} />
          </div>
          {webhookEnabled && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-zinc-400 mb-1">{t("setup.webhookUrl")}</label>
                <input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..." className={INPUT} />
              </div>
              <div>
                <label className="block text-zinc-400 mb-1">
                  {t("setup.webhookSecret")}
                  {n?.hasWebhookSecret && <span className="ml-2 text-[10px] text-emerald-400">({t("setup.webhookSecretSavedHint")})</span>}
                </label>
                <input type="password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} placeholder="Optional HMAC secret" className={INPUT} />
              </div>
            </div>
          )}
          <div className="flex flex-wrap gap-4 pt-1 text-[11px] text-zinc-300">
            <Check checked={notifyOnInbox} onChange={setNotifyOnInbox} label={t("setup.notifyOnInbox")} />
            <Check checked={notifyOnDelivery} onChange={setNotifyOnDelivery} label={t("setup.notifyOnDelivery")} />
            <Check checked={notifyOnFailure} onChange={setNotifyOnFailure} label={t("setup.notifyOnFailure")} />
          </div>
          {notifyMsg && (
            <div className={`p-2.5 rounded-lg border text-[11px] ${notifyMsg.ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-rose-500/30 bg-rose-500/10 text-rose-300"}`}>
              {notifyMsg.text}
            </div>
          )}
        </div>
      </section>

      {/* MCP + remote webhooks */}
      <section className="space-y-3 pt-2 border-t border-zinc-800/80">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div>
            <h4 className="font-semibold text-zinc-200 flex items-center gap-1.5">
              <Plug className="w-3.5 h-3.5 text-teal-400" />
              {t("setup.mcpWebhookTitle")}
            </h4>
            <p className="text-[11px] text-zinc-400 mt-0.5">{t("setup.mcpWebhookDesc")}</p>
          </div>
          <button
            type="button"
            onClick={copyMcp}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-teal-500/40 bg-teal-500/10 hover:bg-teal-500/20 text-teal-200 text-[11px] shrink-0"
          >
            <Copy className="w-3 h-3" />
            {mcpCopied ? t("setup.mcpCopied") : t("setup.mcpCopyBtn")}
          </button>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
          <div>
            <label className="block text-zinc-400 mb-1">{t("setup.publicBaseUrl")}</label>
            <input value={publicBaseUrl} onChange={(e) => setPublicBaseUrl(e.target.value)} placeholder="https://my-mac.tailnet.ts.net:4318" className={INPUT} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <div className="flex items-center justify-between gap-2 mb-1">
                <label className="text-zinc-400">
                  {t("setup.actionSecret")}
                  {n?.hasActionSecret && <span className="ml-1.5 text-[10px] text-emerald-400">({n.maskedActionSecret})</span>}
                </label>
                <button
                  type="button"
                  onClick={() =>
                    setActionSecret(`${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`)
                  }
                  className="inline-flex items-center gap-1 text-[10px] text-indigo-300 hover:text-indigo-200"
                >
                  <KeyRound className="w-2.5 h-2.5" />
                  {t("setup.generateSecretBtn")}
                </button>
              </div>
              <input value={actionSecret} onChange={(e) => setActionSecret(e.target.value)} placeholder="HMAC secret for /api/webhooks/action & chatops" className={INPUT} />
            </div>
            <div>
              <label className="block text-zinc-400 mb-1">
                {t("setup.githubWebhookSecret")}
                {n?.hasGithubWebhookSecret && <span className="ml-1.5 text-[10px] text-emerald-400">({n.maskedGithubWebhookSecret})</span>}
              </label>
              <input type="password" value={githubWebhookSecret} onChange={(e) => setGithubWebhookSecret(e.target.value)} placeholder="Secret configured on GitHub /api/webhooks/github" className={INPUT} />
            </div>
          </div>
        </div>
      </section>

      {error && <div className="p-3 rounded-lg border border-rose-500/30 bg-rose-500/10 text-rose-300 break-words">{error}</div>}

      <div className="flex flex-wrap items-center justify-end gap-3 pt-2 border-t border-zinc-800/80">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium disabled:opacity-50"
        >
          {saving ? t("setup.saving") : t("setup.saveActivate")}
        </button>
      </div>
    </div>
  );
}
