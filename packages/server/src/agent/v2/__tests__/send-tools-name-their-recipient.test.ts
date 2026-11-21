// 3.5: a channel send tool called with no recipient does not run (it never falls back silently to
// the turn's counterparty); a send that ran says who it went to and whether that is the person
// this turn is talking to.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { ownerAddresses, senders, presence } = vi.hoisted(() => ({
  presence: { now: 'in_dojo' as 'in_dojo' | 'away' },
  ownerAddresses: new Set<string>(),
  senders: [] as Array<{ name: string; address: string; is_primary?: boolean }>,
}));
vi.mock('../../../services/safe-senders.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isOwnerIMessageRecipient: (a: string) => ownerAddresses.has(a),
}));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => presence.now, isImessageConfigured: () => true }));
vi.mock('../../../services/imessage-bridge.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getSafeSenders: () => senders,
}));
import { openTurnContext, endTurnContext } from '../../turn-context.js';
import { computeTurnAddress } from '../turn-address.js';
import { refuseSendWithNoRecipient, recipientNoteFor, routedReplyWords } from '../send-recipient.js';
import type { TurnCounterparty } from '../counterparty.js';
import { executeTool, toolResultOf } from '../../tools/index.js';
import { getTurnScopedImRecipient } from '../../../services/imessage-bridge.js';

const AGENT = 'primary';
const contact: TurnCounterparty = { kind: 'user', name: 'Pat Example', relation: 'known_contact', channel: 'imessage', senderId: '+15550100', threadId: null, senderIsAgent: false };
const owner: TurnCounterparty = { kind: 'user', name: 'Owner Example', relation: 'owner', channel: 'dashboard', senderId: null, threadId: null, senderIsAgent: false };

function turnWith(cp: TurnCounterparty, inbound: 'imessage' | 'dashboard', isEngineTurn = false): void {
  endTurnContext(AGENT);
  const t = openTurnContext(AGENT);
  t.address = computeTurnAddress({ autoRoutes: true, counterparty: cp, isEngineTurn, isNotificationTurn: false, inboundChannel: inbound, inboundContext: null });
}

beforeEach(() => {
  endTurnContext(AGENT);
  presence.now = 'in_dojo';
  ownerAddresses.clear();
  senders.length = 0;
});

describe('no recipient, no send', () => {
  it('imessage_send with no recipient on a contact\'s turn does not run and names who the turn is talking to', () => {
    turnWith(contact, 'imessage');
    const r = refuseSendWithNoRecipient(AGENT, 'imessage_send', { message: 'hello' }, 'c1');
    expect(r?.isError).toBe(true);
    expect(r?.content).toContain('was NOT run');
    expect(r?.content).toContain('Pat Example');
    expect(r?.content).toContain('by iMessage');
    expect(r?.content).toMatch(/person this message is for/i);
  });

  it('the same for sms_send, gmail_send and outlook_send, and for a blank recipient', () => {
    turnWith(contact, 'imessage');
    for (const [tool, args] of [['sms_send', { body: 'x' }], ['gmail_send', { subject: 's' }], ['outlook_send', { to: [] }], ['imessage_send', { message: 'x', recipient: '  ' }]] as const) {
      expect(refuseSendWithNoRecipient(AGENT, tool, args as Record<string, unknown>, 'c'), tool).not.toBeNull();
    }
  });

  it('a call that names its recipient, a reply tool, or a non-send tool is left alone', () => {
    turnWith(contact, 'imessage');
    expect(refuseSendWithNoRecipient(AGENT, 'imessage_send', { message: 'x', recipient: '+15550199' }, 'c')).toBeNull();
    expect(refuseSendWithNoRecipient(AGENT, 'gmail_reply', { message_id: 'm1' }, 'c')).toBeNull();
    expect(refuseSendWithNoRecipient(AGENT, 'file_read', {}, 'c')).toBeNull();
  });

  it('with no address at all the refusal still refuses and says it cannot name the person', () => {
    const r = refuseSendWithNoRecipient(AGENT, 'imessage_send', { message: 'x' }, 'c');
    expect(r?.isError).toBe(true);
    expect(r?.content).toContain('the person this turn is talking to');
  });
});

describe('the refusal makes the next call obvious (#27: never block the main agent from texting the owner)', () => {
  it('imessage_send lists the people it can reach, the owner marked, and the turn person\'s own address', () => {
    senders.push({ name: 'Owner Example', address: '+15550199', is_primary: true }, { name: 'Pat Example', address: '+15550100' });
    turnWith(contact, 'imessage');
    const c = refuseSendWithNoRecipient(AGENT, 'imessage_send', { message: 'x' }, 'c')!.content;
    expect(c).toContain('Owner Example <+15550199> [the owner]');
    expect(c).toContain('Pat Example <+15550100>');
    expect(c).toContain('(address +15550100)');
    expect(c).toContain('Call again with the recipient set to the address of the person this message is for.');
    expect(c).not.toMatch(/\bme\b/);
  });
});

