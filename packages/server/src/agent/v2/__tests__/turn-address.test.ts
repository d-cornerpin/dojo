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
    presence: 'in_dojo', imessageBridgeConfigured: true, ownerAffinityChannel: null, ...over,
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

  it('A4: an owner turn promoted by being away is told the promoted channel; affinity never moves a dashboard ask', () => {
    // Field fix 3 test-2 rank 2 (channel identity): the owner asking ON the dashboard is the
    // opposite of RC-10's "invisible dashboard" premise, so affinity leaves that reply where he is.
    // An ENGINE turn that defaults to the dashboard still follows affinity (RC-10's own case).
    expect(addr({ counterparty: owner, inboundChannel: 'dashboard', ownerAffinityChannel: 'imessage' }).deliveryChannel).toBe('dashboard');
    expect(addr({ counterparty: owner, isEngineTurn: true, inboundChannel: 'dashboard', ownerAffinityChannel: 'imessage' }).deliveryChannel).toBe('imessage');
    // Owner ruling 2026-11-04 ("if a user types a message on the dashboard, they get a response on
    // the dashboard"): a dashboard ask stays on the dashboard even when away; away forwards the turns
    // no person asked on the dashboard (here, a proactive turn with no inbound).
    expect(addr({ counterparty: owner, inboundChannel: 'dashboard', presence: 'away' }).deliveryChannel).toBe('dashboard');
    expect(addr({ counterparty: owner, inboundChannel: null, presence: 'away' }).deliveryChannel).toBe('imessage');
    // Affinity alone with no inbound is refused (phantom-outreach rule).
    expect(addr({ counterparty: owner, inboundChannel: null, ownerAffinityChannel: 'imessage' }).deliveryChannel).toBe('dashboard');
  });

  it('A4: affinity never promotes a contact', () => {
    const a = addr({ counterparty: { ...contact, channel: 'dashboard' }, inboundChannel: 'dashboard', ownerAffinityChannel: 'imessage' });
    expect(a.deliveryChannel).toBe('dashboard');
  });

  it('A5: an A2A turn is not routed to a person and names no human', () => {
    const a = addr({ counterparty: peer, inboundChannel: 'dashboard', presence: 'away' });
    expect(a.kind).toBe('agent');
    expect(a.deliveryChannel).toBe('dashboard');
    expect(a.routed).toBe(false);
  });

  it('A6: engine and notification turns have no reply line and are never routed to a person as a reply', () => {
    const e = addr({ counterparty: owner, isEngineTurn: true, presence: 'away' });
    const n = addr({ counterparty: owner, isNotificationTurn: true, presence: 'away' });
    expect(e.kind).toBe('engine');
    expect(n.kind).toBe('notification');
    expect(n.deliveryChannel).toBe('dashboard');
    // An away owner's reminder is delivered to their phone; the address says so truthfully.
    expect(e.deliveryChannel).toBe('imessage');
  });

  it('delivery reads the address: live presence still applies, the bound inbound does not move', () => {
    // A proactive owner turn (no inbound; the owner ruling keeps a dashboard ask on the dashboard).
    const a = addr({ counterparty: owner, inboundChannel: null });
    expect(resolveDeliveryChannel(a, { presence: 'away', imessageBridgeConfigured: true, ownerAffinityChannel: null })).toBe('imessage');
    const c = addr({ counterparty: contact, inboundChannel: 'imessage' });
    expect(resolveDeliveryChannel(c, { presence: 'in_dojo', imessageBridgeConfigured: true, ownerAffinityChannel: 'imessage' })).toBe('imessage');
  });

  it('the tail restatement exists only for a routed reply', () => {
    expect(renderTailRestatement(addr({ counterparty: contact, inboundChannel: 'imessage' }))).toBe('[Reply goes to Pat Example by iMessage.]');
    expect(renderTailRestatement(addr({ counterparty: owner, inboundChannel: 'dashboard' }))).toBeNull();
    expect(renderTailRestatement(null)).toBeNull();
  });
});

describe('only the primary agent\'s written reply is texted to an away owner', () => {
  it('a sub-agent\'s address says the dashboard and is not routed, away or not', () => {
    const a = addr({ counterparty: owner, inboundChannel: 'dashboard', presence: 'away', autoRoutes: false });
    expect(a.deliveryChannel).toBe('dashboard');
    expect(a.routed).toBe(false);
    expect(renderTailRestatement(a)).toBeNull();
    expect(resolveDeliveryChannel(a, { presence: 'away', imessageBridgeConfigured: true, ownerAffinityChannel: 'imessage' })).toBe('dashboard');
  });
  it('the primary agent\'s says iMessage for the same away owner (an engine turn; a dashboard ask stays on the dashboard)', () => {
    expect(addr({ counterparty: owner, isEngineTurn: true, inboundChannel: 'dashboard', presence: 'away' }).deliveryChannel).toBe('imessage');
  });
});
