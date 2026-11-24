import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { BackupArchiveInfo, DoctorCheckItem, SystemDoctorReport } from "../types.ts";
import { isTerminalTicketStatus, newId, nowIso } from "../utils.ts";
import type { KernelCoordinatorContext } from "./context.ts";

export async function runSystemDoctor(
  ctx: KernelCoordinatorContext,
  options?: { fix?: boolean },
): Promise<SystemDoctorReport> {
  const fix = Boolean(options?.fix);
  const items: DoctorCheckItem[] = [];
  let fixesApplied = 0;

  // 1. SQLite integrity & WAL status
  if (ctx.stateStore.checkDatabaseIntegrity) {
    try {
      const dbRes = await ctx.stateStore.checkDatabaseIntegrity();
      items.push({
        id: "sqlite_integrity",
        category: "sqlite",
        status: dbRes.ok ? "ok" : "error",
        title: "SQLite Quick Integrity Check",
        detail: `${dbRes.detail}${dbRes.walPages !== undefined ? ` (WAL pages=${dbRes.walPages})` : ""}`,
        fixable: false,
      });
    } catch (err) {
      items.push({
        id: "sqlite_integrity",
        category: "sqlite",
        status: "error",
        title: "SQLite Quick Integrity Check",
        detail: err instanceof Error ? err.message : String(err),
        fixable: false,
      });
    }
  }

  // 2. Reclaimable / orphan worktrees
  const wtItems = await ctx.inspectWorktrees().catch(() => []);
  const reclaimableWt = wtItems.filter((w) => w.reclaimable);
  if (reclaimableWt.length > 0 && fix) {
    const gcRes = await ctx.gcWorktrees().catch(() => null);
    const cleaned = gcRes?.removedPaths.length ?? 0;
    if (cleaned > 0) fixesApplied += cleaned;
    items.push({
      id: "worktrees_gc",
      category: "worktree",
      status: "ok",
      title: "Worktree Pool Hygiene",
      detail: `Cleaned ${cleaned} reclaimable/orphan worktree(s)`,
      fixable: true,
      fixed: cleaned > 0,
      count: 0,
    });
  } else {
    items.push({
      id: "worktrees_gc",
      category: "worktree",
      status: reclaimableWt.length > 0 ? "warn" : "ok",
      title: "Worktree Pool Hygiene",
      detail:
        reclaimableWt.length > 0
          ? `${reclaimableWt.length} reclaimable or orphan worktree(s) ready for GC`
          : `${wtItems.length} active worktree(s), zero reclaimable clutter`,
      fixable: reclaimableWt.length > 0,
      count: reclaimableWt.length,
    });
  }

  // 3. Stale or dead Live Previews
  const previews = ctx.previewProvider ? await ctx.previewProvider.listPreviews().catch(() => []) : [];
  const stalePreviews = previews.filter((p) => {
    const expired = Date.parse(p.expiresAt) < Date.now();
    const missingDir = !p.worktreePath || !existsSync(p.worktreePath);
    return (p.status !== "ready" && p.status !== "starting") || expired || missingDir;
  });
  if (stalePreviews.length > 0 && fix && ctx.previewProvider) {
    let stoppedCount = 0;
    for (const p of stalePreviews) {
      await ctx.previewProvider.stopPreview(p.id).catch(() => {});
      stoppedCount += 1;
    }
    fixesApplied += stoppedCount;
    items.push({
      id: "preview_processes",
      category: "preview",
      status: "ok",
      title: "Live Worktree Preview Processes",
      detail: `Stopped ${stoppedCount} stale/expired preview process(es)`,
      fixable: true,
      fixed: stoppedCount > 0,
      count: 0,
    });
  } else {
    items.push({
      id: "preview_processes",
      category: "preview",
      status: stalePreviews.length > 0 ? "warn" : "ok",
      title: "Live Worktree Preview Processes",
      detail:
        stalePreviews.length > 0
          ? `${stalePreviews.length} stale or expired preview session(s) detected`
          : `${previews.length} active preview session(s), all healthy`,
      fixable: stalePreviews.length > 0,
      count: stalePreviews.length,
    });
  }

  // 4. Lingering hidden checkpoint Git refs on terminal/missing tickets
  const repos = await ctx.stateStore.listRepos();
  const staleRefs: Array<{ rootRepoPath: string; ref: string; ticketId: string }> = [];
  if (ctx.workspace.listCheckpointRefs) {
    const tickets = await ctx.stateStore.listTickets();
    const ticketById = new Map(tickets.map((t) => [t.id, t]));
    for (const repo of repos) {
      const refs = await ctx.workspace.listCheckpointRefs(repo.rootPath).catch(() => []);
      for (const r of refs) {
        const tkt = ticketById.get(r.ticketId);
        if (!tkt || isTerminalTicketStatus(tkt.status)) {
          staleRefs.push({ rootRepoPath: repo.rootPath, ref: r.ref, ticketId: r.ticketId });
        }
      }
    }
  }
  if (staleRefs.length > 0 && fix && ctx.workspace.deleteGitRef) {
    const cleanedTickets = new Set<string>();
    let deletedCount = 0;
    for (const sr of staleRefs) {
      const ok = await ctx.workspace.deleteGitRef(sr.rootRepoPath, sr.ref).catch(() => false);
      if (ok) {
        deletedCount += 1;
        cleanedTickets.add(sr.ticketId);
      }
    }
    const ts = nowIso();
    for (const tid of cleanedTickets) {
      await ctx.stateStore.markCheckpointsCleaned(tid, ts).catch(() => {});
    }
    fixesApplied += deletedCount;
    items.push({
      id: "hidden_checkpoint_refs",
      category: "git_ref",
      status: "ok",
      title: "Hidden Checkpoint Git Refs",
      detail: `Pruned ${deletedCount} stale hidden ref(s) across ${cleanedTickets.size} terminal ticket(s)`,
      fixable: true,
      fixed: deletedCount > 0,
      count: 0,
    });
  } else {
    items.push({
      id: "hidden_checkpoint_refs",
      category: "git_ref",
      status: staleRefs.length > 0 ? "warn" : "ok",
      title: "Hidden Checkpoint Git Refs",
      detail:
        staleRefs.length > 0
          ? `${staleRefs.length} lingering refs/super-work/checkpoints/* ref(s) on completed/deleted tickets`
          : "No stale hidden checkpoint refs",
      fixable: staleRefs.length > 0,
      count: staleRefs.length,
    });
  }

  return {
    healthy: items.every((i) => i.status === "ok"),
    checkedAt: nowIso(),
    fixesApplied,
    items,
  };
}

