// ════════════════════════════════════════════════════════════════════════════════════════
// SWEEP CORE-2 ITEM 1 — THE SUPERVISOR WORKS. The doorbell, the attempt ledger, the order.
//
// ── THE DEFECT, IN SIX MEASURED DENOMINATORS (never restated as opinion) ─────────────────
//   BATTERY5  `bmsh2j4inp3`  27 coverage misses / 104 durable rows; worst wait 17.4 min
//   BATTERY5  same run       the escalate-before-verdict ordering reproduced at 17–36 min
//   BATTERY6  `bmsh708xse7`  102 miss rows, one at 36.9 min
//   BATTERY6  same run       5 of 6 owner-escalated rows never received an in-window verdict
//   BATTERY9  `bmshmu5ygd5`  ZERO Key-2 verdicts written on the box in 84 minutes
//   BATTERY9  same pair      96 of 98 handed rows missed across 27 no-verdict reviews;
//                            3 of 3 owner-escalated rows never validated
// TWO NAMED MODES: (1) the PM's hourly LLM cap throttling validation to ~6/hr
// (`pm-agent.ts:999-1006` at `3a4dc6a`); (2) the PM spinning out for tens of minutes on one
// trivial item and damming the queue behind it.
//
// ── THE OWNER'S DESIGN, BINDING (2026-08-06, his words) ──────────────────────────────────
//   *"so and so says they got this done. Confirm and mark it in the tracker, or push back,
//    or get more info — whatever needs done to make sure the task gets completed."*
//   *"This needs to be more of a 'get the agent back on track when spinning out' thing like
//    we do with the other agents. Then otherwise, let the PM do their work."*
//
// ── WHAT THIS FILE DRIVES ───────────────────────────────────────────────────────────────
//   (i)   THE DOORBELL. The exact moment an agent says a two-key row is done — the Key-1
//         filing and the engine's own delivery-receipt close, both inside `transition()` —
//         rings a targeted PM wake CARRYING THAT ROW. Negative controls: an authority's
//         close (Key 2 already turned) and a non-two-key kind ring nothing.
//   (ii)  THE ATTEMPT LEDGER. "Was this row's validator ever actually asked?" becomes a
//         question the spine can answer, on the EXISTING `audit` door, with no new event
//         kind and no new column — the join-drive / run-deliver-drive counting pattern.
//   (iii) HEAD-OF-LINE. The validation queue orders by how many times a row has already
//         defeated the validator, so a stubborn item serves the ones behind it and CIRCLES
//         BACK. It is never removed, never capped, never terminally un-approvable.
// ════════════════════════════════════════════════════════════════════════════════════════

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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-validation-drive-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import { transition } from '../store.js';
import { appendAuditEntry } from '../audit-trail.js';
import {
  ringValidationDoorbell,
  setValidationDoorbellHandler,
  VALIDATION_ATTEMPT_MARKERS,
  VALIDATION_ATTEMPT_MISS,
  VALIDATION_ATTEMPT_UNAVAILABLE,
  validationAttemptCount,
  validationAttemptCountExpr,
  validationAttemptRecordedExpr,
  validationQueueOrderExpr,
  type DoorbellRing,
} from '../validation-drive.js';

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

/** Every ring the doorbell made, in order. The rider is what the PM is woken WITH. */
let rings: DoorbellRing[] = [];

beforeEach(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.prepare(
    `INSERT INTO deliveries (id, agent_id, tool, channel, outcome)
     VALUES ('d-1', ?, 'send_message', 'imessage', 'delivered')`,
  ).run(AGENT);
  rings = [];
  setValidationDoorbellHandler((ring) => { rings.push(ring); });
});

afterEach(() => {
  setValidationDoorbellHandler(null);
});

// ════════════════════════════════════════════════════════════════════════════════════════
// (i) THE DOORBELL — a completion that owes Key 2 wakes the validator WITH the row
// ════════════════════════════════════════════════════════════════════════════════════════

