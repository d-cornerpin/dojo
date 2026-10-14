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
import { registerAbortable, releaseAbortable, activeRuns } from '../../agent/shared-state.js';
import { configRouter } from '../../gateway/routes/config.js';
import { trackerAddNotes } from '../tools.js';
import { recordPoke, currentRung } from '../../work/poke-ladder.js';
import { noteEngineCheckpoint } from '../../work/engine-checkpoint-note.js';
import { endJobCarry, registerTimerWake, beginJobRun, endJobRun } from '../../work/task-freshness.js';
import { injectTaskAssignmentNotification } from '../notify.js';
import { stampTasksAtTurnFinalize } from '../task-stamps.js';
import { agentsRouter } from '../../gateway/routes/agents.js';
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
import { trackerValidatePause, trackerRetask } from '../tools.js';

/** One engine turn of the long job: a turn context like the engine's own, then the two records a
 *  15-minute park leaves (the checkpoint and the turn-finalize stamp), then the turn ends. The
 *  first turn's trigger is the owner's ask; a continuation's trigger is the engine's self-wake. */
function parkedTurn(turnNumber: number, at: number, askMessageId: string | null): void {
  vi.setSystemTime(at);
  if (askMessageId === null) beginJobRun('helper', 'timer'); // the park's own wake fires: this run carries the job
  const tc = openTurnContext('helper');
  tc.turnNumber = turnNumber;
  tc.root = askMessageId ? { kind: 'ask', id: askMessageId, sourceMessageId: askMessageId } : null;
  db().prepare(`INSERT INTO turns (agent_id, turn_number, started_at, ended_at, exit_reason, answered)
                VALUES ('helper', ?, ?, ?, 'budget', 0)`).run(turnNumber, sqlTime(at - 15 * MIN), sqlTime(at));
  modelCallFinished(at);
  noteEngineCheckpoint('helper', 'turn-budget');
  registerTimerWake('helper');   // the park's continuation, armed on its own timer
  stampTasksAtTurnFinalize({
    agentId: 'helper', turnNumber, outcome: 'budget', answerMessageId: null,
    rootSourceMessageId: askMessageId, convKey: 'c-job', servedTaskId: null,
  });
  endTurnContext('helper');
  endJobRun('helper'); // the carrying run ends; a further park registered its own wake
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

/** An unrelated owner message takes a turn mid-job: its own trigger, no park, then it ends. */
function ownerTurn(turnNumber: number, at: number, askMessageId: string): void {
  vi.setSystemTime(at);
  const tc = openTurnContext('helper');
  tc.turnNumber = turnNumber;
  tc.root = { kind: 'ask', id: askMessageId, sourceMessageId: askMessageId };
  db().prepare(`INSERT INTO turns (agent_id, turn_number, started_at, ended_at, exit_reason, answered)
                VALUES ('helper', ?, ?, ?, 'answered', 1)`).run(turnNumber, sqlTime(at - MIN), sqlTime(at));
  modelCallFinished(at);
  stampTasksAtTurnFinalize({
    agentId: 'helper', turnNumber, outcome: 'answered', answerMessageId: null,
    rootSourceMessageId: askMessageId, convKey: 'c-job', servedTaskId: null,
  });
  endTurnContext('helper');
}

/** The long job on the helper, with two abandoned tasks planted BEFORE it: one from another
 *  conversation, one from the SAME conversation as the job. The job parks, the owner sends an
 *  UNRELATED message mid-job (it takes the next turn), then the job's continuations park twice
 *  more (the review's exact shape, C1). */
async function longJobWithTwoAbandoned(now: number): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] });
  claimedTask('task-other-conv', 'the forgotten report', now - 120 * MIN, 'c-old');
  claimedTask('task-same-conv', 'the half-done spreadsheet', now - 100 * MIN, 'c-job');
  seedTrackerTask(db(), {
    id: 'task-live', agentId: 'helper', status: 'in_progress', title: 'the long research job',
    opened_at: now - 60 * MIN, updated_at: now - 60 * MIN, origin_conv_key: 'c-job',
    source_message_id: 'msg-ask', priority: 'normal',
  } as never);
  parkedTurn(41, now - 45 * MIN, 'msg-ask'); // the owner's ask: the turn whose trigger names the job
  ownerTurn(42, now - 35 * MIN, 'msg-unrelated'); // an unrelated owner message takes the next turn
  parkedTurn(43, now - 25 * MIN, null);     // continuations: the engine's self-wake
  parkedTurn(44, now - 12 * MIN, null);
  parkedTurn(45, now - MIN, null);
  vi.setSystemTime(now);
}

