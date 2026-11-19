// When the owner's own agent cannot run, he is told on the dashboard only, in today's words: no text to him.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OWNER_ALERT_HEADS_UP_PREFIX } from '@dojo/shared';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => ({ ...(await import('./helpers/reply-sender.js')).bridgeMock(await orig()), sendAlert: async () => true }));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../../db/migrations.js';
import { deliverDueReplies } from '../channel-sender.js';
import { freshReplyDb, imessage, OWNER, T0 } from './helpers/reply-sender.js';
import { overBudget, textFrom, stopOn, sentRows, parkNotes } from './helpers/parked-agent.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: T0 });
  freshReplyDb(runMigrations);
  overBudget();
});

describe('the owner gets no text when his agent cannot run', () => {
  it('his messages by iMessage get the dashboard line only', async () => {
    textFrom('m-1', OWNER, { relation: 'owner' });
    await stopOn('m-1');
    textFrom('m-2', OWNER, { relation: 'owner' });
    await stopOn('m-2');
    await deliverDueReplies(T0);

    expect(imessage.send).not.toHaveBeenCalled();
    expect(sentRows()).toEqual([]);
    const [first, second] = parkNotes();
    expect(first.content).toMatch(/^\[System \(platform notice\): .*\$2\.00/);
    expect(second.content.startsWith(OWNER_ALERT_HEADS_UP_PREFIX)).toBe(true);
  });
});
