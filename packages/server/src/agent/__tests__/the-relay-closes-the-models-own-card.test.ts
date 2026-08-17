// ════════════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 14 / T66 — THE RELAY CLOSES THE MODEL'S OWN SCAFFOLD CARD.
//
// ── THE MEASURED SHAPE (round 14; every row re-read off the dev body by W47) ─────────────
// `ask:64b85330-f08c-49ba-930a-7d2238711015` ("Anniversary dinner outing and at-home backup")
// was claimed by turn 4984, opened a two-piece join, and went `blocked` on the hold. Both
// pieces landed. Three redrives were spent — turns 4985, 4986 (plus one deferred) and 4987 —
// and then `join_engine_relay 1/1` shipped the pieces verbatim; the ask closed `done` on
// delivery `9b15cc2f` with `compile_resolved` beside it.
//
// AND THE MODEL'S OWN CARD FOR THE SAME JOB STAYED OPEN: task `708985b4`, "Combine anniversary
// dinner plan and deliver to David", opened on turn 4985 — which is `join_redrive 1/3` for this
// very ask — sat `blocked` and PM-upheld. By `pm-agent.ts`'s own queue rules an upheld block is
// never re-adjudicated, so the row's only remaining surface is a 30-minute `BLOCKED:` notice
// about work the engine finished an hour earlier.
//
// ── THE TIE, AND WHY IT IS THIS ONE ─────────────────────────────────────────────────────
// Read off that live row: `source_message_id` NULL, `origin_conv_key` NULL, `parent_id` NULL,
// `a2a_thread_id` NULL, `conversation_id` NULL, `root_id` = itself. The one lineage column that
// carries anything is `origin_turn`, and the ask's own ledger records which turns its ladder
// drove. So the structural tie is: THE CARD WAS OPENED ON A TURN THIS ASK'S LADDER WAS DRIVING.
// No title is read. `join-drive.ts` carries the full argument, the honest bound, and the deeper
// root that is deliberately NOT fixed here (the missing `source_message_id` edge).
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// Same measured reason as the sibling relay files: the first clause pays the migration chain
// plus `a2a-transport.js`'s whole import graph.
vi.setConfig({ testTimeout: 20_000 });

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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-relay-closes-card-test', 'dojo.db'),
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
  openAsk, claimAsk, stampClaimingTurn, openDelegationJoin, landPiece,
} from '../../work/store.js';
import { openTrackerTask, setTrackerStatus } from '../../work/tracker-store.js';
import { JOIN_REDRIVE_BOUND } from '../../work/join-drive.js';

const AGENT = 'kevin';
const OTHER_AGENT = 'kelly';
const PEER_A = 'kelly';
const PEER_B = 'kayla';
const CONV = 'conv-1';
const CLAIM_TURN = 4984;

const PIECE_A = 'Healer: burrata with heirloom tomatoes, brown butter linguine, affogato.';
const PIECE_B = 'Ticky: Westward, 2501 N Northlake Way — book Sat by Thursday.';

const workRow = (id: string): Record<string, unknown> =>
  mockDb.current!.prepare('SELECT * FROM work WHERE id = ?').get(id) as Record<string, unknown>;

const auditEntries = (workId: string): string[] =>
  (mockDb.current!.prepare(
    `SELECT payload FROM work_events WHERE work_id = ? AND kind = 'audit' ORDER BY id`,
  ).all(workId) as Array<{ payload: string }>)
    .map((r) => (JSON.parse(r.payload) as { entry_kind: string }).entry_kind);

/** The turn clock the ladder reads (`currentTurnNumber` = MAX(turn_number)). Advancing it is
 *  what makes a redrive a real chance rather than a deferral (T10's rule). */
function advanceTurnTo(n: number, agentId = AGENT): void {
  mockDb.current!.prepare(
    `INSERT OR IGNORE INTO turns (agent_id, turn_number, kind, answered, started_at)
     VALUES (?, ?, 'a2a', 0, datetime('now'))`,
  ).run(agentId, n);
}

const drive = async (): Promise<void> => {
  const { resolveCompilePendingJoins } = await import('../a2a-transport.js');
  await resolveCompilePendingJoins(AGENT);
};

