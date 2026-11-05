import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-still-working');

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-still-working');
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-still-working', 'dojo.db'),
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

// The PM sweep's gate: an answered turn on the task's origin, idle since. Only its CHANNEL line is
// on record here (`deliveredVia: ['imessage']`, no artifact): the shape of an iMessage "On it".
const { evidence } = vi.hoisted(() => ({ evidence: { on: false } }));
vi.mock('../delivery-evidence.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../delivery-evidence.js')>()),
  findDeliveryEvidenceForTask: (taskId: string) => (evidence.on
    ? { turnNumber: 7, answeredAt: '2020-01-01 00:00:00', artifacts: [], deliveredVia: ['imessage'], answerMessageId: null, taskId } as never
    : null),
}));

import { runMigrations } from '../../db/migrations.js';

// Each clause boots the real module graph and runs the full migration chain; an import cost, not
// a timing assertion. Nothing here measures time.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
import { runPokeCheck } from '../pm-agent.js';
import { trackerAddNotes } from '../tools.js';
import { patienceFloorFor } from '../assignee-patience.js';
import { endJobCarry } from '../../work/task-freshness.js';
import { seedTrackerTask } from '../../work/__tests__/work-fixture.js';

const OWNER = 'owner@example.test';
const MIN = 60_000;
const db = (): Database.Database => mockDb.current!;
const sqlTime = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

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
const remediations = (taskId: string): number => (db().prepare(
  "SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = 'poke_remediation'",
).get(taskId) as { n: number }).n;
const sweepAt = async (at: number): Promise<void> => { vi.setSystemTime(at); await runPokeCheck(); await new Promise((r) => setTimeout(r, 15)); };
function claimedTask(id: string, atMs: number): void {
  seedTrackerTask(db(), {
    id, agentId: 'helper', status: 'in_progress', title: 'sort the inbox',
    opened_at: atMs, updated_at: atMs, origin_conv_key: 'c-1', priority: 'normal',
  } as never);
}
function modelCall(atMs: number, latencyMs = 4_000): void {
  db().prepare(`INSERT INTO cost_records (id, agent_id, model_id, provider_id, input_tokens, output_tokens, cost_usd, latency_ms, created_at)
    VALUES (?, 'helper', 'm-a', 'prov-a', 900, 40, 0, ?, ?)`).run(`c-${atMs}-${latencyMs}`, latencyMs, sqlTime(atMs));
}

// FIELD FIX 3 AUDIT ROUND (#8). OR-LONG-JOBS (owner, 2026-10-12, verbatim): "If the agent gives the PM a
// response that suggests they are still working on the project, then the PM should let them work. ...
// we can't have the dojo panick every 15 minutes because an agent isn't responding." The ladder ran on
// fixed clocks and a "still working" note re-armed nothing: nudge at 5 min, "Second check-in" at 15,
// ESCALATION to the main agent at 30, whatever the agent said.
describe('a "still working" answer or token movement re-arms the PM ladder', () => {
  it('THE RED: the assignee answers the first check-in "still working": no second check-in or escalation follows on the old clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    claimedTask('task-sw', now - 6 * MIN);
    await sweepAt(now);
    expect(rungsSent('task-sw')).toEqual([1]);
    vi.setSystemTime(now + 2 * MIN);
    trackerAddNotes('helper', { taskId: 'task-sw', notes: 'still working: 30 of 50 sorted' });
    await sweepAt(now + 16 * MIN);
    await sweepAt(now + 31 * MIN);
    expect(Math.max(...rungsSent('task-sw'))).toBeLessThan(3);
    expect(remediations('task-sw')).toBeGreaterThan(0);
    expect(rungsSent('task-sw')[1]).toBe(1);
  });

  it('token movement after the check-in re-arms it the same way (the agent is working, it just has not written to the task)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    claimedTask('task-tok', now - 6 * MIN);
    await sweepAt(now);
    modelCall(now + 2 * MIN);
    await sweepAt(now + 16 * MIN);
    await sweepAt(now + 31 * MIN);
    expect(Math.max(...rungsSent('task-tok'))).toBeLessThan(3);
    expect(rungsSent('task-tok')[1]).toBe(1);
  });

  it('CONTROL: no answer and no tokens: the ladder climbs as before', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    claimedTask('task-quiet', now - 6 * MIN);
    for (const m of [0, 16, 31]) await sweepAt(now + m * MIN);
    expect(rungsSent('task-quiet')).toEqual([1, 2, 3]);
    expect(remediations('task-quiet')).toBe(0);
  });

  it('the waits scale with the measured model pace: an assignee whose calls take 15 minutes is not checked in on at 6', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    modelCall(now - 40 * MIN, 15 * MIN);
    claimedTask('task-slow', now - 6 * MIN);
    await sweepAt(now);
    expect(pokes('task-slow')).toBe(0);
    expect(patienceFloorFor('helper').floorSeconds).toBeGreaterThanOrEqual(15 * 60);
  });
});
