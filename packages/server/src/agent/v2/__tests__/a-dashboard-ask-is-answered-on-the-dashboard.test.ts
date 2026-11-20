// v3.5 field fix 3, test-2 round (DIAGNOSIS-test2 Problem 4, fix rank 2): A DASHBOARD ASK IS ANSWERED
// ON THE DASHBOARD. Channel identity is sacred: reply on the channel the message came from.
//
// RC-10 owner affinity (2026-07-16, `owner-affinity.ts`) exists for turns where the owner is NOT
// at the dashboard: notification and engine-triggered turns whose reply would default to "the
// invisible dashboard" while the owner converses on iMessage. The phantom-outreach fix
// (2026-07-18) already ruled affinity alone is never a basis to text the owner. A turn whose
// trigger is the owner's OWN dashboard message is the opposite case: the dashboard is where he
// is, so affinity must never move that reply to iMessage, and the address the model reads must
// say the dashboard.
//
// OWNER RULING (2026-11-04), verbatim: "obviously if a user types a message on the dashboard, they
// get a response on the dashboard." So a person's dashboard ask is answered on the dashboard
// whatever the presence state. "Away" alone forwards nothing to the phone: an engine or proactive turn
// goes where it was asked. Typing on the dashboard while away also flips presence back to in-dojo
// (`gateway/__tests__/a-dashboard-message-means-the-owner-is-here.test.ts`).

import { describe, it, expect } from 'vitest';
import type { TurnCounterparty } from '../counterparty.js';
import { computeTurnAddress, renderTailRestatement, type ComputeTurnAddressInput } from '../turn-address.js';
import { affinityPromotionRefusedNoBasis } from '../owner-affinity.js';

const ownerOnDashboard: TurnCounterparty = {
  kind: 'user', name: 'Owner Example', relation: 'owner', channel: 'dashboard',
  senderId: null, threadId: null, senderIsAgent: false,
};
const ownerOnIMessage: TurnCounterparty = { ...ownerOnDashboard, channel: 'imessage', senderId: '+15550100' };

function addr(over: Partial<ComputeTurnAddressInput> & { counterparty: TurnCounterparty }) {
  return computeTurnAddress({ autoRoutes: true,
    isEngineTurn: false, isNotificationTurn: false, inboundChannel: null, inboundContext: null,
    presence: 'in_dojo', imessageBridgeConfigured: true, ownerAffinityChannel: null, ...over,
  });
}

describe('a dashboard ask with owner affinity on iMessage', () => {
  it('THE RED: the owner asked on the dashboard; the reply goes to the dashboard, and the address says so', () => {
    const a = addr({ counterparty: ownerOnDashboard, inboundChannel: 'dashboard', ownerAffinityChannel: 'imessage' });
    expect(a.deliveryChannel).toBe('dashboard');
    expect(a.routed).toBe(false);
    expect(renderTailRestatement(a)).toBeNull();
  });

  it('the guard refuses the promotion on a person\'s dashboard ask', () => {
    expect(affinityPromotionRefusedNoBasis({
      ownerAffinityChannel: 'imessage', inboundChannel: 'dashboard', presence: 'in_dojo', personAskedHere: true,
    })).toBe(true);
  });
});

describe('the owner ruling: a dashboard ask while marked away', () => {
  it('THE RED: presence away, a dashboard ask: the reply goes to the dashboard and the address says so', () => {
    const a = addr({ counterparty: ownerOnDashboard, inboundChannel: 'dashboard', presence: 'away' });
    expect(a.deliveryChannel).toBe('dashboard');
    expect(a.routed).toBe(false);
    expect(renderTailRestatement(a)).toBeNull();
  });

  it('away AND affinity together still leave a dashboard ask on the dashboard', () => {
    expect(addr({ counterparty: ownerOnDashboard, inboundChannel: 'dashboard', presence: 'away', ownerAffinityChannel: 'imessage' }).deliveryChannel).toBe('dashboard');
  });

  it('away no longer forwards an ENGINE turn that defaults to the dashboard', () => {
    expect(addr({ counterparty: ownerOnDashboard, isEngineTurn: true, inboundChannel: 'dashboard', presence: 'away' }).deliveryChannel).toBe('dashboard');
  });
});

describe('controls: every other case is unchanged', () => {

  it('an iMessage ask still replies by iMessage (in the dojo, away, and with affinity)', () => {
    for (const presence of ['in_dojo', 'away'] as const) {
      const a = addr({ counterparty: ownerOnIMessage, inboundChannel: 'imessage', presence, ownerAffinityChannel: 'imessage' });
      expect(a.deliveryChannel).toBe('imessage');
    }
  });

  it('RC-10 intent kept: an ENGINE turn whose reply defaults to the dashboard still follows affinity to iMessage', () => {
    const a = addr({ counterparty: ownerOnDashboard, isEngineTurn: true, inboundChannel: 'dashboard', ownerAffinityChannel: 'imessage' });
    expect(a.deliveryChannel).toBe('imessage');
  });

  it('the phantom-outreach rule kept: affinity alone with no inbound is still refused', () => {
    expect(addr({ counterparty: ownerOnDashboard, inboundChannel: null, ownerAffinityChannel: 'imessage' }).deliveryChannel).toBe('dashboard');
  });

  it('a proactive turn (no inbound) on an away box stays on the dashboard', () => {
    expect(addr({ counterparty: ownerOnDashboard, inboundChannel: null, presence: 'away' }).deliveryChannel).toBe('dashboard');
  });
});
