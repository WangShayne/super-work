import { useState, type FormEvent } from "react";
import { api } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import type { MilestoneIntegrationMode } from "../types.ts";

/** Split a Markdown bullet / numbered list (or plain lines) into individual requirements. */
export function parseMilestoneRequirements(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
}

interface MilestoneDispatchFormProps {
  repoId: string;
  onClose: () => void;
  onCreated?: () => Promise<void> | void;
}

export function MilestoneDispatchForm({ repoId, onClose, onCreated }: MilestoneDispatchFormProps) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [version, setVersion] = useState("");
  const [text, setText] = useState("");
  const [integrationMode, setIntegrationMode] = useState<MilestoneIntegrationMode>("milestone_branch");
  const [preferredRoute, setPreferredRoute] = useState<"auto" | "single_ticket">("auto");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const requirements = parseMilestoneRequirements(text);
  const canSubmit = Boolean(repoId && name.trim() && requirements.length > 0);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError("");
    try {
      await api.createMilestone({
        repoId,
        name: name.trim(),
        targetVersion: version.trim() || undefined,
        requirements,
        integrationMode,
        preferredRoute,
      });
      await onCreated?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3 text-xs">
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <label className="block text-zinc-400 mb-1">{t("milestone.nameLabel")}</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("milestone.namePlaceholder")}
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500"
          />
        </div>
        <div>
          <label className="block text-zinc-400 mb-1">{t("milestone.versionLabel")}</label>
          <input
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            placeholder={t("milestone.versionPlaceholder")}
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-zinc-400 mb-1">{t("milestone.integrationLabel")}</label>
          <select
            value={integrationMode}
            onChange={(e) => setIntegrationMode(e.target.value as MilestoneIntegrationMode)}
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-zinc-200 focus:outline-none focus:border-indigo-500"
          >
            <option value="milestone_branch">{t("milestone.integration.milestone_branch")}</option>
            <option value="direct_main">{t("milestone.integration.direct_main")}</option>
          </select>
        </div>
        <div>
          <label className="block text-zinc-400 mb-1">{t("milestone.routeLabel")}</label>
          <select
            value={preferredRoute}
            onChange={(e) => setPreferredRoute(e.target.value as "auto" | "single_ticket")}
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-zinc-200 focus:outline-none focus:border-indigo-500"
          >
            <option value="auto">{t("milestone.route.auto")}</option>
            <option value="single_ticket">{t("milestone.route.single_ticket")}</option>
          </select>
        </div>
      </div>
      <div>
        <label className="block text-zinc-400 mb-1">{t("milestone.requirementsLabel")}</label>
        <textarea
          rows={8}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("milestone.requirementsPlaceholder")}
          className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500 font-mono"
        />
        <div className="mt-1 text-zinc-500">
          {t("milestone.requirementsCount")}: {requirements.length}
        </div>
      </div>
      {error && <div className="text-rose-400">{error}</div>}
      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 rounded-lg border border-zinc-800 text-zinc-400 hover:text-zinc-200"
        >
          {t("modal.dispatch.cancel")}
        </button>
        <button
          type="submit"
          disabled={submitting || !canSubmit}
          className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium disabled:opacity-50"
        >
          {submitting ? t("modal.dispatch.submitting") : t("milestone.createBtn")}
        </button>
      </div>
    </form>
  );
}
