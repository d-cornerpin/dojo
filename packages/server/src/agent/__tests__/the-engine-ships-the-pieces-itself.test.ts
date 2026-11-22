// WHEN THE AGENT DOES NOT ANSWER, THE ENGINE SHIPS THE PIECES ITSELF, ONCE AND WHOLE.
// The pieces came back and the request went back to the agent; the turn serving it was shown them and said
// nothing, its required reply empty too, so A stands the request down. From that one place the Dojo relays
// every piece whole under one preface line of its own, and the request closes on that delivery. Driven through
// the real boot re-drain (the put-back) and the real turn finalize (the stand-down) over the real spine.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// Same measured reason as `join-relay-exactly-once.test.ts`: the first clause in a file that
// imports `a2a-transport.js` pays the migration chain plus that module's whole import graph.
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
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-engine-ships-pieces-test', 'dojo.db'),
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
  openAsk, claimAsk, stampClaimingTurn, openDelegationJoin, landPiece,
  settlePieceWithoutResult,
} from '../../work/store.js';
import { engineRelayPreface } from '../../work/join-drive.js';
import { resolveJoinsAtBoot } from '../a2a-transport.js';
import { newestPutBack, recordPiecesShown, settleAsksAtTurnFinalize } from '../../work/ask-settlement.js';
import { turnRow } from '../v2/__tests__/helpers/live-turn.js';
import { FX, FXID } from '../../../../../deploy/checks/fixture-vocabulary.mjs';

const AGENT = FXID.n4;
const PEER_A = FXID.n5;
const PEER_B = 'kayla';
const CONV = 'conv-1';
const DELEGATING_TURN = 4900;

/** The two research streams S5 delegated, kept long enough that a 600-char truncation shows. */
const PIECE_A = `# Dog-friendly lunch spots\n\n1. The Patio — dogs on the terrace, water bowls.\n2. Harbour Grill — leashed dogs welcome.\n\n${'A'.repeat(900)}\n\nSources: three local listings.`;
const PIECE_B = `## Best route there\n\nTake the coast road; 1h40m without traffic.\n\n${'B'.repeat(900)}\n\nReturn leg: allow an extra 25 minutes after 4pm.`;

const workRow = (id: string): Record<string, unknown> =>
  mockDb.current!.prepare('SELECT * FROM work WHERE id = ?').get(id) as Record<string, unknown>;

const relayRows = (joinId: string): Array<{ id: string; tool: string }> =>
  mockDb.current!.prepare(
    `SELECT id, tool FROM deliveries WHERE outcome = 'delivered' AND json_extract(payload_json, '$.joinId') = ? ORDER BY rowid`,
  ).all(joinId) as Array<{ id: string; tool: string }>;

/** What the OWNER can actually see on their own lane. */
const ownerFacing = (): Array<{ content: string; role: string }> =>
  mockDb.current!.prepare(
    `SELECT content, role FROM messages WHERE agent_id = ? AND role IN ('assistant','system')
        AND lane = 'owner' ORDER BY rowid`,
  ).all(AGENT) as Array<{ content: string; role: string }>;

/** The answer goes back; the next turn serving the request is shown it and stays silent, its required reply too. */
async function agentStaysSilent(askId: string, turn = DELEGATING_TURN + 1): Promise<void> {
  await resolveJoinsAtBoot();
  settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: DELEGATING_TURN });   // the delegating turn ends
  turnRow(AGENT, turn, null);
  claimAsk(askId, AGENT);
  stampClaimingTurn(askId, turn);
  recordPiecesShown(askId, AGENT, turn, newestPutBack(askId)!.id);
  settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: turn, forcedEmpty: true });
  await vi.dynamicImportSettled();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

/**
 * The measured S5 shape, built through the product's own calls: the owner asks, a turn claims
 * it, the turn delegates TWO research streams, both peers answer with real deliverables, and
 * both pieces land with content — which is the state that sets `compile_pending = 1`.
 */
