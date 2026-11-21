// 3.5 (owner law: the Dojo always knows which channel it used and who it talked to). A written reply
// to an email turn goes out by email, so the delivery ledger must carry an email row naming the
// sender, not only the dashboard bubble. Drives the real finalize router, the real sender and the real
// gmail_reply tool; only the provider's network edge and the account lookups are stand-ins.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(), getDbPath: () => ':memory:',
}));
vi.mock('../../../../../google/auth.js', () => ({ getValidAccessTokenForAccount: async () => 'tok' }));
vi.mock('../../../../../google/accounts.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveGoogleAccountForTool: () => ({ account: { id: 'agent', kind: 'agent', position: 1, email: 'agent@x.test', enabled: true, connected: true, sendEmail: true } }),
}));
vi.mock('../../../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => '' }));
vi.mock('../../../../access/channels.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), mayUseChannel: () => true }));
vi.mock('../../../../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../../../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => false }));
vi.mock('../link-backstop.js', () => ({ appendUndeliveredLinks: async (s: unknown) => s }));
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../../../../db/migrations.js';
import { routeTerminalReply } from '../route-reply.js';
import { deliverDueReplies } from '../../../channel-sender.js';
import { resolveInbound } from '../../../inbound-channel.js';

const OWNER_MAILBOX = 'owner@home.test';
let calls: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  mockDb.current = new Database(':memory:'); runMigrations();
  mockDb.current.prepare("INSERT INTO agents (id, name, status, classification) VALUES ('primary', 'primary', 'idle', 'standard')").run();
  mockDb.current.prepare("INSERT INTO google_accounts (id, kind, position, email, connected) VALUES ('g-user', 'user', 0, ?, 1)").run(OWNER_MAILBOX);
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(String(url));
    const body = String(url).includes('/messages/m1') ? { threadId: 't1', payload: { headers: [{ name: 'From', value: `Sender <${OWNER_MAILBOX}>` }, { name: 'Subject', value: 'hello' }, { name: 'Message-ID', value: '<o@x.test>' }] } } : { id: 'sent1', threadId: 't1' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

describe('an email turn\'s written reply is recorded as email, to the sender', () => {
  it('the ledger holds an email row whose recipient is the sender (the watcher stamps `sender`, not a separate reply address)', async () => {
    const inboundMeta = JSON.stringify({ channel: 'email', accountKind: 'agent', authorized: true, sender: OWNER_MAILBOX, emailMessageId: 'm1', emailService: 'gmail', emailAccount: 'agent@x.test', emailSubject: 'hello', relation: 'owner', ownerWords: 'Yes.' });
    const r = resolveInbound({ agentId: 'primary', content: 'x', channel: 'email', inboundMeta });
    expect(r.inboundChannel).toBe('email');
    const state = { lastAssistantTextForIM: 'received', explicitSendThisTurn: {}, repliedToCounterpartyThisTurn: {}, steerQueue: { pending: [], fired: [] }, inboundContext: r.inboundContext, inboundChannel: 'email' } as never;
    const address = { kind: 'person', isOwner: true, boundChannel: 'email', autoRoutes: true };
    const ctx = { agentId: 'primary', turnNumber: 1, turnCtx: { address, root: null, replyFiles: [] }, counterparty: { kind: 'user', channel: 'email', senderId: OWNER_MAILBOX, relation: 'owner' }, chosenConvKey: 'c', settledContextWakeTurn: false, isEngineTurn: false, persistRoutingMarker: () => {} } as never;
    await routeTerminalReply(state, ctx);
    await deliverDueReplies(Date.now());

    expect(calls.some((u) => u.endsWith('/messages/send'))).toBe(true);
    const rows = mockDb.current!.prepare("SELECT tool, channel, recipient_id FROM deliveries WHERE channel = 'email'").all() as Array<{ tool: string; channel: string; recipient_id: string | null }>;
    expect(rows).toEqual([{ tool: 'auto-route', channel: 'email', recipient_id: OWNER_MAILBOX }]);
    const pills = mockDb.current!.prepare("SELECT content FROM messages WHERE role = 'system' ORDER BY rowid").all() as Array<{ content: string }>;
    expect(pills.at(-1)?.content).toContain(`email to ${OWNER_MAILBOX}`);
  });
});
