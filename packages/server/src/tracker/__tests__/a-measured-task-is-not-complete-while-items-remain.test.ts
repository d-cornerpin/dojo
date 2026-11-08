// v3.5 DONE IS MEASURED, Task A4 — a task can carry a MEASURE, and a close with items left is
// refused unless the worker names the remainder.
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
const call = async (key: string, args: Record<string, unknown>): Promise<Out> =>
  (trackerHandlers[key] as (ctx: unknown) => Promise<Out>)({ agentId: AGENT, args });

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
  const id = `d-${Math.random()}`;
  db().prepare(`INSERT INTO messages (id, agent_id, lane, role, content, created_at, sent_at) VALUES (?, ?, 'owner', 'assistant', 'The labelled messages are listed in the summary.', ?, ?)`)
    .run(`m-${id}`, AGENT, Date.now(), Date.now());
  db().prepare(`INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, message_id, outcome, created_at)
    VALUES (?, ?, NULL, 'dashboard', 'dashboard', 'conv-owner', ?, 'delivered', datetime('now', '+1 second'))`).run(id, AGENT, `m-${id}`);
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

describe('a measured task is not complete while items remain', () => {
  it('setting a measure on open counts it once and stores initial = remaining', async () => {
    countMeasure.mockResolvedValueOnce({ ok: true, count: 10551 });
    const out = await call('work_open:task', { title: 'Sort the inbox', goal: 'every inbox message labelled', measure: MEASURE });
    const row = readWork(taskIdFrom(out));
    expect(countMeasure).toHaveBeenCalledTimes(1);
    expect(row.measure_initial).toBe(10551);
    expect(row.measure_remaining).toBe(10551);
    expect(JSON.parse(row.measure_json!)).toEqual(MEASURE);
    expect(out.content).toContain('returns 10551 messages now');
    expect(lastEvent(taskIdFrom(out), 'measured')).toMatchObject({ actor: 'engine', payload: { remaining: 10551, initial: 10551, ok: true } });
  });

  it('close with items remaining is refused with the number, and the row stays claimed', async () => {
    const id = await openMeasured(10551);
    countMeasure.mockResolvedValueOnce({ ok: true, count: 10412 });
    const out = await call('work_update:status', { task_id: id, status: 'complete', ...CLOSE });
    expect(out.content).toMatch(/^Refused: status="complete" on a measured task/);
    expect(out.content).toMatch(/still returns 10412 messages \(10551 when the task started; 0 touched so far\)/);
    expect(out.isError).toBe(true);
    expect(readWork(id).state).toBe('claimed');
    expect(readWork(id).measure_remaining).toBe(10412);
    expect(lastEvent(id, 'measured')!.payload).toMatchObject({ remaining: 10412, initial: 10551, ok: true });
  });

  it('a refused close is "keep working", never a malformed call: repeating it files no override request', async () => {
    const id = await openMeasured(50);
    for (let i = 0; i < 5; i++) {
      countMeasure.mockResolvedValueOnce({ ok: true, count: 50 - i });
      // eslint-disable-next-line no-await-in-loop
      expect((await call('work_update:status', { task_id: id, status: 'complete', ...CLOSE })).content).toMatch(/^Refused:/);
    }
    expect(lastEvent(id, 'override_request')).toBeUndefined();
    expect(readWork(id).state).toBe('claimed');
  });

  it('close with a named remainder goes through, with the number and the reason on the record', async () => {
    const id = await openMeasured(100);
    countMeasure.mockResolvedValueOnce({ ok: true, count: 7 });
    const out = await call('work_update:status', {
      task_id: id, status: 'complete', ...CLOSE,
      remainder: { disposition: 'skipped', reason: '7 are calendar invites the owner said to leave' },
    });
    expect(out.content).not.toMatch(/Refused|Error/);
    expect(readWork(id).measure_remaining).toBe(7);
    const notes = db().prepare("SELECT payload FROM work_events WHERE work_id = ? AND kind = 'audit'").all(id) as Array<{ payload: string }>;
    expect(notes.some((n) => n.payload.includes('Remainder named at close: 7 messages skipped: 7 are calendar invites the owner said to leave'))).toBe(true);
  });

  it('a remainder with no real reason is still refused', async () => {
    const id = await openMeasured(100);
    countMeasure.mockResolvedValueOnce({ ok: true, count: 7 });
    const out = await call('work_update:status', { task_id: id, status: 'complete', ...CLOSE, remainder: { disposition: 'skipped', reason: 'n/a' } });
    expect(out.content).toMatch(/^Refused:/);
  });

  it('close at zero proceeds', async () => {
    const id = await openMeasured(100);
    countMeasure.mockResolvedValueOnce({ ok: true, count: 0 });
    const out = await call('work_update:status', { task_id: id, status: 'complete', ...CLOSE });
    expect(out.content).not.toMatch(/Refused|Error/);
    expect(readWork(id).measure_remaining).toBe(0);
  });

  it('REVIEW FOCUS 1: a provider outage at close is recorded, not a refusal', async () => {
    const id = await openMeasured(100);
    countMeasure.mockResolvedValueOnce({ ok: false, error: '503' });
    const out = await call('work_update:status', { task_id: id, status: 'complete', ...CLOSE });
    expect(out.content).not.toMatch(/Refused/);
    expect(readWork(id).measure_remaining).toBeNull();
    expect(lastEvent(id, 'measured')!.payload).toMatchObject({ ok: false, error: '503', remaining: null, initial: 100 });
  });

  it('the complete_step door holds the same rule', async () => {
    const id = await openMeasured(30);
    countMeasure.mockResolvedValueOnce({ ok: true, count: 3 });
    const refused = await call('work_update:complete_step', { task_id: id, ...CLOSE });
    expect(refused.content).toMatch(/^Refused: action="complete_step" on a measured task\. Its measure \(gmail_search "in:inbox -label:Done"\) still returns 3 messages/);
    expect(refused.isError).toBe(true);
    countMeasure.mockResolvedValueOnce({ ok: true, count: 0 });
    // With no task_id, the door's own "your one claimed task" pick is the row re-measured.
    expect((await call('work_update:complete_step', { ...CLOSE })).content).not.toMatch(/Refused|Error/);
  });

  it('an unmeasured task never asks the counter, and closes as it always did', async () => {
    const out = await call('work_open:task', { title: 'Write the summary', goal: 'a summary exists' });
    const id = taskIdFrom(out);
    await call('work_update:status', { task_id: id, status: 'in_progress' });
    seedDelivery();
    expect((await call('work_update:status', { task_id: id, status: 'complete', ...CLOSE })).content).not.toMatch(/Refused|Error/);
    expect(countMeasure).not.toHaveBeenCalled();
    expect(readWork(id).measure_json).toBeNull();
  });

  it('REVIEW FOCUS 5: a recurring task with a measure is judged per run, and the run advances exactly as an unmeasured one does', async () => {
    const now = Date.now();
    const recurring = { title: 'Nightly inbox sweep', goal: 'inbox sorted', allow_duplicate: true, scheduled_start: new Date(now - 60_000).toISOString(), repeat_interval: 1, repeat_unit: 'days' };
    const fire = (id: string): void => {
      const due = db().prepare('SELECT next_run_at FROM work WHERE id = ?').get(id) as { next_run_at: number };
      expect(claimOccurrence({ workId: id, sequence: 1, occurrenceMs: due.next_run_at, nowMs: now, nextRunMs: due.next_run_at + 86_400_000, agentId: AGENT })).toBeTruthy();
      db().prepare("UPDATE work SET schedule_status = 'running', state = 'claimed' WHERE id = ?").run(id);
    };
    countMeasure.mockResolvedValueOnce({ ok: true, count: 4 });
    const measured = taskIdFrom(await call('work_open:task', { measure: MEASURE, ...recurring }));
    const plain = taskIdFrom(await call('work_open:task', recurring));   // the twin: same task, no measure
    fire(measured); fire(plain);

    // Items left on this run: the run is refused, and its schedule is untouched.
    countMeasure.mockResolvedValueOnce({ ok: true, count: 4 });
    const before = readWork(measured).next_run_at;
    expect((await call('work_update:status', { task_id: measured, status: 'complete', ...CLOSE })).content).toMatch(/^Refused:/);
    expect(readWork(measured).next_run_at).toBe(before);

    // At zero, the measured run closes byte-for-byte the way the unmeasured twin's does.
    countMeasure.mockResolvedValueOnce({ ok: true, count: 0 });
    // Each close also starts the run's settlement off the call's own stack; let it finish before
    // the next close, so the two twins are compared in the same settled state (a race otherwise).
    const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };   // eslint-disable-line no-await-in-loop
    const a = await call('work_update:status', { task_id: measured, status: 'complete', ...CLOSE });
    await settle();
    const b = await call('work_update:status', { task_id: plain, status: 'complete', ...CLOSE });
    await settle();
    expect(a.content.replaceAll(measured, 'ID').replaceAll(measured.slice(0, 8), 'ID')).toBe(b.content.replaceAll(plain, 'ID').replaceAll(plain.slice(0, 8), 'ID'));
    expect(a.content).not.toMatch(/^Refused/);
    const [ra, rb] = [readWork(measured), readWork(plain)];
    expect({ state: ra.state, next: ra.next_run_at }).toEqual({ state: rb.state, next: rb.next_run_at });
  });

  it('a bad measure is refused on open with the fault named, and nothing is created', async () => {
    const before = (db().prepare("SELECT COUNT(*) AS n FROM work WHERE kind = 'task'").get() as { n: number }).n;
    const out = await call('work_open:task', { title: 't', goal: 'g', measure: { tool: 'gmail_send', args: {} } });
    expect(out.content).toMatch(/cannot be counted/);
    expect(out.isError).toBe(true);
    expect((db().prepare("SELECT COUNT(*) AS n FROM work WHERE kind = 'task'").get() as { n: number }).n).toBe(before);
    expect(countMeasure).not.toHaveBeenCalled();
  });

  it('a measure the agent could not read itself is refused with the executor\'s own words, and nothing is read', async () => {
    granted.value = false;
    const out = await call('work_open:task', { title: 't', goal: 'g', measure: MEASURE });
    expect(out.content).toMatch(/^Permission denied: gmail_search is in the/);
    expect(out.isError).toBe(true);
    expect(countMeasure).not.toHaveBeenCalled();
  });

  it('a measure set on edit is a new scope: initial is re-read', async () => {
    const id = await openMeasured(500);
    countMeasure.mockResolvedValueOnce({ ok: true, count: 80 });
    const out = await call('work_update:edit', { task_id: id, measure: { ...MEASURE, args: { query: 'in:inbox -label:Done newer_than:30d' } } });
    expect(out.content).toContain('returns 80 messages now');
    expect(out.isError).toBe(false);
    expect(readWork(id)).toMatchObject({ measure_initial: 80, measure_remaining: 80 });
    expect(JSON.parse(readWork(id).measure_json!).args.query).toBe('in:inbox -label:Done newer_than:30d');
  });

  it('a project task carries its own measure', async () => {
    countMeasure.mockResolvedValueOnce({ ok: true, count: 42 });
    const out = await call('work_open:project', { title: 'Mailbox clean-up', level: 1, plan: { approach: 'Label the inbox, then write it up.', steps: [{ title: 'Label the inbox', how: 'gmail_label in batches', done: 'the search returns 0' }, { title: 'Write it up', how: 'file_write the summary', done: 'the summary is handed over' }] }, tasks: [{ title: 'Label the inbox', measure: MEASURE }, { title: 'Write it up' }] });
    expect(out.content).toContain('returns 42 messages now');
    const rows = db().prepare("SELECT title, measure_initial FROM work WHERE kind = 'task' ORDER BY title").all();
    expect(rows).toEqual([{ title: 'Label the inbox', measure_initial: 42 }, { title: 'Write it up', measure_initial: null }]);
  });
});
