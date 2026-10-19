// ════════════════════════════════════════════════════════════════════════════════════════
// t239 (c) — A CUT RESPONSE'S TOOL CALLS ARE NEVER RUN.
//
// Before: the t195 output-grind rung acted only when the cut response had NO tool call
// (`result.toolCalls.length === 0`). A response cut mid-sentence whose tool call had already
// parsed fell past it and the call RAN: a half-written deliverable was sent as if whole.
// After: a cut response takes the same escalation whatever it carries. The rung returns
// `continue` BEFORE the assistant row is persisted and before the execute step is reached, so
// the cut call does not run; the model is told its output was cut and that nothing was sent.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolCall } from '@dojo/shared';

const broadcastSpy = vi.fn();
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: (...a: unknown[]) => broadcastSpy(...(a as [])) }));

import { advance, initState, type AgentTurnState } from '../../../state.js';
import { runEmptyResponse } from '../empty-response.js';
import { steerFired } from '../../../steer-queue.js';
import type { PostCallClassifyContext } from '../index.js';

const reArmSpy = vi.fn();

const cutSend = (stopReason: string, over: Record<string, unknown> = {}): PostCallClassifyContext['result'] => ({
  content: 'Chapter two. The light turned green and the bus pulled out, waiting for the light to change',
  toolCalls: [{ id: 'tc-1', name: 'send_to_agent', arguments: { intent: 'DELIVERABLE', payload: 'half a story' } }] as ToolCall[],
  inputTokens: 22_396, outputTokens: 8_324, stopReason,
  outputRoom: { sent: 8_192, ceiling: 32_768 },
  ...over,
} as unknown as PostCallClassifyContext['result']);

const ctxFor = (result: PostCallClassifyContext['result']): PostCallClassifyContext => ({
  agentId: 'helper', turnNumber: 7, chosenConvKey: null, result,
  reArmIfStrandedNoAnswer: reArmSpy,
  turnCtx: { startAckSteerRequested: false, startAckSteerArmedThisTurn: false, engineStartAckDeliveredThisTurn: false, root: null },
  isA2ATurn: true, isEngineTurn: false, counterpartyIsAgentSender: true, hasUnansweredUser: false, triggerRow: null,
} as unknown as PostCallClassifyContext);

function freshState(over: Partial<AgentTurnState> = {}): AgentTurnState {
  const base = initState({
    agentId: 'helper', contextWindow: 30_720, isAutoRouted: false,
    configuredModelId: 'test-model', turnNumber: 7, triggeredByIMessage: false,
    triggeredByA2AReplyIntent: null, lastUserMessageContent: 'write the story', lastUserMessageId: 'msg-1',
  } as Parameters<typeof initState>[0]);
  return advance(base, { phase: 'postCallClassify', loopCount: 2, modelId: 'test-model', ...over });
}

beforeEach(() => { vi.clearAllMocks(); });

describe('t239 (c) — a cut response with a tool call takes the output-grind escalation', () => {
  it('RED→GREEN: the cut call does not run (the loop continues), the model is told it was cut and given the extra room', () => {
    const out = runEmptyResponse(freshState(), ctxFor(cutSend('length')));
    expect(out.directive).toBe('continue');
    if (out.directive !== 'continue') throw new Error('unreachable');
    expect(out.state.outputTokensEscalated).toBe(16_384);
    expect(steerFired(out.state.steerQueue, 'output-grind')).toBe(true);
    // The steer is true for THIS shape: it says the tool call did not run and nothing was sent.
    const steer = JSON.stringify(out.state.steerQueue);
    expect(steer).toMatch(/cut off/i);
    expect(steer).toMatch(/did not run|was not run|nothing was sent/i);
    expect(steer).not.toMatch(/no tool call/i);
    // Nothing was said to anyone: the retry is the agent's chance.
    expect(broadcastSpy.mock.calls.map((c) => (c[0] as { type: string }).type)).not.toContain('chat:error');
  });

  it('the Anthropic spelling of a cut (max_tokens) takes the same path', () => {
    const out = runEmptyResponse(freshState(), ctxFor(cutSend('max_tokens')));
    expect(out.directive).toBe('continue');
  });

  it('a cut again after the extra room was given gives up on the owner\'s existing surface, and the call still never runs', () => {
    const first = runEmptyResponse(freshState(), ctxFor(cutSend('length')));
    if (first.directive !== 'continue') throw new Error('unreachable');
    vi.clearAllMocks();
    const second = runEmptyResponse(advance(first.state, { phase: 'postCallClassify' }), ctxFor(cutSend('length', { outputRoom: { sent: 16_384, ceiling: 32_768 } })));
    expect(second.directive).toBe('exit');
    expect(reArmSpy).toHaveBeenCalledTimes(1);
  });

  it('CONTROL: a whole response with a tool call (tool_use) is not touched by the rung', () => {
    const out = runEmptyResponse(freshState(), ctxFor(cutSend('tool_use')));
    expect(out.directive).toBe('proceed');
  });

  it('CONTROL: the no-tool-call grind keeps its own wording', () => {
    const out = runEmptyResponse(freshState(), ctxFor(cutSend('length', { toolCalls: [], content: '' })));
    if (out.directive !== 'continue') throw new Error('unreachable');
    expect(JSON.stringify(out.state.steerQueue)).toMatch(/no tool call and no answer/);
  });
});
