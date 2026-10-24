// v3.5 D1, FIX ROUND 2 (ruling 3, review (c)) — A CONTINUED JOB THAT TOUCHES NOTHING IS CHECKED IN ON.
//
// The PM's check-in ladder holds for the job in flight (the agent's carry) and while the agent is mid-turn.
// A measured job the engine keeps continuing is nearly always one or the other, so a chain of
// continuations that only ever makes new reads, touching no item, was never checked in on. The hold now
// applies to a continued measured job only while it is touching items (new ledger items since the last
// check-in, or, before the first, within the first rung's own window). One that touches none lets the
// ladder run on its existing rungs, and the check-in carries the fact: continuations since it last
// touched an item, and how many are left. Pokes still never fire mid-turn (orchestrator ruling, fix
// round 3): such a job's check-in lands at the CONTINUATION BOUNDARY, the park between its turns,
// where the engine asks the ladder (`checkInAtThePark`). A job touching items is left alone as before.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-d1-loop-checkin');

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-d1-loop-checkin');
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-d1-loop-checkin', 'dojo.db'),
  };
});

const { broadcasts, transport, a2a } = vi.hoisted(() => ({
  broadcasts: [] as Array<Record<string, unknown>>,
  transport: [] as string[],
  a2a: [] as Array<{ toAgent?: string; payload?: string; threadId?: string }>,
}));
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (e: Record<string, unknown>) => { broadcasts.push(e); },
  stampPersistedRow: (e: unknown) => e,
}));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({
    notifyPrimaryOfInjury: vi.fn(async () => undefined),
    handleMessage: vi.fn(async () => undefined),
    getAgentUptime: () => 0,
  }),
  stopAgent: vi.fn(),
}));
vi.mock('../../agent/a2a-transport.js', () => ({
  deliverA2AMessage: vi.fn(async (env: { toAgent?: string; payload?: string; threadId?: string }) => {
    a2a.push(env);
    return { delivered: true, threadId: env.threadId ?? 't' };
  }),
  makeThreadId: (seed: string) => `thread-${seed}`,
}));
const { verdict } = vi.hoisted(() => ({ verdict: { reply: '' } }));
vi.mock('../../agent/model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent/model.js')>()),
  callModel: vi.fn(async () => ({ content: verdict.reply })),
}));
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  const record = (...a: unknown[]): string => { transport.push(JSON.stringify(a)); return ''; };
  return { ...orig, default: { ...orig, execSync: record, execFileSync: record }, execSync: record, execFileSync: record };
});

const { evidence } = vi.hoisted(() => ({ evidence: { on: false } }));
vi.mock('../delivery-evidence.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../delivery-evidence.js')>()),
  // A TANGIBLE handover on record, answered before any check-in: strike 1 and strike 2's premise.
  findDeliveryEvidenceForTask: (taskId: string) => (evidence.on
    ? { turnNumber: 7, answeredAt: '2020-01-01 00:00:00', artifacts: ['/tmp/report.md'], deliveredVia: ['dashboard'], taskId } as never
    : null),
}));

import { runMigrations } from '../../db/migrations.js';

// Each clause boots the real module graph and runs the full migration chain; an import cost, not
// a timing assertion. Nothing here measures time.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
import { runPokeCheck, checkInAtThePark } from '../pm-agent.js';
import { endJobCarry, registerTimerWake, beginJobRun, endJobRun, carryJobWork } from '../../work/task-freshness.js';
import { recordContinued } from '../../work/job-momentum.js';
import { recordTouched } from '../../work/ledger-store.js';
import { seedTrackerTask } from '../../work/__tests__/work-fixture.js';
import { activeRuns } from '../../agent/shared-state.js';