describe('the owner is recognised by the one owner rule, never by a display name', () => {
  it('an owner turn texting the owner\'s address is "the person this turn is talking to" even when the record name differs', () => {
    ownerAddresses.add('+15550199');
    // The owner asked by text, so the reply really is texted to the owner.
    turnWith(owner, 'imessage');
    const n = recipientNoteFor(AGENT, 'imessage_send', { recipient: '+15550199', message: 'x' });
    expect(n).toContain('This is the person this turn is talking to.');
    expect(recipientNoteFor(AGENT, 'imessage_send', { recipient: '+15550123', message: 'x' })).toContain('is not the person this turn is talking to');
  });
});

describe('a send says who it went to', () => {
  it('to the person the turn is talking to: says so', () => {
    turnWith(contact, 'imessage');
    const n = recipientNoteFor(AGENT, 'imessage_send', { recipient: '+15550100', message: 'x' });
    expect(n).toContain('Sent to +15550100 by iMessage.');
    expect(n).toContain('This is the person this turn is talking to.');
  });

  it('to someone else on a routed turn: says plainly that it is NOT the person, and where the written reply still goes', () => {
    turnWith(contact, 'imessage');
    const n = recipientNoteFor(AGENT, 'sms_send', { to: '+15550123', body: 'x' });
    expect(n.trim()).toBe('Sent to +15550123 by SMS. This is not the person this turn is talking to (Pat Example); your written reply still goes to Pat Example.');
    expect(n).not.toMatch(/confirm/i);
  });

  it('a dashboard turn needs no contrast: it just names the recipient', () => {
    turnWith(owner, 'dashboard');
    const n = recipientNoteFor(AGENT, 'imessage_send', { recipient: '+15550123', message: 'x' });
    expect(n).toContain('Sent to +15550123 by iMessage.');
    expect(n).not.toMatch(/not the person/i);
  });

  it('a reply tool (no recipient argument) adds nothing; its own result names the thread', () => {
    turnWith(contact, 'imessage');
    expect(recipientNoteFor(AGENT, 'gmail_reply', { message_id: 'm1' })).toBe('');
  });
});

describe('failure results say where the written reply goes, from the address', () => {
  it('a contact\'s routed turn: the written reply goes to them on their channel', () => {
    turnWith(contact, 'imessage');
    const r = routedReplyWords(AGENT)!;
    expect(r.name).toBe('Pat Example');
    // The turn's own reply goes by iMessage, so a down bridge stops it too.
    expect(r.where).toContain('will not reach Pat Example by iMessage either');
    expect(r.where).toContain('stays in the dashboard chat');
  });
  it('a dashboard turn: nothing to say, the dashboard wording is already true', () => {
    turnWith(owner, 'dashboard');
    expect(routedReplyWords(AGENT)).toBeNull();
  });
});

describe('the executor enforces it at the one door', () => {
  it('executeTool(imessage_send) with no recipient returns the refusal and sends nothing', async () => {
    turnWith(contact, 'imessage');
    const out = await executeTool(AGENT, { id: 'call-1', name: 'imessage_send', arguments: { message: 'hello' } });
    const r = toolResultOf(out);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('was NOT run');
    expect(r.content).toContain('Pat Example');
  }, 60_000);
});

describe('minors: the failure words, the iMessage recipient and the tool description', () => {
  it('an SMS-routed turn is told its written reply still reaches the person there', () => {
    endTurnContext(AGENT);
    const t = openTurnContext(AGENT);
    t.address = computeTurnAddress({ autoRoutes: true, counterparty: { ...contact, channel: 'sms' }, isEngineTurn: false, isNotificationTurn: false, inboundChannel: 'sms', inboundContext: null });
    expect(routedReplyWords(AGENT)!.where).toContain('goes to Pat Example by SMS, so tell them there');
  });
  it('the image path reads the iMessage recipient from the address, not a second field', async () => {
    turnWith(contact, 'imessage');
    expect(getTurnScopedImRecipient(AGENT)).toBe('+15550100');
    turnWith(owner, 'dashboard');
    expect(getTurnScopedImRecipient(AGENT)).toBeNull();
    endTurnContext(AGENT);
    expect(getTurnScopedImRecipient(AGENT)).toBeNull();
  });
});
