// RC-1 no-bleed regression gates.
//
// The dual-home echo row (loop.ts persistCrossConvSendEcho) records a cross-recipient
// send INTO the recipient's conversation so their next turn can bind a bare answer to
// the question. The mandated regression gates from RC-1's History check encode the OLD
// conversation-bleed bug the attribution redesign killed, and this fix must not
// reintroduce it:
//
//   (a) the echo row appears in the RECIPIENT's scoped tail and NOT in the original
//       counterparty's scoped tail (beyond that counterparty's own conversation);
//   (b) scopeToHumanConversation still excludes OTHER conversations' user rows
//       (existing no-bleed behavior, pinned);
//   (c) the pending-question header only ever contains sends TO the current
//       counterparty (guaranteed by the ledger recipient filter, recipientMatchesAliases).

import { describe, it, expect } from 'vitest';
import type { Message, MessageOrigin } from '@dojo/shared';
import { scopeToHumanConversation } from '../assembler.js';
import { conversationKey, type TurnCounterparty } from '../../agent/v2/counterparty.js';
import { recipientMatchesAliases } from '../../agent/v2/outbound-ledger.js';

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

const mayaKey = conversationKey('imessage', 'maya', 'Maya', null);   // imessage:maya
const davidKey = conversationKey('imessage', 'sam', 'Sam', null); // imessage:sam

// The synthetic echo row persistCrossConvSendEcho writes: an assistant row homed to
// the RECIPIENT's conversation (Sam), carrying the verbatim sent question.
const echoRow = msg({
  id: 'echo1', role: 'assistant',
  content: '[Sent via iMessage to Sam]: whats your Delta SkyMiles number?',
  convKey: davidKey, origin: selfOrigin,
});
const mayaUserRow = msg({
  id: 'maya-in', role: 'user', content: 'can you ask Sam for his SkyMiles number?',
  convKey: null, origin: userOrigin('imessage', 'maya', 'Maya'),
});
const davidUserRow = msg({
  id: 'david-in', role: 'user', content: '5550001234',
  convKey: null, origin: userOrigin('imessage', 'sam', 'Sam'),
});

describe('RC-1 gate (a): the echo row is homed to the RECIPIENT only', () => {
  it("appears in Sam's (recipient) scoped tail", () => {
    const scoped = scopeToHumanConversation([mayaUserRow, echoRow, davidUserRow], userCp('imessage', 'sam', 'Sam'));
    expect(scoped.map((m) => m.id)).toContain('echo1');
    // and Sam's own inbound stays, Maya's inbound is gone
    expect(scoped.map((m) => m.id)).toContain('david-in');
    expect(scoped.map((m) => m.id)).not.toContain('maya-in');
  });

  it("does NOT appear in Maya's (original counterparty) scoped tail", () => {
    const scoped = scopeToHumanConversation([mayaUserRow, echoRow, davidUserRow], userCp('imessage', 'maya', 'Maya'));
    expect(scoped.map((m) => m.id)).not.toContain('echo1');
    expect(scoped.map((m) => m.id)).toContain('maya-in');
    expect(scoped.map((m) => m.id)).not.toContain('david-in');
  });
});

describe('RC-1 gate (b): scopeToHumanConversation still excludes other conversations user rows', () => {
  it('a different human conversation never crosses into a turn scoped elsewhere', () => {
    // Sam's turn must not see Maya's inbound, and vice versa (the exact conflation
    // the redesign kills; pinned so the echo change does not loosen it).
    const davidScoped = scopeToHumanConversation([mayaUserRow, davidUserRow], userCp('imessage', 'sam', 'Sam'));
    expect(davidScoped.map((m) => m.id)).toEqual(['david-in']);
    const mayaScoped = scopeToHumanConversation([mayaUserRow, davidUserRow], userCp('imessage', 'maya', 'Maya'));
    expect(mayaScoped.map((m) => m.id)).toEqual(['maya-in']);
  });

  it('a self row stamped for another conversation is dropped (re-answer-ghost guard)', () => {
    const otherSelf = msg({ id: 'other-self', role: 'assistant', content: 'done', convKey: mayaKey, origin: selfOrigin });
    const scoped = scopeToHumanConversation([otherSelf, davidUserRow], userCp('imessage', 'sam', 'Sam'));
    expect(scoped.map((m) => m.id)).not.toContain('other-self');
  });
});

describe('RC-1 gate (c): the pending-question header quotes only sends TO the counterparty', () => {
  // findRecentDeliveries filters receipts by recipientMatchesAliases; the header uses
  // that result, so a send to Maya can never surface on Sam's turn and vice versa.
  it('a receipt to another party does not match the counterparty aliases', () => {
    const davidAliases = ['sam', '+15550001234'];
    expect(recipientMatchesAliases('Maya', davidAliases)).toBe(false);
    expect(recipientMatchesAliases('maya@example.com', davidAliases)).toBe(false);
  });

  it('a receipt to the counterparty (by name or handle) matches', () => {
    expect(recipientMatchesAliases('Sam', ['sam'])).toBe(true);
    expect(recipientMatchesAliases('+15550001234', ['+15550001234'])).toBe(true);
    // recipient carries "Name <handle>"; a handle alias still matches by substring
    expect(recipientMatchesAliases('Sam <+15550001234>', ['+15550001234'])).toBe(true);
  });

  it('short aliases (< 3 chars) never match (avoids spurious substring hits)', () => {
    expect(recipientMatchesAliases('Sam', ['s'])).toBe(false);
  });
});
