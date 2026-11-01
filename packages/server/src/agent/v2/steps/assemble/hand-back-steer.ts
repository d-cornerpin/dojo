// The served ask's HAND-BACK FACTS, given whole to the one turn that serves it (proof-fix-f, review B1/M1).
// A dead run's ask is handed back with what that run left behind recorded on the ask itself
// (`work/hand-back-facts.ts`). They reach the model here: as a steer on the turn whose ROOT is that
// ask — so only that conversation's turn sees them — delivered whole through the drain, never gisted
// as an events-lane row. The floor latches, so this reads the record once per turn.
import { askIdForMessage } from '../../../../work/store.js';
import { handBackFactsFor } from '../../../../work/hand-back-facts.js';
import { steerFired } from '../../steer-queue.js';
import { persistEngineSteer } from '../../engine-steer.js';
import type { AgentTurnState } from '../../state.js';
import type { TurnContext } from '../../../turn-context.js';
import { broadcast } from '../../../../gateway/ws.js';

export function withHandBackFacts(state: AgentTurnState, turnCtx: TurnContext, agentId: string, turnNumber: number): AgentTurnState {
  if (steerFired(state.steerQueue, 'handed-back-ask')) return state;
  const root = turnCtx.root;
  if (root?.kind !== 'ask' || !root.id) return state;
  const facts = handBackFactsFor(askIdForMessage(root.id));
  if (facts === null) return state;
  // The durable row is the house rule for every steer (HL3: what the model sees is also logged).
  return persistEngineSteer(state, { agentId, content: facts, turnNumber, floor: 'handed-back-ask', atLoop: state.loopCount }, { broadcast });
}
