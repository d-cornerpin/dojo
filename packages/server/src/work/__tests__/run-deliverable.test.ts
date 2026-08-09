// ════════════════════════════════════════════════════════════════════════════════
// SWEEP CORE-1 CT2 — A SCHEDULED RUN CANNOT BE RECORDED COMPLETE WITHOUT A MESSAGE.
//
// ── THE INCIDENT THESE ARMS ARE WRITTEN FROM (the owner's box, his transcript, 2026-08-07) ──
// His Tomorrow Brief — a recurring scheduled task — fired on time. His agent did the work and
// wrote the brief. Then it marked the run COMPLETE and sent NOTHING. His own sentence about it
// is the rule under test: *"I won't close the run until after the message is sent."*
//
// ── AND THE SHAPE IT ACTUALLY TOOK, DRIVEN, before a line of this fix existed ──
// dojo `8a060c5`, behavioral run `bmslpj41gkx`, 2026-08-09 11:16 UTC, through the real doors:
//
//   task      d277e98c "Tomorrow Brief (ct2run-bmslpj41gkx)", created via POST /api/tracker/tasks
//             task_kind = NULL            ← the platform declared nothing; there was no mechanism
//   run       occurrence 2fc4e3e3 seq 1 · state `done` · run_status `complete`
//             → the owner's run history read **complete**
//   receipt   b57483d6 · tool=dashboard · channel=dashboard · display_kind='tool-turn'
//             content = [{"type":"tool_use","name":"work_update",
//                         "input":{"action":"status","status":"complete"}}]
//             THE RUN WAS MARKED COMPLETE ON THE CHIP OF THE CALL THAT MARKED IT COMPLETE.
//   and the brief DID exist, one delivery earlier, and was not what the run closed on:
//             "Tomorrow (Mon, Aug 10) is clear — no events on any of your calendars."
//
// ARM 3a below is that row, replayed. The rest are its negative controls and the ladder.
// ════════════════════════════════════════════════════════════════════════════════

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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-run-deliverable-test', 'dojo.db'),
  };
});

import { createWorkTable, seedTrackerTask } from './work-fixture.js';
import {
  declaredDeliverableShape, declareDeliverableOnSchedule, taskOwesDeliverable,
  occurrenceOwesDeliverable, findLiveRecurringTwin, DELIVERABLE_OWING_TASK_KINDS,
  DECLARATION_MARKER,
} from '../deliverable-declaration.js';
import {
  claimOccurrence, settleOccurrence, runDeliverableEvidence, runSettleApplied,
  OCCURRENCE_KIND, OCCURRENCE_EVENT,
} from '../occurrences.js';
import {
  MAX_RUN_DELIVER_STEERS, RUN_STATUS_UNDELIVERED, RUN_DELIVER_STAND_DOWN_MARKER,
  RUN_DELIVER_STEER_MARKER, nextRunDeliverRung, recordRunDeliverSteer,
} from '../run-deliver-drive.js';

const W = 'sched-1';
const AGENT = 'a1';
const RUN_OPENED = 1785316028089;

/** The two tables the evidence predicate reads. Only the columns it names. */
function createLedgerTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, display_kind TEXT, content TEXT
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, tool TEXT NOT NULL, channel TEXT NOT NULL,
      outcome TEXT NOT NULL, message_id TEXT, created_at TEXT NOT NULL
    );
  `);
}

/** A delivery, plus the message row it points at when it has one. */
function seedDelivery(o: {
  id: string; tool?: string; channel?: string; outcome?: string;
  displayKind?: string | null; content?: string | null; atSec?: number;
}): void {
  const db = mockDb.current!;
  const messageId = o.displayKind === null ? null : `m-${o.id}`;
  if (messageId) {
    db.prepare('INSERT INTO messages (id, display_kind, content) VALUES (?, ?, ?)')
      .run(messageId, o.displayKind ?? 'agent-text', o.content ?? 'here is your brief');
  }
  const at = new Date((o.atSec ?? Math.floor(RUN_OPENED / 1000) + 10) * 1000)
    .toISOString().slice(0, 19).replace('T', ' ');
  db.prepare(
    `INSERT INTO deliveries (id, agent_id, tool, channel, outcome, message_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(o.id, AGENT, o.tool ?? 'dashboard', o.channel ?? 'dashboard',
        o.outcome ?? 'delivered', messageId, at);
}

