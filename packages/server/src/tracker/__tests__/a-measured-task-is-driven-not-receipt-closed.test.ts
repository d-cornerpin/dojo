import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-measured-strike2');

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-measured-strike2');
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-measured-strike2', 'dojo.db'),
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

import { runMigrations } from '../../db/migrations.js';

// Each clause boots the real module graph and runs the full migration chain; an import cost, not
// a timing assertion. Nothing here measures time.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
import { runPokeCheck } from '../pm-agent.js';
import { trackerAddNotes, trackerUpdateStatus } from '../tools.js';
import { recordPoke, currentRung } from '../../work/poke-ladder.js';
import { readAuditTrail } from '../../work/audit-trail.js';
import { noteEngineCheckpoint } from '../../work/engine-checkpoint-note.js';
import { endJobCarry, registerTimerWake, beginJobRun, endJobRun } from '../../work/task-freshness.js';
import { stampTasksAtTurnFinalize } from '../task-stamps.js';
import { seedTrackerTask } from '../../work/__tests__/work-fixture.js';
import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';

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
/** What the PM sent about this task, to whoever it went to, oldest first. */
const checkIns = (taskId: string): string[] => (db().prepare(
  "SELECT content FROM messages WHERE lane = 'events' AND task_id = ? ORDER BY rowid",
).all(taskId) as Array<{ content: string }>).map((r) => r.content);
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
/** The work the engine can count (`engineProof`): a file the helper wrote, charged to the task's ledger, still on disk. */
function wroteFile(taskId: string, atMs: number): void {
  const report = path.join(HOME, `${taskId}.md`);
  fs.writeFileSync(report, 'The one-page report.');
  db().prepare(
    `INSERT INTO audit_log (id, agent_id, action_type, target, result, created_at) VALUES (?, 'helper', 'file_write', ?, 'success', ?)`,
  ).run(`a-${taskId}`, report, sqlTime(atMs));
  db().prepare(`INSERT INTO work_ledger (work_id, item_key, tool, first_at, last_at) VALUES (?, ?, 'file_write', ?, ?)`)
    .run(taskId, `file:${report}`, atMs, atMs);
}
const closeLogged = (taskId: string): number => (db().prepare(
  "SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = 'handed_in' AND actor = 'engine'",
).get(taskId) as { n: number }).n;

describe('fix round 3 (NB2): a delivered measured task with items left is driven, never handed in by the engine', () => {
  it('two cycles of the ladder: it climbs to escalation, never sends a close-out poke, never logs a close', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    claimedTask('task-m', 'the mailbox sweep', now - 6 * MIN, 12);
    wroteFile('task-m', now - 5 * MIN);
    for (const m of [0, 10, 25, 31, 47, 62, 80, 95]) await sweepAt(now + m * MIN);
    const sent = checkIns('task-m').join('\n---\n');
    expect(sent).not.toMatch(/DELIVERY ON RECORD|Do NOT redo the work/);
    expect(rungsSent('task-m')).toEqual(expect.arrayContaining([1, 2, 3]));
    expect(closeLogged('task-m')).toBe(0);
    expect(remediations('task-m')).toBe(0);
    expect((db().prepare("SELECT state FROM work WHERE id = 'task-m'").get() as { state: string }).state).toBe('claimed');
  });

  it('CONTROL: the same evidence on an unmeasured task still gets the close-out steer (strike 1)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    claimedTask('task-u', 'the one-page report', now - 6 * MIN, null);
    wroteFile('task-u', now - 5 * MIN);
    await sweepAt(now);
    expect(checkIns('task-u').join('\n')).toMatch(/DELIVERY ON RECORD/);
  });

  it('CONTROL: a measured task at zero is handed in by the engine at strike 2, never set done', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    claimedTask('task-z', 'the finished sweep', now - 6 * MIN, 0);
    wroteFile('task-z', now - 5 * MIN);
    for (const m of [0, 10, 25]) await sweepAt(now + m * MIN);
    expect(checkIns('task-z').join('\n')).toMatch(/DELIVERY ON RECORD/);
    expect(closeLogged('task-z')).toBe(1);
    expect((db().prepare("SELECT state FROM work WHERE id = 'task-z'").get() as { state: string }).state).toBe('handed_in');
    expect(db().prepare("SELECT COUNT(*) AS c FROM work_events WHERE work_id = 'task-z' AND kind = 'decided'").get()).toEqual({ c: 0 });
  });
});
