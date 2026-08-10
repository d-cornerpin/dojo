// UX-REPAIR ROUND 2 / T10 — THE ONE NARROW EXEMPTION TO A2A TAIL SCOPING.
//
// ── THE DEFECT THIS PINS (investigation-round2.md §1, orchestrator-verified) ──
// The fan-out compile order is an ENGINE RIDER: a row that must be SEEN during a turn that is
// happening anyway, whose recorded delivery contract is "the deliverable's own wake carries it
// to the model" (`agent/a2a-transport.ts`, owner option B, 2026-07-18). But a delegated job's
// own wake IS an A2A turn, and `scopeToA2AThread` ends `return false; // exclude human + engine`
// — a `b2027b0` rule that predates the rider design by six weeks and was never reconciled with
// it. Measured on the box (S4, 2026-08-10): the compile order and redrives 1 and 2 were filtered
// out of turns 4553 and 4554 entirely; the answer came on turn 4555 only because that wake
// happened to be bare and therefore took the HUMAN scoper, which keeps engine rows.
//
// ── WHY THE EXEMPTION IS EXACTLY ONE INTENT AND NOT A CLASS ──
// `b2027b0`'s requirement is "one counterparty per turn; a second conversation never bleeds in".
// The compile order is not counterparty content at all: it is an imperative addressed to THIS
// agent, quoting THIS agent's OWN children's returned pieces. Nothing about it is another
// conversation. Every OTHER engine intent stays excluded, and the enumeration below is what
// makes that a gate rather than a sentence — a new rider intent is excluded by default and a
// future widening has to come here and argue.
import { describe, it, expect } from 'vitest';
import type { Message, MessageOrigin } from '@dojo/shared';
import { scopeToA2AThread } from '../assembler.js';
import { ENGINE_RIDER_INTENTS } from '../../agent/v2/engine-riders.js';

const THREAD = '1a952a39-1111-2222-3333-444444444444';
const OTHER_THREAD = '34430191-9999-8888-7777-666666666666';

function msg(partial: Partial<Message> & Pick<Message, 'id' | 'role' | 'content'>): Message {
  return {
    agentId: 'a1', tokenCount: null, modelId: null, cost: null, latencyMs: null,
    createdAt: '2026-08-10 06:17:10', ...partial,
  } as Message;
}

function engineOrigin(intent: string | null): MessageOrigin {
  return {
    kind: 'engine', relation: 'engine', channel: 'engine',
    senderName: null, senderId: null, threadId: null, intent, authorized: false,
  };
}

function agentOrigin(threadId: string): MessageOrigin {
  return {
    kind: 'agent', relation: 'agent', channel: 'a2a',
    senderName: 'Ticky', senderId: 'ticky', threadId, intent: 'ASSIGN', authorized: true,
  };
}

function humanOrigin(): MessageOrigin {
  return {
    kind: 'user', relation: 'owner', channel: 'dashboard',
    senderName: 'David', senderId: 'david', threadId: null, intent: null, authorized: true,
  };
}

const compileOrder = msg({
  id: 'steer-fanout', role: 'user', origin: engineOrigin('fanout_join'),
  content: 'All 2 delegated pieces for the owner\'s request are now back.',
});
const thisThreadPeer = msg({
  id: 'peer-here', role: 'user', origin: agentOrigin(THREAD), content: 'here is my piece',
});
const otherThreadPeer = msg({
  id: 'peer-elsewhere', role: 'user', origin: agentOrigin(OTHER_THREAD), content: 'a different job',
});
const ownerLine = msg({
  id: 'owner-line', role: 'user', origin: humanOrigin(), content: 'can you also book the flight?',
});

describe('T10: the compile order survives the A2A scoper', () => {
  it('an A2A turn keeps the fan-out compile order in its tail', () => {
    const kept = scopeToA2AThread([compileOrder, thisThreadPeer], THREAD).map((m) => m.id);
    expect(kept).toContain('steer-fanout');
  });

  it('the exemption does not re-open cross-conversation bleed: the owner and other threads stay out', () => {
    const kept = scopeToA2AThread(
      [compileOrder, thisThreadPeer, otherThreadPeer, ownerLine], THREAD,
    ).map((m) => m.id);
    expect(kept).toEqual(['steer-fanout', 'peer-here']);
  });
});

describe('T10 conformance: fanout_join is the ONLY engine intent an A2A tail keeps', () => {
  // The whole rider table, enumerated from its own module so a new intent cannot be added
  // without this gate seeing it.
  const EXEMPT = new Set(['fanout_join']);

  for (const intent of ENGINE_RIDER_INTENTS) {
    it(`origin_intent='${intent}' is ${EXEMPT.has(intent) ? 'KEPT (the one exemption)' : 'excluded'} from an A2A tail`, () => {
      const row = msg({ id: `row-${intent}`, role: 'user', origin: engineOrigin(intent), content: 'x' });
      const kept = scopeToA2AThread([row, thisThreadPeer], THREAD).map((m) => m.id);
      expect(kept.includes(`row-${intent}`)).toBe(EXEMPT.has(intent));
    });
  }

  it('an engine row with no intent at all stays excluded', () => {
    const row = msg({ id: 'row-bare', role: 'user', origin: engineOrigin(null), content: 'x' });
    expect(scopeToA2AThread([row, thisThreadPeer], THREAD).map((m) => m.id)).toEqual(['peer-here']);
  });

  it('an engine intent that is NOT a declared rider stays excluded', () => {
    const row = msg({ id: 'row-unknown', role: 'user', origin: engineOrigin('some_future_intent'), content: 'x' });
    expect(scopeToA2AThread([row, thisThreadPeer], THREAD).map((m) => m.id)).toEqual(['peer-here']);
  });
});
