// RC-4.2 / RC-5.2 / RC-10 counterparty tests.
//
//   RC-4.2  resolveTurnCounterparty threads senderIsAgent off the trigger row's
//           structured inbound_meta so the engine can gate channel-delivered acks on
//           data, not description prose.
//   RC-5.2  renderCounterpartyHeader has a NOTIFICATION variant that replaces the
//           owner-on-dashboard framing on a mailbox/channel notification wake.
//   RC-10   renderCounterpartyHeader renders the RESOLVED reply destination (owner
//           affinity / away) so the model is never told "dashboard" on a turn the
//           engine will text.

import { describe, it, expect } from 'vitest';
import { resolveTurnCounterparty, renderCounterpartyHeader, type TurnCounterparty } from '../counterparty.js';

// ── RC-4.2: senderIsAgent threading ──
describe('RC-4.2 resolveTurnCounterparty threads senderIsAgent', () => {
  const agentSenderMeta = JSON.stringify({
    channel: 'imessage', authorized: true, sender: 'Peer Agent',
    relation: 'known_contact', senderIsAgent: true,
  });
  const humanSenderMeta = JSON.stringify({
    channel: 'imessage', authorized: true, sender: 'A Contact',
    relation: 'known_contact', senderIsAgent: false,
  });

  it('exposes senderIsAgent: true when the trigger row is an agent-flagged sender', () => {
    const cp = resolveTurnCounterparty({
      isA2ATurn: false, a2aFromName: null, a2aThreadShort: null,
      triggerContent: '[SOURCE: IMESSAGE FROM Peer Agent] on it',
      triggerSource: null, triggerInboundMeta: agentSenderMeta, inboundChannel: 'imessage',
    });
    expect(cp.kind).toBe('user');
    expect(cp.senderIsAgent).toBe(true);
  });

  it('exposes senderIsAgent: false for an ordinary human sender', () => {
    const cp = resolveTurnCounterparty({
      isA2ATurn: false, a2aFromName: null, a2aThreadShort: null,
      triggerContent: '[SOURCE: IMESSAGE FROM A Contact] hi',
      triggerSource: null, triggerInboundMeta: humanSenderMeta, inboundChannel: 'imessage',
    });
    expect(cp.senderIsAgent).toBe(false);
  });

  it('defaults senderIsAgent to false when there is no inbound_meta', () => {
    const cp = resolveTurnCounterparty({
      isA2ATurn: false, a2aFromName: null, a2aThreadShort: null,
      triggerContent: '[SOURCE: IMESSAGE FROM A Contact] hi',
      triggerSource: null, triggerInboundMeta: null, inboundChannel: 'imessage',
    });
    expect(cp.senderIsAgent).toBe(false);
  });

  it('an A2A turn is never flagged senderIsAgent (kind=agent is a separate lane)', () => {
    const cp = resolveTurnCounterparty({
      isA2ATurn: true, a2aFromName: 'Stella', a2aThreadShort: 'abcd1234',
      triggerContent: null, triggerSource: null, triggerInboundMeta: null, inboundChannel: null,
    });
    expect(cp.kind).toBe('agent');
    expect(cp.senderIsAgent).toBe(false);
  });
});

// ── header builders ──
const ownerCp: TurnCounterparty = {
  kind: 'user', name: 'Sam', relation: 'owner', channel: 'dashboard',
  senderId: null, threadId: null, senderIsAgent: false,
};

describe('RC-5.2 renderCounterpartyHeader notification variant', () => {
  it('renders the notification framing and REPLACES the owner-on-dashboard header', () => {
    const header = renderCounterpartyHeader(ownerCp, { isNotificationTurn: true });
    expect(header).toMatch(/triggered by a mailbox\/channel notification/i);
    expect(header).toMatch(/NOT a person messaging you/i);
    expect(header).toMatch(/\[no-reply\]/);
    // The owner-conversation framing must NOT appear on a notification turn.
    expect(header).not.toMatch(/Your reply goes back to them/);
  });

  it('the notification variant takes precedence over the engine variant', () => {
    const header = renderCounterpartyHeader(ownerCp, { isNotificationTurn: true, isEngineTurn: true });
    expect(header).toMatch(/triggered by a mailbox\/channel notification/i);
  });
});

describe('RC-10 renderCounterpartyHeader renders the resolved reply destination', () => {
  it('an owner dashboard turn promoted to iMessage tells the model iMessage, not dashboard', () => {
    const header = renderCounterpartyHeader(ownerCp, { resolvedDestination: 'imessage' });
    expect(header).toMatch(/Your reply goes back to them on iMessage/);
    expect(header).not.toMatch(/Your reply goes back to them on the dashboard chat/);
  });

  it('with no resolved override the reply channel is the counterparty channel', () => {
    const header = renderCounterpartyHeader(ownerCp);
    expect(header).toMatch(/Your reply goes back to them on the dashboard chat/);
  });
});
