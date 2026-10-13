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

const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-t143-r2-freshness');

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t143-r2-freshness');
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
import { runPokeCheck, queueEffortReviewIfNeeded, runEffortReview } from '../pm-agent.js';
import { pendingCirclingVerdict } from '../effort-governor.js';
import { registerAbortable, releaseAbortable } from '../../agent/shared-state.js';
import { configRouter } from '../../gateway/routes/config.js';
import { trackerAddNotes } from '../tools.js';
import { recordPoke } from '../../work/poke-ladder.js';
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
/** The phone sends (the bridge's own `--help` probe and path lookups are not sends). */
const sent = (): string[] => transport.filter((t) => t.includes('"send"'));
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


import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';
import { initState } from '../../agent/v2/state.js';
import { runCloseoutGate } from '../../agent/v2/steps/preflight/closeout-gate.js';
import { runSchedulerTick, balanceCheckSettled } from '../../scheduler/clock.js';
import { trackerValidatePause } from '../tools.js';

/** One engine turn of the long job: a turn context like the engine's own, then the two records a
 *  15-minute park leaves (the checkpoint and the turn-finalize stamp), then the turn ends. The
 *  first turn's trigger is the owner's ask; a continuation's trigger is the engine's self-wake. */
function parkedTurn(turnNumber: number, at: number, askMessageId: string | null): void {
  vi.setSystemTime(at);
  const tc = openTurnContext('helper');
  tc.turnNumber = turnNumber;
  tc.root = askMessageId ? { kind: 'ask', id: askMessageId, sourceMessageId: askMessageId } : null;
  db().prepare(`INSERT INTO turns (agent_id, turn_number, started_at, ended_at, exit_reason, answered)
                VALUES ('helper', ?, ?, ?, 'budget', 0)`).run(turnNumber, sqlTime(at - 15 * MIN), sqlTime(at));
  modelCallFinished(at);
  noteEngineCheckpoint('helper', 'turn-budget');
  stampTasksAtTurnFinalize({
    agentId: 'helper', turnNumber, outcome: 'budget', answerMessageId: null,
    rootSourceMessageId: askMessageId, convKey: 'c-job', servedTaskId: null,
  });
  endTurnContext('helper');
}

/** The close-out gate as a continuation turn of this agent meets it (no human waiting). */
async function gateNames(): Promise<string[]> {
  const tc = openTurnContext('helper');
  tc.state = initState({
    agentId: 'helper', contextWindow: 128_000, isAutoRouted: false, configuredModelId: 'm-a', turnNumber: 99,
    triggeredByIMessage: false, triggeredByA2AReplyIntent: null, lastUserMessageContent: null,
    lastUserMessageId: null, inboundChannel: null, inboundContext: null, pendingTechniqueAck: null,
  });
  try {
    await runCloseoutGate(tc, { agentId: 'helper' } as never, { db: db(), triggerRow: undefined as never });
    return [...(tc.state!.danglingTaskIds ?? [])];
  } finally {
    endTurnContext('helper');
  }
}

/** The long job on the helper, with two abandoned tasks planted BEFORE it: one from another
 *  conversation, one from the SAME conversation as the job. Three real parks over 30 minutes. */
async function longJobWithTwoAbandoned(now: number): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] });
  claimedTask('task-other-conv', 'the forgotten report', now - 120 * MIN, 'c-old');
  claimedTask('task-same-conv', 'the half-done spreadsheet', now - 100 * MIN, 'c-job');
  seedTrackerTask(db(), {
    id: 'task-live', agentId: 'helper', status: 'in_progress', title: 'the long research job',
    opened_at: now - 40 * MIN, updated_at: now - 40 * MIN, origin_conv_key: 'c-job',
    source_message_id: 'msg-ask', priority: 'normal',
  } as never);
  parkedTurn(41, now - 30 * MIN, 'msg-ask'); // the owner's ask: the turn whose trigger names the job
  parkedTurn(42, now - 15 * MIN, null);     // continuations: the engine's self-wake
  parkedTurn(43, now - MIN, null);
  vi.setSystemTime(now);
}

describe('ROUND 2 (2+3): freshness is refreshed only by activity that names the task', () => {
  it('the close-out gate names BOTH abandoned tasks (another conversation, the same conversation) and never the job in flight', async () => {
    await longJobWithTwoAbandoned(Date.now());
    const named = await gateNames();
    expect(named).toContain('task-other-conv');
    expect(named).toContain('task-same-conv');
    expect(named).not.toContain('task-live');
  });

  it('the PM re-drives an abandoned task from the SAME conversation as the long job; the job in flight gets no check-in', async () => {
    await longJobWithTwoAbandoned(Date.now());
    await runPokeCheck();
    expect(pokes('task-same-conv')).toBeGreaterThan(0);
    expect(pokes('task-other-conv')).toBeGreaterThan(0);
    expect(pokes('task-live')).toBe(0);
    expect(ownerTexts()).toBe(0);
  });

  it('the timestamp itself: a park moves the job\'s own row and no other', async () => {
    const now = Date.now();
    await longJobWithTwoAbandoned(now);
    const at = (id: string): number => (db().prepare('SELECT updated_at AS u FROM work WHERE id = ?').get(id) as { u: number }).u;
    expect(at('task-live')).toBe(now - MIN);
    expect(at('task-other-conv')).toBe(now - 120 * MIN);
    expect(at('task-same-conv')).toBe(now - 100 * MIN);
  });
});

describe('ROUND 2 (1): the platform notice never depends on the project manager existing', () => {
  it('with the PM switched off, the scheduler\'s own tick tells the owner about a wedged agent, once', async () => {
    db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('pm_agent_enabled', 'false')").run();
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

describe('ROUND 2 (4): "your pause was lifted" wakes the agent and asks for no reply', () => {
  it('a PM-rejected pause re-drives the agent through a notice that names the task, with no reply owed to the PM', async () => {
    claimedTask('task-paused', 'the price check', Date.now() - 30 * MIN, 'c-1');
    db().prepare("UPDATE work SET state = 'paused' WHERE id = 'task-paused'").run();
    const out = await trackerValidatePause('pm', { task_id: 'task-paused', valid: false, reject_reason: 'no specific wait condition was named' });
    expect(out).not.toMatch(/^Error/);
    // No A2A that owes the PM a reply …
    expect(a2a.filter((m) => m.toAgent === 'helper' && (m as { requiresResponse?: boolean }).requiresResponse)).toHaveLength(0);
    // … and the notice the agent gets names the task as a column (its next turn serves that task).
    const row = db().prepare("SELECT task_id, lane, content FROM messages WHERE agent_id = 'helper' AND content LIKE '%was lifted%'")
      .get() as { task_id: string; lane: string; content: string } | undefined;
    expect(row?.task_id).toBe('task-paused');
    expect(row?.lane).toBe('events');
  });
});
