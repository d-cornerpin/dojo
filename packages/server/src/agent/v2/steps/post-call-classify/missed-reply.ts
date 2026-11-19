// A2A missed-reply: a peer's question needs a `send_to_agent` reply and the agent wrote prose instead.
// The enforcer steers once per assign id; the hardcap ends the turn if the agent writes prose again.

import { v4 as uuidv4 } from 'uuid';
import { broadcast } from '../../../../gateway/ws.js';
import { insertMessageIfAbsent, repliedOnThread } from '../../../../memory/message-store.js';
import { type AgentTurnState } from '../../state.js';
import { steerFired } from '../../steer-queue.js';
import { persistEngineSteer } from '../../engine-steer.js';
import { a2aReplyEnforcer } from '../../classifiers/a2a.js';
import { continueLoop, proceed, requestExit, type StepOutcome } from '../step-outcome.js';
import type { PostCallClassifyContext, PostCallScratch } from './index.js';

/** The A2A missed-reply nudge and the hardcap that ends the spiral. */
export function runMissedReply(
  state: AgentTurnState,
  ctx: PostCallClassifyContext,
  sc: PostCallScratch,
): StepOutcome {
  const {
    a2aReplyAssignMessageId, a2aReplyContext, agentId, result, turnNumber,
    unrepliedAssign,
  } = ctx;
  const { persistedContent } = sc;

  // The settled-context tripwire lives only at the end-of-turn route site; do not add a second copy here.

  // Hardcap: the nudge already fired for this assign id and the model again wrote text with no send, so
  // end the turn; some models cannot be talked into the tool call and would loop until the budget ran out.
  if (
    a2aReplyAssignMessageId &&
    steerFired(state.steerQueue, 'a2a-missed-reply', a2aReplyAssignMessageId ?? '') &&
    !state.sentToAgentThisTurn &&
    persistedContent && persistedContent.trim().length > 0
  ) {
    const stopMsg = (
      `[System: Ending the turn. You wrote text instead of calling send_to_agent, so the message from the other agent is still unanswered. ` +
      `If it still needs a reply, call send_to_agent on your next turn; otherwise leave it.]`
    );
    const stopId = uuidv4();
    insertMessageIfAbsent({ id: stopId, agentId, role: 'system', content: stopMsg, turnNumber });
    broadcast({
      type: 'chat:message',
      agentId,
      message: {
        id: stopId, agentId, role: 'system' as const,
        content: stopMsg,
        tokenCount: null, modelId: null, cost: null, latencyMs: null,
        createdAt: new Date().toISOString(),
      },
    });
    return requestExit(state, 'a2a-missed-reply-hardcap');
  }

  const replyDecision = a2aReplyEnforcer({
    triggeredByReplyNeededIntent: a2aReplyContext !== null,
    sentToAgentThisTurn: state.sentToAgentThisTurn,
    alreadyNudgedForMissedReply:
      !!a2aReplyAssignMessageId && steerFired(state.steerQueue, 'a2a-missed-reply', a2aReplyAssignMessageId),
    // Raw text, not `persistedContent` (nulled on inter-agent turns): prose instead of a send still counts.
    agentProducedText: !!(result.content && result.content.trim().length > 0),
    intent: a2aReplyContext?.intent,
    threadShort: a2aReplyContext?.threadShort,
    fromName: a2aReplyContext?.fromName,
    // Softer nudge when the asker's store already holds a row from this agent on the thread (ever, or since
    // the request), so a reply that landed is never called "got nothing".
    priorReplyOnSameThread:
      !!unrepliedAssign && repliedOnThread(agentId, unrepliedAssign.fromId, unrepliedAssign.threadId, 0),
    verifiedSendReceiptOnThread:
      !!unrepliedAssign && repliedOnThread(agentId, unrepliedAssign.fromId, unrepliedAssign.threadId, unrepliedAssign.createdAt),
  });
  if (replyDecision.decision === 'nudge') {
    // Keyed on the assign id, so the next pass's enforcer finds it fired and the hardcap engages.
    state = persistEngineSteer(
      state,
      {
        agentId,
        content: replyDecision.nudgeText,
        turnNumber,
        floor: 'a2a-missed-reply',
        atLoop: state.loopCount,
        key: a2aReplyAssignMessageId ?? '',
      },
      { broadcast },
    );
    return continueLoop(state);
  }

  return proceed(state);
}
