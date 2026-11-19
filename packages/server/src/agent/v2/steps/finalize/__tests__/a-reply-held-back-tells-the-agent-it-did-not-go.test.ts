// A reply the engine holds back (no permission on the channel, or no address to send to) stays in the dashboard
// and is never sent later, so the agent is told once that it did not go. A dashboard reply tells it nothing.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

const mockDb = { current: null as Database.Database | null };
const route = vi.hoisted(() => ({ granted: true }));
const notices = vi.hoisted(() => [] as Array<{ toAgentId: string; brief: string }>);
vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(), getDbPath: () => ':memory:',
}));
vi.mock('../../../../access/engine-route.js', () => ({ engineMayRouteTo: () => route.granted, engineRouteRefusalReason: () => 'withheld' }));
vi.mock('../../../../agent-notice.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  postAgentNotice: (o: { toAgentId: string; brief: string }) => { notices.push(o); return 'notice'; },
}));
vi.mock('../../../../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../../../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => false }));
vi.mock('../link-backstop.js', () => ({ appendUndeliveredLinks: async (s: unknown) => s }));
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../../../../db/migrations.js';
import { routeTerminalReply } from '../route-reply.js';

const AGENT = randomUUID();
async function reply(boundChannel: string): Promise<void> {
  const state = { lastAssistantTextForIM: 'here it is', explicitSendThisTurn: {}, repliedToCounterpartyThisTurn: {}, steerQueue: { pending: [], fired: [] }, inboundContext: null, inboundChannel: boundChannel } as never;
  const address = { kind: 'person', isOwner: true, boundChannel, autoRoutes: true };
  const ctx = { agentId: AGENT, turnNumber: 1, turnCtx: { address, ownerAffinityDestination: null, root: null, replyFiles: [] }, counterparty: { kind: 'user', channel: boundChannel, senderId: 'owner@example.com', relation: 'owner' }, chosenConvKey: 'c', settledContextWakeTurn: false, isEngineTurn: false, persistRoutingMarker: () => {} } as never;
  await routeTerminalReply(state, ctx);
}

beforeEach(() => {
  mockDb.current = new Database(':memory:'); runMigrations();
  mockDb.current.prepare("INSERT INTO agents (id, name, status, classification) VALUES (?, 'main', 'idle', 'standard')").run(AGENT);
  route.granted = true; notices.length = 0;
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('a reply held back tells the agent it did not go', () => {
  it('no permission on the channel: one notice that it stayed in the dashboard', async () => {
    route.granted = false;
    await reply('email');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.toAgentId).toBe(AGENT);
    expect(notices[0]!.brief).toContain('Your reply did not go out on the email channel: you have no permission to send on that channel');
    expect(notices[0]!.brief).toContain('will not be sent later');
  });

  it('no address to send to: one notice that names it', async () => {
    await reply('email');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.brief).toContain('there was no email address to send it to');
  });

  it('a reply that belongs in the dashboard: no notice', async () => {
    await reply('dashboard');
    expect(notices).toEqual([]);
  });
});
