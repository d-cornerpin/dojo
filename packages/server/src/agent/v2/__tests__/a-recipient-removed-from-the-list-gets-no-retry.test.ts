// A reply waiting for its retry is not sent to someone the owner has since removed from the approved list: the
// next try refuses it before any send, it ends failed at once, and it is never tried again.
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
import { deliverDueReplies, nextReplyDueAt } from '../channel-sender.js';
import { freshReplyDb, imessage, personTurn, replyRows, setApproved, testDb, OWNER, OTHER, T0 } from './helpers/reply-sender.js';

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  freshReplyDb(runMigrations);
  await routeTerminalReply(...personTurn('your code is 4417', { channel: 'imessage' }));
  testDb().prepare('UPDATE deliveries SET next_attempt_at = ? WHERE payload_json IS NOT NULL').run(T0);
});

describe('a recipient removed from the list gets no retry', () => {
  it('the retry is refused before the send and the row is final', async () => {
    imessage.send.mockResolvedValueOnce(false);
    await deliverDueReplies(T0);
    setApproved([OWNER, OTHER]);
    await deliverDueReplies(T0 + 30_000);

    expect(imessage.send).toHaveBeenCalledTimes(1);
    const [row] = replyRows();
    expect(row).toMatchObject({ outcome: 'failed', attempts: 2 });
    expect(row.detail).toMatch(/no longer on the approved list/);
    expect(nextReplyDueAt()).toBeNull();
  });
});