/** The job is over (its task closed) and the agent goes quiet past its window. */
function jobEndsAndAgentGoesQuiet(now: number): void {
  db().prepare("UPDATE work SET state = 'abandoned', closed_at = 1791936612000 WHERE id = 'task-live'").run();
  vi.setSystemTime(now + 3 * 60 * MIN);
}

describe('ROUND 2 (2+3) + ROUND 3 (C1): freshness is refreshed only by activity that names the task; a moving agent is left alone', () => {
  it('while the job runs (long job, an unrelated owner message, two more parks): the job is never refused or poked and stays open; the abandoned others are still named and re-driven', async () => {
    await longJobWithTwoAbandoned(Date.now());
    const named = await gateNames();
    expect(named).toEqual(expect.arrayContaining(['task-other-conv', 'task-same-conv']));
    expect(named).not.toContain('task-live');
    await runPokeCheck();
    expect(pokes('task-live')).toBe(0);
    expect(pokes('task-other-conv')).toBeGreaterThan(0);
    expect(pokes('task-same-conv')).toBeGreaterThan(0);
    expect((db().prepare("SELECT state FROM work WHERE id = 'task-live'").get() as { state: string }).state).toBe('claimed');
    expect(ownerTexts()).toBe(0);
  });

  it('AFTER the job stops, the close-out gate names BOTH abandoned tasks (another conversation, the same conversation)', async () => {
    const now = Date.now();
    await longJobWithTwoAbandoned(now);
    jobEndsAndAgentGoesQuiet(now);
    const named = await gateNames();
    expect(named).toContain('task-other-conv');
    expect(named).toContain('task-same-conv');
    expect(named).not.toContain('task-live');
  });

  it('AFTER the job stops, the PM re-drives an abandoned task from the SAME conversation as the long job', async () => {
    const now = Date.now();
    await longJobWithTwoAbandoned(now);
    jobEndsAndAgentGoesQuiet(now);
    await runPokeCheck();
    expect(pokes('task-same-conv')).toBeGreaterThan(0);
    expect(pokes('task-other-conv')).toBeGreaterThan(0);
    expect(pokes('task-live')).toBe(0);
  });

  it('the timestamp itself: the job survives an unrelated message mid-job (every park moves the job\'s own row) and no other row', async () => {
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

describe('ROUND 3 (I2): a check-in owes no reply — nothing waits, nothing escalates for a missing one', () => {
  const eventsToHelper = (): Array<{ task_id: string | null; content: string; a2a_requires_response: number | null }> =>
    db().prepare("SELECT task_id, content, a2a_requires_response FROM messages WHERE agent_id = 'helper' AND lane = 'events'")
      .all() as never;

  it('a PM check-in on a quiet, idle assignee wakes it through an events-lane notice that names the task; no A2A owes the PM a reply', async () => {
    claimedTask('task-quiet', 'the price check', Date.now() - 3 * 60 * MIN, 'c-1');
    await runPokeCheck();
    await new Promise((r) => setTimeout(r, 20));
    expect(pokes('task-quiet')).toBeGreaterThan(0);
    expect(a2a.filter((m) => (m as { requiresResponse?: boolean }).requiresResponse)).toHaveLength(0);
    const row = eventsToHelper().find((r) => r.content.includes('the price check'));
    expect(row?.task_id).toBe('task-quiet');
    expect(row?.a2a_requires_response ?? 0).toBe(0);
  });

  it('the retask directive is delivered the same way: a notice naming the task, no reply owed', async () => {
    claimedTask('task-redo', 'the price check', Date.now() - 30 * MIN, 'c-1');
    const out = await trackerRetask('pm', { task_id: 'task-redo', directive: 'The brief went to chat but the task says email; send it by email with the same content.' });
    expect(out).not.toMatch(/^Error/);
    expect(a2a.filter((m) => (m as { requiresResponse?: boolean }).requiresResponse)).toHaveLength(0);
    expect(eventsToHelper().find((r) => r.content.includes('send it by email'))?.task_id).toBe('task-redo');
  });
});

describe('ROUND 4 (C1): "moving" is no blanket shield — only the job in flight, or an agent live right now, is left alone', () => {
  /** The agent said "on it" a minute ago and left the task claimed; nothing is live. */
  function saidOnItAndLeft(): void {
    const now = Date.now();
    claimedTask('task-onit', 'the price check', now - 30 * MIN, 'c-1');
    db().prepare(`INSERT INTO messages (id, agent_id, role, content, turn_number, created_at)
                  VALUES ('asst-onit', 'helper', 'assistant', 'On it - I will have the prices shortly.', 9, ?)`).run(now - MIN);
    modelCallFinished(now - MIN);
  }

  it('the "on it" + claimed-and-left task is named by the close-out gate and nudged by the PM on schedule, however recently the agent spoke', async () => {
    saidOnItAndLeft();
    await runPokeCheck();
    expect(pokes('task-onit')).toBeGreaterThan(0);
    expect(await gateNames()).toContain('task-onit');
  });

  it('an agent with a turn live RIGHT NOW (the live-run registry) is not poked; the same agent the moment it is not live, is', async () => {
    saidOnItAndLeft();
    activeRuns.add('helper');
    try {
      await runPokeCheck();
      expect(pokes('task-onit')).toBe(0);
    } finally {
      activeRuns.delete('helper');
    }
    await runPokeCheck();
    expect(pokes('task-onit')).toBeGreaterThan(0);
  });

  it('a model request open on a live connection right now is not poked either', async () => {
    saidOnItAndLeft();
    const open = new AbortController();
    expect(registerAbortable('helper', open)).toBe(true);
    try {
      await runPokeCheck();
      expect(pokes('task-onit')).toBe(0);
    } finally {
      releaseAbortable('helper', open);
    }
  });
});

describe('ROUND 4 (I1): a turn woken by a PM re-drive is not, by being woken, progress on the task', () => {
  it('a woken turn that does nothing leaves the ladder to advance to rung 3', async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    claimedTask('task-lazy', 'the price check', now - 20 * MIN, 'c-1');
    await runPokeCheck();                       // idle 20 min: the urgent rung (2)
    await new Promise((r) => setTimeout(r, 20));
    expect(currentRung('task-lazy')).toBe(2);
    // The woken turn: the engine serves the re-drive's event row (naming the task), the agent
    // writes a line and ends its turn. It touched nothing on the task.
    vi.setSystemTime(now + MIN);
    db().prepare("UPDATE messages SET served_by_turn = 50 WHERE agent_id = 'helper' AND lane = 'events' AND task_id = 'task-lazy'").run();
    const tc = openTurnContext('helper');
    tc.turnNumber = 50;
    tc.root = { kind: 'engine', id: 'redrive', sourceMessageId: null };
    tc.servedWork = { taskId: 'task-lazy', runId: null, taskKind: 'task', originConvKey: null };
    db().prepare(`INSERT INTO turns (agent_id, turn_number, started_at, ended_at, exit_reason, answered)
                  VALUES ('helper', 50, ?, ?, 'answered', 1)`).run(sqlTime(now), sqlTime(now + MIN));
    stampTasksAtTurnFinalize({
      agentId: 'helper', turnNumber: 50, outcome: 'answered', answerMessageId: null,
      rootSourceMessageId: null, convKey: null, servedTaskId: 'task-lazy',
    });
    endTurnContext('helper');
    vi.setSystemTime(now + 11 * MIN);           // 31 minutes idle in all
    await runPokeCheck();
    expect(currentRung('task-lazy')).toBe(3);
  });
});

describe('ROUND 4 (minors): a failed re-drive is not dropped; a crash-left turn row is not a live agent', () => {
  const blockEvents = (): void => {
    db().exec("CREATE TRIGGER block_events BEFORE INSERT ON messages WHEN NEW.lane = 'events' BEGIN SELECT RAISE(ABORT, 'disk said no'); END");
  };

  it('a poke whose re-drive could not be written is not recorded: the next sweep tries it again', async () => {
    claimedTask('task-retry', 'the price check', Date.now() - 30 * MIN, 'c-1');
    blockEvents();
    await runPokeCheck();
    expect(pokes('task-retry')).toBe(0);
    db().exec('DROP TRIGGER block_events');
    await runPokeCheck();
    expect(pokes('task-retry')).toBeGreaterThan(0);
  });

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
    const { sweepSilentAgents } = await import('../liveness.js');
    sweepSilentAgents();
    expect(ownerTexts()).toBe(0);
  });
});

describe('ROUND 5 (R4-C1): the job carry has no clock — only its tasks closing, or the chain ending cleanly, ends it', () => {
  it('a continuation holding one call/tool longer than 20 minutes keeps the carry: the next park still touches the job, no refusal, no poke, no strike', async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    seedTrackerTask(db(), {
      id: 'task-live', agentId: 'helper', status: 'in_progress', title: 'the long research job',
      opened_at: now - 60 * MIN, updated_at: now - 60 * MIN, origin_conv_key: 'c-job',
      source_message_id: 'msg-ask', priority: 'normal',
    } as never);
    parkedTurn(41, now - 45 * MIN, 'msg-ask');   // park at t0
    parkedTurn(42, now - 14 * MIN, null);        // the continuation ran ONE call for 31 minutes, then parked
    const at = (db().prepare("SELECT updated_at AS u FROM work WHERE id = 'task-live'").get() as { u: number }).u;
    expect(at, 'the second park still knows the job').toBe(now - 14 * MIN);
    vi.setSystemTime(now);                       // 14 minutes later, between continuations
    expect(await gateNames()).toEqual([]);
    await runPokeCheck();
    expect(pokes('task-live')).toBe(0);
    expect((db().prepare("SELECT state FROM work WHERE id = 'task-live'").get() as { state: string }).state).toBe('claimed');
  });

  it('a clean end of the chain (a continuation that parks no further) ends the carry; the task is then judged like any other', async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    seedTrackerTask(db(), {
      id: 'task-live', agentId: 'helper', status: 'in_progress', title: 'the long research job',
      opened_at: now - 90 * MIN, updated_at: now - 90 * MIN, origin_conv_key: 'c-job',
      source_message_id: 'msg-ask', priority: 'normal',
    } as never);
    parkedTurn(41, now - 60 * MIN, 'msg-ask');
    // the continuation finishes its work without parking again, leaving the task claimed
    vi.setSystemTime(now - 50 * MIN);
    beginJobRun('helper', 'timer');
    const tc = openTurnContext('helper');
    tc.turnNumber = 42;
    endTurnContext('helper');
    endJobRun('helper');
    vi.setSystemTime(now);
    expect(await gateNames()).toContain('task-live');
  });

  it('a scheduler wake (not the park\'s launch) cannot consume the carry', async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    seedTrackerTask(db(), {
      id: 'task-live', agentId: 'helper', status: 'in_progress', title: 'the long research job',
      opened_at: now - 60 * MIN, updated_at: now - 60 * MIN, origin_conv_key: 'c-job',
      source_message_id: 'msg-ask', priority: 'normal',
    } as never);
    parkedTurn(41, now - 20 * MIN, 'msg-ask');
    const tc = openTurnContext('helper');        // an unrelated wake: nobody launched a continuation for it
    tc.turnNumber = 42;
    endTurnContext('helper');
    parkedTurn(43, now - 5 * MIN, null);         // the real continuation still carries the job
    expect((db().prepare("SELECT updated_at AS u FROM work WHERE id = 'task-live'").get() as { u: number }).u).toBe(now - 5 * MIN);
  });
});

