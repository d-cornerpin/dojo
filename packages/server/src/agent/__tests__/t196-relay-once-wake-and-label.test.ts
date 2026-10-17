// t196 (A1) - A RELAYED ANSWER IS NOT REPEATED.
//
// The engine relays a single-piece delegated answer to the person who asked. Two things used to make
// the delegating agent tell it again on the next turn:
//   (1) the woken agent-thread turn could not see the relay and its footer said "notify the user";
//   (2) the relay row's label named the request it answered but never said it was SENT.
// Both now state the fact the `deliveries` row already records. Driven through the REAL transport
// door, the REAL runtime wake, the REAL relay writer; only the model loop is a no-op.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.setConfig({ testTimeout: 30_000 });

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(),
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({
  generateEmbedding: vi.fn(async () => new Float32Array(8)),
  queueEmbedding: vi.fn(),
}));
vi.mock('../../config/platform.js', async () => {
  const actual = await vi.importActual<typeof import('../../config/platform.js')>('../../config/platform.js');
  return { ...actual, getOwnerName: () => 'TestUser' };
});
let lastRunTouch = Date.now();
vi.mock('../v2/loop.js', () => ({
  runV2Turn: async () => { lastRunTouch = Date.now(); },
}));
vi.mock('../../services/imessage-bridge.js', () => ({
  sendAlert: vi.fn(), sendResponseViaIMessage: vi.fn(), maybeForwardToImessage: vi.fn(),
}));

const AGENT = 'desk-main';
const HELPER = 'desk-helper';
const CONV = 'conv-1';
const THREAD = 'thread-t196aaaa-0001';
const ASK_MSG = 'm-ask';
const ASK = `ask:${ASK_MSG}`;
const ANSWER = 'No record of that identifier; I cannot give three facts about it.';

const db = (): Database.Database => mockDb.current!;

beforeEach(async () => {
  const shared = await import('../shared-state.js');
  shared.activeRuns.clear();
  shared.pendingWakeups.clear();
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
});
afterEach(async () => {
  const shared = await import('../shared-state.js');
  shared.activeRuns.clear();
  lastRunTouch = Date.now();
  while (Date.now() - lastRunTouch < 900 || shared.activeRuns.size > 0) await new Promise((r) => setTimeout(r, 100));
  mockDb.current?.close();
  mockDb.current = null;
});

async function boot(): Promise<void> {
  await import('../runtime.js');
  const { runMigrations } = await import('../../db/migrations.js');
  runMigrations();
  db().prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Desk', 'idle', '1970-01-01'), (?, 'Helper', 'idle', '1970-01-01')`,
  ).run(AGENT, HELPER);
  db().prepare(
    `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at)
     VALUES (?, ?, 'dashboard', NULL, 'owner', datetime('now'))`,
  ).run(CONV, AGENT);
}

async function delegate(): Promise<void> {
  const { insertMessage } = await import('../../memory/message-store.js');
  insertMessage({
    id: ASK_MSG, agentId: AGENT, role: 'user', content: 'Ask the helper for three facts and tell me when it is done',
    channel: 'dashboard', senderId: 'owner', conversationId: CONV,
    inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  });
  const { claimAsk, stampClaimingTurn, openDelegationJoin } = await import('../../work/store.js');
  claimAsk(ASK, AGENT);
  stampClaimingTurn(ASK, 1);
  openDelegationJoin({
    parentWorkId: ASK, agentId: AGENT, replyConversationId: CONV, ttlAt: Date.now() + 60 * 60_000,
    threads: [{ threadId: THREAD, assigneeAgent: HELPER, intent: 'QUESTION', hopCount: 0 }],
  });
}

async function helperReplies(intent: string): Promise<void> {
  const { deliverA2AMessage } = await import('../a2a-transport.js');
  const r = await deliverA2AMessage({
    intent: intent as never, threadId: THREAD, requiresResponse: false,
    payload: ANSWER, toAgent: AGENT, fromAgent: HELPER,
  } as never);
  expect(r.delivered).toBe(true);
}

/** What the woken agent-thread turn reads: the inbound agent row, footer included. */
const wakeText = (): string =>
  (db().prepare(`SELECT content FROM messages WHERE agent_id = ? AND role = 'user' AND lane = 'a2a' AND a2a_thread_id = ?`)
    .get(AGENT, THREAD) as { content: string }).content;

describe('t196 (A1.2) - the wake footer says the answer was already sent', () => {
  for (const intent of ['COMPLETE', 'ANSWER', 'DELIVERABLE']) {
    it(`${intent}: names the owner, the channel and the instant, and says not to tell him again`, async () => {
      await boot();
      await delegate();
      await helperReplies(intent);
      const relay = db().prepare(`SELECT channel, created_at FROM deliveries WHERE agent_id = ? AND tool = 'a2a-join-relay' AND outcome = 'delivered'`)
        .get(AGENT) as { channel: string; created_at: string } | undefined;
      expect(relay, 'the engine relayed the answer').toBeDefined();
      const text = wakeText();
      expect(text).toMatch(/already sent to TestUser on dashboard at /);
      expect(text).toMatch(/do not tell (him|them) again/i);
      expect(text).toMatch(/update (your )?tracker only/i);
      expect(text).not.toMatch(/notify the user/i);
      expect(text).not.toMatch(/relay to user/i);
    });
  }

  it('a relay held back until the delegating turn ends: the footer does not claim it is sent, and does not invite a second send', async () => {
    await boot();
    await delegate();
    const shared = await import('../shared-state.js');
    shared.activeRuns.add(AGENT);
    try {
      await helperReplies('COMPLETE');
    } finally {
      shared.activeRuns.delete(AGENT);
    }
    expect(db().prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE agent_id = ? AND tool = 'a2a-join-relay'`).get(AGENT)).toEqual({ n: 0 });
    const text = wakeText();
    expect(text).not.toMatch(/already sent/i);
    expect(text).not.toMatch(/notify the user/i);
    expect(text).toMatch(/the engine (sends|delivers) this answer to TestUser itself/i);
  });
});

describe('t196 (A1.1) - the relay row says it was sent', () => {
  it('the owner view labels the relay row with who, which channel, when, and the request it answers', async () => {
    await boot();
    await delegate();
    await helperReplies('COMPLETE');
    const { getRecentMessages } = await import('../../memory/store.js');
    const { labelRows } = await import('../../memory/row-label.js');
    const rows = getRecentMessages(AGENT, 100);
    const relay = rows.find((r) => r.role === 'assistant' && r.content.startsWith('Heard back from'))!;
    expect(relay).toBeDefined();
    const label = labelRows(AGENT, rows).get(relay.id)!;
    expect(label).toMatch(/sent to TestUser on dashboard at [^;]+ by the engine as the result of the request of /);
    expect(label).toMatch(/TestUser has it\]$/);
    expect(label).not.toMatch(/result delivered later/);
  });
});
