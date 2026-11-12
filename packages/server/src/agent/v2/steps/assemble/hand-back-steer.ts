// A dead run's ask is handed back with what it left behind; those facts reach only the turn
// whose root is that ask, delivered whole through the drain, never gisted as an events-lane row.
import { askIdForMessage } from '../../../../work/store.js';
import { handBackFactsFor } from '../../../../work/hand-back-facts.js';
import { inheritedOwedListFor, INHERITED_NOTICE_INTENT } from '../../../../work/inherited-backlog.js';
import { getDb } from '../../../../db/connection.js';
import { steerFired } from '../../steer-queue.js';
import { persistEngineSteer } from '../../engine-steer.js';
import type { AgentTurnState } from '../../state.js';
import type { TurnContext } from '../../../turn-context.js';
import { broadcast } from '../../../../gateway/ws.js';

export function withHandBackFacts(state: AgentTurnState, turnCtx: TurnContext, agentId: string, turnNumber: number): AgentTurnState {
  if (steerFired(state.steerQueue, 'handed-back-ask')) return state;
  const root = turnCtx.root;
  const facts = root?.kind === 'ask' && root.id ? handBackFactsFor(askIdForMessage(root.id)) : inheritedListDrivingThisTurn(turnCtx);
  if (facts === null) return state;
  return persistEngineSteer(state, { agentId, content: facts, turnNumber, floor: 'handed-back-ask', atLoop: state.loopCount }, { broadcast });
}

/** The inherited list, only on the turn the notice row drives (its stored row holds ids only). */
function inheritedListDrivingThisTurn(turnCtx: TurnContext): string | null {
  const { triggerMessageId: id } = turnCtx;   // the claim sites own the WRITE of this field (preflight/turn-classification.ts)
  if (!id) return null;
  const row = getDb().prepare('SELECT origin_intent AS intent, content FROM messages WHERE id = ?').get(id) as { intent: string | null; content: string } | undefined;
  return row?.intent === INHERITED_NOTICE_INTENT ? inheritedOwedListFor(row.content) : null;
}
