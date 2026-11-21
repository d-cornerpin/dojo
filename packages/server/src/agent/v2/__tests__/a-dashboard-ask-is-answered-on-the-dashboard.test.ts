// A dashboard ask is answered on the dashboard. OWNER RULING (2026-11-04), verbatim: "obviously if a user types a
// message on the dashboard, they get a response on the dashboard." Presence moves nothing: a reminder asked on the
// dashboard stays there, a result nobody asked for stays there, and a text ask is answered by text.

import { describe, it, expect } from 'vitest';
import type { TurnCounterparty } from '../counterparty.js';
import { computeTurnAddress, renderTailRestatement, type ComputeTurnAddressInput } from '../turn-address.js';

const ownerOnDashboard: TurnCounterparty = {
  kind: 'user', name: 'Owner Example', relation: 'owner', channel: 'dashboard',
  senderId: null, threadId: null, senderIsAgent: false,
};
const ownerOnIMessage: TurnCounterparty = { ...ownerOnDashboard, channel: 'imessage', senderId: '+15550100' };

const addr = (over: Partial<ComputeTurnAddressInput> & { counterparty: TurnCounterparty }) => computeTurnAddress({
  autoRoutes: true, isEngineTurn: false, isNotificationTurn: false, inboundChannel: null, inboundContext: null, ...over,
});

describe('a dashboard ask is answered on the dashboard', () => {
  it('the owner asked on the dashboard: the reply goes to the dashboard, and the address says so', () => {
    const a = addr({ counterparty: ownerOnDashboard, inboundChannel: 'dashboard' });
    expect(a.deliveryChannel).toBe('dashboard');
    expect(a.routed).toBe(false);
    expect(renderTailRestatement(a)).toBeNull();
  });

  it('a reminder asked on the dashboard and a result with no asking channel stay on the dashboard', () => {
    expect(addr({ counterparty: ownerOnDashboard, isEngineTurn: true, inboundChannel: 'dashboard' }).deliveryChannel).toBe('dashboard');
    expect(addr({ counterparty: ownerOnDashboard, isEngineTurn: true, inboundChannel: null }).deliveryChannel).toBe('dashboard');
  });

  it('an iMessage ask, or a reminder asked by text, is answered by iMessage', () => {
    expect(addr({ counterparty: ownerOnIMessage, inboundChannel: 'imessage' }).deliveryChannel).toBe('imessage');
    expect(addr({ counterparty: ownerOnDashboard, isEngineTurn: true, inboundChannel: 'imessage' }).deliveryChannel).toBe('imessage');
  });
});
