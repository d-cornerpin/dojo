// While the owner has iMessage switched off in Settings, a reply queued for iMessage is never sent: the sender's
// check before each send finds it off and closes the reply as not delivered with the plain reason.
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
import { deliverDueReplies } from '../channel-sender.js';
import { freshReplyDb, imessage, personTurn, replyRows, T0 } from './helpers/reply-sender.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T0);
  freshReplyDb(runMigrations);
});

describe('with iMessage switched off', () => {
  it('a queued iMessage reply is not sent and ends not delivered with the reason', async () => {
    imessage.on = false;
    await routeTerminalReply(...personTurn('here is the address', { channel: 'imessage' }));
    await deliverDueReplies(Date.now());
    expect(imessage.send).not.toHaveBeenCalled();
    expect(replyRows()[0]).toMatchObject({ outcome: 'failed', detail: 'iMessage is switched off in Settings', attempts: 1 });
  });

  it('switched on, the same reply goes', async () => {
    await routeTerminalReply(...personTurn('here is the address', { channel: 'imessage' }));
    await deliverDueReplies(Date.now());
    expect(imessage.send).toHaveBeenCalledTimes(1);
    expect(replyRows()[0]).toMatchObject({ outcome: 'delivered' });
  });
});
