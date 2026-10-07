// ════════════════════════════════════════════════════════════════════════════════════════
// t124 — THE ESCALATION VOID. OWNER RULING OR-PM-1v2, his words:
//
//   *"the path is for that to get escalated to the user which should already happen after
//    some failures/time."*  He calls it a fundamental piece.
//
// ── THIS FILE IS THE TRIAGE'S OWN EXPERIMENT, INVERTED ──────────────────────────────────
// `overhaul-plans/pm-cluster-triage.md` §Q4b drove the escalation ladder three ways on a live
// dev box — ~22 minutes of real server sweeps, idleness backdated to 9,800 s — and recorded
// the same result in every arm: **owner notifications observed: ZERO.** Each arm below is one
// of those three runs, driven here through the same functions the scheduler calls, and the
// assertion is reversed: the owner-visible row must now LAND.
//
//   §1  run 1 — a PM-UPHELD block. Measured: excluded from the sweep permanently, because the
//               blessing itself set `blocked_validated=1` and the arm read it as `= 0`.
//   §2  run 2 — a pending escalation plus unrelated chatter. Measured: the primary woke, spoke
//               about an unrelated vendor email, and the sweep accepted that as proof it had
//               escalated — burning the row's one permanent stamp.
//   §3  run 3 — the full ladder. Measured: time was the only trigger that existed; no failure
//               counter existed anywhere, so a declined ASSIGN left `in_progress` was in no
//               arm at all.
//   §4  THE NEGATIVE, which is half the bar: healthy progressing work NEVER escalates. An
//       escalation that fires on everything is not an escalation.
//   §5  the sentence itself — what is blocked, since when, what was tried (honest-record).
//
// Every clause here is driven, never source-matched: the rows are real `work` rows, the
// uphold is a real adjudication, the failures are real `transition()` calls, and the owner
// notification is read back out of `messages` as the owner's dashboard would see it.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { OWNER_ALERT_HEADS_UP_PREFIX } from '@dojo/shared';

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
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t124-escalation-test', 'dojo.db'),
  };
});

const frames: Array<Record<string, unknown>> = [];
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (e: Record<string, unknown>) => { frames.push(e); },
}));

const wakes: Array<{ agentId: string; content: string }> = [];
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({
    handleMessage: (agentId: string, content: string) => {
      wakes.push({ agentId, content });
      return Promise.resolve();
    },
  }),
}));

import { runMigrations } from '../../db/migrations.js';
import { transition } from '../store.js';
import { validatedExpr, taskScope } from '../tracker-view.js';
import { upholdClaim } from '../tracker-store.js';
import { deliveryAboutWorkSince, deliveryForAgentSince } from '../tracker-store.js';
import {
  selectRowsForOwnerEscalation,
  setValidationDoorbellHandler,
  ownerEscalationAlertLine,
  workFailureCount,
  FAILURE_TRANSITION_STATES,
  recordEscalationSteer,
  failureArmStillWithinPatience,
} from '../validation-drive.js';
import { patienceFloorFor, flooredThresholds } from '../../tracker/assignee-patience.js';
import { POKE_THRESHOLDS } from '../../tracker/pm-agent.js';
import { STREAM_FIRST_CHUNK_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS } from '../../agent/stream-patience.js';

/** Fictional throughout (G1): no real agent or person names reach a shipped surface. */
const ASSIGNEE = 'zargo';
const PRIMARY = 'primary';
const PM = 'pm';

const T = 1_700_000_000_000;
const NOW = T + 60 * 60_000;
/** The sweep's own cutoff: `now - VALIDATION_ESCALATION_MIN`. */
const CUTOFF = NOW - 5 * 60_000;
const SERVICE_IDS = ['dreamer', 'healer'] as const;

function seedWork(id: string, over: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id, kind: 'task', parent_id: null, agent_id: ASSIGNEE, assignee_agent: null,
    requester: 'owner', requester_id: 'owner', conversation_id: null,
    root_kind: 'tracker', root_id: id, state: 'claimed', claimed_by_turn: null,
    result_delivery_id: null, intent: 'do-it', wakes: 1, closes_thread: 0,
    hop_count: 0, superseded_by: null, title: 'wire up the greenhouse sensor', goal: null,
    priority: 'normal', notes: null, remaining_children: null, compile_pending: 0,
    ttl_at: null, reply_conversation_id: null, attempts: 0, next_attempt_at: null,
    schedule_json: null, tz: null, anchor_local: null, next_run_at: null, sequence: null,
    opened_at: T, closed_at: null, updated_at: T, provenance: 'live',
    missed_runs_paused_at: null, ...over,
  };
  const cols = Object.keys(row);
  mockDb.current!.prepare(
    `INSERT INTO work (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`,
  ).run(row);
}

/** Backdate the row past the sweep's bound, the way the live drive used `sqlite3`. */
const age = (id: string): void => {
  mockDb.current!.prepare('UPDATE work SET updated_at = ? WHERE id = ?').run(T, id);
};

const candidates = (): string[] =>
  selectRowsForOwnerEscalation(CUTOFF, [...SERVICE_IDS]).map((r) => r.id);

const candidateRow = (id: string) =>
  selectRowsForOwnerEscalation(CUTOFF, [...SERVICE_IDS]).find((r) => r.id === id);

/** A row blocked by its assignee, with the hard-gated obstacle note the tool demands. */
const OBSTACLE = 'the sensor vendor API returns 500 on every write and support has not replied';

function seedBlocked(id: string): void {
  seedWork(id);
  const r = transition(id, {
    to: 'blocked', by: 'agent', actorId: ASSIGNEE,
    reason: 'work_update(action="status") -> blocked', note: OBSTACLE,
  });
  expect(r.kind).toBe('applied');
  age(id);
}

