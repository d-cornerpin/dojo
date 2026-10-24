// v3.5 DONE IS MEASURED, fix round 2 — NO ROUTE closes a measured task with items left unless the
// remainder is named: the engine's own closes (the same-turn receipt close, the A2A deliverable
// close request, the PM's receipt close, the join-drive card release, a group deletion's orphans,
// the scheduler's last-run and recovery closes) all cross the tracker's ONE status writer, which
// now holds the rule; the PM's own close and `complete_task` are judged at their doors.
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
import { setTrackerStatus } from '../../work/tracker-store.js';
import { fileAssignDeliverableCloseRequest } from '../tools.js';
import { agentsHandlers } from '../../agent/tools/cat/agents.js';
import { trackerRouter } from '../../gateway/routes/tracker.js';
import { fileOverrideRequest } from '../../work/override-requests.js';

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



const PM = 'pm-agent-x';
function seedPM(): void {
  db().prepare(`INSERT INTO agents (id, name, model_id, status, config, spawn_depth, created_by, created_at, updated_at)
    VALUES (?, 'PM', 'm1', 'idle', '{}', 1, 'owner', datetime('now'), datetime('now'))`).run(PM);
}

describe('the status writer holds the rule for every engine and scheduler close', () => {
  for (const by of ['engine', 'scheduler', 'pm', 'healer'] as const) {
    it(`a ${by} close of a measured task whose last reading shows items left is refused`, async () => {
      const id = await openMeasured(30);
      const r = setTrackerStatus(id, 'complete', { by, actorId: by, reason: 'engine close on receipts' });
      expect(r).toMatchObject({ kind: 'refused', reason: 'measure-items-left' });
      expect(readWork(id).state).toBe('claimed');
    });
  }

  it('at zero, unmeasured, or with an outage reading, the writer is unchanged', async () => {
    const zero = await openMeasured(0);
    expect(setTrackerStatus(zero, 'complete', { by: 'engine', actorId: 'engine', reason: 'x' })).not.toMatchObject({ reason: 'measure-items-left' });
    countMeasure.mockResolvedValueOnce({ ok: false, error: '503' });
    const outage = taskIdFrom(await call('work_open:task', { title: 'Sort the outage', goal: 'g', measure: MEASURE }));
    await call('work_update:status', { task_id: outage, status: 'in_progress' });
    expect(setTrackerStatus(outage, 'complete', { by: 'engine', actorId: 'engine', reason: 'x' })).not.toMatchObject({ reason: 'measure-items-left' });
    const plain = taskIdFrom(await call('work_open:task', { title: 'Write it up', goal: 'g' }));
    await call('work_update:status', { task_id: plain, status: 'in_progress' });
    expect(setTrackerStatus(plain, 'complete', { by: 'engine', actorId: 'engine', reason: 'x' })).not.toMatchObject({ reason: 'measure-items-left' });
  });

  it('a close request the worker filed WITH a named remainder is not undone at the writer (the PM\'s Key 2 stays the PM\'s)', async () => {
    const id = await openMeasured(100);
    countMeasure.mockResolvedValueOnce({ ok: true, count: 7 });
    expect((await call('work_update:status', { task_id: id, status: 'complete', ...CLOSE, remainder: { disposition: 'skipped', reason: '7 are calendar invites the owner said to leave' } })).content).not.toMatch(/Refused|Error/);
    const keyTwo = setTrackerStatus(id, 'complete', { by: 'pm', actorId: PM, claim: 'authoritative', reason: 'PM validated the close' });
    expect(keyTwo).not.toMatchObject({ reason: 'measure-items-left' });
  });
});

describe('the A2A deliverable close request', () => {
  const assigned = async (count: number): Promise<string> => {
    const id = await openMeasured(count);
    db().prepare("UPDATE work SET a2a_thread_id = 'thread-assign-1' WHERE id = ?").run(id);
    return id;
  };
  it('is not filed for a measured task with items left', async () => {
    const id = await assigned(12);
    expect(await fileAssignDeliverableCloseRequest(AGENT, 'thread-assign-1', 'here is the result')).toBe(false);
    expect(lastEvent(id, 'validation_requested')).toBeUndefined();
  });
  it('is filed as before at zero', async () => {
    const id = await assigned(0);
    expect(await fileAssignDeliverableCloseRequest(AGENT, 'thread-assign-1', 'here is the result')).toBe(true);
    expect(readWork(id).state).toBe('done');   // the engine's close, as before
  });
});

