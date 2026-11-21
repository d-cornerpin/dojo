// A fan-out with one helper whose work stopped settles when its last piece does: what arrived goes back to the agent
// to answer in its own words, the stopped helper marked as never answering, and no Dojo notice reaches the person.
// With nothing back at all, the person gets the one "no answer" notice.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

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
import { sweepExpiredJoins } from '../a2a-transport.js';

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

const putBack = (parent: string): string | null => (mockDb.current!.prepare(
  "SELECT json_extract(payload, '$.kind') AS k FROM work_events WHERE work_id = ? AND kind = 'compile_resolved' ORDER BY id DESC LIMIT 1",
).get(parent) as { k: string } | undefined)?.k ?? null;
const pieceStates = (parent: string): string[] => (mockDb.current!.prepare('SELECT state FROM work WHERE parent_id = ? ORDER BY opened_at, id')
  .all(parent) as Array<{ state: string }>).map((r) => r.state);

describe('a fan-out with one stopped helper answers with what arrived', () => {
  it('one piece landed, one helper idle with nothing coming: the agent gets what arrived, the person no notice', async () => {
    const parent = seedLiveFanOut();
    landPiece(findJoinChildByThread(AGENT, T1)!.id, { deliveryId: seedDelivery('d-1'), content: 'The sum is 72.', messageId: null });
    expect((await sweep()).failedClosed).toBe(0);
    expect([putBack(parent), pieceStates(parent), ownerFacing()]).toEqual(['compile', ['done', 'abandoned'], []]);
  });

  it('a piece that came back FAILED with a reason counts as arrived', async () => {
    const parent = seedLiveFanOut(true);
    landPiece(findJoinChildByThread(AGENT, T1)!.id, { deliveryId: seedDelivery('d-1'), content: 'The sum is 72.', messageId: null });
    settlePieceWithoutResult(findJoinChildByThread(AGENT, T2)!.id, {
      to: 'failed', reason: 'the peer replied FAIL', content: 'I could not write the story: no model was free.', actorId: 'slowhelper',
    });
    await sweep();
    expect([putBack(parent), pieceStates(parent), ownerFacing()]).toEqual(['compile', ['done', 'failed', 'abandoned'], []]);
  });

  it('nothing back: the one fail-closed notice', async () => {
    seedLiveFanOut();
    await sweep();
    const msgs = ownerFacing();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toMatch(/nothing came back from any of them/i);
  });
});
