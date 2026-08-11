// ════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 6 T26 — A CLOSE REQUEST SURVIVES THE SCHEDULER.
//
// THE LEDGER, by event id, re-read at HEAD by this worker (`work_events`, dev body):
//
//   22623  23:08:16  af72630e  transition  scheduler  on_deck→claimed  "occurrence fired"
//   22625  23:08:16  908380fb  transition  scheduler  on_deck→claimed  "occurrence fired"
//   22626  23:09:10  6b9cb562  transition  scheduler  open→done  delivery 081f9a26
//   22628  23:09:10  af72630e  validation_requested  {requested_state:'done', from:'claimed',
//                              reason:"agent asserts every run is done; the schedule stops
//                              here", result_delivery_id:'081f9a26…'}
//   22630  23:09:15  af72630e  transition  SCHEDULER  claimed→on_deck
//                              "this run is failed; the schedule rejoins at its next occurrence"
//   22632  23:13:17  87cc803a  transition  scheduler  open→abandoned
//                              "Auto-skipped: orphaned run (parent task not running this occurrence)"
//
// The model did everything right: one combined delivery, the twin closed normally, and an
// honest `complete_all_runs` stop filed on the duplicate. Five seconds later the janitor that
// resets structurally-stuck recurring rows called the row stuck — because a filed close leaves
// the row DELIBERATELY unmoved (migration 139's two-key wall) — and its own bookkeeping
// transition, id 22630 > 22628, made `pendingCloseRequestExpr` read 0. The request became
// invisible to every queue that asks for it, the duplicate rejoined its schedule, and its
// occurrence was orphaned and skipped four minutes later.
//
// THE DESIGN QUESTION, and its answer: WHICH events consume a pending close request? Only an
// answer to the question the request asks — "is this job finished?" A verdict answers it
// (`claim_rejected`). A transition that ends the row (`done`/`failed`/`abandoned`) or re-tasks
// it (`open`) answers it. A move between working states — claimed→on_deck, claimed→paused —
// says where the job IS, not whether it is FINISHED, and must leave the request standing.
//
// T21'S SELF-HEAL PROPERTY IS PRESERVED AND STRENGTHENED, and that is this file's regression
// obligation: `claim_upheld` was never in the comparison set, which is what let round-5's
// stuck paused rows heal once the queue could see them. It is still not in it, and now the
// scheduler's bookkeeping is not either — so the round-5 shape heals FASTER, not slower.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t26-close-survives', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../db/migrations.js';
import { openTrackerProject, openTrackerTask, setTrackerStatus, upholdClaim } from '../../work/tracker-store.js';
import { pendingCloseRequestExpr, closeRequestFiledExpr, dueScope, taskScope } from '../../work/tracker-view.js';
import { forceResetStuckRecurringTask } from '../../scheduler/runner.js';
import { appendWorkEvent } from '../../work/store.js';

const AGENT = 'behaviorbot';
const PM = 'pm-agent';
const CONV = 'conv-owner';

const db = (): Database.Database => mockDb.current!;
const stateOf = (id: string): string =>
  (db().prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string }).state;
const pending = (id: string): number =>
  (db().prepare(`SELECT ${pendingCloseRequestExpr('w')} AS p FROM work w WHERE w.id = ?`)
    .get(id) as { p: number }).p;

