// A start line ("on it") waiting to go is not the reply: the request whose turn ended with only that is handed
// back to be answered.
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
import { CONV, askRow, endTurn, turnRow } from './helpers/text-request.js';

import { queueReply } from '../deliveries.js';
import { AGENT, PERSON } from './helpers/reply-sender.js';
import { settleAsksAtTurnFinalize } from '../../../work/ask-settlement.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date());
  freshReplyDb(runMigrations);
});

describe('a start line alone never holds a request', () => {
  it('the request goes back open while only its start line waits', async () => {
    const ask = claimedAsk('msg-1', CONV, 1);
    turnRow(1);
    await queueReply({ agentId: AGENT, turnNumber: 1, root: { kind: 'ask', id: 'msg-1', sourceMessageId: 'msg-1', conversationId: CONV }, text: 'on it', address: { channel: 'imessage', to: PERSON }, kind: 'start-line' });
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 1 });
    expect(replyRows()[0].outcome).toBe('pending');
    expect(askRow(ask).state).toBe('open');
  });
});
