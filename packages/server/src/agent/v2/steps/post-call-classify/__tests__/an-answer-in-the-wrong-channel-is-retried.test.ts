// ════════════════════════════════════════════════════════════════════════════════════════
// HL2 — THE ANSWER THAT WENT INTO THE WRONG CHANNEL.
//
// THE CORRECTED PREMISE, owned in the learnings document: the dojo HAS an empty-response
// ladder. What it never had is a ladder that consults `reasoning_content` before taking its
// DELIBERATE not-a-failure exit ("the model did work and has nothing to say").
//
// DeepSeek's own harness says the model *"can answer entirely in the reasoning channel,
// e.g. a v4-flash greeting"* (`llm-deepseek/src/serialize.ts:88-95`) and treats a
// content-less completion as retryable. So a turn that OWES A PERSON a reply, returns
// nothing visible, and leaves a body in the hidden channel is an answer in the wrong
// channel — not a legitimate no-comment.
//
// RED AT `26cf372`: clause 1 exits `empty-response-after-tools`. GREEN: one silent retry,
// on the ladder's OWN existing rung, with a named reason.
//
// THE CONTROLS ARE THE POINT. Four turns that must stay byte-identical: nobody owed; a
// model whose contract says it cannot do this; a blank reasoning channel; and the second
// empty in the same turn, which must not get a second silent retry because the latch is
// shared with the rung it borrowed.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolCall } from '@dojo/shared';
import type { ModelContract } from '../../../../model-contract.js';

const broadcastSpy = vi.fn();
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: (...a: unknown[]) => broadcastSpy(...(a as [])) }));

// The contract the ladder consults. Faked at the registry door, so the test never needs a
// database and every field can be moved independently.
let CONTRACT: ModelContract;
vi.mock('../../../../model.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  contractForConfiguredModel: () => CONTRACT,
}));

import { advance, initState, type AgentTurnState } from '../../../state.js';
import { runEmptyResponse } from '../empty-response.js';
import { steerFired } from '../../../steer-queue.js';
import type { PostCallClassifyContext } from '../index.js';

const ANSWERS_IN_REASONING: ModelContract = {
  id: 'deepseek-native',
  requiresReasoningReplay: true,
  answersInReasoning: true,
  thinkingToggle: 'native-thinking-param',
  rejectsSamplingParamsWhenThinking: true,
  emptyRetryBudget: 1,
  apiRootIsBareHost: true,
  systemPromptCacheMarker: 'provider-auto',
};

const reArmSpy = vi.fn();

const modelResult = (
  over: Partial<{ content: string; toolCalls: ToolCall[]; stopReason: string; reasoningContent: string }> = {},
): PostCallClassifyContext['result'] => ({
  content: '', toolCalls: [] as ToolCall[],
  inputTokens: 10, outputTokens: 300, stopReason: 'end_turn', ...over,
} as unknown as PostCallClassifyContext['result']);

const turnCtx = (over: Record<string, unknown> = {}): PostCallClassifyContext['turnCtx'] => ({
  startAckSteerRequested: false,
  startAckSteerArmedThisTurn: false,
  engineStartAckDeliveredThisTurn: false,
  ...over,
} as unknown as PostCallClassifyContext['turnCtx']);

/** A turn that ran tools, owes the person who asked, and came back empty. */
const ctxFor = (over: Partial<PostCallClassifyContext> = {}): PostCallClassifyContext => ({
  agentId: 'kevin',
  configuredModelId: 'test-model',
  result: modelResult({ reasoningContent: 'The answer is: two flights, 8:05 and 11:40.' }),
  reArmIfStrandedNoAnswer: reArmSpy,
  turnCtx: turnCtx(),
  isA2ATurn: false,
  isEngineTurn: false,
  counterpartyIsAgentSender: false,
  hasUnansweredUser: true,
  triggerRow: { rowid: 1, content: 'when are the flights?' },
  ...over,
} as unknown as PostCallClassifyContext);

