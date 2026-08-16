// SWEEP-A TB13 — THE ENGINE RELAYS A DELEGATED ANSWER TO THE OWNER **ONCE**.
//
// ── THE DEFECT, MEASURED, NOT REASONED ABOUT ──────────────────────────────────────────────
// Battery `bmshcidpw8d` (2026-08-06), scenario `delegation-duplicate-reconciled`, clause (c)
// — `engine relayed at most once=false (2 join relay deliver(ies))`, the first time in 15
// recorded bundles that ran it. ONE delegated piece, relayed to the owner TWICE, 52 s apart,
// in two different wordings:
//
//   10:33:04.235  bc839833  turn 4039  "Heard back from DupWorker-…: ECHO-PW8D-33"
//   10:33:56.333  2fc0347e  turn NULL  "All the delegated pieces are back; here they are …"
//
// Both `tool='a2a-join-relay'`, both `outcome='delivered'`, both resolving to user-visible
// assistant rows. WHY, one row deeper, read off the body:
//
//   1. the peer answered INSIDE the delegating turn (4039), so `recordDelivery` stamped the
//      engine's relay with that turn from the ambient turn context;
//   2. the join arm's later-turn narrowing therefore refused the engine's OWN relay as the
//      receipt ("the compiled answer has not landed for the owner yet") — its premise was
//      that the relay always records `turn_number = NULL`;
//   3. so the row stayed `compile_pending`, the ladder spent all six rungs, and its LAST rung
//      relayed the very same piece again. Nothing in the engine asked "have I already told
//      them?" — the exactly-once guard is the `work` transition, and step 2 is exactly the
//      case where that transition never happens.
//
// This file drives the REAL `resolveCompilePendingJoins` — the ladder, its rungs, its relay
// and the authority behind it — over the real spine, and counts what reached the owner.

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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-join-relay-once-test', 'dojo.db'),
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
import { JOIN_REDRIVE_BOUND, STUCK_NOTICE_RETRY_BOUND } from '../../work/join-drive.js';

const AGENT = 'kevin';
const PEER = 'dupworker';
const CONV = 'conv-1';
const DELEGATING_TURN = 4039;
/** Every rung the ladder has: the re-drives, the stuck notices, and the pass that ends at the
 *  platform surface and the relay. Driving MORE passes than that is deliberate — a guard that
 *  only holds for one extra sweep is not an exactly-once guard. */
const PASSES_TO_EXHAUST_THE_LADDER = JOIN_REDRIVE_BOUND + STUCK_NOTICE_RETRY_BOUND + 3;

const workRow = (id: string): Record<string, unknown> =>
  mockDb.current!.prepare('SELECT * FROM work WHERE id = ?').get(id) as Record<string, unknown>;

/** Every relay the engine recorded for this join, in order. */
const relayRows = (joinId: string): Array<{ id: string; turn_number: number | null; created_at: string }> =>
  mockDb.current!.prepare(
    `SELECT id, turn_number, created_at FROM deliveries
       WHERE tool = 'a2a-join-relay' AND outcome = 'delivered' AND detail LIKE ?
       ORDER BY rowid`,
  ).all(`%${joinDeliveryDetail(joinId)}%`) as Array<{ id: string; turn_number: number | null; created_at: string }>;

/** What the OWNER can actually see on their own lane — the thing the duplicate answer is. */
const ownerFacing = (): Array<{ content: string; role: string }> =>
  mockDb.current!.prepare(
    `SELECT content, role FROM messages WHERE agent_id = ? AND role IN ('assistant','system')
        AND lane = 'owner' ORDER BY rowid`,
  ).all(AGENT) as Array<{ content: string; role: string }>;

const drive = async (): Promise<void> => {
  const { resolveCompilePendingJoins } = await import('../a2a-transport.js');
  await resolveCompilePendingJoins(AGENT);
};

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

/**
 * DELIVERY #1, exactly as `resolveCompletedJoin`'s one-piece branch recorded it at 10:33:04 —
 * including the fact this whole task is about: it carries the DELEGATING turn's number, because
 * the peer replied while that turn was still open and `recordDelivery` stamps `turn_number` from
 * the ambient turn context (`agent/v2/deliveries.ts`).
 */
