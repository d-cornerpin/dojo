// 981: one failing deferred join relay must not drop the others waiting behind it.
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
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-981-deferred-relays', 'dojo.db'),
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
const failFor = vi.hoisted(() => ({ joinId: null as string | null }));
vi.mock('../../work/ask-settlement.js', async (orig) => {
  const real = await orig<typeof import('../../work/ask-settlement.js')>();
  return {
    ...real,
    priorEngineJoinRelay: (joinId: string) => {
      if (joinId === failFor.joinId) throw new Error('simulated database error');
      return real.priorEngineJoinRelay(joinId);
    },
  };
});
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: vi.fn(async () => {}) }) }));

import { runMigrations } from '../../db/migrations.js';
import {
  openAsk, claimAsk, stampClaimingTurn, openDelegationJoin, landPiece, joinPieces,
  settlePieceWithoutResult,
} from '../../work/store.js';
import { releaseDeferredJoinRelays } from '../a2a-transport.js';
import { deferJoinRelay } from '../deferred-join-relay.js';
import { FX, FXID } from '../../../../../deploy/checks/fixture-vocabulary.mjs';

const AGENT = FXID.n4;
const PEER = 'dupworker';
const CONV = 'conv-1';
const DELEGATING_TURN = 4039;
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

/**
 * The measured shape, built through the product's own calls: the owner asks, a turn claims it,
 * the turn delegates ONE piece, the peer answers, and the piece lands with real content — which
 * is the state that sets `compile_pending = 1`.
 *
 * `askAgeSeconds` is past `COMPILE_GRACE_SECONDS` (60) on purpose: the grace is what put 52 s
 * between the two live deliveries, and a test that never spends it would never reach the rung
 * that speaks twice.
 */
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
  // UX-REPAIR ROUND 12 T48 note: `missingDeliverables` settles that many trailing pieces with
  // NO result. The join still completes (the countdown reaches zero either way), but a
  // deliverable is missing — which is the population that still walks the full grind-vs-tell
  // ladder. Without it, an all-landed multi-piece join now leaves at the engine-relay rung.
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


beforeEach(() => {
  broadcast.mockClear();
  failFor.joinId = null;
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

describe('981 — deferred join relays survive one failure', () => {
  it('a throw on the first join still relays the second', async () => {
    const first = seedCompletedOnePieceJoin('m-1');
    const second = seedCompletedOnePieceJoin('m-2');
    failFor.joinId = first;
    deferJoinRelay(AGENT, first);
    deferJoinRelay(AGENT, second);

    await expect(releaseDeferredJoinRelays(AGENT)).resolves.toBeUndefined();

    expect(relayRows(first)).toHaveLength(0);
    expect(relayRows(second)).toHaveLength(1);
    expect(workRow(second).state).toBe('done');
  });
});
