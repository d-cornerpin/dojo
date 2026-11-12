// WHAT KEEPS AN EMBEDDING ALIVE: `embeddings` is polymorphic (`source_type`, `source_id`), so no foreign key.
// A LEAF with NO imports: tests replace `embeddings.js` with a partial `vi.mock` that an import would break.

export type EmbeddingSourceType = 'message' | 'summary' | 'technique';

/** The table whose surviving row keeps an embedding of this kind true; a kind without one is a compile error. */
export const EMBEDDING_SOURCE_TABLES: Record<EmbeddingSourceType, string> = {
  message: 'messages',
  summary: 'summaries',
  technique: 'techniques',
};

/** A source row that exists but is NOT knowledge: a not-yet-condensed note is never embedded or served. */
const NOT_EMBEDDABLE: Partial<Record<EmbeddingSourceType, string>> = { summary: "src.kind = 'uncondensed'" };
const embeddable = (kind: string): string => {
  const excluded = Object.hasOwn(NOT_EMBEDDABLE, kind) ? NOT_EMBEDDABLE[kind as EmbeddingSourceType] : undefined;
  return excluded ? ` AND NOT (${excluded})` : '';
};

/** A SQL predicate over an aliased `embeddings` row, true while its source exists. FAIL-CLOSED on an undeclared
 *  kind (a silent dead-preview serve is worse than a visible census failure); table names come only from the map. */
export function embeddingSourceAliveSql(alias = 'e'): string {
  const arms = Object.entries(EMBEDDING_SOURCE_TABLES).map(
    ([kind, table]) =>
      `(${alias}.source_type = '${kind}' AND EXISTS (SELECT 1 FROM ${table} src WHERE src.id = ${alias}.source_id${embeddable(kind)}))`,
  );
  return `(${arms.join(' OR ')})`;
}

export const UNDECLARED_EMBEDDING_KIND_WARNING =
  'Embedding discarded: its source kind declares no liveness table';

/** The liveness table for a kind, or `null` when undeclared (only untyped callers and legacy rows reach it). */
export function embeddingSourceTableFor(kind: string): string | null {
  return Object.prototype.hasOwnProperty.call(EMBEDDING_SOURCE_TABLES, kind)
    ? EMBEDDING_SOURCE_TABLES[kind as EmbeddingSourceType]
    : null;
}

interface EmbeddingWriteDb {
  prepare(sql: string): { run(...params: unknown[]): { changes: number } };
}

export interface EmbeddingRow {
  id: string;
  sourceType: EmbeddingSourceType;
  sourceId: string;
  agentId: string | null;
  preview: string;
  vector: Buffer;
  dimensions: number;
  model?: string | null;
}

/** Write an embedding ONLY WHILE ITS SOURCE IS STILL THERE (false when it has gone). One statement, not a check
 *  then an insert: a source deleted during the model call would otherwise leave an orphan no trigger can reach. */
export function insertEmbeddingIfSourceAlive(
  db: EmbeddingWriteDb,
  row: EmbeddingRow,
  /** Unknown kind: reported, nothing written, never thrown (a fire-and-forget write); injected, no import. */
  onUnknownKind?: (kind: string) => void,
): boolean {
  const table = embeddingSourceTableFor(row.sourceType);
  if (table === null) {
    onUnknownKind?.(row.sourceType);
    return false;
  }
  const result = db.prepare(`
    INSERT INTO embeddings (id, source_type, source_id, agent_id, content_preview, embedding, dimensions, embedding_model, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, datetime('now')
     WHERE EXISTS (SELECT 1 FROM ${table} src WHERE src.id = ?${embeddable(row.sourceType)})
  `).run(
    row.id, row.sourceType, row.sourceId, row.agentId, row.preview,
    row.vector, row.dimensions, row.model ?? null, row.sourceId,
  );
  return result.changes > 0;
}
