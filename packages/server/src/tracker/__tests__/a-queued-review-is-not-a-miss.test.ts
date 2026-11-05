// v3.5 FIELD FIX 3 (#4): A REVIEW THE PM NEVER RAN IS NOT A MISS.
//
// The owner's box, 3.5.0-preflight.3: `runPMReview` posted its report and awaited
// `runtime.handleMessage(pm)`. The PM was already mid-run, so `handleMessage` only queued a wakeup
// and returned at once. The coverage check then read the rows back, found them still awaiting
// Key 2, and wrote `validation_review_miss` ("the validation review ran and returned no verdict")
// about a turn that had not happened. The real verdict landed on the queued wakeup about 45s later.
// The false miss also orders the queue and releases the owner escalation, so a busy PM pushed rows
// toward the owner for reasons that had nothing to do with them.
//
// The fix: `handleMessage` says whether the turn ran or was queued. A queued review records no miss
// and keeps its asked rows on the doorbell, so the next review (after the PM's queued turn) carries
// them and judges coverage against a turn that really ran.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-queued-review');

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-queued-review');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
    isTestRun: (): boolean => true,
  };
});

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-queued-review', 'dojo.db'),
  };
});

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ }, stampPersistedRow: (e: unknown) => e }));

// What the PM's runtime answers: 'queued' = it was mid-run and only queued a wakeup.
const { pm } = vi.hoisted(() => ({ pm: {
  outcome: 'ran' as string, calls: 0, to: [] as string[],
  // The queued wakeup turn: `whenQueuedRunEnds` answers when the test ends it.
  queuedEnd: null as null | ((o: string) => void), waits: 0,
  /** Every review waiting on the queued turn (two reviews can queue behind one busy run). */
  waiting: [] as Array<(o: string) => void>,
} }));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({
    notifyPrimaryOfInjury: vi.fn(async () => undefined),
    handleMessage: vi.fn(async (agentId: string) => { pm.to.push(agentId); if (agentId === 'pm') pm.calls += 1; return pm.outcome; }),
    whenQueuedRunEnds: vi.fn(() => { pm.waits += 1; return new Promise<string>((resolve) => { pm.queuedEnd = resolve; pm.waiting.push(resolve); }); }),
    getAgentUptime: () => 0,
  }),
  stopAgent: vi.fn(),
}));
vi.mock('../../agent/a2a-transport.js', () => ({
  deliverA2AMessage: vi.fn(async (env: { threadId?: string }) => ({ delivered: true, threadId: env.threadId ?? 't' })),
  makeThreadId: (seed: string) => `thread-${seed}`,
}));

import { runMigrations } from '../../db/migrations.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
import { runPokeCheck, drainValidationDoorbell } from '../pm-agent.js';
import { appendWorkEvent, transition } from '../../work/store.js';
import { VALIDATION_ATTEMPT_MISS } from '../../work/validation-drive.js';
import { seedTrackerTask } from '../../work/__tests__/work-fixture.js';