export async function createSystemBackup(ctx: KernelCoordinatorContext): Promise<BackupArchiveInfo> {
  if (!ctx.stateStore.vacuumIntoBackup) {
    throw new Error("Configured StateStore does not support online VACUUM INTO hot backups.");
  }
  const backupsDir = resolve(ctx.dataDir, "backups");
  mkdirSync(backupsDir, { recursive: true });
  const id = newId("bkp");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `super-work-backup-${stamp}-${id.slice(-6)}.sqlite`;
  const filePath = join(backupsDir, filename);

  await ctx.stateStore.vacuumIntoBackup(filePath);
  const st = statSync(filePath);
  const dbIntegrityOk = ctx.stateStore.checkDatabaseIntegrity
    ? (await ctx.stateStore.checkDatabaseIntegrity().catch(() => ({ ok: true }))).ok
    : true;

  const info: BackupArchiveInfo = {
    id,
    filename,
    filePath,
    byteSize: st.size,
    createdAt: nowIso(),
    dbIntegrityOk,
  };
  writeFileSync(join(backupsDir, `${filename}.meta.json`), JSON.stringify(info, null, 2), "utf8");
  return info;
}

export async function listSystemBackups(dataDir: string): Promise<BackupArchiveInfo[]> {
  const backupsDir = resolve(dataDir, "backups");
  if (!existsSync(backupsDir)) {
    return [];
  }
  const entries = readdirSync(backupsDir).filter((name) => name.endsWith(".sqlite"));
  const archives: BackupArchiveInfo[] = entries.map((filename) => {
    const filePath = join(backupsDir, filename);
    const st = statSync(filePath);
    const metaPath = join(backupsDir, `${filename}.meta.json`);
    if (existsSync(metaPath)) {
      try {
        const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as BackupArchiveInfo;
        return { ...parsed, byteSize: st.size, filePath };
      } catch {
        // fallback below
      }
    }
    return {
      id: basename(filename, ".sqlite"),
      filename,
      filePath,
      byteSize: st.size,
      createdAt: st.mtime.toISOString(),
    };
  });
  return archives.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
