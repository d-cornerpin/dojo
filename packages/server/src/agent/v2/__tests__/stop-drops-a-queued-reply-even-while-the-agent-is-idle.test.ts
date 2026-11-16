// The owner presses Stop while the agent is idle with a reply written but not yet sent: the reply is dropped,
// marked "not sent: stopped by you", never sent later, and the Stop reports how many replies it dropped.
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
import { freshReplyDb, imessage, personTurn, replyRows, testDb, T0 } from './helpers/reply-sender.js';
import { pressStop, pills } from './helpers/owner-stop.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T0);
  freshReplyDb(runMigrations);
});

describe('Stop drops a queued reply even while the agent is idle', () => {
  it('the reply is dropped, marked, never sent, and counted in the Stop result', async () => {
    await routeTerminalReply(...personTurn('here is the address', { channel: 'imessage' }));

    const { status, body } = await pressStop();
    expect(status).toBe(200);
    expect(body.data?.repliesNotSent).toBe(1);
    expect(replyRows()[0]).toMatchObject({ outcome: 'suppressed', detail: 'stopped by the owner' });
    await vi.waitFor(() => expect(pills().some((p) => p.includes('not sent: stopped by you'))).toBe(true));

    await deliverDueReplies(T0 + 60 * 60_000);
    expect(imessage.send).not.toHaveBeenCalled();
  });

  it('a queued reply whose record cannot be read is still dropped', async () => {
    await routeTerminalReply(...personTurn('here is the address', { channel: 'imessage' }));
    testDb().prepare("UPDATE deliveries SET payload_json = '{broken' WHERE payload_json IS NOT NULL").run();
    expect((await pressStop()).body.data?.repliesNotSent).toBe(1);
    expect(replyRows()[0].outcome).toBe('suppressed');
  });
});
