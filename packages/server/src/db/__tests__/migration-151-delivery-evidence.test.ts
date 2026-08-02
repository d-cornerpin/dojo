// PHASE-4 T2, THE GUARD — a `done` work row may never silently lose its evidence.
//
// THE LAW THIS DEFENDS, stated in three places already and enforced in none of
// them after the fact:
//   * migration 135: `CHECK (state <> 'done' OR result_delivery_id IS NOT NULL)`
//   * `work/store.ts` G7: the id must point at a delivery that EXISTS — checked
//     at close time
//   * the column's own FK: `result_delivery_id TEXT REFERENCES deliveries(id)`
// All three are satisfiable by a database in which the delivery has SINCE been
// deleted. G7 looks once, at the close; the CHECK only ever sees the column;
// and the FK — the only one that looks afterwards — is enforced by a
// PER-CONNECTION PRAGMA. This tree already knows that (`message-store.ts`
// records it in prose: "FK enforcement is a per-connection PRAGMA, and it is
// OFF for the whole migration chain"), and it is exactly how seven `done` rows
// in the dev body came to point at deliveries that no longer exist: they were
// deleted by a raw `sqlite3` client, where `foreign_keys` defaults to OFF.
//
// MEASURED, on a VACUUM INTO copy of the real body, before any of this was
// written — one delete, two pragma states:
//   foreign_keys=ON   → "FOREIGN KEY constraint failed"; the row survives
//   foreign_keys=OFF  → the delete succeeds; 180 `done` rows are orphaned
// A guard whose enforcement is a connection setting is a guard the next client
// turns off by accident.
//
// SO THE GUARD IS A TRIGGER, which no pragma disables, and it REFUSES rather
// than re-points. Re-pointing (a tombstone delivery carrying "the evidence used
// to be here") would MANUFACTURE the receipt the law asks for — the forged-flag
// class migration 108 was demolished for, and the prose-keyed honesty the phase
// cautions forbid. A closed ticket is provable or it is not closed.
//
// It is scoped to `state='done'` deliberately: a non-terminal row's
// `result_delivery_id` is not the evidence of anything, and a guard that bites
// more than its requirement is a guard someone disables.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join(os.tmpdir(), 'dojo-m151-test', 'dojo.db'),
  };
});

import { runMigrations } from '../migrations.js';

const AGENT = 'kevin';

/** A delivery row, minimally. */
function seedDelivery(id: string): string {
  mockDb.current!.prepare(
    `INSERT INTO deliveries (id, agent_id, tool, channel, outcome)
     VALUES (?, ?, 'dashboard', 'dashboard', 'delivered')`,
  ).run(id, AGENT);
  return id;
}

/** A work row in `state`, pointing at `deliveryId`. Written raw so the test can
 *  build the exact shapes the guard is about, including ones `transition()` would
 *  refuse to create. */
function seedWork(id: string, state: string, deliveryId: string | null): string {
  mockDb.current!.prepare(
    `INSERT INTO work (id, kind, agent_id, requester, requester_id, root_kind, root_id,
                       state, intent, wakes, closes_thread, title, result_delivery_id,
                       closed_at, opened_at, updated_at, provenance)
     VALUES (?, 'ask', ?, 'owner', 'owner', 'ask', ?, ?, 'ask', 0, 0, 'a question', ?,
             CASE WHEN ? IN ('done','failed','abandoned') THEN 1700000000000 ELSE NULL END,
             1700000000000, 1700000000000, 'live')`,
  ).run(id, AGENT, id, state, deliveryId, state);
  return id;
}

beforeEach(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.prepare(
    `INSERT INTO agents (id, name, status, session_started_at)
     VALUES (?, 'Kevin', 'idle', '1970-01-01')`,
  ).run(AGENT);
  // OFF on purpose, and it is the whole point: this is the state a raw `sqlite3`
  // client and the entire migration chain run in. The guard must hold here.
  db.pragma('foreign_keys = OFF');
});

