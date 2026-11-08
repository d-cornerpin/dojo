// v3.5 field fix 3, audit round (#9): WORK RECORDS ARE KEPT, AND AN OPEN QUESTION WAITS FOR ITS ANSWER.
//
// RULINGS-AUDIT section 3, item 9. The hourly prune deleted the oldest complete, blocked, fallen and
// cancelled tasks past 50 each: blocked is open, owed work, and ruling 9d keeps work records ("prune
// history only with the owner's say-so"). A verdict request the owner had not answered in 12 hours
// dropped the task to blocked on a fixed clock, and a missed-runs pause nobody resolved in 10 minutes
// was skipped on a fixed clock. Owner (2026-10-13): "I don't want to put hard limits on the dojo."

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-records-kept', 'dojo.db'),
  };
});
const frames: Array<Record<string, unknown>> = [];
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (e: Record<string, unknown>) => { frames.push(e); },
  stampPersistedRow: (e: unknown) => e,
}));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => { /* no-op */ } }) }));
const notices: unknown[] = [];
vi.mock('../../agent/a2a-notice.js', () => ({ deliverA2ANotice: async (n: unknown) => { notices.push(n); } }));
// One switch per test: make the drop refuse for a named row, the way a pre-gate would.
const refuseDropFor = new Set<string>();
vi.mock('../../work/tracker-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../work/tracker-store.js')>();
  return {
    ...actual,
    setTrackerStatus: (id: string, status: Parameters<typeof actual.setTrackerStatus>[1], input: Parameters<typeof actual.setTrackerStatus>[2]) =>
      refuseDropFor.has(id)
        ? { kind: 'refused', workId: id, reason: 'illegal-transition', detail: 'refused for this test' }
        : actual.setTrackerStatus(id, status, input),
  };
});
import { runMigrations } from '../../db/migrations.js';
import { autoResolveStaleMissedRunPauses } from '../runner.js';
import { decide } from '../../work/done/decide.js';
import { REAPER_KINDS } from '../../work/work-reaper.js';
import { openTrackerTask } from '../../work/tracker-store.js';
import { setHold } from '../../work/done/hold.js';

const AGENT = 'agent-worker';
const HOURS_13 = 13 * 3600_000;
const db = (): Database.Database => mockDb.current!;

function seedTask(title: string): string {
  return openTrackerTask({
    title, status: 'in_progress', assignedTo: AGENT, createdBy: AGENT,
    origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null },
  });
}

/** A verdict request the owner never answered, filed 13h ago (written raw so it can be backdated). */
function oldRequest(id: string): void {
  db().prepare(
    `INSERT INTO work_events (work_id, kind, payload, actor, created_at) VALUES (?, 'user_verdict_requested', '{}', 'pm', ?)`,
  ).run(id, Date.now() - HOURS_13);
}

function finish(id: string, to: 'done' | 'abandoned'): void {
  expect(decide({ workId: id, deciderAgentId: null, verdict: to === 'done' ? 'owner_done' : 'cancel', reason: `owner ${to}` }).kind).toBe('decided');
}
const stateOf = (id: string): string => (db().prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string }).state;
const sqlTime = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString().replace('T', ' ').slice(0, 19);
const count = (state: string): number => (db().prepare(`SELECT COUNT(*) AS n FROM work WHERE kind = 'task' AND state = ?`).get(state) as { n: number }).n;

/** A recurring task the scheduler paused for missed runs `pausedMsAgo` ago, with the agent's notice on record. */
function missedRunsPause(pausedMsAgo: number): string {
  const id = seedTask('water the plants');
  db().prepare(`UPDATE work SET is_paused = 1, missed_runs_paused_at = ?, repeat_interval = 1, repeat_unit = 'days',
      next_run_at = ?, scheduled_start = ? WHERE id = ?`).run(Date.now() - pausedMsAgo, Date.now() - 3 * 86_400_000, Date.now() - 10 * 86_400_000, id);
  return id;
}
function finishedTurn(n: number, startedMsAgo: number): void {
  db().prepare(`INSERT INTO turns (agent_id, turn_number, kind, subject_kind, answered, started_at, ended_at, exit_reason)
    VALUES (?, ?, 'user', 'conv', 1, ?, ?, 'answered')`).run(AGENT, n, sqlTime(startedMsAgo), sqlTime(startedMsAgo - 60_000));
}
const paused = (id: string): number => (db().prepare('SELECT is_paused FROM work WHERE id = ?').get(id) as { is_paused: number }).is_paused;

beforeEach(() => {
  mockDb.current?.close();
  const d = new Database(':memory:');
  mockDb.current = d;
  runMigrations();
  d.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Worker', 'idle', '1970-01-01')`).run(AGENT);
  frames.length = 0;
});

describe('the hourly sweeps keep work records', () => {
  it('THE RED: sixty blocked and sixty finished tasks are all still there after every reaper kind runs', async () => {
    for (let i = 0; i < 60; i++) {
      const b = seedTask(`blocked ${i}`);
      expect(setHold(b, 'blocked', 'waiting', 'owner').ok).toBe(true);
      const c = seedTask(`finished ${i}`);
      finish(c, 'abandoned');
    }
    for (const k of REAPER_KINDS.filter((x) => /prune/.test(x.id))) await k.run();
    expect((db().prepare("SELECT COUNT(*) AS n FROM work WHERE kind = 'task' AND hold_kind = 'blocked'").get() as { n: number }).n).toBe(60);
    expect(count('abandoned')).toBe(60);
  });
});

describe('a missed-runs pause is skipped on the agent\'s record, never on a clock', () => {
  it('THE RED: paused 20 minutes ago, the agent has not had a whole turn since: the pause stands for it to resolve', async () => {
    finishedTurn(1, 60 * 60_000);
    const t = missedRunsPause(20 * 60_000);
    await autoResolveStaleMissedRunPauses();
    expect(paused(t)).toBe(1);
  });

  it('the agent ran a whole turn after the pause and did not resolve it: the engine skips to the next run (D12 kept)', async () => {
    const t = missedRunsPause(5 * 60_000);
    finishedTurn(1, 3 * 60_000);
    await autoResolveStaleMissedRunPauses();
    expect(paused(t)).toBe(0);
  });
});
