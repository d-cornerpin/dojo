// THE ENGINE RELAYS A DELEGATED ANSWER TO THE OWNER ONCE. A join whose answer the engine already relayed (its row
// stamped with the delegating turn, so the settle once refused it) is settled on that relay by the pass that puts
// the answer back, and never relayed again; a join nothing was relayed for is put back to the agent once, however
// many passes run. Driven through the real boot re-drain over the real spine.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// Same measured reason as `join-closed-parent-reaper.test.ts`: the first clause in a file that
// imports `a2a-transport.js` pays the migration chain plus that module's whole import graph
// (~2.5 s settled), which expands past vitest's 5,000 ms default on a loaded machine.
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
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-join-relay-once-test', 'dojo.db'),
  };
});

const broadcast = vi.hoisted(() => vi.fn());
vi.mock('../../gateway/ws.js', () => ({ broadcast }));
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
import {
  openAsk, claimAsk, stampClaimingTurn, openDelegationJoin, landPiece, joinPieces,
  settlePieceWithoutResult,
} from '../../work/store.js';
import { resolveJoinsAtBoot } from '../a2a-transport.js';
import { FX, FXID } from '../../../../../deploy/checks/fixture-vocabulary.mjs';

const AGENT = FXID.n4;
const PEER = 'dupworker';
const CONV = 'conv-1';
const DELEGATING_TURN = 4039;
/** More passes than one: a guard that holds for one pass only is not an exactly-once guard. */
const PASSES = 6;

const workRow = (id: string): Record<string, unknown> =>
  mockDb.current!.prepare('SELECT * FROM work WHERE id = ?').get(id) as Record<string, unknown>;

/** Every relay the engine recorded for this join, in order. */
const relayRows = (joinId: string): Array<{ id: string; turn_number: number | null; created_at: string }> =>
  mockDb.current!.prepare(
    `SELECT id, turn_number, created_at FROM deliveries
       WHERE tool = 'a2a-join-relay' AND outcome = 'delivered' AND json_extract(payload_json, '$.joinId') = ?
       ORDER BY rowid`,
  ).all(joinId) as Array<{ id: string; turn_number: number | null; created_at: string }>;

/** What the OWNER can actually see on their own lane — the thing the duplicate answer is. */
const ownerFacing = (): Array<{ content: string; role: string }> =>
  mockDb.current!.prepare(
    `SELECT content, role FROM messages WHERE agent_id = ? AND role IN ('assistant','system')
        AND lane = 'owner' ORDER BY rowid`,
  ).all(AGENT) as Array<{ content: string; role: string }>;

const drive = async (): Promise<void> => {
  await resolveJoinsAtBoot();
};

const putBacks = (askId: string): number => (mockDb.current!.prepare(
  "SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = 'compile_resolved' AND json_extract(payload, '$.kind') IS NOT NULL",
).get(askId) as { n: number }).n;

