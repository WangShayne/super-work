import { spawn, type ChildProcess } from "node:child_process";
import type { PreviewProvider, PreviewSession } from "@super-work/core";
import { newId, nowIso } from "@super-work/core";
import { allocateFreeLocalPort } from "../workspace/git-worktree-provider.ts";

interface ManagedPreviewRecord {
  session: PreviewSession;
  child: ChildProcess | null;
  ttlTimer: ReturnType<typeof setTimeout> | null;
  exited: boolean;
  exitedPromise: Promise<void>;
  createdOrder: number;
}

export class WorktreePreviewManager implements PreviewProvider {
  private readonly maxConcurrent: number;
  private readonly defaultTtlMinutes: number;
  private readonly startupTimeoutMs: number;
  private readonly records = new Map<string, ManagedPreviewRecord>();
  private readonly listeners = new Set<(session: PreviewSession) => void>();
  private orderCounter = 0;

  constructor(options?: {
    maxConcurrent?: number;
    defaultTtlMinutes?: number;
    startupTimeoutMs?: number;
  }) {
    this.maxConcurrent = Math.max(1, options?.maxConcurrent ?? 3);
    this.defaultTtlMinutes = Math.max(1, options?.defaultTtlMinutes ?? 20);
    this.startupTimeoutMs = Math.max(1_000, options?.startupTimeoutMs ?? 15_000);
  }