const seedSchedule = (extra: Record<string, unknown> = {}): void => {
  seedTrackerTask(mockDb.current!, {
    id: W, title: 'Tomorrow Brief', status: 'on_deck', agentId: AGENT,
    next_run_at: RUN_OPENED, schedule_status: 'waiting', is_paused: 0,
    repeat_interval: 1, repeat_unit: 'days', attempts: 0,
    description: 'Every morning, send me a short brief of what is on for tomorrow.',
    ...extra,
  });
};

const claim = (): string => claimOccurrence({
  workId: W, sequence: 1, occurrenceMs: RUN_OPENED,
  nowMs: RUN_OPENED + 1, nextRunMs: RUN_OPENED + 86_400_000, agentId: AGENT,
})!;

const stateOf = (id: string): string =>
  (mockDb.current!.prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string }).state;

const settledRunStatus = (id: string): string | null => {
  const r = mockDb.current!.prepare(
    `SELECT json_extract(payload, '$.run_status') AS s FROM work_events
      WHERE work_id = ? AND kind = ? ORDER BY id DESC LIMIT 1`,
  ).get(id, OCCURRENCE_EVENT.settled) as { s: string | null } | undefined;
  return r?.s ?? null;
};

const receiptOf = (id: string): string | null =>
  (mockDb.current!.prepare('SELECT result_delivery_id AS d FROM work WHERE id = ?')
    .get(id) as { d: string | null }).d;

const markerCount = (id: string, marker: string): number =>
  (mockDb.current!.prepare(
    `SELECT COUNT(*) AS n FROM work_events
      WHERE work_id = ? AND kind = 'audit' AND json_extract(payload, '$.marker') = ?`,
  ).get(id, marker) as { n: number }).n;

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  createWorkTable(db);
  createLedgerTables(db);
});

