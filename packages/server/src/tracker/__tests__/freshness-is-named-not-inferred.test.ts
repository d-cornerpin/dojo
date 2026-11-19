// ════════════════════════════════════════════════════════════════════════════════════════
// t143 ROUND 2 — A TASK IS FRESH ONLY BY ACTIVITY THAT NAMES IT; THE PLATFORM NOTICE NEEDS NO PM.
//
// Rulings (orchestrator, 2026-10-13): (1) the silent check runs whether or not the project manager
// is enabled; (2+3) a task's freshness may only be refreshed by activity that structurally names
// THAT task — its own tool calls / notes / work_update, the turn whose trigger names it — so the
// engine's 15-minute checkpoint and the turn-end stamp stop refreshing tasks by agent or by
// conversation, and the close-out gate reads the same freshness; (4) the PM's "your pause was
// lifted" notice keeps waking the agent but asks for no reply.
//
// (The round-1 header follows: the same harness.)
//
// The owner's ruling: "if there is progress of any kind, maybe we just let them work … a true
// connection issue or no movement (no tokens going in or out) for a couple hours, we notify the
// user." Movement is what the Dojo can see: tokens in or out (a model call's cost row), a request
// open on a live connection (the abort registry), a tool started or finished (the agent's own
// rows). The 30-second status heartbeat (`runtime.ts` `startStatusHeartbeat`) is a timer, not
// progress, and is never read as evidence.
//
// Every clause drives the real doors: the scheduler's own tick, the retask door, the real owner-notice
// door down to the `deliveries` ledger. Only the phone (`child_process`), the socket, the A2A
// transport and the engine runtime are replaced.
// ════════════════════════════════════════════════════════════════════════════════════════

// RED-FIRST at 4cb9ed61: clauses marked `it.fails` are the witness; the fix commit flips them.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-t143-r2-freshness');

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t143-r2-freshness');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t143-r2-freshness', 'dojo.db'),
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
import { seedTrackerTask } from '../../work/__tests__/work-fixture.js';

const OWNER = 'owner@example.test';
const MIN = 60_000;
const db = (): Database.Database => mockDb.current!;
const sqlTime = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

