// A recurring task's run, end to end through the real doors. The worker's hand-in on a NON-final run
// is a run hand-in: the schedule advances at once and the PM's decision returns the row to Open for its
// next run. The FINAL run's hand-in is the whole schedule's: its approval ends the row done with the
// schedule stopped. Each shape is driven with an occurrence really in flight.
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
import { setNextRun } from '../../work/next-run.js';
import { decide } from '../../work/done/decide.js';
import { openProof } from '../../work/done/open-proof.js';
import { clearPlatformConfigCache } from '../../config/platform.js';

const AGENT = 'agent-recurring';
const PM = 'pm-agent';
const HAND_IN = { outcome: 'finished', proof: [{ kind: 'delivery', ref: '' }], note: 'ran the sweep' };

type Out = { content: string; isError: boolean };
const call = async (key: string, args: Record<string, unknown>): Promise<Out> =>
  (trackerHandlers[key] as (ctx: unknown) => Promise<Out>)({ agentId: AGENT, args });
const db = (): Database.Database => mockDb.current!;
const row = (id: string) => db().prepare(
  'SELECT state, schedule_status, next_run_at, attempts FROM work WHERE id = ?',
).get(id) as { state: string; schedule_status: string; next_run_at: number | null; attempts: number };
const scopeOf = (id: string): string | null => (db().prepare(
  "SELECT json_extract(payload, '$.scope') AS s FROM work_events WHERE work_id = ? AND kind = 'handed_in' ORDER BY id DESC LIMIT 1",
).get(id) as { s: string | null }).s;
/** The PM's decision, by the one decision door, after opening the proof it relies on. */
const pmDecides = (id: string, verdict: 'approve' | 'send_back') => {
  openProof(PM, id, 0);
  const r = decide({ workId: id, deciderAgentId: PM, verdict, reason: 'The sweep reached the owner' });
  expect(r.kind, r.text).toBe('decided');
  return r;
};
/** A result that reached the person, in the run's own turn — what a close points at (`deliveryForTaskClose`). */
let turns = 0;
const seedDelivery = (task: string): void => {
  const id = `d-${Math.random()}`;
  const run = (db().prepare("SELECT id FROM work WHERE kind = 'occurrence' AND parent_id = ? ORDER BY sequence DESC LIMIT 1").get(task) as { id: string }).id;
  db().prepare("INSERT INTO turns (agent_id, turn_number, root_kind, root_id, started_at, answered) VALUES (?, ?, 'occurrence', ?, datetime('now', '-1 second'), 0)")
    .run(AGENT, ++turns, run);
  db().prepare(`INSERT INTO messages (id, agent_id, lane, role, content, created_at, sent_at) VALUES (?, ?, 'owner', 'assistant', 'The labelled messages are listed in the summary.', ?, ?)`)
    .run(`m-${id}`, AGENT, Date.now(), Date.now());
  db().prepare(`INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, message_id, outcome, created_at)
    VALUES (?, ?, ?, 'dashboard', 'dashboard', 'conv-owner', ?, 'delivered', datetime('now', '+1 second'))`).run(id, AGENT, turns, `m-${id}`);
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
  db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('pm_agent_id', ?)").run(PM);
  clearPlatformConfigCache();
});

describe('a recurring task keeps its schedule through a run the PM decides', () => {
  it('a non-final run: the worker\'s hand-in is a run hand-in, the schedule advances at once, and the decision returns the row to Open', async () => {
    const id = await recurringInFlight();
    const before = row(id);
    seedDelivery(id);
    const fin = await call('work_update:hand_in', { task_id: id, ...HAND_IN });
    await settle();
    expect(fin.isError, fin.content).toBe(false);
    expect(scopeOf(id)).toBe('run');
    let r = row(id);
    expect(r.state).toBe('handed_in');
    expect(r.schedule_status).toBe('waiting');
    expect(r.next_run_at!).toBeGreaterThan(Date.now());
    expect(r.attempts).toBe(before.attempts + 1);
    expect(pmDecides(id, 'approve').kind).toBe('decided');
    r = row(id);
    expect({ s: r.state, ss: r.schedule_status, a: r.attempts }).toEqual({ s: 'open', ss: 'waiting', a: before.attempts + 1 });
  });

  it('a final run (no further occurrence): its approval ends the row done and stops the schedule', async () => {
    const id = await recurringInFlight({ repeat_end_type: 'after_count', repeat_end_value: '1' });
    db().prepare('UPDATE work SET next_run_at = NULL WHERE id = ?').run(id);
    seedDelivery(id);
    const fin = await call('work_update:hand_in', { task_id: id, ...HAND_IN });
    expect(fin.isError, fin.content).toBe(false);
    expect(scopeOf(id), 'a run in flight with no next run is the final run: the whole schedule is handed in').toBe('schedule');
    expect(pmDecides(id, 'approve').kind).toBe('decided');
    await settle();
    const r = row(id);
    expect(r.state).toBe('done');
    expect(r.schedule_status).toBe('completed');
  });

  it('the one rule at the fire-time writer: nothing arms a schedule on a settled row', async () => {
    const id = await recurringInFlight();
    expect(decide({ workId: id, deciderAgentId: null, verdict: 'owner_done', reason: 'closed' }).kind).toBe('decided');
    await settle();
    expect(row(id).state).toBe('done');
    setNextRun(id, { at: Date.now() + 3_600_000, alongside: { schedule_status: 'waiting' }, reason: 'test' });
    expect(row(id).schedule_status).toBe('completed');
    expect(row(id).next_run_at).toBeNull();
    expect((db().prepare('SELECT is_paused AS p FROM work WHERE id = ?').get(id) as { p: number }).p, 'an ended schedule has one shape').toBe(1);
  });

  it('N1: a row with a repeat interval but no live schedule is handed in whole, and decided done', async () => {
    const id = await recurringInFlight();
    db().prepare("UPDATE work SET schedule_status = 'unscheduled', state = 'claimed' WHERE id = ?").run(id);
    seedDelivery(id);
    const fin = await call('work_update:hand_in', { task_id: id, ...HAND_IN });
    expect(fin.isError, fin.content).toBe(false);
    expect(scopeOf(id), 'its run in flight is its last').toBe('schedule');
    expect(pmDecides(id, 'approve').kind).toBe('decided');
    expect(row(id).state).toBe('done');
  });
});
