// A reply to an iMessage that does not go out is tried again by the Dojo itself, after 30 seconds, then 2, 10 and
// 30 minutes; it goes once the channel works. After five failed tries it is recorded failed and never tried again.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const logged = vi.hoisted(() => ({ errors: [] as Array<{ msg: string; data: Record<string, unknown> }> }));
vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => (await import('./helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../steps/finalize/link-backstop.js', () => ({ appendUndeliveredLinks: async (s: unknown) => s }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));
vi.mock('../../../logger.js', () => ({ createLogger: () => ({ info: () => {}, debug: () => {}, warn: () => {}, error: (msg: string, data: Record<string, unknown>) => logged.errors.push({ msg, data }) }) }));

import { runMigrations } from '../../../db/migrations.js';
import { routeTerminalReply } from '../steps/finalize/route-reply.js';
import { deliverDueReplies } from '../channel-sender.js';
import { freshReplyDb, imessage, personTurn, replyRows, testDb, PERSON, T0 } from './helpers/reply-sender.js';

const MIN = 60_000;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  freshReplyDb(runMigrations);
  logged.errors = [];
  await routeTerminalReply(...personTurn('the table is booked for eight', { channel: 'imessage' }));
  testDb().prepare('UPDATE deliveries SET next_attempt_at = ? WHERE payload_json IS NOT NULL').run(T0);
});

describe('an iMessage reply that fails is tried again and goes', () => {
  it('is queued as one waiting row, not sent inside the turn', () => {
    expect(imessage.send).not.toHaveBeenCalled();
    expect(replyRows()).toMatchObject([{ outcome: 'pending', attempts: 0, turn_number: 1 }]);
  });

  it('fails, waits 30 seconds, fails, waits 2 minutes, then goes', async () => {
    imessage.send.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    await deliverDueReplies(T0);
    expect(replyRows()[0]).toMatchObject({ outcome: 'pending', attempts: 1, next_attempt_at: T0 + 30_000 });
    await deliverDueReplies(T0 + 29_000);
    expect(imessage.send).toHaveBeenCalledTimes(1);
    await deliverDueReplies(T0 + 30_000);
    expect(replyRows()[0]).toMatchObject({ outcome: 'pending', attempts: 2, next_attempt_at: T0 + 30_000 + 2 * MIN });
    await deliverDueReplies(T0 + 30_000 + 2 * MIN);
    expect(imessage.send).toHaveBeenCalledTimes(3);
    expect(imessage.send).toHaveBeenLastCalledWith(PERSON, 'the table is booked for eight');
    expect(replyRows()[0]).toMatchObject({ outcome: 'delivered', attempts: 3 });
    const pills = testDb().prepare("SELECT content FROM messages WHERE role = 'system' ORDER BY rowid").all() as Array<{ content: string }>;
    expect(pills.map((p) => p.content)).toEqual([`[Reply routed via iMessage to ${PERSON} (sending)]`, `[Reply routed via iMessage to ${PERSON}]`]);
  });

  it('after five failed tries over about 43 minutes it is failed, logged, and never tried again', async () => {
    imessage.send.mockResolvedValue(false);
    let now = T0;
    for (const wait of [30_000, 2 * MIN, 10 * MIN, 30 * MIN, 0]) {
      await deliverDueReplies(now);
      now += wait;
    }
    expect(now - T0).toBe(42.5 * MIN);
    expect(imessage.send).toHaveBeenCalledTimes(5);
    const [row] = replyRows();
    expect(row).toMatchObject({ outcome: 'failed', attempts: 5 });
    expect(logged.errors.some((e) => e.data.deliveryId === row.id)).toBe(true);
    await deliverDueReplies(now + 24 * 60 * MIN);
    expect(imessage.send).toHaveBeenCalledTimes(5);
  });
});
