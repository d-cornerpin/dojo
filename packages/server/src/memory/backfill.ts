// ════════════════════════════════════════
// Embedding Backfill (Phase 5C)
// One-time job to generate embeddings for existing data
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { storeEmbedding } from './embeddings.js';
import { broadcast } from '../gateway/ws.js';

const logger = createLogger('backfill');

// Cap the work PER RUN. On a months-deep box the un-embedded backlog can be tens
// of thousands of rows; embedding them all in ONE pass would peg the local
// embedder for hours on the first boot after an upgrade. The boot drain re-fires
// on an interval (index.ts), every embedded row is excluded by the LEFT JOIN on
// the next pass, and rows are taken oldest-first (the file's existing intent), so
// a bounded slice per run drains the backlog incrementally without ever blocking.
const BACKFILL_PER_RUN_CAP = 500;

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
    // Collect un-embedded messages (with sufficient content), oldest first, capped
    // to the per-run budget so a deep backlog is drained incrementally, not in one
    // multi-hour pass.
    const messages = db.prepare(`
      SELECT m.id, m.agent_id, m.content
      FROM messages m
      LEFT JOIN embeddings e ON e.source_type = 'message' AND e.source_id = m.id
      WHERE e.id IS NULL AND length(m.content) >= 20
      ORDER BY m.created_at ASC
      LIMIT ?
    `).all(BACKFILL_PER_RUN_CAP) as Array<{ id: string; agent_id: string; content: string }>;

    // Collect un-embedded summaries (also capped, oldest first).
    const summaries = db.prepare(`
      SELECT s.id, s.agent_id, s.content
      FROM summaries s
      LEFT JOIN embeddings e ON e.source_type = 'summary' AND e.source_id = s.id
      WHERE e.id IS NULL
      ORDER BY s.created_at ASC
      LIMIT ?
    `).all(BACKFILL_PER_RUN_CAP) as Array<{ id: string; agent_id: string; content: string }>;

    // Collect un-embedded techniques (intent surface only: name + description
    // + tags — recall matches the ask against what a technique is FOR).
    const techniques = db.prepare(`
      SELECT t.id, t.name, t.description, t.tags
      FROM techniques t
      LEFT JOIN embeddings e ON e.source_type = 'technique' AND e.source_id = t.id
      WHERE e.id IS NULL
      ORDER BY t.created_at ASC
      LIMIT ?
    `).all(BACKFILL_PER_RUN_CAP) as Array<{ id: string; name: string; description: string | null; tags: string | null }>;

    // One combined per-run budget across all three sources (messages first, so a
    // deep message backlog drains before the small summary/technique tails).
    const items: Array<{ type: 'message' | 'summary' | 'technique'; id: string; agentId: string | null; content: string }> = [
      ...messages.map(m => ({ type: 'message' as const, id: m.id, agentId: m.agent_id, content: m.content })),
      ...summaries.map(s => ({ type: 'summary' as const, id: s.id, agentId: s.agent_id, content: s.content })),
      ...techniques.map(t => {
        let tags: string[] = [];
        try { tags = JSON.parse(t.tags ?? '[]'); } catch { /* malformed tags column */ }
        return { type: 'technique' as const, id: t.id, agentId: null, content: `${t.name}\n${t.description ?? ''}\n${tags.join(' ')}` };
      }),
    ].slice(0, BACKFILL_PER_RUN_CAP);

    // Remaining un-embedded backlog across all sources (cheap COUNTs), so the
    // drain's progress is visible boot-to-boot as it resumes.
    const remaining = (() => {
      try {
        const c = (q: string): number => (db.prepare(q).get() as { c: number }).c;
        const total =
          c(`SELECT COUNT(*) AS c FROM messages m LEFT JOIN embeddings e ON e.source_type='message' AND e.source_id=m.id WHERE e.id IS NULL AND length(m.content) >= 20`) +
          c(`SELECT COUNT(*) AS c FROM summaries s LEFT JOIN embeddings e ON e.source_type='summary' AND e.source_id=s.id WHERE e.id IS NULL`) +
          c(`SELECT COUNT(*) AS c FROM techniques t LEFT JOIN embeddings e ON e.source_type='technique' AND e.source_id=t.id WHERE e.id IS NULL`);
        return Math.max(0, total - items.length);
      } catch { return null; }
    })();

    backfillProgress.total = items.length;

    logger.info(`Backfill started: embedding ${items.length} item(s) this run (cap ${BACKFILL_PER_RUN_CAP}); ${remaining ?? 'unknown'} still pending after this run`);

    // Broadcast progress start
    broadcast({
      type: 'backfill:progress',
      data: { ...backfillProgress, status: 'running' },
    });

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
        });
        logger.info(`Backfill progress: ${backfillProgress.completed}/${backfillProgress.total} (${backfillProgress.failed} failed)`);
      }
    }

    logger.info(`Backfill completed: ${backfillProgress.completed} embedded, ${backfillProgress.failed} failed, ${backfillProgress.total} total`);

    broadcast({
      type: 'backfill:progress',
      data: { ...backfillProgress, status: 'complete' },
    });

    return { ...backfillProgress };
  } finally {
    backfillRunning = false;
  }
}
