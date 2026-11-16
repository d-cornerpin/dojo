// A reply still waiting to go keeps its request with the turn that answered it: not owed, not handed back to be
// served again, and the agent is told it has not gone out yet. It closes when the reply goes.
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
import { CONV, askRow, endTurn } from './helpers/text-request.js';

import { openObligations } from '../../../work/store.js';
import { getRecentOutbound, renderRecentOutboundBlock } from '../outbound-ledger.js';
import { AGENT } from './helpers/reply-sender.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date());
  freshReplyDb(runMigrations);
});

describe('a reply on its way is not shown as owed and the request is not served again', () => {
  it('stays claimed while the reply waits, is not owed, is named as not gone out, and closes when it goes', async () => {
    imessage.send.mockResolvedValueOnce(false);
    const ask = claimedAsk('msg-1', CONV, 1);
    await endTurn(1, 'the table is booked for eight');
    await deliverDueReplies(Date.now());

    expect(askRow(ask).state).toBe('claimed');
    expect(openObligations(AGENT).map((o) => o.id)).not.toContain(ask);
    expect(renderRecentOutboundBlock(getRecentOutbound(AGENT, 24, 5))).toMatch(/iMessage -> \+15550100: not gone out yet, the Dojo is still trying$/);

    await deliverDueReplies(Date.now() + 30_000);
    expect(replyRows()[0].outcome).toBe('delivered');
    expect(askRow(ask).state).toBe('done');
  });
});