describe('complete_task (a spawned agent ending)', () => {
  const apprentice = async (count: number): Promise<string> => {
    const id = await openMeasured(count);
    db().prepare("UPDATE agents SET classification = 'apprentice', task_id = ? WHERE id = ?").run(id, AGENT);
    return id;
  };
  const completeTask = (args: Record<string, unknown>) =>
    (agentsHandlers['complete_task'] as (ctx: unknown) => Promise<Out>)({ agentId: AGENT, args });

  it('with items left is refused BEFORE the agent is ended, naming the door that takes a remainder', async () => {
    const id = await apprentice(40);
    countMeasure.mockResolvedValueOnce({ ok: true, count: 40 });
    const out = await completeTask({ status: 'complete', summary: 'labelled what I could' });
    expect(out.content).toMatch(/^Refused: complete_task\(status="complete"\) on a measured task\. .*still returns 40 messages/);
    expect(out.content).toContain('work_update(action="status", status="complete", remainder=');
    expect(out.isError).toBe(true);
    expect((db().prepare('SELECT status FROM agents WHERE id = ?').get(AGENT) as { status: string }).status).not.toBe('terminated');
    expect(readWork(id).state).toBe('claimed');
  });
  it('at zero ends as before; and after a remainder was named at the status door it is not refused again', async () => {
    await apprentice(40);
    countMeasure.mockResolvedValueOnce({ ok: true, count: 0 });
    expect((await completeTask({ status: 'complete', summary: 'all labelled' })).content).toMatch(/Task completion reported: complete/);
  });
  it('a task already closed with a named remainder lets complete_task end the agent', async () => {
    const id = await apprentice(40);
    countMeasure.mockResolvedValueOnce({ ok: true, count: 3 });
    expect((await call('work_update:status', { task_id: id, status: 'complete', ...CLOSE, remainder: { disposition: 'blocked', reason: 'three need the owner to log in to the other account' } })).content).not.toMatch(/Refused|Error/);
    expect((await completeTask({ status: 'complete', summary: 'done but three' })).content).toMatch(/Task completion reported: complete/);
  });
});

describe('the PM\'s own close', () => {
  it('a PM status="complete" on a measured task with items left is refused unless the remainder is named', async () => {
    seedPM();
    const id = await openMeasured(100);
    countMeasure.mockResolvedValueOnce({ ok: true, count: 9 });
    const out = await call('work_update:status', { task_id: id, status: 'complete', ...CLOSE }, PM);
    expect(out.content).toMatch(/^Refused: status="complete" on a measured task/);
    countMeasure.mockResolvedValueOnce({ ok: true, count: 9 });
    const named = await call('work_update:status', { task_id: id, status: 'complete', ...CLOSE, remainder: { disposition: 'skipped', reason: 'the owner said to leave these nine' } }, PM);
    expect(named.content).not.toMatch(/Refused/);
  });
  it('the PM\'s close re-reads the measure as the task\'s own agent, so a PM without the mailbox grant still gets a real count', async () => {
    seedPM();
    const id = await openMeasured(100);
    countMeasure.mockResolvedValueOnce({ ok: true, count: 9 });
    await call('work_update:status', { task_id: id, status: 'complete', ...CLOSE }, PM);
    expect(countMeasure.mock.calls.at(-1)![1]).toBe(AGENT);
    expect(readWork(id).measure_remaining).toBe(9);
  });
});

describe('fix round 3 (NB1): THE OWNER CAN ALWAYS CLOSE HIS OWN TASK', () => {
  const ownerNotes = (id: string): string[] => (db().prepare("SELECT payload FROM work_events WHERE work_id = ? AND kind = 'audit'").all(id) as Array<{ payload: string }>)
    .map((r) => r.payload).filter((p) => p.includes('Closed by the owner with'));

  it('the writer never refuses by:"owner", and records what was left', async () => {
    const id = await openMeasured(30);
    const delivery = (db().prepare('SELECT id FROM deliveries ORDER BY rowid DESC LIMIT 1').get() as { id: string }).id;
    const r = setTrackerStatus(id, 'complete', { by: 'owner', actorId: 'user', claim: 'authoritative', reason: 'the owner closed it', resultDeliveryId: delivery });
    expect(r).not.toMatchObject({ reason: 'measure-items-left' });
    expect(r.kind).toBe('applied');
    expect(ownerNotes(id)).toEqual([expect.stringContaining('Closed by the owner with 30 messages left.')]);
  });

  it('the dashboard drag to complete returns 200', async () => {
    const id = await openMeasured(30);
    const res = await trackerRouter.request(`/tasks/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'complete' }) });
    expect(res.status).toBe(200);
    expect(readWork(id).state).toBe('done');
  });

  it('the owner approving a complete override closes the task', async () => {
    const id = await openMeasured(30);
    const reqId = fileOverrideRequest(id, { requestedBy: AGENT, requestedStatus: 'complete', justification: 'the rest are not mine to do' });
    const res = await trackerRouter.request(`/override-requests/${reqId}/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approve: true, reason: 'leave the rest' }) });
    expect(res.status).toBe(200);
    expect(readWork(id).state).toBe('done');
  });

  it('the owner\'s project close closes its measured tasks too', async () => {
    countMeasure.mockResolvedValueOnce({ ok: true, count: 42 });
    const out = await call('work_open:project', { title: 'Mailbox clean-up', level: 1, allow_duplicate: true, tasks: [{ title: 'Label the inbox', measure: MEASURE }] });
    const project = /project_id=([0-9a-f-]{36})/.exec(out.content)![1];
    const res = await trackerRouter.request(`/projects/${project}/close`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'complete', reason: 'good enough for me' }) });
    expect(res.status).toBe(200);
    const open = db().prepare("SELECT COUNT(*) AS n FROM work WHERE parent_id = ? AND state NOT IN ('done', 'failed', 'abandoned')").get(project) as { n: number };
    expect(open.n).toBe(0);
  });
});
