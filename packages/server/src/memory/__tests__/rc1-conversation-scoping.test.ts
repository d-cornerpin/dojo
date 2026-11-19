// RC-1 no-bleed regression gates.
//
// The dual-home echo row (loop.ts `persistCrossConvSendEcho`) recorded a cross-recipient
// send INTO the recipient's conversation so their next turn could bind a bare answer to the
// question. The mandated regression gates from RC-1's History check encode the OLD
// conversation-bleed bug the attribution redesign killed:
//
//   (a) the echo row appears in the RECIPIENT's scoped tail and NOT in the original
//       counterparty's — STRIPPED at PHASE-3 T7 Step 2 with the writer; see the note below;
//   (b) scopeToHumanConversation still excludes OTHER conversations' user rows
//       (existing no-bleed behavior, pinned) — STAYS, it is the assembler's own law;
//   (c) moved: the one "was it sent to this person" reader is pinned by its own behaviour test.

import { describe, it, expect } from 'vitest';
import type { Message, MessageOrigin } from '@dojo/shared';
import { scopeToHumanConversation } from '../assembler.js';
import { conversationKey, type TurnCounterparty } from '../../agent/v2/counterparty.js';
import { FXID } from '../../../../../deploy/checks/fixture-vocabulary.mjs';

// ── builders ──

function userCp(channel: 'imessage', senderId: string, name: string): TurnCounterparty {
  return { kind: 'user', name, relation: 'known_contact', channel, senderId, threadId: null, senderIsAgent: false };
}

const selfOrigin: MessageOrigin = {
  kind: 'self', relation: 'agent', channel: null,
  senderName: null, senderId: null, threadId: null, intent: null, authorized: true,
};

function userOrigin(channel: 'imessage', senderId: string, name: string): MessageOrigin {
  return {
    kind: 'user', relation: 'known_contact', channel,
    senderName: name, senderId, threadId: null, intent: null, authorized: true,
  };
}

function msg(partial: Partial<Message> & Pick<Message, 'id' | 'role' | 'content'>): Message {
  return {
    agentId: 'a1', tokenCount: null, modelId: null, cost: null, latencyMs: null,
    createdAt: '2026-07-15 12:00:00', ...partial,
  } as Message;
}

// PHASE-2 T10I: the conversation is `conversations.id` now, so the scoper takes it as an
// argument rather than re-deriving a key. `conversationKey` is still exercised below — the
// INBOUND half of the scoper still matches human rows on their origin, and this is the
// function that decides that — so the import is not residue.
const mayaConv = 'conv-maya';
const samConv = 'conv-sam';
// A positive control on the surviving matcher: the scoper's INBOUND half still decides
// membership with this function, so if it ever stopped producing a stable key the gates below
// would pass for the wrong reason.
expect(conversationKey('imessage', 'maya', 'Maya', null)).toBe('imessage:maya');

// STRIP (T7 Step 2): the synthetic echo-row fixture went with gate (a) below.
const mayaUserRow = msg({
  id: 'maya-in', role: 'user', content: 'can you ask Sam for his SkyMiles number?',
  conversationId: null, origin: userOrigin('imessage', 'maya', 'Maya'),
});
const davidUserRow = msg({
  id: `${FXID.n11}-in`, role: 'user', content: '5550001234',
  conversationId: null, origin: userOrigin('imessage', 'sam', 'Sam'),
});

// ── STRIP (PHASE-3 T7 Step 2, 2026-08-01): RC-1 gate (a) is DELETED with its subject. ──
// It asserted that the ECHO ROW appeared in Sam's scoped tail and not in Maya's. There is no
// echo row any more: `persistCrossConvSendEcho` is deleted, so these two clauses would be
// asserting the assembler's handling of a shape production can no longer produce -- a test
// that passes forever and guards nothing.
//
// requirement preserved: the recipient's next turn sees the question it was asked, and the
// original counterparty does not. That is the DELIVERIES LANE's now, and it is held by
// `memory/__tests__/deliveries-lane.test.ts` -> "a send into ANOTHER conversation never
// surfaces on this turn, and DOES on that one", written and green BEFORE the writer was
// deleted (roadmap #2). It is a structurally stronger home: the lane is scoped by the
// conversation being served, so it cannot bleed, where the echo row's no-bleed depended on
// the assembler filtering out a row the engine had deliberately persisted elsewhere.
//
// Gate (b) below is not about the echo and stays: it is the assembler's own no-bleed law.

describe('RC-1 gate (b): scopeToHumanConversation still excludes other conversations user rows', () => {
  it('a different human conversation never crosses into a turn scoped elsewhere', () => {
    // Sam's turn must not see Maya's inbound, and vice versa (the exact conflation
    // the redesign kills; pinned so the echo change does not loosen it).
    const davidScoped = scopeToHumanConversation([mayaUserRow, davidUserRow], userCp('imessage', 'sam', 'Sam'), samConv);
    expect(davidScoped.map((m) => m.id)).toEqual([`${FXID.n11}-in`]);
    const mayaScoped = scopeToHumanConversation([mayaUserRow, davidUserRow], userCp('imessage', 'maya', 'Maya'), mayaConv);
    expect(mayaScoped.map((m) => m.id)).toEqual(['maya-in']);
  });

  it('a self row stamped for another conversation is dropped (re-answer-ghost guard)', () => {
    const otherSelf = msg({ id: 'other-self', role: 'assistant', content: 'done', conversationId: mayaConv, origin: selfOrigin });
    const scoped = scopeToHumanConversation([otherSelf, davidUserRow], userCp('imessage', 'sam', 'Sam'), samConv);
    expect(scoped.map((m) => m.id)).not.toContain('other-self');
  });
});
