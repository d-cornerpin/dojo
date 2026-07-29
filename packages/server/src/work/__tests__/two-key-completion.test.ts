// PHASE-2 T8T — TWO-KEY COMPLETION, THE RULED SHAPE (progress.md RULING 1).
//
// Research 19 §1c wanted one trigger: `state='complete'` requires an upheld adjudication.
// It is unlandable verbatim (T8a report §7): OR1 folded asks, commitments and occurrences
// onto the SAME `work` table, and 83 ask rows had reached `done` against an EMPTY
// `adjudications`, so an unscoped trigger aborts every ask closure T3/T5 built.
//
// RULING 1 is what this file proves, clause by clause:
//   * the trigger is scoped to `kind IN ('task','project')`;
//   * `transition()` files the `claim_state='done'` adjudication IN THE SAME TRANSACTION
//     when the closer is an authority (`owner`/`pm`) or a system closer
//     (`engine`/`scheduler`/`healer`), whose close G7 has already forced to point at a
//     delivery that exists;
//   * the AGENT's own close is Key 1 and only Key 1 — recorded as a request, state unmoved.
//
// And the property RULING 1 does NOT state but must not break: the PM's key still turns.
// `complete_validated` is the PM's verdict, not the trigger's key, so a system close leaves
// it 0 and the validation queue still sees the row (owner ruling 2026-07-19,
// `tracker/tools.ts:256-270`; migration `108`'s demolished forgery is the landmine).

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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-two-key-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import { transition, type WorkKind } from '../store.js';
import { validatedExpr } from '../tracker-view.js';

const AGENT = 'kevin';
const T = 1_700_000_000_000;

function seedWork(id: string, over: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id, kind: 'task', parent_id: null, agent_id: AGENT, assignee_agent: null,
    requester: 'owner', requester_id: 'owner', conversation_id: null,
    root_kind: 'tracker', root_id: '', state: 'claimed', claimed_by_turn: null,
    result_delivery_id: null, intent: 'do-it', wakes: 1, closes_thread: 0,
    hop_count: 0, superseded_by: null, title: 'a thing', goal: null, priority: 'normal',
    notes: null, remaining_children: null, compile_pending: 0, ttl_at: null,
    reply_conversation_id: null, attempts: 0, next_attempt_at: null, schedule_json: null,
    tz: null, anchor_local: null, next_run_at: null, sequence: null,
    opened_at: T, closed_at: null, updated_at: T, provenance: 'live', ...over,
  };
  const cols = Object.keys(row);
  mockDb.current!.prepare(
    `INSERT INTO work (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`,
  ).run(row);
}

const adjudications = (id: string) =>
  mockDb.current!.prepare(
    'SELECT claim_state, verdict, by_agent FROM adjudications WHERE work_id = ? ORDER BY id',
  ).all(id) as Array<{ claim_state: string; verdict: string; by_agent: string }>;

const stateOf = (id: string) =>
  (mockDb.current!.prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string }).state;

const events = (id: string) =>
  mockDb.current!.prepare('SELECT kind FROM work_events WHERE work_id = ? ORDER BY id')
    .all(id) as Array<{ kind: string }>;

/** `complete_validated` as every production reader computes it. */
const completeValidated = (id: string): number =>
  (mockDb.current!.prepare(
    `SELECT ${validatedExpr('w', 'done')} AS v FROM work w WHERE w.id = ?`,
  ).get(id) as { v: number }).v;

beforeEach(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.prepare(
    `INSERT INTO deliveries (id, agent_id, tool, channel, outcome)
     VALUES ('d-1', ?, 'send_message', 'imessage', 'delivered')`,
  ).run(AGENT);
});

// ════════════════════════════════════════════════════════════════════════════════
// 1 — THE KEY TURNS: authority closers and system closers
// ════════════════════════════════════════════════════════════════════════════════

