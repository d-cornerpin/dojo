// A reply waiting to go survives a restart, including one that was in the middle of a try when the process died:
// the restarted Dojo sends it once the dead try's 10-minute lease has run out, and not before.
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
import { deliverDueReplies } from '../channel-sender.js';
import { freshReplyDb, imessage, personTurn, replyRows, testDb, PERSON, T0 } from './helpers/reply-sender.js';

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  freshReplyDb(runMigrations);
  await routeTerminalReply(...personTurn('see you at noon', { channel: 'imessage' }));
  testDb().prepare('UPDATE deliveries SET next_attempt_at = ? WHERE payload_json IS NOT NULL').run(T0);
});

describe('a reply queued before a restart is sent after it', () => {
  it('a try cut off by the restart is sent again by the restarted sender after its lease, once', async () => {
    imessage.send.mockImplementationOnce(() => new Promise<boolean>(() => {}));
    void deliverDueReplies(T0);
    await vi.waitFor(() => expect(imessage.send).toHaveBeenCalledTimes(1));

    vi.resetModules();
    const restarted = await import('../channel-sender.js');
    await restarted.deliverDueReplies(T0 + 9 * 60_000);
    expect(imessage.send).toHaveBeenCalledTimes(1);
    await restarted.deliverDueReplies(T0 + 10 * 60_000);
    expect(imessage.send).toHaveBeenCalledTimes(2);
    expect(imessage.send).toHaveBeenLastCalledWith(PERSON, 'see you at noon');
    expect(replyRows()).toMatchObject([{ outcome: 'delivered', attempts: 2 }]);
  });
});
