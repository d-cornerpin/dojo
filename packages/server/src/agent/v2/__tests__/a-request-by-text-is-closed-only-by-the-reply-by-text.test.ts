// A request that came by iMessage is answered only when the answer went by iMessage: the dashboard copy of the
// reply does not close it; the reply's own row does, when it goes.
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
import { freshReplyDb, replyRows } from './helpers/reply-sender.js';
import { claimedAsk } from './helpers/owner-stop.js';
import { CONV, askRow, dashboardCopy, endTurn } from './helpers/text-request.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date());
  freshReplyDb(runMigrations);
});

describe('a request by text is closed only by the reply by text', () => {
  it('the dashboard copy leaves it open; the iMessage row closes it when it goes', async () => {
    const ask = claimedAsk('msg-1', CONV, 1);
    dashboardCopy(1);
    expect(askRow(ask).state).toBe('claimed');

    await endTurn(1, 'the table is booked for eight');
    expect(askRow(ask).state).toBe('claimed');
    await deliverDueReplies(Date.now());

    const [reply] = replyRows();
    expect(reply.outcome).toBe('delivered');
    expect(askRow(ask)).toEqual({ state: 'done', result_delivery_id: reply.id });
  });
});
