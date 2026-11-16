// The process dies after the reply was queued and before the turn was recorded: at the next start the request is
// not handed back to be answered again; the queued reply goes and closes it.
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
import { reconcileOrphanedClaims } from '../../../work/orphaned-claims.js';
import { freshReplyDb, imessage, personTurn } from './helpers/reply-sender.js';
import { claimedAsk } from './helpers/owner-stop.js';
import { CONV, askRow, turnRow } from './helpers/text-request.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date());
  freshReplyDb(runMigrations);
});

describe('a crash before the turn is recorded does not hand back a request whose reply is queued', () => {
  it('the start-up reconciliation leaves it claimed; the reply goes after the start and closes it', async () => {
    const ask = claimedAsk('msg-1', CONV, 1);
    turnRow(1, false);
    await routeTerminalReply(...personTurn('the table is booked for eight', { channel: 'imessage' }, 1));

    expect(reconcileOrphanedClaims().reArmed).toBe(0);
    expect(askRow(ask).state).toBe('claimed');

    await deliverDueReplies(Date.now());
    expect(imessage.send).toHaveBeenCalledTimes(1);
    expect(askRow(ask).state).toBe('done');
  });
});
