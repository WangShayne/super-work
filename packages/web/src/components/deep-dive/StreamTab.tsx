import { Compass, FileCode2, FolderGit2, GitFork, Layers, Link2, Lock, Sparkles, Wrench, Zap } from "lucide-react";
import { api } from "../../api.ts";
import { DagCanvas } from "../DagCanvas.tsx";
import { HandoverDigestView } from "./HandoverDigestView.tsx";
import { scopedVerificationForRun } from "./scopedVerification.ts";
import { formatStage, formatTicketStatus, useI18n } from "../../i18n.tsx";
import type { EnginePreference, LiveEventLogEntry, RepoConfig, Ticket, TicketDetailResponse } from "../../types.ts";

export interface StreamTabProps {
  ticketId: string;
  ticket: Ticket | undefined;
  detail: TicketDetailResponse | null;
  repos: RepoConfig[];
  reposById: Map<string, RepoConfig>;
  childSubtasks: Ticket[];
  ticketLiveEvents: LiveEventLogEntry[];
  deliveryError: string | null;
  evalNotice: string | null;
  steerInstruction: string;
  setSteerInstruction: (v: string) => void;
  steerEngine: EnginePreference | "";
  setSteerEngine: (v: EnginePreference | "") => void;
  steering: boolean;
  handleLiveSteer: (e: React.FormEvent) => Promise<void>;
  setDetail: (d: TicketDetailResponse) => void;
  onRefresh: () => void;
  onSelectTicket?: (ticketId: string) => void;
}