describe('RULING 1 — who turns the second key', () => {
  it('an OWNER close applies and files EXACTLY ONE upheld done adjudication', () => {
    seedWork('w1');
    const r = transition('w1', {
      to: 'done', by: 'owner', actorId: 'user', claim: 'authoritative',
      reason: 'dashboard close', resultDeliveryId: 'd-1',
    });
    expect(r.kind).toBe('applied');
    expect(stateOf('w1')).toBe('done');
    expect(adjudications('w1')).toEqual([
      { claim_state: 'done', verdict: 'upheld', by_agent: 'user' },
    ]);
  });

  it('a PM close applies and files exactly one', () => {
    seedWork('w1');
    const r = transition('w1', {
      to: 'done', by: 'pm', actorId: 'pm-agent', claim: 'authoritative',
      reason: 'PM validated the close', resultDeliveryId: 'd-1',
    });
    expect(r.kind).toBe('applied');
    expect(adjudications('w1')).toHaveLength(1);
  });

  it.each(['engine', 'scheduler', 'healer'] as const)(
    'a %s close applies and files exactly one, stamped with the ROLE not the actor id',
    (by) => {
      seedWork('w1');
      const r = transition('w1', {
        to: 'done', by, actorId: AGENT, reason: 'delivery-receipt close',
        evidenceRef: 'd-1', resultDeliveryId: 'd-1',
      });
      expect(r.kind).toBe('applied');
      expect(adjudications('w1')).toEqual([
        { claim_state: 'done', verdict: 'upheld', by_agent: by },
      ]);
    },
  );
});

// ════════════════════════════════════════════════════════════════════════════════
// 2 — THE AGENT'S OWN CLOSE IS KEY 1 AND ONLY KEY 1
// ════════════════════════════════════════════════════════════════════════════════

