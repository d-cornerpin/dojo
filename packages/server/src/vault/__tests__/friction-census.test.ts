// K34 — the engine, with no model, finds the tasks that went badly, and hands the Dreamer one
// ROUGH TASKS batch: a timeline per task and the form to fill. It never touches the primary.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

import { runMigrations } from '../../db/migrations.js';
import { frictionCensus } from '../friction-census.js';
import { buildRoughTasksBatch } from '../rough-tasks-batch.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const SINCE = NOW - DAY;
let seq = 0;

function task(id: string, agentId: string, title: string): void {
  mockDb.current!.prepare(
    `INSERT INTO work (id, kind, agent_id, assignee_agent, requester, requester_id, root_kind, root_id, state, intent,
                       wakes, closes_thread, title, goal, opened_at, updated_at, provenance)
     VALUES (?, 'task', ?, ?, 'owner', 'owner', 'tracker', ?, 'claimed', 'action', 1, 0, ?, 'goal text', ?, ?, 'live')`,
  ).run(id, agentId, agentId, `turn:${++seq}`, title, NOW - 2 * DAY, NOW - 2 * DAY);
}
function event(workId: string, kind: string, payload: object | null, atMs = NOW - 3600_000, actor = 'engine'): number {
  return Number(mockDb.current!.prepare('INSERT INTO work_events (work_id, kind, payload, actor, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(workId, kind, payload ? JSON.stringify(payload) : null, actor, atMs).lastInsertRowid);
}

beforeEach(() => {
  seq = 0;
  mockDb.current = new Database(':memory:');
  runMigrations();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('frictionCensus — deterministic, no model', () => {
  it('a seeded day with two rough tasks: the census finds both, with their kinds and event ids', () => {
    task('task-rough-1', 'agent-x', 'File the quarterly summary');
    const e1 = event('task-rough-1', 'rearm_refused', { reason: 'x' });
    const e2 = event('task-rough-1', 'claim_rejected', { note: 'not done' });
    task('task-rough-2', 'agent-y', 'Book the venue');
    const e3 = event('task-rough-2', 'audit', { entry_kind: 'ladder_pm' });
    const e4 = event('task-rough-2', 'floor_ghosted', { floor: 'delegated-job-stuck' });
    task('task-quiet', 'agent-z', 'Water the plants');
    event('task-quiet', 'audit', { entry_kind: 'ladder_hint' });
    event('task-quiet', 'transition', { to: 'done' });

    const found = frictionCensus(SINCE);
    expect(found.map((f) => f.taskId).sort()).toEqual(['task-rough-1', 'task-rough-2']);
    const one = found.find((f) => f.taskId === 'task-rough-1')!;
    expect(one.agentId).toBe('agent-x');
    expect(one.kinds.sort()).toEqual(['claim_rejected', 'rearm_refused']);
    expect(one.eventIds.sort()).toEqual([e1, e2].sort());
    const two = found.find((f) => f.taskId === 'task-rough-2')!;
    expect(two.kinds.sort()).toEqual(['floor_ghosted', 'stall_escalated']);
    expect(two.eventIds.sort()).toEqual([e3, e4].sort());
  });

  it('a task that ended failed is rough; one that was abandoned or finished is not', () => {
    task('task-failed', 'agent-x', 'Helper errored out');
    const ef = event('task-failed', 'transition', { from: 'claimed', to: 'failed' });
    task('task-dropped', 'agent-y', 'Owner dropped it');
    event('task-dropped', 'transition', { from: 'claimed', to: 'abandoned' });
    task('task-fine', 'agent-z', 'Went fine');
    event('task-fine', 'transition', { from: 'claimed', to: 'done' });
    task('task-failed-old', 'agent-x', 'Failed long ago');
    event('task-failed-old', 'transition', { to: 'failed' }, NOW - 3 * DAY);

    const found = frictionCensus(SINCE);
    expect(found.map((f) => f.taskId)).toEqual(['task-failed']);
    expect(found[0].kinds).toEqual(['task_failed']);
    expect(found[0].eventIds).toEqual([ef]);
  });

  it('friction older than the window is not this cycle\'s', () => {
    task('task-old', 'agent-x', 'Old trouble');
    event('task-old', 'claim_rejected', { note: 'n' }, NOW - 3 * DAY);
    expect(frictionCensus(SINCE)).toEqual([]);
  });

  it('an identical-call refusal and a destructive hold, tied to the task by the turn that claimed it', () => {
    task('task-brake', 'agent-b', 'Loop on a call');
    const claim = event('task-brake', 'claim_turn', { turn_number: 7 });
    const db = mockDb.current!;
    db.prepare("INSERT INTO agents (id, name, status, config) VALUES ('agent-b', 'B', 'idle', '{}')").run();
    db.prepare(`INSERT INTO turns (agent_id, turn_number, started_at, ended_at, exit_reason, answered)
                VALUES ('agent-b', 7, datetime('now', '-1 hour'), datetime('now', '-1 hour'), 'identical_call', 0)`).run();
    task('task-held', 'agent-b', 'Delete something');
    const claim2 = event('task-held', 'claim_turn', { turn_number: 9 });
    db.prepare(`INSERT INTO destructive_approvals (token, agent_id, tool_name, signature, request_text, turn_number)
                VALUES ('tok', 'agent-b', 'file_delete', 'sig', 'delete a thing', 9)`).run();
    const found = frictionCensus(SINCE);
    expect(found.find((f) => f.taskId === 'task-brake')!.kinds).toEqual(['identical_call_refused']);
    expect(found.find((f) => f.taskId === 'task-brake')!.eventIds).toEqual([claim]);
    expect(found.find((f) => f.taskId === 'task-held')!.kinds).toEqual(['destructive_hold']);
    expect(found.find((f) => f.taskId === 'task-held')!.eventIds).toEqual([claim2]);
  });
});

describe('buildRoughTasksBatch — the Dreamer\'s one batch', () => {
  it('contains a timeline for each rough task and the four-line form, and none for a quiet task', () => {
    task('task-rough-1', 'agent-x', 'File the quarterly summary');
    const e1 = event('task-rough-1', 'rearm_refused', { reason: 'boot reconciliation' });
    task('task-rough-2', 'agent-y', 'Book the venue');
    const e2 = event('task-rough-2', 'floor_ghosted', { floor: 'delegated-job-stuck' });
    task('task-quiet', 'agent-z', 'Water the plants');
    event('task-quiet', 'audit', { entry_kind: 'ladder_hint' });

    const batch = buildRoughTasksBatch(SINCE, 100_000)!;
    expect(batch.verbatim).toBe(true);
    expect(batch.ids).toEqual([]);
    expect(batch.text).toContain('task-rough-1');
    expect(batch.text).toContain('File the quarterly summary');
    expect(batch.text).toContain(`#${e1}`);
    expect(batch.text).toContain('task-rough-2');
    expect(batch.text).toContain(`#${e2}`);
    expect(batch.text).not.toContain('task-quiet');
    for (const line of ['CUE:', 'LESSON:', 'EVIDENCE:', 'CONFIDENCE:', 'NO_ENTRY']) expect(batch.text).toContain(line);
    expect(batch.text).toContain('lesson_record');
  });

  it('no rough tasks: no batch', () => {
    task('task-quiet', 'agent-z', 'Water the plants');
    expect(buildRoughTasksBatch(SINCE, 100_000)).toBeNull();
  });

  it('building it writes no message to anyone (nothing wakes the main agent)', () => {
    task('task-rough-1', 'agent-x', 'File the summary');
    event('task-rough-1', 'rearm_refused', { reason: 'r' });
    const before = (mockDb.current!.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    buildRoughTasksBatch(SINCE, 100_000);
    expect((mockDb.current!.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(before);
  });
});
