// A start line ("on it") is tried once, and only within a minute of being written: it is never tried again and
// never arrives after the answer. A start line that did not go is not told to the owner or the agent.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => (await import('./helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../../db/migrations.js';
import { deliverDueReplies } from '../channel-sender.js';
import { servedOwnerNotices } from '../../../healer/owner-notice-kinds.js';
import { freshReplyDb, imessage, replyRows, testDb, PERSON } from './helpers/reply-sender.js';
import { imessageTurn } from './helpers/imessage-turn.js';

const MIN = 60_000;
let now = 0;
const told = () => ({
  cards: servedOwnerNotices().length,
  notices: testDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE content LIKE '[SOURCE: AGENT NOTICE%'").get(),
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  freshReplyDb(runMigrations);
  const turn = imessageTurn();
  await turn.startLine('On it, checking the venue now.');
  await turn.end('The venue is free on the 14th.');
  now = Date.now();
});

describe('a start line is tried once and never arrives after the answer', () => {
  it('fails once: it is not tried again, and the answer still goes', async () => {
    imessage.send.mockResolvedValueOnce(false);
    await deliverDueReplies(now);
    await deliverDueReplies(now + 1_000);
    await deliverDueReplies(now + 10 * MIN);
    expect(imessage.send.mock.calls).toEqual([[PERSON, 'On it, checking the venue now.'], [PERSON, 'The venue is free on the 14th.']]);
    expect(replyRows().map((r) => [r.outcome, r.attempts])).toEqual([['failed', 1], ['delivered', 1]]);
    expect(told()).toEqual({ cards: 0, notices: { n: 0 } });
  });

  it('not tried within a minute of being written: it never goes, and the answer does', async () => {
    await deliverDueReplies(now + MIN + 1);
    await deliverDueReplies(now + MIN + 2);
    expect(imessage.send.mock.calls).toEqual([[PERSON, 'The venue is free on the 14th.']]);
    expect(replyRows()[0]).toMatchObject({ outcome: 'failed', attempts: 1 });
    expect(told()).toEqual({ cards: 0, notices: { n: 0 } });
  });
});
