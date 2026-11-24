import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ArtifactKind, ArtifactStore, SpillArtifact } from "@super-work/core";
import { newId, nowIso } from "@super-work/core";

export class FsArtifactStore implements ArtifactStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = resolve(baseDir);
  }

  async writeSpill(
    meta: { ticketId: string; stageRunId?: string; kind: ArtifactKind; summary: string; ext?: string },
    content: string,
  ): Promise<SpillArtifact> {
    const id = newId("art");
    const ext = meta.ext ?? "txt";
    const dir = join(this.baseDir, meta.ticketId);
    await mkdir(dir, { recursive: true });

    const filePath = join(dir, `${id}.${ext}`);
    await writeFile(filePath, content, "utf8");
    const byteSize = Buffer.byteLength(content, "utf8");

    return {
      id,
      ticketId: meta.ticketId,
      stageRunId: meta.stageRunId,
      kind: meta.kind,
      summary: meta.summary,
      storageUri: filePath,
      byteSize,
      createdAt: nowIso(),
    };
  }

  async readSpill(storageUri: string): Promise<string> {
    return readFile(storageUri, "utf8");
  }

  async writeBinarySpill(
    meta: { ticketId: string; stageRunId?: string; kind: ArtifactKind; summary: string; ext?: string },
    data: Uint8Array,
  ): Promise<SpillArtifact> {
    const id = newId("art");
    const ext = meta.ext ?? "bin";
    const dir = join(this.baseDir, meta.ticketId);
    await mkdir(dir, { recursive: true });

    const filePath = join(dir, `${id}.${ext}`);
    await writeFile(filePath, data);

    return {
      id,
      ticketId: meta.ticketId,
      stageRunId: meta.stageRunId,
      kind: meta.kind,
      summary: meta.summary,
      storageUri: filePath,
      byteSize: data.byteLength,
      createdAt: nowIso(),
    };
  }

  async readBinarySpill(storageUri: string): Promise<Uint8Array> {
    const buf = await readFile(storageUri);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
}
