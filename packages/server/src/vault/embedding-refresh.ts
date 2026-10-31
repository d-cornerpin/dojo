// ════════════════════════════════════════
// Re-embedding vault entries whose vector is missing or was made by another embedding model.
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { generateEmbedding } from '../memory/embeddings.js';
import { embeddingModelKey } from '../memory/embedding-model.js';

const logger = createLogger('vault-embedding-refresh');

// D17: some vault entries carry a NULL embedding (a pre-C12 Ollama 500-and-drop at create time, or an
// embed outage). semanticSearch requires a vector, so those can NEVER match a semantic vault_search,
// only an exact LIKE lookup. Re-embed them once so they become findable. Best effort, up to `limit`
// per call; anything still failing is retried on the next pass. Returns how many were re-embedded.
export async function reembedNullVaultEntries(limit = 200): Promise<number> {
  return reembedVaultEntries('embedding IS NULL', limit);
}

/**
 * After the embedding model is switched: re-embed the entries whose vector was made by another model
 * (or none), up to `limit` per call. The caller loops until none are left or none can be done, and
 * only calls this when the new model is free to use (memory/embedding-switch.ts).
 */
export async function reembedStaleVaultEntries(limit = 200): Promise<number> {
  return reembedVaultEntries('(embedding IS NULL OR embedding_model IS NOT ?)', limit, [embeddingModelKey()]);
}

async function reembedVaultEntries(where: string, limit: number, whereParams: unknown[] = []): Promise<number> {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, content FROM vault_entries WHERE ${where} AND is_obsolete = 0 LIMIT ?`,
  ).all(...whereParams, limit) as Array<{ id: string; content: string }>;
  let fixed = 0;
  for (const row of rows) {
    try {
      const model = embeddingModelKey();   // read before the call: the label of the model that makes this vector
      const emb = await generateEmbedding(row.content);
      db.prepare('UPDATE vault_entries SET embedding = ?, embedding_model = ? WHERE id = ?').run(Buffer.from(emb.buffer), model, row.id);
      fixed++;
    } catch { /* best effort, retry next pass */ }
  }
  if (fixed > 0) logger.info('Re-embedded vault entries', { fixed });
  return fixed;
}
