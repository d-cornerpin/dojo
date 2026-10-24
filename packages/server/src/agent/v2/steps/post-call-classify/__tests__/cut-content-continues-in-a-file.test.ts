// v3.5 B13 — a reply cut off by the output limit after it WROTE something is told to put it in a file
// and finish it a part at a time; a cut with nothing written keeps the "thinking" steer unchanged.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolCall } from '@dojo/shared';

vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { advance, initState, type AgentTurnState } from '../../../state.js';
import { runEmptyResponse } from '../empty-response.js';
import { nextSteer } from '../../../steer-queue.js';
import type { PostCallClassifyContext } from '../index.js';

const cut = (content: string, toolCalls: ToolCall[] = []): PostCallClassifyContext => ({
  agentId: 'agent-writer', turnNumber: 7, chosenConvKey: null,
  result: { content, toolCalls, inputTokens: 10, outputTokens: 16_384, stopReason: 'length' },
  reArmIfStrandedNoAnswer: vi.fn(),
  turnCtx: { startAckSteerRequested: false, startAckSteerArmedThisTurn: false, engineStartAckDeliveredThisTurn: false, root: null },
  isA2ATurn: false, isEngineTurn: false, counterpartyIsAgentSender: false, hasUnansweredUser: false, triggerRow: null,
} as unknown as PostCallClassifyContext);

function freshState(): AgentTurnState {
  const base = initState({
    agentId: 'agent-writer', contextWindow: 128_000, isAutoRouted: false, configuredModelId: 'test-model', turnNumber: 7,
    triggeredByIMessage: false, triggeredByA2AReplyIntent: null, lastUserMessageContent: 'write me the report', lastUserMessageId: 'm1',
  } as Parameters<typeof initState>[0]);
  return advance(base, { phase: 'postCallClassify', loopCount: 2, modelId: 'test-model' });
}

const steerFor = (ctx: PostCallClassifyContext): string => {
  const out = runEmptyResponse(freshState(), ctx);
  if (out.directive !== 'continue') throw new Error(`expected continue, got ${out.directive}`);
  return nextSteer(out.state.steerQueue)!.content;
};

beforeEach(() => { vi.clearAllMocks(); });

describe('B13: cut content continues in a file', () => {
  it('a cut with 4,000 characters of content and no tool call: the file steer', () => {
    const text = steerFor(cut('Chapter one. '.repeat(310)));
    expect(text).toBe('[System: Your last reply was CUT OFF by the output limit; what you wrote so far did not reach anyone. '
      + 'Put it in a file: file_write what you have, file_append the rest a part at a time, then send the path.]');
  });
  it('a cut with no content: the thinking steer, unchanged', () => {
    expect(steerFor(cut(''))).toBe('[System: Your last response used your ENTIRE output budget thinking and produced no tool call and no answer, so none of it reached anyone. '
      + 'Do not plan further. Take the single next concrete step now: make ONE tool call, or give the short answer you already have. Keep it brief.]');
  });
  it('a cut that carried a tool call keeps its own steer', () => {
    expect(steerFor(cut('checking', [{ id: 'c1', name: 'file_write', arguments: { path: '/tmp/x', content: 'y' } } as ToolCall])))
      .toMatch(/^\[System: Your last response was CUT OFF by the output limit, so its tool call did NOT run/);
  });
});
