// ════════════════════════════════════════
// Vector Search (Phase 5C)
// Cosine similarity search over embeddings
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { generateEmbedding } from './embeddings.js';
import { embeddingSourceAliveSql } from './embedding-sources.js';
import { ftsSafeQuery } from './fts-query.js';
import { ftsCandidateRowidFloor } from './search-bounds.js';
import { embeddingModelKey } from './embedding-model.js';

const logger = createLogger('vector-search');

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dotProduct / denom;
}

export interface VectorSearchResult {
  sourceType: string;
  sourceId: string;
  preview: string;
  similarity: number;
  agentId: string | null;
}

// ── Vector Search ──

export async function vectorSearch(
  query: string,
  agentId?: string,
  options?: {
    limit?: number;
    sourceType?: 'all' | 'message' | 'summary' | 'technique';
    minSimilarity?: number;
    // D4: a pre-computed query embedding. When the caller already embedded the
    // per-turn recall query (assembler auto-recall), pass it so the same query
    // isn't re-embedded once per search lane (messages + summaries + vault).
    queryEmbedding?: Float32Array;
  },
): Promise<VectorSearchResult[]> {
  const limit = options?.limit ?? 10;
  const sourceType = options?.sourceType ?? 'all';
  const minSimilarity = options?.minSimilarity ?? 0.3;

  logger.info('Vector search', { query: query.slice(0, 80), agentId, limit, sourceType });

  // Reuse the caller's embedding when provided; otherwise embed the query.
  const queryEmbedding = options?.queryEmbedding ?? await generateEmbedding(query, { agentId });

  // Load embeddings from DB
  const db = getDb();
  const conditions: string[] = ['1=1'];
  const params: unknown[] = [];

  if (agentId) {
    conditions.push('e.agent_id = ?');
    params.push(agentId);
  }

  if (sourceType !== 'all') {
    conditions.push('e.source_type = ?');
    params.push(sourceType);
  }

  // ── AN EMBEDDING MAY NOT SERVE ONCE ITS SOURCE IS GONE (BACKLOG-CAMPAIGN) ──────────────
  // This read used to take `content_preview` with no liveness check at all, and previews are
  // served straight to the caller — so a row whose message had been deleted still surfaced as a
  // semantic hit carrying the first 200 characters of content the platform had already deleted.
  // Measured on the owner's box at the time of the fix: 645 such rows, 630 of them messages.
  //
  // The cascades (triggers) are the CLEANUP; this is the SERVE-SIDE half, and it is deliberately
  // not redundant. A trigger cannot fire for rows lost to a `DROP TABLE`, which is how the 630
  // came to exist across four rebuilds of `messages` — so the cleanup alone can only ever
  // promise "clean right now", while this promises "cannot serve, ever, however it got here".
  // The predicate is built from `EMBEDDING_SOURCE_TABLES`, the one declared map, so a new source
  // kind cannot be silently half-wired.
  conditions.push(embeddingSourceAliveSql('e'));

  conditions.push('e.embedding_model = ?'); params.push(embeddingModelKey());   // one model's vectors only: embedding-model.ts

  const where = conditions.join(' AND ');

  const rows = db.prepare(`
    SELECT e.id, e.source_type, e.source_id, e.agent_id, e.content_preview, e.embedding, e.dimensions
    FROM embeddings e
    WHERE ${where}
  `).all(...params) as Array<{
    id: string;
    source_type: string;
    source_id: string;
    agent_id: string | null;
    content_preview: string;
    embedding: Buffer;
    dimensions: number;
  }>;

  // Score each embedding
  const scored: VectorSearchResult[] = [];

  for (const row of rows) {
    const embedding = new Float32Array(
      row.embedding.buffer,
      row.embedding.byteOffset,
      row.dimensions,
    );
    const similarity = cosineSimilarity(queryEmbedding, embedding);

    if (similarity >= minSimilarity) {
      scored.push({
        sourceType: row.source_type,
        sourceId: row.source_id,
        preview: row.content_preview,
        similarity,
        agentId: row.agent_id,
      });
    }
  }

  // Sort by similarity descending
  scored.sort((a, b) => b.similarity - a.similarity);

  return scored.slice(0, limit);
}

// ── Hybrid Search (FTS5 + Vector) ──

