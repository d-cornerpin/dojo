// PHASE-6 T0D Step 1 arms (b) and (c) — SESSION CONTEXT STOPS CARRYING DEAD IDS.
//
// The other half of the stale-task-id class, and the half the issues-log item
// actually names: "session context must not carry dead task ids". Measured at
// the phase base, it did, in two places, and both of them could REFUSE the
// agent's own live tool calls on the strength of a row that is not there.
//
//  (b) `danglingTaskIds` is armed once at turn start from a live query and then
//      re-read at end of turn. The re-query asked `state = 'claimed'` and every
//      id that did not come back was reclassified as an ON-DECK STRAGGLER — so a
//      DELETED id was indistinguishable from a live on-deck row and was carried
//      forward as one. The same list then refuses every non-close-out tool call
//      for the rest of the turn, naming ids the tracker verbs will (correctly)
//      refuse in their turn: the agent is told to close a task that cannot be
//      closed because it does not exist.
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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-stale-work-ids-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../../db/migrations.js';
import { splitDanglers, survivingDanglers, closeOutGateDecision, resolveServedWork } from '../stale-work-ids.js';

const AGENT = 'kevin';
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

describe('(b) a dangling id whose row is gone is DROPPED, not reclassified', () => {
  it('sorts each id into exactly one bucket, and the buckets add up', () => {
    seedWork('d-claimed', { state: 'claimed' });
    seedWork('d-ondeck', { state: 'on_deck' });
    seedWork('d-open', { state: 'open' });
    const ids = ['d-claimed', 'd-ondeck', 'd-open', 'd-deleted'];

    const split = splitDanglers(ids);
    expect(split.claimed).toEqual(['d-claimed']);
    // The pre-fix behaviour put `d-deleted` HERE, beside a live straggler.
    expect(split.onDeck).toEqual(['d-ondeck', 'd-open']);
    expect(split.gone).toEqual(['d-deleted']);
    // A denominator, not a sample: nothing may be lost or double-counted.
    expect(split.claimed.length + split.onDeck.length + split.gone.length).toBe(ids.length);
  });

  it('survivors keep the caller’s order and exclude every id whose row is gone', () => {
    seedWork('d-1', { state: 'claimed' });
    seedWork('d-3', { state: 'on_deck' });
    expect(survivingDanglers(['d-1', 'd-2', 'd-3'])).toEqual(['d-1', 'd-3']);
  });

  it('answers an empty list without asking the database (`id IN ()` is a syntax error)', () => {
    const split = splitDanglers([]);
    expect(split).toEqual({ claimed: [], onDeck: [], gone: [] });
    expect(survivingDanglers([])).toEqual([]);
  });

  it('does not refuse a live tool call when every dangler it would name is GONE', () => {
    // The trap, stated as a test. The gate refuses everything the agent calls
    // until it closes one of these tasks — and if they are all deleted, closing
    // one is impossible, so the turn is spent being refused.
    const decision = closeOutGateDecision(['d-deleted-1', 'd-deleted-2'], false, 'file_write');
    expect(decision.refuse).toBe(false);
    expect(decision.live).toEqual([]);
  });

  it('CONTROL: the SAME call IS refused while one dangler is still there', () => {
    // Without this, "it did not refuse" proves nothing — it might refuse nothing.
    seedWork('d-live', { state: 'claimed' });
    const decision = closeOutGateDecision(['d-live', 'd-deleted'], false, 'file_write');
    expect(decision.refuse).toBe(true);
    // ...and the refusal names ONLY the id that exists, so the agent is steered
    // at a task it can actually close.
    expect(decision.live).toEqual(['d-live']);
  });

  it('keeps the gate’s other two conditions exactly as they were', () => {
    seedWork('d-live', { state: 'claimed' });
    // satisfied this turn -> no refusal
    expect(closeOutGateDecision(['d-live'], true, 'file_write').refuse).toBe(false);
    // a close-out operation is allowed through -> no refusal
    expect(closeOutGateDecision(['d-live'], false, 'work_update:status').refuse).toBe(false);
    expect(closeOutGateDecision(['d-live'], false, 'load_tool_docs').refuse).toBe(false);
    // nothing dangling at all -> no refusal, and no query
    expect(closeOutGateDecision([], false, 'file_write').refuse).toBe(false);
  });
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
