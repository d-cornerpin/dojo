// An early answer whose first try fails is tried again by the Dojo, like any reply, and reaches the person once.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => (await import('./helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../../db/migrations.js';
import { deliverDueReplies } from '../channel-sender.js';
import { freshReplyDb, imessage, replyRows, PERSON } from './helpers/reply-sender.js';
import { imessageTurn } from './helpers/imessage-turn.js';

const ANSWER = 'The venue holds 120 people and is free on the 14th.';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  freshReplyDb(runMigrations);
});

describe('an early answer that fails is tried again and goes once', () => {
  it('fails, is tried again 30 seconds later and goes; the turn\'s end added no second copy', async () => {
    const turn = imessageTurn();
    await turn.answerEarly(ANSWER);
    await turn.end();
    const now = Date.now();
    imessage.send.mockResolvedValueOnce(false);
    await deliverDueReplies(now);
    await deliverDueReplies(now + 30_000);
    await deliverDueReplies(now + 3_600_000);
    expect(imessage.send.mock.calls).toEqual([[PERSON, ANSWER], [PERSON, ANSWER]]);
    expect(replyRows().map((r) => [r.outcome, r.attempts])).toEqual([['delivered', 2]]);
  });
});
