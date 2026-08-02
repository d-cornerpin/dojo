// PHASE-4 T2 Step 3 — COMMIT-THEN-EMIT IS THE LAW, and it is structural.
//
// Research 22's largest omission was that the platform had no concurrency
// primitive at all: 137 mutation lines sat within 15 lines of a `broadcast(`
// when it was measured, 49 at this HEAD (the rest moved behind single-writer
// functions in Phases 1–3). Every one of them is a place where a listener can
// be told about a write before the database has agreed to it.
//
// THE SHAPE THIS TAKES, and it is deliberately NOT 33 edited call sites.
// `broadcast()` is the one door every frame passes through — 324 call sites —
// so the law lives THERE. A convention 33 sites must remember is a convention
// the 34th site breaks; a door cannot be forgotten.
//
// BUT `broadcast()` IS NOT A PURE EMITTER, and that is the finding this step
// had to deal with rather than route around. It does three things:
//   1. `stampPersistedRow(event)`      — decorates the frame
//   2. `recordDashboardDelivery(event)` — WRITES a `deliveries` row and may
//      close the ask it answers (the dashboard transport door, PHASE-2 T5)
//   3. the actual emission (internal listeners, then the socket/batch)
// Only (3) is an emit. (2) is a WRITE and belongs with the mutation it
// accompanies: if the surrounding unit rolls back, that delivery must roll back
// with it, which is exactly what T2's flagship cluster is about. Deferring it
// past the commit would give the ledger its own separate transaction again —
// the defect, re-introduced from the other end.
//
// So: THE WRITES STAY, THE EMISSION WAITS.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  closeDb: vi.fn(),
  getDbPath: () => path.join(os.tmpdir(), 'dojo-bcast-test', 'dojo.db'),
}));

// The delivery half is exercised by its own suite; here it stands in as an
// observable WRITE so the test can prove it does NOT move past the commit.
const dashboardCalls: string[] = [];
vi.mock('../../agent/v2/outbound.js', async () => ({
  recordDashboardDelivery: (): string | null => { dashboardCalls.push('write'); return null; },
}));

import { withUnit } from '../../db/unit.js';
import { broadcast, onBroadcast } from '../ws.js';

let dir: string;
let seen: string[];
let off: (() => void) | null = null;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-bcast-'));
  mockDb.current = new Database(path.join(dir, 'dojo.db'));
  mockDb.current.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
  seen = [];
  dashboardCalls.length = 0;
  off = onBroadcast((e) => { seen.push(e.type); });
});

afterEach(() => {
  off?.();
  off = null;
  mockDb.current?.close();
  mockDb.current = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

const put = (id: string): void => { mockDb.current!.prepare('INSERT INTO t (id) VALUES (?)').run(id); };
const rows = (): number =>
  (mockDb.current!.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n;
const evt = (): Parameters<typeof broadcast>[0] =>
  ({ type: 'agent:status', data: { agentId: 'kevin', status: 'idle' } }) as Parameters<typeof broadcast>[0];

describe('broadcast inside a unit: the emission waits for the commit', () => {
  it('POSITIVE: nothing is emitted while the unit is open; it lands after it commits', () => {
    withUnit(() => {
      put('a');
      broadcast(evt());
      // Mid-unit: the write is not committed, so nobody may have been told.
      seen.push(`mid:${String(seen.length)}`);
    });
    // 'mid:0' proves the listener had heard nothing at that point.
    expect(seen).toEqual(['mid:0', 'agent:status']);
    expect(rows()).toBe(1);
  });

  it('THE LAW: a unit that ROLLS BACK emits nothing — no listener hears about a write that vanished', () => {
    expect(() => withUnit(() => {
      put('a');
      broadcast(evt());
      throw new Error('rolled back');
    })).toThrow('rolled back');
    expect(seen).toEqual([]);
    expect(rows()).toBe(0);
  });

  it('THE WRITE HALF DOES NOT MOVE: recordDashboardDelivery runs INSIDE the unit', () => {
    // If this ran after the commit, the delivery ledger would get its own separate
    // transaction back — the exact defect T2's flagship cluster closes.
    withUnit(() => {
      broadcast(evt());
      expect(dashboardCalls).toEqual(['write']);   // already happened, inside the unit
      expect(seen).toEqual([]);                    // and nothing has been emitted yet
    });
    expect(seen).toEqual(['agent:status']);
  });

  it('and it rolls back with the unit: the write ran, the emission never did', () => {
    expect(() => withUnit(() => {
      broadcast(evt());
      throw new Error('rolled back');
    })).toThrow();
    expect(dashboardCalls).toEqual(['write']);  // attempted inside the unit, rolled back with it
    expect(seen).toEqual([]);                   // and nobody was told
  });

  it('NEGATIVE CONTROL: OUTSIDE a unit the emission is immediate — autocommit already committed', () => {
    put('a');
    broadcast(evt());
    expect(seen).toEqual(['agent:status']);
  });

  it('order is preserved across the deferral', () => {
    withUnit(() => {
      broadcast({ type: 'agent:status', data: { agentId: 'a', status: 'idle' } } as Parameters<typeof broadcast>[0]);
      broadcast({ type: 'agent:deleted', data: { agentId: 'b' } } as Parameters<typeof broadcast>[0]);
    });
    expect(seen).toEqual(['agent:status', 'agent:deleted']);
  });

  it('a NESTED unit does not release the emission early', () => {
    withUnit(() => {
      withUnit(() => { broadcast(evt()); });
      // The inner unit returned, but a savepoint release is not a commit.
      expect(seen).toEqual([]);
    });
    expect(seen).toEqual(['agent:status']);
  });
});
