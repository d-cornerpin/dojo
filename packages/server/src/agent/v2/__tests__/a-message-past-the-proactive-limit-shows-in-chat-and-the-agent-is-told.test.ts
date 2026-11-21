// A message past the proactive limit stays in the dashboard chat: its push to the owner's phone is held and the agent
// is told once that it did not go. Under the limit the same message is pushed.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { queueSpy, heldSpy, notices } = vi.hoisted(() => ({
  queueSpy: vi.fn(async () => 'row'),
  heldSpy: vi.fn((_row: unknown, _why: string) => ({ kind: 'applied', value: { deliveryId: 'held' } })),
  notices: [] as Array<{ brief: string }>,
}));
vi.mock('../deliveries.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), queueReply: queueSpy }));
vi.mock('../outbound.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), recordHeld: heldSpy }));
vi.mock('../../agent-notice.js', () => ({ postAgentNotice: (o: { brief: string }) => { notices.push(o); return 'notice'; } }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => '' }));
vi.mock('../steps/finalize/link-backstop.js', () => ({ appendUndeliveredLinks: async (s: unknown) => s }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'away', isImessageConfigured: () => true }));
vi.mock('../../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import { routeTerminalReply } from '../steps/finalize/route-reply.js';
import { computeTurnAddress } from '../turn-address.js';
import type { TurnCounterparty } from '../counterparty.js';

const LIMIT = "the owner has not answered the agent's last unprompted messages";
const owner: TurnCounterparty = { kind: 'user', name: 'Owner Example', relation: 'owner', channel: 'dashboard', senderId: null, threadId: null, senderIsAgent: false };
const address = computeTurnAddress({
  counterparty: owner, isEngineTurn: true, isNotificationTurn: false, inboundChannel: 'imessage', inboundContext: null, autoRoutes: true, settledContextWakeTurn: true,
});

async function reply(pushHeld: string | null): Promise<void> {
  const state = {
    lastAssistantTextForIM: 'Your flight was cancelled.', explicitSendThisTurn: {}, repliedToCounterpartyThisTurn: {},
    steerQueue: { pending: [], fired: [] }, inboundChannel: null, inboundContext: null,
  } as never;
  const ctx = {
    agentId: 'primary', turnNumber: 1, counterparty: owner, chosenConvKey: 'c',
    turnCtx: { address, replyFiles: [], root: null, pushHeld },
    settledContextWakeTurn: true, isEngineTurn: true, persistRoutingMarker: () => {},
  } as never;
  await routeTerminalReply(state, ctx);
}

beforeEach(() => { queueSpy.mockClear(); heldSpy.mockClear(); notices.length = 0; });

describe('a message past the proactive limit', () => {
  it('is not pushed: it is held in the dashboard chat, with the limit as the reason', async () => {
    await reply(LIMIT);
    expect(queueSpy).not.toHaveBeenCalled();
    expect(heldSpy).toHaveBeenCalledTimes(1);
    expect(heldSpy.mock.calls[0]![1]).toBe(LIMIT);
  });

  it('tells the agent once that it was not sent', async () => {
    await reply(LIMIT);
    expect(notices.map((n) => n.brief)).toEqual([
      'Your reply did not go out on the imessage channel: the owner has not answered your last messages sent on your own, so it stayed'
      + ' in the dashboard chat and will not be sent later. Do not say it arrived.',
    ]);
  });

  it('CONTROL: under the limit the same message is pushed and the agent is told nothing', async () => {
    await reply(null);
    expect(queueSpy).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([]);
  });
});
