// ════════════════════════════════════════
// Embedding Backfill (Phase 5C)
// One-time job to generate embeddings for existing data
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { storeEmbedding } from './embeddings.js';
import { broadcast } from '../gateway/ws.js';

const logger = createLogger('backfill');

let backfillRunning = false;
let backfillProgress = { total: 0, completed: 0, failed: 0 };

export function isBackfillRunning(): boolean {
  return backfillRunning;
}

export function getBackfillProgress(): typeof backfillProgress {
  return { ...backfillProgress };
}

export async function runBackfill(): Promise<{ completed: number; failed: number; total: number }> {
  if (backfillRunning) {
    throw new Error('Backfill is already running');
  }

  backfillRunning = true;
  backfillProgress = { total: 0, completed: 0, failed: 0 };

  const db = getDb();

  try {
    // Collect all un-embedded messages (with sufficient content)
    const messages = db.prepare(`
      SELECT m.id, m.agent_id, m.content
      FROM messages m
      LEFT JOIN embeddings e ON e.source_type = 'message' AND e.source_id = m.id
      WHERE e.id IS NULL AND length(m.content) >= 20
      ORDER BY m.created_at ASC
    `).all() as Array<{ id: string; agent_id: string; content: string }>;

    // Collect un-embedded summaries
    const summaries = db.prepare(`
      SELECT s.id, s.agent_id, s.content
      FROM summaries s
      LEFT JOIN embeddings e ON e.source_type = 'summary' AND e.source_id = s.id
      WHERE e.id IS NULL
      ORDER BY s.created_at ASC
    `).all() as Array<{ id: string; agent_id: string; content: string }>;

    const items: Array<{ type: 'message' | 'summary'; id: string; agentId: string; content: string }> = [
      ...messages.map(m => ({ type: 'message' as const, id: m.id, agentId: m.agent_id, content: m.content })),
      ...summaries.map(s => ({ type: 'summary' as const, id: s.id, agentId: s.agent_id, content: s.content })),
    ];

    backfillProgress.total = items.length;

    logger.info(`Backfill started: ${items.length} items to embed`);

    // Broadcast progress start
    broadcast({
      type: 'backfill:progress',
      data: { ...backfillProgress, status: 'running' },
    } as never);

    // Process in batches
    const batchSize = 10;
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);

      // Process batch sequentially to avoid overwhelming the embedding API
      for (const item of batch) {
        try {
          await storeEmbedding(item.type, item.id, item.agentId, item.content);
          backfillProgress.completed++;
        } catch (err) {
          backfillProgress.failed++;
          logger.debug('Backfill item failed', {
            error: err instanceof Error ? err.message : String(err),
            type: item.type,
            id: item.id,
          });
        }
      }

      // Broadcast progress every batch
      if (i % (batchSize * 5) === 0 || i + batchSize >= items.length) {
        broadcast({
          type: 'backfill:progress',
          data: { ...backfillProgress, status: 'running' },
        } as never);
        logger.info(`Backfill progress: ${backfillProgress.completed}/${backfillProgress.total} (${backfillProgress.failed} failed)`);
      }
    }

    logger.info(`Backfill completed: ${backfillProgress.completed} embedded, ${backfillProgress.failed} failed, ${backfillProgress.total} total`);

    broadcast({
      type: 'backfill:progress',
      data: { ...backfillProgress, status: 'complete' },
    } as never);

    return { ...backfillProgress };
  } finally {
    backfillRunning = false;
  }
}
