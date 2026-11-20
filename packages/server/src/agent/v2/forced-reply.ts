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

/** A live call (voice, phone) and another Dojo box on a human channel (its silence is allowed: two boxes made to answer
 *  each other never stop) are never given the must-answer call; everywhere else it follows a silent end. */
export const replyCanBeRequired = (latestUserSource: string | null, inboundChannel: string | null, peerBox: boolean): boolean =>
  latestUserSource !== 'voice' && inboundChannel !== 'phone' && !peerBox;

/** The required reply: a turn ending silent with someone owed makes one more call requiring the answer, steered so
 *  the model writes it. Armed spent first, so a pass that leaves early never arms a second; it re-enters past the gates. */
export async function forcedReplyDue(
  turnCtx: TurnContext,
  p: { agentId: string; turnNumber: number; latestUserSource: string | null; counterpartyIsAgentSender: boolean },
): Promise<boolean> {
  const state = turnCtx.state!;
  if (turnCtx.forcedReplySpent || state.engineCutExit !== null || turnParkedTheJob(p.agentId)) return false;
  if (state.lastAssistantTextForIM || turnCtx.deferredUserReplyWithTools) return false;
  if (!replyCanBeRequired(p.latestUserSource, state.inboundChannel, p.counterpartyIsAgentSender)) return false;
  const owesItsDeliverable = turnCtx.root?.kind === 'occurrence'
    && DELIVERABLE_OWING_TASK_KINDS.includes(turnCtx.servedWork?.taskKind ?? '')
    && !turnDeliveredToPerson(p.agentId, p.turnNumber);
  const aPersonWaits = owedAtTurnEnd(p.agentId, p.turnNumber).length > 0;
  if (!aPersonWaits && !owesItsDeliverable) return false;
  if (await inboundAsksNothing(turnCtx)) return false;
  const kind = turnCtx.servedWork?.taskKind === 'notify' ? 'message' : turnCtx.servedWork?.taskKind;
  const owed = aPersonWaits ? `${userWords(turnCtx.address)} is waiting for your answer to their message`
    : `this run is due to deliver its ${kind} and has said nothing yet`;
  turnCtx.forcedReplySpent = true;
  turnCtx.state = persistEngineSteer(advance(state, { phase: 'preCallGates' }), {
    agentId: p.agentId, turnNumber: p.turnNumber, floor: 'forced-reply', atLoop: state.loopCount,
    content: `[Engine: ${owed}. Write it now.]`,
  }, { broadcast });
  turnCtx.forceReplyPending = true;
  turnCtx.repeatGraceCalls = 0;
  return true;
}
