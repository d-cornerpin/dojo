// Generates embeddings for sources with no vector from the current model: the scheduled drain.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { storeEmbedding } from './embeddings.js';
import { embeddingModelKey, readEmbeddingConfig } from './embedding-model.js';

const logger = createLogger('backfill');

// Cap per run: a months-deep backlog embedded in one pass would peg the local embedder for hours.
// The boot drain (index.ts) re-fires on an interval; embedded rows drop out via the LEFT JOIN.
const BACKFILL_PER_RUN_CAP = 500;

let backfillRunning = false;
let backfillProgress = { total: 0, completed: 0, failed: 0 };

export function isBackfillRunning(): boolean {
  return backfillRunning;
}

export function getBackfillProgress(): typeof backfillProgress {
  return { ...backfillProgress };
}

// The same floor `storeEmbedding` applies, so a row it would skip is never picked (and never counted failed).
const LONG_ENOUGH = (t: string): string => `length(trim(${t}.content, char(9, 10, 13, 32))) >= 20`;

export async function runBackfill(): Promise<{ completed: number; failed: number; total: number }> {
  if (backfillRunning) {
    throw new Error('Backfill is already running');
  }

  backfillRunning = true;
  backfillProgress = { total: 0, completed: 0, failed: 0 };

  const db = getDb();
  const model = embeddingModelKey();
  // Another model's vector is re-made only on a local embedder (it costs nothing); otherwise any vector counts as done.
  const local = readEmbeddingConfig().provider === 'ollama';
  if (!local) logger.debug('Embedding model is not local: vectors made by another model are not re-made automatically', { model });
  const current = local ? model : null;

  try {
    // Un-embedded messages with sufficient content, capped to the per-run budget.
    const messages = db.prepare(`
      SELECT m.id, m.agent_id, m.content
      FROM messages m
      LEFT JOIN embeddings e ON e.source_type = 'message' AND e.source_id = m.id AND e.embedding_model = COALESCE(?, e.embedding_model)
      WHERE e.id IS NULL AND ${LONG_ENOUGH('m')}
      ORDER BY m.created_at
      LIMIT ?
    `).all(current, BACKFILL_PER_RUN_CAP) as Array<{ id: string; agent_id: string; content: string }>;

    // Collect un-embedded summaries (also capped, oldest first).
    const summaries = db.prepare(`
      SELECT s.id, s.agent_id, s.content
      FROM summaries s
      LEFT JOIN embeddings e ON e.source_type = 'summary' AND e.source_id = s.id AND e.embedding_model = COALESCE(?, e.embedding_model)
      WHERE e.id IS NULL AND s.kind != 'uncondensed' AND ${LONG_ENOUGH('s')}
      ORDER BY s.created_at
      LIMIT ?
    `).all(current, BACKFILL_PER_RUN_CAP) as Array<{ id: string; agent_id: string; content: string }>;

    // Un-embedded techniques: intent surface only (name, description, tags), since recall matches
    // the ask against what a technique is for.
    const techniques = db.prepare(`
      SELECT t.id, t.name, t.description, t.tags
      FROM techniques t
      LEFT JOIN embeddings e ON e.source_type = 'technique' AND e.source_id = t.id AND e.embedding_model = COALESCE(?, e.embedding_model)
      WHERE e.id IS NULL
      ORDER BY t.created_at
      LIMIT ?
    `).all(current, BACKFILL_PER_RUN_CAP) as Array<{ id: string; name: string; description: string | null; tags: string | null }>;

    // One combined per-run budget; messages first so a deep message backlog drains before the tails.
    const messageItems = messages.map(m => ({ type: 'message' as const, id: m.id, agentId: m.agent_id, content: m.content }));
    const summaryItems = summaries.map(s => ({ type: 'summary' as const, id: s.id, agentId: s.agent_id, content: s.content }));
    const items: Array<{ type: 'message' | 'summary' | 'technique'; id: string; agentId: string | null; content: string }> = [
      ...messageItems, ...summaryItems,
      ...techniques.map(t => {
        let tags: string[] = [];
        try { tags = JSON.parse(t.tags ?? '[]'); } catch { /* malformed tags column */ }
        return { type: 'technique' as const, id: t.id, agentId: null, content: `${t.name}\n${t.description ?? ''}\n${tags.join(' ')}` };
      }),
    ].slice(0, BACKFILL_PER_RUN_CAP);

    backfillProgress.total = items.length;

    logger.info(`Backfill started: embedding ${items.length} item(s) this run (cap ${BACKFILL_PER_RUN_CAP})`);

    const batchSize = 10;

    // storeEmbedding is best-effort: it swallows every failure and returns void,
    // so a call that returned may have written NO row. Count the row that landed,
    // not the call that returned.
    const stored = db.prepare('SELECT 1 FROM embeddings WHERE source_type = ? AND source_id = ? AND embedding_model IS ?');
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);

      // Process batch sequentially to avoid overwhelming the embedding API
      for (const item of batch) {
        try {
          await storeEmbedding(item.type, item.id, item.agentId, item.content);
          if (stored.get(item.type, item.id, model)) {
            backfillProgress.completed++;
          } else {
            backfillProgress.failed++;
            logger.debug('Backfill item not embedded', { type: item.type, id: item.id });
          }
        } catch (err) {
          backfillProgress.failed++;
          logger.debug('Backfill item failed', {
            error: err instanceof Error ? err.message : String(err),
            type: item.type,
            id: item.id,
          });
        }
      }

      // Log progress every few batches
      if (i % (batchSize * 5) === 0 || i + batchSize >= items.length) {
        logger.info(`Backfill progress: ${backfillProgress.completed}/${backfillProgress.total} (${backfillProgress.failed} failed)`);
      }
    }

    logger.info(`Backfill completed: ${backfillProgress.completed} embedded, ${backfillProgress.failed} failed, ${backfillProgress.total} total`);

    return { ...backfillProgress };
  } finally {
    backfillRunning = false;
  }
}
