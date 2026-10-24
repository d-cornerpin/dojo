// v3.5 DONE IS MEASURED, fix round 1 — EVERY way to mark a task complete goes through the same
// remainder judgement: the measure is re-read at the close, whatever the status is spelled, and
// items left are refused unless named. Doors: work_update status (any spelling) and complete_step,
// work_schedule(pause, mark_complete=true), close_project(status="complete").
//
// Driven through the work verbs' own door (`agent/tools/cat/tracker.ts`), because that is where
// the measure is read (it is I/O) before the synchronous close door judges it. The schema is the
// real migration chain. Two seams only: the counter (`countMeasure`, so no mailbox is read) and
// the agent's category grant (so the executor's own wall can be shown refusing).
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-measured-close-test', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
const { countMeasure, granted } = vi.hoisted(() => ({ countMeasure: vi.fn(), granted: { value: true } }));
vi.mock('../../work/measure.js', async (orig) => ({ ...(await orig<typeof import('../../work/measure.js')>()), countMeasure }));
vi.mock('../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../config/platform.js')>()),
  isPMAgent: (id: string) => id === 'pm-agent-x',
}));
vi.mock('../../agent/access/read.js', async (orig) => ({
  ...(await orig<typeof import('../../agent/access/read.js')>()),
  toolCategoryGranted: () => granted.value,
}));

import { runMigrations } from '../../db/migrations.js';
import { trackerHandlers } from '../../agent/tools/cat/tracker.js';
import { claimOccurrence } from '../../work/occurrences.js';

const AGENT = 'agent-measured';
const MEASURE = { tool: 'gmail_search', args: { query: 'in:inbox -label:Done' }, unit: 'messages' };
const CLOSE = { result: 'done', evidence: [{ kind: 'claim', claim: 'labelled the messages the query listed' }] };

type Out = { content: string; isError: boolean };
const call = async (key: string, args: Record<string, unknown>, agentId = AGENT): Promise<Out> =>
  (trackerHandlers[key] as (ctx: unknown) => Promise<Out>)({ agentId, args });

const db = (): Database.Database => mockDb.current!;
const readWork = (id: string) => db().prepare('SELECT state, measure_json, measure_initial, measure_remaining, measure_at, next_run_at FROM work WHERE id = ?').get(id) as {
  state: string; measure_json: string | null; measure_initial: number | null; measure_remaining: number | null; measure_at: number | null; next_run_at: number | null;
};
const lastEvent = (id: string, kind: string) => {
  const r = db().prepare('SELECT payload, actor FROM work_events WHERE work_id = ? AND kind = ? ORDER BY id DESC LIMIT 1').get(id, kind) as { payload: string; actor: string } | undefined;
  return r ? { actor: r.actor, payload: JSON.parse(r.payload) as Record<string, unknown> } : undefined;
};
const taskIdFrom = (out: Out): string => {
  const m = /task_id=([0-9a-f-]{36})/.exec(out.content);
  if (!m) throw new Error(`no task id in: ${out.content}`);
  return m[1];
};

/** A result that reached the person — what a one-shot close points at (`deliveryForTaskClose`). */
function seedDelivery(): void {
  db().prepare(`INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, outcome, created_at)
    VALUES (?, ?, NULL, 'dashboard', 'dashboard', 'conv-owner', 'delivered', datetime('now', '+1 second'))`).run(`d-${Math.random()}`, AGENT);
}

async function openMeasured(initial: number, extra: Record<string, unknown> = {}): Promise<string> {
  countMeasure.mockResolvedValueOnce({ ok: true, count: initial });
  const out = await call('work_open:task', { title: 'Sort the inbox', goal: 'every inbox message labelled', measure: MEASURE, ...extra });
  const id = taskIdFrom(out);
  await call('work_update:status', { task_id: id, status: 'in_progress' });
  seedDelivery();
  return id;
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare(`INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
    VALUES ('local','Local','openai-compatible','http://127.0.0.1:1/v1','none',1,datetime('now'),datetime('now'))`).run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m1','local','M','m','["text"]',8192,1024,1,datetime('now'),datetime('now'))`).run();
  db().prepare(`INSERT INTO agents (id, name, model_id, status, config, spawn_depth, created_by, created_at, updated_at)
    VALUES (?, 'Worker', 'm1', 'idle', '{}', 1, 'owner', datetime('now'), datetime('now'))`).run(AGENT);
  countMeasure.mockReset();
  granted.value = true;
});


