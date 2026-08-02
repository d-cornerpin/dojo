// PHASE-4 T5 Step 1 — M7's clear protocol at the tracker's assignee (P706's server half).
//
// P706 is the CLIENT half: the dashboard used `undefined` as a clear-this-field sentinel,
// `JSON.stringify` dropped it, "Unassigned" sent an empty PUT body and unassigning a task was
// impossible. The sentinel is `null` now, which JSON carries.
//
// Making the sentinel sendable exposed the server half, and it is not the shape the plan
// assumed. `updateTask` maps `assignedTo` -> `work.agent_id`, and **`agent_id` is
// `TEXT NOT NULL` on the spine** (`135_work_spine.sql:42`, deliberately, with no FK — its own
// rider). So the fixed client would have turned a silent no-op into a 500:
//
//     SqliteError: NOT NULL constraint failed: work.agent_id
//
// The spine already has the column that means "nobody in particular is assigned" —
// `assignee_agent`, nullable, and `openTrackerTask` sets exactly that pair ("an unassigned
// task belongs to its creator until someone claims it"). So the clear lands there and the
// row keeps a holder, which is what the NOT NULL was protecting.
//
// WHAT THIS TEST DOES NOT CLAIM: that the dashboard dropdown then READS as Unassigned. It
// does not — `tracker-view.ts:352` projects `work.agent_id AS assigned_to`, so the legacy
// `Task.assignedTo` a client renders can never be empty. That projection is a separate change
// with its own blast radius and it is handed up in T5's report, not smuggled in here.

import { describe, it, expect, beforeEach, vi } from 'vitest';
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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-clear-assignee-test', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

import { runMigrations } from '../../db/migrations.js';
import { updateTask } from '../schema.js';

const T = 1_700_000_000_000;

function seedTask(id: string, agentId: string, assignee: string | null): void {
  mockDb.current!.prepare(`
    INSERT INTO work (id, kind, agent_id, assignee_agent, requester, requester_id,
                      root_kind, root_id, state, intent, wakes, closes_thread,
                      title, opened_at, updated_at, provenance)
    VALUES (?, 'task', ?, ?, 'owner', 'owner', 'tracker', ?, 'on_deck', 'tracker', 0, 0,
            'a task', ?, ?, 'live')
  `).run(id, agentId, assignee, id, T, T);
}

const row = (id: string): Record<string, unknown> =>
  mockDb.current!.prepare('SELECT * FROM work WHERE id = ?').get(id) as Record<string, unknown>;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
});

describe("M7 / P706 — the tracker's clear-assignee protocol", () => {
  it('THE DEFECT: an explicit null must clear the assignee, not crash on NOT NULL', () => {
    seedTask('t1', 'kevin', 'kevin');
    expect(() => updateTask('t1', { assignedTo: null })).not.toThrow();
    const r = row('t1');
    expect(r.assignee_agent).toBeNull();
    expect(r.agent_id).toBe('kevin'); // the holder survives; NOT NULL is not violated
  });

  it('CONTROL: a real assignee is still written to agent_id', () => {
    seedTask('t1', 'kevin', 'kevin');
    updateTask('t1', { assignedTo: 'dana' });
    expect(row('t1').agent_id).toBe('dana');
  });

  it('an omitted assignee leaves both columns alone', () => {
    seedTask('t1', 'kevin', 'kevin');
    updateTask('t1', { priority: 'high' });
    const r = row('t1');
    expect(r.agent_id).toBe('kevin');
    expect(r.assignee_agent).toBe('kevin');
    expect(r.priority).toBe('high');
  });
});
