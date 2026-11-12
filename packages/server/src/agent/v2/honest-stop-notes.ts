// A PERSON WHO MESSAGES A PARKED AGENT IS NOT MET WITH SILENCE: each open ask gets the platform's line once.

import { OWNER_ALERT_HEADS_UP_PREFIX } from '@dojo/shared';
import { getDb } from '../../db/connection.js';
import { broadcast } from '../../gateway/ws.js';
import { insertMessageIfAbsent } from '../../memory/message-store.js';
import { createLogger } from '../../logger.js';
import { parkedCauseOf } from './honest-stop-lock.js';

const logger = createLogger('honest-stop');

/** The row identity the park's own notice takes when it answers a message: the `park-note:<message>` id
 *  and its conversation; empty (a fresh id) when no open ask waits or that id already has a line. */
export function noticeIdentityFor(agentId: string, rootId: string | null | undefined): { id?: string; conversationId?: string | null } {
  if (!rootId) return {};
  try {
    const db = getDb();
    const ask = db.prepare(`SELECT conversation_id AS conversationId FROM work WHERE kind = 'ask' AND agent_id = ? AND root_id = ? AND state = 'open'`).get(agentId, rootId) as { conversationId: string | null } | undefined;
    if (!ask) return {};
    const id = `park-note:${rootId}`;
    if (db.prepare('SELECT 1 FROM messages WHERE id = ?').get(id)) return {};
    return { id, conversationId: ask.conversationId };
  } catch { return {}; }
}

/** Every still-open owner ask waiting on a parked agent gets ONCE, in its own conversation, the platform's
 *  plain-cause system line (row id `park-note:<message>`): dashboard chat only, never iMessage, no card;
 *  the message stays queued for release. `exceptRootId` is the message the park's own notice answered. */
export function noteWaitingOfParked(agentId: string, exceptRootId?: string | null): void {
  try {
    const db = getDb();
    const row = db.prepare('SELECT status, last_error FROM agents WHERE id = ?').get(agentId) as { status: string; last_error: string | null } | undefined;
    const cause = parkedCauseOf(row?.status, row?.last_error);
    if (!cause) return;
    const waiting = db.prepare(`SELECT root_id AS rootId, conversation_id AS conversationId FROM work
      WHERE kind = 'ask' AND agent_id = ? AND state = 'open' AND root_id IS NOT NULL ORDER BY opened_at`).all(agentId) as Array<{ rootId: string; conversationId: string | null }>;
    for (const { rootId, conversationId } of waiting) {
      if (rootId === exceptRootId) continue;
      const content = `${OWNER_ALERT_HEADS_UP_PREFIX} ${cause}`;
      const id = `park-note:${rootId}`;
      if (!insertMessageIfAbsent({ id, agentId, role: 'system', content, conversationId })) continue;   // already answered
      broadcast({ type: 'chat:message', agentId, message: { id, agentId, role: 'system', content, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString() } });
    }
  } catch (err) {
    logger.warn('honest stop: could not answer a waiting message', { agentId, error: err instanceof Error ? err.message : String(err) }, agentId);
  }
}
