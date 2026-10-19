// ════════════════════════════════════════════════════════════════════════════════════════
// t239 (item 4) — THE LIVE-PARENT TIMEOUT NOTICE USES THE ONE LANDED-CONTENT COMPOSER.
//
// A fan-out whose parent ask is still open and whose deadline passes with one piece landed and
// one never answered used to tell the owner a single bare failure sentence: it relayed NONE of
// what had landed, and it counted a piece that came back with real content as "replied with
// nothing usable". The closed-parent arm already had the honest shape (say what arrived, name
// only who did not). There is now ONE composer for both arms: landed pieces are relayed, only
// the missing piece is named missing.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { isOwnerAlertSystemNote } from '@dojo/shared';

vi.setConfig({ testTimeout: 15_000 });

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t239-live-parent-notice', 'dojo.db'),
  };
});
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  setLogLevel: () => {}, setLogBroadcast: () => {}, readLogEntries: () => [],
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../memory/embeddings.js', () => ({
  generateEmbedding: vi.fn(async () => new Float32Array(8)),
  queueEmbedding: vi.fn(),
}));
vi.mock('../../config/platform.js', () => ({
  isPrimaryAgent: () => false, isPMAgent: () => false, isHealerAgent: () => false,
  isDreamerAgent: () => false, getOwnerName: () => 'Owner', getPrimaryAgentId: () => 'primary',
}));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: vi.fn(async () => {}) }) }));

import { runMigrations } from '../../db/migrations.js';
import { openAsk, claimAsk, openDelegationJoin, findJoinChildByThread, landPiece, settlePieceWithoutResult } from '../../work/store.js';

const AGENT = 'mainagent';
const T1 = 'thread-aaaaaaaa-1111';
const T2 = 'thread-bbbbbbbb-2222';
const T3 = 'thread-cccccccc-3333';

const ownerFacing = (): Array<{ content: string; role: string }> =>
  mockDb.current!.prepare(
    `SELECT content, role FROM messages WHERE agent_id = ? AND role IN ('assistant','system') AND lane = 'owner' ORDER BY rowid`,
  ).all(AGENT) as Array<{ content: string; role: string }>;

function seedDelivery(id: string): string {
  mockDb.current!.prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, outcome)
     VALUES (?, ?, 7, 'send_to_agent', 'a2a', NULL, 'delivered')`,
  ).run(id, AGENT);
  return id;
}

/** A LIVE parent (the ask is still open) whose fan-out deadline has passed. */
function seedLiveFanOut(threeWay = false): string {
  const db = mockDb.current!;
  db.prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, channel, conversation_id, created_at, seq)
     VALUES ('m-live', ?, 'user', 'get the sum and a story', 'owner', 'dashboard', 'conv-1', ?, NULL)`,
  ).run(AGENT, Date.now() - 120 * 60_000);
  const parent = openAsk({
    agentId: AGENT, messageId: 'm-live', conversationId: 'conv-1', requesterId: 'owner',
    openedAt: Date.now() - 120 * 60_000, title: 'sum and story',
  });
  claimAsk(parent, AGENT);
  openDelegationJoin({
    parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-1',
    ttlAt: Date.now() - 60 * 60_000,
    threads: [
      { threadId: T1, assigneeAgent: 'fasthelper' }, { threadId: T2, assigneeAgent: 'slowhelper' },
      ...(threeWay ? [{ threadId: T3, assigneeAgent: 'thirdhelper' }] : []),
    ],
  });
  return parent;
}

async function sweep(): Promise<{ failedClosed: number }> {
  const { sweepExpiredJoins } = await import('../a2a-transport.js');
  return sweepExpiredJoins();
}

beforeEach(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES
       (?, 'Main', 'idle', '1970-01-01'), ('fasthelper', 'Fast', 'idle', '1970-01-01'),
       ('slowhelper', 'Slow', 'idle', '1970-01-01'), ('thirdhelper', 'Third', 'idle', '1970-01-01')`,
  ).run(AGENT);
  db.prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES ('conv-1', ?, 'dashboard', 'owner')`).run(AGENT);
});

describe('t239 item 4 — the live-parent timeout notice relays what landed and names only what is missing', () => {
  it('RED→GREEN: one piece landed with real content, one never answered', async () => {
    seedLiveFanOut();
    landPiece(findJoinChildByThread(AGENT, T1)!.id, {
      deliveryId: seedDelivery('d-1'), content: 'The sum is 72.', messageId: null,
    });

    const r = await sweep();

    expect(r.failedClosed).toBe(1);
    const msgs = ownerFacing();
    expect(msgs).toHaveLength(1);
    const text = msgs[0].content;
    expect(text, 'what DID arrive is relayed').toContain('The sum is 72.');
    expect(text, 'who did not come back is named').toContain('Slow');
    expect(text, 'and the one that DID is not named as missing').not.toMatch(/Fast[^.]*never/i);
    expect(text, 'a piece with real content is never "nothing usable"').not.toMatch(/nothing usable|no usable answer/i);
    expect(msgs[0].role).toBe('system');
    expect(isOwnerAlertSystemNote(text)).toBe(true);
  });

  it('a piece that came back FAILED with a reason is relayed as arrived too, and is not named missing', async () => {
    seedLiveFanOut(true);
    landPiece(findJoinChildByThread(AGENT, T1)!.id, {
      deliveryId: seedDelivery('d-1'), content: 'The sum is 72.', messageId: null,
    });
    settlePieceWithoutResult(findJoinChildByThread(AGENT, T2)!.id, {
      to: 'failed', reason: 'the peer replied FAIL', content: 'I could not write the story: no model was free.', actorId: 'slowhelper',
    });
    await sweep();
    const msgs = ownerFacing();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain('The sum is 72.');
    expect(msgs[0].content).toContain('no model was free');
    expect(msgs[0].content).toContain('Third');
    expect(msgs[0].content).not.toMatch(/Slow[^.]*never came back/i);
  });

  it('CONTROL: nothing landed keeps the existing fail-closed sentence (one composer, same words)', async () => {
    seedLiveFanOut();
    await sweep();
    const msgs = ownerFacing();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toMatch(/none of them answered/i);
  });
});
