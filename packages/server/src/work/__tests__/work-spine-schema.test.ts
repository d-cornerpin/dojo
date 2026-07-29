// PHASE-2 T2 Step 4 — the work spine's constraints, each proven to BITE.
//
// A CHECK that never bit is not a guard, so every constraint in migration 135 gets a
// negative control (the thing it must refuse) AND a positive control (the neighbouring
// thing it must still accept). The positive halves are what stop a constraint from
// passing its negative test by refusing everything.
//
// The schema comes from the REAL migration chain, never a hand-rolled fixture: a fixture
// drifts, and this file's whole job is to describe what actually ships.

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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-work-spine-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';

const AGENT = 'agent-under-test';
const OPENED = 1_700_000_000_000;

function baseRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'w-' + Math.random().toString(36).slice(2),
    kind: 'task', parent_id: null, agent_id: AGENT, assignee_agent: null,
    requester: 'agent', requester_id: AGENT, conversation_id: null,
    root_kind: 'ask', root_id: 'r1', state: 'open', claimed_by_turn: null,
    result_delivery_id: null, intent: 'do-the-thing', wakes: 0, closes_thread: 0,
    hop_count: 0, superseded_by: null, title: 't', goal: null, priority: null, notes: null,
    remaining_children: null, compile_pending: 0, ttl_at: null, reply_conversation_id: null,
    attempts: 0, next_attempt_at: null, schedule_json: null, tz: null, anchor_local: null,
    next_run_at: null, sequence: null, opened_at: OPENED, closed_at: null,
    updated_at: OPENED, provenance: 'live',
    ...over,
  };
}

function insertWork(row: Record<string, unknown>): void {
  const cols = Object.keys(row);
  mockDb.current!.prepare(
    `INSERT INTO work (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`,
  ).run(row);
}

/** The whole point of the file: assert the DB REFUSES, and that it refuses for the stated
 *  reason rather than for some incidental NOT NULL further down the row. */
function refuses(row: Record<string, unknown>, because: RegExp): void {
  expect(() => insertWork(row)).toThrow(because);
}

beforeEach(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.prepare(
    `INSERT INTO deliveries (id, agent_id, tool, channel, outcome)
     VALUES ('d-real', ?, 'send_message', 'imessage', 'delivered')`,
  ).run(AGENT);
});

describe('migration 135: the work table exists with its declared shape', () => {
  it('creates work, work_events and adjudications', () => {
    const names = mockDb.current!.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('work','work_events','adjudications') ORDER BY name",
    ).all() as Array<{ name: string }>;
    expect(names.map((n) => n.name)).toEqual(['adjudications', 'work', 'work_events']);
  });

  // RE-EXPRESSED AT PHASE-2 T10. `135` renamed `tasks`/`projects` to `legacy_*` so a reader
  // nobody re-pointed would fail loud rather than read a stale twin; this clause asserted both
  // halves of that rename. `141` then DROPPED `legacy_tasks`, which is the rename's whole
  // purpose arriving — so asserting the retirement name still exists would pin the interim.
  // Both requirements are asserted, at the end state each has reached.
  // Re-expressed twice, and the history is the point. `135` renamed `tasks`/`projects` to
  // `legacy_*` so an un-re-pointed reader would fail loud instead of reading a stale twin;
  // `141` dropped `legacy_tasks`; `142` rebuilt `techniques` onto the spine and dropped
  // `legacy_projects` — the survivor that the previous version of this clause deliberately
  // pinned as a decision rather than a leftover. All four names are gone now, which is the
  // rename's whole purpose arriving.
  it('every legacy tracker table name is gone, and techniques points at the spine', () => {
    const db = mockDb.current!;
    const gone = db.prepare(
      "SELECT count(*) c FROM sqlite_master WHERE type='table' AND name IN ('tasks','projects','legacy_tasks','legacy_projects')",
    ).get() as { c: number };
    expect(gone.c).toBe(0);

    // The reason `legacy_projects` could not go with `legacy_tasks`, now discharged: this FK
    // was its last dependent. Asserted rather than assumed, because a rebuild that quietly
    // kept the old parent would still pass every row-count check.
    const techniques = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='techniques'",
    ).get() as { sql: string }).sql;
    expect(techniques).not.toMatch(/legacy_projects/);
    expect(techniques).toMatch(/build_project_id\s+TEXT\s+REFERENCES\s+work\(id\)/);
    // NEGATIVE CONTROL: the rebuild must not have dropped the OTHER foreign key on its way.
    expect(techniques).toMatch(/build_squad_id\s+TEXT\s+REFERENCES\s+agent_groups\(id\)/);
    // and the scratch table used by the rebuild is not left standing
    expect((db.prepare(
      "SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='techniques_new'",
    ).get() as { c: number }).c).toBe(0);
  });

  it('gives work.agent_id NO foreign key — a terminated agent must not take its work with it (T0 D1)', () => {
    const fks = mockDb.current!.prepare("SELECT * FROM pragma_foreign_key_list('work')")
      .all() as Array<{ table: string; from: string }>;
    expect(fks.some((f) => f.from === 'agent_id')).toBe(false);
    // ...and the FKs that SHOULD be there are, so this is not passing because the table has none.
    expect(fks.map((f) => f.from).sort()).toEqual(['conversation_id', 'parent_id', 'result_delivery_id']);
  });

  it('carries no media-job columns — a generation job is not a work row (T0 D3)', () => {
    const cols = (mockDb.current!.prepare("SELECT name FROM pragma_table_info('work')")
      .all() as Array<{ name: string }>).map((c) => c.name);
    for (const forbidden of ['provider_job_id', 'asset_path', 'asset_mime', 'attempt_count', 'cost_usd']) {
      expect(cols).not.toContain(forbidden);
    }
  });
});

