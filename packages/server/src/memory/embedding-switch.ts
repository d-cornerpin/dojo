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
//     persistent owner card (healer/owner-notices.ts, key `embedding-switch`: it is re-derived on every dashboard
//     load and ends once no memory is left on the old model), how many memories still use the old model and
//     that search may miss them until they are re-processed.
//
// The owner's own backfill request (POST /embeddings/backfill) re-processes them on demand.
// ════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';
import { ownerCardFrame } from '../services/owner-card-frames.js';
import { tellOwnerOnce, ownerConditionCleared, wordsOf, cardKeyOf } from '../healer/owner-notices.js';
import { embeddingIsLocal, embeddingModelKey, countMemoriesOnOtherModels } from './embedding-model.js';

const logger = createLogger('embedding-switch');

export const EMBEDDING_SWITCH_KEY = 'embedding-switch';

/** No memory is left on another model: the owner card ends (every open dashboard, and the load-time list). */
export function embeddingSwitchSettled(): void {
  try { if (countMemoriesOnOtherModels() === 0) ownerConditionCleared(EMBEDDING_SWITCH_KEY); } catch { /* best effort */ }
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
    embeddingSwitchSettled();
  }
}

/** Called once, by `setEmbeddingConfig`, when the saved model label changed. */
export async function handleEmbeddingModelSwitch(previousKey: string): Promise<void> {
  ownerConditionCleared(EMBEDDING_SWITCH_KEY);   // a new switch starts a new telling
  const count = countMemoriesOnOtherModels();
  logger.info('Embedding model switched', { from: previousKey, to: embeddingModelKey(), memoriesOnOtherModels: count });
  if (count === 0) return;
  if (embeddingIsLocal()) {
    void reembedAllStale().catch((err) => logger.warn('Background re-embed stopped', { error: err instanceof Error ? err.message : String(err) }));
    return;
  }
  // Paid: nothing is spent. A lasting card, told once per switch.
  if (tellOwnerOnce(EMBEDDING_SWITCH_KEY)) ownerCardFrame(wordsOf(EMBEDDING_SWITCH_KEY), 'warning', cardKeyOf(EMBEDDING_SWITCH_KEY));
}