const MIN = 60_000;
const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, '.dojo', 'logs'), { recursive: true });
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  drainValidationDoorbell();
  pm.outcome = 'ran';
  pm.calls = 0;
  pm.to = [];
  pm.queuedEnd = null;
  pm.waits = 0;
  pm.waiting = [];
  d.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('prov-a', 'Cloud Provider', 'openai-compatible', 'api_key')`).run();
  d.prepare(`INSERT INTO models (id, provider_id, name, api_model_id) VALUES ('m-a', 'prov-a', 'Model A', 'model-a')`).run();
  d.prepare(`INSERT INTO agents (id, name, status, model_id, classification) VALUES
    ('helper', 'Helper', 'idle', 'm-a', 'apprentice'), ('pm', 'PM', 'idle', 'm-a', 'sensei'),
    ('primary', 'Main', 'idle', 'm-a', 'sensei')`).run();
});

afterEach(() => {
  vi.useRealTimers();
  drainValidationDoorbell();
  mockDb.current?.close();
  mockDb.current = null;
});

/** A claimed task whose worker filed its close (Key 1) a while ago, written straight to the spine
 *  so no debounce timer is armed by the test itself. */
function filedClose(id: string, atMs: number): void {
  seedTrackerTask(db(), {
    id, agentId: 'helper', status: 'in_progress', title: 'write the summary file',
    opened_at: atMs - 10 * MIN, updated_at: atMs, priority: 'normal',
  } as never);
  appendWorkEvent(id, 'validation_requested', 'helper', { requested_state: 'done', reason: 'done', from: 'claimed', result_delivery_id: null }, atMs);
}

const misses = (taskId: string): number => (db().prepare(
  `SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = 'audit'
     AND json_extract(payload, '$.action_taken') = ?`,
).get(taskId, VALIDATION_ATTEMPT_MISS) as { n: number }).n;

/** One poke tick. The review it fires is fire-and-forget, so wait for it to finish its work: reach the
 *  PM's door (and, when queued, start waiting for the queued turn), or settle without asking. */
const sweepAt = async (at: number): Promise<void> => {
  vi.setSystemTime(at);
  const calls = pm.calls;
  await runPokeCheck();
  for (let i = 0; i < 500 && pm.calls === calls; i += 1) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 30));
};

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));
const missReasons = (taskId: string): string[] => (db().prepare(
  `SELECT json_extract(payload, '$.reason') AS r FROM work_events WHERE work_id = ? AND kind = 'audit'
     AND json_extract(payload, '$.action_taken') = ?`,
).all(taskId, VALIDATION_ATTEMPT_MISS) as Array<{ r: string }>).map((x) => x.r);

describe('review M5: a queued review is judged when its queued turn actually runs', () => {
  it('queued: no miss while the PM is busy; the queued turn ends with no verdict, so THAT turn is the miss', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    filedClose('task-m5', now - 2 * MIN);
    pm.outcome = 'queued';
    await sweepAt(now);
    expect(pm.waits).toBe(1);
    expect(misses('task-m5')).toBe(0);
    pm.queuedEnd!('ran');              // the queued wakeup turn ran and ruled on nothing
    await settle();
    expect(misses('task-m5')).toBe(1);
  });

  it('queued: the queued turn ruled, so there is no miss', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    filedClose('task-m5v', now - 2 * MIN);
    pm.outcome = 'queued';
    await sweepAt(now);
    db().prepare(`INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, outcome, created_at) VALUES ('d-m5', 'helper', NULL, 'dashboard', 'dashboard', 'delivered', datetime('now'))`).run();
    expect(transition('task-m5v', { to: 'done', by: 'pm', actorId: 'pm', claim: 'authoritative', reason: 'upheld', resultDeliveryId: 'd-m5' }).kind).toBe('applied');
    pm.queuedEnd!('ran');
    await settle();
    expect(misses('task-m5v')).toBe(0);
  });

  it('a PM that stays busy past the owner bound still reaches the owner escalation: the miss says so', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    filedClose('task-m5b', now - 9 * MIN);   // filed long before: past the 5-minute owner bound
    pm.outcome = 'queued';
    await sweepAt(now);
    pm.queuedEnd!('ran');
    await settle();
    expect(missReasons('task-m5b').join('\n')).toMatch(/PAST the 5-minute owner-escalation bound/);
  });

  it('a queued turn that never ran (the PM was terminated): no miss, the rows stay on the doorbell for the next review', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    filedClose('task-m5n', now - 2 * MIN);
    pm.outcome = 'queued';
    await sweepAt(now);
    pm.queuedEnd!('not-run');
    await settle();
    expect(misses('task-m5n')).toBe(0);
    expect(drainValidationDoorbell()).toContain('task-m5n');
  });
});

/** The PM's turn ledger: the real turn a queued review is judged on. */
const pmTurn = (n: number): void => {
  db().prepare(`INSERT INTO turns (agent_id, turn_number, kind, subject_kind, started_at, ended_at, exit_reason, answered)
    VALUES ('pm', ?, 'engine', 'engine_event', datetime('now'), datetime('now'), 'answered', 0)`).run(n);
};

describe('review round 2 (R5): one miss per row per REAL PM turn', () => {
  it('two reviews queued behind one busy run both judge the same turn: each row gets ONE miss', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    filedClose('task-d1', now - 3 * MIN);
    pm.outcome = 'queued';
    await sweepAt(now);                     // review 1 asks about d1, queued
    filedClose('task-d2', now - 2 * MIN);
    await sweepAt(now + 20_000);            // review 2 asks about d1 and d2, queued behind the same run
    expect(pm.waits).toBe(2);
    pmTurn(41);                              // the one queued turn ran, and ruled on nothing
    for (const w of pm.waiting.splice(0)) w('ran');
    await settle();
    expect(misses('task-d1')).toBe(1);
    expect(misses('task-d2')).toBe(1);
  });

  it('a LATER real turn that also ruled on nothing is a second miss', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    filedClose('task-d3', now - 3 * MIN);
    pm.outcome = 'ran';
    pmTurn(50);
    await sweepAt(now);
    expect(misses('task-d3')).toBe(1);
    pmTurn(51);
    await sweepAt(now + 2 * MIN);           // the re-drive: a new review, a new real turn
    expect(misses('task-d3')).toBe(2);
  });
});

describe('#4: a validation review records a miss only when the PM turn actually ran', () => {
  it('the PM was mid-run (handleMessage queued): NO miss is recorded while the queued turn has not run', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    filedClose('task-q', now - 5 * MIN);
    pm.outcome = 'queued';
    await sweepAt(now);
    expect(pm.calls).toBe(1);   // the review did reach the PM's door
    expect(misses('task-q')).toBe(0);   // and records nothing while the queued turn has not run
  });

  it('after the queued turn: a turn that RAN without a verdict is a real miss, recorded once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    filedClose('task-r', now - 5 * MIN);
    pm.outcome = 'queued';
    await sweepAt(now);
    expect(misses('task-r')).toBe(0);
    pm.queuedEnd!('ran');
    await settle();
    expect(misses('task-r')).toBe(1);   // judged once, on the turn that ran
  });

  it('CONTROL: a review whose turn ran and ruled on nothing is still a miss on the first review', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    filedClose('task-c', now - 5 * MIN);
    pm.outcome = 'ran';
    await sweepAt(now);
    expect(misses('task-c')).toBe(1);
    expect(drainValidationDoorbell()).not.toContain('task-c');
  });

  it('a row the PM ruled on during its queued turn is not asked again and gets no miss', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    filedClose('task-v', now - 5 * MIN);
    pm.outcome = 'queued';
    await sweepAt(now);
    // The queued turn ran and upheld it: Key 2, through the spine's own door.
    db().prepare(`INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, outcome, created_at) VALUES ('d-v', 'helper', NULL, 'dashboard', 'dashboard', 'delivered', datetime('now'))`).run();
    const kept = transition('task-v', { to: 'done', by: 'pm', actorId: 'pm', claim: 'authoritative', reason: 'upheld', resultDeliveryId: 'd-v' });
    expect(kept.kind).toBe('applied');
    pm.queuedEnd!('ran');
    await settle();
    pm.outcome = 'ran';
    const before = pm.calls;
    await sweepAt(now + MIN);
    expect(misses('task-v')).toBe(0);
    expect(pm.calls).toBe(before);   // nothing left to ask about: the dedup holds, no wasted PM turn
  });
});
