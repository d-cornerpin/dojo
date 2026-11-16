// A reply tried again while a later turn of the same agent is running is recorded under the turn that wrote it:
// its receipt and its row carry that turn and its request, never the live one.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => (await import('./helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../steps/finalize/link-backstop.js', () => ({ appendUndeliveredLinks: async (s: unknown) => s }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../../db/migrations.js';
import { routeTerminalReply } from '../steps/finalize/route-reply.js';
import { deliverDueReplies } from '../channel-sender.js';
import { openTurnContext, endTurnContext } from '../../turn-context.js';
import { freshReplyDb, imessage, personTurn, replyRows, testDb, AGENT, T0 } from './helpers/reply-sender.js';

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  freshReplyDb(runMigrations);
  await routeTerminalReply(...personTurn('the plumber comes at nine', { channel: 'imessage' }, 1));
  testDb().prepare('UPDATE deliveries SET next_attempt_at = ? WHERE payload_json IS NOT NULL').run(T0);
});
afterEach(() => endTurnContext(AGENT));

describe('a retry during a later turn is recorded under its own turn', () => {
  it('the retry\'s receipt and row name turn 1 and its request while turn 2 runs', async () => {
    imessage.send.mockResolvedValueOnce(false);
    await deliverDueReplies(T0);

    const live = openTurnContext(AGENT);
    live.turnNumber = 2;
    live.convKey = 'live-conversation';
    live.root = { kind: 'ask', id: 'ask-2', sourceMessageId: null, conversationId: 'conv-live' };
    await deliverDueReplies(T0 + 30_000);

    expect(replyRows()).toMatchObject([{ outcome: 'delivered', turn_number: 1 }]);
    const receipts = testDb().prepare("SELECT turn_number, root_id, conv_key FROM tool_receipts WHERE tool = 'imessage_send'").all();
    expect(receipts).toEqual([{ turn_number: 1, root_id: 'ask-1', conv_key: null }]);
    expect(testDb().prepare('SELECT COUNT(*) AS n FROM deliveries WHERE turn_number = 2').get()).toEqual({ n: 0 });
  });
});
