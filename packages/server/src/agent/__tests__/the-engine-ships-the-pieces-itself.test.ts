// UX-REPAIR ROUND 12 / T48 — AFTER THE REDRIVES, THE ENGINE SHIPS THE PIECES ITSELF.
//
// ── THE DEFECT, MEASURED (round-12 S5, `round12/S5-catalog.md` §8.5–§8.8) ──
// Three redrive steers each said "Do NOT search, open files, run commands, or call any tools
// first"; the model called `load_tool_docs`, `history_search`, `history_get`, `work_update`
// (errored ×2) and `history_get` across 12m26s and never compiled. The ladder's next rung was
// the STUCK NOTICE — the engine asking the agent to tell the owner the job could not be
// finished — while both finished deliverables sat in the join's landed pieces, in the engine's
// own hands. `work/join-drive.ts:146-162` is where that ordering lived.
//
// ── THE SOLVE, AND ITS PRECEDENT ──
// `resolveCompletedJoin`'s ONE-PIECE branch already relays: "the ENGINE relays the answer to
// the owner itself", with the ask closing on that delivery. T48 gives the MULTI-piece case the
// same door, one rung earlier than the old end-of-ladder relay, and only when every piece
// landed with content. The engine composes NO prose beyond one preface line; the pieces go
// VERBATIM.
//
// This file drives the REAL `resolveCompilePendingJoins` over the real spine and reads what
// reached the owner's own lane.

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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-engine-ships-pieces-test', 'dojo.db'),
  };
});

const broadcast = vi.fn();
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
import { joinDeliveryDetail } from '../../work/ask-settlement.js';
import {
  JOIN_REDRIVE_BOUND, STUCK_NOTICE_RETRY_BOUND, engineRelayPreface,
} from '../../work/join-drive.js';

const AGENT = 'kevin';
const PEER_A = 'kelly';
const PEER_B = 'kayla';
const CONV = 'conv-1';
const DELEGATING_TURN = 4900;

/** Every rung the ladder has, plus slack — a guard that only holds for one extra sweep is not
 *  a guard. */
const PASSES_TO_EXHAUST_THE_LADDER = JOIN_REDRIVE_BOUND + STUCK_NOTICE_RETRY_BOUND + 3;

/** The two research streams S5 delegated, kept long enough that a 600-char truncation shows. */
const PIECE_A = `# Dog-friendly lunch spots\n\n1. The Patio — dogs on the terrace, water bowls.\n2. Harbour Grill — leashed dogs welcome.\n\n${'A'.repeat(900)}\n\nSources: three local listings.`;
const PIECE_B = `## Best route there\n\nTake the coast road; 1h40m without traffic.\n\n${'B'.repeat(900)}\n\nReturn leg: allow an extra 25 minutes after 4pm.`;

const workRow = (id: string): Record<string, unknown> =>
  mockDb.current!.prepare('SELECT * FROM work WHERE id = ?').get(id) as Record<string, unknown>;

const relayRows = (joinId: string): Array<{ id: string; tool: string }> =>
  mockDb.current!.prepare(
    `SELECT id, tool FROM deliveries WHERE outcome = 'delivered' AND detail LIKE ? ORDER BY rowid`,
  ).all(`%${joinDeliveryDetail(joinId)}%`) as Array<{ id: string; tool: string }>;

/** What the OWNER can actually see on their own lane. */
const ownerFacing = (): Array<{ content: string; role: string }> =>
  mockDb.current!.prepare(
    `SELECT content, role FROM messages WHERE agent_id = ? AND role IN ('assistant','system')
        AND lane = 'owner' ORDER BY rowid`,
  ).all(AGENT) as Array<{ content: string; role: string }>;

const auditEntries = (workId: string): string[] =>
  (mockDb.current!.prepare(
    `SELECT payload FROM work_events WHERE work_id = ? AND kind = 'audit' ORDER BY id`,
  ).all(workId) as Array<{ payload: string }>)
    .map((r) => (JSON.parse(r.payload) as { entry_kind: string }).entry_kind);

/** Every engine steer the ladder wrote for this agent. They ride the message store on the
 *  EVENTS & NOTICES lane (`memory/message-store.ts:engineRow`), not the owner's. The stuck
 *  notice is one of these. */
const engineSteers = (): string[] =>
  (mockDb.current!.prepare(
    `SELECT content FROM messages WHERE agent_id = ? AND lane = 'events' ORDER BY rowid`,
  ).all(AGENT) as Array<{ content: string }>).map((r) => r.content);

const drive = async (): Promise<void> => {
  const { resolveCompilePendingJoins } = await import('../a2a-transport.js');
  await resolveCompilePendingJoins(AGENT);
};

/**
 * Drive until the redrive rung is genuinely SPENT, never a fixed pass count.
 *
 * T10's rule is why: a pass that lands on a turn a rung was already spent on records
 * `join_redrive_deferred` and does NOT spend, so "three passes" and "three drives" are
 * different numbers. Counting the rung the ladder actually recorded is the only reading that
 * cannot go quiet if that rule changes shape.
 */