/** One delivered, owner-facing receipt whose TURN ROOT is `root`. */
function seedDelivery(p: {
  id: string; agent: string; rootKind: string | null; rootId: string | null;
  channel?: string; atMs?: number; tool?: string; outcome?: string;
}): void {
  mockDb.current!.prepare(
    `INSERT INTO deliveries (id, agent_id, tool, channel, outcome, root_kind, root_id, created_at)
     VALUES (@id, @agent, @tool, @channel, @outcome, @rootKind, @rootId,
             datetime(@at, 'unixepoch'))`,
  ).run({
    id: p.id, agent: p.agent, tool: p.tool ?? 'send_message',
    channel: p.channel ?? 'dashboard', outcome: p.outcome ?? 'delivered',
    rootKind: p.rootKind, rootId: p.rootId,
    at: Math.floor((p.atMs ?? NOW) / 1000),
  });
}

/** The owner-visible rows the platform's own voice wrote, as the dashboard reads them. */
const ownerAlerts = (): string[] =>
  (mockDb.current!.prepare(
    `SELECT content FROM messages
      WHERE agent_id = ? AND role = 'system' AND lane = 'owner' AND retired_at IS NULL
      ORDER BY rowid`,
  ).all(PRIMARY) as Array<{ content: string }>)
    .map((r) => r.content)
    .filter((c) => c.startsWith(OWNER_ALERT_HEADS_UP_PREFIX));

/**
 * Drive the real sweep the scheduler drives. Imported lazily so the module graph is built
 * against the mocks above.
 */
async function sweep(): Promise<void> {
  const { sweepUnvalidatedTasksForUserEscalation } = await import('../../scheduler/runner.js');
  await sweepUnvalidatedTasksForUserEscalation();
}

/** Run the ladder to its end: steer, steer, then the platform's own surface. */
async function driveLadderToTheEnd(): Promise<void> {
  await sweep();
  await sweep();
  await sweep();
}

