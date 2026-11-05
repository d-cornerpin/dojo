// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 owner test 2, fix rank 4: HAS THE PERSON BEEN SHOWN A LINE THIS TURN?
//
// The start-ack family's question is "has the person heard anything". `startAckRepliedNow` (`preflight/start-ack.ts`)
// answers it from assistant rows with no origin stamp, which cannot see the two lines he is most often shown first:
//   - a line the model wrote beside a tool call, demoted to a PLAIN `[working-note]` row (role='system') that the
//     owner reads as a dimmed bubble (`post-call-classify/terminal-text.ts`);
//   - the delivered start line, stamped `engine_start_ack`.
// So the engine steered "the user has not heard anything from you yet this turn" after an "On it" had reached him, and
// the model said it again (owner test 2). This is the record of what reached him, read off the rows, never the words.
// An INTERNAL note (`[working-note:internal]`, a routed channel or nobody waiting) never reached him and does not count.
//
// Read only by the start-ack family (the threshold request, the steer, its reminder). `startAckRepliedNow` keeps its
// own meaning for its other readers (the T52 compile promotion, the live-ask answer), which ask a different question:
// "has the turn already delivered a REPLY".
// ════════════════════════════════════════════════════════════════════════════════════════

import { WORKING_NOTE_PREFIX } from '@dojo/shared';
import { getDb } from '../../db/connection.js';
import { START_ACK_ORIGIN_INTENT } from '../../memory/origin-intents.js';

/** Was the person shown a plain working note, or the delivered start line, on this turn? An unreadable store answers
 *  no (the engine then asks for the line, as before). */
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