  subscribe(listener: (session: PreviewSession) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(session: PreviewSession): void {
    for (const listener of this.listeners) {
      try {
        listener(session);
      } catch {
        // Isolate subscriber exceptions
      }
    }
  }

  async startPreview(input: {
    repoId: string;
    ticketId: string;
    candidateId?: string;
    label: string;
    worktreePath: string;
    command: string;
    ttlMinutes?: number;
  }): Promise<PreviewSession> {
    const cleanCmd = input.command.trim();
    if (!cleanCmd) {
      throw new Error("Preview start command is empty (configure previewCommand or smokeCheck.startCommand).");
    }

    // Reuse existing active preview for the exact same ticket/candidate/worktree
    for (const rec of this.records.values()) {
      if (
        (rec.session.status === "starting" || rec.session.status === "ready") &&
        rec.session.ticketId === input.ticketId &&
        (rec.session.candidateId ?? "") === (input.candidateId ?? "") &&
        rec.session.worktreePath === input.worktreePath
      ) {
        return (await this.renewPreview(rec.session.id, input.ttlMinutes)) ?? rec.session;
      }
    }

    // Evict oldest active preview if at maxConcurrent
    const active = Array.from(this.records.values())
      .filter((r) => r.session.status === "starting" || r.session.status === "ready")
      .sort((a, b) => a.createdOrder - b.createdOrder);
    while (active.length >= this.maxConcurrent) {
      const oldest = active.shift();
      if (oldest) {
        await this.stopPreview(oldest.session.id);
      }
    }

    const port = await allocateFreeLocalPort();
    const url = `http://127.0.0.1:${port}`;
    const ttlMin = Math.max(1, Math.min(180, input.ttlMinutes ?? this.defaultTtlMinutes));
    const startedAt = nowIso();
    const expiresAt = new Date(Date.now() + ttlMin * 60_000).toISOString();
    const id = newId("prv");

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(port),
      SUPER_WORK_PREVIEW_PORT: String(port),
      SUPER_WORK_PREVIEW_URL: url,
      SUPER_WORK_SMOKE_PORT: String(port),
      SUPER_WORK_SMOKE_URL: url,
    };
    delete env.SUPER_WORK_TOKEN;
    delete env.SUPER_WORK_LLM_API_KEY;

    const child = spawn("sh", ["-lc", cleanCmd], {
      cwd: input.worktreePath,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let resolveExited!: () => void;
    const exitedPromise = new Promise<void>((res) => {
      resolveExited = res;
    });

    const record: ManagedPreviewRecord = {
      session: {
        id,
        repoId: input.repoId,
        ticketId: input.ticketId,
        candidateId: input.candidateId,
        label: input.label,
        worktreePath: input.worktreePath,
        command: cleanCmd,
        port,
        url,
        status: "starting",
        pid: child.pid,
        outputTail: "",
        startedAt,
        expiresAt,
      },
      child,
      ttlTimer: null,
      exited: false,
      exitedPromise,
      createdOrder: ++this.orderCounter,
    };

    const appendTail = (chunk: Buffer | string) => {
      const combined = `${record.session.outputTail}${String(chunk)}`;
      record.session = {
        ...record.session,
        outputTail: combined.length > 3000 ? combined.slice(-3000) : combined,
      };
    };
    child.stdout?.on("data", appendTail);
    child.stderr?.on("data", appendTail);

    child.once("exit", (code) => {
      record.exited = true;
      resolveExited();
      if (record.ttlTimer) {
        clearTimeout(record.ttlTimer);
        record.ttlTimer = null;
      }
      if (record.session.status === "starting" || record.session.status === "ready") {
        record.session = {
          ...record.session,
          status: record.session.status === "starting" ? "failed" : "stopped",
          error:
            record.session.status === "starting"
              ? `Preview process exited early (code=${code ?? "null"})`
              : undefined,
        };
        this.emit(record.session);
      }
    });
    child.once("error", (err) => {
      record.exited = true;
      resolveExited();
      record.session = {
        ...record.session,
        status: "failed",
        error: err.message,
      };
      this.emit(record.session);
    });

    this.scheduleTtl(record, ttlMin * 60_000);
    this.records.set(id, record);
    this.emit(record.session);

    // Poll readiness asynchronously so UI gets immediate session handle, OR transitions cleanly to ready
    void this.pollUntilReady(record);
    return record.session;
  }

  private scheduleTtl(record: ManagedPreviewRecord, ms: number): void {
    if (record.ttlTimer) {
      clearTimeout(record.ttlTimer);
    }
    record.ttlTimer = setTimeout(() => {
      void this.stopPreview(record.session.id);
    }, ms);
    record.ttlTimer.unref();
  }

  private async pollUntilReady(record: ManagedPreviewRecord): Promise<void> {
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (record.exited || record.session.status !== "starting") return;
      try {
        const res = await fetch(record.session.url, {
          signal: AbortSignal.timeout(1_000),
        });
        if (res.status >= 200 && res.status < 500) {
          record.session = {
            ...record.session,
            status: "ready",
          };
          this.emit(record.session);
          return;
        }
      } catch {
        // Server still binding
      }
      await new Promise<void>((r) => setTimeout(r, 150));
    }

    if (record.session.status === "starting" && !record.exited) {
      record.session = {
        ...record.session,
        status: "failed",
        error: `Timed out waiting ${this.startupTimeoutMs}ms for ${record.session.url}`,
      };
      this.emit(record.session);
    }
  }

  async stopPreview(previewId: string): Promise<PreviewSession | null> {
    const rec = this.records.get(previewId);
    if (!rec) return null;
    if (rec.ttlTimer) {
      clearTimeout(rec.ttlTimer);
      rec.ttlTimer = null;
    }

    rec.session = {
      ...rec.session,
      status: "stopped",
    };

    const pid = rec.child?.pid;
    if (pid && !rec.exited) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          rec.child?.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
      await Promise.race([rec.exitedPromise, new Promise<void>((r) => setTimeout(r, 1_000))]);
      if (!rec.exited) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          try {
            rec.child?.kill("SIGKILL");
          } catch {
            // ignore
          }
        }
        await Promise.race([rec.exitedPromise, new Promise<void>((r) => setTimeout(r, 400))]);
      }
    }

    this.emit(rec.session);
    return rec.session;
  }

  async stopPreviewsForTicket(ticketId: string): Promise<number> {
    const matching = Array.from(this.records.values()).filter(
      (r) =>
        r.session.ticketId === ticketId &&
        (r.session.status === "starting" || r.session.status === "ready"),
    );
    for (const rec of matching) {
      await this.stopPreview(rec.session.id);
    }
    return matching.length;
  }

  async renewPreview(previewId: string, ttlMinutes?: number): Promise<PreviewSession | null> {
    const rec = this.records.get(previewId);
    if (!rec || (rec.session.status !== "starting" && rec.session.status !== "ready")) {
      return null;
    }
    const mins = Math.max(1, Math.min(180, ttlMinutes ?? this.defaultTtlMinutes));
    rec.session = {
      ...rec.session,
      expiresAt: new Date(Date.now() + mins * 60_000).toISOString(),
    };
    this.scheduleTtl(rec, mins * 60_000);
    this.emit(rec.session);
    return rec.session;
  }

  async listPreviews(repoId?: string): Promise<PreviewSession[]> {
    const list = Array.from(this.records.values())
      .map((r) => r.session)
      .filter((s) => (!repoId || s.repoId === repoId) && s.status !== "stopped");
    return list;
  }

  async stopAll(): Promise<void> {
    const ids = Array.from(this.records.keys());
    await Promise.all(ids.map((id) => this.stopPreview(id)));
    this.records.clear();
  }
}