const OWNER = 'owner@example.test';
const MIN = 60_000;
const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
  endJobCarry('helper');   // the job carry is process memory: no test inherits another's
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, '.dojo', 'logs'), { recursive: true });
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  transport.length = 0;
  broadcasts.length = 0;
  a2a.length = 0;
  d.prepare(`INSERT INTO config (key, value) VALUES ('imessage_approved_senders', ?)`)
    .run(JSON.stringify([{ address: OWNER, name: 'Owner', is_primary: true }]));
  d.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('prov-a', 'Cloud Provider', 'openai-compatible', 'api_key')`).run();
  d.prepare(`INSERT INTO models (id, provider_id, name, api_model_id) VALUES ('m-a', 'prov-a', 'Model A', 'model-a')`).run();
  d.prepare(`INSERT INTO agents (id, name, status, model_id, classification) VALUES
    ('helper', 'Helper', 'idle', 'm-a', 'apprentice'), ('pm', 'PM', 'idle', 'm-a', 'sensei'),
    ('primary', 'Main', 'idle', 'm-a', 'sensei')`).run();
});

afterEach(() => {
  activeRuns.delete('helper');
  vi.useRealTimers();
  mockDb.current?.close();
  mockDb.current = null;
});

const pokes = (taskId: string): number => (db().prepare(
  "SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = 'poke'",
).get(taskId) as { n: number }).n;
const rungsSent = (taskId: string): number[] => (db().prepare(
  "SELECT json_extract(payload, '$.rung') AS r FROM work_events WHERE work_id = ? AND kind = 'poke' ORDER BY id",
).all(taskId) as Array<{ r: number }>).map((x) => x.r);
/** What the PM sent about this task, to whoever it went to, oldest first: a re-drive names the task on
 *  its row; the check-in at the park is a rider notice, which names it in its text (fix round 4). */
const checkIns = (taskId: string): string[] => (db().prepare(
  "SELECT content FROM messages WHERE lane = 'events' AND (task_id = ? OR (origin_intent = 'agent_notice' AND instr(content, ?) > 0)) ORDER BY rowid",
).all(taskId, `ID: ${taskId}`) as Array<{ content: string }>).map((r) => r.content);
const sweepAt = async (at: number): Promise<void> => { vi.setSystemTime(at); await runPokeCheck(); await new Promise((r) => setTimeout(r, 15)); };


/** A claimed task on the helper, opened (and last written) at `atMs`. */
function claimedTask(id: string, title: string, atMs: number, measuredLeft: number | null): void {
  seedTrackerTask(db(), {
    id, agentId: 'helper', status: 'in_progress', title,
    opened_at: atMs, updated_at: atMs, origin_conv_key: 'c-1', priority: 'normal',
  } as never);
  if (measuredLeft !== null) {
    db().prepare(`UPDATE work SET measure_json = ?, measure_initial = 50, measure_remaining = ?, measure_at = ? WHERE id = ?`)
      .run(JSON.stringify({ tool: 'gmail_search', args: { query: 'in:inbox -label:Done' }, unit: 'messages' }), measuredLeft, atMs, id);
  }
}


const JOB = 'task-loop';

/** A measured job, opened `ageMin` minutes ago, carried by the agent's running continuation, which the
 *  engine has continued `continuations` times. */
function aContinuedJob(now: number, ageMin: number, continuations: number): void {
  claimedTask(JOB, 'the mailbox sweep', now - ageMin * MIN, 12);
  for (let i = 0; i < continuations; i++) recordContinued(JOB, { remaining: 12, touchedThisTurn: 0, novelCallsThisTurn: 1, turnNumber: 10 + i });
  carryJobWork('helper', [JOB]);
  registerTimerWake('helper');
  beginJobRun('helper', 'timer');
  activeRuns.add('helper');   // the runtime holds the run until the turn's `finally`: the park runs inside it
  db().prepare("UPDATE agents SET status = 'working' WHERE id = 'helper'").run();
}

describe('fix round 2 (c): a continued job that touches nothing is checked in on', () => {
  it('the sweep never pokes it mid-turn (the rule stands): its check-in waits for the continuation boundary', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    aContinuedJob(now, 6, 3);
    await sweepAt(now);
    expect(pokes(JOB)).toBe(0);
    endJobRun('helper');
  });

  it('at the park (the continuation boundary), a loop of new successful reads with 0 items touched is checked in on at its normal rung, carrying the fact', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    aContinuedJob(now, 6, 3);
    vi.setSystemTime(now);
    await checkInAtThePark(JOB);
    await new Promise((r) => setTimeout(r, 15));
    expect(rungsSent(JOB)).toEqual([1]);
    expect(checkIns(JOB).join('\n')).toMatch(/Continued 3 times since it last touched an item; 12 left on its measure\./);
    endJobRun('helper');
  });

  it('CONTROL: the same job touching items is left alone at the park, as before', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    aContinuedJob(now, 6, 3);
    recordTouched(JOB, 'gmail_label', ['gmail:msg:a'], now - MIN);
    vi.setSystemTime(now);
    await checkInAtThePark(JOB);
    await new Promise((r) => setTimeout(r, 15));
    expect(pokes(JOB)).toBe(0);
    endJobRun('helper');
  });
});
