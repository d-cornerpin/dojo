// A try that comes back after its row was already finished elsewhere (a restarted sender resent it once the
// lease ran out) changes nothing: no second pill and no second verdict.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const fake = vi.hoisted(() => ({ errors: [] as Array<Record<string, unknown>> }));
vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => (await import('./helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../steps/finalize/link-backstop.js', () => ({ appendUndeliveredLinks: async (s: unknown) => s }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));
vi.mock('../../../logger.js', () => ({ createLogger: () => ({ info: () => {}, debug: () => {}, warn: () => {}, error: (_m: string, data: Record<string, unknown>) => fake.errors.push(data) }) }));

import { runMigrations } from '../../../db/migrations.js';
import { routeTerminalReply } from '../steps/finalize/route-reply.js';
import { deliverDueReplies } from '../channel-sender.js';
import { freshReplyDb, imessage, personTurn, replyRows, testDb, PERSON, T0 } from './helpers/reply-sender.js';

const pills = (): string[] => (testDb().prepare("SELECT content FROM messages WHERE role = 'system' ORDER BY rowid").all() as Array<{ content: string }>).map((r) => r.content);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  freshReplyDb(runMigrations);
  fake.errors = [];
  await routeTerminalReply(...personTurn('see you at noon', { channel: 'imessage' }));
  testDb().prepare('UPDATE deliveries SET next_attempt_at = ? WHERE payload_json IS NOT NULL').run(T0);
});

describe('a late verdict on a finished reply changes nothing', () => {
  it('the first try comes back after the restarted sender delivered the row: one delivered pill, no error', async () => {
    let finish: (ok: boolean) => void = () => {};
    imessage.send.mockImplementationOnce(() => new Promise<boolean>((r) => { finish = r; }));
    const first = deliverDueReplies(T0);
    await vi.waitFor(() => expect(imessage.send).toHaveBeenCalledTimes(1));

    vi.resetModules();
    const restarted = await import('../channel-sender.js');
    await restarted.deliverDueReplies(T0 + 10 * 60_000);
    expect(replyRows()).toMatchObject([{ outcome: 'delivered' }]);

    finish(true);
    await first;
    expect(replyRows()).toMatchObject([{ outcome: 'delivered' }]);
    expect(pills()).toEqual([`[Reply routed via sending by iMessage to ${PERSON}]`, `[Reply routed via iMessage to ${PERSON}]`]);
    expect(fake.errors).toEqual([]);
  });
});
