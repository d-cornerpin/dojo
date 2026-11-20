// The required reply: a turn about to end with nothing said to the person waiting on it gets one more model call
// in which the answer is required (`forceReply` in agent/model.ts), with a steer so the model writes it itself.

import { broadcast } from '../../gateway/ws.js';
import { owedAtTurnEnd } from '../../work/ask-settlement.js';
import { DELIVERABLE_OWING_TASK_KINDS } from '../../work/deliverable-declaration.js';
import type { TurnContext } from '../turn-context.js';
import { turnDeliveredToPerson } from './answered-edge.js';
import { inboundAsksNothing } from './classifiers/inbound-routing.js';
import { persistEngineSteer } from './engine-steer.js';
import { turnParkedTheJob } from './engine-exit.js';
import { advance } from './state.js';
import { userWords } from './turn-address.js';

/** Should the turn, about to end, make the required call? When it should, the pass is armed (spent first, so a
 *  pass that leaves before any call never arms a second) and the loop re-enters past its gates. */
export async function forcedReplyDue(
  turnCtx: TurnContext,
  p: { agentId: string; turnNumber: number; latestUserSource: string | null },
): Promise<boolean> {
  const state = turnCtx.state!;
  if (turnCtx.forcedReplySpent || state.engineCutExit !== null || turnParkedTheJob(p.agentId)) return false;
  if (state.lastAssistantTextForIM || turnCtx.deferredUserReplyWithTools) return false;
  if (p.latestUserSource === 'voice' || state.inboundChannel === 'phone') return false;
  const owesItsDeliverable = turnCtx.root?.kind === 'occurrence'
    && DELIVERABLE_OWING_TASK_KINDS.includes(turnCtx.servedWork?.taskKind ?? '')
    && !turnDeliveredToPerson(p.agentId, p.turnNumber);
  if (owedAtTurnEnd(p.agentId, p.turnNumber).length === 0 && !owesItsDeliverable) return false;
  if (await inboundAsksNothing(turnCtx)) return false;
  turnCtx.forcedReplySpent = true;
  turnCtx.state = persistEngineSteer(advance(state, { phase: 'preCallGates' }), {
    agentId: p.agentId, turnNumber: p.turnNumber, floor: 'forced-reply', atLoop: state.loopCount,
    content: `[Engine: ${userWords(turnCtx.address)} is waiting for your answer to their message. Write it now.]`,
  }, { broadcast });
  turnCtx.forceReplyPending = true;
  turnCtx.spinBrakeGraceCalls = 0;
  return true;
}
