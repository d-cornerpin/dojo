// v3.5 field fix 3, audit round (#4). The owner, 2026-11-04 (verbatim): "I was clear that the main agent
// owns the Mac they live in and the dojo doesn't limit them." / "I fucking LOVE when the agent tells
// the user "do it yourself"." (sarcastic: he is furious when it does).
//
// `ENGINE_BLOCK_ESCAPE_HATCH` (agent/v2/loop.ts) was appended to five engine refusals (the thrash
// gate, the loop-break, the A2A send cap, the thrash refusal and the compile gate) and told the agent:
// "tell the person you are talking to what you were trying to do and that the engine blocked it, so
// they can decide." That hands the owner the engine's problem and narrates engine internals. It is
// deleted; each refusal states its facts.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runRefusalGates } from '../steps/execute/refusal-gates.js';
import { advance, initState } from '../state.js';

describe('no engine refusal hands the owner the problem', () => {

  it('the A2A send-cap refusal states facts: no "End your turn now", no hatch', () => {
    const state = advance(initState({ agentId: 'a', maxToolLoops: 75, turnNumber: 1, lastUserMessageContent: null } as never),
      { sendsPerAgentThisTurn: { pm: 5 } });
    const ctx = { agentId: 'a', turnNumber: 1, turnCtx: {}, counterparty: { kind: 'agent' }, reminderLaneRefusedSigs: new Set<string>() };
    const text = runRefusalGates(state as never, { id: 'c', name: 'send_to_agent', arguments: { to_agent: 'pm', message: 'x' } } as never, ctx as never, true).refusal?.content ?? '';
    expect(text).toContain('already sent');
    expect(text).toContain('5 messages this turn');
    expect(text).not.toMatch(/End your turn now/);
    expect(text).not.toMatch(/engine blocked it|tell the person/i);
  });
});