const remainderNotes = (id: string): number =>
  (db().prepare("SELECT payload FROM work_events WHERE work_id = ? AND kind = 'audit'").all(id) as Array<{ payload: string }>)
    .filter((r) => r.payload.includes('Remainder named at close')).length;

describe('A4-I1: the close re-reads the measure whatever "complete" is spelled', () => {
  for (const word of ['done', 'completed', 'Complete', ' finished ']) {
    it(`status=${JSON.stringify(word)} re-reads, and at zero the close proceeds`, async () => {
      const id = await openMeasured(100);
      countMeasure.mockResolvedValueOnce({ ok: true, count: 0 });
      const out = await call('work_update:status', { task_id: id, status: word, ...CLOSE });
      expect(countMeasure).toHaveBeenCalledTimes(2);   // at open, and at this close
      expect(out.content).not.toMatch(/Refused|Error/);
      expect(readWork(id).measure_remaining).toBe(0);
    });
  }
  it('status="done" with items left is refused on the reading taken for THIS close', async () => {
    const id = await openMeasured(100);
    countMeasure.mockResolvedValueOnce({ ok: true, count: 37 });
    const out = await call('work_update:status', { task_id: id, status: 'done', ...CLOSE });
    expect(out.content).toMatch(/^Refused: .*still returns 37 messages/);
  });
});

describe('A4-I2: the schedule door and the project door hold the same rule', () => {
  const recurring = { title: 'Nightly inbox sweep', goal: 'inbox sorted', allow_duplicate: true, scheduled_start: new Date(Date.now() + 3_600_000).toISOString(), repeat_interval: 1, repeat_unit: 'days' };

  it('work_schedule(pause, mark_complete=true) with items left is refused, and nothing closes', async () => {
    countMeasure.mockResolvedValueOnce({ ok: true, count: 9 });
    const id = taskIdFrom(await call('work_open:task', { measure: MEASURE, ...recurring }));
    seedDelivery();
    countMeasure.mockResolvedValueOnce({ ok: true, count: 9 });
    const out = await call('work_schedule:pause', { task_id: id, mark_complete: true });
    expect(out.content).toMatch(/^Refused: work_schedule\(action="pause", mark_complete=true\) on a measured task\. .*still returns 9 messages/);
    expect(out.content).toContain('work_update(action="status", status="complete", remainder=');
    expect(out.isError).toBe(true);
    expect(readWork(id).state).not.toBe('done');
    expect(countMeasure).toHaveBeenCalledTimes(2);
  });

  it('work_schedule(pause, mark_complete=true) at zero completes as before', async () => {
    countMeasure.mockResolvedValueOnce({ ok: true, count: 9 });
    const id = taskIdFrom(await call('work_open:task', { measure: MEASURE, ...recurring }));
    seedDelivery();
    countMeasure.mockResolvedValueOnce({ ok: true, count: 0 });
    const out = await call('work_schedule:pause', { task_id: id, mark_complete: true });
    expect(out.content).not.toMatch(/Refused/);
    expect(out.content).toMatch(/\[FILED\]|marked complete/);   // the door's own close, as for any task
  });

  it('a plain pause (no mark_complete) never reads the measure', async () => {
    countMeasure.mockResolvedValueOnce({ ok: true, count: 9 });
    const id = taskIdFrom(await call('work_open:task', { measure: MEASURE, ...recurring }));
    expect((await call('work_schedule:pause', { task_id: id })).content).toMatch(/Schedule paused/);
    expect(countMeasure).toHaveBeenCalledTimes(1);
  });

  const projectWithMeasuredTask = async (): Promise<{ project: string }> => {
    countMeasure.mockResolvedValueOnce({ ok: true, count: 42 });
    const out = await call('work_open:project', { title: 'Mailbox clean-up', level: 1, allow_duplicate: true, plan: { approach: 'Label the inbox, then write it up.', steps: [{ title: 'Label the inbox', how: 'gmail_label in batches', done: 'the search returns 0' }, { title: 'Write it up', how: 'file_write the summary', done: 'the summary is handed over' }] }, tasks: [{ title: 'Label the inbox', measure: MEASURE }, { title: 'Write it up' }] });
    const m = /project_id=([0-9a-f-]{36})/.exec(out.content);
    return { project: m![1] };
  };

  it('close_project(status="complete") over a measured task with items left is refused, naming the task', async () => {
    const { project } = await projectWithMeasuredTask();
    countMeasure.mockResolvedValueOnce({ ok: true, count: 12 });
    const out = await call('work_update:close_project', { project_id: project, status: 'complete', reason: 'all done here' });
    expect(out.content).toMatch(/^Refused: close_project\(status="complete"\) on a project with measured work left\./);
    expect(out.content).toContain('"Label the inbox"');
    expect(out.content).toContain('still returns 12 messages');
    expect(out.isError).toBe(true);
    const open = db().prepare("SELECT COUNT(*) AS n FROM work WHERE parent_id = ? AND state NOT IN ('done', 'failed', 'abandoned')").get(project) as { n: number };
    expect(open.n).toBe(2);
  });

  it('close_project(status="complete") at zero closes as before; status="cancelled" is never judged', async () => {
    const a = await projectWithMeasuredTask();
    countMeasure.mockResolvedValueOnce({ ok: true, count: 0 });
    expect((await call('work_update:close_project', { project_id: a.project, status: 'complete', reason: 'all done here' })).content).toMatch(/^\[OK\]/);
    const b = await projectWithMeasuredTask();
    const calls = countMeasure.mock.calls.length;
    expect((await call('work_update:close_project', { project_id: b.project, status: 'cancelled', reason: 'scope changed' })).content).toMatch(/^\[OK\]/);
    expect(countMeasure.mock.calls.length).toBe(calls);
  });
});