function seedTwoPieceJoin(msgId = 'm-1', opts: { landB?: boolean } = {}): string {
  const db = mockDb.current!;
  const openedAt = Date.now() - 20 * 60_000;
  db.prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, channel, conversation_id, created_at, seq)
     VALUES (?, ?, 'user', 'plan the trip: lunch spots and the drive', 'owner', 'dashboard', ?, ?, NULL)`,
  ).run(msgId, AGENT, CONV, openedAt);
  const askId = openAsk({
    agentId: AGENT, messageId: msgId, conversationId: CONV, requesterId: 'owner',
    openedAt, title: 'plan the trip',
  });
  turnRow(AGENT, DELEGATING_TURN, { kind: 'ask', id: msgId });
  claimAsk(askId, AGENT);
  stampClaimingTurn(askId, DELEGATING_TURN);
  const kids = openDelegationJoin({
    parentWorkId: askId, agentId: AGENT, replyConversationId: CONV,
    ttlAt: Date.now() + 60 * 60_000,
    threads: [
      { threadId: 'thread-a', assigneeAgent: PEER_A, intent: 'ASSIGN' as const, hopCount: 0 },
      { threadId: 'thread-b', assigneeAgent: PEER_B, intent: 'ASSIGN' as const, hopCount: 0 },
    ],
  });
  for (const [i] of kids.entries()) {
    db.prepare(
      `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, outcome, created_at)
       VALUES (?, ?, NULL, 'send_to_agent', 'a2a', 'delivered', datetime('now'))`,
    ).run(`piece-d-${msgId}-${i}`, AGENT);
  }
  landPiece(kids[0], { deliveryId: `piece-d-${msgId}-0`, content: PIECE_A, messageId: null, actorId: PEER_A });
  if (opts.landB === false) {
    // A piece that settled with NO result: the join completes, but a deliverable is missing.
    settlePieceWithoutResult(kids[1], { to: 'abandoned', reason: 'the assignee never came back', actorId: PEER_B });
  } else {
    landPiece(kids[1], { deliveryId: `piece-d-${msgId}-1`, content: PIECE_B, messageId: null, actorId: PEER_B });
  }
  expect(workRow(askId).compile_pending, 'premise: the join completed and a compile is owed').toBe(1);
  return askId;
}

beforeEach(() => {
  broadcast.mockClear();
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES
       (?, '${FX.n4}', 'idle', '1970-01-01'), (?, '${FX.n5}', 'idle', '1970-01-01'), (?, 'Kayla', 'idle', '1970-01-01')`,
  ).run(AGENT, PEER_A, PEER_B);
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES (?, ?, 'dashboard', 'owner')`,
  ).run(CONV, AGENT);
});

describe('a silent agent ends in the whole answer relayed once', () => {
  it('the pieces reach the owner lane whole, under the one preface line, and the request closes on that delivery', async () => {
    const askId = seedTwoPieceJoin();
    await agentStaysSilent(askId);

    const relayed = ownerFacing().find((m) => m.content.includes(engineRelayPreface(2)));
    expect(relayed, 'the owner lane carries the engine relay').toBeTruthy();
    expect(relayed!.content).toContain(PIECE_A);
    expect(relayed!.content).toContain(PIECE_B);
    expect(relayed!.content.startsWith(`Dojo: ${engineRelayPreface(2)}`)).toBe(true);
    expect(relayed!.role).toBe('assistant');
    const row = workRow(askId);
    const relays = relayRows(askId);
    expect(relays).toHaveLength(1);
    expect([row.state, row.result_delivery_id, row.compile_pending]).toEqual(['done', relays[0].id, 0]);
    const settled = mockDb.current!.prepare(
      `SELECT json_extract(payload, '$.basis') AS basis FROM work_events WHERE work_id = ? AND kind = 'compile_resolved' AND json_extract(payload, '$.basis') IS NOT NULL`,
    ).all(askId);
    expect(settled).toEqual([{ basis: 'engine-relay' }]);
    expect(mockDb.current!.prepare("SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = 'floor_ghosted'").get(askId), 'no stood-down card').toEqual({ n: 0 });
  });

  it('later passes send nothing more and put nothing back', async () => {
    const askId = seedTwoPieceJoin();
    await agentStaysSilent(askId);
    for (let i = 0; i < 4; i++) await resolveJoinsAtBoot();
    expect(relayRows(askId)).toHaveLength(1);
    expect(workRow(askId).state).toBe('done');
  });

  it('a request more than a day old, or from before a New Session, is relayed at once instead of put back', async () => {
    const old = seedTwoPieceJoin('m-old');
    mockDb.current!.prepare('UPDATE work SET opened_at = ? WHERE id = ?').run(Date.now() - 25 * 3_600_000, old);
    await resolveJoinsAtBoot();
    await vi.dynamicImportSettled();
    expect([relayRows(old).length, newestPutBack(old)]).toEqual([1, null]);
    const before = seedTwoPieceJoin('m-before');
    mockDb.current!.prepare("UPDATE agents SET session_started_at = datetime('now', '+1 minute') WHERE id = ?").run(AGENT);
    await resolveJoinsAtBoot();
    await vi.dynamicImportSettled();
    expect([relayRows(before).length, newestPutBack(before)]).toEqual([1, null]);
  });

  it('a piece that came back with nothing is named, and what did arrive goes whole', async () => {
    const askId = seedTwoPieceJoin('m-1', { landB: false });
    await agentStaysSilent(askId);
    const relayed = ownerFacing().find((m) => m.content.includes(engineRelayPreface(2)))!;
    expect(relayed.content).toContain(PIECE_A);
    expect(relayed.content).toMatch(/\(it never answered\)/);
  });
});
