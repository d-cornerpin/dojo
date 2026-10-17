// ════════════════════════════════════════════════════════════════════════════════════════
// t195 (D2) — THE GRIND RUNG ESCALATES INSTEAD OF ONLY STEERING.
//
// Before: the rung steered once and gave up on the second grind; the "plain truncation" rung
// that was supposed to widen the budget set a number nothing read, and was unreachable
// anyway (the grind rung takes every truncation with no tool call first).
// After: the first grind asks for twice the room (bounded by what the call reported) AND
// carries the steer; a second grind gives up on the owner's existing surface.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ToolCall } from '@dojo/shared';

const broadcastSpy = vi.fn();
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: (...a: unknown[]) => broadcastSpy(...(a as [])) }));

import { advance, initState, type AgentTurnState } from '../../../state.js';
import { runEmptyResponse } from '../empty-response.js';
import { steerFired } from '../../../steer-queue.js';
import type { PostCallClassifyContext } from '../index.js';

const reArmSpy = vi.fn();

const grind = (room: { sent: number; ceiling: number } | undefined = { sent: 16_384, ceiling: 384_000 }): PostCallClassifyContext['result'] => ({
  content: '', toolCalls: [] as ToolCall[], inputTokens: 10, outputTokens: 16_384,
  stopReason: 'length', ...(room ? { outputRoom: room } : {}),
} as unknown as PostCallClassifyContext['result']);

const ctxFor = (result: PostCallClassifyContext['result']): PostCallClassifyContext => ({
  agentId: 'test-agent', turnNumber: 7, chosenConvKey: null, result,
  reArmIfStrandedNoAnswer: reArmSpy,
  turnCtx: { startAckSteerRequested: false, startAckSteerArmedThisTurn: false, engineStartAckDeliveredThisTurn: false, root: null },
  isA2ATurn: false, isEngineTurn: false, counterpartyIsAgentSender: false, hasUnansweredUser: false, triggerRow: null,
} as unknown as PostCallClassifyContext);

function freshState(over: Partial<AgentTurnState> = {}): AgentTurnState {
  const base = initState({
    agentId: 'test-agent', contextWindow: 128_000, isAutoRouted: false,
    configuredModelId: 'test-model', turnNumber: 7, triggeredByIMessage: false,
    triggeredByA2AReplyIntent: null, lastUserMessageContent: 'do the thing', lastUserMessageId: 'msg-user-1',
  } as Parameters<typeof initState>[0]);
  return advance(base, { phase: 'postCallClassify', loopCount: 2, modelId: 'test-model', ...over });
}

beforeEach(() => { vi.clearAllMocks(); });

describe('t195 — a grind retries once with MORE room', () => {
  it('the first grind asks for twice the budget it was cut at, and still carries the steer', () => {
    const out = runEmptyResponse(freshState(), ctxFor(grind()));
    expect(out.directive).toBe('continue');
    if (out.directive !== 'continue') throw new Error('unreachable');
    expect(out.state.outputTokensEscalated).toBe(32_768);
    expect(steerFired(out.state.steerQueue, 'output-grind')).toBe(true);
    // Nothing was said to the person: the retry is the agent's chance.
    expect(broadcastSpy.mock.calls.map((c) => (c[0] as { type: string }).type).filter((t) => t === 'chat:error')).toEqual([]);
  });

  it('the ask is bounded by the room the call reported', () => {
    const out = runEmptyResponse(freshState(), ctxFor(grind({ sent: 300_000, ceiling: 384_000 })));
    if (out.directive !== 'continue') throw new Error('unreachable');
    expect(out.state.outputTokensEscalated).toBe(384_000);
  });

  it('with no room left to give, the rung steers exactly as before and asks for nothing', () => {
    const out = runEmptyResponse(freshState(), ctxFor(grind({ sent: 384_000, ceiling: 384_000 })));
    if (out.directive !== 'continue') throw new Error('unreachable');
    expect(out.state.outputTokensEscalated).toBe(0);
    expect(steerFired(out.state.steerQueue, 'output-grind')).toBe(true);
  });

  it('a transport that reports no room (local or SDK path) is steered as before', () => {
    const out = runEmptyResponse(freshState(), ctxFor(grind(undefined)));
    if (out.directive !== 'continue') throw new Error('unreachable');
    expect(out.state.outputTokensEscalated).toBe(0);
  });

  it('a grind after the extra room was spent gives up on the owner\'s existing surface', () => {
    const first = runEmptyResponse(freshState(), ctxFor(grind()));
    if (first.directive !== 'continue') throw new Error('unreachable');
    vi.clearAllMocks();
    const second = runEmptyResponse(advance(first.state, { phase: 'postCallClassify' }), ctxFor(grind({ sent: 32_768, ceiling: 384_000 })));
    expect(second.directive).toBe('exit');
    const errs = broadcastSpy.mock.calls.map((c) => c[0] as { type: string; error?: string }).filter((e) => e.type === 'chat:error');
    expect(errs).toHaveLength(1);
    expect(errs[0].error).toMatch(/ran out of room/);
    expect(reArmSpy).toHaveBeenCalledTimes(1);
  });

  it('the unreachable plain-truncation rung is deleted, not left beside the real one', () => {
    const src = readFileSync(path.resolve(__dirname, '../empty-response.ts'), 'utf8');
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    // exactly one reader of the classifier now: the grind rung.
    expect(code.match(/outputTruncationClassifier\(/g)?.length).toBe(1);
  });
});