describe('every CHECK bites', () => {
  it('POSITIVE CONTROL: a well-formed open row is accepted', () => {
    expect(() => insertWork(baseRow())).not.toThrow();
  });

  it('done REQUIRES a delivery', () => {
    refuses(baseRow({ state: 'done', closed_at: OPENED }), /result_delivery_id IS NOT NULL/);
    expect(() => insertWork(baseRow({ state: 'done', closed_at: OPENED, result_delivery_id: 'd-real' })))
      .not.toThrow();
  });

  it('terminal state and closed_at are the same fact, in both directions', () => {
    refuses(baseRow({ state: 'abandoned', closed_at: null }), /closed_at IS NOT NULL/);
    refuses(baseRow({ state: 'open', closed_at: OPENED }), /closed_at IS NOT NULL/);
    expect(() => insertWork(baseRow({ state: 'failed', closed_at: OPENED }))).not.toThrow();
    expect(() => insertWork(baseRow({ state: 'paused', closed_at: null }))).not.toThrow();
  });

  it('a project may not have a parent', () => {
    insertWork(baseRow({ id: 'parent-1', kind: 'project' }));
    refuses(baseRow({ kind: 'project', parent_id: 'parent-1' }), /kind <> 'project'/);
    // a TASK under the same parent is fine — the rule is about projects, not about parents
    expect(() => insertWork(baseRow({ kind: 'task', parent_id: 'parent-1' }))).not.toThrow();
  });

  it('the five kinds are the only kinds', () => {
    refuses(baseRow({ kind: 'epic' }), /kind IN/);
    for (const k of ['ask', 'task', 'project', 'occurrence', 'commitment']) {
      expect(() => insertWork(baseRow({ kind: k }))).not.toThrow();
    }
  });

  it('the eight states are the only states — and in_progress is NOT one of them', () => {
    refuses(baseRow({ state: 'in_progress' }), /state IN/);
    refuses(baseRow({ state: 'complete' }), /state IN/);
    refuses(baseRow({ state: 'fallen' }), /state IN/);
    for (const s of ['open', 'claimed', 'paused', 'blocked', 'on_deck']) {
      expect(() => insertWork(baseRow({ state: s }))).not.toThrow();
    }
  });

  it('requester is one of four, and it is required', () => {
    refuses(baseRow({ requester: 'robot' }), /requester IN/);
    refuses(baseRow({ requester: null }), /NOT NULL/);
    for (const r of ['owner', 'agent', 'schedule', 'watcher']) {
      expect(() => insertWork(baseRow({ requester: r }))).not.toThrow();
    }
  });

  it('provenance keeps all three values and refuses a fourth (T0 D1 rider 3)', () => {
    refuses(baseRow({ provenance: 'invented' }), /provenance IN/);
    for (const p of ['live', 'migrated', 'rescued']) {
      expect(() => insertWork(baseRow({ provenance: p }))).not.toThrow();
    }
  });

  it('opened_at refuses a seconds-valued timestamp (the 1000x class)', () => {
    refuses(baseRow({ opened_at: 1_700_000_000 }), /opened_at > 1600000000000/);
    expect(() => insertWork(baseRow({ opened_at: 1_600_000_000_001 }))).not.toThrow();
  });

  it('intent has NO default — the writer must say (the FYI default killed wakes)', () => {
    refuses(baseRow({ intent: null }), /NOT NULL constraint failed: work\.intent/);
    const cols = mockDb.current!.prepare("SELECT name, dflt_value FROM pragma_table_info('work')")
      .all() as Array<{ name: string; dflt_value: string | null }>;
    expect(cols.find((c) => c.name === 'intent')!.dflt_value).toBeNull();
  });

  it('wakes and closes_thread are INDEPENDENT and both required', () => {
    refuses(baseRow({ wakes: null }), /NOT NULL constraint failed: work\.wakes/);
    refuses(baseRow({ closes_thread: null }), /NOT NULL constraint failed: work\.closes_thread/);
    expect(() => insertWork(baseRow({ wakes: 1, closes_thread: 0 }))).not.toThrow();
    expect(() => insertWork(baseRow({ wakes: 0, closes_thread: 1 }))).not.toThrow();
  });

  it('agent_id, root_kind, root_id and updated_at are all required', () => {
    refuses(baseRow({ agent_id: null }), /NOT NULL constraint failed: work\.agent_id/);
    refuses(baseRow({ root_kind: null }), /NOT NULL constraint failed: work\.root_kind/);
    refuses(baseRow({ root_id: null }), /NOT NULL constraint failed: work\.root_id/);
    refuses(baseRow({ updated_at: null }), /NOT NULL constraint failed: work\.updated_at/);
  });
});

