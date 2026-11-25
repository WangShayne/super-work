import { useI18n } from "../../i18n.tsx";

export function CloseFooter({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  return (
    <div className="shrink-0 border-t border-zinc-800 bg-zinc-900/95 px-5 py-3 flex justify-end">
      <button
        type="button"
        onClick={onClose}
        className="px-3 py-1.5 rounded-lg border border-zinc-800 text-zinc-400 hover:text-zinc-200"
      >
        {t("modal.worktrees.close")}
      </button>
    </div>
  );
}
