// A phone call is live like voice: an answer fully streamed to the caller writes no reply row of its own, and the
// dashboard copy closes the request, so the answer is not served (spoken) a second time.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => (await import('./helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../steps/finalize/link-backstop.js', () => ({ appendUndeliveredLinks: async (s: unknown) => s }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { openAsk, claimAsk, stampClaimingTurn } from '../../../work/store.js';
import { settleAsksAtTurnFinalize } from '../../../work/ask-settlement.js';
import { freshReplyDb, testDb, AGENT, PERSON } from './helpers/reply-sender.js';
import { askRow, dashboardCopy } from './helpers/text-request.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date());
  freshReplyDb(runMigrations);
});

describe('a streamed phone answer is not spoken twice', () => {
  it('the request on the call closes on the dashboard copy at the turn\'s end', () => {
    testDb().prepare("INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES ('conv-call', ?, 'phone', ?)").run(AGENT, PERSON);
    const ask = openAsk({ agentId: AGENT, messageId: 'msg-call', conversationId: 'conv-call', requesterId: null, openedAt: Date.now(), title: null });
    claimAsk(ask, AGENT);
    stampClaimingTurn(ask, 1);
    dashboardCopy(1, 'conv-call');
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 1 });
    expect(askRow(ask).state).toBe('done');
  });
});