describe('ROUND 5 (R4-C2): a job that starts from a tracker notice is carried', () => {
  it('a sub-agent assigned a task by a REAL assignment notice, working it across parks, is left alone by the gate and the PM, and the woken first turn is still not progress', async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    seedTrackerTask(db(), {
      id: 'task-assigned', agentId: 'helper', status: 'in_progress', title: 'the vendor audit',
      opened_at: now - 70 * MIN, updated_at: now - 70 * MIN, origin_conv_key: null, priority: 'normal',
    } as never);
    vi.setSystemTime(now - 60 * MIN);
    const res = injectTaskAssignmentNotification({ assignedAgentId: 'helper', creatorAgentId: 'pm', taskId: 'task-assigned', title: 'the vendor audit', description: 'audit them', projectId: null, priority: 'normal' } as never);
    expect(res.ok).toBe(true);
    // The engine serves the notice row to the helper's first turn (naming the task), which parks.
    db().prepare("UPDATE messages SET served_by_turn = 60 WHERE agent_id = 'helper' AND lane = 'events' AND task_id = 'task-assigned'").run();
    const tc = openTurnContext('helper');
    tc.turnNumber = 60;
    tc.root = { kind: 'engine', id: 'assign', sourceMessageId: null };
    tc.servedWork = { taskId: 'task-assigned', runId: null, taskKind: 'task', originConvKey: null };
    db().prepare(`INSERT INTO turns (agent_id, turn_number, started_at, ended_at, exit_reason, answered)
                  VALUES ('helper', 60, ?, ?, 'budget', 0)`).run(sqlTime(now - 75 * MIN), sqlTime(now - 60 * MIN));
    modelCallFinished(now - 60 * MIN);
    noteEngineCheckpoint('helper', 'turn-budget');
    registerTimerWake('helper');
    stampTasksAtTurnFinalize({ agentId: 'helper', turnNumber: 60, outcome: 'budget', answerMessageId: null, rootSourceMessageId: null, convKey: null, servedTaskId: 'task-assigned' });
    endTurnContext('helper');
    expect(db().prepare("SELECT COUNT(*) AS n FROM work_events WHERE work_id = 'task-assigned' AND kind = 'activity'").get())
      .toEqual({ n: 0 });                          // being woken by the notice is not progress ...
    parkedTurn(61, now - 40 * MIN, null);          // ... but its job runs on through the continuations
    parkedTurn(62, now - 8 * MIN, null);
    vi.setSystemTime(now);
    expect(await gateNames()).toEqual([]);
    await runPokeCheck();
    expect(pokes('task-assigned')).toBe(0);
  });
});

