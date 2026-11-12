// Re-embeds vault entries whose vector is missing or was made by another embedding model.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { generateEmbedding } from '../memory/embeddings.js';
import { embeddingModelKey } from '../memory/embedding-model.js';

const logger = createLogger('vault-embedding-refresh');

// Entries with a NULL embedding never match a semantic vault_search, so re-embed them (best effort, up to `limit`).
export async function reembedNullVaultEntries(limit = 200): Promise<number> {
  return reembedVaultEntries('embedding IS NULL', limit);
}

// Re-embeds entries with another model's vector (or none); callers loop until none are left
// (see memory/embedding-switch.ts).
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
