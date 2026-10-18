// The once-only notice for an agent already on a small main model (t202 D10). Split from
// main-model-floor.ts (t209) so the spawn door can use the floor without loading the websocket
// layer: this file is the only part of the floor that broadcasts.
import { getDb } from '../db/connection.js';
import { broadcast } from '../gateway/ws.js';
import { createLogger } from '../logger.js';
import { MAIN_MODEL_MIN_WINDOW, smallMainModelMessage, windowOf } from './main-model-floor.js';

const logger = createLogger('main-model-floor');

/**
 * An agent that is already on a small main model is told ONCE (per model it has been on), by the
 * existing `chat:error` card at warning severity — nothing is changed or stopped. "Once" is a
 * stored fact (a `config` key naming the model already noticed), so a restart does not repeat it.
 * Returns true when this call is the one that spoke.
 */
export function noteSmallMainModelOnce(agentId: string, modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  try {
    const w = windowOf(modelId);
    if (!w || w.window >= MAIN_MODEL_MIN_WINDOW) return false;
    const db = getDb();
    const key = `small_main_model_noticed:${agentId}`;
    const seen = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
    if (seen?.value === modelId) return false;
    db.prepare(`
      INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, modelId);
    logger.warn('This agent\'s main model is under the 32K floor; it keeps running', {
      modelId, window: w.window,
    }, agentId);
    broadcast({
      type: 'chat:error',
      agentId,
      error: `${smallMainModelMessage(w.name, w.window)} This agent keeps working as it is; the notice is shown once.`,
      code: 'MAIN_MODEL_SMALL',
      severity: 'warning',
      retryable: false,
    });
    return true;
  } catch { return false; }   // a notice is a courtesy; never break the read it rides on
}

