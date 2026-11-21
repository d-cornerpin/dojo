// t281b: (R2) owner matching per channel; (R3) the bridge-down words.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { ownerNumbers, ownerMail } = vi.hoisted(() => ({
  ownerNumbers: new Set<string>(),
  ownerMail: [] as Array<{ address: string }>,
}));
vi.mock('../../../services/safe-senders.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isOwnerIMessageRecipient: (a: string) => ownerNumbers.has(a) }));
vi.mock('../../../services/owner-mailboxes.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ownerMailboxes: () => ownerMail }));

import { computeTurnAddress } from '../turn-address.js';
import { recipientNoteFor, routedReplyWords } from '../send-recipient.js';
import { openTurnContext, endTurnContext } from '../../turn-context.js';
import type { TurnCounterparty } from '../counterparty.js';

const owner: TurnCounterparty = { kind: 'user', name: 'Owner Example', relation: 'owner', channel: 'dashboard', senderId: null, threadId: null, senderIsAgent: false };
const contact: TurnCounterparty = { kind: 'user', name: 'Pat Example', relation: 'known_contact', channel: 'imessage', senderId: '+15550100', threadId: null, senderIsAgent: false };
const mk = (cp: TurnCounterparty, inbound: 'imessage' | 'dashboard' | null) =>
  computeTurnAddress({ autoRoutes: true, counterparty: cp, isEngineTurn: false, isNotificationTurn: false, inboundChannel: inbound, inboundContext: null });

beforeEach(() => { ownerNumbers.clear(); ownerMail.length = 0; endTurnContext('primary'); });

describe('R2: the owner is matched by the channel\'s own owner rule', () => {
  function ownerTurn() {
    const t = openTurnContext('primary');
    t.address = mk(owner, 'imessage');
  }
  it('emailing the owner\'s connected mailbox is the person this turn is talking to, never "not"', () => {
    ownerMail.push({ address: 'owner@owner-mail.test' });
    ownerTurn();
    const n = recipientNoteFor('primary', 'gmail_send', { to: 'Owner@Owner-Mail.test', subject: 's' });
    expect(n).toContain('This is the person this turn is talking to.');
    expect(n).not.toMatch(/not the person/);
    expect(recipientNoteFor('primary', 'gmail_send', { to: 'someone@else.test' })).toMatch(/not the person/);
  });
  it('texting the owner\'s number by SMS or iMessage is the same', () => {
    ownerNumbers.add('+15550199');
    ownerTurn();
    for (const [tool, args] of [['sms_send', { to: '+15550199', body: 'x' }], ['imessage_send', { recipient: '+15550199', message: 'x' }]] as const) {
      expect(recipientNoteFor('primary', tool, args as Record<string, unknown>), tool).toContain('This is the person this turn is talking to.');
    }
  });
});

describe('R3: the bridge-down words', () => {
  it('do not ask the agent to tell someone it has just said it cannot reach, and say "down" only when it is down', () => {
    const t = openTurnContext('primary');
    t.address = mk(contact, 'imessage');
    const r = routedReplyWords('primary')!;
    expect(r.where).toBe('your written reply will not reach Pat Example by iMessage either; it stays in the dashboard chat');
    expect(r.where).not.toMatch(/tell|while it is down/i);
    expect(r.down).toBe('You cannot reach Pat Example by iMessage right now, and your written reply will not reach them either; it stays in the dashboard chat.');
  });
});
