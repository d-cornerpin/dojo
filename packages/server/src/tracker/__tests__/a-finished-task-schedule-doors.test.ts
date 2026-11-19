// proof-fix V round 5 (R3-1) — setting a schedule on a FINISHED recurring task.
// Owner door (dashboard PUT, schedule alone): reopens the task with the owner's authority, THEN arms
// the schedule, and the 200 is true. Agent doors (work_update edit, work_schedule resume): the
// product already refuses an agent's reopen of a finished row, so they refuse up front with nothing
// changed. Never a silently ended schedule behind an "ok".
import { decide } from '../../work/done/decide.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-finished-sched-test', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/access/read.js', async (orig) => ({
  ...(await orig<typeof import('../../agent/access/read.js')>()),
  toolCategoryGranted: () => true,
}));
const { engine } = vi.hoisted(() => ({ engine: { throws: false } }));
vi.mock('../../scheduler/engine.js', async (orig) => {
  const real = await orig<typeof import('../../scheduler/engine.js')>();
  return { ...real, calculateNextRun: (t: Parameters<typeof real.calculateNextRun>[0]) => {
    if (engine.throws) throw new Error('the walk blew up');
    return real.calculateNextRun(t);
  } };
});
vi.mock('../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../config/platform.js')>()),
  getPrimaryAgentId: () => 'primary',
}));

import { runMigrations } from '../../db/migrations.js';
import { trackerHandlers } from '../../agent/tools/cat/tracker.js';
import { setTrackerStatus } from '../../work/tracker-store.js';
import { listTaskLog } from '../task-log.js';
import { armScheduleOnOwnerSave } from '../finished-task-schedule.js';
import { trackerRouter } from '../../gateway/routes/tracker.js';

const AGENT = 'agent-finished';
type Out = { content: string; isError: boolean };
const call = async (key: string, args: Record<string, unknown>): Promise<Out> =>
  (trackerHandlers[key] as (ctx: unknown) => Promise<Out>)({ agentId: AGENT, args });
const db = (): Database.Database => mockDb.current!;
const row = (id: string) => db().prepare(
  'SELECT state, schedule_status, next_run_at, is_paused, repeat_interval, scheduled_start FROM work WHERE id = ?',
).get(id) as { state: string; schedule_status: string; next_run_at: number | null; is_paused: number; repeat_interval: number | null; scheduled_start: number | null };

/** A recurring task whose schedule ran its course: done, schedule 'completed'. */
async function finishedRecurring(): Promise<string> {
  const out = await call('work_open:task', {
    title: 'Weekly digest', goal: 'digest sent', allow_duplicate: true,
    scheduled_start: new Date(Date.now() + 3_600_000).toISOString(), repeat_interval: 1, repeat_unit: 'days',
  });
  const id = /task_id=([0-9a-f-]{36})/.exec(out.content)![1];
  db().prepare(`INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, outcome, created_at)
    VALUES ('d-fin', ?, NULL, 'dashboard', 'dashboard', 'conv-owner', 'delivered', datetime('now'))`).run(AGENT);
  decide({ workId: id, deciderAgentId: null, verdict: 'owner_done', reason: 'closed' });
  db().prepare("UPDATE work SET schedule_status = 'completed', is_paused = 1, next_run_at = NULL WHERE id = ?").run(id);
  expect(row(id).state).toBe('done');
  return id;
}

beforeEach(() => {
  engine.throws = false;
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare(`INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
    VALUES ('local','Local','openai-compatible','http://127.0.0.1:1/v1','none',1,datetime('now'),datetime('now'))`).run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m1','local','M','m','["text"]',8192,1024,1,datetime('now'),datetime('now'))`).run();
  db().prepare(`INSERT INTO agents (id, name, model_id, status, config, spawn_depth, created_by, created_at, updated_at)
    VALUES (?, 'Worker', 'm1', 'idle', '{}', 1, 'owner', datetime('now'), datetime('now'))`).run(AGENT);
});

