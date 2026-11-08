// proof-fix V round 3 — a recurring task's blessed run, end to end through the real doors.
// The worker's per-run finish (work_update:status complete) on a NON-final run advances the
// schedule through the engine with no close request at all; only a FINAL run or a stop
// (complete_all_runs) files Key 1. Each shape is driven with an occurrence really in flight,
// then the PM's work_validate, and judged by what an owner expects of the row.
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-recurring-bless-test', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/access/read.js', async (orig) => ({
  ...(await orig<typeof import('../../agent/access/read.js')>()),
  toolCategoryGranted: () => true,
}));

import { runMigrations } from '../../db/migrations.js';
import { trackerHandlers } from '../../agent/tools/cat/tracker.js';
import { claimOccurrence } from '../../work/occurrences.js';
import { trackerValidateComplete } from '../tools.js';
import { setTrackerStatus } from '../../work/tracker-store.js';
import { setNextRun } from '../../work/next-run.js';

const AGENT = 'agent-recurring';
const PM = 'pm-agent';
const CLOSE = { result: 'done', evidence: [{ kind: 'claim', claim: 'ran the sweep' }] };

type Out = { content: string; isError: boolean };
const call = async (key: string, args: Record<string, unknown>): Promise<Out> =>
  (trackerHandlers[key] as (ctx: unknown) => Promise<Out>)({ agentId: AGENT, args });
const db = (): Database.Database => mockDb.current!;
const row = (id: string) => db().prepare(
  'SELECT state, schedule_status, next_run_at, attempts FROM work WHERE id = ?',
).get(id) as { state: string; schedule_status: string; next_run_at: number | null; attempts: number };
const keyOnes = (id: string): number => (db().prepare(
  "SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = 'validation_requested'",
).get(id) as { n: number }).n;
/** A result that reached the person — what a close points at (`deliveryForTaskClose`). */
const seedDelivery = (): void => {
  const id = `d-${Math.random()}`;
  db().prepare(`INSERT INTO messages (id, agent_id, lane, role, content, created_at, sent_at) VALUES (?, ?, 'owner', 'assistant', 'The labelled messages are listed in the summary.', ?, ?)`)
    .run(`m-${id}`, AGENT, Date.now(), Date.now());
  db().prepare(`INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, message_id, outcome, created_at)
    VALUES (?, ?, NULL, 'dashboard', 'dashboard', 'conv-owner', ?, 'delivered', datetime('now', '+1 second'))`).run(id, AGENT, `m-${id}`);
};
const settle = async (): Promise<void> => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };   // eslint-disable-line no-await-in-loop

/** A daily recurring task with its first occurrence really claimed and in flight. */
async function recurringInFlight(extra: Record<string, unknown> = {}): Promise<string> {
  const now = Date.now();
  const out = await call('work_open:task', {
    title: 'Nightly sweep', goal: 'sweep done', allow_duplicate: true,
    scheduled_start: new Date(now - 60_000).toISOString(), repeat_interval: 1, repeat_unit: 'days', ...extra,
  });
  const id = /task_id=([0-9a-f-]{36})/.exec(out.content)![1];
  const due = db().prepare('SELECT next_run_at FROM work WHERE id = ?').get(id) as { next_run_at: number };
  expect(claimOccurrence({
    workId: id, sequence: 1, occurrenceMs: due.next_run_at, nowMs: now,
    nextRunMs: extra.repeat_end_type ? null : due.next_run_at + 86_400_000, agentId: AGENT,
  })).toBeTruthy();
  db().prepare("UPDATE work SET schedule_status = 'running', state = 'claimed' WHERE id = ?").run(id);
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
  db().prepare(`INSERT INTO agents (id, name, status) VALUES (?, 'PM', 'idle')`).run(PM);
});

