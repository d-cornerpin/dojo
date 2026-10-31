// 3.5: a channel send tool called with no recipient does not run (it never falls back silently to
// the turn's counterparty); a send that ran says who it went to and whether that is the person
// this turn is talking to.
import { describe, it, expect, beforeEach } from 'vitest';
import { openTurnContext, endTurnContext } from '../../turn-context.js';
import { computeTurnAddress } from '../turn-address.js';
import { refuseSendWithNoRecipient, recipientNoteFor, routedReplyWords } from '../send-recipient.js';
import type { TurnCounterparty } from '../counterparty.js';
import { executeTool, toolResultOf } from '../../tools/index.js';

const AGENT = 'primary';
const contact: TurnCounterparty = { kind: 'user', name: 'Pat Example', relation: 'known_contact', channel: 'imessage', senderId: '+15550100', threadId: null, senderIsAgent: false };
const owner: TurnCounterparty = { kind: 'user', name: 'Owner Example', relation: 'owner', channel: 'dashboard', senderId: null, threadId: null, senderIsAgent: false };

function turnWith(cp: TurnCounterparty, inbound: 'imessage' | 'dashboard', isEngineTurn = false): void {
  endTurnContext(AGENT);
  const t = openTurnContext(AGENT);
  t.address = computeTurnAddress({ counterparty: cp, isEngineTurn, isNotificationTurn: false, inboundChannel: inbound, inboundContext: null, presence: 'in_dojo', imessageBridgeConfigured: true, ownerAffinityChannel: null });
}

beforeEach(() => endTurnContext(AGENT));

describe('no recipient, no send', () => {
  it('imessage_send with no recipient on a contact\'s turn does not run and names who the turn is talking to', () => {
    turnWith(contact, 'imessage');
    const r = refuseSendWithNoRecipient(AGENT, 'imessage_send', { message: 'hello' }, 'c1');
    expect(r?.isError).toBe(true);
    expect(r?.content).toContain('was NOT run');
    expect(r?.content).toContain('Pat Example');
    expect(r?.content).toContain('by iMessage');
    expect(r?.content).toMatch(/who this message is for/i);
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

describe('a send says who it went to', () => {
  it('to the person the turn is talking to: says so', () => {
    turnWith(contact, 'imessage');
    const n = recipientNoteFor(AGENT, 'imessage_send', { recipient: '+15550100', message: 'x' });
    expect(n).toContain('by imessage');
    expect(n).toContain('This is the person this turn is talking to.');
  });

  it('to someone else on a routed turn: says plainly that it is NOT the person, and where the written reply still goes', () => {
    turnWith(contact, 'imessage');
    const n = recipientNoteFor(AGENT, 'sms_send', { to: '+15550123', body: 'x' });
    expect(n).toContain('NOT the person this turn is talking to (that is Pat Example)');
    expect(n).toContain('your written reply still goes to Pat Example');
  });

  it('a dashboard turn needs no contrast: it just names the recipient', () => {
    turnWith(owner, 'dashboard');
    const n = recipientNoteFor(AGENT, 'imessage_send', { recipient: '+15550123', message: 'x' });
    expect(n).toContain('Recipient:');
    expect(n).not.toContain('NOT the person');
  });

  it('a reply tool (no recipient argument) adds nothing; its own result names the thread', () => {
    turnWith(contact, 'imessage');
    expect(recipientNoteFor(AGENT, 'gmail_reply', { message_id: 'm1' })).toBe('');
  });
});

describe('failure results say where the written reply goes, from the address', () => {
  it('a contact\'s routed turn: the written reply goes to them on their channel', () => {
    turnWith(contact, 'imessage');
    expect(routedReplyWords(AGENT)).toContain('goes to Pat Example by iMessage');
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