function seedTheEnginesFirstRelay(askId: string, o: { turn?: number | null; conversationId?: string | null } = {}): string {
  const db = mockDb.current!;
  const messageId = `msg-relay-1-${askId}`;
  const conversationId = o.conversationId === undefined ? CONV : o.conversationId;
  db.prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, channel, conversation_id, display_kind, created_at, seq)
     VALUES (?, ?, 'assistant', 'Heard back from DupWorker: ECHO-PW8D-30', 'owner', 'dashboard', ?, 'agent-text', ?, NULL)`,
  ).run(messageId, AGENT, conversationId, Date.now());
  db.prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, message_id, outcome, detail, created_at)
     VALUES (?, ?, ?, 'a2a-join-relay', 'dashboard', ?, ?, 'delivered', ?, datetime('now', '+1 seconds'))`,
  ).run(
    `d-relay-1-${askId}`, AGENT, o.turn === undefined ? DELEGATING_TURN : o.turn,
    conversationId, messageId, joinDeliveryDetail(askId),
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
       (?, 'Kevin', 'idle', '1970-01-01'), (?, 'DupWorker', 'idle', '1970-01-01')`,
  ).run(AGENT, PEER);
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, counterparty_id)
     VALUES (?, ?, 'dashboard', 'owner')`,
  ).run(CONV, AGENT);
});

// ════════════════════════════════════════════════════════════════════════════════
// THE RECORDED SHAPE, END TO END.
// ════════════════════════════════════════════════════════════════════════════════

