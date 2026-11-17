// A reply that fails all its tries ends its request failed, with the reason, so it is not served again.
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
import { freshReplyDb, imessage, replyRows } from './helpers/reply-sender.js';
import { claimedAsk } from './helpers/owner-stop.js';
import { CONV, askRow, endTurn, turnRow } from './helpers/text-request.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date());
  freshReplyDb(runMigrations);
});

describe('a reply that never goes ends its request failed and it is not served again', () => {
  it('after five failed tries the request is failed, not open', async () => {
    imessage.send.mockResolvedValue(false);
    const ask = claimedAsk('msg-1', CONV, 1);
    turnRow(1);
    await endTurn(1, 'the table is booked for eight');
    let now = Date.now();
    for (const wait of [30_000, 120_000, 600_000, 1_800_000, 0]) {
      await deliverDueReplies(now);
      now += wait;
    }
    expect(replyRows()[0].outcome).toBe('failed');
    expect(askRow(ask).state).toBe('failed');
  });
});
