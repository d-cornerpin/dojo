// A reply still queued when the owner ends its agent is never sent afterwards: the sender's check before
// each send finds the agent ended and closes the reply as not delivered.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => (await import('./helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../steps/finalize/link-backstop.js', () => ({ appendUndeliveredLinks: async (s: unknown) => s }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

vi.mock('../../../vault/archive.js', () => ({ archiveAgentConversation: () => {} }));

import { runMigrations } from '../../../db/migrations.js';
import { routeTerminalReply } from '../steps/finalize/route-reply.js';
import { deliverDueReplies } from '../channel-sender.js';
import { terminateAgent } from '../../spawner.js';
import { freshReplyDb, imessage, personTurn, replyRows, AGENT, T0 } from './helpers/reply-sender.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T0);
  freshReplyDb(runMigrations);
});

describe('a reply from an ended agent never goes', () => {
  it('the queued reply is not sent and ends not delivered, for good', async () => {
    await routeTerminalReply(...personTurn('here is the address', { channel: 'imessage' }));
    terminateAgent(AGENT, 'test');

    await deliverDueReplies(Date.now());
    await deliverDueReplies(Date.now() + 2 * 60 * 60_000);

    expect(imessage.send).not.toHaveBeenCalled();
    expect(replyRows()[0]).toMatchObject({ outcome: 'failed', detail: 'the agent was ended', attempts: 1 });
  });
});
