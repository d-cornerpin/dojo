// `routeTerminalReply` queues the reply on the destination the SAME resolver gives the agent
// (`resolveDeliveryChannel`), whatever the newest row, the trigger row or the owner's presence says; and the
// channel the agent is told (the turn's address) equals the channel used, whatever presence does mid-turn.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { queueSpy, presence, bridge } = vi.hoisted(() => ({
  queueSpy: vi.fn(async () => 'row'),
  presence: { current: 'in_dojo' as 'in_dojo' | 'away' },
  bridge: { on: true },
}));
vi.mock('../../../deliveries.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), queueReply: queueSpy }));
vi.mock('../../../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => '' }));
vi.mock('../link-backstop.js', () => ({ appendUndeliveredLinks: async (s: unknown) => s }));
vi.mock('../../../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../../../../services/presence.js', () => ({ getPresence: () => presence.current, isImessageConfigured: () => bridge.on }));
vi.mock('../../../../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import { routeTerminalReply } from '../route-reply.js';
import { computeTurnAddress } from '../../../turn-address.js';
import type { TurnCounterparty } from '../../../counterparty.js';

const contact: TurnCounterparty = { kind: 'user', name: 'Pat Example', relation: 'known_contact', channel: 'imessage', senderId: '+15550100', threadId: null, senderIsAgent: false };
const owner: TurnCounterparty = { kind: 'user', name: 'Owner Example', relation: 'owner', channel: 'dashboard', senderId: null, threadId: null, senderIsAgent: false };

function addressFor(cp: TurnCounterparty, inbound: 'imessage' | 'dashboard' | null, primary = true) {
  return computeTurnAddress({ autoRoutes: primary, counterparty: cp, isEngineTurn: false, isNotificationTurn: false, inboundChannel: inbound, inboundContext: null });
}
/** The channel the reply was queued on, or `dashboard` when nothing left the dashboard. */
async function destinationOf(cp: TurnCounterparty, address: ReturnType<typeof addressFor>, stateInbound: 'imessage' | 'dashboard' | null): Promise<string> {
  queueSpy.mockClear();
  const state = { lastAssistantTextForIM: 'hi', explicitSendThisTurn: {}, repliedToCounterpartyThisTurn: {}, steerQueue: { pending: [], fired: [] }, inboundChannel: stateInbound, inboundContext: null } as never;
  const ctx = { agentId: 'primary', turnNumber: 1, turnCtx: { address, replyFiles: [] }, counterparty: cp, chosenConvKey: 'c', settledContextWakeTurn: false, isEngineTurn: false } as never;
  await routeTerminalReply(state, ctx);
  expect(queueSpy.mock.calls.length).toBeLessThanOrEqual(1);
  const queued = queueSpy.mock.calls[0] as unknown as [{ address: { channel: string } }] | undefined;
  return queued ? queued[0].address.channel : 'dashboard';
}

beforeEach(() => { presence.current = 'in_dojo'; bridge.on = true; });

describe('delivery follows the turn address', () => {
  it('a contact\'s iMessage turn is delivered by iMessage, whatever the owner\'s presence', async () => {
    for (const p of ['in_dojo', 'away'] as const) {
      presence.current = p;
      expect(await destinationOf(contact, addressFor(contact, 'imessage'), 'imessage')).toBe('imessage');
    }
  });

  it('a job turn (no trigger row, state inbound empty) still delivers to the address\'s bound channel', async () => {
    const address = computeTurnAddress({
      autoRoutes: true, counterparty: contact, isEngineTurn: false, isNotificationTurn: false, inboundChannel: 'imessage', inboundContext: null,
    });
    expect(await destinationOf(contact, address, null)).toBe('imessage');
  });

  it('an A2A turn never delivers to a person', async () => {
    const peer: TurnCounterparty = { kind: 'agent', name: 'peer-agent', relation: 'agent', channel: 'a2a', senderId: null, threadId: 't1', senderIsAgent: false };
    presence.current = 'away';
    expect(await destinationOf(peer, addressFor(peer, 'dashboard'), 'dashboard')).toBe('dashboard');
  });
});

describe('what the agent is told equals what is used, whatever presence does mid-turn', () => {
  it('owner ruling: a DASHBOARD ask stays on the dashboard when the owner goes away mid-turn', async () => {
    const address = addressFor(owner, 'dashboard');
    presence.current = 'away';
    expect(address.deliveryChannel).toBe('dashboard');
    expect(await destinationOf(owner, address, 'dashboard')).toBe('dashboard');
  });

  it('a turn no message started stays on the dashboard while the owner is away', async () => {
    presence.current = 'away';
    const address = addressFor(owner, null);
    expect(address.deliveryChannel).toBe('dashboard');
    expect(await destinationOf(owner, address, null)).toBe('dashboard');
  });

  it('a sub-agent\'s reply stays in the dashboard even with the owner away (no iMessage promise)', () => {
    const sub = addressFor(owner, 'imessage', false);
    expect(sub.deliveryChannel).toBe('dashboard');
    expect(sub.routed).toBe(false);
  });
});
