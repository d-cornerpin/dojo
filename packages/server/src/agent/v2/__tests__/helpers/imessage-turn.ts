// A person's iMessage turn driven through its own steps: the turn's closures (`deliverEngineUserAck`), the
// terminal-text step and finalize's route. The reply-sender fakes (`./reply-sender.ts`) must be mocked by the file.
import type { ToolCall } from '@dojo/shared';
import { START_ACK_ORIGIN_INTENT } from '../../../../memory/message-store.js';
import { initState, advance, type AgentTurnState } from '../../state.js';
import { runTurnClosures } from '../../steps/preflight/turn-closures.js';
import { runTerminalText } from '../../steps/post-call-classify/terminal-text.js';
import { routeTerminalReply } from '../../steps/finalize/route-reply.js';
import { testDb, AGENT, PERSON } from './reply-sender.js';

export function imessageTurn(turnNumber = 1) {
  const counterparty = { kind: 'user', name: 'a person', relation: 'known_contact', channel: 'imessage', senderId: PERSON, threadId: null, senderIsAgent: false };
  const root = { kind: 'ask', id: `ask-${turnNumber}`, sourceMessageId: `m-${turnNumber}`, conversationId: `conv-${PERSON}` };
  const address = { kind: 'person', isOwner: false, boundChannel: 'imessage', autoRoutes: true, deliveryChannel: 'imessage', routed: true, inboundChannel: 'imessage', senderId: PERSON };
  let state: AgentTurnState = advance(initState({ agentId: AGENT, turnNumber } as Parameters<typeof initState>[0]), {
    inboundChannel: 'imessage', inboundContext: { recipientAddress: PERSON },
  } as Partial<AgentTurnState>);
  const turnCtx = {
    agentId: AGENT, kind: 'user', root, address, ownerAffinityDestination: null, servedWork: undefined,
    deferredUserReplyWithTools: null, engineStartAckDeliveredThisTurn: false, deferredDeliveredByAck: false,
    startAckSteerArmedThisTurn: false, startAckSteerRequested: false, earlyAnswerRowId: null, state,
  } as unknown as Parameters<typeof runTurnClosures>[0];
  const { deliverEngineUserAck } = runTurnClosures(turnCtx, { agentId: AGENT } as never, { terminalAnswerRowId: null } as never, {
    counterparty: counterparty as never, chosenConvKey: 'c', chosenConversationId: root.conversationId, turnNumber, revertTriggerStampOnAbort: () => {},
  });
  const ctx = {
    agentId: AGENT, turnCtx, turnNumber, db: testDb(), counterparty, hasUnansweredUser: true, isHumanContinuation: true, messageId: `msg-${turnNumber}`,
    deliverEngineUserAck, noteTerminalAnswer: () => {}, startAckRepliedNow: () => false,
    chosenConvKey: 'c', settledContextWakeTurn: false, isEngineTurn: false, persistRoutingMarker: () => {}, broadcast: () => {},
  };
  return {
    /** The start line ("on it"), delivered as the turn's opening words. */
    startLine: (text: string) => deliverEngineUserAck(text, START_ACK_ORIGIN_INTENT),
    /** A continued task's only words ride a tool call: they are delivered at once as the answer. */
    answerEarly: async (text: string) => {
      const result = { content: text, toolCalls: [{ id: 'tc1', name: 'file_read', arguments: {} }] as ToolCall[], stopReason: 'tool_use' };
      state = (await runTerminalText(state, { ...ctx, result } as never, { interAgentTurn: false } as never)).state;
    },
    /** The turn ends with `text` as its reply, or with nothing new to say; finalize routes what the turn holds. */
    end: async (text?: string) => {
      if (text) state = advance(state, { lastAssistantTextForIM: text });
      await routeTerminalReply(state, ctx as never);
    },
  };
}
