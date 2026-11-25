import type { ParsedSseEvent } from "../client.ts";

export function extractEventTicketId(data: Record<string, unknown>): string | undefined {
  return (
    (data.ticketId as string | undefined) ??
    ((data.ticket as { id?: string } | undefined)?.id) ??
    ((data.checkpoint as { ticketId?: string } | undefined)?.ticketId) ??
    ((data.item as { ticketId?: string } | undefined)?.ticketId) ??
    ((data.entry as { ticketId?: string } | undefined)?.ticketId) ??
    ((data.signal as { ticketId?: string } | undefined)?.ticketId)
  );
}

export function formatEventLine(ev: ParsedSseEvent, watchedTicketId?: string): string {
  const data = ev.data;
  const evTicketId = extractEventTicketId(data);
  const childPrefix =
    watchedTicketId && evTicketId && evTicketId !== watchedTicketId ? `[${evTicketId}] ` : "";

  if (ev.event === "worker_event") {
    const engine = String(data.engine ?? "worker");
    const inner = (data.event ?? {}) as Record<string, unknown>;
    const type = String(inner.type ?? "event");
    const detail =
      (inner.toolName ? `${inner.toolName}(${String(inner.inputSummary ?? "").slice(0, 80)})` : undefined) ??
      (inner.text as string | undefined) ??
      (inner.summary as string | undefined) ??
      (inner.message as string | undefined) ??
      "";
    return `${childPrefix}[${engine}:${type}] ${detail}`.trim();
  }
  if (ev.event === "ticket_updated" || ev.event === "ticket_created") {
    const t = data.ticket as { id?: string; status?: string; currentStage?: string; title?: string } | undefined;
    return `${childPrefix}[${ev.event}] status=${t?.status ?? "?"} stage=${t?.currentStage ?? "?"}`;
  }
  if (ev.event === "stage_started" || ev.event === "stage_completed") {
    const run = data.stageRun as { stage?: string; engine?: string; status?: string; summary?: string } | undefined;
    return `${childPrefix}[${ev.event}] ${run?.stage ?? "?"} (${run?.engine ?? "?"}) status=${run?.status ?? "?"}${run?.summary ? `: ${run.summary.slice(0, 120)}` : ""}`;
  }
  if (ev.event === "verification_completed") {
    const res = data.result as
      | {
          ok?: boolean;
          summary?: string;
          scopedVerification?: { usedScoped?: boolean; estimatedSavedMs?: number };
        }
      | undefined;
    const scoped = res?.scopedVerification;
    const scopedTag = scoped?.usedScoped
      ? ` [scoped gate${scoped.estimatedSavedMs ? `, saved ~${Math.round(scoped.estimatedSavedMs / 1000)}s` : ""}]`
      : "";
    return `${childPrefix}[verification]${scopedTag} ${res?.ok ? "PASS" : "FAIL"}: ${res?.summary ?? ""}`;
  }
  if (ev.event === "playbook_updated") {
    const entry = data.entry as { id?: string; source?: string; rule?: string } | undefined;
    return entry
      ? `[playbook_updated] (${entry.source}) ${entry.rule ?? entry.id}`
      : `[playbook_updated] deleted=${String(data.deletedId ?? "")}`;
  }
  if (ev.event === "routine_run_updated") {
    const run = data.run as { routineId?: string; status?: string; summary?: string } | undefined;
    return `[routine_run] ${run?.routineId ?? "?"} status=${run?.status ?? "?"}${run?.summary ? `: ${run.summary.slice(0, 100)}` : ""}`;
  }
  if (ev.event === "epic_replanned") {
    const prop = data.proposal as { summary?: string } | undefined;
    return `[epic_replanned] epic=${String(data.epicId ?? "?")} auto=${String(Boolean(data.autoApplied))} :: ${prop?.summary ?? ""}`;
  }
  if (ev.event === "preview_updated") {
    const p = data.preview as { id?: string; ticketId?: string; status?: string; url?: string } | undefined;
    return `[preview_updated] ${p?.id ?? "?"} (${p?.ticketId ?? "?"}) status=${p?.status ?? "?"} ${p?.url ?? ""}`.trim();
  }
  if (ev.event === "campaign_updated") {
    const cmp = data.campaign as { id?: string; status?: string; currentValue?: number } | undefined;
    return cmp
      ? `[campaign] ${cmp.id ?? "?"} status=${cmp.status ?? "?"} value=${cmp.currentValue ?? "?"}`
      : `[campaign] deleted=${String(data.deletedId ?? "")}`;
  }
  if (ev.event === "merge_train_updated") {
    const entries = (data.entries as Array<{ id: string; status: string }> | undefined) ?? [];
    return `[merge_train] repo=${String(data.repoId ?? "?")} entries=${entries.length}`;
  }
  if (ev.event === "checkpoint_created") {
    const cp = data.checkpoint as
      | { id?: string; ticketId?: string; stage?: string; commitSha?: string; label?: string }
      | undefined;
    return `[checkpoint_created] ${cp?.id ?? "?"} ticket=${cp?.ticketId ?? "?"} stage=${cp?.stage ?? "?"} sha=${cp?.commitSha?.slice(0, 8) ?? "?"} :: ${cp?.label ?? ""}`.trim();
  }
  return `${childPrefix}[${ev.event}] ${JSON.stringify(data).slice(0, 140)}`;
}