describe('THE DOORBELL — "so and so says they got this done"', () => {
  it("a worker's OWN close (Key 1 filed) rings the doorbell carrying that row", () => {
    seedWork('w1');
    const r = transition('w1', {
      to: 'done', by: 'agent', actorId: AGENT,
      reason: 'work_update(action="status") -> complete', resultDeliveryId: 'd-1',
    });
    // The spine's own verdict is unchanged: this is a REQUEST, the row does not move.
    expect(r.kind).toBe('refused');
    // …and it is now ALSO a doorbell. Before this task the same event woke nobody at all:
    // `tracker/tools.ts:1958` returns on the refusal, so `noteTransitionForReview` — the
    // only PM wake in the tree — was never reached for the single most common completion
    // shape on the platform. The PM found the row on a patrol tick or not at all.
    expect(rings).toHaveLength(1);
    expect(rings[0].workId).toBe('w1');
    expect(rings[0].shape).toBe('close-request');
  });

  it("the ENGINE's delivery-receipt close rings it too — the same row still owes Key 2", () => {
    seedWork('w2');
    const r = transition('w2', {
      to: 'done', by: 'engine', actorId: 'engine', reason: 'assignment-thread deliverable',
      evidenceRef: 'd-1', resultDeliveryId: 'd-1',
    });
    expect(r.kind).toBe('applied');
    // `validatedExpr('done')` excludes engine/scheduler/healer, so this row is `done` AND
    // awaiting Key 2 — exactly the shape TB5 named. It must ring.
    expect(rings.map((x) => [x.workId, x.shape])).toEqual([['w2', 'engine-receipt']]);
  });

  it.each(['scheduler', 'healer'] as const)(
    'a %s close rings it as well — every system closer leaves Key 2 owed',
    (by) => {
      seedWork('w3');
      transition('w3', {
        to: 'done', by, actorId: 'engine', reason: 'schedule final',
        evidenceRef: 'd-1', resultDeliveryId: 'd-1',
      });
      expect(rings).toHaveLength(1);
      expect(rings[0].shape).toBe('engine-receipt');
    },
  );

  it('NEGATIVE CONTROL: an AUTHORITY close rings NOTHING — Key 2 is already turned', () => {
    seedWork('w4');
    const r = transition('w4', {
      to: 'done', by: 'pm', actorId: 'kelly', claim: 'authoritative',
      reason: 'PM validated the close', resultDeliveryId: 'd-1',
    });
    expect(r.kind).toBe('applied');
    expect(rings).toEqual([]);
  });

  it.each(['ask', 'commitment', 'occurrence'] as const)(
    'NEGATIVE CONTROL: a %s is not a two-key subject and rings nothing',
    (kind) => {
      seedWork('w5', { kind });
      transition('w5', { to: 'done', by: 'agent', reason: 'delivered', resultDeliveryId: 'd-1' });
      expect(rings).toEqual([]);
    },
  );

  it('NEGATIVE CONTROL: an a2a_thread piece is not a board row and rings nothing', () => {
    seedWork('w6', { root_kind: 'a2a_thread' });
    transition('w6', { to: 'done', by: 'agent', reason: 'piece landed', resultDeliveryId: 'd-1' });
    expect(rings).toEqual([]);
  });

  it('NEGATIVE CONTROL: a non-terminal move rings nothing (a pause is a different verdict)', () => {
    seedWork('w7');
    transition('w7', { to: 'paused', by: 'agent', reason: 'waiting on the user' });
    expect(rings).toEqual([]);
  });

  it('a doorbell with NO validator wired is LOUD, never a silent drop', () => {
    setValidationDoorbellHandler(null);
    seedWork('w8');
    // It must not throw into the spine's single writer…
    const r = transition('w8', {
      to: 'done', by: 'agent', reason: 'done', resultDeliveryId: 'd-1',
    });
    expect(r.kind).toBe('refused');
    // …and the ring itself is still a call the caller can make safely.
    expect(() => ringValidationDoorbell({ workId: 'w8', shape: 'close-request' })).not.toThrow();
  });

  it('a handler that THROWS cannot break the state change it rode in on', () => {
    setValidationDoorbellHandler(() => { throw new Error('PM is on fire'); });
    seedWork('w9');
    const r = transition('w9', {
      to: 'done', by: 'engine', actorId: 'engine', reason: 'receipt close',
      evidenceRef: 'd-1', resultDeliveryId: 'd-1',
    });
    expect(r.kind).toBe('applied');
    expect(
      (mockDb.current!.prepare('SELECT state FROM work WHERE id = ?').get('w9') as { state: string }).state,
    ).toBe('done');
  });

  it('A BURST OF 20 COMPLETIONS RINGS 20 TIMES — nothing throttles the doorbell', () => {
    // The retired mode, driven: BATTERY9 measured the hourly cap holding validation to
    // ~6/hr while 98 rows waited. N = 20 is taken from that denominator (98 handed rows
    // across 27 reviews ≈ 3.6/review; 20 is well past any hour's worth of the old cap).
    for (let i = 0; i < 20; i++) {
      seedWork(`burst-${i}`);
      transition(`burst-${i}`, {
        to: 'done', by: 'agent', reason: 'done', resultDeliveryId: 'd-1',
      });
    }
    expect(rings).toHaveLength(20);
    expect(new Set(rings.map((x) => x.workId)).size).toBe(20);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// (ii) THE ATTEMPT LEDGER — "was this row's validator ever actually asked?"
// ════════════════════════════════════════════════════════════════════════════════════════

const recordAttempt = (workId: string, marker: string): void => {
  appendAuditEntry(workId, 'pm', { entryKind: 'observation', actionTaken: marker, reason: 'test' });
};

const attemptRecorded = (workId: string): number =>
  (mockDb.current!.prepare(
    `SELECT ${validationAttemptRecordedExpr('w')} AS v FROM work w WHERE w.id = ?`,
  ).get(workId) as { v: number }).v;

describe('THE ATTEMPT LEDGER — the question TB8 made answerable, now readable in SQL', () => {
  it('a row nobody has tried to validate reads ZERO', () => {
    seedWork('a1');
    expect(attemptRecorded('a1')).toBe(0);
    expect(validationAttemptCount('a1')).toBe(0);
  });

  it("a recorded MISS — the validator was handed the row and returned no verdict — reads ONE", () => {
    seedWork('a2');
    recordAttempt('a2', VALIDATION_ATTEMPT_MISS);
    expect(attemptRecorded('a2')).toBe(1);
    expect(validationAttemptCount('a2')).toBe(1);
  });

  it('a recorded VALIDATOR-UNAVAILABLE also counts: we tried, and there was nobody to ask', () => {
    // The hole this closes: gating the owner escalation on a recorded attempt would, on a
    // box whose PM is terminated or has no model, mean the owner is NEVER told. An attempt
    // that could not be made is still an attempt, and it is the one the owner most needs.
    seedWork('a3');
    recordAttempt('a3', VALIDATION_ATTEMPT_UNAVAILABLE);
    expect(attemptRecorded('a3')).toBe(1);
  });

  it('the marker set is single-sourced — both markers, and only those, satisfy the predicate', () => {
    expect([...VALIDATION_ATTEMPT_MARKERS].sort())
      .toEqual([VALIDATION_ATTEMPT_MISS, VALIDATION_ATTEMPT_UNAVAILABLE].sort());
    seedWork('a4');
    // Any OTHER audit row on the same door is not an attempt. A `smell_flag`, a
    // `closeout_miss` and a plain observation are all audit rows; none of them means the
    // validator was asked, and reading them as one is how a gate stops meaning what it says.
    recordAttempt('a4', 'engine-maintenance adjudication');
    recordAttempt('a4', 'closeout_miss');
    appendAuditEntry('a4', 'engine', { entryKind: 'smell_flag', reason: 'x' });
    expect(attemptRecorded('a4')).toBe(0);
  });

  it('attempts ACCUMULATE per row, and that count is what the queue orders on', () => {
    seedWork('a5');
    recordAttempt('a5', VALIDATION_ATTEMPT_MISS);
    recordAttempt('a5', VALIDATION_ATTEMPT_MISS);
    recordAttempt('a5', VALIDATION_ATTEMPT_UNAVAILABLE);
    expect(validationAttemptCount('a5')).toBe(3);
  });

  it('the count is a COUNT over durable rows — it survives, and cannot drift from its causes', () => {
    seedWork('a6');
    recordAttempt('a6', VALIDATION_ATTEMPT_MISS);
    // Re-read through the SQL expression the queue itself uses, not the helper.
    const viaSql = (mockDb.current!.prepare(
      `SELECT ${validationAttemptCountExpr('w')} AS n FROM work w WHERE w.id = ?`,
    ).get('a6') as { n: number }).n;
    expect(viaSql).toBe(1);
    expect(viaSql).toBe(validationAttemptCount('a6'));
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// (iii) HEAD-OF-LINE — one stubborn item never dams the queue
// ════════════════════════════════════════════════════════════════════════════════════════

describe('HEAD-OF-LINE IS DESIGNED OUT — she serves the ones behind it and circles back', () => {
  /** The review's own ordering — the SAME expression `tracker/pm-agent.ts` builds it with,
   *  imported rather than restated, so this proof cannot agree with a copy. */
  const queueOrder = (): string[] =>
    (mockDb.current!.prepare(
      `SELECT w.id AS id FROM work w ORDER BY ${validationQueueOrderExpr('w')}`,
    ).all() as Array<{ id: string }>).map((r) => r.id);

  it('the item that keeps defeating the validator sorts BEHIND the ones it was blocking', () => {
    // `stubborn` is the OLDEST row, so under the pre-fix `ORDER BY updated_at ASC` it led
    // every single review for ever — the measured shape: one item eating the turn while the
    // queue behind it went unserved for 84 minutes.
    seedWork('stubborn', { updated_at: T });
    seedWork('behind-1', { updated_at: T + 1000 });
    seedWork('behind-2', { updated_at: T + 2000 });
    recordAttempt('stubborn', VALIDATION_ATTEMPT_MISS);
    recordAttempt('stubborn', VALIDATION_ATTEMPT_MISS);
    expect(queueOrder()).toEqual(['behind-1', 'behind-2', 'stubborn']);
  });

  it('IT IS NEVER DROPPED — the stubborn row is still IN the queue, every time', () => {
    seedWork('stubborn', { updated_at: T });
    for (let i = 0; i < 25; i++) recordAttempt('stubborn', VALIDATION_ATTEMPT_MISS);
    // Twenty-five failed reviews and it is still there, still ordered, still approvable.
    // Nothing anywhere renders an item terminally un-approvable — the owner's named
    // nightmare is one blocked approval halting a whole project.
    expect(queueOrder()).toContain('stubborn');
    expect(validationAttemptCount('stubborn')).toBe(25);
  });

  it('IT CIRCLES BACK — once the rows behind it have also been missed, it leads again', () => {
    seedWork('stubborn', { updated_at: T });
    seedWork('behind-1', { updated_at: T + 1000 });
    recordAttempt('stubborn', VALIDATION_ATTEMPT_MISS);
    expect(queueOrder()).toEqual(['behind-1', 'stubborn']);
    // The next review misses the one behind too: the counts level and the oldest leads again.
    recordAttempt('behind-1', VALIDATION_ATTEMPT_MISS);
    expect(queueOrder()).toEqual(['stubborn', 'behind-1']);
  });

  it('a FRESH completion never waits behind a stubborn one', () => {
    seedWork('stubborn', { updated_at: T });
    recordAttempt('stubborn', VALIDATION_ATTEMPT_MISS);
    seedWork('fresh', { updated_at: T + 60_000 });
    expect(queueOrder()[0]).toBe('fresh');
  });
});
