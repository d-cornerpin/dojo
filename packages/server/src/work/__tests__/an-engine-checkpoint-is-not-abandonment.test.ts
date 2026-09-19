// T79a (SLOW-INFERENCE PLAN) — AN ENGINE CHECKPOINT IS NOT ABANDONMENT.
//
// The gate's own dangler predicates (`agent/v2/steps/preflight/closeout-gate.ts` ~63-103) are
// reproduced HERE, byte-for-byte in shape, as the test's own oracle: this file does not import
// the gate (that would require the whole `TurnContext`/`PreflightContext` rig this unit test
// has no business standing up), it re-derives what the gate would find, the same way the gate
// finds it. `gateInProgressDanglers` / `gateStrandedDanglers` are that oracle.
//
// THE CLAIM UNDER TEST: `work/engine-checkpoint-note.ts`'s `noteEngineCheckpoint` makes both
// oracle queries return zero rows for an agent it was just called on, and leaves one
// `entryKind: 'observation'`, `fromEntity: 'engine'` trail entry behind naming why.

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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-engine-checkpoint-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import { listTaskLog, writeTaskLog } from '../../tracker/task-log.js';
import { noteEngineCheckpoint, pendingCirclingVerdictParkLine } from '../engine-checkpoint-note.js';
import { pendingCirclingVerdict } from '../../tracker/effort-governor.js';
import { taskScope } from '../tracker-view.js';

const AGENT = 'kevin';
const OTHER_AGENT = 'dreamer';
const T = 1_700_000_000_000;
const CLOSE_OUT_IDLE_MINUTES = 10;
const STRANDED_IDLE_MINUTES = 30;

function seedWork(id: string, over: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id, kind: 'task', parent_id: null, agent_id: AGENT, assignee_agent: null,
    requester: 'owner', requester_id: 'owner', conversation_id: null,
    root_kind: 'tracker', root_id: id, state: 'claimed', claimed_by_turn: null,
    result_delivery_id: null, intent: 'do-it', wakes: 1, closes_thread: 0,
    hop_count: 0, superseded_by: null, title: 'a thing', goal: null, priority: 'normal',
    notes: null, remaining_children: null, compile_pending: 0, ttl_at: null,
    reply_conversation_id: null, attempts: 0, next_attempt_at: null, schedule_json: null,
    tz: null, anchor_local: null, next_run_at: null, sequence: null,
    scheduled_start: null, schedule_status: null, is_paused: 0,
    opened_at: T, closed_at: null, updated_at: T, provenance: 'live', ...over,
  };
  const cols = Object.keys(row);
  mockDb.current!.prepare(
    `INSERT INTO work (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`,
  ).run(row);
}

function seedProject(id: string, over: Record<string, unknown> = {}): void {
  seedWork(id, { kind: 'project', state: 'open', requester_id: AGENT, ...over });
}

/** The gate's own query 1 (`closeout-gate.ts` ~64-72), unmodified. */
function gateInProgressDanglers(agentId: string, now: number): Array<{ id: string }> {
  return mockDb.current!.prepare(`
    SELECT w.id AS id FROM work w
    WHERE ${taskScope('w')} AND w.agent_id = ?
      AND w.state = 'claimed'
      AND w.is_paused = 0
      AND w.updated_at < ?
  `).all(agentId, now - CLOSE_OUT_IDLE_MINUTES * 60_000) as Array<{ id: string }>;
}

/** The gate's own query 2 (`closeout-gate.ts` ~86-103), unmodified. */
function gateStrandedDanglers(agentId: string, now: number): Array<{ id: string }> {
  return mockDb.current!.prepare(`
    SELECT t.id AS id FROM work t
    INNER JOIN work p ON p.id = t.parent_id
    WHERE ${taskScope('t')} AND t.agent_id = ?
      AND t.state = 'on_deck'
      AND t.is_paused = 0
      AND (t.scheduled_start IS NULL OR t.scheduled_start <= ?)
      AND t.schedule_status != 'waiting'
      AND p.requester_id = ?
      AND p.state = 'open'
      AND t.updated_at < ?
      AND NOT EXISTS (
        SELECT 1 FROM work sib
        WHERE sib.parent_id = p.id AND sib.kind = 'task' AND sib.state = 'claimed'
      )
  `).all(agentId, now, agentId, now - STRANDED_IDLE_MINUTES * 60_000) as Array<{ id: string }>;
}

