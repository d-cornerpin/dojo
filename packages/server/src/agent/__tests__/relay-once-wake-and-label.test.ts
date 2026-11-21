// A helper's reply the join owns wakes nobody: the request it answers is the one wake. When the Dojo relays the
// answer, the relay row's label says it was sent, to whom and where. Driven through the real transport door and
// the real relay writer; only the model loop is a no-op.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../../memory/message-store.js';
import { claimAsk, stampClaimingTurn, openDelegationJoin } from '../../work/store.js';
import { deliverA2AMessage, relayPiecesWhole } from '../a2a-transport.js';
import { getRecentMessages } from '../../memory/store.js';
import { labelRows } from '../../memory/row-label.js';
import * as shared from '../shared-state.js';
import '../runtime.js';

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
  sendAlert: vi.fn(), maybeForwardToImessage: vi.fn(),
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
  shared.activeRuns.clear();
  shared.pendingWakeups.clear();
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
});
afterEach(async () => {
  shared.activeRuns.clear();
  lastRunTouch = Date.now();
  while (Date.now() - lastRunTouch < 900 || shared.activeRuns.size > 0) await new Promise((r) => setTimeout(r, 100));
  mockDb.current?.close();
  mockDb.current = null;
});

async function boot(): Promise<void> {
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
  insertMessage({
    id: ASK_MSG, agentId: AGENT, role: 'user', content: 'Ask the helper for three facts and tell me when it is done',
    channel: 'dashboard', senderId: 'owner', conversationId: CONV,
    inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  });
  claimAsk(ASK, AGENT);
  stampClaimingTurn(ASK, 1);
  openDelegationJoin({
    parentWorkId: ASK, agentId: AGENT, replyConversationId: CONV, ttlAt: Date.now() + 60 * 60_000,
    threads: [{ threadId: THREAD, assigneeAgent: HELPER, intent: 'QUESTION', hopCount: 0 }],
  });
}

async function helperReplies(intent: string): Promise<void> {
  const r = await deliverA2AMessage({
    intent: intent as never, threadId: THREAD, requiresResponse: false,
    payload: ANSWER, toAgent: AGENT, fromAgent: HELPER,
  } as never);
  expect(r.delivered).toBe(true);
}

describe('a reply the join owns wakes nobody; its request is the one wake', () => {
  for (const intent of ['COMPLETE', 'ANSWER', 'DELIVERABLE']) {
    it(`${intent}: the helper's row carries no wake, and the request is back in the queue, due now`, async () => {
      await boot();
      await delegate();
      await helperReplies(intent);
      expect(db().prepare('SELECT a2a_requires_response AS w FROM messages WHERE agent_id = ? AND a2a_thread_id = ?').get(AGENT, THREAD)).toEqual({ w: 0 });
      const ask = db().prepare('SELECT state, next_attempt_at AS due FROM work WHERE id = ?').get(ASK) as { state: string; due: number | null };
      expect(ask.state).toBe('claimed');
      expect(ask.due).not.toBeNull();
      expect(db().prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE agent_id = ? AND tool = 'a2a-join-relay'`).get(AGENT)).toEqual({ n: 0 });
    });
  }
});

describe('t196 (A1.1) - the relay row says it was sent', () => {
  it('the owner view labels the relay row with who, which channel, when, and the request it answers', async () => {
    await boot();
    await delegate();
    await helperReplies('COMPLETE');
    await relayPiecesWhole(ASK, 'compile', null);
    const rows = getRecentMessages(AGENT, 100);
    const relay = rows.find((r) => r.role === 'assistant' && r.content.startsWith('Dojo: The helper'))!;
    expect(relay).toBeDefined();
    const label = labelRows(AGENT, rows).get(relay.id)!;
    expect(label).toMatch(/sent to TestUser on dashboard at [^;]+ by the engine as the result of the request of /);
    expect(label).toMatch(/TestUser has it\]$/);
    expect(label).not.toMatch(/result delivered later/);
  });
});
