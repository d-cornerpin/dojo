import { describe, it, expect } from 'vitest';
import type { TurnCounterparty } from '../counterparty.js';
import {
  computeTurnAddress, resolveDeliveryChannel, renderTailRestatement, type ComputeTurnAddressInput,
} from '../turn-address.js';

const contact: TurnCounterparty = {
  kind: 'user', name: 'Pat Example', relation: 'known_contact', channel: 'imessage',
  senderId: '+15550100', threadId: null, senderIsAgent: false,
};
const owner: TurnCounterparty = {
  kind: 'user', name: 'Owner Example', relation: 'owner', channel: 'dashboard',
  senderId: null, threadId: null, senderIsAgent: false,
};
const peer: TurnCounterparty = {
  kind: 'agent', name: 'peer-agent', relation: 'agent', channel: 'a2a',
  senderId: null, threadId: 'thr1', senderIsAgent: false,
};

function addr(over: Partial<ComputeTurnAddressInput> & { counterparty: TurnCounterparty }) {
  return computeTurnAddress({ autoRoutes: true,
    isEngineTurn: false, isNotificationTurn: false, inboundChannel: null, inboundContext: null,
    ...over,
  });
}

describe('the turn address: who the written reply really goes to', () => {
  it('A1: a contact texted and the owner also wrote on the dashboard: the address is the contact by iMessage', () => {
    // The turn's counterparty and inbound are the TRIGGER's (the contact's iMessage); the
    // owner's newer dashboard row never enters the address.
    const a = addr({ counterparty: contact, inboundChannel: 'imessage' });
    expect(a.deliveryChannel).toBe('imessage');
    expect(a.routed).toBe(true);
    expect(a.name).toBe('Pat Example');
  });

  it('A2: nothing arriving later can change it; the same inputs give the same address', () => {
    const first = addr({ counterparty: contact, inboundChannel: 'imessage' });
    const second = addr({ counterparty: contact, inboundChannel: 'imessage' });
    expect(second).toEqual(first);
  });

  it('A3: a turn with no inbound of its own falls to the dashboard', () => {
    expect(addr({ counterparty: contact, inboundChannel: null }).deliveryChannel).toBe('dashboard');
  });

  // Owner ruling 2026-11-04: "obviously if a user types a message on the dashboard, they get a response on the dashboard."
  it('A4: a dashboard ask, a reminder asked on the dashboard and a result nobody asked for all stay on the dashboard', () => {
    expect(addr({ counterparty: owner, inboundChannel: 'dashboard' }).deliveryChannel).toBe('dashboard');
    expect(addr({ counterparty: owner, isEngineTurn: true, inboundChannel: 'dashboard' }).deliveryChannel).toBe('dashboard');
    expect(addr({ counterparty: owner, isEngineTurn: true, inboundChannel: null }).deliveryChannel).toBe('dashboard');
  });

  it('A5: an A2A turn is not routed to a person and names no human', () => {
    const a = addr({ counterparty: peer, inboundChannel: 'dashboard' });
    expect(a.kind).toBe('agent');
    expect(a.deliveryChannel).toBe('dashboard');
    expect(a.routed).toBe(false);
  });

  it('A6: engine and notification turns have no reply line and are never routed to a person as a reply', () => {
    const e = addr({ counterparty: owner, isEngineTurn: true });
    const n = addr({ counterparty: owner, isNotificationTurn: true });
    expect(e.kind).toBe('engine');
    expect(n.kind).toBe('notification');
    expect(n.deliveryChannel).toBe('dashboard');
    expect(e.deliveryChannel).toBe('dashboard');
  });

  it('a routed inbound is answered on its own channel, a reminder asked by text included', () => {
    for (const ch of ['imessage', 'teams', 'email', 'sms', 'voice'] as const) {
      expect(resolveDeliveryChannel(addr({ counterparty: contact, inboundChannel: ch }))).toBe(ch);
    }
    expect(addr({ counterparty: owner, isEngineTurn: true, inboundChannel: 'imessage' }).deliveryChannel).toBe('imessage');
  });

  it('the tail restatement exists only for a routed reply', () => {
    expect(renderTailRestatement(addr({ counterparty: contact, inboundChannel: 'imessage' }))).toBe('[Reply goes to Pat Example by iMessage.]');
    expect(renderTailRestatement(addr({ counterparty: owner, inboundChannel: 'dashboard' }))).toBeNull();
    expect(renderTailRestatement(null)).toBeNull();
  });
});

describe('only the primary agent\'s written reply is routed', () => {
  it('a sub-agent\'s address says the dashboard and is not routed', () => {
    const a = addr({ counterparty: owner, inboundChannel: 'dashboard', autoRoutes: false });
    expect(a.deliveryChannel).toBe('dashboard');
    expect(a.routed).toBe(false);
    expect(renderTailRestatement(a)).toBeNull();
    expect(resolveDeliveryChannel({ ...a, boundChannel: 'imessage' })).toBe('dashboard');
  });
});
