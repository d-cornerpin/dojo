// A try that breaks before anything is sent (a lookup that throws) still counts as a try: after five it is
// recorded failed with its error logged, and the next reply to the same person is no longer held behind it.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const fake = vi.hoisted(() => ({ broken: true, errors: [] as Array<Record<string, unknown>> }));
vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => (await import('./helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../access/engine-route.js', () => ({
  engineMayRouteTo: () => { if (fake.broken) throw new Error('grant table unreadable'); return true; },
  engineRouteRefusalReason: () => 'no grant',
}));
vi.mock('../steps/finalize/link-backstop.js', () => ({ appendUndeliveredLinks: async (s: unknown) => s }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));
vi.mock('../../../logger.js', () => ({ createLogger: () => ({ info: () => {}, debug: () => {}, warn: () => {}, error: (_m: string, data: Record<string, unknown>) => fake.errors.push(data) }) }));

import { runMigrations } from '../../../db/migrations.js';
import { routeTerminalReply } from '../steps/finalize/route-reply.js';
import { deliverDueReplies } from '../channel-sender.js';
import { freshReplyDb, imessage, personTurn, replyRows, testDb, PERSON, T0 } from './helpers/reply-sender.js';

const MIN = 60_000;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  freshReplyDb(runMigrations);
  fake.broken = false;
  fake.errors = [];
  await routeTerminalReply(...personTurn('first', { channel: 'imessage' }, 1));
  await routeTerminalReply(...personTurn('second', { channel: 'imessage' }, 2));
  fake.broken = true;
  testDb().prepare('UPDATE deliveries SET next_attempt_at = ? WHERE payload_json IS NOT NULL').run(T0);
});

describe('a try that breaks before the send still ends and frees the queue', () => {
  it('five broken tries end the row failed, logged, and the next reply goes', async () => {
    let now = T0;
    for (const wait of [30_000, 2 * MIN, 10 * MIN, 30 * MIN, 0]) {
      await deliverDueReplies(now);
      now += wait;
    }
    const [first, second] = replyRows();
    expect(first).toMatchObject({ outcome: 'failed', attempts: 5 });
    expect(first.detail).toMatch(/grant table unreadable/);
    expect(fake.errors.some((e) => e.deliveryId === first.id)).toBe(true);
    expect(second).toMatchObject({ outcome: 'pending', attempts: 0 });

    fake.broken = false;
    await deliverDueReplies(now);
    expect(imessage.send).toHaveBeenCalledTimes(1);
    expect(imessage.send).toHaveBeenCalledWith(PERSON, 'second');
    expect(replyRows()[1]).toMatchObject({ outcome: 'delivered' });
  });
});
