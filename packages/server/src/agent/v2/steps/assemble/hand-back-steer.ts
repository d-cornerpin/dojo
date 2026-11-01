// The served ask's HAND-BACK FACTS, given whole to the one turn that serves it (proof-fix-f, review B1/M1) — and the
// inherited-backlog list, given whole to the one engine turn its notice row drives (review R3-3).
// A dead run's ask is handed back with what that run left behind recorded on the ask itself
// (`work/hand-back-facts.ts`). They reach the model here: as a steer on the turn whose ROOT is that
// ask — so only that conversation's turn sees them — delivered whole through the drain, never gisted
// as an events-lane row. The floor latches, so this reads the record once per turn.
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
  // The durable row is the house rule for every steer (HL3: what the model sees is also logged).
  return persistEngineSteer(state, { agentId, content: facts, turnNumber, floor: 'handed-back-ask', atLoop: state.loopCount }, { broadcast });
}

/** Review R3-3: the inherited-backlog notice's list, only on the engine turn that notice row drives (its stored row holds ids only). */
function inheritedListDrivingThisTurn(turnCtx: TurnContext): string | null {
  const { triggerMessageId: id } = turnCtx;   // the claim sites own the WRITE of this field (preflight/turn-classification.ts)
  if (!id) return null;
  const row = getDb().prepare('SELECT origin_intent AS intent, content FROM messages WHERE id = ?').get(id) as { intent: string | null; content: string } | undefined;
  return row?.intent === INHERITED_NOTICE_INTENT ? inheritedOwedListFor(row.content) : null;
}
