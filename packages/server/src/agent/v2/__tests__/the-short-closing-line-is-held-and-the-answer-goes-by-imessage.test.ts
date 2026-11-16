// The double-answer guard still sees the dashboard copy of a text turn's answer, so a short closing line after it is
// held; the request waits for the answer itself, which goes by iMessage and closes it.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => (await import('./helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../steps/finalize/link-backstop.js', () => ({ appendUndeliveredLinks: async (s: unknown) => s }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { initState, advance } from '../state.js';
import { steerFired } from '../steer-queue.js';
import { runCloseoutFloors } from '../steps/post-call-classify/closeout-floors.js';
import { routeTerminalReply } from '../steps/finalize/route-reply.js';
import { deliverDueReplies } from '../channel-sender.js';
import { freshReplyDb, imessage, personTurn, testDb, AGENT, PERSON } from './helpers/reply-sender.js';
import { claimedAsk } from './helpers/owner-stop.js';
import { CONV, askRow, dashboardCopy } from './helpers/text-request.js';

const ANSWER = 'The table is booked for eight at the corner place.';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date());
  freshReplyDb(runMigrations);
});

describe('the short closing line is held and the answer goes by iMessage', () => {
  it('holds "All set." after the answer, keeps the request waiting, and closes it on the iMessage row', async () => {
    const ask = claimedAsk('msg-1', CONV, 7);
    dashboardCopy(7);

    const state = advance(initState({ agentId: AGENT, turnNumber: 7 } as Parameters<typeof initState>[0]), { loopCount: 2 });
    const ctx = {
      agentId: AGENT, turnNumber: 7, db: testDb(), messageId: 'msg-closing', settledContextWakeTurn: false,
      turnCtx: { root: { kind: 'ask', id: 'msg-1', sourceMessageId: 'msg-1', conversationId: CONV } },
      result: { content: 'All set.', toolCalls: [], stopReason: 'end_turn' },
    };
    const sc = { persistedContent: 'All set.', deliberateSurfaceTurn: false, interAgentTurn: false };
    const out = runCloseoutFloors(state, ctx as never, sc as never);
    expect(steerFired(out.state.steerQueue, 'redundant-closeout')).toBe(true);
    expect(sc.persistedContent).toBeNull();
    expect(askRow(ask).state).toBe('claimed');

    await routeTerminalReply(...personTurn(ANSWER, { channel: 'imessage' }, 7));
    await deliverDueReplies(Date.now());
    expect(imessage.send).toHaveBeenCalledWith(PERSON, ANSWER);
    expect(askRow(ask).state).toBe('done');
  });
});
