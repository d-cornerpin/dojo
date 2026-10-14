// ════════════════════════════════════════════════════════════════════════════════════════
// t148 round 5 — A PERSON WHO MESSAGES A PARKED AGENT IS NOT MET WITH SILENCE (see honest-stop.ts for
// the park). Split out of that file to keep it within its size line.
// ════════════════════════════════════════════════════════════════════════════════════════

import { OWNER_ALERT_HEADS_UP_PREFIX } from '@dojo/shared';
import { getDb } from '../../db/connection.js';
import { broadcast } from '../../gateway/ws.js';
import { insertMessageIfAbsent } from '../../memory/message-store.js';
import { createLogger } from '../../logger.js';
import { parkedCauseOf } from './honest-stop-lock.js';

const logger = createLogger('honest-stop');

/**
 * The row identity the park's OWN notice takes when it answers a message (t152 step 17): the same
 * `park-note:<message>` id and the message's own conversation, so "this message was answered" is one
 * fact in one place and a later message does not write the first one a second line. Empty (the notice
 * keeps a fresh id) when there is no waiting message to answer, or a line already stands under that id
 * (a fresh park for a message that was already told an earlier park: the new notice must still be written).
 */
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

/**
 * A person who messages a parked agent is not met with silence (t148 round 5). Every owner ask still
 * waiting on a parked agent gets, ONCE, the platform's existing owner-visible system line in ITS OWN
 * conversation: the true cause in plain words, and that the message is kept and answered when it clears.
 * No model call, no text, no card, no toast. Once per message is the row id (`park-note:<message>`), so
 * it answers that message and is not a repeated condition alert. It is the dashboard's chat (a
 * `role='system'` row and a `chat:message` frame): it does not go back out on iMessage. The message itself
 * stays queued and is answered on release with the others. `exceptRootId` is the message the park's own
 * notice already answered.
 */
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
