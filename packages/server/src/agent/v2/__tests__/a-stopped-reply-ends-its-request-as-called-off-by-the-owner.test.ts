// A reply dropped by Stop ends the request it was answering: the request is abandoned by the owner, in the same
// step, and a request the reply was not answering is left alone.
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
import { freshReplyDb, personTurn, testDb, PERSON, T0 } from './helpers/reply-sender.js';
import { askState, claimedAsk, pressStop } from './helpers/owner-stop.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T0);
  freshReplyDb(runMigrations);
});

describe('a stopped reply ends its request as called off by the owner', () => {
  it('the request the reply answered is abandoned by the owner; another turn\'s request stays claimed', async () => {
    const answered = claimedAsk('msg-1', `conv-${PERSON}`, 1);
    const other = claimedAsk('msg-2', `conv-${PERSON}`, 2);
    await routeTerminalReply(...personTurn('here is the address', { channel: 'imessage' }, 1));

    expect((await pressStop()).status).toBe(200);

    expect(askState(answered)).toBe('abandoned');
    const event = testDb().prepare(
      "SELECT json_extract(payload, '$.by') AS by FROM work_events WHERE work_id = ? AND kind = 'transition' ORDER BY id DESC LIMIT 1",
    ).get(answered) as { by: string };
    expect(event.by).toBe('owner');
    expect(askState(other)).toBe('claimed');
  });
});