describe('ROUND 5 (minor): the no-primary rung-3 re-drive is addressed to the assignee', () => {
  const textsToHelper = (): string[] =>
    (db().prepare("SELECT content FROM messages WHERE agent_id = 'helper' AND lane = 'events'").all() as Array<{ content: string }>).map((r) => r.content);

  it('with no primary on the box, rung 3 reads as a second-person check-in, not "ESCALATION ... for your awareness"', async () => {
    claimedTask('task-r3', 'the price check', Date.now() - 31 * MIN, 'c-1');
    recordPoke('task-r3', 'pm', 1, 'nudge', 'helper');
    recordPoke('task-r3', 'pm', 2, 'urgent', 'helper');
    await runPokeCheck();
    expect(currentRung('task-r3')).toBe(3);
    const t = textsToHelper().join('\n');
    expect(t).not.toContain('ESCALATION');
    expect(t).toMatch(/your|you /i);
  });

  it('a TERMINATED primary counts as no primary: the assignee is re-driven, nothing is sent to the dead one', async () => {
    db().prepare("INSERT INTO agents (id, name, status, model_id, classification) VALUES ('primary', 'Main', 'terminated', 'm-a', 'sensei')").run();
    claimedTask('task-r3b', 'the price check', Date.now() - 31 * MIN, 'c-1');
    recordPoke('task-r3b', 'pm', 1, 'nudge', 'helper');
    recordPoke('task-r3b', 'pm', 2, 'urgent', 'helper');
    await runPokeCheck();
    expect(currentRung('task-r3b')).toBe(3);
    expect(textsToHelper().join('\n')).not.toContain('ESCALATION');
    expect((db().prepare("SELECT COUNT(*) AS n FROM messages WHERE agent_id = 'primary'").get() as { n: number }).n).toBe(0);
  });
});