describe('minors', () => {
  it('the named remainder is written only once the close has landed', async () => {
    countMeasure.mockResolvedValueOnce({ ok: true, count: 100 });
    const id = taskIdFrom(await call('work_open:task', { title: 'Sort the inbox', goal: 'every inbox message labelled', measure: MEASURE }));
    await call('work_update:status', { task_id: id, status: 'in_progress' });
    const named = { ...CLOSE, remainder: { disposition: 'skipped', reason: '7 are calendar invites the owner said to leave' } };
    countMeasure.mockResolvedValueOnce({ ok: true, count: 7 });
    // No delivery yet: the close is refused AFTER the measure door ("needs a delivery").
    expect((await call('work_update:status', { task_id: id, status: 'complete', ...named })).content).toMatch(/needs a delivery/);
    expect(remainderNotes(id)).toBe(0);
    seedDelivery();
    countMeasure.mockResolvedValueOnce({ ok: true, count: 7 });
    expect((await call('work_update:status', { task_id: id, status: 'complete', ...named })).content).not.toMatch(/Refused|Error/);
    expect(remainderNotes(id)).toBe(1);
  });

  it('the re-read at close is held to the executor\'s gates: a revoked grant is "could not be read", never a read', async () => {
    const id = await openMeasured(100);
    granted.value = false;
    const out = await call('work_update:status', { task_id: id, status: 'complete', ...CLOSE });
    expect(countMeasure).toHaveBeenCalledTimes(1);   // only at open
    expect(out.content).not.toMatch(/Refused/);
    expect(lastEvent(id, 'measured')!.payload).toMatchObject({ ok: false, remaining: null });
    expect(String(lastEvent(id, 'measured')!.payload.error)).toMatch(/^Permission denied/);
  });

  // (Round 1's "a PM close never reads the measure" is gone: fix round 2's ruling binds the PM's
  // own close to the measure; `no-route-closes-a-measured-task-with-items-left.test.ts` holds it.)

  it('a task created with an error after its insert (an unknown group) keeps its measure', async () => {
    countMeasure.mockResolvedValueOnce({ ok: true, count: 55 });
    const out = await call('work_open:task', { title: 'Sort the inbox', goal: 'g', measure: MEASURE, assigned_to_group: 'no-such-group' });
    expect(out.content).toMatch(/does not exist\. The task was created/);
    const row = db().prepare("SELECT measure_initial FROM work WHERE kind = 'task' AND title = 'Sort the inbox'").get() as { measure_initial: number | null };
    expect(row.measure_initial).toBe(55);
  });
});
