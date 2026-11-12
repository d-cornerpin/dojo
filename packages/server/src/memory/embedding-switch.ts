// What happens to the memories when the embedding model is switched. Every stored vector names its model
// (migration 207) and a search scores only the current model's vectors, so old memories are unsearchable by meaning
// until re-embedded. A LOCAL model re-embeds in the background here; a PAID one re-embeds nothing (it would spend the
// owner's money unasked) and tells the owner once, via an informational owner card (`healer/owner-notices.ts`).

import { createLogger } from '../logger.js';
import { tellOwner, ownerConditionCleared, wordsOf } from '../healer/owner-notices.js';
import { embeddingIsLocal, embeddingModelKey, countMemoriesOnOtherModels } from './embedding-model.js';

const logger = createLogger('embedding-switch');

export const EMBEDDING_SWITCH_KEY = 'embedding-switch';

export function embeddingSwitchSettled(): void {
  try { if (countMemoriesOnOtherModels() === 0) ownerConditionCleared(EMBEDDING_SWITCH_KEY); } catch { /* best effort */ }
}

let reembedding = false;

/** Re-embed everything made by another model. It ends when none is left, or when a whole pass leaves the count
 *  where it was (the embedder is down, or a source cannot be embedded): the count is the real signal. */
async function reembedAllStale(): Promise<void> {
  if (reembedding) return;
  reembedding = true;
  const startedWith = embeddingModelKey();
  let why = 'none left';
  try {
    const { runBackfill, isBackfillRunning } = await import('./backfill.js');
    const { reembedStaleVaultEntries } = await import('../vault/embedding-refresh.js');
    let before = countMemoriesOnOtherModels();
    for (;;) {
      if (embeddingModelKey() !== startedWith) { why = 'switched again; that switch decides'; return; }
      // A drain already running (the scheduled one) is waited for, not skipped: it may have chosen its rows before the switch.
      while (isBackfillRunning()) await new Promise((r) => setTimeout(r, 200));
      if (embeddingModelKey() !== startedWith) { why = 'switched again; that switch decides'; return; }
      try { await runBackfill({ includeStale: true }); } catch { /* already running, or the embedder is down */ }
      await reembedStaleVaultEntries();
      const after = countMemoriesOnOtherModels();
      if (after === 0) return;
      if (after >= before) { why = `${after} memories on other models, and the last pass did not lower the count`; return; }
      before = after;
    }
  } finally {
    reembedding = false;
    logger.info('Re-embed finished', { reason: why });
    embeddingSwitchSettled();
  }
}

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
  tellOwner(EMBEDDING_SWITCH_KEY, wordsOf(EMBEDDING_SWITCH_KEY));
}