export function formatTranscriptLines(rawJsonl: string, limit = 40): string[] {
  const lines = rawJsonl
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      const ev = JSON.parse(line) as Record<string, unknown>;
      const type = String(ev.type ?? "event");
      if (type === "thought") {
        out.push(`    [thought] ${String(ev.text ?? "").slice(0, 120)}`);
      } else if (type === "tool_use") {
        out.push(`    [tool_use] ${String(ev.toolName ?? "tool")}(${String(ev.inputSummary ?? "").slice(0, 80)})`);
      } else if (type === "tool_result") {
        out.push(
          `    [tool_result] ${String(ev.toolName ?? "tool")} ${ev.isError ? "ERR" : "ok"}: ${String(ev.outputSummary ?? "").slice(0, 90)}`,
        );
      } else if (type === "text") {
        out.push(`    [text] ${String(ev.text ?? "").slice(0, 140)}`);
      } else if (type === "completed") {
        out.push(`    [completed] ${String(ev.summary ?? "").slice(0, 140)}`);
      } else if (type === "error") {
        out.push(`    [error] ${String(ev.message ?? "").slice(0, 140)}`);
      }
    } catch {
      // Ignore malformed transcript line
    }
  }
  return out;
}

export function printHelp(stdout: (line: string) => void): void {
  stdout(`super-work v1.5.0 CLI

Usage:
  super-work up [-d|--detach] [--host 127.0.0.1] [--port 4318] [--data-dir path] [--token <token>]
  super-work service [install [--no-start] | uninstall | start | stop | status | logs [--lines 80]] [--host <addr>] [--port <n>] [--data-dir <path>] [--token <token>] [--json]
  super-work reload [--force] [--skip-canary] [--auto-start] [--json]
  super-work mcp [--url http://localhost:4318] [--token <token>] [--no-auto-start]
  super-work status [--repo <id>] [--auto-start] [--json]
  super-work intake <requirement> [--title <title>] [--repo <id>] [--route auto|single_ticket|epic_dag|goal_campaign]
                    [--template fast|standard|strict] [--engine auto|claude|codex|opencode|gemini|mock] [--tdd]
                    [--gate-policy always_auto|risk_gated|always_signoff] [--budget <usd>]
                    [--metric <cmd> --target <num> [--direction increase|decrease] [--unit <u>]]
                    [--preview-only] [--wait] [--timeout-ms <ms>] [--auto-start] [--json]
  super-work wait <ticketOrEpicId> [--timeout-ms <ms>] [--auto-start] [--json]
  super-work ask <question> [--repo <id>] [--auto-start] [--json]
  super-work steer <ticketId> <instruction> [--engine auto|claude|codex|opencode|gemini|mock] [--auto-start] [--json]
  super-work dispatch <title> [-d|--desc <text>] [--repo <id>] [--blueprint <id>] [--gate-policy <policy>] [--paths <csv>] [--depends-on <csv>]
                      [--template fast|standard|strict] [--engine auto|claude|codex|opencode|gemini|mock]
                      [--tdd] [--pause-before-run] [--arena [engine]] [--clarify] [--clarify-only]
                      [--budget <usd>] [--wait] [--auto-start] [--json]
  super-work epic <title> [-d|--desc <text>] [--repo <id>] [--template fast|standard|strict] [--tdd]
                  [--engine auto|...] [--preview-only] [--per-subtask] [--wait] [--auto-start] [--json]
  super-work campaign [list | get <id> | create <name> -d <prompt> --metric <cmd> --target <num> [--direction increase|decrease] [--unit <u>] [--regex <re>] [--delivery-mode staging_branch|per_wave_merge] [--max-iter 5] [--budget 5] [--paths <csv>] [--start] | start <id> [-m <note>] | pause <id> [-m <reason>] | deliver <id> [--action local_merge|push_and_create_pr] | delete <id>] [--repo <id>] [--auto-start] [--json]
  super-work milestone [list | create --name <n> [--version <v>] [--repo <id>] [--template fast|standard|strict] [--engine <e>] [--budget <usd>] [--integration direct_main|milestone_branch] [--route auto|single_ticket] <req...> | show <id> | release <id> [--bump] [--tag] [--push] [--squash] [-m <commit message>]] [--auto-start] [--json]
  super-work train [list | flush | eject <entryId> [-m <reason>]] [--repo <id>] [--auto-start] [--json]
  super-work blueprints [--repo <id>] [--auto-start] [--json]
  super-work doctor [--fix] [--auto-start] [--json]
  super-work engines [status | reset <engine> | probe [engine]] [--auto-start] [--json]
  super-work digest [--repo <id>] [--hours <n>] [--markdown] [--json] [--auto-start]
  super-work backup [list | create | restore <backupId> [--force]] [--auto-start] [--json]
  super-work bundle [export <repoId> [-o <path>] | import <repoId> <path>] [--auto-start] [--json]
  super-work eval [list [--repo <id>] | save <ticketId> | run <evalCaseId> [--engines <csv>] [--budget <usd>] | runs [--repo <id>]] [--auto-start] [--json]
  super-work impact [--repo <id>] [--paths <csv>] [--auto-start] [--json]
  super-work checkpoint [list <ticketId> | diff <ticketId> <cpId> [--base <cpId>] |
                         restore <ticketId> <cpId> [--mode in_place|fork] [-m <prompt>] [--stage <stage>] [--engine <eng>]]
  super-work dag [pause <ticketId> | resume <ticketId> | rerun <ticketId> |
                  set <ticketId> [--engine auto|...] [--paths <csv>] [--depends-on <csv>] [-d <desc>] [--tdd|--no-tdd] [--breakpoint]]
  super-work inbox [list | approve <id> [--expand-mandate] [--local-merge] [--budget-add <usd>] [--winner <candId>] [-m <note>] | reject <id> [-m <note>] |
                    batch --decision <approved|rejected> [--repo <id>] [--low-risk] [--ids <csv>] [-m <note>]]
  super-work preview [list | start <ticketId> [--candidate <candId>] | stop <previewId>] [--repo <id>] [--json]
  super-work routine [list | add <name> -d <prompt> [--cron <expr> | --every <min>] [--window HH:MM-HH:MM] [--paths <csv>] [--budget <usd>] | run <id> | toggle <id> | runs [--routine <id>] | delete <id>]
  super-work casebook [list | search <query>] [--repo <id>] [--auto-start] [--json]
  super-work playbook [list | add <rule> [--paths <csv>] [--pin] | toggle <entryId> | delete <entryId> | prune | sync [--export]] [--repo <id>] [--auto-start] [--json]
  super-work logs <ticketId> [-f|--follow] [--auto-start] [--json]
  super-work watch [--repo <id>] [--ticket <id>] [--timeout-ms <ms>] [--auto-start] [--json]
  super-work revert <ticketId> [--auto-start] [--json]

Env / Flags:
  SUPER_WORK_URL     Daemon base URL (default: http://localhost:4318) or --url
  SUPER_WORK_TOKEN   Optional Bearer token for remote access or --token`);
}