// ════════════════════════════════════════════════════════════════════════════════
describe('ARM 1 — THE DECLARATION: decided once, from the DEFINITION, never from the run', () => {
  it("1a the owner's own definition declares a brief", () => {
    const s = declaredDeliverableShape({
      title: 'Tomorrow Brief',
      description: 'Every morning, send me a short brief of what is on for tomorrow.',
      goal: null, hasSchedule: true,
    });
    expect(s?.shape).toBe('brief');
    expect(s?.matched.toLowerCase()).toBe('brief');
  });

  it('1a the plain-language shape the owner actually types is caught by the notify rule', () => {
    expect(declaredDeliverableShape({
      title: 'Morning update', description: 'Every day at 7am, text me what is on today.',
      hasSchedule: true,
    })?.shape).toBe('notify');
    expect(declaredDeliverableShape({
      title: 'Weekly status', description: 'Send me the weekly report every Monday.',
      hasSchedule: true,
    })?.shape).toBe('report');
  });

  it('1b an explicit kind from the caller ALWAYS wins, schedule or not', () => {
    const s = declaredDeliverableShape({ kind: 'reminder', title: 'x', hasSchedule: false });
    expect(s?.shape).toBe('reminder');
    expect(s?.rule).toBe('declared-by-the-caller');
  });

  it('1c NEGATIVE CONTROL — an UNSCHEDULED task is never declared, however it is worded', () => {
    expect(declaredDeliverableShape({
      title: 'Send me the brief', description: 'send me a brief when you are done',
      hasSchedule: false,
    })).toBeNull();
  });

  it('1d NEGATIVE CONTROLS — the patterns are word-bounded and addressed, not substrings', () => {
    // "debrief" contains "brief". An unbounded substring is the exact defect class TB3 fixed
    // in the kit's own census, and it would declare this a brief.
    expect(declaredDeliverableShape({
      title: 'debrief the logs', description: 'debrief the logs nightly', hasSchedule: true,
    })).toBeNull();
    // A bare "report" verb with no person on the other end owes nobody a word.
    expect(declaredDeliverableShape({
      title: 'error sweep', description: 'report any errors to the log file', hasSchedule: true,
    })).toBeNull();
    // A telling verb aimed at somebody who is not a person in this conversation.
    expect(declaredDeliverableShape({
      title: 'client mail', description: 'email the client the invoice each month', hasSchedule: true,
    })).toBeNull();
    // The nightly backup: the case that must keep closing exactly as it always has.
    expect(declaredDeliverableShape({
      title: 'Nightly backup', description: 'back up the database to the NAS every night at 2am',
      hasSchedule: true,
    })).toBeNull();
  });

  it('1e the declaration is written to the row AND audited with the phrase that caused it', () => {
    seedSchedule();
    const s = declareDeliverableOnSchedule(W);
    expect(s?.shape).toBe('brief');
    expect(taskOwesDeliverable(W)).toEqual({ owes: true, taskKind: 'brief' });
    const ev = mockDb.current!.prepare(
      `SELECT payload FROM work_events WHERE work_id = ? AND kind = 'audit'
        AND json_extract(payload, '$.marker') = ?`,
    ).get(W, DECLARATION_MARKER) as { payload: string } | undefined;
    expect(ev, 'the declaration must be readable by a person, not only by the closer').toBeTruthy();
    expect(ev!.payload).toContain('brief');
    expect(ev!.payload).toContain('cannot be recorded complete');
  });

  it('1f it is idempotent and never re-labels a kind somebody already set', () => {
    seedSchedule({ task_kind: 'reminder' });
    expect(declareDeliverableOnSchedule(W)?.rule).toBe('already-declared');
    expect(taskOwesDeliverable(W).taskKind).toBe('reminder');
    // A caller-supplied kind that is NOT on the list is a deliberate statement and is honoured.
    seedTrackerTask(mockDb.current!, {
      id: 'sched-2', title: 'Daily brief', status: 'on_deck', agentId: AGENT,
      schedule_status: 'waiting', repeat_interval: 1, repeat_unit: 'days', task_kind: 'chore',
      description: 'send me a brief every day',
    });
    expect(declareDeliverableOnSchedule('sched-2')).toBeNull();
    expect(taskOwesDeliverable('sched-2')).toEqual({ owes: false, taskKind: 'chore' });
  });

  it('1g the closed inventory is exactly the list the kit mirrors', () => {
    expect([...DELIVERABLE_OWING_TASK_KINDS]).toEqual(['reminder', 'brief', 'report', 'notify']);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
describe('ARM 2 — THE EVIDENCE: six narrowings, each a negative control', () => {
  let runId = '';
  beforeEach(() => { seedSchedule(); declareDeliverableOnSchedule(W); runId = claim(); });

  it('2a a real owner-lane message with text IS the evidence', () => {
    seedDelivery({ id: 'd-msg', content: 'Tomorrow (Mon, Aug 10) is clear.' });
    expect(runDeliverableEvidence(runId)?.id).toBe('d-msg');
  });

  it('2b NARROWING — a tool-call CHIP is not a message (the owner\'s own case)', () => {
    seedDelivery({ id: 'd-chip', displayKind: 'tool-turn', content: '[{"type":"tool_use"}]' });
    expect(runDeliverableEvidence(runId)).toBeNull();
  });

  it('2c NARROWING — an engine start-ack is not the thing', () => {
    seedDelivery({ id: 'd-ack', tool: 'engine-ack' });
    expect(runDeliverableEvidence(runId)).toBeNull();
  });

  it("2d NARROWING — the platform's own alert voice is not the agent's work", () => {
    seedDelivery({ id: 'd-alert', tool: 'alert', channel: 'imessage', displayKind: null });
    expect(runDeliverableEvidence(runId)).toBeNull();
  });

  it('2e NARROWING — an a2a hand-off to an apprentice is not the owner hearing it', () => {
    seedDelivery({ id: 'd-a2a', tool: 'send_to_agent', channel: 'a2a', displayKind: null });
    expect(runDeliverableEvidence(runId)).toBeNull();
  });

  it('2f NARROWING — a send that did not succeed is not a send', () => {
    seedDelivery({ id: 'd-fail', outcome: 'failed' });
    expect(runDeliverableEvidence(runId)).toBeNull();
  });

  it('2g NARROWING — a delivery that PREDATES the run cannot be its deliverable', () => {
    seedDelivery({ id: 'd-old', atSec: Math.floor(RUN_OPENED / 1000) - 60 });
    expect(runDeliverableEvidence(runId)).toBeNull();
  });

  it('2h NARROWING — READ THE REPLY: a message row that exists and is BLANK is a send of nothing', () => {
    seedDelivery({ id: 'd-blank', content: '   ' });
    expect(runDeliverableEvidence(runId)).toBeNull();
  });

  it('2i POSITIVE CONTROLS — the narrowings must not eat honest channel sends', () => {
    seedDelivery({ id: 'd-sms', tool: 'auto-route', channel: 'imessage', displayKind: null });
    expect(runDeliverableEvidence(runId)?.id, 'a channel send records no chat row at all').toBe('d-sms');
  });

  it("2j POSITIVE CONTROL — the engine's COMPILED join relay to the owner is admitted (TB13 whole)", () => {
    seedDelivery({ id: 'd-relay', tool: 'a2a-join-relay', channel: 'dashboard', content: 'the compiled answer' });
    expect(runDeliverableEvidence(runId)?.id).toBe('d-relay');
  });

  it('2k the chip does not shadow the real message even when it is NEWER', () => {
    // This is the owner's exact ordering: the brief lands, then the close-out call's chip.
    seedDelivery({ id: 'd-brief', content: 'Tomorrow is clear.', atSec: Math.floor(RUN_OPENED / 1000) + 10 });
    seedDelivery({ id: 'd-chip', displayKind: 'tool-turn', content: '[{"type":"tool_use"}]', atSec: Math.floor(RUN_OPENED / 1000) + 20 });
    expect(runDeliverableEvidence(runId)?.id).toBe('d-brief');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
describe('ARM 3 — THE CLOSER: the run closes on the message, or it does not close', () => {
  it("3a THE OWNER'S CASE — a declared run whose only delivery is a chip is OWED, not complete", () => {
    seedSchedule();
    declareDeliverableOnSchedule(W);
    const runId = claim();
    seedDelivery({ id: 'd-chip', displayKind: 'tool-turn', content: '[{"type":"tool_use","name":"work_update"}]' });

    // The caller passes the chip, exactly as `deliveryForAgentSince` hands it over today.
    const s = settleOccurrence(runId, 'complete', 'd-chip', 'wrote the brief');

    expect(s.verdict, 'the run must NOT be settled').toBe('owed');
    expect(s.outcome, 'nothing may be transitioned').toBeNull();
    expect(runSettleApplied(s)).toBe(false);
    expect(stateOf(runId), 'the run is still in flight, so a later delivery can still close it').toBe('open');
    expect(settledRunStatus(runId), 'NOTHING may be recorded complete').toBeNull();
  });

  it('3b …and the SAME run closes on the real message when one exists, not on the chip', () => {
    seedSchedule();
    declareDeliverableOnSchedule(W);
    const runId = claim();
    seedDelivery({ id: 'd-brief', content: 'Tomorrow (Mon, Aug 10) is clear — no events.', atSec: Math.floor(RUN_OPENED / 1000) + 10 });
    seedDelivery({ id: 'd-chip', displayKind: 'tool-turn', content: '[{"type":"tool_use"}]', atSec: Math.floor(RUN_OPENED / 1000) + 20 });

    const s = settleOccurrence(runId, 'complete', 'd-chip', 'wrote the brief');

    expect(s.verdict).toBe('settled');
    expect(runSettleApplied(s)).toBe(true);
    expect(stateOf(runId)).toBe('done');
    expect(receiptOf(runId), 'THE CALLER NARROWS THE SCOPE; THE AUTHORITY DECIDES').toBe('d-brief');
    expect(settledRunStatus(runId)).toBe('complete');
  });

  it('3c NEGATIVE CONTROL — a task that owes nobody anything settles EXACTLY as before', () => {
    seedTrackerTask(mockDb.current!, {
      id: W, title: 'Nightly backup', status: 'on_deck', agentId: AGENT,
      next_run_at: RUN_OPENED, schedule_status: 'waiting', is_paused: 0,
      repeat_interval: 1, repeat_unit: 'days', attempts: 0,
      description: 'back up the database to the NAS every night at 2am',
    });
    expect(declareDeliverableOnSchedule(W)).toBeNull();
    const runId = claim();
    const s = settleOccurrence(runId, 'complete', null, 'backed up');
    expect(s.verdict).toBe('settled');
    expect(stateOf(runId)).toBe('abandoned');       // G7: no delivery, so not `done`
    expect(settledRunStatus(runId)).toBe('complete'); // and the owner's history still says so
  });

  it('3d NEGATIVE CONTROL — `failed` and `skipped` never reach the gate', () => {
    seedSchedule();
    declareDeliverableOnSchedule(W);
    const a = claim();
    expect(settleOccurrence(a, 'failed', null, 'provider error').verdict).toBe('settled');
    expect(stateOf(a)).toBe('failed');
  });

  it('3e THE LADDER — bounded steers, then a stand-down that is NEVER complete', () => {
    seedSchedule();
    declareDeliverableOnSchedule(W);
    const runId = claim();
    seedDelivery({ id: 'd-chip', displayKind: 'tool-turn', content: '[{"type":"tool_use"}]' });

    // Rungs 1..N: refused, and each one recorded on the run's own history by the caller that
    // performed it — the ladder decides, the caller spends (`join-drive.ts`'s rule).
    for (let i = 1; i <= MAX_RUN_DELIVER_STEERS; i++) {
      const rung = nextRunDeliverRung(runId);
      expect(rung.rung).toBe('steer');
      expect(rung.attempt).toBe(i);
      expect(settleOccurrence(runId, 'complete', 'd-chip', null).verdict).toBe('owed');
      // Each drive is a SEPARATE TURN — see 3e2 for why that is the unit.
      recordRunDeliverSteer(runId, { attempt: rung.attempt, bound: rung.bound, taskId: W, why: 'test', turnNumber: 100 + i });
    }
    expect(markerCount(runId, RUN_DELIVER_STEER_MARKER)).toBe(MAX_RUN_DELIVER_STEERS);
    expect(nextRunDeliverRung(runId).rung).toBe('stand-down');

    // Rung N+1: the run is settled, and the word is UNDELIVERED.
    const s = settleOccurrence(runId, 'complete', 'd-chip', 'wrote the brief');
    expect(s.verdict).toBe('settled');
    expect(runSettleApplied(s)).toBe(true);
    expect(stateOf(runId)).toBe('abandoned');
    expect(settledRunStatus(runId), 'the owner must NEVER read "complete" for a run he never heard')
      .toBe(RUN_STATUS_UNDELIVERED);
    expect(receiptOf(runId)).toBeNull();
    expect(markerCount(runId, RUN_DELIVER_STAND_DOWN_MARKER)).toBe(1);
    const ev = mockDb.current!.prepare(
      `SELECT payload FROM work_events WHERE work_id = ? AND kind = 'transition' ORDER BY id DESC LIMIT 1`,
    ).get(runId) as { payload: string };
    expect(ev.payload).toContain('reached NOBODY');
  });

  it('3e2 A RETRY LOOP INSIDE ONE TURN IS ONE DRIVE, not the whole ladder', () => {
    // MEASURED, run `bmslqef2w3r`: the floor model called `work_update(status="complete")` FOUR
    // TIMES inside one turn, before it had spoken at all. Counting ROWS spent the entire ladder
    // in ten seconds and stood the run down while the agent was still working — and it then
    // delivered a perfectly good brief into a run already recorded UNDELIVERED. A rung is a
    // DRIVE: a separate attempt, with a turn in between for the agent to act on the steer.
    seedSchedule();
    declareDeliverableOnSchedule(W);
    const runId = claim();
    for (let i = 0; i < 8; i++) {
      recordRunDeliverSteer(runId, { attempt: 1, bound: MAX_RUN_DELIVER_STEERS, taskId: W, why: 'retry loop', turnNumber: 4242 });
    }
    expect(markerCount(runId, RUN_DELIVER_STEER_MARKER), 'eight rows were written').toBe(8);
    expect(nextRunDeliverRung(runId).rung, 'and they are ONE drive').toBe('steer');
    expect(nextRunDeliverRung(runId).attempt).toBe(2);
    // Three DISTINCT turns is what spends it.
    recordRunDeliverSteer(runId, { attempt: 2, bound: MAX_RUN_DELIVER_STEERS, taskId: W, why: 'x', turnNumber: 4243 });
    recordRunDeliverSteer(runId, { attempt: 3, bound: MAX_RUN_DELIVER_STEERS, taskId: W, why: 'x', turnNumber: 4244 });
    expect(nextRunDeliverRung(runId).rung).toBe('stand-down');
  });

  it('3e3 a steer from OUTSIDE a turn is still its own drive — it cannot be free', () => {
    seedSchedule();
    declareDeliverableOnSchedule(W);
    const runId = claim();
    recordRunDeliverSteer(runId, { attempt: 1, bound: MAX_RUN_DELIVER_STEERS, taskId: W, why: 'x', turnNumber: null });
    expect(nextRunDeliverRung(runId).attempt).toBe(2);
  });

  it('3f the ladder counts PER RUN, so yesterday\'s steers do not spend today\'s', () => {
    seedSchedule();
    declareDeliverableOnSchedule(W);
    const first = claim();
    for (let i = 1; i <= MAX_RUN_DELIVER_STEERS; i++) {
      recordRunDeliverSteer(first, { attempt: i, bound: MAX_RUN_DELIVER_STEERS, taskId: W, why: 'test', turnNumber: 200 + i });
    }
    expect(nextRunDeliverRung(first).rung).toBe('stand-down');
    const second = claimOccurrence({
      workId: W, sequence: 2, occurrenceMs: RUN_OPENED + 86_400_000,
      nowMs: RUN_OPENED + 86_400_001, nextRunMs: null, agentId: AGENT,
    })!;
    expect(nextRunDeliverRung(second).rung, 'a fresh run starts at rung 1').toBe('steer');
    expect(nextRunDeliverRung(second).attempt).toBe(1);
  });

  it('3g occurrenceOwesDeliverable reads the PARENT schedule, one column, never prose', () => {
    seedSchedule();
    declareDeliverableOnSchedule(W);
    const runId = claim();
    expect(occurrenceOwesDeliverable(runId)).toEqual({ owes: true, taskKind: 'brief', taskId: W });
    expect(occurrenceOwesDeliverable('no-such-run')).toEqual({ owes: false, taskKind: null, taskId: null });
  });

  it('3h the run-as-complete RETIREMENT path is gated too — the three call sites that pass null', () => {
    // `skipOpenOccurrencesAsComplete` hard-codes `deliveryId = null` and used to record the
    // run `complete` on the strength of the caller's assertion alone. For a declared task it
    // cannot any more.
    seedSchedule();
    declareDeliverableOnSchedule(W);
    const runId = claim();
    const s = settleOccurrence(runId, 'complete', null, 'All runs completed by agent');
    expect(s.verdict).toBe('owed');
    expect(settledRunStatus(runId)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
describe('ARM 4 — THE DUPLICATE-RECURRING GUARD (Step 3)', () => {
  const twinArgs = {
    creatorId: AGENT, shape: 'brief', repeatInterval: 1, repeatUnit: 'days',
    repeatDaysOfWeek: null,
  };
  const seedLiveBrief = (id: string, extra: Record<string, unknown> = {}): void => {
    seedTrackerTask(mockDb.current!, {
      id, title: `Tomorrow Brief ${id}`, status: 'on_deck', agentId: AGENT,
      next_run_at: RUN_OPENED, schedule_status: 'waiting', is_paused: 0,
      repeat_interval: 1, repeat_unit: 'days', task_kind: 'brief', ...extra,
    });
  };

  it("4a THE OWNER'S CASE — a live daily brief by the same owner IS a twin", () => {
    seedLiveBrief('old-brief');
    expect(findLiveRecurringTwin(twinArgs)?.id).toBe('old-brief');
  });

  it('4b …and the ANCHOR is deliberately not compared, because his differed', () => {
    // He recreated the briefs BECAUSE the anchor was wrong. Matching on it would have missed
    // his case exactly — this clause is the reason the guard keys on the cadence.
    seedLiveBrief('old-brief', { anchor_local: '2026-08-01T07:00:00Z', next_run_at: RUN_OPENED + 3_600_000 });
    expect(findLiveRecurringTwin(twinArgs)?.id).toBe('old-brief');
  });

  it('4c NEGATIVE CONTROL — a DIFFERENT cadence is not a twin', () => {
    seedLiveBrief('weekly-brief', { repeat_unit: 'weeks' });
    expect(findLiveRecurringTwin(twinArgs)).toBeNull();
  });

  it('4d NEGATIVE CONTROL — a different deliverable shape on the same cadence is not a twin', () => {
    seedLiveBrief('daily-notify', { task_kind: 'notify' });
    expect(findLiveRecurringTwin(twinArgs)).toBeNull();
  });

  it('4e NEGATIVE CONTROL — another owner\'s schedule is not a twin', () => {
    seedLiveBrief('someone-elses');
    mockDb.current!.prepare('UPDATE work SET requester_id = ? WHERE id = ?').run('other', 'someone-elses');
    expect(findLiveRecurringTwin(twinArgs)).toBeNull();
  });

  it('4f NEGATIVE CONTROL — a schedule that fires nothing is not a twin', () => {
    // This is the legitimate re-creation the owner was ACTUALLY attempting: stop the old one,
    // then make a new one. Refusing against a dead schedule would block exactly that.
    seedLiveBrief('paused', { is_paused: 1 });
    expect(findLiveRecurringTwin(twinArgs)).toBeNull();
    seedLiveBrief('stopped', { schedule_status: 'completed' });
    expect(findLiveRecurringTwin(twinArgs)).toBeNull();
    seedLiveBrief('cancelled', { status: 'cancelled' });
    expect(findLiveRecurringTwin(twinArgs)).toBeNull();
  });

  it('4g NEGATIVE CONTROL — a shape that is not deliverable-owing is never twinned here', () => {
    seedLiveBrief('chore', { task_kind: 'chore' });
    expect(findLiveRecurringTwin({ ...twinArgs, shape: 'chore' })).toBeNull();
  });

  it('4h NO TIME WINDOW — the twin counts however old it is', () => {
    seedLiveBrief('ancient', { opened_at: 1600000000001 });
    expect(findLiveRecurringTwin(twinArgs)?.id,
      'his duplicate was created DAYS after its twin; a five-minute window cannot see that').toBe('ancient');
  });

  it('4i the row being created is excludable, so a later pass cannot twin a task with itself', () => {
    seedLiveBrief('me');
    expect(findLiveRecurringTwin({ ...twinArgs, excludeTaskId: 'me' })).toBeNull();
  });
});