beforeEach(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
});

describe('an engine checkpoint squares the tracker it interrupts', () => {
  it('RED->GREEN: a claimed task past the gate\'s staleness window is disarmed by the checkpoint note', () => {
    const now = Date.now();
    const stale = now - (CLOSE_OUT_IDLE_MINUTES + 5) * 60_000;
    seedWork('w-inflight', { updated_at: stale });

    // Before the checkpoint: the gate's own query already calls this a dangler.
    expect(gateInProgressDanglers(AGENT, now).map((r) => r.id)).toEqual(['w-inflight']);

    const touched = noteEngineCheckpoint(AGENT, 'turn-budget');

    expect(touched).toBe(1);
    // After the checkpoint: the SAME gate query, unmodified, finds nothing.
    expect(gateInProgressDanglers(AGENT, now)).toEqual([]);

    const entries = listTaskLog('w-inflight', { kinds: ['observation'] });
    expect(entries.length).toBe(1);
    expect(entries[0].fromEntity).toBe('engine');
    expect(entries[0].reason).toContain('turn-budget');
  });

  it('touches a task that has NOT yet gone stale — the checkpoint is not a staleness check', () => {
    const now = Date.now();
    const fresh = now - 30_000; // 30 seconds ago, nowhere near the 10-minute window
    seedWork('w-fresh', { updated_at: fresh });

    expect(gateInProgressDanglers(AGENT, now)).toEqual([]); // not a dangler yet

    const touched = noteEngineCheckpoint(AGENT, 'tool-loop');

    expect(touched).toBe(1);
    const row = mockDb.current!.prepare('SELECT updated_at FROM work WHERE id = ?')
      .get('w-fresh') as { updated_at: number };
    expect(row.updated_at).toBeGreaterThanOrEqual(now);

    const entries = listTaskLog('w-fresh', { kinds: ['observation'] });
    expect(entries.length).toBe(1);
    expect(entries[0].reason).toContain('tool-loop');
  });

  it('leaves another agent\'s claimed task untouched', () => {
    const now = Date.now();
    const stale = now - (CLOSE_OUT_IDLE_MINUTES + 5) * 60_000;
    seedWork('w-other-agent', { agent_id: OTHER_AGENT, updated_at: stale });

    const touched = noteEngineCheckpoint(AGENT, 'turn-budget');

    expect(touched).toBe(0);
    expect(gateInProgressDanglers(OTHER_AGENT, now).map((r) => r.id)).toEqual(['w-other-agent']);
    expect(listTaskLog('w-other-agent', { kinds: ['observation'] })).toEqual([]);
  });

  it('returns 0 and writes nothing when the agent has no in-flight work', () => {
    expect(noteEngineCheckpoint(AGENT, 'turn-budget')).toBe(0);
  });

  it('also disarms a stranded on_deck task the gate would flag in the second family', () => {
    const now = Date.now();
    const stale = now - (STRANDED_IDLE_MINUTES + 5) * 60_000;
    seedProject('proj-1');
    // `schedule_status: 'unscheduled'` — the legacy default for a plain (non-recurring)
    // on_deck task (`009_phase6.sql`'s `DEFAULT 'unscheduled'`, backfilled into `work` by
    // `137_work_attributes.sql`). NULL would also satisfy the gate's own `!= 'waiting'` NO —
    // SQLite's NULL-comparison rule makes `NULL != 'waiting'` unknown, not true, so a raw NULL
    // silently fails the gate's own predicate too. 'unscheduled' is the real, lived-in value.
    seedWork('w-stranded', {
      kind: 'task', parent_id: 'proj-1', state: 'on_deck', updated_at: stale,
      schedule_status: 'unscheduled',
    });

    expect(gateStrandedDanglers(AGENT, now).map((r) => r.id)).toEqual(['w-stranded']);

    const touched = noteEngineCheckpoint(AGENT, 'tool-loop');

    expect(touched).toBe(1);
    expect(gateStrandedDanglers(AGENT, now)).toEqual([]);
    expect(listTaskLog('w-stranded', { kinds: ['observation'] }).length).toBe(1);
  });

  it('does NOT touch a stranded on_deck task whose project still has a claimed sibling', () => {
    // The gate's own NOT EXISTS clause: a project with a claimed sibling is not "stranded",
    // it is actively worked, so the checkpoint correctly leaves the on_deck step alone.
    const now = Date.now();
    const stale = now - (STRANDED_IDLE_MINUTES + 5) * 60_000;
    seedProject('proj-2');
    seedWork('w-active-sibling', { kind: 'task', parent_id: 'proj-2', state: 'claimed', updated_at: now });
    seedWork('w-on-deck-sibling', {
      kind: 'task', parent_id: 'proj-2', state: 'on_deck', updated_at: stale,
      schedule_status: 'unscheduled',
    });

    const touched = noteEngineCheckpoint(AGENT, 'turn-budget');

    // The claimed sibling IS touched (it's the in-flight family); the on_deck one is not.
    expect(touched).toBe(1);
    const onDeckRow = mockDb.current!.prepare('SELECT updated_at FROM work WHERE id = ?')
      .get('w-on-deck-sibling') as { updated_at: number };
    expect(onDeckRow.updated_at).toBe(stale);
    expect(listTaskLog('w-on-deck-sibling', { kinds: ['observation'] })).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// T79 FIX WAVE, FINDING 2 — the circling verdict rides the checkpoint park message.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('pendingCirclingVerdictParkLine — a never-idle agent gets the verdict on its own checkpoint', () => {
  /** Simulates `runEffortReview`'s own circling-branch write (`tracker/pm-agent.ts`): the
   *  durable `effort_review_intervene` task_log entry `pendingCirclingVerdict` reads back. */
  function recordCirclingVerdict(taskId: string, reason: string): void {
    writeTaskLog({ taskId, fromEntity: 'pm', entryKind: 'effort_review_intervene', reason });
  }

  it('no pending verdict: returns null, the byte-identical-message case', () => {
    seedWork('w-quiet', { title: 'Quiet task' });
    expect(pendingCirclingVerdictParkLine(AGENT)).toBeNull();
  });

  it('a claimed task with a recorded circling verdict: returns a line naming the task and quoting the PM\'s reason, and latches the delivery marker', () => {
    seedWork('w-circling', { title: 'Sweep the mailbox' });
    recordCirclingVerdict('w-circling', 'same three calls repeated with nothing new landing');

    const line = pendingCirclingVerdictParkLine(AGENT);

    expect(line, 'a pending circling verdict must produce a line').not.toBeNull();
    expect(line).toContain('Sweep the mailbox');
    expect(line).toContain('w-circling');
    expect(line).toContain('same three calls repeated with nothing new landing');

    // THE LATCH: the SAME read the guarded poke sweep uses now sees this verdict as already
    // delivered — proven directly against `tracker/effort-governor.ts`'s real export, not a
    // re-invocation of this function.
    expect(pendingCirclingVerdict('w-circling'), 'the marker this checkpoint just wrote must be visible to the sweep\'s own read').toBeNull();
  });

  it('the sweep does NOT redeliver what the checkpoint already surfaced: a second checkpoint call also returns null', () => {
    seedWork('w-circling-2', { title: 'Long research sweep' });
    recordCirclingVerdict('w-circling-2', 'circling on the same three files');

    const first = pendingCirclingVerdictParkLine(AGENT);
    expect(first).toContain('circling on the same three files');

    const second = pendingCirclingVerdictParkLine(AGENT);
    expect(second, 'already delivered once; a second checkpoint must not re-surface it').toBeNull();
  });

  it('an agent with no claimed task at all: returns null', () => {
    expect(pendingCirclingVerdictParkLine('nobody-claims-anything')).toBeNull();
  });

  it('a DIFFERENT agent\'s circling verdict is never surfaced for this agent', () => {
    seedWork('w-other-circling', { agent_id: OTHER_AGENT, title: 'Someone else\'s task' });
    recordCirclingVerdict('w-other-circling', 'not this agent\'s problem');

    expect(pendingCirclingVerdictParkLine(AGENT)).toBeNull();
  });
});