/** The state after a turn that executed tools. */
function afterToolsState(over: Partial<AgentTurnState> = {}): AgentTurnState {
  const base = initState({
    agentId: 'kevin', contextWindow: 128_000, isAutoRouted: false,
    configuredModelId: 'test-model', turnNumber: 7, triggeredByIMessage: false,
    triggeredByA2AReplyIntent: null, lastUserMessageContent: 'when are the flights?',
    lastUserMessageId: 'msg-user-1',
  } as Parameters<typeof initState>[0]);
  return advance(base, {
    phase: 'postCallClassify', loopCount: 2, modelId: 'test-model',
    toolCallsExecutedThisTurn: 3, ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  CONTRACT = { ...ANSWERS_IN_REASONING };
});

describe('HL2 — an answer left in the reasoning channel is retried, not called a no-comment', () => {
  it('RED clause 1 — owed turn + empty visible content + fat reasoning -> one silent retry', () => {
    const out = runEmptyResponse(afterToolsState(), ctxFor());
    expect(out.directive).toBe('continue');
    if (out.directive !== 'continue') throw new Error('unreachable');
    // The ladder's OWN latch, not a second one.
    expect(out.state.retriedEmptyResponse).toBe(true);
    // No steer, no toast, no re-arm: a silent retry is silent.
    expect(out.state.steerQueue).toEqual(afterToolsState().steerQueue);
    expect(broadcastSpy).not.toHaveBeenCalled();
    expect(reArmSpy).not.toHaveBeenCalled();
  });

  it('RED clause 2 — the start-ack owed pair is enough on its own, with no unanswered row', () => {
    const out = runEmptyResponse(afterToolsState(), ctxFor({
      hasUnansweredUser: false,
      triggerRow: null,
      turnCtx: turnCtx({ startAckSteerRequested: true }),
    }));
    expect(out.directive).toBe('continue');
  });

  it('RED clause 3 — an ARMED steer that has not been delivered is owed too', () => {
    const out = runEmptyResponse(afterToolsState(), ctxFor({
      hasUnansweredUser: false,
      triggerRow: null,
      turnCtx: turnCtx({ startAckSteerArmedThisTurn: true }),
    }));
    expect(out.directive).toBe('continue');
  });

  // ── THE CONTROLS: every one of these must exit exactly as it did before HL2 ──

  it('CONTROL — nobody is owed: the not-a-failure exit is untouched', () => {
    const out = runEmptyResponse(afterToolsState(), ctxFor({
      hasUnansweredUser: false, triggerRow: null,
    }));
    expect(out.directive).toBe('exit');
    if (out.directive !== 'exit') throw new Error('unreachable');
    expect(out.reason).toBe('empty-response-after-tools');
  });

  it('CONTROL — an A2A turn is not a person, even with a trigger row', () => {
    expect(runEmptyResponse(afterToolsState(), ctxFor({ isA2ATurn: true })).directive).toBe('exit');
    expect(runEmptyResponse(afterToolsState(), ctxFor({ isEngineTurn: true })).directive).toBe('exit');
    expect(runEmptyResponse(afterToolsState(), ctxFor({ counterpartyIsAgentSender: true })).directive).toBe('exit');
  });

  it('CONTROL — a model whose contract says answersInReasoning:false never takes the branch', () => {
    CONTRACT = { ...ANSWERS_IN_REASONING, answersInReasoning: false };
    const out = runEmptyResponse(afterToolsState(), ctxFor());
    expect(out.directive).toBe('exit');
    if (out.directive !== 'exit') throw new Error('unreachable');
    expect(out.reason).toBe('empty-response-after-tools');
  });

  it('CONTROL — a blank or absent reasoning channel is a real no-comment', () => {
    for (const reasoningContent of [undefined, '', '   \n  ']) {
      const out = runEmptyResponse(afterToolsState(), ctxFor({
        result: modelResult(reasoningContent === undefined ? {} : { reasoningContent }),
      }));
      expect(out.directive).toBe('exit');
    }
  });

  it('CONTROL — the latch is SHARED: a turn gets one silent retry, whichever door asked', () => {
    const out = runEmptyResponse(afterToolsState({ retriedEmptyResponse: true }), ctxFor());
    expect(out.directive).toBe('exit');
    if (out.directive !== 'exit') throw new Error('unreachable');
    expect(out.reason).toBe('empty-response-after-tools');
  });

  it('CONTROL — a contract with emptyRetryBudget 0 gets no silent retry from EITHER door', () => {
    CONTRACT = { ...ANSWERS_IN_REASONING, emptyRetryBudget: 0 };
    // the wrong-channel door
    expect(runEmptyResponse(afterToolsState(), ctxFor()).directive).toBe('exit');
    // and the ordinary empty-response door, which skips straight to the nudge
    const noTools = runEmptyResponse(afterToolsState({ toolCallsExecutedThisTurn: 0 }), ctxFor());
    expect(noTools.directive).toBe('continue');
    if (noTools.directive !== 'continue') throw new Error('unreachable');
    expect(noTools.state.retriedEmptyResponse).toBe(false);
    expect(steerFired(noTools.state.steerQueue, 'empty-response')).toBe(true);
  });

  it('CONTROL — a turn that ran NO tools still walks the original ladder', () => {
    const out = runEmptyResponse(afterToolsState({ toolCallsExecutedThisTurn: 0 }), ctxFor());
    expect(out.directive).toBe('continue');
    if (out.directive !== 'continue') throw new Error('unreachable');
    expect(out.state.retriedEmptyResponse).toBe(true);
  });

  it('CONTROL — a turn WITH visible content never reaches this guard (the sentinel case)', () => {
    const out = runEmptyResponse(afterToolsState(), ctxFor({
      result: modelResult({ content: '[no-reply]', reasoningContent: 'lots of thinking' }),
    }));
    expect(out.directive).toBe('proceed');
  });
});