describe("RULING 1 — the agent's own close stays a Key-1 request", () => {
  it.each(['task', 'project'] as const)(
    'an agent closing a %s files NO adjudication, records ONE request, and the state does not move',
    (kind) => {
      seedWork('w1', { kind });
      const r = transition('w1', {
        to: 'done', by: 'agent', actorId: AGENT,
        reason: 'work_update(action="status") -> complete', resultDeliveryId: 'd-1',
      });
      expect(r.kind).toBe('rejected');
      if (r.kind !== 'rejected') return;
      expect(r.gate).toBe('requires-validation');
      expect(stateOf('w1')).toBe('claimed');
      expect(adjudications('w1')).toEqual([]);
      expect(events('w1').map((e) => e.kind)).toEqual(['validation_requested']);
    },
  );

  it('the refusal is the SAME shape that an authority applies — the gate, not the row', () => {
    seedWork('w1');
    expect(transition('w1', {
      to: 'done', by: 'agent', reason: 'done', resultDeliveryId: 'd-1',
    }).kind).toBe('rejected');
    // one detail corrected — the closer — and the identical call applies.
    expect(transition('w1', {
      to: 'done', by: 'owner', claim: 'authoritative', reason: 'done', resultDeliveryId: 'd-1',
    }).kind).toBe('applied');
  });

  it('an agent close with a claim of requests-validation lands the same request, once', () => {
    seedWork('w1');
    const r = transition('w1', {
      to: 'done', by: 'agent', claim: 'requests-validation',
      reason: 'sent it', resultDeliveryId: 'd-1',
    });
    expect(r.kind).toBe('rejected');
    expect(events('w1').map((e) => e.kind)).toEqual(['validation_requested']);
  });

  it('the request still runs G7 first: no delivery is refused as no-delivery, not as a request', () => {
    seedWork('w1');
    const r = transition('w1', { to: 'done', by: 'agent', reason: 'trust me' });
    expect(r.kind).toBe('rejected');
    if (r.kind !== 'rejected') return;
    expect(r.gate).toBe('done-requires-delivery');
    expect(events('w1')).toEqual([]);       // a work claim nobody delivered is not a Key-1 filing
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 3 — NEGATIVE CONTROLS PER KIND: asks, commitments and occurrences close by DELIVERY
// ════════════════════════════════════════════════════════════════════════════════

describe('RULING 1 — the other three kinds keep closing by delivery', () => {
  it.each(['ask', 'commitment', 'occurrence'] as const)(
    'an agent closing a %s applies, with no adjudication anywhere',
    (kind: WorkKind) => {
      seedWork('w1', { kind });
      const r = transition('w1', {
        to: 'done', by: 'agent', reason: 'delivered', resultDeliveryId: 'd-1',
      });
      expect(r.kind).toBe('applied');
      expect(stateOf('w1')).toBe('done');
      expect(adjudications('w1')).toEqual([]);
    },
  );

  // `kind='task'` is NOT the same set as "the tracker's rows", and this control is why the
  // rehearsal existed. T4's fan-out opens its countdown children as `kind='task'` under
  // `root_kind='a2a_thread'`, and `store.ts:landPiece` settles each one `by: 'agent'` when
  // the peer's answer arrives. Seventeen such rows were sitting on the box when this landed;
  // a trigger scoped on `kind` alone aborts every one of those landings.
  it('a DELEGATION JOIN PIECE is kind=task and still closes — it is not a board row', () => {
    seedWork('w1', { kind: 'task', root_kind: 'a2a_thread', root_id: 'thread-x' });
    const r = transition('w1', {
      to: 'done', by: 'agent', actorId: 'a2a',
      reason: 'the delegated piece came back', resultDeliveryId: 'd-1',
    });
    expect(r.kind).toBe('applied');
    expect(adjudications('w1')).toEqual([]);
  });

  it.each(['legacy', 'tracker', 'engine_scaffold', 'something-nobody-invented-yet'] as const)(
    "but root_kind='%s' is a board row and the agent's close is still a request",
    (rootKind) => {
      seedWork('w1', { kind: 'task', root_kind: rootKind });
      expect(transition('w1', {
        to: 'done', by: 'agent', reason: 'closing', resultDeliveryId: 'd-1',
      }).kind).toBe('rejected');
    },
  );
});

// ════════════════════════════════════════════════════════════════════════════════
// 4 — THE TRIGGER ITSELF (migration 139), reached by RAW SQL so the gate above cannot
//     be what is being measured
// ════════════════════════════════════════════════════════════════════════════════

describe('migration 139 — the two_key_completion trigger', () => {
  const rawClose = (id: string) =>
    mockDb.current!.prepare(
      "UPDATE work SET state = 'done', result_delivery_id = 'd-1', closed_at = ? WHERE id = ?",
    ).run(Date.now(), id);

  it('is declared', () => {
    const row = mockDb.current!.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name='two_key_completion'",
    ).get() as { name: string } | undefined;
    expect(row?.name).toBe('two_key_completion');
  });

  it.each(['task', 'project'] as const)(
    'ABORTS a raw %s close with no adjudication', (kind) => {
      seedWork('w1', { kind });
      expect(() => rawClose('w1')).toThrow(/two-key/);
      expect(stateOf('w1')).toBe('claimed');
    },
  );

  it.each(['ask', 'commitment', 'occurrence'] as const)(
    'IGNORES a raw %s close — the kinds OR1 folded onto the same table', (kind) => {
      seedWork('w1', { kind });
      expect(() => rawClose('w1')).not.toThrow();
      expect(stateOf('w1')).toBe('done');
    },
  );

  it('passes once an upheld done adjudication exists', () => {
    seedWork('w1');
    mockDb.current!.prepare(
      `INSERT INTO adjudications (work_id, claim_state, verdict, by_agent, created_at)
       VALUES ('w1', 'done', 'upheld', 'pm', ?)`,
    ).run(Date.now());
    expect(() => rawClose('w1')).not.toThrow();
    expect(stateOf('w1')).toBe('done');
  });

  it('a REJECTED adjudication is not a key', () => {
    seedWork('w1');
    mockDb.current!.prepare(
      `INSERT INTO adjudications (work_id, claim_state, verdict, by_agent, created_at)
       VALUES ('w1', 'done', 'rejected', 'pm', ?)`,
    ).run(Date.now());
    expect(() => rawClose('w1')).toThrow(/two-key/);
  });

  it('an adjudication for a DIFFERENT claim state is not a key', () => {
    seedWork('w1');
    mockDb.current!.prepare(
      `INSERT INTO adjudications (work_id, claim_state, verdict, by_agent, created_at)
       VALUES ('w1', 'blocked', 'upheld', 'pm', ?)`,
    ).run(Date.now());
    expect(() => rawClose('w1')).toThrow(/two-key/);
  });

  it('a STALE key from a previous close does not open the next one', () => {
    // The row was closed, adjudicated, reopened. The adjudication survives (history is not
    // erased) — but it belongs to the close that already happened, so the NEXT close needs
    // its own. Same freshness window `validatedExpr` uses for the flag it replaced.
    seedWork('w1');
    transition('w1', {
      to: 'done', by: 'owner', claim: 'authoritative', reason: 'first close', resultDeliveryId: 'd-1',
    });
    transition('w1', { to: 'open', by: 'owner', claim: 'authoritative', reason: 'reopened' });
    expect(stateOf('w1')).toBe('open');
    expect(adjudications('w1')).toHaveLength(2);   // the close's, and the reopen's
    const again = transition('w1', {
      to: 'done', by: 'agent', reason: 'closing again', resultDeliveryId: 'd-1',
    });
    expect(again.kind).toBe('rejected');
    expect(stateOf('w1')).toBe('open');
  });

  it('does not fire on an UPDATE that leaves the state alone', () => {
    seedWork('w1', { state: 'done', result_delivery_id: 'd-1', closed_at: T });
    expect(() => mockDb.current!.prepare("UPDATE work SET title = 'renamed' WHERE id = ?").run('w1'))
      .not.toThrow();
  });

  it('does not fire on INSERT — a migration backfilling done rows is not a close', () => {
    expect(() => seedWork('w2', { state: 'done', result_delivery_id: 'd-1', closed_at: T }))
      .not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 5 — THE PM'S KEY STILL TURNS (the property RULING 1 must not silently retire)
// ════════════════════════════════════════════════════════════════════════════════

describe("the trigger's key and the PM's verdict are different questions", () => {
  it('a SYSTEM close reaches done with complete_validated STILL 0 — the queue still sees it', () => {
    seedWork('w1');
    expect(transition('w1', {
      to: 'done', by: 'engine', actorId: AGENT, reason: 'strike-0 receipt close',
      evidenceRef: 'd-1', resultDeliveryId: 'd-1',
    }).kind).toBe('applied');
    expect(stateOf('w1')).toBe('done');
    expect(completeValidated('w1')).toBe(0);
  });

  it("and the PM's own uphold then turns it to 1", async () => {
    seedWork('w1');
    transition('w1', {
      to: 'done', by: 'engine', actorId: AGENT, reason: 'strike-0 receipt close',
      evidenceRef: 'd-1', resultDeliveryId: 'd-1',
    });
    const { upholdClaim } = await import('../tracker-store.js');
    upholdClaim('w1', 'done', 'pm', 'pm-agent', 'PM validated the close against the goal');
    expect(completeValidated('w1')).toBe(1);
  });

  it("an AUTHORITY's own close is validated on arrival — he IS the verdict", () => {
    seedWork('w1');
    transition('w1', {
      to: 'done', by: 'owner', actorId: 'user', claim: 'authoritative',
      reason: 'dashboard close', resultDeliveryId: 'd-1',
    });
    expect(completeValidated('w1')).toBe(1);
  });

  it('the engine can still uphold a BLOCKED claim — the scoping is done-only', () => {
    seedWork('w1');
    transition('w1', { to: 'blocked', by: 'engine', reason: 'waiting on a person', evidenceRef: 'd-1' });
    mockDb.current!.prepare(
      `INSERT INTO adjudications (work_id, claim_state, verdict, by_agent, created_at)
       VALUES ('w1', 'blocked', 'upheld', 'engine', ?)`,
    ).run(Date.now());
    const v = (mockDb.current!.prepare(
      `SELECT ${validatedExpr('w', 'blocked')} AS v FROM work w WHERE w.id = ?`,
    ).get('w1') as { v: number }).v;
    expect(v).toBe(1);
  });
});
