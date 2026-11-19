// Labels a peer request awaiting its own turn so this turn does not work it; the row stays visible.
import { liveTurnServes, requestAwaitingItsOwnTurn } from '../agent/a2a-own-turn.js';
import { LabelFacts } from './row-label.js';

export interface AwaitingRequest {
  readonly messageId: string;
  readonly label: string;
}

/** The awaiting request the turn in flight is NOT serving (a serving turn gets no label), or null. */
export function requestForAnotherTurn(agentId: string): AwaitingRequest | null {
  const owed = requestAwaitingItsOwnTurn(agentId);
  if (!owed) return null;
  if (liveTurnServes(agentId, owed) === true) return null;
  const where = new LabelFacts(agentId).thread(owed.threadId);
  return {
    messageId: owed.messageId,
    label: `[this request belongs to ${where}; it is handled on its own turn, right after this one — do not work on it here]`,
  };
}

export function clauseFor(waiting: AwaitingRequest | null, id: string): string {
  return waiting?.messageId === id ? `${waiting.label} ` : '';
}
