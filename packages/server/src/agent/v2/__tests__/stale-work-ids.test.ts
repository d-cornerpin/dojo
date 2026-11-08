// PHASE-6 T0D Step 1 arm (c): SESSION CONTEXT STOPS CARRYING DEAD IDS.
//
// The other half of the stale-task-id class, and the half the issues-log item
// actually names: "session context must not carry dead task ids". Measured at
// the phase base, it did, in two places, and both of them could REFUSE the
// agent's own live tool calls on the strength of a row that is not there.
//
//  (c) `currentTurnServedWork` is set from the engine event's task referent. The
//      row was already queried for its kind — and the map was set even when that
//      query came back EMPTY, publishing a dead id to turn-state for the rest of
//      the turn.
//
// THE BOUNDARY THIS FILE RESPECTS: collapsing the ambient turn-state maps into
// `TurnContext` is PHASE-6 T1's, and nothing here moves a map. This is the
// validation half only — T1 re-verifies it once the maps collapse.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-stale-work-ids-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../../db/migrations.js';
import { resolveServedWork } from '../stale-work-ids.js';
import { FXID } from '../../../../../../deploy/checks/fixture-vocabulary.mjs';

const AGENT = FXID.n4;
const T = 1_700_000_000_000;

function seedWork(id: string, over: Record<string, unknown> = {}): void {
  const row = {
    id, kind: 'task', parent_id: null, agent_id: AGENT, assignee_agent: null,
    requester: 'owner', requester_id: 'owner', conversation_id: null,
    root_kind: 'tracker', root_id: id, state: 'open', claimed_by_turn: null,
    result_delivery_id: null, intent: 'tracker', wakes: 1, closes_thread: 0,
    hop_count: 0, superseded_by: null, title: 'a thing', task_kind: null,
    origin_conv_key: null, opened_at: T, closed_at: null, updated_at: T,
    provenance: 'live', ...over,
  };
  const cols = Object.keys(row);
  mockDb.current!.prepare(
    `INSERT INTO work (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`,
  ).run(row);
}

beforeEach(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
});

describe('(c) the turn does not publish a served work id that is not there', () => {
  it('resolves a live task to its kind and origin', () => {
    seedWork('w-served', { task_kind: 'reminder', origin_conv_key: 'ck-1' });
    const served = resolveServedWork('w-served', 'run-9');
    expect(served).toEqual({
      taskId: 'w-served', runId: 'run-9', taskKind: 'reminder', originConvKey: 'ck-1',
    });
  });

  it('returns null for a task id whose row does not exist', () => {
    // The pre-fix code set the map ANYWAY, with `taskKind: null` — which is not
    // "no served work", it is "served work whose kind we could not read", and
    // three readers downstream treat those two differently.
    expect(resolveServedWork('w-deleted', 'run-9')).toBeNull();
  });

  it('returns null when there is no task referent at all', () => {
    expect(resolveServedWork(null, 'run-9')).toBeNull();
    expect(resolveServedWork(undefined, null)).toBeNull();
  });

  it('carries a live row with NO kind, which is a different fact from no row', () => {
    seedWork('w-plain');
    expect(resolveServedWork('w-plain', null)).toEqual({
      taskId: 'w-plain', runId: null, taskKind: null, originConvKey: null,
    });
  });
});