export async function hybridSearch(
  query: string,
  agentId: string,
  options?: { limit?: number },
): Promise<Array<{ source: 'fts' | 'vector'; sourceType: string; sourceId: string; preview: string; score: number }>> {
  const limit = options?.limit ?? 10;

  // Run both searches in parallel
  const db = getDb();

  // FTS5 search — the keyword arm. It must stay in line with `searchMessagesInner` in
  // retrieval.ts, the path that owns it. Three drifts are corrected here, each the reason this
  // half silently went dead in the field: the MATCH text is FTS-safe (`ftsSafeQuery`, so a `?`,
  // `.`, `'` or `-` in the question does not throw a syntax error that the catch swallows and
  // drops the keyword half entirely); it ranks only the newest `FTS_CANDIDATE_ROWS` rows (a
  // common term over a large table is a full synchronous B-tree walk on the serving thread); and
  // it drops the agent's own pure tool_use echo (`isPureToolCallMessage`), which would otherwise
  // trigger the grep-the-grep loop.
  const ftsResults: Array<{ sourceType: string; sourceId: string; preview: string; score: number }> = [];
  const pattern = ftsSafeQuery(query, 8);
  if (pattern.length > 0) {
    try {
      // Dynamic import: retrieval.ts already imports this module dynamically, so a static import
      // here would close the cycle.
      const { isPureToolCallMessage } = await import('./retrieval.js');

      const maxSeq = (db.prepare('SELECT MAX(seq) AS r FROM messages WHERE agent_id = ?').get(agentId) as { r: number | null } | undefined)?.r ?? 0;
      const candidateFloor = ftsCandidateRowidFloor(maxSeq);

      // Over-fetch, then drop echoes, then keep the first `limit` — the same shape as
      // `searchMessagesInner`, so the two arms cannot drift apart again.
      const fetchLimit = limit * 3;
      const params: unknown[] = [pattern, agentId];
      let floorClause = '';
      if (candidateFloor > 0) {
        floorClause = ' AND fts.rowid > ?';
        params.push(candidateFloor);
      }
      params.push(fetchLimit);

      const ftsRows = db.prepare(`
        SELECT m.id, m.content, m.role, rank
        FROM messages_fts fts
        JOIN messages m ON m.rowid = fts.rowid
        WHERE messages_fts MATCH ? AND m.agent_id = ?${floorClause}
        ORDER BY rank
        LIMIT ?
      `).all(...params) as Array<{ id: string; content: string; role: string; rank: number }>;

      const kept = ftsRows.filter((r) => !isPureToolCallMessage(r.content)).slice(0, limit);
      for (const row of kept) {
        ftsResults.push({
          sourceType: 'message',
          sourceId: row.id,
          preview: row.content.slice(0, 200),
          score: -row.rank, // FTS5 rank is negative (lower = better)
        });
      }
    } catch (error) {
      // Message text only — never the query text, which is user input and must not land in logs.
      logger.warn('hybrid search keyword arm failed', { patternChars: query.length, error });
    }
  }

  // Vector search
  let vectorResults: VectorSearchResult[] = [];
  try {
    vectorResults = await vectorSearch(query, agentId, { limit, sourceType: 'all' });
  } catch {
    // Vector search might fail if no embeddings or model unavailable
  }

  // Merge and deduplicate
  const seen = new Set<string>();
  const merged: Array<{ source: 'fts' | 'vector'; sourceType: string; sourceId: string; preview: string; score: number }> = [];

  // Normalize scores to [0,1] range
  const maxFtsScore = ftsResults.length > 0 ? Math.max(...ftsResults.map(r => r.score)) : 1;
  const ftsNorm = maxFtsScore > 0 ? maxFtsScore : 1;

  for (const r of ftsResults) {
    const key = `${r.sourceType}:${r.sourceId}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push({ source: 'fts', ...r, score: r.score / ftsNorm });
    }
  }

  for (const r of vectorResults) {
    const key = `${r.sourceType}:${r.sourceId}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push({
        source: 'vector',
        sourceType: r.sourceType,
        sourceId: r.sourceId,
        preview: r.preview,
        score: r.similarity,
      });
    }
  }

  // Sort by score descending
  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, limit);
}
