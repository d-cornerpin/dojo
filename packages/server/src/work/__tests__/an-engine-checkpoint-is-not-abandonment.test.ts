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
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-engine-checkpoint-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import { listTaskLog, writeTaskLog } from '../../tracker/task-log.js';
import { noteEngineCheckpoint, deliverPendingCirclingVerdict } from '../engine-checkpoint-note.js';
import { pendingCirclingVerdict } from '../../tracker/effort-governor.js';
import { taskScope } from '../tracker-view.js';
import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';
import { endJobCarry, beginJobRun, endJobRun, registerTimerWake } from '../task-freshness.js';

/** t143 round 2: a park happens INSIDE a turn, and touches only the work that turn's trigger names.
 *  Here the trigger is the owner's ask `msg-job`, which opened the job's task (or project). */
function park(reason: 'turn-budget' | 'tool-loop', turnNumber = 5, ask: string | null = 'msg-job'): number {
  const tc = openTurnContext(AGENT);
  tc.turnNumber = turnNumber;
  tc.root = ask ? { kind: 'ask', id: ask, sourceMessageId: ask } : null;
  if (!ask) beginJobRun(AGENT, 'timer');   // a trigger-less park here is the continuation the previous park's own wake started
  try { const n = noteEngineCheckpoint(AGENT, reason); registerTimerWake(AGENT); return n; } finally { endTurnContext(AGENT); endJobRun(AGENT); }
}

const AGENT = 'zargo';
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
  endJobCarry(AGENT);   // the job carry is process memory: no test inherits another's
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
});

