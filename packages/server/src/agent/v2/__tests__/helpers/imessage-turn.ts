// A person's iMessage turn driven through its own steps: the turn's closures (`deliverEngineUserAck`), the
// terminal-text step, the reply's persist step and finalize. The reply-sender fakes (`./reply-sender.ts`) must be mocked by the file.
import type { ToolCall } from '@dojo/shared';
import { START_ACK_ORIGIN_INTENT } from '../../../../memory/message-store.js';
import { initState, advance, type AgentTurnState } from '../../state.js';
import { runTurnClosures } from '../../steps/preflight/turn-closures.js';
import { runTerminalText } from '../../steps/post-call-classify/terminal-text.js';
import { runPersistAssistant } from '../../steps/post-call-classify/persist-assistant.js';
import { routeTerminalReply } from '../../steps/finalize/route-reply.js';
import { runFinalize } from '../../steps/finalize/index.js';
import { testDb, AGENT, PERSON } from './reply-sender.js';

export function imessageTurn(turnNumber = 1) {
  const counterparty = { kind: 'user', name: 'a person', relation: 'known_contact', channel: 'imessage', senderId: PERSON, threadId: null, senderIsAgent: false };
  const root = { kind: 'ask', id: `ask-${turnNumber}`, sourceMessageId: `m-${turnNumber}`, conversationId: `conv-${PERSON}` };
  const address = { kind: 'person', isOwner: false, boundChannel: 'imessage', autoRoutes: true, deliveryChannel: 'imessage', routed: true, inboundChannel: 'imessage', senderId: PERSON };
  let state: AgentTurnState = advance(initState({ agentId: AGENT, turnNumber } as Parameters<typeof initState>[0]), {
    inboundChannel: 'imessage', inboundContext: { recipientAddress: PERSON },
  } as Partial<AgentTurnState>);
  const turnCtx = {
    agentId: AGENT, kind: 'user', root, address, servedWork: undefined,
    deferredUserReplyWithTools: null, engineStartAckDeliveredThisTurn: false, deferredDeliveredByAck: false,
    startAckSteerArmedThisTurn: false, startAckSteerRequested: false, earlyAnswerRowId: null, replyFiles: [], state,
  } as unknown as Parameters<typeof runTurnClosures>[0];
  const { deliverEngineUserAck } = runTurnClosures(turnCtx, { agentId: AGENT } as never, { terminalAnswerRowId: null } as never, {
    counterparty: counterparty as never, chosenConvKey: 'c', chosenConversationId: root.conversationId, turnNumber, revertTriggerStampOnAbort: () => {},
  });
  let answerKey: string | null = null;
  const ctx = {
    agentId: AGENT, turnCtx, turnNumber, db: testDb(), counterparty, hasUnansweredUser: true, isHumanContinuation: true, messageId: `msg-${turnNumber}`,
    deliverEngineUserAck, noteTerminalAnswer: (rowId: string) => { answerKey = rowId; }, startAckRepliedNow: () => false,
    chosenConvKey: 'c', settledContextWakeTurn: false, isEngineTurn: false, persistRoutingMarker: () => {}, broadcast: () => {},
    agent: { id: AGENT, name: AGENT }, configuredModelId: 'm', latestUserSource: null, inboundChannel: 'imessage',
    isA2ATurn: false, turnStartedAt: new Date().toISOString(), stopStatusHeartbeat: () => {},
  };
  return {
    /** The start line ("on it"), delivered as the turn's opening words. */
    startLine: (text: string) => deliverEngineUserAck(text, START_ACK_ORIGIN_INTENT),
    /** A continued task's only words ride a tool call: they are delivered at once as the answer. */
    answerEarly: async (text: string) => {
      const result = { content: text, toolCalls: [{ id: 'tc1', name: 'file_read', arguments: {} }] as ToolCall[], stopReason: 'tool_use' };
      state = (await runTerminalText(state, { ...ctx, result } as never, { interAgentTurn: false } as never)).state;
    },
    /** The model writes `text` with no tool call: the reply's row is persisted with the files shown so far. */
    say: async (text: string) => {
      const result = { content: text, toolCalls: [] as ToolCall[], stopReason: 'end_turn' };
      state = (await runPersistAssistant(state, { ...ctx, result } as never, { interAgentTurn: false, persistedContent: text } as never)).state;
    },
    /** The whole finalize step, as the turn's end runs it. */
    finalize: async () => { state = (await runFinalize(state, ctx as never)).state; },
    /** The message the turn records as its answer. */
    answerKey: () => answerKey,
    /** The turn ends with `text` as its reply, or with nothing new to say; finalize routes what the turn holds. */
    end: async (text?: string) => {
      if (text) state = advance(state, { lastAssistantTextForIM: text });
      await routeTerminalReply(state, ctx as never);
    },
  };
}
