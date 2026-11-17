// Another Dojo's agent that texts an agent that cannot run is sent nothing: the line is recorded held.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => ({ ...(await import('./helpers/reply-sender.js')).bridgeMock(await orig()), sendAlert: async () => true }));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../../db/migrations.js';
import { deliverDueReplies } from '../channel-sender.js';
import { freshReplyDb, imessage, OTHER, T0 } from './helpers/reply-sender.js';
import { overBudget, textFrom, stopOn, sentRows, parkNotes } from './helpers/parked-agent.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: T0 });
  freshReplyDb(runMigrations);
  overBudget();
});

describe('no cannot-run line goes to another Dojo\'s agent', () => {
  it('the line is held and nothing is sent', async () => {
    textFrom('m-1', OTHER, { relation: 'known_contact', senderIsAgent: true });
    await stopOn('m-1');
    await deliverDueReplies(T0);

    expect(imessage.send).not.toHaveBeenCalled();
    expect(sentRows().map((r) => [r.tool, r.outcome])).toEqual([['cannot-run', 'held']]);
    expect(parkNotes().map((n) => n.id)).toEqual(['park-note:m-1']);
  });
});
