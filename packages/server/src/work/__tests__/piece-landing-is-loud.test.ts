// PHASE-2 T10 — RULING 7 rider (b): a transition ABORT during piece landing is LOUD,
// and it names the row.
//
// The incident (MAP-TRIAGE, 2026-07-29): the box carried a two-key trigger missing its
// `root_kind <> 'a2a_thread'` clause, so every fan-out piece landing raised
// `two-key: completion requires an upheld adjudication`. The throw unwound into
// `a2a-transport.ts`, which logged it as:
//
//     warn a2a-transport | A2A close-the-loop delivery failed
//                          {"error":"two-key: completion requires an upheld adjudication"}
//
// — no row, no work id, no kind, at a tier nobody reads. The countdown never reached
// zero, the engine's deterministic relay never fired, and the ordinary "surface this
// deliverable" hint is deliberately suppressed once a join owns the thread. The platform
// took responsibility for a delivery and was then silently prevented from making it, for
// six hours, across eight firings.
//
// The loudness lives in `landPiece`/`settlePieceWithoutResult` rather than at the two
// catch sites, for the reason already written in `a2a-transport.ts` about the empty-piece
// refusal: inside the settle function, no caller can forget it.
//
// The trigger planted below is THE OLD BROKEN ONE, byte-shaped like the object the box
// actually carried — this test reproduces the incident rather than describing it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-piece-loud-test', 'dojo.db'),
  };
});

const logged: Array<{ level: string; msg: string; meta: unknown }> = [];
vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    error: (msg: string, meta?: unknown) => logged.push({ level: 'error', msg, meta }),
    warn: (msg: string, meta?: unknown) => logged.push({ level: 'warn', msg, meta }),
    info: () => {},
    debug: () => {},
  }),
}));

import { runMigrations } from '../../db/migrations.js';
import { openAsk, claimAsk, openDelegationJoin, landPiece, settlePieceWithoutResult } from '../store.js';

const AGENT = 'kevin';
const THREAD = 'thread-aaaaaaaa-1111';

/** The trigger the box carried on 2026-07-29: no `root_kind` arm, so it bites join pieces. */
function plantTheBrokenTrigger(db: Database.Database): void {
  db.exec(`DROP TRIGGER IF EXISTS trg_work_two_key_completion;`);
  db.exec(`
    CREATE TRIGGER trg_work_two_key_completion
    BEFORE UPDATE OF state ON work
    WHEN NEW.state = 'done' AND OLD.state <> 'done'
     AND NEW.kind IN ('task', 'project')
    BEGIN
      SELECT RAISE(ABORT, 'two-key: completion requires an upheld adjudication');
    END;
  `);
}

function seedJoinChild(): { parent: string; child: string } {
  const db = mockDb.current!;
  db.prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, channel, conversation_id, created_at, seq)
     VALUES ('m-1', ?, 'user', 'ask Ana, then tell me', 'owner', 'dashboard', 'owner', ?, NULL)`,
  ).run(AGENT, Date.now());
  const parent = openAsk({
    agentId: AGENT, messageId: 'm-1', conversationId: 'conv-1', requesterId: 'owner',
    openedAt: Date.now(), title: 'ask Ana',
  });
  claimAsk(parent, AGENT);
  const kids = openDelegationJoin({
    parentWorkId: parent, agentId: AGENT, replyConversationId: 'conv-1',
    ttlAt: Date.now() + 60 * 60_000, threads: [{ threadId: THREAD }],
  });
  return { parent, child: kids[0] };
}

function seedDelivery(id: string): string {
  mockDb.current!.prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, outcome)
     VALUES (?, ?, 7, 'send_to_agent', 'a2a', NULL, 'delivered')`,
  ).run(id, AGENT);
  return id;
}

