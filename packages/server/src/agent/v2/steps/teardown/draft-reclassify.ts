// At turn end, answer-shaped bubbles that turns.answer_message_id does not name become working notes.
// Only the boundary knows the answer, so bubbles stream untouched mid-turn; row and wire change together.

import { broadcast } from '../../../../gateway/ws.js';
import { getDb } from '../../../../db/connection.js';
import { createLogger } from '../../../../logger.js';
import { reclassifyDraftsAsWorkingNotes } from '../../../../memory/message-store.js';

const logger = createLogger('v2-loop');

export interface DraftReclassification {
  /** The ledger's verdict for this turn. `null` means the turn recorded no answer. */
  answerMessageId: string | null;
  /** The rows moved into the working-note lane, in the order they were said. */
  reclassified: Array<{ id: string; content: string }>;
}

/** Re-classify this turn's non-answer bubbles and announce each; fails closed if no answer was recorded. */
export function reclassifyTurnDrafts(
  p: { agentId: string; turnNumber: number },
): DraftReclassification {
  const { agentId, turnNumber } = p;
  const key = getDb().prepare(
    'SELECT answer_message_id FROM turns WHERE agent_id = ? AND turn_number = ?',
  ).get(agentId, turnNumber) as { answer_message_id: string | null } | undefined;
  const answerMessageId = key?.answer_message_id ?? null;
  if (answerMessageId == null) return { answerMessageId: null, reclassified: [] };

  const reclassified = reclassifyDraftsAsWorkingNotes({ agentId, turnNumber, answerMessageId });
  for (const row of reclassified) {
    // A re-classification converts the row in place, so both ids are that row's id.
    broadcast({
      type: 'chat:workingnote',
      agentId,
      messageId: row.id,
      noteId: row.id,
      content: row.content,
      reclassified: true,
    });
  }
  if (reclassified.length > 0) {
    logger.info('v2: the turn ended and its drafting was re-classified as working notes — the ledger named a different bubble as the answer', {
      agentId, turnNumber, answerMessageId,
      reclassified: reclassified.map((r) => r.id),
    }, agentId);
  }
  return { answerMessageId, reclassified };
}