describe('the delivery-evidence guard: a done row cannot silently lose its receipt', () => {
  it('POSITIVE: deleting the delivery a DONE row names is REFUSED, with foreign_keys OFF', () => {
    const d = seedDelivery('d-done');
    seedWork('w-done', 'done', d);

    expect(() => mockDb.current!.prepare('DELETE FROM deliveries WHERE id = ?').run(d))
      .toThrow(/evidence of a done work row/i);
    // Still there, so the ticket is still provable.
    expect(
      (mockDb.current!.prepare('SELECT count(*) AS n FROM deliveries WHERE id = ?').get(d) as { n: number }).n,
    ).toBe(1);
  });

  it('POSITIVE: refused with foreign_keys ON too — and the refusal is the TRIGGER, named', () => {
    mockDb.current!.pragma('foreign_keys = ON');
    const d = seedDelivery('d-done-fk');
    seedWork('w-done-fk', 'done', d);
    // The message matters: with the pragma on, an FK would refuse with "FOREIGN KEY
    // constraint failed", which tells a reader nothing about what they broke.
    expect(() => mockDb.current!.prepare('DELETE FROM deliveries WHERE id = ?').run(d))
      .toThrow(/evidence of a done work row/i);
  });

  it('NEGATIVE CONTROL: a delivery NO work row names still deletes freely', () => {
    const d = seedDelivery('d-loose');
    mockDb.current!.prepare('DELETE FROM deliveries WHERE id = ?').run(d);
    expect(
      (mockDb.current!.prepare('SELECT count(*) AS n FROM deliveries WHERE id = ?').get(d) as { n: number }).n,
    ).toBe(0);
  });

  it('NEGATIVE CONTROL: a delivery a NON-DONE row names still deletes freely', () => {
    // The guard is about closed tickets that must stay provable, not about the table.
    const d = seedDelivery('d-claimed');
    seedWork('w-claimed', 'claimed', d);
    mockDb.current!.prepare('DELETE FROM deliveries WHERE id = ?').run(d);
    expect(
      (mockDb.current!.prepare('SELECT count(*) AS n FROM deliveries WHERE id = ?').get(d) as { n: number }).n,
    ).toBe(0);
  });

  it('NEGATIVE CONTROL: a bulk delete that touches ONE protected row takes none of them', () => {
    // The shape the kit's teardown uses: `DELETE FROM deliveries WHERE agent_id IN (…)`.
    // A statement-level ABORT is what makes the caller notice, instead of silently
    // deleting everything except the one row.
    const a = seedDelivery('d-bulk-a');
    const b = seedDelivery('d-bulk-b');
    seedWork('w-bulk', 'done', b);
    expect(() => mockDb.current!.prepare('DELETE FROM deliveries WHERE agent_id = ?').run(AGENT))
      .toThrow(/evidence of a done work row/i);
    expect(
      (mockDb.current!.prepare('SELECT count(*) AS n FROM deliveries WHERE id IN (?, ?)').get(a, b) as { n: number }).n,
    ).toBe(2);
  });

  it('THE MIGRATION DOES NOT ABORT ON A BODY THAT ALREADY CARRIES ORPHANS', () => {
    // The `.23`-incident class, avoided BY CONSTRUCTION rather than by luck: a BEFORE
    // DELETE trigger validates nothing at creation time, so a lived-in database whose
    // history already contains a `done` row with a deleted delivery still takes the
    // chain. A CHECK could not have said this. The dev body carries seven such rows,
    // and this is the clause that says the migration is safe to put in front of them.
    const db = new Database(':memory:');
    mockDb.current = db;
    runMigrations();
    db.pragma('foreign_keys = OFF');
    db.prepare(
      `INSERT INTO agents (id, name, status, session_started_at)
       VALUES (?, 'Kevin', 'idle', '1970-01-01')`,
    ).run(AGENT);
    // An orphan: `done`, naming a delivery that does not exist.
    expect(() => seedWork('w-orphan', 'done', 'gone-delivery')).not.toThrow();
    // Re-running the whole chain over that body is still fine.
    expect(() => runMigrations()).not.toThrow();
    expect(
      (db.prepare(
        `SELECT count(*) AS n FROM work w WHERE w.state = 'done' AND w.result_delivery_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.id = w.result_delivery_id)`,
      ).get() as { n: number }).n,
    ).toBe(1);
  });
});
