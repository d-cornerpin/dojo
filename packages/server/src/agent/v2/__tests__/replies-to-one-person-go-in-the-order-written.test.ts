// Two replies to one person go in the order they were written: while the older one waits for its retry the newer
// one waits behind it. A reply to someone else never waits behind them.
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
import { freshReplyDb, imessage, personTurn, testDb, PERSON, OTHER, T0 } from './helpers/reply-sender.js';

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  freshReplyDb(runMigrations);
  await routeTerminalReply(...personTurn('first', { channel: 'imessage' }, 1));
  await routeTerminalReply(...personTurn('second', { channel: 'imessage' }, 2));
  await routeTerminalReply(...personTurn('to someone else', { channel: 'imessage', sender: OTHER }, 3));
  testDb().prepare('UPDATE deliveries SET next_attempt_at = ? WHERE payload_json IS NOT NULL').run(T0);
});

const sentTo = (who: string): string[] => imessage.send.mock.calls.filter(([to]) => to === who).map(([, text]) => text);

describe('replies to one person go in the order written', () => {
  it('the newer reply waits behind the older one\'s retry, then both go in order', async () => {
    imessage.send.mockImplementation(async (to, text) => !(to === PERSON && text === 'first' && sentTo(PERSON).length === 1));
    await deliverDueReplies(T0);
    expect(sentTo(PERSON)).toEqual(['first']);
    expect(sentTo(OTHER)).toEqual(['to someone else']);
    // The waiting head of the queue sets when the next pass is due, not the newer reply behind it.
    expect(nextReplyDueAt()).toBe(T0 + 30_000);

    await deliverDueReplies(T0 + 10_000);
    expect(sentTo(PERSON)).toEqual(['first']);

    await deliverDueReplies(T0 + 30_000);
    expect(sentTo(PERSON)).toEqual(['first', 'first', 'second']);
    expect(nextReplyDueAt()).toBeNull();
  });
});