describe('occurrence uniqueness — "execute once" as a constraint', () => {
  it('refuses a second occurrence on the same (parent, sequence), and is scoped to occurrences', () => {
    insertWork(baseRow({ id: 'sched-1', kind: 'commitment' }));
    insertWork(baseRow({ id: 'occ-a', kind: 'occurrence', parent_id: 'sched-1', sequence: 1 }));
    expect(() => insertWork(baseRow({ id: 'occ-b', kind: 'occurrence', parent_id: 'sched-1', sequence: 1 })))
      .toThrow(/UNIQUE/);
    // a DIFFERENT sequence under the same parent is the normal case
    expect(() => insertWork(baseRow({ id: 'occ-c', kind: 'occurrence', parent_id: 'sched-1', sequence: 2 })))
      .not.toThrow();
    // and a non-occurrence may reuse the pair: the index is partial on purpose
    expect(() => insertWork(baseRow({ id: 'task-x', kind: 'task', parent_id: 'sched-1', sequence: 1 })))
      .not.toThrow();
  });
});

describe('the turns split', () => {
  const insertTurn = (over: Record<string, unknown> = {}): void => {
    const row = {
      agent_id: AGENT, turn_number: Math.floor(Math.random() * 1e9), kind: 'user',
      subject_kind: 'conv', subject_id: 'c1', root_kind: 'ask', root_id: 'r',
      source_message_id: null, conv_key: null, started_at: '2026-07-28 00:00:00',
      ended_at: null, exit_reason: null, answered: 0, effectful_calls: 0,
      answer_message_id: null, lane: null, ...over,
    };
    const cols = Object.keys(row);
    mockDb.current!.prepare(
      `INSERT INTO turns (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`,
    ).run(row);
  };

  it('drops outcome and carries exit_reason + answered + effectful_calls', () => {
    const cols = (mockDb.current!.prepare("SELECT name FROM pragma_table_info('turns')")
      .all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).not.toContain('outcome');
    expect(cols).toEqual(expect.arrayContaining(['exit_reason', 'answered', 'effectful_calls']));
  });

  it('accepts all 17 exit reasons and refuses an eighteenth', () => {
    const REASONS = ['answered', 'no_reply_intended', 'park', 'handoff', 'delegation_exit',
      'iteration_cap', 'brake', 'identical_call', 'stop', 'preempt', 'provider_error',
      'stream_idle', 'abort', 'terminated', 'budget', 'compile_pending', 'unknown'];
    expect(REASONS.length).toBe(17);
    REASONS.forEach((r, i) => {
      expect(() => insertTurn({ turn_number: 1000 + i, ended_at: '2026-07-28 00:01:00', exit_reason: r }))
        .not.toThrow();
    });
    // 'no_reply' was the OLD vocabulary; it must not survive as a silent synonym
    expect(() => insertTurn({ ended_at: '2026-07-28 00:01:00', exit_reason: 'no_reply' }))
      .toThrow(/exit_reason/);
    expect(() => insertTurn({ ended_at: '2026-07-28 00:01:00', exit_reason: 'error' }))
      .toThrow(/exit_reason/);
  });

  it('a turn that ended without recording why is unrepresentable, in both directions', () => {
    expect(() => insertTurn({ ended_at: '2026-07-28 00:01:00' })).toThrow(/ended_at IS NULL/);
    expect(() => insertTurn({ exit_reason: 'stop' })).toThrow(/ended_at IS NULL/);
    expect(() => insertTurn({ ended_at: '2026-07-28 00:01:00', exit_reason: 'stop' })).not.toThrow();
    expect(() => insertTurn({})).not.toThrow();       // an OPEN turn is legal
  });

  it('answered is 0/1, NOT NULL, and has no default', () => {
    expect(() => insertTurn({ answered: 2 })).toThrow(/answered IN \(0,1\)/);
    expect(() => insertTurn({ answered: null })).toThrow(/NOT NULL constraint failed: turns\.answered/);
    const col = (mockDb.current!.prepare("SELECT name, dflt_value FROM pragma_table_info('turns')")
      .all() as Array<{ name: string; dflt_value: string | null }>).find((c) => c.name === 'answered')!;
    expect(col.dflt_value).toBeNull();
  });

  it('refuses a duplicate (agent_id, turn_number) — the ON CONFLICT DO UPDATE is gone', () => {
    insertTurn({ turn_number: 7 });
    expect(() => insertTurn({ turn_number: 7 })).toThrow(/UNIQUE|PRIMARY/);
  });
});
