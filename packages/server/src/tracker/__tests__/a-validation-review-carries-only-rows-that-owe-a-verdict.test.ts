// PM-CANNOT-APPROVE C2: A VALIDATION REVIEW CARRIES ONLY THE ROWS THAT OWE A VERDICT.
//
// Measured on a lived-in box: the one row owed a verdict was item 8 of a review, behind a board
// summary and seven BLOCKED lines for rows already validated and already escalated, and the footer
// said that ending silently was right when nothing was actionable. The PM went silent on about
// 2,800 reviews. A review that carries a verdict-owed row now carries only such rows, each with
// its own "rule on this one" line, and says nothing about ending silently. A review with no verdict
// owed is the patrol review, unchanged.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-validation-review-rows');

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-validation-review-rows');
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-validation-review-rows', 'dojo.db'),
  };
});

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ }, stampPersistedRow: (e: unknown) => e }));

// What the PM's runtime answers: 'queued' = it was mid-run and only queued a wakeup.
const { pm } = vi.hoisted(() => ({ pm: { calls: 0, reports: [] as string[] } }));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({
    notifyPrimaryOfInjury: vi.fn(async () => undefined),
    handleMessage: vi.fn(async (agentId: string, content: string) => { if (agentId === 'pm') { pm.calls += 1; pm.reports.push(content); } return 'ran'; }),
    whenQueuedRunEnds: vi.fn(async () => 'ran'),
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
import { appendWorkEvent } from '../../work/store.js';
import { upholdClaim } from '../../work/tracker-store.js';
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
  pm.calls = 0;
  pm.reports = [];
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

/** A claimed task whose worker filed its close (Key 1) a while ago: it owes the PM a verdict. */
function filedClose(id: string, atMs: number): void {
  seedTrackerTask(db(), {
    id, agentId: 'helper', status: 'in_progress', title: 'write the summary file',
    opened_at: atMs - 10 * MIN, updated_at: atMs, priority: 'normal',
  } as never);
  appendWorkEvent(id, 'validation_requested', 'helper', { requested_state: 'done', reason: 'done', from: 'claimed', result_delivery_id: null }, atMs);
}

/** A row blocked for hours whose block the PM already upheld: it owes nothing. */
function settledBlock(id: string, atMs: number): void {
  seedTrackerTask(db(), {
    id, agentId: 'helper', status: 'blocked', title: `waiting on a vendor ${id}`,
    opened_at: atMs - 600 * MIN, updated_at: atMs - 500 * MIN, priority: 'normal',
  } as never);
  upholdClaim(id, 'blocked', 'pm', 'pm', 'the block is real');
}

const sweepAt = async (at: number): Promise<void> => {
  vi.setSystemTime(at);
  const calls = pm.calls;
  await runPokeCheck();
  for (let i = 0; i < 500 && pm.calls === calls; i += 1) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 30));
};

describe('C2: a validation review carries only the rows that owe a verdict', () => {
  it.skip('2d: a review with one verdict-owed row and seven settled blocks carries only that row, with a rule-on-it line, and never says to end silently', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    for (let i = 1; i <= 7; i += 1) settledBlock(`blocked-${i}`, now);
    filedClose('task-owed', now - 2 * MIN);
    await sweepAt(now);
    expect(pm.reports.length).toBe(1);
    const report = pm.reports[0];
    expect(report).toMatch(/^Tracker review -- /);
    expect(report).toContain('task-owe');
    expect(report, 'settled rows are not in a validation review').not.toMatch(/BLOCKED:/);
    expect(report).not.toMatch(/waiting on a vendor/);
    expect(report, 'silence is never offered as the answer').not.toMatch(/end silently/i);
    expect(report.match(/\[Engine hint: rule on this one:/g)?.length, 'one rule-on line per verdict-owed row').toBe(1);
  });

  it.skip('2d: two verdict-owed rows get one rule-on line each', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    filedClose('task-one', now - 2 * MIN);
    filedClose('task-two', now - 3 * MIN);
    await sweepAt(now);
    expect(pm.reports[0].match(/\[Engine hint: rule on this one:/g)?.length).toBe(2);
  });

  it.skip('2d: CONTROL: with no verdict owed, the patrol review still reports the blocked rows as before', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now() + 24 * 60 * MIN;   // past the patrol review's 10-minute cadence gate
    settledBlock('blocked-only', now);
    await sweepAt(now);
    expect(pm.reports.length).toBe(1);
    expect(pm.reports[0]).toMatch(/BLOCKED: "waiting on a vendor blocked-only"/);
    expect(pm.reports[0]).not.toMatch(/\[Engine hint: rule on this one:/);
  });
});
