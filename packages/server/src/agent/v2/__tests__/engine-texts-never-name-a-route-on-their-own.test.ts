// 3.5, Task 6: the owner's law, as a harness test. The agent always knows who it is talking to and
// who it is sending to. No engine-written text names a reply route, or "the user", as a literal
// on its own: it reads the turn's address (or is on the sweep list below, to be reworded).
import { describe, it, expect } from 'vitest';
import '../../../prompt/registry/entries.js';
import { getMessageEntries } from '../../../prompt/registry/registry.js';
import { renderCounterpartyHeader, type TurnCounterparty } from '../counterparty.js';
import { compileSteerText } from '../../../work/join-drive.js';
import { startAckSteerText } from '../steps/assemble/start-ack-door.js';
import { computeTurnAddress } from '../turn-address.js';
import { refuseSendWithNoRecipient, recipientNoteFor, routedReplyWords } from '../send-recipient.js';
import { openTurnContext, endTurnContext } from '../../turn-context.js';

// ── The second law: a turn whose counterparty is a contact never gets owner-route text ──
const contact: TurnCounterparty = { kind: 'user', name: 'Pat Example', relation: 'known_contact', channel: 'imessage', senderId: '+15550100', threadId: null, senderIsAgent: false };
const FORBIDDEN = /dashboard chat|the owner is watching|reply to the owner|as your chat reply|owner's channel|in this conversation \(do NOT|send Owner Example a note, a promise/i;

describe('a contact\'s turn never gets owner-route text, on any outbound path the engine writes', () => {
  const addr = computeTurnAddress({ autoRoutes: true, counterparty: contact, isEngineTurn: false, isNotificationTurn: false, inboundChannel: 'imessage', inboundContext: null });

  it('the turn block, the start-ack steer, the compile steer, the send-tool results and the failure words', () => {
    endTurnContext('primary');
    openTurnContext('primary').address = addr;
    const entry = getMessageEntries().find((e) => e.id === 'msg.turn-context')!;
    const block = (entry.render as (c: unknown) => { content: string })({
      agentId: 'primary', lastUserMessageContent: 'hi', isPrimary: true, ownerName: 'Owner Example',
      replyDestination: addr.deliveryChannel, replyRecipientName: contact.name, inboundChannel: 'imessage', smsFromNumber: null, phoneFromNumber: null,
      turnContext: { counterparty: contact, address: addr, othersWaiting: 1, conversationalTurn: true },
    }).content;
    const texts: Record<string, string> = {
      'turn block (header, tag, hints)': block,
      'header alone': renderCounterpartyHeader(contact, { address: addr }),
      'start-ack steer': startAckSteerText({ address: addr } as never),
      'compile steer (asker = this contact)': compileSteerText({ kind: 'late', asker: { name: contact.name, channel: 'iMessage' }, helper: 'Helper', request: 'x', files: [], pieces: ['x'], back: 1, calledOff: [] }),
      'no-recipient refusal': refuseSendWithNoRecipient('primary', 'imessage_send', { message: 'x' }, 'c')!.content,
      'send note (someone else)': recipientNoteFor('primary', 'sms_send', { to: '+15550123', body: 'x' }),
      'failure words': routedReplyWords('primary')?.where ?? '',
    };
    for (const [name, text] of Object.entries(texts)) {
      // The failure words for a down bridge truthfully say the reply stays in the dashboard chat.
      expect(text, name).not.toMatch(name === 'failure words' ? /the owner is watching|reply to the owner|as your chat reply|owner's channel/i : FORBIDDEN);
      expect(text.length, name).toBeGreaterThan(0);
    }
    // And the contact is named wherever a text says who it is talking to.
    expect(texts['turn block (header, tag, hints)']).toContain('Pat Example');
    expect(texts['no-recipient refusal']).toContain('Pat Example');
    endTurnContext('primary');
  });
});
