// Owner law #28: the channel the agent is told its reply goes to equals the channel it is delivered on.
// An engine turn (reminder, tracker event) with nobody waiting is NEVER a held wake, and its reply lands where its
// address says, away or not. A held wake stays a person-turn idea. Behavioural: drives routeTerminalReply and
// compares with the told address.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { queueSpy, presence } = vi.hoisted(() => ({
  queueSpy: vi.fn(async () => 'row'),
  presence: { current: 'in_dojo' as 'in_dojo' | 'away' },
}));
vi.mock('../deliveries.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), queueReply: queueSpy }));
vi.mock('../outbound.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), recordHeld: () => ({ kind: 'applied', value: { deliveryId: 'held' } }) }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => '' }));
vi.mock('../steps/finalize/link-backstop.js', () => ({ appendUndeliveredLinks: async (s: unknown) => s }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => presence.current, isImessageConfigured: () => true }));
vi.mock('../../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import { routeTerminalReply } from '../steps/finalize/route-reply.js';
import { computeTurnAddress } from '../turn-address.js';
import type { TurnCounterparty } from '../counterparty.js';

const owner: TurnCounterparty = { kind: 'user', name: 'Owner Example', relation: 'owner', channel: 'dashboard', senderId: null, threadId: null, senderIsAgent: false };

function address(settled: boolean, isEngineTurn: boolean) {
  return computeTurnAddress({
    counterparty: owner, isEngineTurn, isNotificationTurn: false, inboundChannel: null, inboundContext: null,
    autoRoutes: true, settledContextWakeTurn: settled,
  });
}
/** The channel the reply was queued on; a held or dashboard reply leaves the text in the dashboard. */
async function delivered(addr: ReturnType<typeof address>, settled: boolean, isEngineTurn: boolean) {
  queueSpy.mockClear();
  const state = { lastAssistantTextForIM: 'hi', explicitSendThisTurn: {}, repliedToCounterpartyThisTurn: {}, steerQueue: { pending: [], fired: [] }, inboundChannel: null, inboundContext: null } as never;
  const ctx = { agentId: 'primary', turnNumber: 1, turnCtx: { address: addr, replyFiles: [] }, counterparty: owner, chosenConvKey: 'c', settledContextWakeTurn: settled, isEngineTurn, persistRoutingMarker: () => {} } as never;
  await routeTerminalReply(state, ctx);
  const queued = queueSpy.mock.calls[0] as unknown as [{ address: { channel: string } }] | undefined;
  return queued ? queued[0].address.channel : 'dashboard';
}

beforeEach(() => { presence.current = 'in_dojo'; });

describe('told == delivered, for every engine-turn state', () => {
  for (const p of ['in_dojo', 'away'] as const) {
    for (const settled of [true, false]) {
      it(`engine turn, owner ${p}, settled ${settled}`, async () => {
        presence.current = p;
        const addr = address(settled, true);
        expect(addr.heldWake).toBe(false);
        expect(await delivered(addr, settled, true)).toBe(addr.deliveryChannel);
        expect(addr.deliveryChannel).toBe('dashboard');
      });
    }
  }

  it('a PERSON turn with nobody waiting is still a held wake: told dashboard, delivered to the dashboard', async () => {
    presence.current = 'away';
    const addr = address(true, false);
    expect(addr.heldWake).toBe(true);
    expect(addr.deliveryChannel).toBe('dashboard');
    expect(await delivered(addr, true, false)).toBe('dashboard');
  });
});
