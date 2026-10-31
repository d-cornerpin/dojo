// ════════════════════════════════════════════════════════════════════════════
// WHAT HAPPENS TO THE MEMORIES WHEN THE EMBEDDING MODEL IS SWITCHED (owner ruling).
//
// Every stored vector names the model that made it (migration 207), and a search scores only the
// current model's vectors, so right after a switch the old memories are unsearchable by meaning
// until they are embedded again. Two cases:
//
//   · The new model is LOCAL (costs nothing): they are re-embedded in the background, here.
//   · The new model is PAID (a hosted API): nothing is re-embedded automatically, because that would
//     spend the owner's money without his say. He is told once, through the dashboard's existing
//     notification card (the `chat:error` frame every engine card rides), how many memories still
//     use the old model and that search may miss them until they are re-processed.
//
// The owner's own backfill request (POST /embeddings/backfill) re-processes them on demand.
// ════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getPrimaryAgentId } from '../config/platform.js';
import { embeddingIsLocal, embeddingModelKey } from './embedding-model.js';

const logger = createLogger('embedding-switch');

export const EMBEDDING_SWITCH_NOTICE_CODE = 'EMBEDDING_MODEL_SWITCHED' as const;

/** How many memories (conversation, summary and technique vectors, plus vault entries) were made by another model. */
export async function countMemoriesOnOtherModels(): Promise<number> {
  const key = embeddingModelKey();
  const a = (getDb().prepare('SELECT COUNT(*) AS c FROM embeddings WHERE embedding_model IS NOT ?').get(key) as { c: number }).c;
  const { countStaleVaultEntries } = await import('../vault/embedding-refresh.js');
  return a + countStaleVaultEntries();
}

export function embeddingSwitchNoticeText(count: number): string {
  return `The memory search model was changed. ${count} saved ${count === 1 ? 'memory still uses' : 'memories still use'} the old model, `
    + 'so search may miss them until they are re-processed. New memories use the new model. '
    + 'They were not re-processed automatically because the new model is a paid one.';
}

let reembedding = false;

/** Re-embed everything made by another model until nothing is left or nothing more can be done. */
async function reembedAllStale(): Promise<void> {
  if (reembedding) return;
  reembedding = true;
  const startedWith = embeddingModelKey();
  try {
    const { runBackfill, isBackfillRunning } = await import('./backfill.js');
    const { reembedStaleVaultEntries } = await import('../vault/embedding-refresh.js');
    for (;;) {
      if (embeddingModelKey() !== startedWith) return;   // switched again: that switch decides
      let progress = 0;
      if (!isBackfillRunning()) {
        try { progress += (await runBackfill({ includeStale: true })).completed; } catch { /* already running, or the embedder is down */ }
      }
      progress += await reembedStaleVaultEntries();
      if (progress === 0) return;
    }
  } finally {
    reembedding = false;
  }
}

/** Called once, by `setEmbeddingConfig`, when the saved model label changed. */
export async function handleEmbeddingModelSwitch(previousKey: string): Promise<void> {
  const count = await countMemoriesOnOtherModels();
  logger.info('Embedding model switched', { from: previousKey, to: embeddingModelKey(), memoriesOnOtherModels: count });
  if (count === 0) return;
  if (embeddingIsLocal()) {
    void reembedAllStale().catch((err) => logger.warn('Background re-embed stopped', { error: err instanceof Error ? err.message : String(err) }));
    return;
  }
  try {
    broadcast({
      type: 'chat:error',
      agentId: getPrimaryAgentId(),
      error: embeddingSwitchNoticeText(count),
      code: EMBEDDING_SWITCH_NOTICE_CODE,
      severity: 'warning',
      retryable: false,
    });
  } catch { /* a notice is a courtesy; the switch itself has already happened */ }
}
