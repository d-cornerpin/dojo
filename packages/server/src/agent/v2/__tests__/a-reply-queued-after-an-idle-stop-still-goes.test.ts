// An idle Stop drops only what was queued when it was pressed: a reply written after it still goes out.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => (await import('./helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../steps/finalize/link-backstop.js', () => ({ appendUndeliveredLinks: async (s: unknown) => s }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { routeTerminalReply } from '../steps/finalize/route-reply.js';
import { deliverDueReplies } from '../channel-sender.js';
import { freshReplyDb, imessage, personTurn, replyRows, T0 } from './helpers/reply-sender.js';
import { pressStop } from './helpers/owner-stop.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T0);
  freshReplyDb(runMigrations);
});

describe('a reply queued after an idle Stop still goes', () => {
  it('only the reply queued before the Stop is dropped', async () => {
    await routeTerminalReply(...personTurn('the first answer', { channel: 'imessage' }, 1));
    expect((await pressStop()).status).toBe(200);
    await routeTerminalReply(...personTurn('the second answer', { channel: 'imessage' }, 2));

    await deliverDueReplies(Date.now());

    expect(imessage.send.mock.calls.map(([, text]) => text)).toEqual(['the second answer']);
    expect(replyRows().map((r) => r.outcome)).toEqual(['suppressed', 'delivered']);
  });
});