beforeEach(() => {
  logged.length = 0;
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(
    `INSERT INTO agents (id, name, status, session_started_at)
     VALUES (?, 'Kevin', 'idle', '1970-01-01'), ('ana', 'Ana', 'idle', '1970-01-01')`,
  ).run(AGENT);
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, counterparty_id)
     VALUES ('conv-1', ?, 'dashboard', 'owner')`,
  ).run(AGENT);
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('RULING 7 rider (b): a piece landing that aborts says so at ERROR, naming the row', () => {
  it('THE INCIDENT: landPiece under the old trigger logs an error carrying the child id, kind and root_kind', () => {
    const { parent, child } = seedJoinChild();
    plantTheBrokenTrigger(mockDb.current!);
    const deliveryId = seedDelivery('d-1');

    expect(() => landPiece(child, { deliveryId, content: 'here is the answer', actorId: 'ana' }))
      .toThrow(/two-key/);

    const errors = logged.filter(l => l.level === 'error');
    expect(errors).toHaveLength(1);
    const meta = errors[0].meta as Record<string, unknown>;
    expect(meta.workId).toBe(child);
    expect(meta.kind).toBe('task');
    expect(meta.rootKind).toBe('a2a_thread');
    expect(meta.parentId).toBe(parent);
    expect(meta.rootId).toBe(THREAD);
    expect(String(meta.error)).toMatch(/two-key/);
    // The tier is the point: `warn` is what the incident already had.
    expect(logged.some(l => l.level === 'warn' && /abort/i.test(l.msg))).toBe(false);
  });

  it('settlePieceWithoutResult is covered too — a terminal FAIL lands through a different call', () => {
    const { child } = seedJoinChild();
    // A trigger that bites `failed` as well, so the FAIL path is exercised rather than assumed.
    mockDb.current!.exec(`
      DROP TRIGGER IF EXISTS trg_work_two_key_completion;
      CREATE TRIGGER trg_test_bite_failed BEFORE UPDATE OF state ON work
      WHEN NEW.state = 'failed'
      BEGIN SELECT RAISE(ABORT, 'planted: failed is refused'); END;
    `);

    expect(() => settlePieceWithoutResult(child, {
      to: 'failed', reason: 'the peer replied FAIL', content: 'no', actorId: 'ana',
    })).toThrow(/planted/);

    const errors = logged.filter(l => l.level === 'error');
    expect(errors).toHaveLength(1);
    expect((errors[0].meta as Record<string, unknown>).workId).toBe(child);
  });

  it('NEGATIVE CONTROL: a piece that lands normally logs no error at all', () => {
    // Without this, the clause above would pass on a function that logs an error every time.
    const { child } = seedJoinChild();
    const deliveryId = seedDelivery('d-1');

    const settled = landPiece(child, { deliveryId, content: 'here is the answer', actorId: 'ana' });

    expect(settled.result.kind).toBe('applied');
    expect(logged.filter(l => l.level === 'error')).toEqual([]);
  });

  it('NEGATIVE CONTROL: an in-band refusal is NOT an abort and stays quiet', () => {
    // `landPiece` refuses an empty reply by RETURNING a rejection. That is a value the
    // caller reads, not a crash, and raising it to error would make the loud tier noise.
    const { child } = seedJoinChild();
    const deliveryId = seedDelivery('d-1');

    const settled = landPiece(child, { deliveryId, content: '   ', actorId: 'ana' });

    expect(settled.result.kind).toBe('refused');
    expect(logged.filter(l => l.level === 'error')).toEqual([]);
  });

  it('the abort still THROWS — the loudness is added, the control flow is not changed', () => {
    const { child } = seedJoinChild();
    plantTheBrokenTrigger(mockDb.current!);
    const deliveryId = seedDelivery('d-1');
    let threw: unknown = null;
    try { landPiece(child, { deliveryId, content: 'x', actorId: 'ana' }); } catch (e) { threw = e; }
    expect(threw).toBeInstanceOf(Error);
    // and the row is untouched, which is what made the incident invisible
    const state = (mockDb.current!.prepare('SELECT state FROM work WHERE id = ?').get(child) as { state: string }).state;
    expect(state).toBe('open');
  });
});