beforeEach(() => {
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
    ('helper', 'Helper', 'idle', 'm-a', 'apprentice'), ('pm', 'PM', 'idle', 'm-a', 'sensei')`).run();
});

afterEach(() => {
  vi.useRealTimers();
  mockDb.current?.close();
  mockDb.current = null;
});

const ownerTexts = (): number => (db().prepare(
  "SELECT COUNT(*) AS n FROM deliveries WHERE agent_id = 'platform' AND tool = 'alert' AND recipient_id = ?",
).get(OWNER) as { n: number }).n;
/** The phone sends (the bridge's own `--help` probe and path lookups are not sends). */

/** A claimed task on the helper, opened (and last written) at `atMs`. */
function claimedTask(id: string, title: string, atMs: number, convKey: string): void {
  seedTrackerTask(db(), {
    id, agentId: 'helper', status: 'in_progress', title,
    opened_at: atMs, updated_at: atMs, origin_conv_key: convKey, priority: 'normal',
  } as never);
}

/** A model call that finished at `atMs`: the cost row is the record of tokens in and out. */
function modelCallFinished(atMs: number, agentId = 'helper'): void {
  db().prepare(`INSERT INTO cost_records (id, agent_id, model_id, provider_id, input_tokens, output_tokens, cost_usd, created_at)
                VALUES (?, ?, 'm-a', 'prov-a', 12000, 300, 0.01, ?)`).run(`cr-${agentId}-${atMs}`, agentId, sqlTime(atMs));
}

/** The model asked for a tool at `atMs` (the assistant's own row, carrying the tool_use block). */
function toolStarted(atMs: number, tool: string, turn: number): void {
  db().prepare(`INSERT INTO messages (id, agent_id, role, content, turn_number, created_at)
                VALUES (?, 'helper', 'assistant', ?, ?, ?)`)
    .run(`asst-${atMs}`, JSON.stringify([{ type: 'tool_use', id: `tu-${atMs}`, name: tool, input: {} }]), turn, atMs);
}

/** A turn is open (the agent is mid-turn), started at `atMs`. */
function turnOpen(turn: number, atMs: number): void {
  db().prepare(`INSERT INTO turns (agent_id, turn_number, started_at, answered) VALUES ('helper', ?, ?, 0)`)
    .run(turn, sqlTime(atMs));
}

/** A wedged tool call: the model's call finished and asked for a tool `quietMs` ago; the tool
 *  never returned; nothing is open on the abort registry; the agent still reads `working`. */
function wedgedToolCall(quietMs: number, now = Date.now()): void {
  claimedTask('task-wedged', 'the quarterly numbers', now - quietMs - 5 * MIN, 'c-1');
  turnOpen(7, now - quietMs - MIN);
  modelCallFinished(now - quietMs);
  toolStarted(now - quietMs, 'exec', 7);
  db().prepare("UPDATE agents SET status = 'working' WHERE id = 'helper'").run();
}


import { runSchedulerTick, balanceCheckSettled } from '../../scheduler/clock.js';
import { trackerRetask } from '../tools.js';
import { sweepSilentAgents } from '../liveness.js';

describe('ROUND 2 (1): the platform notice never depends on the project manager existing', () => {
  it('with no PM agent, the scheduler\'s own tick tells the owner about a wedged agent, once', async () => {
    db().prepare("DELETE FROM agents WHERE id = 'pm'").run();
    wedgedToolCall(3 * 60 * MIN);
    expect(await runSchedulerTick()).toBe('ran');
    await balanceCheckSettled();
    expect(ownerTexts()).toBe(1);
    expect(await runSchedulerTick()).toBe('ran');
    await balanceCheckSettled();
    expect(ownerTexts()).toBe(1);
  });
});


describe('ROUND 3 (I2): a check-in owes no reply — nothing waits, nothing escalates for a missing one', () => {
  const eventsToHelper = (): Array<{ task_id: string | null; content: string; a2a_requires_response: number | null }> =>
    db().prepare("SELECT task_id, content, a2a_requires_response FROM messages WHERE agent_id = 'helper' AND lane = 'events'")
      .all() as never;

  it('the retask directive is delivered the same way: a notice naming the task, no reply owed', async () => {
    claimedTask('task-redo', 'the price check', Date.now() - 30 * MIN, 'c-1');
    const out = await trackerRetask('pm', { task_id: 'task-redo', directive: 'The brief went to chat but the task says email; send it by email with the same content.' });
    expect(out).not.toMatch(/^Error/);
    expect(a2a.filter((m) => (m as { requiresResponse?: boolean }).requiresResponse)).toHaveLength(0);
    expect(eventsToHelper().find((r) => r.content.includes('send it by email'))?.task_id).toBe('task-redo');
  });
});

describe('ROUND 4 (minors): a failed re-drive is not dropped; a crash-left turn row is not a live agent', () => {
  const blockEvents = (): void => {
    db().exec("CREATE TRIGGER block_events BEFORE INSERT ON messages WHEN NEW.lane = 'events' BEGIN SELECT RAISE(ABORT, 'disk said no'); END");
  };

  it('a retask whose directive could not be delivered says so, instead of "Directive delivered"', async () => {
    claimedTask('task-redo2', 'the price check', Date.now() - 30 * MIN, 'c-1');
    blockEvents();
    const out = await trackerRetask('pm', { task_id: 'task-redo2', directive: 'The brief went to chat but the task says email; send it by email with the same content.' });
    expect(out).not.toContain('Directive delivered');
    expect(out).toMatch(/not delivered|could not be delivered/);
  });

  it('SILENT: an idle agent waiting on the owner, with a turn row a crash left open, is not silent', async () => {
    const now = Date.now();
    claimedTask('task-asked2', 'the venue shortlist', now - 5 * 60 * MIN, 'c-1');
    turnOpen(3, now - 200 * MIN);                // the crash-left row: ended_at never written
    modelCallFinished(now - 199 * MIN);
    sweepSilentAgents();
    expect(ownerTexts()).toBe(0);
  });
});
