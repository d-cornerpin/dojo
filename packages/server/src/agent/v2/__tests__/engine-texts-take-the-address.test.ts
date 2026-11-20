// 3.5: engine texts that name a recipient or a reply route take the turn's address as input.
import { describe, it, expect } from 'vitest';
import '../../../prompt/registry/entries.js';
import { getMessageEntries } from '../../../prompt/registry/registry.js';
import { renderCounterpartyHeader, type TurnCounterparty } from '../counterparty.js';
import { compileSteerText } from '../../../work/join-drive.js';
import { compileAskerFromMeta } from '../../../work/compile-asker.js';
import { startAckSteerText, START_ACK_STEER_TEXT } from '../steps/assemble/start-ack-door.js';
import { computeTurnAddress, deliveryLabel } from '../turn-address.js';

const contact: TurnCounterparty = { kind: 'user', name: 'Pat Example', relation: 'known_contact', channel: 'imessage', senderId: '+15550100', threadId: null, senderIsAgent: false };
const owner: TurnCounterparty = { kind: 'user', name: 'Owner Example', relation: 'owner', channel: 'dashboard', senderId: null, threadId: null, senderIsAgent: false };
const addrOf = (cp: TurnCounterparty, inbound: 'imessage' | 'dashboard') => computeTurnAddress({ autoRoutes: true, counterparty: cp, isEngineTurn: false, isNotificationTurn: false, inboundChannel: inbound, inboundContext: null, presence: 'in_dojo', imessageBridgeConfigured: true, ownerAffinityChannel: null });

describe('the header\'s close-the-loop line says HOW to reach the owner', () => {
  it('on a contact turn the written reply goes to the contact, so the owner is reached by an explicit send that names them', () => {
    const h = renderCounterpartyHeader(contact, { address: addrOf(contact, 'imessage') });
    expect(h).toContain('Your written reply goes to Pat Example, not');
    expect(h).toContain('explicit send that names');
    expect(h).not.toMatch(/or send .* a note, a promise/);
  });
});

describe('the compile steer names the person who asked', () => {
  const base = { kind: 'compile' as const, asker: null, helper: 'Helper', request: 'plan the trip', files: [], pieces: ['Piece 1: "x"', 'Piece 2: "y"'] };
  it('for the owner it names the owner\'s request and quotes it whole', () => {
    const t = compileSteerText(base);
    expect(t).toContain("All 2 delegated pieces for the owner's request are back.");
    expect(t).toContain('They asked: "plan the trip"');
  });
  it('for a contact it names them, and a late answer names them and their channel', () => {
    const contactAsker = { name: 'Pat Example', channel: 'iMessage' };
    expect(compileSteerText({ ...base, asker: contactAsker })).toContain("for Pat Example's request are back");
    expect(compileSteerText({ ...base, kind: 'late', asker: contactAsker }))
      .toContain('Pat Example (by iMessage) was told there was no answer yet, so start your reply with "Update:"');
    expect(compileSteerText({ ...base, asker: contactAsker })).not.toContain('the owner');
  });
  it('the asker comes from the ask row\'s own stamp; the owner on the dashboard (or stamped owner) is null', () => {
    const name = (_c: string, h: string) => `Name for ${h}`;
    const label = (c: string) => deliveryLabel(c as never);
    expect(compileAskerFromMeta(JSON.stringify({ channel: 'dashboard' }), name, label)).toBeNull();
    expect(compileAskerFromMeta(JSON.stringify({ channel: 'imessage', relation: 'owner', sender: '+15550101' }), name, label)).toBeNull();
    expect(compileAskerFromMeta(null, name, label)).toBeNull();
    expect(compileAskerFromMeta(JSON.stringify({ channel: 'imessage', relation: 'known_contact', sender: '+15550100' }), name, label))
      .toEqual({ name: 'Name for +15550100', channel: 'iMessage' });
  });
});

describe('the start-ack steer says who is waiting and where the line lands', () => {
  it('names the person and their channel', () => {
    const t = startAckSteerText({ address: addrOf(contact, 'imessage') } as never);
    expect(t).toContain('Pat Example has not heard anything');
    expect(t).toContain('reaches them by iMessage');
  });
  it('with no person it is the generic text', () => {
    expect(startAckSteerText({ address: undefined } as never)).toBe(START_ACK_STEER_TEXT);
  });
});

describe('the others-waiting hint reads the address instead of "this turn\'s channel"', () => {
  it('says who the written reply goes to', () => {
    const entry = getMessageEntries().find((e) => e.id === 'msg.turn-context')!;
    const out = (entry.render as (c: unknown) => { content: string })({
      agentId: 'a', lastUserMessageContent: 'hi', isPrimary: true, ownerName: 'Owner Example',
      turnContext: { counterparty: contact, address: addrOf(contact, 'imessage'), othersWaiting: 1 },
    });
    expect(out.content).toContain('Your written reply goes to Pat Example by iMessage, as usual.');
    expect(out.content).not.toContain("Reply on this turn's channel as usual");
    void owner;
  });
});
