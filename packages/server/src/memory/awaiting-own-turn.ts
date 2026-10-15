// ════════════════════════════════════════════════════════════════════════════════════════
// t165 — A REQUEST THAT BELONGS TO ANOTHER CONVERSATION SAYS SO, WHERE THE AGENT READS IT.
//
// The owner, 2026-10-14: "Keep it separate" — his chat shows only work done for HIM; another
// agent's request is handled in its own conversation. The agent's history tools (recall, search,
// get) read rows from every lane it owns, which is right — and is how a peer's question, waiting
// for its own turn, reached an owner turn's model and was worked there. The fix is a LABEL on the
// row, never a narrower view (OR-LABEL-NOT-HIDE): the row is still printed, with one bound clause
// saying whose it is and when it is handled.
//
// "Still awaiting its own turn" is the engine's own fact (`requestAwaitingItsOwnTurn`: an inbound
// QUESTION/ASSIGN/BLOCK with no recorded reply — the thing the runtime gives a dedicated turn right
// after the one in flight), never a reading of the text. The turn that IS serving the request does
// not get the label: for it the row is its work. No row-name or agent-name is relied on; the peer's
// name appears only as display text.
// ════════════════════════════════════════════════════════════════════════════════════════
import { liveTurnServes, requestAwaitingItsOwnTurn } from '../agent/a2a-own-turn.js';
import { LabelFacts } from './row-label.js';

export interface AwaitingRequest {
  /** The inbound row the clause belongs to. */
  readonly messageId: string;
  /** The clause, ready to sit in front of the row's text. */
  readonly label: string;
}

/** The request awaiting its own turn that the turn in flight is NOT serving, or null. Read once
 *  per tool call; every row-renderer compares `messageId` to the rows it prints. */
export function requestForAnotherTurn(agentId: string): AwaitingRequest | null {
  const owed = requestAwaitingItsOwnTurn(agentId);
  if (!owed) return null;
  if (liveTurnServes(agentId, owed) === true) return null;
  const where = new LabelFacts(agentId).thread(owed.threadId ?? owed.threadShort);
  return {
    messageId: owed.messageId,
    label: `[this request belongs to ${where}; it is handled on its own turn, right after this one — do not work on it here]`,
  };
}

/** The clause to print in front of row `id`'s text ('' when the row is not the awaiting request). */
export function clauseFor(waiting: AwaitingRequest | null, id: string): string {
  return waiting?.messageId === id ? `${waiting.label} ` : '';
}