describe('the engine relays one delegated answer to the owner ONCE (bmshcidpw8d clause (c))', () => {
  it('THE MEASURED DEFECT: a one-piece join whose relay was stamped with the delegating turn '
    + 'is NOT relayed a second time by the ladder', async () => {
    const askId = seedCompletedOnePieceJoin('m-1');
    const first = seedTheEnginesFirstRelay(askId);
    expect(workRow(askId).compile_pending, 'premise: the join is compile-pending, as it was live').toBe(1);
    expect(relayRows(askId), 'premise: the owner has been told exactly once so far').toHaveLength(1);

    for (let i = 0; i < PASSES_TO_EXHAUST_THE_LADDER; i++) await drive();

    const relays = relayRows(askId);
    expect(relays.map((r) => r.id), 'the engine speaks about one delegated answer once').toEqual([first]);
    // …and the owner's own lane is the surface that matters, not the ledger alone.
    expect(ownerFacing().filter((m) => /ECHO-PW8D-30|delegated pieces are back/.test(m.content)))
      .toHaveLength(1);
  });

  it('…and the ask SETTLES on the relay the owner actually got — no silence in place of the duplicate', async () => {
    const askId = seedCompletedOnePieceJoin('m-1');
    const first = seedTheEnginesFirstRelay(askId);

    for (let i = 0; i < PASSES_TO_EXHAUST_THE_LADDER; i++) await drive();

    const row = workRow(askId);
    expect(row.state).toBe('done');
    expect(row.result_delivery_id).toBe(first);
    expect(row.compile_pending).toBe(0);
    const kinds = mockDb.current!.prepare(
      'SELECT kind FROM work_events WHERE work_id = ? ORDER BY id',
    ).all(askId) as Array<{ kind: string }>;
    expect(kinds.map((k) => k.kind)).toContain('compile_resolved');
  });

  it('THE CAUSE, AT THE CAUSE: the relay settles the join on the FIRST pass, so the ladder '
    + 'never spends a rung and the owner is never told the job is stuck', async () => {
    const askId = seedCompletedOnePieceJoin('m-1');
    seedTheEnginesFirstRelay(askId);

    await drive();

    expect(workRow(askId).state).toBe('done');
    const drives = mockDb.current!.prepare(
      `SELECT COUNT(*) n FROM work_events WHERE work_id = ? AND kind = 'audit'`,
    ).get(askId) as { n: number };
    expect(drives.n, 'a job that is finished is not re-driven').toBe(0);
    const ghosts = mockDb.current!.prepare(
      `SELECT COUNT(*) n FROM work_events WHERE work_id = ? AND kind = 'floor_ghosted'`,
    ).get(askId) as { n: number };
    expect(ghosts.n).toBe(0);
  });

  it('THE GUARD ITSELF BITES, with the authority unable to help: an ask with no conversation row '
    + 'still gets exactly ONE relay, and the ladder settles on the one already sent', async () => {
    // The conversation-scoped read returns nothing when the ask has no conversation
    // (`compiledDelivery` refuses outright), so step 1 of the drive cannot close this join and
    // the ladder runs to its end — which is precisely the pass that used to speak twice. The
    // guard is what stops it, and the settle it makes NAMES the delivery the owner already got.
    const askId = seedCompletedOnePieceJoin('m-1', { conversationId: null });
    const first = seedTheEnginesFirstRelay(askId, { conversationId: null });
    expect(workRow(askId).compile_pending).toBe(1);

    for (let i = 0; i < PASSES_TO_EXHAUST_THE_LADDER; i++) await drive();

    expect(relayRows(askId).map((r) => r.id)).toEqual([first]);
    expect(workRow(askId).state).toBe('done');
    expect(workRow(askId).result_delivery_id).toBe(first);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// WHAT MUST NOT CHANGE. The governing priority is "worst case the owner hears it
// twice; it never errs toward silence" — so a guard against the second relay is
// only defensible if the FIRST one still always happens.
// ════════════════════════════════════════════════════════════════════════════════

describe('PRESERVED: the ladder still relays when the engine has said NOTHING', () => {
  it('a ghosted TWO-piece compile still reaches the owner — the relay is not suppressed, it is '
    + 'de-duplicated', async () => {
    const askId = seedCompletedOnePieceJoin('m-1', { children: 2 });
    expect(relayRows(askId), 'premise: nothing has been relayed for this join').toHaveLength(0);

    for (let i = 0; i < PASSES_TO_EXHAUST_THE_LADDER; i++) await drive();

    const relays = relayRows(askId);
    expect(relays, 'the owner gets the pieces the model never compiled').toHaveLength(1);
    // UX-REPAIR ROUND 12 T48: with EVERY piece back, the telling now happens one rung earlier —
    // at the engine-relay rung rather than at the end of the ladder — and it carries T48's own
    // preface instead of the end-of-ladder wording. The subject of this clause is untouched:
    // the FIRST relay still always happens, and there is still exactly one of it.
    expect(ownerFacing().some((m) => /results are in as delivered by the helpers/.test(m.content))).toBe(true);
    expect(workRow(askId).state).toBe('done');
  });

  it('the ladder still climbs when nothing was relayed: re-drives, stuck notices, then the '
    + 'platform surface — in that order, each bounded', async () => {
    // T48 rekey: the full climb belongs to a join that is genuinely stuck — one whose
    // deliverable never came back. An all-landed join leaves at the engine-relay rung now, so
    // seeding one here would measure the new rung and call it the old ladder.
    const askId = seedCompletedOnePieceJoin('m-1', { children: 2, missingDeliverables: 1 });

    for (let i = 0; i < PASSES_TO_EXHAUST_THE_LADDER; i++) await drive();

    const audits = (mockDb.current!.prepare(
      `SELECT payload FROM work_events WHERE work_id = ? AND kind = 'audit' ORDER BY id`,
    ).all(askId) as Array<{ payload: string }>)
      .map((r) => (JSON.parse(r.payload) as { entry_kind: string }).entry_kind);
    expect(audits.filter((a) => a === 'join_redrive')).toHaveLength(JOIN_REDRIVE_BOUND);
    expect(audits.filter((a) => a === 'join_stuck_notice')).toHaveLength(STUCK_NOTICE_RETRY_BOUND);
    expect(audits.filter((a) => a === 'join_drive_ghosted')).toHaveLength(1);
  });

  it('a relay recorded for ANOTHER join does not silence this one', async () => {
    const other = seedCompletedOnePieceJoin('m-other', { children: 2 });
    seedTheEnginesFirstRelay(other);
    const askId = seedCompletedOnePieceJoin('m-1', { children: 2 });

    for (let i = 0; i < PASSES_TO_EXHAUST_THE_LADDER; i++) await drive();

    expect(relayRows(askId), 'this join own answer still goes out').toHaveLength(1);
  });
});
