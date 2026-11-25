// FTS memory index and search storage helpers (extracted from sqlite-state-store.ts).
import type { Database } from "bun:sqlite";
import type {
  MemorySearchHit,
} from "@super-work/core";

export function indexMemoryDocument(
  db: Database,
  doc: {
  entityType: string;
  entityId: string;
  ticketId: string;
  repoId: string;
  title: string;
  body: string;
  },
): void {
  const tx = db.transaction(() => {
    db
      .query("DELETE FROM memory_fts WHERE entity_type = ? AND entity_id = ?")
      .run(doc.entityType, doc.entityId);
    db
      .query(
        "INSERT INTO memory_fts (entity_type, entity_id, ticket_id, repo_id, title, body) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(doc.entityType, doc.entityId, doc.ticketId, doc.repoId, doc.title, doc.body);
  });
  tx();
}

export function searchMemoryByMatch(
  db: Database,
  ftsQuery: string,
  limit: number,
  repoId?: string,
): MemorySearchHit[] {
  const sql = repoId
    ? `SELECT entity_type, entity_id, ticket_id, repo_id, title,
              snippet(memory_fts, 5, '[', ']', '...', 18) AS snippet
       FROM memory_fts
       WHERE memory_fts MATCH ? AND repo_id = ?
       ORDER BY bm25(memory_fts)
       LIMIT ?`
    : `SELECT entity_type, entity_id, ticket_id, repo_id, title,
              snippet(memory_fts, 5, '[', ']', '...', 18) AS snippet
       FROM memory_fts
       WHERE memory_fts MATCH ?
       ORDER BY bm25(memory_fts)
       LIMIT ?`;

  const rows = (
    repoId ? db.query(sql).all(ftsQuery, repoId, limit) : db.query(sql).all(ftsQuery, limit)
  ) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    entityType: String(r.entity_type),
    entityId: String(r.entity_id),
    ticketId: String(r.ticket_id),
    repoId: String(r.repo_id),
    title: String(r.title),
    snippet: String(r.snippet ?? ""),
  }));
}
