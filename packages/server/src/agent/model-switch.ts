// Switching models must stay reversible, so this function never rewrites the DB.
// Flattening of old-model tool ids for cross-provider compatibility happens in memory
// at API-call time, when the context is assembled; the DB stays the truth.

import { v4 as uuidv4 } from 'uuid';
import { broadcast } from '../gateway/ws.js';
import { createLogger } from '../logger.js';
import { insertMessageIfAbsent } from '../memory/message-store.js';
import { clearOn } from '../memory/writer.js';

const logger = createLogger('model-switch');

const RECALL_NUDGE_TEXT =
  '[System: Model just changed. If the recent thread feels unclear or tool history looks malformed, call recall_recent_thread(include_tool_results: true) BEFORE responding — it reads directly from your messages table and shows you what was actually said.]';

function insertModelSwitchNudge(agentId: string): void {
  try {
    const id = uuidv4();
    insertMessageIfAbsent({ id, agentId, role: 'system', content: RECALL_NUDGE_TEXT });
    broadcast({
      type: 'chat:message',
      agentId,
      message: {
        id,
        agentId,
        role: 'system' as const,
        content: RECALL_NUDGE_TEXT,
        tokenCount: null,
        modelId: null,
        cost: null,
        latencyMs: null,
        createdAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    logger.warn('Failed to insert model-switch recall nudge', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}

/** Non-destructive: logs, adds the recall nudge, returns the old shape so call sites stay accurate.
 *  Rewrites and deletes no existing rows, so a switch stays reversible: switching back restores the tool history. */
export function sanitizeMessagesOnModelChange(agentId: string): { collapsed: number } {
  logger.info('Model change recorded (sanitization deferred to assembly time)', { agentId }, agentId);
  insertModelSwitchNudge(agentId);
  clearOn({ kind: 'own-model-changed', agentId });   // every model-change door calls this
  return { collapsed: 0 };
}
