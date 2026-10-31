// Owner law #28: the channel the agent is told its reply goes to equals the channel it is delivered on.
// An engine turn (reminder, tracker event) with nobody waiting is NEVER a held wake: its text reaches an
// away owner's phone (outbound-root.ts `engine_occurrence`), so the address must say so. A held wake stays
// a person-turn idea. Behavioural: drives routeTerminalReply and compares with the told (live) address.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { pushSpy, presence } = vi.hoisted(() => ({
  pushSpy: vi.fn(async () => undefined),
  presence: { current: 'in_dojo' as 'in_dojo' | 'away' },
}));
vi.mock('../steps/finalize/channel-push.js', () => ({ pushReplyToChannel: pushSpy }));
vi.mock('../steps/finalize/link-backstop.js', () => ({ appendUndeliveredLinks: async (s: unknown) => s }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => presence.current, isImessageConfigured: () => true }));
vi.mock('../../../services/imessage-bridge.js', () => ({ sendResponseViaIMessage: vi.fn() }));
vi.mock('../../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import { routeTerminalReply } from '../steps/finalize/route-reply.js';
import { computeTurnAddress } from '../turn-address.js';
import { liveAddress } from '../turn-address-live.js';
import type { TurnCounterparty } from '../counterparty.js';

const owner: TurnCounterparty = { kind: 'user', name: 'Owner Example', relation: 'owner', channel: 'dashboard', senderId: null, threadId: null, senderIsAgent: false };

function address(p: 'in_dojo' | 'away', settled: boolean, isEngineTurn: boolean) {
  return computeTurnAddress({
    counterparty: owner, isEngineTurn, isNotificationTurn: false, inboundChannel: null, inboundContext: null,
    presence: p, imessageBridgeConfigured: true, ownerAffinityChannel: null, autoRoutes: true, settledContextWakeTurn: settled,
  });
}
async function delivered(addr: ReturnType<typeof address>, settled: boolean, isEngineTurn: boolean) {
  pushSpy.mockClear();
  const state = { lastAssistantTextForIM: 'hi', explicitSendThisTurn: {}, steerQueue: { pending: [], fired: [] }, inboundChannel: null } as never;
  const ctx = { agentId: 'primary', turnNumber: 1, turnCtx: { address: addr, ownerAffinityDestination: null }, counterparty: owner, chosenConvKey: 'c', settledContextWakeTurn: settled, isEngineTurn } as never;
  await routeTerminalReply(state, ctx, false);
  expect(pushSpy).toHaveBeenCalledTimes(1);
  const opts = (pushSpy.mock.calls[0] as unknown as [unknown, unknown, { destination: string; settledContextHold: boolean }])[2];
  return opts.settledContextHold ? 'dashboard' : opts.destination; // a held push leaves the text in the dashboard
}

beforeEach(() => { presence.current = 'in_dojo'; });

describe('told == delivered, for every engine-turn state', () => {
  for (const p of ['in_dojo', 'away'] as const) {
    for (const settled of [true, false]) {
      it(`engine turn, owner ${p}, settled ${settled}`, async () => {
        presence.current = p;
        const addr = address(p, settled, true);
        expect(addr.heldWake).toBe(false);
        const told = liveAddress(addr)!.deliveryChannel;
        expect(await delivered(addr, settled, true)).toBe(told);
        expect(told).toBe(p === 'away' ? 'imessage' : 'dashboard');
      });
    }
  }

  it('a PERSON turn with nobody waiting is still a held wake: told dashboard, delivered to the dashboard', async () => {
    presence.current = 'away';
    const addr = address('away', true, false);
    expect(addr.heldWake).toBe(true);
    expect(liveAddress(addr)!.deliveryChannel).toBe('dashboard');
    expect(await delivered(addr, true, false)).toBe('dashboard');
  });
});