/** The owner asks, a turn claims it and delegates, the pieces land with content: `compile_pending = 1`. */
function seedCompletedOnePieceJoin(
  msgId: string,
  opts: { conversationId?: string | null; children?: number; missingDeliverables?: number } = {},
): string {
  const db = mockDb.current!;
  const conversationId = opts.conversationId === undefined ? CONV : opts.conversationId;
  const children = opts.children ?? 1;
  const openedAt = Date.now() - 5 * 60_000;
  db.prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, channel, conversation_id, created_at, seq)
     VALUES (?, ?, 'user', 'ask DupWorker for the codeword and tell me', 'owner', 'dashboard', ?, ?, NULL)`,
  ).run(msgId, AGENT, conversationId, openedAt);
  const askId = openAsk({
    agentId: AGENT, messageId: msgId, conversationId, requesterId: 'owner',
    openedAt, title: 'get the codeword',
  });
  claimAsk(askId, AGENT);
  stampClaimingTurn(askId, DELEGATING_TURN);
  const kids = openDelegationJoin({
    parentWorkId: askId, agentId: AGENT, replyConversationId: conversationId,
    ttlAt: Date.now() + 60 * 60_000,
    threads: Array.from({ length: children }, (_, i) => ({
      threadId: `thread-${i}`, assigneeAgent: PEER, intent: 'ASSIGN' as const, hopCount: 0,
    })),
  });
  // `missingDeliverables` settles that many trailing pieces with no result; the join still completes.
  const missing = opts.missingDeliverables ?? 0;
  for (const [i, childId] of kids.entries()) {
    if (i >= children - missing) {
      settlePieceWithoutResult(childId, {
        to: 'abandoned', reason: 'the assignee never came back', actorId: PEER,
      });
      continue;
    }
    db.prepare(
      `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, outcome, created_at)
       VALUES (?, ?, NULL, 'send_to_agent', 'a2a', 'delivered', datetime('now'))`,
    ).run(`piece-d-${msgId}-${i}`, AGENT);
    landPiece(kids[i], {
      deliveryId: `piece-d-${msgId}-${i}`, content: `ECHO-PW8D-3${i}`, messageId: null, actorId: PEER,
    });
  }
  expect(joinPieces(askId).filter((p) => (p.content ?? '').trim().length > 0))
    .toHaveLength(children - missing);
  return askId;
}

/** The engine's first relay of this join, stamped with the delegating turn's number. */
function seedTheEnginesFirstRelay(askId: string, o: { turn?: number | null; conversationId?: string | null } = {}): string {
  const db = mockDb.current!;
  const messageId = `msg-relay-1-${askId}`;
  const conversationId = o.conversationId === undefined ? CONV : o.conversationId;
  db.prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, channel, conversation_id, display_kind, created_at, seq)
     VALUES (?, ?, 'assistant', 'Heard back from DupWorker: ECHO-PW8D-30', 'owner', 'dashboard', ?, 'agent-text', ?, NULL)`,
  ).run(messageId, AGENT, conversationId, Date.now());
  db.prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, message_id, outcome, payload_json, created_at)
     VALUES (?, ?, ?, 'a2a-join-relay', 'dashboard', ?, ?, 'delivered', ?, datetime('now', '+1 seconds'))`,
  ).run(
    `d-relay-1-${askId}`, AGENT, o.turn === undefined ? DELEGATING_TURN : o.turn,
    conversationId, messageId, JSON.stringify({ joinId: askId }),
  );
  return `d-relay-1-${askId}`;
}

beforeEach(() => {
  broadcast.mockClear();
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES
       (?, '${FX.n4}', 'idle', '1970-01-01'), (?, 'DupWorker', 'idle', '1970-01-01')`,
  ).run(AGENT, PEER);
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, counterparty_id)
     VALUES (?, ?, 'dashboard', 'owner')`,
  ).run(CONV, AGENT);
});

describe('the engine relays one delegated answer to the owner ONCE', () => {
  it('a join already relayed is settled on that relay, and nothing is relayed or put back again', async () => {
    const askId = seedCompletedOnePieceJoin('m-1');
    const first = seedTheEnginesFirstRelay(askId);
    expect(workRow(askId).compile_pending, 'premise: the join is compile-pending').toBe(1);

    for (let i = 0; i < PASSES; i++) await drive();

    expect(relayRows(askId).map((r) => r.id)).toEqual([first]);
    expect(ownerFacing().filter((m) => /ECHO-PW8D-30/.test(m.content))).toHaveLength(1);
    const row = workRow(askId);
    expect([row.state, row.result_delivery_id, row.compile_pending]).toEqual(['done', first, 0]);
    expect(putBacks(askId)).toBe(0);
  });

  it('an ask with no conversation row is settled on the relay already sent too', async () => {
    const askId = seedCompletedOnePieceJoin('m-1', { conversationId: null });
    const first = seedTheEnginesFirstRelay(askId, { conversationId: null });

    for (let i = 0; i < PASSES; i++) await drive();

    expect(relayRows(askId).map((r) => r.id)).toEqual([first]);
    expect([workRow(askId).state, workRow(askId).result_delivery_id]).toEqual(['done', first]);
  });
});

describe('PRESERVED: an answer nothing was relayed for goes back to the agent, once', () => {
  it('a two-piece join is put back once over many passes, and nothing is sent in the agent\'s place', async () => {
    const askId = seedCompletedOnePieceJoin('m-1', { children: 2 });

    for (let i = 0; i < PASSES; i++) await drive();

    expect(putBacks(askId)).toBe(1);
    expect(relayRows(askId)).toHaveLength(0);
    expect(workRow(askId).compile_pending).toBe(0);
  });

  it('a relay recorded for ANOTHER join does not settle this one', async () => {
    const other = seedCompletedOnePieceJoin('m-other', { children: 2 });
    seedTheEnginesFirstRelay(other);
    const askId = seedCompletedOnePieceJoin('m-1', { children: 2 });

    for (let i = 0; i < PASSES; i++) await drive();

    expect(putBacks(askId)).toBe(1);
    expect(workRow(askId).state).not.toBe('done');
  });
});
