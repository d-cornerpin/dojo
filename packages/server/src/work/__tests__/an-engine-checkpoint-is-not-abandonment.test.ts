// AN ENGINE CHECKPOINT IS NOT ABANDONMENT, AND NOT PROGRESS EITHER. A park carries the job's work to the
// continuation it queues and leaves one engine note on each of this agent's open tasks the job names; it never
// moves a task (so a job that stops moving still reads as stalled), and it leaves unnamed or other agents'
// work alone.

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
import { noteEngineCheckpoint } from '../engine-checkpoint-note.js';
import { endTurnContext } from '../../agent/turn-context.js';
import { liveTurn } from '../../agent/v2/__tests__/helpers/live-turn.js';
import { FXID } from '../../../../../deploy/checks/fixture-vocabulary.mjs';

/** t143 round 2: a park happens INSIDE a turn, and touches only the work that turn's trigger names.
 *  Here the trigger is the owner's ask `msg-job`, which opened the job's task (or project). */
function park(reason: 'turn-budget', turnNumber = 5, ask: string | null = 'msg-job'): number {
  // A trigger-less park here is the job's own turn, started from its task.
  liveTurn(AGENT, ask ? { turnNumber, root: { kind: 'ask', id: ask, sourceMessageId: ask } }
    : { turnNumber, root: null, servedJob: 'w-job', servedWork: { taskId: 'w-job', runId: null, taskKind: null, originConvKey: null } });
  try { return noteEngineCheckpoint(AGENT, reason); } finally { endTurnContext(AGENT); }
}

const AGENT = FXID.n4;
const OTHER_AGENT = 'dreamer';
const T = 1_700_000_000_000;

function seedWork(id: string, over: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id, kind: 'task', parent_id: null, agent_id: AGENT, assignee_agent: null,
    requester: 'agent', requester_id: AGENT, conversation_id: null,
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

const moved = (id: string): number => (mockDb.current!.prepare('SELECT updated_at AS u FROM work WHERE id = ?').get(id) as { u: number }).u;
const notes = (id: string): number => listTaskLog(id, { kinds: ['observation'] }).length;

beforeEach(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
});

describe('an engine checkpoint carries the job and notes it, without moving it', () => {
  it('the job\'s open task gets one engine note naming the checkpoint, and its clock does not move', () => {
    const stale = Date.now() - 15 * 60_000;
    seedWork('w-inflight', { updated_at: stale, source_message_id: 'msg-job' });
    expect(park('turn-budget')).toBe(1);
    const entries = listTaskLog('w-inflight', { kinds: ['observation'] });
    expect(entries.map((e) => [e.fromEntity, e.reason])).toEqual([['engine', 'engine checkpoint: turn-budget']]);
    expect(moved('w-inflight')).toBe(stale);
  });

  it('another agent\'s task and a task the turn does not name are left alone', () => {
    seedWork('w-job', { source_message_id: 'msg-job', origin_conv_key: 'c-job' });
    seedWork('w-other-agent', { agent_id: OTHER_AGENT, source_message_id: 'msg-job' });
    seedWork('w-abandoned-same-conv', { origin_conv_key: 'c-job' });
    expect(park('turn-budget')).toBe(1);
    expect([notes('w-job'), notes('w-other-agent'), notes('w-abandoned-same-conv')]).toEqual([1, 0, 0]);
  });

  it('the job\'s own turn names the job however many other turns ran first; a turn with its own trigger never does', () => {
    const now = Date.now();
    const stale = now - 15 * 60_000;
    seedWork('w-job', { updated_at: stale, source_message_id: 'msg-job' });
    expect(park('turn-budget', 7)).toBe(1);
    mockDb.current!.prepare('UPDATE work SET updated_at = ? WHERE id = ?').run(stale, 'w-job');
    expect(park('turn-budget', 8, 'msg-other')).toBe(0); // an unrelated ask takes the next turn: it names other work
    expect(park('turn-budget', 9, null)).toBe(1); // the job's own turn (empty trigger) still names the job
    mockDb.current!.prepare('UPDATE work SET updated_at = ? WHERE id = ?').run(stale, 'w-job');
    expect(park('turn-budget', 12, null)).toBe(1); // and again, turns later
  });

  it('a trigger-less turn that is not the job\'s (a scheduler wake) takes nothing from the job', async () => {
    const now = Date.now();
    const stale = now - 15 * 60_000;
    seedWork('w-job', { updated_at: stale, source_message_id: 'msg-job' });
    expect(park('turn-budget', 7)).toBe(1);
    mockDb.current!.prepare('UPDATE work SET updated_at = ? WHERE id = ?').run(stale, 'w-job');
    const { stampTasksAtTurnFinalize } = await import('../../tracker/task-stamps.js');
    liveTurn(AGENT, { turnNumber: 8, root: null });   // an unrelated wake: no root, no served work, and it does not park
    stampTasksAtTurnFinalize({ agentId: AGENT, turnNumber: 8, outcome: 'answered', answerMessageId: null, convKey: null, servedTaskId: null });
    endTurnContext(AGENT);
    mockDb.current!.prepare('UPDATE work SET updated_at = ? WHERE id = ?').run(stale, 'w-job');
    expect(park('turn-budget', 9, null)).toBe(1); // the job's own turn still names the job
  });

  it('returns 0 and writes nothing when the agent has no in-flight work', () => {
    expect(park('turn-budget')).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// T79 FIX WAVE, FINDING 2 — the circling verdict is handed over at the checkpoint.
// t137 ROUND 2 (R-V333-3): it no longer rides an owner-visible park row (role='system', which the
// model never read); it is handed to the AGENT as a PM-attributed rider notice on the events lane.
// The model-visibility half is driven against the real assembler in
// `agent/v2/__tests__/t137-the-circling-verdict-reaches-the-agent.test.ts`.
// ════════════════════════════════════════════════════════════════════════════════════════