async function driveUntilTheRedrivesAreSpent(askId: string): Promise<void> {
  for (let i = 0; i < PASSES_TO_EXHAUST_THE_LADDER; i++) {
    if (auditEntries(askId).filter((e) => e === 'join_redrive').length >= JOIN_REDRIVE_BOUND) return;
    await drive();
  }
  throw new Error('the redrive rung never spent out inside the ladder\'s own pass budget');
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
       (?, 'Kevin', 'idle', '1970-01-01'), (?, 'Kelly', 'idle', '1970-01-01'), (?, 'Kayla', 'idle', '1970-01-01')`,
  ).run(AGENT, PEER_A, PEER_B);
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES (?, ?, 'dashboard', 'owner')`,
  ).run(CONV, AGENT);
});

// ════════════════════════════════════════════════════════════════════════════════
// THE RUNG ITSELF.
// ════════════════════════════════════════════════════════════════════════════════

describe('T48: at redrive exhaustion with every piece back, the engine ships them', () => {
  it('THE MEASURED SHAPE: after the redrives the NEXT rung is the relay, not the stuck notice', async () => {
    const askId = seedTwoPieceJoin();

    await driveUntilTheRedrivesAreSpent(askId);
    expect(auditEntries(askId).filter((e) => e === 'join_redrive')).toHaveLength(JOIN_REDRIVE_BOUND);
    expect(relayRows(askId), 'premise: nothing has reached the owner yet').toHaveLength(0);

    await drive();

    expect(auditEntries(askId)).toContain('join_engine_relay');
    expect(auditEntries(askId), 'the owner is never told the job is stuck when the engine holds the answer')
      .not.toContain('join_stuck_notice');
  });

  it('the pieces reach the OWNER LANE in full, verbatim, under the one preface line', async () => {
    const askId = seedTwoPieceJoin();
    await driveUntilTheRedrivesAreSpent(askId);
    await drive();

    const relayed = ownerFacing().find((m) => m.content.includes(engineRelayPreface(2)));
    expect(relayed, 'the owner lane carries the engine relay').toBeTruthy();
    // VERBATIM: the whole piece, not a 600-char summary of it, and the engine adds no words.
    expect(relayed!.content).toContain(PIECE_A);
    expect(relayed!.content).toContain(PIECE_B);
    expect(relayed!.content.startsWith(engineRelayPreface(2))).toBe(true);
    // 0 prefix bytes on the owner-delivery lane.
    expect(relayed!.content.startsWith('[')).toBe(false);
    expect(relayed!.role).toBe('assistant');
  });

  it('the ask CLOSES on that delivery — `done`, the relay as its receipt, `compile_resolved` '
    + 'with basis `engine-relay`', async () => {
    const askId = seedTwoPieceJoin();
    await driveUntilTheRedrivesAreSpent(askId);
    await drive();

    const row = workRow(askId);
    expect(row.state).toBe('done');
    expect(row.compile_pending).toBe(0);
    const relays = relayRows(askId);
    expect(relays).toHaveLength(1);
    expect(row.result_delivery_id).toBe(relays[0].id);
    const resolved = mockDb.current!.prepare(
      `SELECT payload FROM work_events WHERE work_id = ? AND kind = 'compile_resolved' ORDER BY id`,
    ).all(askId) as Array<{ payload: string }>;
    expect(resolved).toHaveLength(1);
    expect((JSON.parse(resolved[0].payload) as { basis: string }).basis).toBe('engine-relay');
  });

  it('THE LADDER ENDS THERE: further passes spend no rung, send nothing, and never reach the '
    + 'platform-trouble surface', async () => {
    const askId = seedTwoPieceJoin();
    for (let i = 0; i < PASSES_TO_EXHAUST_THE_LADDER; i++) await drive();

    expect(relayRows(askId), 'exactly one telling').toHaveLength(1);
    expect(auditEntries(askId).filter((e) => e === 'join_engine_relay')).toHaveLength(1);
    expect(auditEntries(askId)).not.toContain('join_stuck_notice');
    expect(auditEntries(askId)).not.toContain('join_drive_ghosted');
    const ghosts = mockDb.current!.prepare(
      `SELECT COUNT(*) n FROM work_events WHERE work_id = ? AND kind = 'floor_ghosted'`,
    ).get(askId) as { n: number };
    expect(ghosts.n).toBe(0);
  });

  it('NO DOUBLE ANSWER: a model compose that lands AFTER the relay finds no owed ask behind it', async () => {
    const askId = seedTwoPieceJoin();
    await driveUntilTheRedrivesAreSpent(askId);
    await drive();
    expect(workRow(askId).state).toBe('done');
    const receipt = workRow(askId).result_delivery_id;

    // The model finally composes, three minutes late. The ask is already closed on the relay
    // the owner actually got: nothing re-opens, nothing is re-settled, no second relay goes out.
    mockDb.current!.prepare(
      `INSERT INTO messages (id, agent_id, role, content, lane, channel, conversation_id, display_kind, created_at, seq)
       VALUES ('msg-late-compose', ?, 'assistant', 'Here is the combined plan…', 'owner', 'dashboard', ?, 'agent-text', ?, NULL)`,
    ).run(AGENT, CONV, Date.now());
    for (let i = 0; i < 3; i++) await drive();

    expect(relayRows(askId)).toHaveLength(1);
    expect(workRow(askId).result_delivery_id).toBe(receipt);
    expect(workRow(askId).state).toBe('done');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// THE CONTROLS. The rung is an INSERTION: everything either side of it is unchanged.
// ════════════════════════════════════════════════════════════════════════════════

describe('T48 CONTROL: a join still missing a deliverable walks the OLD rungs', () => {
  it('stuck-notice then platform-trouble, each on its own bound, and no engine relay rung', async () => {
    const askId = seedTwoPieceJoin('m-1', { landB: false });

    for (let i = 0; i < PASSES_TO_EXHAUST_THE_LADDER; i++) await drive();

    const audits = auditEntries(askId);
    expect(audits.filter((a) => a === 'join_redrive')).toHaveLength(JOIN_REDRIVE_BOUND);
    expect(audits.filter((a) => a === 'join_stuck_notice')).toHaveLength(STUCK_NOTICE_RETRY_BOUND);
    expect(audits.filter((a) => a === 'join_drive_ghosted')).toHaveLength(1);
    expect(audits, 'the relay rung never fires for a join that is missing a piece')
      .not.toContain('join_engine_relay');
  });

  it('…and the stuck notice the agent is asked to deliver is UNCHANGED', async () => {
    seedTwoPieceJoin('m-1', { landB: false });
    for (let i = 0; i < PASSES_TO_EXHAUST_THE_LADDER; i++) await drive();

    const stuck = engineSteers().find((s) => s.includes('TELL THE OWNER NOW'));
    expect(stuck, 'the ladder still asks the agent to speak for a job that is genuinely stuck').toBeTruthy();
    expect(stuck).toContain('1 of 2 delegated piece(s) came back.');
  });

  it('…and the end-of-ladder relay still ships what DID come back', async () => {
    const askId = seedTwoPieceJoin('m-1', { landB: false });
    for (let i = 0; i < PASSES_TO_EXHAUST_THE_LADDER; i++) await drive();

    expect(ownerFacing().some((m) => /All the delegated pieces are back/.test(m.content))).toBe(true);
    expect(workRow(askId).state).toBe('done');
  });
});

describe('T48 CONTROL: the ONE-PIECE relay is byte-identical', () => {
  /** The one-piece world belongs to `resolveCompletedJoin`'s own branch (D13's relay), and the
   *  rung is fenced off it by the SAME split the compile path already uses: one piece relays,
   *  more than one compiles. This seeds the ladder-visible half of that world — a one-piece
   *  join whose settle was refused, the `bmshcidpw8d` shape — and asserts the rung stays out. */
  function seedOnePieceJoin(): string {
    const db = mockDb.current!;
    const openedAt = Date.now() - 20 * 60_000;
    db.prepare(
      `INSERT INTO messages (id, agent_id, role, content, lane, channel, conversation_id, created_at, seq)
       VALUES ('m-solo', ?, 'user', 'ask kelly for the codeword', 'owner', 'dashboard', ?, ?, NULL)`,
    ).run(AGENT, CONV, openedAt);
    const askId = openAsk({
      agentId: AGENT, messageId: 'm-solo', conversationId: CONV, requesterId: 'owner',
      openedAt, title: 'the codeword',
    });
    claimAsk(askId, AGENT);
    stampClaimingTurn(askId, DELEGATING_TURN);
    const kids = openDelegationJoin({
      parentWorkId: askId, agentId: AGENT, replyConversationId: CONV,
      ttlAt: Date.now() + 60 * 60_000,
      threads: [{ threadId: 'thread-solo', assigneeAgent: PEER_A, intent: 'ASSIGN' as const, hopCount: 0 }],
    });
    db.prepare(
      `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, outcome, created_at)
       VALUES ('piece-d-solo', ?, NULL, 'send_to_agent', 'a2a', 'delivered', datetime('now'))`,
    ).run(AGENT);
    landPiece(kids[0], { deliveryId: 'piece-d-solo', content: 'ECHO-S5', messageId: null, actorId: PEER_A });
    expect(joinPieces(askId)).toHaveLength(1);
    return askId;
  }

  it('the rung never fires on a one-piece join, and the end-of-ladder relay keeps its own words', async () => {
    const askId = seedOnePieceJoin();

    for (let i = 0; i < PASSES_TO_EXHAUST_THE_LADDER; i++) await drive();

    expect(auditEntries(askId), 'one piece is D13\'s relay, not this rung').not.toContain('join_engine_relay');
    expect(ownerFacing().some((m) => /All the delegated pieces are back/.test(m.content))).toBe(true);
    expect(ownerFacing().some((m) => m.content.includes('results are in as delivered by the helpers'))).toBe(false);
  });
});
