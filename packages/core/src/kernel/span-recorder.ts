import type { StageSpan, StageSpanKind } from "../types.ts";
import { nowIso } from "../utils.ts";

export interface ActiveSpanHandle {
  kind: StageSpanKind;
  label: string;
  startedAt: string;
  startedMs: number;
}

export class SpanRecorder {
  private readonly spans: StageSpan[] = [];

  start(kind: StageSpanKind, label: string): ActiveSpanHandle {
    return {
      kind,
      label,
      startedAt: nowIso(),
      startedMs: Date.now(),
    };
  }

  end(
    handle: ActiveSpanHandle,
    status: StageSpan["status"] = "ok",
    detail?: string,
  ): StageSpan {
    const endedAt = nowIso();
    const span: StageSpan = {
      kind: handle.kind,
      label: handle.label,
      startedAt: handle.startedAt,
      endedAt,
      durationMs: Math.max(0, Date.now() - handle.startedMs),
      status,
      ...(detail ? { detail } : {}),
    };
    this.spans.push(span);
    return span;
  }

  addExisting(spans?: StageSpan[]): void {
    if (!spans || spans.length === 0) return;
    this.spans.push(...spans);
  }

  toArray(): StageSpan[] {
    return [...this.spans];
  }
}
