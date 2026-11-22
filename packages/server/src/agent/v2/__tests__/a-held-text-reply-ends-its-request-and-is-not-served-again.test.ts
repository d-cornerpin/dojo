// A reply to a text request that is held (here: the agent holds no iMessage grant) ends the request failed with
// the hold's reason, instead of handing it back to be answered into the same hold again.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => (await import('./helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => false, engineRouteRefusalReason: () => 'this agent holds no iMessage grant' }));
vi.mock('../steps/finalize/link-backstop.js', () => ({ appendUndeliveredLinks: async (s: unknown) => s }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { freshReplyDb, imessage, testDb } from './helpers/reply-sender.js';
import { claimedAsk } from './helpers/owner-stop.js';
import { CONV, askRow, endTurn, turnRow } from './helpers/text-request.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date());
  freshReplyDb(runMigrations);
});

describe('a held text reply ends its request and is not served again', () => {
  it('the request is failed with the hold\'s reason, and nothing was sent', async () => {
    const ask = claimedAsk('msg-1', CONV, 1);
    turnRow(1);
    await endTurn(1, 'the table is booked for eight');
    expect(imessage.send).not.toHaveBeenCalled();
    expect(askRow(ask).state).toBe('failed');
    const reason = testDb().prepare(
      "SELECT json_extract(payload, '$.reason') AS r FROM work_events WHERE work_id = ? AND kind = 'transition' ORDER BY id DESC LIMIT 1",
    ).get(ask) as { r: string };
    expect(reason.r).toContain('this agent holds no iMessage grant');
  });
});