beforeEach(() => {
  mockDb.current?.close();
  mockDb.current = new Database(':memory:');
  runMigrations();
  // The three agents this drive involves. Required, not decoration: `recordFloorGhost`'s
  // owner-visible row is an ordinary `messages` insert, and without the agent row behind it
  // the write is REFUSED and swallowed by that function's own non-fatal catch — which is
  // precisely the failure shape this lane is about, so the harness must not reproduce it by
  // accident and then read the silence as a result.
  for (const [id, name] of [[PRIMARY, 'Primary'], [ASSIGNEE, 'Zargo'], [PM, 'PM']]) {
    mockDb.current.prepare(
      `INSERT INTO agents (id, name, status) VALUES (?, ?, 'idle')`,
    ).run(id, name);
  }
  frames.length = 0;
  wakes.length = 0;
  setValidationDoorbellHandler(null);
  vi.setSystemTime(new Date(NOW));
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 · ARM 1 — A PM-UPHELD BLOCK. The triage's run 1, inverted.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§1 a block the PM confirmed is real reaches the owner', () => {
  it('THE INVERSION: a PM-upheld block is a candidate for owner escalation', () => {
    seedBlocked('t-upheld');
    upholdClaim('t-upheld', 'blocked', 'pm', PM, 'PM confirmed the block is real');
    age('t-upheld');

    // The blessing is on file — this is the exact state that used to remove the row forever.
    const row = candidateRow('t-upheld');
    expect(row, 'a PM-upheld block must still be the owner\'s problem').toBeDefined();
    expect(row!.blocked_validated, 'the uphold really is recorded').toBe(1);
  });

  it('THE MUTANT, both ways: restoring the `blocked_validated = 0` conjunct re-opens the void', () => {
    seedBlocked('t-upheld');
    upholdClaim('t-upheld', 'blocked', 'pm', PM, 'PM confirmed the block is real');
    age('t-upheld');
    expect(candidates()).toContain('t-upheld');

    // The defect, planted as SQL rather than as a patch to the module: the arm the fix
    // removed, asked of the same row through the same expression the predicate uses.
    const withOldArm = mockDb.current!.prepare(
      `SELECT w.id FROM work w
        WHERE ${taskScope('w')} AND w.state = 'blocked'
          AND ${validatedExpr('w', 'blocked')} = 0 AND w.updated_at < ?`,
    ).all(CUTOFF) as Array<{ id: string }>;
    expect(withOldArm.map((r) => r.id),
      'the old arm is what excluded it — this is the measured defect').not.toContain('t-upheld');
  });

  it('and the OTHER direction: `close` and `pause` keep their validation conjunct', () => {
    // The negative control for fix 1's scope. An upheld PAUSE is resolved — the pause is
    // legitimate and there is nothing left to tell anyone — so it must NOT escalate.
    seedWork('t-paused', { state: 'paused' });
    const r = transition('t-paused', {
      to: 'paused', by: 'agent', actorId: ASSIGNEE, reason: 'waiting on a part',
    });
    expect(r.kind).toBe('no_change');
    upholdClaim('t-paused', 'paused', 'pm', PM, 'the pause is legitimate');
    age('t-paused');
    expect(candidates(), 'an upheld pause is resolved, not escalated').not.toContain('t-paused');
  });

  it('DRIVEN END TO END: the ladder runs out and the OWNER IS TOLD', async () => {
    seedBlocked('t-upheld');
    upholdClaim('t-upheld', 'blocked', 'pm', PM, 'PM confirmed the block is real');
    age('t-upheld');

    expect(ownerAlerts(), 'nothing before the ladder runs').toHaveLength(0);
    await driveLadderToTheEnd();

    const alerts = ownerAlerts();
    expect(alerts.length,
      'the triage measured ZERO owner notifications in this arm; it must now be at least one',
    ).toBeGreaterThanOrEqual(1);
    const alert = alerts[0];
    // WHAT is blocked.
    expect(alert).toContain('wire up the greenhouse sensor');
    // WHAT WAS TRIED — the agent's own recorded obstacle, and the platform's own attempts.
    expect(alert).toContain('the sensor vendor API returns 500');
    expect(alert).toMatch(/asked .* to raise it with you and got no reply/);
    // AND IT DOES NOT LIE ABOUT THE VALIDATOR: the PM did confirm this one.
    expect(alert).toContain('confirmed the block is real');
    expect(alert, 'the old fixed sentence said the opposite').not.toContain('has not been able to confirm');
  });

  it('the floor-ghost event carries the facts the sentence was built from', async () => {
    seedBlocked('t-upheld');
    upholdClaim('t-upheld', 'blocked', 'pm', PM, 'PM confirmed the block is real');
    age('t-upheld');
    await driveLadderToTheEnd();

    const ghost = mockDb.current!.prepare(
      `SELECT payload FROM work_events WHERE work_id = ? AND kind = 'floor_ghosted'`,
    ).get('t-upheld') as { payload: string } | undefined;
    expect(ghost, 'the ghost is recorded on the row, not only spoken').toBeDefined();
    const payload = JSON.parse(ghost!.payload) as Record<string, unknown>;
    expect(payload.blocked_validated).toBe(1);
    expect(String(payload.stated_obstacle)).toContain('vendor API returns 500');
    expect(payload.since).toBeTruthy();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 · ARM 2 — UNRELATED CHATTER MUST NOT RETIRE A PENDING ESCALATION. Run 2, inverted.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§2 an unrelated sentence does not count as telling the owner', () => {
  const STEER_AT = NOW - 60_000;

  beforeEach(() => {
    // The row, and the ask it exists to satisfy (T11's edge).
    seedWork('t-sweep', { state: 'blocked', source_message_id: 'msg-about-this-row' });
    age('t-sweep');
  });

  it('THE MEASURED DEFECT: an unrelated delivery retires the escalation under the OLD read', () => {
    // The primary woke and published a vendor-email bulletin — a real owner-facing delivery,
    // rooted at a DIFFERENT ask.
    seedDelivery({ id: 'd-email', agent: PRIMARY, rootKind: 'ask', rootId: 'msg-some-vendor-email' });

    expect(deliveryForAgentSince(PRIMARY, STEER_AT),
      'the old agent-scoped read sees it and calls the escalation fired',
    ).toBe('d-email');
  });

  it('THE INVERSION: the work-scoped read does not', () => {
    seedDelivery({ id: 'd-email', agent: PRIMARY, rootKind: 'ask', rootId: 'msg-some-vendor-email' });

    expect(deliveryAboutWorkSince('t-sweep', STEER_AT),
      'talking about an email is not telling the owner about this row',
    ).toBeNull();
  });

  it('THE POSITIVE CONTROL: a delivery rooted at THIS row\'s own ask does count', () => {
    seedDelivery({ id: 'd-this', agent: PRIMARY, rootKind: 'ask', rootId: 'msg-about-this-row' });
    expect(deliveryAboutWorkSince('t-sweep', STEER_AT)).toBe('d-this');
  });

  it('THE SECOND EDGE: a delivery rooted at a scheduled RUN of this row counts too', () => {
    // An occurrence is a `work` row since migration 144 absorbed `task_runs`.
    seedWork('run-7', {
      kind: 'occurrence', parent_id: 't-sweep', root_kind: 'schedule', root_id: 't-sweep',
      state: 'open', intent: 'occurrence', title: 'occurrence #7', sequence: 7,
    });
    seedDelivery({ id: 'd-run', agent: PRIMARY, rootKind: 'occurrence', rootId: 'run-7' });
    expect(deliveryAboutWorkSince('t-sweep', STEER_AT)).toBe('d-run');
  });

  it('the narrowings bite: a peer-lane send, an engine ack, and a pre-steer delivery are all refused', () => {
    // Coordination traffic is not a person being told.
    seedDelivery({ id: 'd-a2a', agent: PRIMARY, rootKind: 'ask', rootId: 'msg-about-this-row', channel: 'a2a' });
    expect(deliveryAboutWorkSince('t-sweep', STEER_AT), 'a2a channel').toBeNull();

    // "On it" is not the work arriving.
    mockDb.current!.prepare('DELETE FROM deliveries').run();
    seedDelivery({ id: 'd-ack', agent: PRIMARY, rootKind: 'ask', rootId: 'msg-about-this-row', tool: 'engine-ack' });
    expect(deliveryAboutWorkSince('t-sweep', STEER_AT), 'engine-ack').toBeNull();

    // A sentence from BEFORE the steer cannot be the answer to it.
    mockDb.current!.prepare('DELETE FROM deliveries').run();
    seedDelivery({ id: 'd-old', agent: PRIMARY, rootKind: 'ask', rootId: 'msg-about-this-row', atMs: STEER_AT - 600_000 });
    expect(deliveryAboutWorkSince('t-sweep', STEER_AT), 'before the steer').toBeNull();

    // A send that failed is not a send.
    mockDb.current!.prepare('DELETE FROM deliveries').run();
    seedDelivery({ id: 'd-fail', agent: PRIMARY, rootKind: 'ask', rootId: 'msg-about-this-row', outcome: 'failed' });
    expect(deliveryAboutWorkSince('t-sweep', STEER_AT), 'not delivered').toBeNull();
  });

  it('DRIVEN: with only unrelated chatter on file, the ladder still ends at the owner', async () => {
    seedDelivery({ id: 'd-email', agent: PRIMARY, rootKind: 'ask', rootId: 'msg-some-vendor-email' });
    await driveLadderToTheEnd();
    expect(ownerAlerts().length,
      'this is the arm where the drive watched an email close the case',
    ).toBeGreaterThanOrEqual(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 · ARM 3 — FAILURES COUNT. Run 3, inverted: the ladder was time-only.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§3 failures count toward escalation, not only time', () => {
  /** One recorded failure of the shape the platform already writes. */
  function failPiece(parentId: string, pieceId: string, to: 'failed' | 'abandoned', over: Record<string, unknown> = {}): void {
    seedWork(pieceId, {
      kind: 'task', root_kind: 'a2a_thread', root_id: `thread-${parentId}`,
      parent_id: parentId, state: 'claimed', title: 'a delegated piece', ...over,
    });
    const r = transition(pieceId, {
      to, by: 'agent', actorId: ASSIGNEE, reason: `the peer replied ${to === 'failed' ? 'FAIL' : 'ABANDONED'}`,
    });
    expect(r.kind).toBe('applied');
  }

  it('the three shapes the triage names are all ONE recorded row shape', () => {
    // Stated as a clause so a future reader cannot quietly add a fourth "failure" that no
    // transition writes, or rename one of these without this file going red.
    expect([...FAILURE_TRANSITION_STATES]).toEqual(['blocked', 'failed', 'abandoned']);
  });

  it('THE PARENT EDGE: a row whose delegated pieces failed is counted', () => {
    seedWork('t-parent', { remaining_children: 3 });
    failPiece('t-parent', 'p-1', 'failed');
    failPiece('t-parent', 'p-2', 'failed');
    failPiece('t-parent', 'p-3', 'abandoned');
    age('t-parent');

    expect(workFailureCount('t-parent')).toBe(3);
    expect(candidates(),
      'a recorded failure admits the row; time alone would never have seen it',
    ).toContain('t-parent');
  });

  it('THE THREAD EDGE — the owner\'s own case: a declined ASSIGN left in_progress', () => {
    // The assignee said it cannot do the work. The FAIL settles the PIECE, which belongs to
    // the asker's join tree; the ASSIGN task is left `in_progress` on the agent that declined
    // it, carrying no marker of the refusal at all. It shares only the THREAD with the piece.
    const THREAD = 'thread-abc123';
    seedWork('t-assigned', { a2a_thread_id: THREAD, state: 'claimed' });
    // The asker's join row the pieces hang off — a different row from the ASSIGN task, which
    // is the whole reason the `parent_id` edge cannot see this failure.
    seedWork('t-ask-root', { kind: 'task', root_kind: 'tracker', state: 'claimed', remaining_children: 3 });
    let n = 0;
    for (const state of ['failed', 'failed', 'abandoned'] as const) {
      n += 1;
      seedWork(`piece-${n}`, {
        root_kind: 'a2a_thread', root_id: THREAD, parent_id: 't-ask-root',
        state: 'claimed', title: 'the delegated piece',
      });
      const r = transition(`piece-${n}`, {
        to: state, by: 'agent', actorId: ASSIGNEE, reason: 'the peer replied FAIL',
      });
      expect(r.kind).toBe('applied');
    }
    age('t-assigned');

    expect(workFailureCount('t-assigned'),
      'a parent_id-only count would score the owner\'s own case ZERO',
    ).toBe(3);
    expect(candidates()).toContain('t-assigned');
  });

  it('THE ARM IS AN EXISTENCE TEST, NOT A TUNED COUNT (owner correction 2026-10-07)', () => {
    // ⟨TOMBSTONE⟩ This clause asserted `ESCALATION_FAILURE_THRESHOLD === 3` and that two failures
    // were "under the bound". THE CONSTANT IS GONE: a flat count is a judgement about pace with
    // the pace taken out of it, and the owner's standing rule is that this platform does not write
    // such judgements as numbers. One failure is enough to ADMIT a row; how much room that failure
    // buys is the assignee's measured pace, which §7 drives. There is no number left to assert.
    seedWork('t-one', { remaining_children: 1 });
    failPiece('t-one', 'q-1', 'failed');
    age('t-one');
    expect(workFailureCount('t-one')).toBe(1);
    expect(candidates(), 'some is not none — the shape admits it').toContain('t-one');

    seedWork('t-none');
    age('t-none');
    expect(candidates(), 'and none is still none').not.toContain('t-none');
  });

  it('THE OTHER MUTANT: the thread edge needs a thread, or the count becomes a global tally', () => {
    // A row with NO a2a_thread_id must not inherit every piece whose root_id is NULL.
    seedWork('t-nothread', { a2a_thread_id: null });
    seedWork('someone-elses-ask', { state: 'claimed', remaining_children: 1 });
    seedWork('loose-piece', {
      root_kind: 'a2a_thread', root_id: 'thread-belonging-to-someone-else',
      parent_id: 'someone-elses-ask', state: 'claimed',
    });
    const r = transition('loose-piece', {
      to: 'failed', by: 'agent', actorId: ASSIGNEE, reason: 'unrelated failure',
    });
    expect(r.kind).toBe('applied');
    age('t-nothread');
    expect(workFailureCount('t-nothread'), 'nobody else\'s failure is this row\'s').toBe(0);
  });

  it('the count is DERIVED: it survives with no new event kind and no maintained integer', () => {
    seedWork('t-derived');
    const kinds = (mockDb.current!.prepare(
      'SELECT DISTINCT kind FROM work_events',
    ).all() as Array<{ kind: string }>).map((r) => r.kind);
    failPiece('t-derived', 'r-1', 'failed');
    const after = (mockDb.current!.prepare(
      'SELECT DISTINCT kind FROM work_events',
    ).all() as Array<{ kind: string }>).map((r) => r.kind);
    // Whatever appeared is a kind the platform already wrote before this lane existed.
    for (const k of after) {
      if (!kinds.includes(k)) {
        expect(['transition', 'child_settled', 'join_complete', 'opened']).toContain(k);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §4 · THE NEGATIVE — and it is half the acceptance bar.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§4 healthy progressing work NEVER escalates', () => {
  it('a claimed row that is being worked on is not a candidate, and the owner hears nothing', async () => {
    seedWork('t-healthy', { state: 'claimed', updated_at: NOW - 1_000 });
    expect(candidates()).not.toContain('t-healthy');
    await driveLadderToTheEnd();
    expect(ownerAlerts(), 'nothing is wrong, so nothing is said').toHaveLength(0);
  });

  it('a blocked row that is NOT yet stale is not a candidate — the clock still decides WHEN', () => {
    seedWork('t-fresh', { state: 'blocked', updated_at: NOW - 1_000 });
    expect(candidates()).not.toContain('t-fresh');
  });

  it('a row with three failures that is ACTIVELY MOVING is not a candidate', () => {
    // The failure arm is a fourth SHAPE, not a bypass of the quiet floor. A row being retried
    // right now has a moving `updated_at`, and that is what keeps the arm off an agent
    // mid-recovery.
    seedWork('t-recovering', { remaining_children: 3 });
    for (const [i, state] of (['failed', 'failed', 'abandoned'] as const).entries()) {
      seedWork(`rec-${i}`, {
        root_kind: 'a2a_thread', root_id: 'thread-rec', parent_id: 't-recovering', state: 'claimed',
      });
      const r = transition(`rec-${i}`, {
        to: state, by: 'agent', actorId: ASSIGNEE, reason: 'a failure',
      });
      expect(r.kind).toBe('applied');
    }
    expect(workFailureCount('t-recovering')).toBe(3);
    mockDb.current!.prepare('UPDATE work SET updated_at = ? WHERE id = ?').run(NOW - 1_000, 't-recovering');
    expect(candidates(),
      'failures change WHICH rows can escalate; the clock still decides WHEN',
    ).not.toContain('t-recovering');
  });

  // ════════════════════════════════════════════════════════════════════════════════════
  // ⚠ REVIEW FIX ROUND 2026-10-07 — THIS CONTROL USED TO BE VACUOUS, AND THAT IS HOW A
  // REGRESSION SHIPPED PAST IT.
  //
  // It read: `seedWork('t-failed', { state: 'failed' })` — a RAW `INSERT INTO work`. No
  // `transition()` ran, so `work_events` was empty for that id, so `workFailureCount` was
  // ZERO, so the row could not match the failure arm **for a reason that had nothing to do
  // with its state.** The clause asserted exactly the right law and passed for the wrong
  // reason; the reviewer's own repro is the same row seeded through the real door, scoring 2
  // failures and escalating.
  //
  // Both halves are fixed here, and the second matters as much as the first: the terminal
  // state is now reached THROUGH THE PRODUCTION DOOR, so the row carries the real transition
  // that the real counter counts, and the clause can go red.
  // ════════════════════════════════════════════════════════════════════════════════════

  it('AN OWNER-CANCELLED TASK IS NEVER ESCALATED — driven through the dashboard door', async () => {
    // The row first FAILS for real, so it carries the recorded failures the arm counts. This is
    // the reviewer's `drv-cancel`: without the state bound it scores >= 1 and is admitted.
    seedWork('t-cancelled', { remaining_children: 1 });
    seedWork('t-cancelled-piece', {
      root_kind: 'a2a_thread', root_id: 'thread-cancel', parent_id: 't-cancelled',
      state: 'claimed', title: 'a delegated piece',
    });
    expect(transition('t-cancelled-piece', {
      to: 'failed', by: 'agent', actorId: ASSIGNEE, reason: 'the peer replied FAIL',
    }).kind).toBe('applied');

    // THE REAL DOOR. `setTaskStatusResult` is the tracker's one status door and this is the
    // dashboard PUT's own call, argument for argument (`gateway/routes/tracker.ts`): the owner
    // dragging a card IS the authority, so it carries `claim: 'authoritative'`.
    const { setTaskStatusResult } = await import('../../tracker/schema.js');
    const { result } = setTaskStatusResult('t-cancelled', 'cancelled', {
      by: 'owner', actorId: 'user', claim: 'authoritative',
      reason: 'dashboard PUT /tracker/tasks/:id', resultDeliveryId: null,
    });
    expect(result.kind, 'the cancel really went through the door').toBe('applied');

    // THE PRODUCTION SHAPE IS PRESENT — this is what the old control lacked, and the assertion
    // exists so a future reseed by raw INSERT makes this clause fail instead of passing hollow.
    const row = mockDb.current!.prepare('SELECT state FROM work WHERE id = ?')
      .get('t-cancelled') as { state: string };
    expect(row.state, 'cancelled lands on the `abandoned` spine state').toBe('abandoned');
    expect(workFailureCount('t-cancelled'),
      'the row genuinely scores failures — the old control scored ZERO and could not fail',
    ).toBeGreaterThanOrEqual(1);

    age('t-cancelled');
    expect(candidates(),
      'the owner closed this himself; telling him nobody brought it to him would be false',
    ).not.toContain('t-cancelled');

    await driveLadderToTheEnd();
    expect(ownerAlerts().join('\n'),
      'and nothing reaches him about it, through the whole ladder',
    ).not.toContain('wire up the greenhouse sensor');
  });

  it('every TERMINAL state is bounded, each reached through transition() with real failures', () => {
    // `done` needs a delivery receipt by CHECK, so it is driven with one; the other two are the
    // shapes a failure itself produces.
    for (const [id, to] of [['t-fail', 'failed'], ['t-aband', 'abandoned']] as const) {
      seedWork(id, { remaining_children: 1 });
      seedWork(`${id}-p`, {
        root_kind: 'a2a_thread', root_id: `thread-${id}`, parent_id: id,
        state: 'claimed', title: 'a piece',
      });
      expect(transition(`${id}-p`, {
        to: 'failed', by: 'agent', actorId: ASSIGNEE, reason: 'FAIL',
      }).kind).toBe('applied');
      expect(transition(id, {
        to, by: 'agent', actorId: ASSIGNEE, reason: `the work ${to}`,
      }).kind).toBe('applied');
      expect(workFailureCount(id), 'it really counts failures').toBeGreaterThanOrEqual(1);
      age(id);
      expect(candidates(), `a ${to} row is over, not escalated`).not.toContain(id);
    }
  });

  it('THE OTHER DIRECTION: a genuinely stuck OPEN task with the same failures still escalates', () => {
    // The bound must cost nothing on live work — otherwise the fix for the regression re-opens
    // the void. Same failures, same age, the only difference is that this row is not finished.
    seedWork('t-still-open', { remaining_children: 1, state: 'claimed' });
    seedWork('t-still-open-p', {
      root_kind: 'a2a_thread', root_id: 'thread-open', parent_id: 't-still-open',
      state: 'claimed', title: 'a piece',
    });
    expect(transition('t-still-open-p', {
      to: 'failed', by: 'agent', actorId: ASSIGNEE, reason: 'FAIL',
    }).kind).toBe('applied');
    age('t-still-open');
    expect(workFailureCount('t-still-open')).toBeGreaterThanOrEqual(1);
    expect(candidates(), 'live work that failed is exactly what the arm is for')
      .toContain('t-still-open');
  });

  it('a PAUSED row is not nagged either — the tool contract promises the owner silence in it', () => {
    // This exclusion is beyond the reviewer's required fix and is argued at the predicate: a
    // pause is the owner holding the ball. Coverage is not lost — an UNVALIDATED pause still
    // escalates through the arm that owns that state, which the next clause drives.
    seedWork('t-paused-fail', { remaining_children: 1 });
    seedWork('t-paused-fail-p', {
      root_kind: 'a2a_thread', root_id: 'thread-paused', parent_id: 't-paused-fail',
      state: 'claimed', title: 'a piece',
    });
    expect(transition('t-paused-fail-p', {
      to: 'failed', by: 'agent', actorId: ASSIGNEE, reason: 'FAIL',
    }).kind).toBe('applied');
    expect(transition('t-paused-fail', {
      to: 'paused', by: 'agent', actorId: ASSIGNEE, reason: 'waiting on the owner for a part',
    }).kind).toBe('applied');
    // Validated, so the pause arm correctly has nothing to say about it either.
    upholdClaim('t-paused-fail', 'paused', 'pm', PM, 'the pause is legitimate');
    age('t-paused-fail');
    expect(workFailureCount('t-paused-fail')).toBeGreaterThanOrEqual(1);
    expect(candidates(), 'no pokes, no nags, ever').not.toContain('t-paused-fail');
  });

  it('the one-shot stamp still bounds everything: a row already escalated is not escalated twice', async () => {
    seedBlocked('t-once');
    upholdClaim('t-once', 'blocked', 'pm', PM, 'PM confirmed the block is real');
    age('t-once');
    await driveLadderToTheEnd();
    const first = ownerAlerts().length;
    expect(first).toBeGreaterThanOrEqual(1);

    age('t-once');
    await driveLadderToTheEnd();
    expect(ownerAlerts().length,
      'the permanent `validation_escalated` stamp is what stops the loop',
    ).toBe(first);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §5 · THE SENTENCE — honest-record family. Every clause is a fact on file, or absent.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§5 the owner is told what is blocked, since when, and what was tried', () => {
  const base = {
    title: 'wire up the greenhouse sensor',
    status: 'blocked',
    since: '2026-10-06 11:04',
    agentName: 'Zargo',
    steers: 2,
    failures: 0,
    blockedValidated: false,
    obstacle: null as string | null,
  };

  it('CLAIMS ONLY WHAT THE SYSTEM KNOWS: no assertion that nobody brought it to the owner', () => {
    // REVIEW RULING 2026-10-07. The line asserted "and nobody has brought it to you" as fact,
    // and the review proved it can be false when spoken: for a non-recurring row the verify
    // step cannot see the delivery it asks about (the steer's intent is an ENGINE RIDER, so it
    // never roots a turn), so the platform fires this holding no record either way. The
    // sentence now reports its OWN state, which is true in both worlds.
    const line = ownerEscalationAlertLine({ ...base, obstacle: OBSTACLE });
    expect(line, 'the platform does not claim a fact it has no record of')
      .not.toMatch(/nobody has brought it to you/);
    expect(line, 'it reports what it actually holds').toContain('I have no record of anyone bringing it to you');

    // THE MUTANT THIS FORBIDS, stated as a property rather than a phrase: the alert must make
    // no bare claim about what the AGENT did or did not do. Every remaining clause is either
    // about the platform's own record, the PM's recorded verdict, or quoted from the agent.
    expect(line).not.toMatch(/\bnobody\b/);
  });

  it('names the work and the instant — the old line named neither', () => {
    const line = ownerEscalationAlertLine(base);
    expect(line).toContain('wire up the greenhouse sensor');
    expect(line).toContain('2026-10-06 11:04');
    expect(line).toContain('blocked');
  });

  it('the validator\'s verdict is three-valued and never collapsed', () => {
    expect(ownerEscalationAlertLine({ ...base, blockedValidated: true }))
      .toContain('confirmed the block is real');
    expect(ownerEscalationAlertLine({ ...base, blockedValidated: false }))
      .toContain('has not been able to confirm');
    // THE MUTANT THIS FORBIDS: the pre-t124 line said "your PM cannot confirm it"
    // unconditionally, which fix 1 turns into a lie for the upheld case.
    expect(ownerEscalationAlertLine({ ...base, blockedValidated: true }))
      .not.toContain('cannot confirm');
  });

  it('quotes the agent\'s own obstacle, and omits the clause when there is none', () => {
    const withIt = ownerEscalationAlertLine({ ...base, obstacle: OBSTACLE });
    expect(withIt).toContain('the sensor vendor API returns 500');
    expect(withIt).toContain('said what was in the way');

    const without = ownerEscalationAlertLine({ ...base, obstacle: null });
    expect(without, 'no fact, no clause — never a guess').not.toContain('said what was in the way');

    const blank = ownerEscalationAlertLine({ ...base, obstacle: '   \n  ' });
    expect(blank, 'whitespace is not an obstacle').not.toContain('said what was in the way');
  });

  it('says what the platform itself tried, and counts attempts not sweep passes', () => {
    expect(ownerEscalationAlertLine({ ...base, steers: 1 })).toContain('asked Zargo once');
    expect(ownerEscalationAlertLine({ ...base, steers: 2 })).toContain('asked Zargo 2 times');
  });

  it('the failure clause is omitted at zero rather than printed as a reassurance', () => {
    expect(ownerEscalationAlertLine({ ...base, failures: 0 }))
      .not.toMatch(/come back failed/);
    expect(ownerEscalationAlertLine({ ...base, failures: 1 }))
      .toContain('come back failed or blocked once already');
    expect(ownerEscalationAlertLine({ ...base, failures: 4 }))
      .toContain('come back failed or blocked 4 times already');
  });

  it('a long title and a long obstacle are bounded, not dropped', () => {
    const line = ownerEscalationAlertLine({
      ...base, title: 'x'.repeat(200), obstacle: 'y'.repeat(500),
    });
    expect(line).toContain('…');
    expect(line.length).toBeLessThan(700);
  });

  it('G1: the composer invents no identity — it is a pure function of its arguments', () => {
    // Stated as a STRUCTURAL property rather than a blacklist of names, for two reasons: a
    // blacklist can only catch the names someone thought to list, and writing a real name into
    // a shipped test to assert it is absent is itself the thing G1 forbids (the names gate
    // refused exactly that, correctly, on the first version of this clause).
    //
    // THE PROPERTY: render the same row twice with every identity-bearing input different. Map
    // each input to a common token and the two sentences must be IDENTICAL — so no word in the
    // output came from anywhere but the arguments. A composer that reached for the owner's name,
    // a config value or a database row would leave a residue this cannot normalise away.
    const render = (agentName: string, title: string, since: string, obstacle: string): string =>
      ownerEscalationAlertLine({ ...base, agentName, title, since, obstacle })
        .split(obstacle).join('<OBSTACLE>')
        .split(agentName).join('<AGENT>')
        .split(title).join('<TITLE>')
        .split(since).join('<SINCE>');

    expect(render('Qqq', 'alpha widget', 'INSTANT-1', 'the first obstacle'))
      .toBe(render('Zzz', 'beta gadget', 'INSTANT-2', 'the second obstacle'));
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §7 · OWNER CORRECTION 2026-10-07 — THE FAILURE ARM RUNS ON THE ASSIGNEE'S OWN CLOCK.
//
//   *"we don't specify numbers or times. We make judgement calls based on how fast the model and
//    model provider are. We've been over this so so many times."*
//
// This lane's first cut shipped `ESCALATION_FAILURE_THRESHOLD = 3`. That is the house doctrine's
// own forbidden shape — `tracker/assignee-patience.ts` states it outright: a multiplier needs a
// REFERENCE speed, no such number exists in this platform, and inventing one is the "scaling the
// numbers" fix ruling R1 rejected. The constant is deleted. The arm now reads the rung the ladder
// already names for escalation, floored by the assignee's own declared patience, through the
// SAME two functions in the SAME order `tracker/pm-agent.ts` uses.
//
// Both directions are driven here, which is the point of the correction: a slow assignee must get
// MORE room than a fast one for the identical row and the identical failure.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§7 a slow model gets more room than a fast one before the owner is told', () => {
  /** A provider that DECLARES its patience, and an agent on it. The `models JOIN providers`
   *  shape `patienceFloorFor` reads. */
  function seedAssigneeOnProvider(p: {
    agentId: string; firstChunkMs: number | null; idleMs: number | null;
  }): void {
    const db = mockDb.current!;
    db.prepare(
      `INSERT INTO providers (id, name, type, auth_type, is_validated,
                              first_chunk_timeout_ms, stream_idle_timeout_ms,
                              created_at, updated_at)
       VALUES (@pid, 'P', 'openai-compatible', 'none', 1, @fc, @idle,
               datetime('now'), datetime('now'))`,
    ).run({ pid: `prov-${p.agentId}`, fc: p.firstChunkMs, idle: p.idleMs });
    db.prepare(
      `INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window,
                           is_enabled, created_at, updated_at)
       VALUES (@mid, @pid, 'M', 'm', '["tools"]', 8192, 1, datetime('now'), datetime('now'))`,
    ).run({ mid: `model-${p.agentId}`, pid: `prov-${p.agentId}` });
    db.prepare(
      `INSERT INTO agents (id, name, status, model_id) VALUES (@id, @id, 'idle', @mid)`,
    ).run({ id: p.agentId, mid: `model-${p.agentId}` });
  }

  /** The room this assignee's failures get, resolved exactly as the ladder resolves it. */
  const roomFor = (agentId: string, priority = 'normal'): number =>
    flooredThresholds(
      POKE_THRESHOLDS[priority] ?? POKE_THRESHOLDS.normal,
      patienceFloorFor(agentId).floorSeconds,
    ).escalate;

  /** A row with one recorded failure, owned by `agentId`, idle for `idleSeconds`. */
  function seedFailedRow(id: string, agentId: string, idleSeconds: number, title = 'a failed thing'): void {
    seedWork(id, { agent_id: agentId, remaining_children: 1, title });
    seedWork(`${id}-piece`, {
      agent_id: agentId, root_kind: 'a2a_thread', root_id: `thread-${id}`,
      parent_id: id, state: 'claimed', title: 'a delegated piece',
    });
    const r = transition(`${id}-piece`, {
      to: 'failed', by: 'agent', actorId: agentId, reason: 'the peer replied FAIL',
    });
    expect(r.kind).toBe('applied');
    mockDb.current!.prepare('UPDATE work SET updated_at = ? WHERE id = ?')
      .run(NOW - idleSeconds * 1000, id);
  }

  const SLOW = 'slowpoke';
  const FAST = 'quickdraw';

  beforeEach(() => {
    // A declared ~15-minute first chunk — the deliberately-slow local model t90 was written for.
    seedAssigneeOnProvider({ agentId: SLOW, firstChunkMs: 900_000, idleMs: 120_000 });
    // Declares nothing, so it resolves to the platform defaults: the R6 path.
    seedAssigneeOnProvider({ agentId: FAST, firstChunkMs: null, idleMs: null });
  });

  it('THE PROPORTIONALITY: the slow assignee\'s room is strictly larger, and neither is chosen here', () => {
    const slowFloor = patienceFloorFor(SLOW);
    const fastFloor = patienceFloorFor(FAST);
    expect(slowFloor.basis, 'the provider declared it').toBe('declared');
    expect(fastFloor.basis, 'nothing declared — the defaults, which is the R6 path').toBe('default');

    // The fast floor is the platform's own default total, not a number this file picked.
    expect(fastFloor.floorSeconds)
      .toBe(Math.ceil((STREAM_FIRST_CHUNK_TIMEOUT_MS + STREAM_IDLE_TIMEOUT_MS) / 1000));
    expect(slowFloor.floorSeconds).toBeGreaterThan(fastFloor.floorSeconds);
    expect(roomFor(SLOW), 'a slow model gets proportionally more room').toBeGreaterThan(roomFor(FAST));

    // R6, inherited arithmetic: an UNDECLARED provider leaves the ladder's own table untouched,
    // which is the whole reason this is a floor and not a replacement.
    expect(roomFor(FAST)).toBe(POKE_THRESHOLDS.normal.escalate);
  });

  it('the law is one-directional: the floor can never fire SOONER than the base table', () => {
    // The shape that would otherwise bring escalation forward — a provider declaring a 1-second
    // patience. `flooredThresholds` is all `max`, so it cannot.
    seedAssigneeOnProvider({ agentId: 'blink', firstChunkMs: 1_000, idleMs: 1_000 });
    expect(roomFor('blink')).toBe(POKE_THRESHOLDS.normal.escalate);
  });

  it('DRIVEN, BOTH DIRECTIONS: the same failure at the same age tells the owner about the FAST row only', async () => {
    const idle = Math.floor((roomFor(FAST) + roomFor(SLOW)) / 2);
    expect(idle, 'the probe age sits between the two rooms').toBeGreaterThan(roomFor(FAST));
    expect(idle).toBeLessThan(roomFor(SLOW));

    // Distinct titles, so the owner's own sentence says which row reached him.
    seedFailedRow('t-fast', FAST, idle, 'the quick provider job');
    seedFailedRow('t-slow', SLOW, idle, 'the slow provider job');

    // Both are ADMITTED by the SQL shape — the existence of a failure is identical.
    expect(candidates()).toContain('t-fast');
    expect(candidates()).toContain('t-slow');
    // And the LAW separates them.
    expect(failureArmStillWithinPatience(idle, roomFor(FAST)), 'the fast row is out of room').toBe(false);
    expect(failureArmStillWithinPatience(idle, roomFor(SLOW)), 'the slow row still has room').toBe(true);

    await driveLadderToTheEnd();
    const alerts = ownerAlerts().join('\n');
    expect(alerts, 'the fast assignee\'s failures reached the owner').toContain('the quick provider job');
    expect(alerts,
      'and the slow assignee\'s identical failure did NOT — poking it here is the t90 defect',
    ).not.toContain('the slow provider job');
    // Same fact on the rows' own durable history.
    const slowGhost = mockDb.current!.prepare(
      `SELECT 1 FROM work_events WHERE work_id = ? AND kind = 'floor_ghosted'`,
    ).get('t-slow');
    const fastGhost = mockDb.current!.prepare(
      `SELECT 1 FROM work_events WHERE work_id = ? AND kind = 'floor_ghosted'`,
    ).get('t-fast');
    expect(fastGhost, 'the fast row is out of room and the owner was told').toBeDefined();
    expect(slowGhost,
      'the slow row is inside its own model\'s escalate rung — poking it here is the t90 defect',
    ).toBeUndefined();
  });

  it('AND THE SLOW ROW IS NOT FORGOTTEN: past its OWN room, it escalates too', async () => {
    seedFailedRow('t-slow', SLOW, roomFor(SLOW) + 60);
    await driveLadderToTheEnd();
    const ghost = mockDb.current!.prepare(
      `SELECT 1 FROM work_events WHERE work_id = ? AND kind = 'floor_ghosted'`,
    ).get('t-slow');
    expect(ghost, 'more room is not immunity').toBeDefined();
  });

  it('THE NEGATIVE CONTROL: a STATE shape is not held by patience at all', async () => {
    // A blocked row is late at the SWEEP's bound; its assignee's model speed is irrelevant to
    // that question, and holding it would re-open the void this lane closed.
    seedWork('t-blocked-slow', { agent_id: SLOW });
    const r = transition('t-blocked-slow', {
      to: 'blocked', by: 'agent', actorId: SLOW, reason: 'r', note: OBSTACLE,
    });
    expect(r.kind).toBe('applied');
    mockDb.current!.prepare('UPDATE work SET updated_at = ? WHERE id = ?').run(T, 't-blocked-slow');

    const row = candidateRow('t-blocked-slow');
    expect(row!.by_state_arm, 'it matched a state shape').toBe(1);
    await driveLadderToTheEnd();
    const ghost = mockDb.current!.prepare(
      `SELECT 1 FROM work_events WHERE work_id = ? AND kind = 'floor_ghosted'`,
    ).get('t-blocked-slow');
    expect(ghost, 'the slowest model in the world does not excuse a confirmed block').toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §6 · THE STEER LEDGER still works the way the ladder reads it.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§6 the ladder spends exactly two steers before it speaks', () => {
  it('a steer is recorded per pass and the platform only speaks after the bound', async () => {
    seedBlocked('t-ladder');
    await sweep();
    expect(ownerAlerts(), 'one steer is not a ghost').toHaveLength(0);
    await sweep();
    expect(ownerAlerts(), 'two steers is still not a ghost').toHaveLength(0);
    await sweep();
    expect(ownerAlerts().length, 'the bound is spent; the platform speaks').toBeGreaterThanOrEqual(1);
  });

  it('the steer ledger is durable and countable', () => {
    seedBlocked('t-count');
    recordEscalationSteer('t-count', { attempt: 1, bound: 2, turnNumber: 11 });
    recordEscalationSteer('t-count', { attempt: 2, bound: 2, turnNumber: 12 });
    const rows = mockDb.current!.prepare(
      `SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = 'audit'`,
    ).get('t-count') as { n: number };
    expect(rows.n).toBeGreaterThanOrEqual(2);
  });
});
