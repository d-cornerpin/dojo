// Two messages answered by one reply: both requests wait with it and both close when it goes.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => (await import('./helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../steps/finalize/link-backstop.js', () => ({ appendUndeliveredLinks: async (s: unknown) => s }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { deliverDueReplies } from '../channel-sender.js';
import { freshReplyDb, imessage, replyRows } from './helpers/reply-sender.js';
import { claimedAsk } from './helpers/owner-stop.js';
import { CONV, askRow, endTurn } from './helpers/text-request.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date());
  freshReplyDb(runMigrations);
});

describe('two requests answered in one reply both close when it goes', () => {
  it('both stay claimed while it waits; both close on its row', async () => {
    const first = claimedAsk('msg-1', CONV, 1);
    const second = claimedAsk('msg-2', CONV, 1);
    await endTurn(1, 'yes to both: eight o\'clock, and the blue one');
    expect([askRow(first).state, askRow(second).state]).toEqual(['claimed', 'claimed']);

    await deliverDueReplies(Date.now());
    const [reply] = replyRows();
    expect(askRow(first)).toEqual({ state: 'done', result_delivery_id: reply.id });
    expect(askRow(second)).toEqual({ state: 'done', result_delivery_id: reply.id });
  });
});
