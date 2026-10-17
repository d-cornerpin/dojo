// The trailing "[Engine: end of recorded history ...]" marker, placed by DELIVERY STATE (t196, A3).
// The assembler appends it whenever the last message is the agent's own (a provider rejects a trailing assistant
// turn). Its claim "everything above was delivered" is true unless the message the running turn is answering arrived
// while an EARLIER turn ran: it then sits above that turn's later replies, and the marker would call it delivered.
import { turnContext as liveTurnContext } from '../agent/turn-context.js';
import { servedOwnerMessageIds } from './served-ask.js';
import type { Message } from '@dojo/shared';

/** Fixed text: the marker lane reserves its length (`lanes.ts`, 216 characters). */
export const END_OF_HISTORY =
  '[Engine: end of recorded history. Everything above, including your own final ' +
  'replies, was already delivered to its recipients. Continue from the newest ' +
  'event of THIS turn; do not re-send or re-answer anything above.]';

/** The same marker saying which message is NOT yet answered. Same head, within the same reserve. */
const END_OF_HISTORY_SERVED_ABOVE =
  '[Engine: end of recorded history. The message this turn is answering arrived while an earlier ' +
  'turn ran and is NOT yet answered. Everything else above was already delivered; do not re-send it.]';

/** The marker for this assembly. `rows` are the tail's rows in seq order. The turn's OWN rows above its trigger are
 *  its work in progress, not a delivery, so only an assistant row of ANOTHER turn counts. */
export function endOfHistoryMarker(agentId: string, rows: Message[]): string {
  const served = servedOwnerMessageIds(agentId);
  if (served.length === 0) return END_OF_HISTORY;
  const inFlight = liveTurnContext(agentId)?.turnNumber ?? null;
  const above = served.some((id) => {
    const at = rows.findIndex((r) => r.id === id);   // -1: out of view, re-emitted ahead of every row
    return rows.slice(at + 1).some((r) => r.role === 'assistant' && (inFlight === null || r.turnNumber !== inFlight));
  });
  return above ? END_OF_HISTORY_SERVED_ABOVE : END_OF_HISTORY;
}