function seedDelivery(id: string): string {
  db().prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, outcome, created_at)
     VALUES (?, ?, NULL, 'dashboard', 'dashboard', ?, 'delivered', datetime('now'))`,
  ).run(id, AGENT, CONV);
  return id;
}

/** A recurring tracker task, running, with a live schedule — the twin-fire shape's row. */
function seedRecurringTask(title: string): string {
  const project = openTrackerProject({
    title: 'Daily weather', createdBy: AGENT,
    origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null },
  });
  const id = openTrackerTask({
    projectId: project, title, status: 'in_progress', assignedTo: AGENT, createdBy: AGENT,
    origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null },
  });
  db().prepare(
    `UPDATE work SET repeat_interval = 1, repeat_unit = 'days', schedule_status = 'waiting',
                     next_run_at = ?, scheduled_start = ?, task_kind = 'brief'
      WHERE id = ?`,
  ).run(Date.now() - 60_000, Date.now() - 86_400_000, id);
  return id;
}

/** The agent's `complete_all_runs` stop: Key 1 filed, the row deliberately NOT moved. */
function fileCloseRequest(taskId: string): void {
  const r = setTrackerStatus(taskId, 'complete', {
    by: 'agent', actorId: AGENT, claim: 'requests-validation',
    resultDeliveryId: seedDelivery(`d-${taskId.slice(0, 6)}`),
    reason: 'agent asserts every run is done; the schedule stops here',
  });
  expect(r.kind, 'the worker close is Key 1 only — the row must not move').toBe('refused');
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare("INSERT INTO agents (id, name, status) VALUES (?, 'BehaviorBot', 'idle')").run(AGENT);
  db().prepare("INSERT INTO agents (id, name, status) VALUES (?, 'PM', 'idle')").run(PM);
  db().prepare(
    `INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES (?, ?, 'dashboard', 'owner')`,
  ).run(CONV, AGENT);
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

// ════════════════════════════════════════════════════════════════════
// ARM 1 — ONLY AN ANSWER CONSUMES THE REQUEST
// ════════════════════════════════════════════════════════════════════

describe('ARM 1 — a scheduler bookkeeping move cannot bury a close request', () => {
  it('RED (event 22630): claimed→on_deck leaves the request PENDING', () => {
    const task = seedRecurringTask('Daily weather check: Seattle');
    fileCloseRequest(task);
    expect(pending(task)).toBe(1);

    // The janitor's own transition, written exactly as the scheduler writes it.
    setTrackerStatus(task, 'on_deck', {
      by: 'scheduler', actorId: 'scheduler',
      reason: 'this run is failed; the schedule rejoins at its next occurrence',
    });

    expect(pending(task), 'the request is still outstanding: nobody answered it').toBe(1);
  });

  it('a cadence reset ("run finished; waiting for the next occurrence") is the same', () => {
    const task = seedRecurringTask('Daily Seattle weather check');
    fileCloseRequest(task);
    setTrackerStatus(task, 'on_deck', {
      by: 'scheduler', actorId: 'scheduler', reason: 'run finished; waiting for the next occurrence',
    });
    expect(pending(task)).toBe(1);
  });

  it('CONTROL: the validator\'s close ANSWERS it — the request is consumed', () => {
    const task = seedRecurringTask('Daily weather check: Seattle');
    fileCloseRequest(task);
    upholdClaim(task, 'done', PM, 'the runs are done; the schedule stops');
    setTrackerStatus(task, 'complete', {
      by: 'pm', actorId: PM, claim: 'authoritative',
      resultDeliveryId: seedDelivery('d-validated'), reason: 'PM validated the close',
    });
    expect(stateOf(task)).toBe('done');
    expect(pending(task)).toBe(0);
  });

  it('CONTROL: a RETASK back to open answers it too', () => {
    const task = seedRecurringTask('Daily weather check: Seattle');
    fileCloseRequest(task);
    setTrackerStatus(task, 'todo', { by: 'agent', actorId: AGENT, reason: 'retasked: more to do' });
    expect(pending(task)).toBe(0);
  });

  it('CONTROL: `claim_rejected` answers it (the PM throws the claim back)', () => {
    const task = seedRecurringTask('Daily weather check: Seattle');
    fileCloseRequest(task);
    appendWorkEvent(task, 'claim_rejected', PM, { claim_state: 'done', reason: 'not finished' });
    expect(pending(task)).toBe(0);
  });

  it('T21 REGRESSION: `claim_upheld` still does NOT answer it — the self-heal survives', () => {
    const task = seedRecurringTask('Daily weather check: Seattle');
    fileCloseRequest(task);
    appendWorkEvent(task, 'claim_upheld', PM, { claim_state: 'paused' });
    expect(pending(task), 'the round-5 self-heal property, unchanged').toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════
// ARM 2 — THE FORCE-RESET SKIPS VALIDATION SUBJECTS
// ════════════════════════════════════════════════════════════════════

describe('ARM 2 — a row with a filed close is not a stuck row', () => {
  it('RED: force-reset leaves a close-requesting row exactly where it is', () => {
    const task = seedRecurringTask('Daily weather check: Seattle');
    fileCloseRequest(task);
    forceResetStuckRecurringTask(task);
    expect(stateOf(task), 'still claimed and still the validator\'s subject').toBe('claimed');
    expect(pending(task)).toBe(1);
  });

  it('CONTROL: a genuinely stuck recurring row with no request still force-resets', () => {
    const task = seedRecurringTask('Daily weather check: Seattle');
    forceResetStuckRecurringTask(task);
    expect(stateOf(task)).toBe('on_deck');
  });
});

// ════════════════════════════════════════════════════════════════════
// ARM 3 — THE SCHEDULE HOLDS UNTIL KEY 2 RULES
// ════════════════════════════════════════════════════════════════════

describe('ARM 3 — a stop-intent holds the row out of firing until the verdict', () => {
  const dueIds = (): string[] =>
    (db().prepare(
      `SELECT w.id AS id FROM work w WHERE ${taskScope('w')} AND ${dueScope('w')}`,
    ).all(Date.now()) as Array<{ id: string }>).map((r) => r.id);

  it('RED: a due row carrying a pending close request is NOT in the due set', () => {
    const task = seedRecurringTask('Daily weather check: Seattle');
    expect(dueIds()).toContain(task);
    fileCloseRequest(task);
    expect(dueIds(), 'it fires again tomorrow otherwise, on both twins').not.toContain(task);
  });

  it('CONTROL: a due row with no request still fires', () => {
    const task = seedRecurringTask('Daily Seattle weather check');
    expect(dueIds()).toContain(task);
  });

  it('the row is never frozen between the two mechanisms: a held row stays the validator\'s subject', () => {
    // The stalemate this arm exists to refuse: held out of firing by `dueScope`, and moved
    // OUT of `closeRequestFiledExpr`'s states by a cadence reset, so no queue can reach it.
    const task = seedRecurringTask('Daily weather check: Seattle');
    fileCloseRequest(task);
    expect(dueIds()).not.toContain(task);
    expect(stateOf(task), 'claimed is a close-request filing state; on_deck is not').toBe('claimed');
    const filed = (db().prepare(
      `SELECT ${closeRequestFiledExpr('w')} AS filed FROM work w WHERE w.id = ?`,
    ).get(task) as { filed: number }).filed;
    expect(filed, 'the completion queue can still see it').toBe(1);
  });

  it('the hold LIFTS when the verdict refuses the close — the schedule resumes', () => {
    const task = seedRecurringTask('Daily weather check: Seattle');
    fileCloseRequest(task);
    expect(dueIds()).not.toContain(task);
    appendWorkEvent(task, 'claim_rejected', PM, { claim_state: 'done', reason: 'the schedule continues' });
    expect(dueIds(), 'refused → the row rejoins its cadence, with the refusal on its ledger')
      .toContain(task);
  });
});

// ════════════════════════════════════════════════════════════════════
// ARM 4 — THE TWIN FIRE
// ════════════════════════════════════════════════════════════════════

describe('ARM 4 — one delivery, two twin rows: the second is not recorded failed', () => {
  it('the twin that filed a stop keeps its run; nothing calls it failed', () => {
    const kept = seedRecurringTask('Daily Seattle weather check');
    const duplicate = seedRecurringTask('Daily weather check: Seattle');
    // One combined delivery: the twin closes normally, the duplicate files its stop.
    upholdClaim(kept, 'done', PM, 'the run delivered');
    setTrackerStatus(kept, 'complete', {
      by: 'pm', actorId: PM, claim: 'authoritative',
      resultDeliveryId: seedDelivery('d-combined'), reason: 'the run delivered',
    });
    fileCloseRequest(duplicate);

    // The dangler janitor runs at the turn boundary, as it did five seconds later that night.
    forceResetStuckRecurringTask(duplicate);

    const failedMoves = (db().prepare(
      `SELECT payload FROM work_events WHERE work_id = ? AND kind = 'transition'`,
    ).all(duplicate) as Array<{ payload: string }>)
      .map((r) => JSON.parse(r.payload) as { reason?: string })
      .filter((p) => /this run is failed/.test(p.reason ?? ''));
    expect(failedMoves, 'a delivered answer sat beside this row; nothing may call its run failed')
      .toHaveLength(0);
    expect(stateOf(duplicate)).toBe('claimed');
    expect(pending(duplicate)).toBe(1);
  });
});
