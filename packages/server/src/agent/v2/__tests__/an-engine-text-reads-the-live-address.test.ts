// t281b: (R1) engine texts read the LIVE address; (R2) owner matching per channel; (R3) the bridge-down words.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { presence, ownerNumbers, ownerMail } = vi.hoisted(() => ({
  presence: { now: 'in_dojo' as 'in_dojo' | 'away' },
  ownerNumbers: new Set<string>(),
  ownerMail: [] as Array<{ address: string }>,
}));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => presence.now, isImessageConfigured: () => true }));
vi.mock('../../../services/safe-senders.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isOwnerIMessageRecipient: (a: string) => ownerNumbers.has(a) }));
vi.mock('../../../services/owner-mailboxes.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ownerMailboxes: () => ownerMail }));

import { computeTurnAddress } from '../turn-address.js';
import { startAckSteerText } from '../steps/assemble/start-ack-door.js';
import { recipientNoteFor, routedReplyWords } from '../send-recipient.js';
import { openTurnContext, endTurnContext } from '../../turn-context.js';
import type { TurnCounterparty } from '../counterparty.js';

const owner: TurnCounterparty = { kind: 'user', name: 'Owner Example', relation: 'owner', channel: 'dashboard', senderId: null, threadId: null, senderIsAgent: false };
const contact: TurnCounterparty = { kind: 'user', name: 'Pat Example', relation: 'known_contact', channel: 'imessage', senderId: '+15550100', threadId: null, senderIsAgent: false };
// Owner ruling 2026-11-04: a person's DASHBOARD ask stays on the dashboard whatever the presence,
// so the away shapes here use an owner turn that no dashboard message started (inbound null), with iMessage
// affinity: with no inbound, affinity moves the reply only while he is away.
const mk = (cp: TurnCounterparty, inbound: 'imessage' | 'dashboard' | null, p: 'in_dojo' | 'away') =>
  computeTurnAddress({ autoRoutes: true, counterparty: cp, isEngineTurn: false, isNotificationTurn: false, inboundChannel: inbound, inboundContext: null, presence: p, imessageBridgeConfigured: true, ownerAffinityChannel: cp.relation === 'owner' ? 'imessage' : null });

beforeEach(() => { presence.now = 'in_dojo'; ownerNumbers.clear(); ownerMail.length = 0; endTurnContext('primary'); });

describe('R1: engine texts read the live address', () => {
  it('the start-ack steer follows a presence flip: told dashboard at preflight, the owner goes away, the line now says iMessage', () => {
    const address = mk(owner, null, 'in_dojo');
    expect(startAckSteerText({ address } as never)).toContain('reaches them by the dashboard chat');
    presence.now = 'away';
    expect(startAckSteerText({ address } as never)).toContain('reaches them by iMessage');
  });
});

describe('R2: the owner is matched by the channel\'s own owner rule', () => {
  function ownerTurnAway() {
    presence.now = 'away';
    const t = openTurnContext('primary');
    t.address = mk(owner, null, 'away');
  }
  it('emailing the owner\'s connected mailbox is the person this turn is talking to, never "not"', () => {
    ownerMail.push({ address: 'owner@owner-mail.test' });
    ownerTurnAway();
    const n = recipientNoteFor('primary', 'gmail_send', { to: 'Owner@Owner-Mail.test', subject: 's' });
    expect(n).toContain('This is the person this turn is talking to.');
    expect(n).not.toMatch(/not the person/);
    expect(recipientNoteFor('primary', 'gmail_send', { to: 'someone@else.test' })).toMatch(/not the person/);
  });
  it('texting the owner\'s number by SMS or iMessage is the same', () => {
    ownerNumbers.add('+15550199');
    ownerTurnAway();
    for (const [tool, args] of [['sms_send', { to: '+15550199', body: 'x' }], ['imessage_send', { recipient: '+15550199', message: 'x' }]] as const) {
      expect(recipientNoteFor('primary', tool, args as Record<string, unknown>), tool).toContain('This is the person this turn is talking to.');
    }
  });
});

describe('R3: the bridge-down words', () => {
  it('do not ask the agent to tell someone it has just said it cannot reach, and say "down" only when it is down', () => {
    const t = openTurnContext('primary');
    t.address = mk(contact, 'imessage', 'in_dojo');
    const r = routedReplyWords('primary')!;
    expect(r.where).toBe('your written reply will not reach Pat Example by iMessage either; it stays in the dashboard chat');
    expect(r.where).not.toMatch(/tell|while it is down/i);
    expect(r.down).toBe('You cannot reach Pat Example by iMessage right now, and your written reply will not reach them either; it stays in the dashboard chat.');
  });
});