export function StreamTab({
  ticketId,
  ticket,
  detail,
  repos,
  reposById,
  childSubtasks,
  ticketLiveEvents,
  deliveryError,
  evalNotice,
  steerInstruction,
  setSteerInstruction,
  steerEngine,
  setSteerEngine,
  steering,
  handleLiveSteer,
  setDetail,
  onRefresh,
  onSelectTicket,
}: StreamTabProps) {
  const { locale, t } = useI18n();
  return (
    <div className="space-y-5">
      {ticket?.errorMessage && (
        <div className="p-3 rounded-lg border border-rose-500/30 bg-rose-500/10 text-xs text-rose-200">
          <strong>{t("drawer.attention")}</strong> {ticket.errorMessage}
        </div>
      )}
      {deliveryError && (
        <div className="p-3 rounded-lg border border-rose-500/30 bg-rose-500/10 text-xs text-rose-200">
          <strong>{t("drawer.attention")}</strong> {deliveryError}
        </div>
      )}
      {evalNotice && (
        <div className="p-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-xs text-emerald-200">
          {evalNotice}
        </div>
      )}

      {ticket &&
        ["planning", "spec_testing", "implementing", "reviewing"].includes(
          ticket.status,
        ) && (
          <form
            onSubmit={handleLiveSteer}
            className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3 space-y-2 text-xs"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Compass className="w-3.5 h-3.5 text-sky-400 shrink-0" />
              <input
                type="text"
                value={steerInstruction}
                onChange={(e) => setSteerInstruction(e.target.value)}
                placeholder={t("drawer.liveSteerPlaceholder")}
                className="flex-1 min-w-[200px] bg-zinc-950 border border-zinc-800 rounded-md px-2.5 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-sky-500"
              />
              <select
                value={steerEngine}
                onChange={(e) => setSteerEngine(e.target.value as EnginePreference | "")}
                className="bg-zinc-950 border border-zinc-800 rounded-md px-2 py-1.5 text-[11px] font-mono text-zinc-300"
              >
                <option value="">keep engine</option>
                <option value="auto">auto</option>
                <option value="claude">claude</option>
                <option value="codex">codex</option>
                <option value="opencode">opencode</option>
                <option value="gemini">gemini</option>
                <option value="mock">mock</option>
              </select>
              <button
                type="submit"
                disabled={steering || !steerInstruction.trim()}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-sky-600 hover:bg-sky-500 text-white text-[11px] font-medium disabled:opacity-40 transition"
              >
                <Compass className="w-3 h-3" />
                {t("drawer.liveSteerBtn")}
              </button>
            </div>
          </form>
        )}

      {ticket &&
        (ticket.routingRationale ||
          (ticket.lockedTestPaths && ticket.lockedTestPaths.length > 0) ||
          ticket.impactSummary) && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 text-xs space-y-2">
            {ticket.routingRationale && (
              <div className="flex items-start gap-2">
                <Sparkles className="w-3.5 h-3.5 text-indigo-400 shrink-0 mt-0.5" />
                <div>
                  <span className="text-zinc-400 font-medium mr-1.5">
                    {t("drawer.routingRationaleLabel")}:
                  </span>
                  <span className="text-zinc-200 font-mono text-[11px]">
                    {ticket.routingRationale}
                  </span>
                </div>
              </div>
            )}
            {ticket.lockedTestPaths && ticket.lockedTestPaths.length > 0 && (
              <div className="flex items-start gap-2">
                <Lock className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" />
                <div>
                  <span className="text-zinc-400 font-medium mr-1.5">
                    {t("drawer.lockedTestsLabel")}:
                  </span>
                  <span className="text-rose-200 font-mono text-[11px]">
                    {ticket.lockedTestPaths.join(", ")}
                  </span>
                </div>
              </div>
            )}
            {ticket.impactSummary && (
              <div className="flex items-start gap-2">
                <GitFork className="w-3.5 h-3.5 text-cyan-400 shrink-0 mt-0.5" />
                <div>
                  <span className="text-zinc-400 font-medium mr-1.5">
                    {t("drawer.impactSummaryLabel")}:
                  </span>
                  <span className="text-cyan-200 font-mono text-[11px]">
                    {ticket.impactSummary.directDependents.join(", ") || "—"} /{" "}
                    {ticket.impactSummary.transitiveDependents.join(", ") || "—"}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

      {ticket?.isEpic && (ticket.epicReplanHistory?.length || ticket.pendingEpicReplan) && (
        <div className="rounded-lg border border-purple-500/30 bg-purple-500/5 p-3 text-xs space-y-1.5">
          <div className="font-semibold text-purple-300 flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5" />
            {t("drawer.epicReplanSection")} ({ticket.epicReplanHistory?.length ?? 0}/2)
          </div>
          {ticket.pendingEpicReplan && (
            <p className="text-amber-300 text-[11px]">
              ⏳ {ticket.pendingEpicReplan.summary}
            </p>
          )}
          {ticket.epicReplanHistory?.map((rep, idx) => (
            <p key={idx} className="text-zinc-300 text-[11px]">
              #{idx + 1} · {rep.summary}
            </p>
          ))}
        </div>
      )}

      {ticket?.isEpic && childSubtasks.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-purple-300 flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5" />
            {t("drawer.epicDagTitle")} ({childSubtasks.length})
          </h3>
          <DagCanvas
            tickets={childSubtasks}
            repos={repos}
            onInspectTicket={(id) => onSelectTicket?.(id)}
            onMutated={() => {
              if (ticketId) {
                api.getTicketDetail(ticketId).then(setDetail).catch(() => {});
              }
              onRefresh();
            }}
          />
          <div className="space-y-2">
            {childSubtasks.map((sub) => {
              const subRepoName = reposById.get(sub.repoId)?.name;
              return (
                <div
                  key={sub.id}
                  onClick={() => onSelectTicket?.(sub.id)}
                  className="rounded-lg border border-zinc-800 bg-zinc-900/60 hover:border-indigo-500/50 p-3 text-xs flex items-center justify-between gap-3 cursor-pointer transition"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      {sub.subtaskKey && (
                        <span className="px-1.5 py-0.5 rounded bg-purple-500/15 border border-purple-500/30 text-purple-200 font-mono text-[10px]">
                          {sub.subtaskKey}
                        </span>
                      )}
                      {subRepoName && (repos.length > 1 || sub.repoId !== ticket.repoId) && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-sky-500/15 border border-sky-500/30 text-sky-300 font-mono text-[10px]">
                          <FolderGit2 className="w-2.5 h-2.5" />
                          {subRepoName}
                        </span>
                      )}
                      <span className="font-medium text-zinc-100 truncate">{sub.title}</span>
                    </div>
                    <div className="text-[10px] font-mono text-zinc-400">
                      {sub.mandate.allowedPaths.join(", ")}
                      {sub.dependsOn.length > 0
                        ? ` · deps: ${sub.dependsOn.join(", ")}`
                        : ""}
                    </div>
                  </div>
                  <span className="shrink-0 px-2 py-0.5 rounded bg-zinc-800 border border-zinc-700 font-mono text-[10px] text-zinc-200">
                    {formatTicketStatus(sub.status, locale)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {(detail?.upstreamDependencies?.length ?? 0) > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-teal-300 flex items-center gap-1.5">
            <Link2 className="w-3.5 h-3.5" />
            {t("drawer.upstreamHandoverTitle")} ({detail!.upstreamDependencies!.length})
          </h3>
          <div className="space-y-2">
            {detail!.upstreamDependencies!.map((dep) => (
              <div
                key={dep.id}
                className="rounded-lg border border-teal-500/25 bg-teal-500/5 p-3 text-xs space-y-2"
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <button
                    type="button"
                    onClick={() => onSelectTicket?.(dep.id)}
                    className="inline-flex items-center gap-1.5 text-left font-medium text-teal-200 hover:text-teal-100"
                  >
                    <span className="px-1.5 py-0.5 rounded bg-sky-500/15 border border-sky-500/30 font-mono text-[10px] text-sky-300">
                      {dep.repoName ?? dep.repoId}
                    </span>
                    <span>{dep.title}</span>
                    <span className="font-mono text-[10px] text-zinc-400">({dep.id})</span>
                  </button>
                  <span className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 font-mono text-[10px] text-zinc-300">
                    {formatTicketStatus(dep.status, locale)}
                  </span>
                </div>
                {dep.handoverDigest && (
                  <HandoverDigestView digest={dep.handoverDigest} />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {ticket?.handoverDigest && (
        <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/5 p-3.5 text-xs space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-indigo-300 flex items-center gap-1.5">
              <FileCode2 className="w-3.5 h-3.5" />
              {t("drawer.exportedHandoverTitle")}
            </span>
            <span className="px-1.5 py-0.5 rounded bg-indigo-500/15 border border-indigo-500/30 font-mono text-[10px] text-indigo-200">
              v{ticket.handoverDigest.version}
            </span>
          </div>
          <HandoverDigestView digest={ticket.handoverDigest} />
        </div>
      )}

      {ticket?.riskAssessment && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 text-xs space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-zinc-200">{t("drawer.riskTitle")}</span>
            <span
              className={`px-2 py-0.5 rounded border font-mono text-[10px] ${
                ticket.riskAssessment.level === "high"
                  ? "border-rose-500/40 bg-rose-500/15 text-rose-300"
                  : ticket.riskAssessment.level === "medium"
                    ? "border-amber-500/40 bg-amber-500/15 text-amber-200"
                    : "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
              }`}
            >
              {ticket.riskAssessment.score}/100 ({ticket.riskAssessment.level}) · {ticket.riskAssessment.policy}
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {ticket.riskAssessment.factors.map((f) => (
              <span
                key={f.key}
                className={`px-1.5 py-0.5 rounded border font-mono text-[10px] ${
                  f.delta > 0
                    ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
                    : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                }`}
              >
                {f.delta > 0 ? `+${f.delta}` : f.delta} {f.label}
              </span>
            ))}
          </div>
        </div>
      )}

      {ticket?.conflictContext && (
        <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3 text-xs space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-sky-200">{t("drawer.conflictTitle")}</span>
            <span
              className={`px-1.5 py-0.5 rounded border font-mono text-[10px] ${
                ticket.conflictContext.resolvedAutomatically
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                  : "border-amber-500/30 bg-amber-500/10 text-amber-200"
              }`}
            >
              {ticket.conflictContext.resolvedAutomatically
                ? t("drawer.conflictAutoResolved")
                : t("drawer.conflictEscalated")}
            </span>
          </div>
          <div className="font-mono text-[10px] text-zinc-400">
            {ticket.conflictContext.baseBranch} ({ticket.conflictContext.mergeBaseSha.slice(0, 8)}) ·{" "}
            {ticket.conflictContext.conflictFiles.join(", ")}
          </div>
          {ticket.conflictContext.resolutionSummary && (
            <p className="text-[11px] text-zinc-300">{ticket.conflictContext.resolutionSummary}</p>
          )}
        </div>
      )}

      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
          {t("drawer.stageRunsTitle")}
        </h3>
        {detail?.stageRuns.length === 0 ? (
          <p className="text-xs text-zinc-500">{t("drawer.noStageRuns")}</p>
        ) : (
          <div className="space-y-2">
            {detail?.stageRuns.map((run) => {
              const spans = run.spans ?? [];
              const scopedGate = scopedVerificationForRun(ticketLiveEvents, run.id);
              const totalSpanMs = Math.max(
                1,
                spans.reduce((acc, sp) => acc + Math.max(1, sp.durationMs), 0),
              );
              const spanBarColor = (kind: string, status: string) => {
                if (status === "failed") return "bg-rose-500";
                if (kind === "workspace_prep") return "bg-slate-400";
                if (kind === "worker_turn") return "bg-indigo-500";
                if (kind === "static_verify") return "bg-emerald-500";
                if (kind === "smoke_cdp") return "bg-cyan-500";
                if (kind === "visual_diff") return "bg-amber-500";
                return "bg-sky-400";
              };

              return (
                <div
                  key={run.id}
                  className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 text-xs space-y-1.5"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-semibold text-indigo-300">
                        {formatStage(run.stage, locale)}
                      </span>
                      <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 font-mono text-[10px]">
                        {run.engine}
                      </span>
                      <span
                        className={`px-1.5 py-0.5 rounded font-mono text-[10px] ${
                          run.status === "completed"
                            ? "bg-emerald-500/15 text-emerald-300"
                            : run.status === "running"
                              ? "bg-amber-500/15 text-amber-300"
                              : run.steered
                                ? "bg-sky-500/15 text-sky-300"
                                : "bg-rose-500/15 text-rose-300"
                        }`}
                      >
                        {run.steered ? "steered" : run.status}
                      </span>
                      {scopedGate?.usedScoped && (
                        <span
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 font-mono text-[10px]"
                          title={[scopedGate.reason, ...scopedGate.commandsRun].join("\n")}
                        >
                          <Zap className="w-3 h-3" />
                          {t("drawer.scopedGate")}
                          {(scopedGate.estimatedSavedMs ?? 0) > 0 && (
                            <span>
                              {" · "}
                              {t("drawer.scopedGateSaved")}
                              {Math.round((scopedGate.estimatedSavedMs ?? 0) / 1000)}s
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                    <span className="font-mono text-zinc-500">${run.costUsd.toFixed(3)}</span>
                  </div>
                  {spans.length > 0 && (
                    <div className="space-y-1 pt-0.5">
                      <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500">
                        <span>{t("drawer.spansTitle")}</span>
                        <span>{(totalSpanMs / 1000).toFixed(2)}s</span>
                      </div>
                      <div className="w-full h-2 rounded-full bg-zinc-950 border border-zinc-800 overflow-hidden flex gap-px">
                        {spans.map((sp, idx) => (
                          <div
                            key={`${sp.kind}_${idx}`}
                            title={`${sp.label}: ${sp.durationMs}ms (${sp.status})`}
                            style={{
                              width: `${Math.max(4, (Math.max(1, sp.durationMs) / totalSpanMs) * 100)}%`,
                            }}
                            className={`h-full ${spanBarColor(sp.kind, sp.status)}`}
                          />
                        ))}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {spans.map((sp, idx) => (
                          <span
                            key={`${sp.kind}_lbl_${idx}`}
                            className="px-1.5 py-0.2 rounded bg-zinc-950 border border-zinc-800 font-mono text-[10px] text-zinc-400"
                          >
                            {sp.kind}:{sp.durationMs}ms
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {run.toolProfile && run.toolProfile.totalToolCalls > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                      <span className="inline-flex items-center gap-1 text-[10px] font-mono text-zinc-500">
                        <Wrench className="w-2.5 h-2.5 text-zinc-400" />
                        {t("drawer.toolProfileTitle")}:
                      </span>
                      {run.toolProfile.byTool.slice(0, 8).map((tp) => (
                        <span
                          key={tp.toolName}
                          title={tp.sampleError ?? `${tp.approxDurationMs}ms`}
                          className={`px-1.5 py-0.2 rounded border font-mono text-[10px] ${
                            tp.errors > 0
                              ? "border-rose-500/35 bg-rose-500/10 text-rose-300"
                              : "border-zinc-800 bg-zinc-950 text-zinc-300"
                          }`}
                        >
                          {tp.toolName} ×{tp.calls}
                          {tp.errors > 0 ? ` (${tp.errors} err)` : ""}
                        </span>
                      ))}
                    </div>
                  )}
                  {run.summary && (
                    <p className="text-zinc-300 whitespace-pre-wrap leading-relaxed">
                      {run.summary}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
          {t("drawer.liveEventsTitle")}
        </h3>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3 font-mono text-[11px] space-y-1.5 max-h-80 overflow-y-auto">
          {ticketLiveEvents.length === 0 ? (
            <span className="text-zinc-600">
              {t("drawer.listeningEvents")}
            </span>
          ) : (
            ticketLiveEvents.map((ev) => (
              <div key={ev.id} className="flex gap-2">
                <span className="text-zinc-600 shrink-0">
                  {ev.timestamp.slice(11, 19)}
                </span>
                <span className="text-indigo-400 shrink-0">[{ev.kind}]</span>
                <span className="text-zinc-300 break-all">{ev.summary}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
