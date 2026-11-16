// A reply whose send is still running is never started again by a later pass, however long the send takes and
// even after its crash lease has run out; its own verdict ends it.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => (await import('./helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../steps/finalize/link-backstop.js', () => ({ appendUndeliveredLinks: async (s: unknown) => s }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../../db/migrations.js';
import { routeTerminalReply } from '../steps/finalize/route-reply.js';
import { deliverDueReplies, isMidTry } from '../channel-sender.js';
import { freshReplyDb, imessage, personTurn, replyRows, testDb, T0 } from './helpers/reply-sender.js';

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  freshReplyDb(runMigrations);
  await routeTerminalReply(...personTurn('here is the address', { channel: 'imessage' }));
  testDb().prepare('UPDATE deliveries SET next_attempt_at = ? WHERE payload_json IS NOT NULL').run(T0);
});

describe('a reply in the middle of a long try is never sent twice', () => {
  it('a later pass, even past the lease, leaves the running try alone; the try\'s verdict stands', async () => {
    let finish: (ok: boolean) => void = () => {};
    imessage.send.mockImplementationOnce(() => new Promise<boolean>((r) => { finish = r; }));
    const first = deliverDueReplies(T0);
    await vi.waitFor(() => expect(imessage.send).toHaveBeenCalledTimes(1));
    const [row] = replyRows();
    expect(isMidTry(row.id)).toBe(true);

    await deliverDueReplies(T0 + 60 * 60_000);
    expect(imessage.send).toHaveBeenCalledTimes(1);

    finish(true);
    await first;
    expect(isMidTry(row.id)).toBe(false);
    expect(replyRows()[0]).toMatchObject({ outcome: 'delivered', attempts: 1 });
    await deliverDueReplies(T0 + 2 * 60 * 60_000);
    expect(imessage.send).toHaveBeenCalledTimes(1);
  });
});
