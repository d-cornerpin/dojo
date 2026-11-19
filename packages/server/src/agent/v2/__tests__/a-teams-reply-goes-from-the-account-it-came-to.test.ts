// A Teams reply goes back into the chat it came from, from the work account the message came to, so with two
// Teams accounts connected the answer is never sent from the wrong one.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const tool = vi.hoisted(() => ({ calls: [] as Array<{ name: string; arguments: Record<string, unknown> }> }));
vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../steps/finalize/link-backstop.js', () => ({ appendUndeliveredLinks: async (s: unknown) => s }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));
vi.mock('../../tools/index.js', () => ({
  executeTool: async (_agentId: string, call: { name: string; arguments: Record<string, unknown> }) => {
    tool.calls.push(call);
    return { kind: 'applied', value: { toolCallId: 'x', name: call.name, content: 'sent' } };
  },
}));

import { runMigrations } from '../../../db/migrations.js';
import { routeTerminalReply } from '../steps/finalize/route-reply.js';
import { deliverDueReplies } from '../channel-sender.js';
import { resolveInbound } from '../inbound-channel.js';
import { freshReplyDb, personTurn, replyRows, testDb, T0 } from './helpers/reply-sender.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  freshReplyDb(runMigrations);
  testDb().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('teams_approved_senders', JSON.stringify([{ address: 'colleague@example.com', name: 'a colleague' }]));
  tool.calls = [];
});

describe('a Teams reply goes from the account it came to', () => {
  it('the reply is posted into the same chat with the receiving account', async () => {
    const meta = { channel: 'teams', accountKind: 'agent', authorized: true, sender: 'colleague@example.com', recipientAddress: 'colleague@example.com', chatId: 'chat-42', chatType: 'dm', teamsAccount: 'work-2' };
    const { inboundContext } = resolveInbound({ agentId: 'agent-main', content: 'x', channel: 'teams', inboundMeta: JSON.stringify(meta) });
    await routeTerminalReply(...personTurn('the deck is in the shared folder', { channel: 'teams', sender: 'colleague@example.com' }, 1, inboundContext));
    testDb().prepare('UPDATE deliveries SET next_attempt_at = ? WHERE payload_json IS NOT NULL').run(T0);
    await deliverDueReplies(T0);

    expect(tool.calls).toEqual([{ id: expect.any(String), name: 'teams_send_message', arguments: { chat_id: 'chat-42', message: 'the deck is in the shared folder', account: 'work-2' } }]);
    expect(replyRows()).toMatchObject([{ outcome: 'delivered', attempts: 1 }]);
  });
});
