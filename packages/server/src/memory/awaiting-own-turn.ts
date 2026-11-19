// Labels a peer request awaiting its own turn so this turn does not work it; the row stays visible.
import { requestsAwaitingTheirOwnTurn } from '../agent/a2a-own-turn.js';
import { LabelFacts } from './row-label.js';

export interface AwaitingRequest {
  readonly messageId: string;
  readonly label: string;
}

/** Every awaiting request the turn in flight is NOT serving (a serving turn's own request gets no label). */
export function requestForAnotherTurn(agentId: string): AwaitingRequest[] {
  const facts = new LabelFacts(agentId);
  return requestsAwaitingTheirOwnTurn(agentId).map((owed) => ({
    messageId: owed.messageId,
    label: `[this request belongs to ${facts.thread(owed.threadId)}; it is handled on its own turn, right after this one — do not work on it here]`,
  }));
}

export function clauseFor(waiting: readonly AwaitingRequest[], id: string): string {
  const w = waiting.find((r) => r.messageId === id);
  return w ? `${w.label} ` : '';
}