describe('a schedule set on a finished recurring task', () => {
  it('OWNER door: the dashboard schedule save reopens the task, arms the schedule, and the 200 is true', async () => {
    const id = await finishedRecurring();
    const start = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const res = await trackerRouter.request(`/tasks/${id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scheduled_start: start, repeat_interval: 1, repeat_unit: 'days' }),
    });
    expect(res.status).toBe(200);
    const r = row(id);
    expect(r.state, 'the finished task is open again').not.toBe('done');
    expect(r.schedule_status).toBe('waiting');
    expect(r.next_run_at!).toBeGreaterThan(Date.now());
    expect(r.is_paused).toBe(0);
  });

  it('AGENT door (work_update edit): refused up front, plain sentence, nothing changed', async () => {
    const id = await finishedRecurring();
    const before = row(id);
    const out = await call('work_update:edit', { task_id: id, repeat_interval: 2, repeat_unit: 'days' });
    expect(out.content).toMatch(/finished/i);
    expect(out.content).toMatch(/nothing was changed/i);
    expect(out.content).toMatch(/dashboard/i);
    expect(out.content).not.toMatch(/\bI\b/);
    expect(row(id)).toEqual(before);
  });

  it('AGENT door (work_schedule resume): refused up front, never reports a resume that did not happen', async () => {
    const id = await finishedRecurring();
    const before = row(id);
    const out = await call('work_schedule:resume', { task_id: id });
    expect(out.content).toMatch(/finished/i);
    expect(out.content).toMatch(/nothing was changed/i);
    expect(out.content).not.toMatch(/^Schedule resumed/);
    expect(row(id)).toEqual(before);
  });

  const put = (id: string, body: unknown) => trackerRouter.request(`/tasks/${id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const SCHED = () => ({ scheduled_start: new Date(Date.now() + 2 * 3_600_000).toISOString(), repeat_interval: 1, repeat_unit: 'days' });
  const snapshot = (id: string) => ({
    row: db().prepare('SELECT * FROM work WHERE id = ?').get(id),
    events: (db().prepare('SELECT COUNT(*) AS n FROM work_events WHERE work_id = ?').get(id) as { n: number }).n,
  });

  it('R4-1 OWNER door is atomic: a hop that fails leaves the row exactly as it was (still finished, schedule unchanged)', async () => {
    const id = await finishedRecurring();
    // The reopen (done -> open) cannot land.
    db().exec(`CREATE TRIGGER no_reopen BEFORE UPDATE ON work WHEN NEW.id = '${id}' AND NEW.state = 'open' BEGIN SELECT RAISE(ABORT, 'no reopen'); END`);
    const before = snapshot(id);
    const res = await put(id, SCHED());
    expect(res.status).not.toBe(200);
    expect(snapshot(id)).toEqual(before);
    expect(row(id).state).toBe('done');
  });

  it('R4-1 OWNER door is atomic: a throw while computing the next run changes nothing', async () => {
    const id = await finishedRecurring();
    const before = snapshot(id);
    engine.throws = true;
    const res = await put(id, SCHED());
    expect(res.status).not.toBe(200);
    expect(snapshot(id)).toEqual(before);
  });

  it('R4-2 OWNER door: the run history says why the finished task came back', async () => {
    const id = await finishedRecurring();
    expect((await put(id, SCHED())).status).toBe(200);
    expect(JSON.stringify(listTaskLog(id, { limit: 50 }))).toMatch(/new schedule on a finished task/);
  });

  it('R4-3 AGENT edit: clearing a finished task\'s schedule arms nothing, so it is let through', async () => {
    const id = await finishedRecurring();
    const out = await call('work_update:edit', { task_id: id, scheduled_start: null, repeat_interval: null, repeat_unit: null });
    expect(out.content, out.content).not.toMatch(/is finished/);
    expect(row(id).state).toBe('done');
  });

  it('R4-4 AGENT refusal: owner-facing words, and a plain verb phrase', async () => {
    const id = await finishedRecurring();
    const edit = await call('work_update:edit', { task_id: id, repeat_interval: 2, repeat_unit: 'days' });
    expect(edit.content).toMatch(/\(complete\)/);
    expect(edit.content).not.toMatch(/\(done\)/);
    const run = await call('work_schedule:resume', { task_id: id });
    expect(run.content).toMatch(/cannot be resumed\. /);
  });

  it('R5-1 OWNER door: a failed save answers a plain sentence (no raw database text), 500, nothing changed', async () => {
    const id = await finishedRecurring();
    db().exec(`CREATE TRIGGER no_reopen2 BEFORE UPDATE ON work WHEN NEW.id = '${id}' AND NEW.state = 'open' BEGIN SELECT RAISE(ABORT, 'secret raw sqlite text'); END`);
    const res = await put(id, SCHED());
    const body = await res.json() as { ok: boolean; error: string };
    expect(res.status).toBe(500);
    expect(body.error).toMatch(/nothing was changed/i);
    expect(body.error).not.toMatch(/secret raw sqlite text|SQLITE/i);
  });

  it('R5-2 OWNER door: a refused arm on a LIVE row answers an honest error, never 200', async () => {
    const out = await call('work_open:task', { title: 'Live one', goal: 'g', allow_duplicate: true });
    const id = /task_id=([0-9a-f-]{36})/.exec(out.content)![1];
    const err = armScheduleOnOwnerSave(id, () => ({ kind: 'refused', workId: id, reason: 'no-such-work', detail: 'gone' }));
    expect(err).toMatch(/could not be saved/);
  });
});