/** The measured S5/round-14 shape, built through the product's own calls. */
function seedTwoPieceJoin(msgId = 'm-1'): string {
  const db = mockDb.current!;
  const openedAt = Date.now() - 20 * 60_000;
  db.prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, channel, conversation_id, created_at, seq)
     VALUES (?, ?, 'user', 'anniversary dinner: a place out, and a backup at home', 'owner', 'dashboard', ?, ?, NULL)`,
  ).run(msgId, AGENT, CONV, openedAt);
  const askId = openAsk({
    agentId: AGENT, messageId: msgId, conversationId: CONV, requesterId: 'owner',
    openedAt, title: 'Anniversary dinner outing and at-home backup',
  });
  claimAsk(askId, AGENT);
  stampClaimingTurn(askId, CLAIM_TURN);
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
    ).run(`piece-d-${i}`, AGENT);
  }
  landPiece(kids[0], { deliveryId: 'piece-d-0', content: PIECE_A, messageId: null, actorId: PEER_A });
  landPiece(kids[1], { deliveryId: 'piece-d-1', content: PIECE_B, messageId: null, actorId: PEER_B });
  expect(workRow(askId).compile_pending, 'premise: the join completed and a compile is owed').toBe(1);
  return askId;
}

/** A card the MODEL opened, exactly as `work_open(kind="task")` records one. */
function modelCard(opts: {
  title: string; originTurn: number | null; agentId?: string;
  originKind?: string; state?: 'blocked' | 'on_deck';
}): string {
  const id = openTrackerTask({
    title: opts.title, description: null, priority: 'normal',
    createdBy: opts.agentId ?? AGENT, assignedTo: opts.agentId ?? AGENT,
    origin: {
      kind: (opts.originKind ?? 'model') as 'model',
      sourceMessageId: null, turn: opts.originTurn, convKey: null,
    },
  });
  if (opts.state === 'blocked') {
    setTrackerStatus(id, 'blocked', {
      by: 'agent', actorId: opts.agentId ?? AGENT,
      reason: 'waiting on the delegated pieces to come back',
      note: 'waiting on the delegated pieces to come back before combining them',
    });
  }
  return id;
}

/** The turns the ladder actually drove, off the ask's own ledger. */
function drivenTurns(askId: string): number[] {
  return (mockDb.current!.prepare(
    `SELECT DISTINCT json_extract(payload,'$.turn_number') AS t FROM work_events
      WHERE work_id = ? AND kind = 'audit' AND json_extract(payload,'$.turn_number') IS NOT NULL`,
  ).all(askId) as Array<{ t: number }>).map((r) => r.t);
}

/** Drive to the relay, advancing the turn clock so each redrive is a real chance. */
async function driveToTheRelay(askId: string): Promise<void> {
  let turn = CLAIM_TURN;
  for (let i = 0; i < JOIN_REDRIVE_BOUND + 4; i++) {
    if (auditEntries(askId).includes('join_engine_relay')) return;
    turn += 1;
    advanceTurnTo(turn);
    await drive();
  }
  throw new Error('the ladder never reached its relay rung');
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
  advanceTurnTo(CLAIM_TURN);
});

// ── RED → GREEN ─────────────────────────────────────────────────────────────────────────

describe('T66: the disarm walk reaches the card the model opened for the same job', () => {
  it('RED→GREEN: the blocked "combine and deliver" card closes on the relay\'s own receipt', async () => {
    const askId = seedTwoPieceJoin();
    // The card is opened on the FIRST redrive's turn, which is the measured shape: the engine
    // put the owed compile back in front of the model and the model wrote itself a card instead.
    advanceTurnTo(CLAIM_TURN + 1);
    const card = modelCard({
      title: 'Combine anniversary dinner plan and deliver to David',
      originTurn: CLAIM_TURN + 1, state: 'blocked',
    });
    expect(workRow(card).state, 'premise: the card is open and blocked, as the measured row was').toBe('blocked');

    await driveToTheRelay(askId);

    expect(auditEntries(askId), 'premise: the relay is what fired').toContain('join_engine_relay');
    expect(workRow(askId).state, 'premise: the ask closed on the relay').toBe('done');
    expect(drivenTurns(askId), 'premise: the tie exists — the card\'s origin turn is one the ladder drove')
      .toContain(CLAIM_TURN + 1);

    const after = workRow(card);
    expect(after.state, 'the card the model opened for this job is discharged, not left blocked').toBe('done');
    // The receipt is the relay's OWN delivery — the same one the ask closed on, which is what
    // makes the close honest and what the two-key gate is satisfied by.
    expect(after.result_delivery_id).toBe(workRow(askId).result_delivery_id);
  });

  it('the close states its reason on the card\'s own ledger, in the engine\'s name', async () => {
    const askId = seedTwoPieceJoin();
    advanceTurnTo(CLAIM_TURN + 1);
    const card = modelCard({ title: 'Combine and deliver', originTurn: CLAIM_TURN + 1, state: 'blocked' });
    await driveToTheRelay(askId);

    const transitions = (mockDb.current!.prepare(
      `SELECT payload FROM work_events WHERE work_id = ? AND kind = 'transition' ORDER BY id`,
    ).all(card) as Array<{ payload: string }>)
      .map((r) => JSON.parse(r.payload) as { to: string; by: string; reason: string });
    const close = transitions.find((t) => t.to === 'done');
    expect(close).toBeDefined();
    expect(close!.by).toBe('engine');
    expect(close!.reason).toMatch(/the engine delivered the compiled result/);
    expect(close!.reason).toMatch(/purpose is discharged/);
  });

  it('a card that was never blocked, just never finished, is discharged too', async () => {
    const askId = seedTwoPieceJoin();
    advanceTurnTo(CLAIM_TURN + 1);
    const card = modelCard({ title: 'Combine the two plans', originTurn: CLAIM_TURN + 1 });
    expect(workRow(card).state, 'premise: open, and never blocked').not.toBe('done');
    await driveToTheRelay(askId);
    expect(workRow(card).state).toBe('done');
  });
});

// ── CONTROLS ────────────────────────────────────────────────────────────────────────────

describe('T66 CONTROLS — the walk reaches the tie and nothing else', () => {
  it('A CARD WITH NO TIE STAYS OPEN — a genuinely-still-owed job is not closed by someone else\'s relay', async () => {
    const askId = seedTwoPieceJoin();
    // Opened on a turn LONG before this ask was ever claimed: no rung of this ladder ever ran
    // on it, so there is no tie and no business closing it.
    advanceTurnTo(CLAIM_TURN);
    const untied = modelCard({ title: 'Renew the passport', originTurn: 4000, state: 'blocked' });
    await driveToTheRelay(askId);
    expect(workRow(untied).state, 'no tie, no close').toBe('blocked');
  });

  it('A CARD OPENED WITH NO ORIGIN TURN AT ALL stays open — an absent tie is not a match', async () => {
    const askId = seedTwoPieceJoin();
    const noOrigin = modelCard({ title: 'Something the model wrote down', originTurn: null });
    const before = workRow(noOrigin).state;
    await driveToTheRelay(askId);
    expect(workRow(noOrigin).state, 'left exactly as the door opened it').toBe(before);
  });

  it('AN ENGINE SCAFFOLD is not the model\'s card — the >=6 floor\'s row is untouched', async () => {
    const askId = seedTwoPieceJoin();
    advanceTurnTo(CLAIM_TURN + 1);
    const scaffold = modelCard({
      title: 'Untracked work on this turn', originTurn: CLAIM_TURN + 1,
      originKind: 'engine_scaffold',
    });
    const before = workRow(scaffold).state;
    await driveToTheRelay(askId);
    expect(workRow(scaffold).state, 'left exactly as the floor opened it').toBe(before);
  });

  it('ANOTHER AGENT\'S card on the same turn number is not this agent\'s work', async () => {
    const askId = seedTwoPieceJoin();
    advanceTurnTo(CLAIM_TURN + 1);
    const theirs = modelCard({
      title: 'Combine something else entirely', originTurn: CLAIM_TURN + 1, agentId: OTHER_AGENT,
    });
    const before = workRow(theirs).state;
    await driveToTheRelay(askId);
    expect(workRow(theirs).state, "another agent's row is not touched").toBe(before);
  });

  it('THE PIECES ARE NOT CARDS: the join\'s own children keep the states the landings gave them', async () => {
    const askId = seedTwoPieceJoin();
    await driveToTheRelay(askId);
    const pieces = mockDb.current!.prepare(
      `SELECT state FROM work WHERE parent_id = ? ORDER BY id`,
    ).all(askId) as Array<{ state: string }>;
    expect(pieces.map((p) => p.state)).toEqual(['done', 'done']);
  });

  it('A SECOND PASS closes nothing twice — the already-terminal card is left alone', async () => {
    const askId = seedTwoPieceJoin();
    advanceTurnTo(CLAIM_TURN + 1);
    const card = modelCard({ title: 'Combine and deliver', originTurn: CLAIM_TURN + 1, state: 'blocked' });
    await driveToTheRelay(askId);
    const closes = (): number => (mockDb.current!.prepare(
      `SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = 'transition'
          AND json_extract(payload,'$.to') = 'done'`,
    ).get(card) as { n: number }).n;
    const firstCount = closes();
    await drive();
    await drive();
    expect(closes(), 'one close, however many passes the sweep makes').toBe(firstCount);
  });

  it('NO RELAY, NO RELEASE: while the redrives still have room the card is left for the model', async () => {
    const askId = seedTwoPieceJoin();
    advanceTurnTo(CLAIM_TURN + 1);
    const card = modelCard({ title: 'Combine and deliver', originTurn: CLAIM_TURN + 1, state: 'blocked' });
    // One pass only: the ladder is on its first redrive, nowhere near the relay.
    await drive();
    expect(auditEntries(askId)).not.toContain('join_engine_relay');
    expect(workRow(card).state, 'the model still owns the job it was asked to do').toBe('blocked');
  });
});