describe('a recurring task keeps its schedule through a run the PM blesses', () => {
  it.skip('2c: a non-final run: the worker\'s finish advances the schedule itself (no Key 1), and a later PM validate is a no-op', async () => {
    const id = await recurringInFlight();
    const before = row(id);
    const fin = await call('work_update:status', { task_id: id, status: 'complete', ...CLOSE });
    await settle();
    expect(fin.content, fin.content).toMatch(/Run completed for recurring task/);
    expect(keyOnes(id), 'a non-final per-run finish files no close request').toBe(0);
    let r = row(id);
    expect(r.state).toBe('on_deck');
    expect(r.schedule_status).toBe('waiting');
    expect(r.next_run_at!).toBeGreaterThan(Date.now());
    expect(r.attempts).toBe(before.attempts + 1);
    // The PM validating afterwards must not disturb any of that.
    await trackerValidateComplete(PM, { task_id: id, valid: true });
    r = row(id);
    expect({ s: r.state, ss: r.schedule_status, a: r.attempts }).toEqual({ s: 'on_deck', ss: 'waiting', a: before.attempts + 1 });
  });

  it.skip('2c: a stop filed while a run is in flight: the PM bless leaves a STOPPED schedule on a done row, never a live one', async () => {
    const id = await recurringInFlight();
    seedDelivery();
    const fin = await call('work_update:status', { task_id: id, status: 'complete', complete_all_runs: true, ...CLOSE });
    expect(fin.content, fin.content).toMatch(/FILED|filed|request/i);
    expect(keyOnes(id)).toBe(1);
    const out = await trackerValidateComplete(PM, { task_id: id, valid: true });
    await settle();
    const r = row(id);
    expect(out, out).toMatch(/^\[OK\]/);
    expect(r.state).toBe('done');
    expect(r.schedule_status, 'a done row must not keep a live schedule').toBe('completed');
  });

  it.skip('2c: a final run (no further occurrence): the filed close, once blessed, ends the schedule with the row', async () => {
    const id = await recurringInFlight({ repeat_end_type: 'after_count', repeat_end_value: '1' });
    seedDelivery();
    const fin = await call('work_update:status', { task_id: id, status: 'complete', ...CLOSE });
    expect(fin.content, fin.content).not.toMatch(/Run completed for recurring task/);
    const out = await trackerValidateComplete(PM, { task_id: id, valid: true });
    await settle();
    const r = row(id);
    expect(out, out).toMatch(/^\[OK\]/);
    expect(r.state).toBe('done');
    expect(r.schedule_status).toBe('completed');
  });

  it.skip('2c: the one rule at the fire-time writer: nothing arms a schedule on a settled row', async () => {
    const id = await recurringInFlight();
    seedDelivery();
    const d = (db().prepare("SELECT id FROM deliveries ORDER BY created_at DESC LIMIT 1").get() as { id: string }).id;
    setTrackerStatus(id, 'complete', { by: 'pm', actorId: PM, claim: 'authoritative', resultDeliveryId: d, reason: 'closed' });
    expect(row(id).state).toBe('done');
    setNextRun(id, { at: Date.now() + 3_600_000, alongside: { schedule_status: 'waiting' }, reason: 'test' });
    expect(row(id).schedule_status).toBe('completed');
    expect(row(id).next_run_at).toBeNull();
    expect((db().prepare('SELECT is_paused AS p FROM work WHERE id = ?').get(id) as { p: number }).p, 'an ended schedule has one shape').toBe(1);
  });

  it.skip('2c: N1: a row with a repeat interval but no live schedule is a one-shot to the filer AND the validator', async () => {
    const id = await recurringInFlight();
    db().prepare("UPDATE work SET schedule_status = 'unscheduled', state = 'claimed' WHERE id = ?").run(id);
    seedDelivery();
    const fin = await call('work_update:status', { task_id: id, status: 'complete', ...CLOSE });
    expect(fin.content, fin.content).not.toMatch(/Run completed for recurring task/);
    const out = await trackerValidateComplete(PM, { task_id: id, valid: true });
    expect(out, out).toMatch(/^\[OK\] Complete validated/);
    expect(row(id).state).toBe('done');
  });
});
