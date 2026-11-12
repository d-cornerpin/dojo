// End-of-history marker by DELIVERY STATE: "delivered" is false when the served message predates this turn.
// `rows`: the tail in seq order. The turn's OWN rows are work in progress; only ANOTHER turn's reply counts.
import { turnContext as liveTurnContext } from '../agent/turn-context.js';
import { servedOwnerMessageIds } from './served-ask.js';
import type { Message } from '@dojo/shared';

/** Both texts fit the marker lane's 216-char reserve (`lanes.ts`); the SERVED_ABOVE twin keeps its head. */
export const END_OF_HISTORY =
  '[Engine: end of recorded history. Everything above, including your own final ' +
  'replies, was already delivered to its recipients. Continue from the newest ' +
  'event of THIS turn; do not re-send or re-answer anything above.]';

const END_OF_HISTORY_SERVED_ABOVE =
  '[Engine: end of recorded history. The message this turn is answering arrived while an earlier ' +
  'turn ran and is NOT yet answered. Everything else above was already delivered; do not re-send it.]';

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
