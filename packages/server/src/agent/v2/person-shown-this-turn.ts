import { WORKING_NOTE_PREFIX } from '@dojo/shared';
import { getDb } from '../../db/connection.js';
import { START_ACK_ORIGIN_INTENT } from '../../memory/origin-intents.js';

/** Was the person shown a plain working note or the delivered start line this turn? Internal notes don't
 *  count; startAckRepliedNow asks about delivery. An unreadable store answers no, so the line is asked. */
export function personShownALineThisTurn(agentId: string, turnNumber: number): boolean {
  try {
    return !!getDb().prepare(`
      SELECT 1 FROM messages
       WHERE agent_id = ? AND turn_number = ? AND lane = 'owner' AND retired_at IS NULL
         AND ((role = 'system' AND substr(content, 1, ?) = ?)
           OR (role = 'assistant' AND origin_intent = ?))
       LIMIT 1`).get(agentId, turnNumber, WORKING_NOTE_PREFIX.length, WORKING_NOTE_PREFIX, START_ACK_ORIGIN_INTENT);
  } catch {
    return false;
  }
}
