// ════════════════════════════════════════════════════════════════════════════════════════
// t143 (v3.3.3, OR-LONG-JOBS) — LIVENESS IS JUDGED ON MOVEMENT, TASK BY TASK.
//
// The owner's ruling: "if there is progress of any kind, maybe we just let them work … a true
// connection issue or no movement (no tokens going in or out) for a couple hours, we notify the
// user." Movement is what the Dojo can see: tokens in or out (a model call's cost row), a request
// open on a live connection (the abort registry), a tool started or finished (the agent's own
// rows). The 30-second status heartbeat (`runtime.ts` `startStatusHeartbeat`) is a timer, not
// progress, and is never read as evidence.
//
// Every clause drives the real doors: the project manager's own sweep (`runPokeCheck`), the
// engine's real checkpoint writer and turn-finalize stamper (the two records a 15-minute park
// leaves on the tracker), the real agents route (the per-agent setting), the real owner-notice
// door down to the `deliveries` ledger. Only the phone (`child_process`), the socket, the A2A
// transport and the engine runtime are replaced.
// ════════════════════════════════════════════════════════════════════════════════════════

// RED-FIRST at 4cb9ed61: clauses marked `it.fails` are the witness; the fix commit flips them.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-t143-liveness');

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t143-liveness');
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t143-liveness', 'dojo.db'),
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
import { noteEngineCheckpoint } from '../../work/engine-checkpoint-note.js';
import { stampTasksAtTurnFinalize } from '../task-stamps.js';
import { agentsRouter } from '../../gateway/routes/agents.js';
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
const sent = (): string[] => transport.filter((t) => !t.includes('--help') && !t.includes('which'));
const pokes = (taskId: string): number => (db().prepare(
  "SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = 'poke'",
).get(taskId) as { n: number }).n;

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

describe('SILENT: an agent with no movement at all, past its window, is reported to the owner once', () => {
  it.fails('a wedged tool call (no stream, no tool finish) for 3 hours: ONE owner notice, naming the agent and its task', async () => {
    wedgedToolCall(3 * 60 * MIN);
    await runPokeCheck();
    expect(ownerTexts()).toBe(1);
    expect(sent()[0]).toContain('Helper');
    expect(sent()[0]).toContain('the quarterly numbers');
    // The same incident on the next sweep: still one.
    await runPokeCheck();
    expect(ownerTexts()).toBe(1);
  });

  it.fails('the per-agent window, set to 10 minutes through the real agents route, is the one the sweep uses', async () => {
    const res = await agentsRouter.request('/helper', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ silentWindowMinutes: 10 }),
    });
    expect(res.status).toBe(200);
    wedgedToolCall(15 * MIN);
    await runPokeCheck();
    expect(ownerTexts()).toBe(1);
    const detail = (await res.json()) as { data: { silentWindowMinutes?: number | null } };
    expect(detail.data.silentWindowMinutes).toBe(10);
  });
});

describe('M3 (t137 review): a task is judged on its OWN activity, not on the engine checkpoint touch', () => {
  it.fails('an abandoned second task planted BEFORE the parks is still re-driven by the PM; the in-flight one is not', async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    // The abandoned task: claimed two hours ago from another conversation, never touched since.
    claimedTask('task-abandoned', 'the forgotten report', now - 120 * MIN, 'c-old');
    // The long job: claimed 40 minutes ago, worked through three real 15-minute parks.
    claimedTask('task-live', 'the long research job', now - 40 * MIN, 'c-job');
    for (const [i, at] of [now - 30 * MIN, now - 15 * MIN, now - MIN].entries()) {
      vi.setSystemTime(at);
      modelCallFinished(at);
      noteEngineCheckpoint('helper', 'turn-budget');
      stampTasksAtTurnFinalize({
        agentId: 'helper', turnNumber: 10 + i, outcome: 'budget', answerMessageId: null,
        rootSourceMessageId: null, convKey: 'c-job', servedTaskId: null,
      });
    }
    vi.setSystemTime(now);
    // Precondition: the checkpoint DID touch the abandoned task (that is what hid it).
    expect((db().prepare("SELECT updated_at FROM work WHERE id = 'task-abandoned'").get() as { updated_at: number }).updated_at)
      .toBeGreaterThan(now - 2 * MIN);
    await runPokeCheck();
    expect(pokes('task-abandoned')).toBeGreaterThan(0);
    expect(pokes('task-live')).toBe(0);
    // The agent is moving (its last park was a minute ago): the owner hears nothing.
    expect(ownerTexts()).toBe(0);
  });
});
