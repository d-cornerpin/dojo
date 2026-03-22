// ════════════════════════════════════════
// Vector Search (Phase 5C)
// Cosine similarity search over embeddings
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { generateEmbedding } from './embeddings.js';

const logger = createLogger('vector-search');

// ── Cosine Similarity ──

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

// ── Search Result ──

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
    sourceType?: 'all' | 'message' | 'summary';
    minSimilarity?: number;
  },
): Promise<VectorSearchResult[]> {
  const limit = options?.limit ?? 10;
  const sourceType = options?.sourceType ?? 'all';
  const minSimilarity = options?.minSimilarity ?? 0.3;

  logger.info('Vector search', { query: query.slice(0, 80), agentId, limit, sourceType });

  // Generate embedding for the query
  const queryEmbedding = await generateEmbedding(query);

  // Load embeddings from DB
  const db = getDb();
  const conditions: string[] = ['1=1'];
  const params: unknown[] = [];

  if (agentId) {
    conditions.push('agent_id = ?');
    params.push(agentId);
  }

  if (sourceType !== 'all') {
    conditions.push('source_type = ?');
    params.push(sourceType);
  }

  const where = conditions.join(' AND ');

  const rows = db.prepare(`
    SELECT id, source_type, source_id, agent_id, content_preview, embedding, dimensions
    FROM embeddings
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

  // FTS5 search
  const ftsResults: Array<{ sourceType: string; sourceId: string; preview: string; score: number }> = [];
  try {
    const ftsRows = db.prepare(`
      SELECT m.id, m.content, m.role, rank
      FROM messages_fts fts
      JOIN messages m ON m.rowid = fts.rowid
      WHERE messages_fts MATCH ? AND m.agent_id = ?
      ORDER BY rank
      LIMIT ?
    `).all(query, agentId, limit) as Array<{ id: string; content: string; role: string; rank: number }>;

    for (const row of ftsRows) {
      ftsResults.push({
        sourceType: 'message',
        sourceId: row.id,
        preview: row.content.slice(0, 200),
        score: -row.rank, // FTS5 rank is negative (lower = better)
      });
    }
  } catch {
    // FTS query might fail on special characters
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