describe('an engine checkpoint squares the tracker it interrupts', () => {
  it('RED->GREEN: a claimed task past the gate\'s staleness window is disarmed by the checkpoint note', () => {
    const now = Date.now();
    const stale = now - (CLOSE_OUT_IDLE_MINUTES + 5) * 60_000;
    seedWork('w-inflight', { updated_at: stale, source_message_id: 'msg-job' });

    // Before the checkpoint: the gate's own query already calls this a dangler.
    expect(gateInProgressDanglers(AGENT, now).map((r) => r.id)).toEqual(['w-inflight']);

    const touched = park('turn-budget');

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
    seedWork('w-fresh', { updated_at: fresh, source_message_id: 'msg-job' });

    expect(gateInProgressDanglers(AGENT, now)).toEqual([]); // not a dangler yet

    const touched = park('tool-loop');

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
    seedWork('w-other-agent', { agent_id: OTHER_AGENT, updated_at: stale, source_message_id: 'msg-job' });

    const touched = park('turn-budget');

    expect(touched).toBe(0);
    expect(gateInProgressDanglers(OTHER_AGENT, now).map((r) => r.id)).toEqual(['w-other-agent']);
    expect(listTaskLog('w-other-agent', { kinds: ['observation'] })).toEqual([]);
  });

  it('t143 r2: a claimed task the turn does NOT name is left alone — another conversation or the same one', () => {
    const now = Date.now();
    const stale = now - (CLOSE_OUT_IDLE_MINUTES + 5) * 60_000;
    seedWork('w-job', { updated_at: stale, source_message_id: 'msg-job', origin_conv_key: 'c-job' });
    seedWork('w-abandoned-same-conv', { updated_at: stale, origin_conv_key: 'c-job' });
    seedWork('w-abandoned-other-conv', { updated_at: stale, origin_conv_key: 'c-old' });
    expect(park('turn-budget')).toBe(1);
    expect(gateInProgressDanglers(AGENT, now).map((r) => r.id).sort()).toEqual(['w-abandoned-other-conv', 'w-abandoned-same-conv']);
  });

  it('t143 r3 (C1): the continuation the park queues inherits the job however many other turns ran first; a turn with its own trigger never does', () => {
    const now = Date.now();
    const stale = now - (CLOSE_OUT_IDLE_MINUTES + 5) * 60_000;
    seedWork('w-job', { updated_at: stale, source_message_id: 'msg-job' });
    expect(park('turn-budget', 7)).toBe(1);
    mockDb.current!.prepare('UPDATE work SET updated_at = ? WHERE id = ?').run(stale, 'w-job');
    expect(park('turn-budget', 8, 'msg-other')).toBe(0); // an unrelated ask takes the next turn: it names other work
    expect(park('turn-budget', 9, null)).toBe(1); // the continuation (empty trigger) still carries the job
    mockDb.current!.prepare('UPDATE work SET updated_at = ? WHERE id = ?').run(stale, 'w-job');
    expect(park('turn-budget', 12, null)).toBe(1); // and again, turns later
  });

  it('t143 r4 (M1): a trigger-less turn that is not the continuation (a scheduler wake) does not consume the carry', async () => {
    const now = Date.now();
    const stale = now - (CLOSE_OUT_IDLE_MINUTES + 5) * 60_000;
    seedWork('w-job', { updated_at: stale, source_message_id: 'msg-job' });
    expect(park('turn-budget', 7)).toBe(1);
    mockDb.current!.prepare('UPDATE work SET updated_at = ? WHERE id = ?').run(stale, 'w-job');
    const { stampTasksAtTurnFinalize } = await import('../../tracker/task-stamps.js');
    const tc = openTurnContext(AGENT);   // an unrelated wake: no root, no served work, and it does not park
    tc.turnNumber = 8;
    stampTasksAtTurnFinalize({ agentId: AGENT, turnNumber: 8, outcome: 'answered', answerMessageId: null, rootSourceMessageId: null, convKey: null, servedTaskId: null });
    endTurnContext(AGENT);
    mockDb.current!.prepare('UPDATE work SET updated_at = ? WHERE id = ?').run(stale, 'w-job');
    expect(park('turn-budget', 9, null)).toBe(1); // the real continuation still carries the job
  });

  it('returns 0 and writes nothing when the agent has no in-flight work', () => {
    expect(park('turn-budget')).toBe(0);
  });

  it('also disarms a stranded on_deck task the gate would flag in the second family', () => {
    const now = Date.now();
    const stale = now - (STRANDED_IDLE_MINUTES + 5) * 60_000;
    seedProject('proj-1', { source_message_id: 'msg-job' });
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

    const touched = park('tool-loop');

    expect(touched).toBe(1);
    expect(gateStrandedDanglers(AGENT, now)).toEqual([]);
    expect(listTaskLog('w-stranded', { kinds: ['observation'] }).length).toBe(1);
  });

  it('does NOT touch a stranded on_deck task whose project still has a claimed sibling', () => {
    // The gate's own NOT EXISTS clause: a project with a claimed sibling is not "stranded",
    // it is actively worked, so the checkpoint correctly leaves the on_deck step alone.
    const now = Date.now();
    const stale = now - (STRANDED_IDLE_MINUTES + 5) * 60_000;
    seedProject('proj-2', { source_message_id: 'msg-job' });
    seedWork('w-active-sibling', { kind: 'task', parent_id: 'proj-2', state: 'claimed', updated_at: now });
    seedWork('w-on-deck-sibling', {
      kind: 'task', parent_id: 'proj-2', state: 'on_deck', updated_at: stale,
      schedule_status: 'unscheduled',
    });

    const touched = park('turn-budget');

    // The claimed sibling IS touched (it's the in-flight family); the on_deck one is not.
    expect(touched).toBe(1);
    const onDeckRow = mockDb.current!.prepare('SELECT updated_at FROM work WHERE id = ?')
      .get('w-on-deck-sibling') as { updated_at: number };
    expect(onDeckRow.updated_at).toBe(stale);
    expect(listTaskLog('w-on-deck-sibling', { kinds: ['observation'] })).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// T79 FIX WAVE, FINDING 2 — the circling verdict is handed over at the checkpoint.
// t137 ROUND 2 (R-V333-3): it no longer rides an owner-visible park row (role='system', which the
// model never read); it is handed to the AGENT as a PM-attributed rider notice on the events lane.
// The model-visibility half is driven against the real assembler in
// `agent/v2/__tests__/t137-the-circling-verdict-reaches-the-agent.test.ts`.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('deliverPendingCirclingVerdict — a never-idle agent gets the verdict at its own checkpoint', () => {
  /** Simulates `runEffortReview`'s own circling-branch write (`tracker/pm-agent.ts`): the
   *  durable `effort_review_intervene` task_log entry `pendingCirclingVerdict` reads back. */
  function recordCirclingVerdict(taskId: string, reason: string): void {
    writeTaskLog({ taskId, fromEntity: 'pm', entryKind: 'effort_review_intervene', reason });
  }
  const notices = (): Array<{ lane: string; role: string; origin_intent: string; content: string }> =>
    mockDb.current!.prepare(
      `SELECT lane, role, origin_intent, content FROM messages WHERE agent_id = ? AND content LIKE '%PM EFFORT REVIEW%'`,
    ).all(AGENT) as Array<{ lane: string; role: string; origin_intent: string; content: string }>;

  beforeEach(() => {
    for (const id of [AGENT, OTHER_AGENT]) {
      mockDb.current!.prepare(
        "INSERT OR IGNORE INTO agents (id, name, status, session_started_at) VALUES (?, ?, 'working', '1970-01-01')",
      ).run(id, `Agent ${id}`);
    }
  });

  it('no pending verdict: returns null and writes nothing', () => {
    seedWork('w-quiet', { title: 'Quiet task' });
    expect(deliverPendingCirclingVerdict(AGENT)).toBeNull();
    expect(notices()).toEqual([]);
  });

  it('a claimed task with a recorded circling verdict: a PM-attributed events-lane notice naming the task and quoting the reason, and the latch', () => {
    seedWork('w-circling', { title: 'Sweep the mailbox' });
    recordCirclingVerdict('w-circling', 'same three calls repeated with nothing new landing');

    expect(deliverPendingCirclingVerdict(AGENT), 'a pending circling verdict must be handed over').not.toBeNull();

    const rows = notices();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lane: 'events', role: 'user', origin_intent: 'agent_notice' });
    expect(rows[0].content).toContain('AGENT NOTICE from PM');
    expect(rows[0].content).toContain('Sweep the mailbox');
    expect(rows[0].content).toContain('w-circling');
    expect(rows[0].content).toContain('same three calls repeated with nothing new landing');
    // THE LATCH: the SAME read the guarded poke sweep uses now sees this verdict as delivered.
    expect(pendingCirclingVerdict('w-circling'), 'the marker must be visible to the sweep\'s own read').toBeNull();
  });

  it('the sweep does NOT redeliver what the checkpoint handed over: a second call writes nothing', () => {
    seedWork('w-circling-2', { title: 'Long research sweep' });
    recordCirclingVerdict('w-circling-2', 'circling on the same three files');
    expect(deliverPendingCirclingVerdict(AGENT)).not.toBeNull();
    expect(deliverPendingCirclingVerdict(AGENT), 'already delivered once').toBeNull();
    expect(notices()).toHaveLength(1);
  });

  it('a notice that could not be written is NOT marked delivered: the verdict stays pending for the sweep', () => {
    seedWork('w-circling-3', { title: 'Inbox triage' });
    recordCirclingVerdict('w-circling-3', 'the same search, five times');
    // The notice door's write fails (the row's agent does not exist, so the FK refuses it) —
    // `postAgentNotice` is best-effort and answers null.
    mockDb.current!.prepare('UPDATE work SET agent_id = ? WHERE id = ?').run('ghost-agent', 'w-circling-3');
    mockDb.current!.pragma('foreign_keys = ON');
    expect(deliverPendingCirclingVerdict('ghost-agent')).toBeNull();
    expect(pendingCirclingVerdict('w-circling-3'), 'no row, no latch').not.toBeNull();
  });

  it('an agent with no claimed task at all: returns null', () => {
    expect(deliverPendingCirclingVerdict('nobody-claims-anything')).toBeNull();
  });

  it('a DIFFERENT agent\'s circling verdict is never handed to this agent', () => {
    seedWork('w-other-circling', { agent_id: OTHER_AGENT, title: 'Someone else\'s task' });
    recordCirclingVerdict('w-other-circling', 'not this agent\'s problem');
    expect(deliverPendingCirclingVerdict(AGENT)).toBeNull();
    expect(notices()).toEqual([]);
  });
});
