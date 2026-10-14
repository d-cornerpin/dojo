// ════════════════════════════════════════════════════════════════════════════════════════
// t151 — THE PM LADDER COUNTS ONLY WHAT REALLY HAPPENED (fixes A, B, D of the t143 live walks).
//
// A (walk items 3 and 10). A task waiting behind its agent's own running job is not chased while the
// agent is working (kept). When the job ends, that task's ladder starts at its FIRST rung: the
// time spent behind the job never counts toward a later one. At 4cb9ed61's successor the idle clock
// was the task's age alone, so the first sweep after a 35-minute job found 35 idle minutes and sent
// the escalation to the primary, "after 2 pokes", with none on the record. The text is derived from
// the task's own record now.
//
// B (item 17). A reply to a check-in is an answer, not progress: a woken turn that only talked
// (no effectful call, no tangible delivery) does not stamp the task, so it does not re-arm. Real
// work (an effectful call, a deliverable) does. A bare note is a record, not progress.
//
// D. `work_update status=in_progress notes=...` on a task already in_progress records the note
// (it used to answer NO-OP and drop it); the note is a record, not progress.
//
// Every clause drives the real doors: the project manager's own sweep (`runPokeCheck`), the
// engine's turn-finalize stamper, the real tracker tools. Only the phone, the socket, the A2A
// transport and the engine runtime are replaced. Nothing here measures wall-clock time.
// ════════════════════════════════════════════════════════════════════════════════════════

// RED-FIRST at 50b921db: committed `it.fails` (RED commit), flipped with the fixes.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-t151-ladder');

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t151-ladder');
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t151-ladder', 'dojo.db'),
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
function claimedTask(id: string, title: string, atMs: number, convKey: string): void {
  seedTrackerTask(db(), {
    id, agentId: 'helper', status: 'in_progress', title,
    opened_at: atMs, updated_at: atMs, origin_conv_key: convKey, priority: 'normal',
  } as never);
}

function modelCallFinished(atMs: number): void {
  db().prepare(`INSERT INTO cost_records (id, agent_id, model_id, provider_id, input_tokens, output_tokens, cost_usd, created_at)
                VALUES (?, 'helper', 'm-a', 'prov-a', 12000, 300, 0.01, ?)`).run(`cr-${atMs}`, sqlTime(atMs));
}

/** One engine turn of the long job: the two records a 15-minute park leaves. */
function parkedTurn(turnNumber: number, at: number, askMessageId: string | null): void {
  vi.setSystemTime(at);
  if (askMessageId === null) beginJobRun('helper', 'timer');
  const tc = openTurnContext('helper');
  tc.turnNumber = turnNumber;
  tc.root = askMessageId ? { kind: 'ask', id: askMessageId, sourceMessageId: askMessageId } : null;
  db().prepare(`INSERT INTO turns (agent_id, turn_number, started_at, ended_at, exit_reason, answered)
                VALUES ('helper', ?, ?, ?, 'budget', 0)`).run(turnNumber, sqlTime(at - 15 * MIN), sqlTime(at));
  modelCallFinished(at);
  noteEngineCheckpoint('helper', 'turn-budget');
  registerTimerWake('helper');
  stampTasksAtTurnFinalize({
    agentId: 'helper', turnNumber, outcome: 'budget', answerMessageId: null,
    rootSourceMessageId: askMessageId, convKey: 'c-job', servedTaskId: null,
  });
  endTurnContext('helper');
  endJobRun('helper');
}

const setStatus = (s: string): void => { db().prepare("UPDATE agents SET status = ? WHERE id = 'helper'").run(s); };

describe('A — the ladder starts at its first rung when the agent\'s own job ends (walk items 3 and 10)', () => {
  /** A 50-minute job that parks three times while the agent stays `working` the whole while;
   *  two abandoned tasks planted at the start (another conversation / the job's own). Returns the
   *  instant the job ends. The PM sweeps every five minutes throughout. */
  async function fiftyMinuteJob(t0: number): Promise<number> {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    claimedTask('x-other', 'the forgotten report', t0, 'c-old');
    claimedTask('x-same', 'the half-done spreadsheet', t0, 'c-job');
    seedTrackerTask(db(), {
      id: 'task-live', agentId: 'helper', status: 'in_progress', title: 'the long research job',
      opened_at: t0, updated_at: t0, origin_conv_key: 'c-job', source_message_id: 'msg-ask', priority: 'normal',
    } as never);
    setStatus('working');
    parkedTurn(41, t0 + 16 * MIN, 'msg-ask');
    parkedTurn(43, t0 + 32 * MIN, null);
    parkedTurn(44, t0 + 48 * MIN, null);
    for (let m = 1; m <= 49; m += 3) await sweepAt(t0 + m * MIN);
    return t0 + 50 * MIN;
  }
  const endJob = (at: number): void => {
    vi.setSystemTime(at);
    db().prepare("UPDATE work SET state = 'abandoned', closed_at = ? WHERE id = 'task-live'").run(at);
    setStatus('idle');
  };

  it('while the job runs nobody is chased; when it ends the first sweep sends nothing and the ladder climbs from rung 1 (not a jump to the top)', async () => {
    const t0 = Date.now();
    const end = await fiftyMinuteJob(t0);
    expect(pokes('x-other') + pokes('x-same'), 'during the job').toBe(0);   // kept: no PM chase while the agent is working
    endJob(end);
    await sweepAt(end + 20_000);                          // the first sweep after the job
    expect(pokes('x-other') + pokes('x-same'), 'first sweep after the job').toBe(0);   // time behind the job counts toward nothing
    await sweepAt(end + 6 * MIN);                         // past the first rung's own idle
    expect(rungsSent('x-other')).toEqual([1]);
    expect(rungsSent('x-same')).toEqual([1]);
    await sweepAt(end + 16 * MIN);
    expect(rungsSent('x-other')).toEqual([1, 2]);
    await sweepAt(end + 31 * MIN);
    expect(rungsSent('x-other')).toEqual([1, 2, 3]);
    // the long stretch is on the task's own record, once; the job's own task (never idle) has none
    const resumed = (id: string): number => (db().prepare(
      "SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = 'audit' AND json_extract(payload, '$.entry_kind') = 'ladder_resumed'",
    ).get(id) as { n: number }).n;
    expect(resumed('x-other')).toBe(1);
  });

  it('a short busy stretch (shorter than the first rung) writes nothing: it is ordinary idleness', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    claimedTask('x-short', 'the price check', now, 'c-1');
    setStatus('working');
    await sweepAt(now + MIN);
    setStatus('idle');
    await sweepAt(now + 2 * MIN);
    expect((db().prepare("SELECT COUNT(*) AS n FROM work_events WHERE work_id = 'x-short' AND kind = 'audit'").get() as { n: number }).n).toBe(0);
  });

  it('the escalation to the primary says only what happened: after rungs 1 and 2 it says two earlier check-ins', async () => {
    const t0 = Date.now();
    const end = await fiftyMinuteJob(t0);
    endJob(end);
    await sweepAt(end + 20_000);   // the first sweep after the job (the PM sweeps every minute)
    for (const m of [6, 16, 31]) await sweepAt(end + m * MIN);
    const escalation = (db().prepare("SELECT content FROM messages WHERE lane = 'events' AND content LIKE 'ESCALATION%' ORDER BY rowid").all() as Array<{ content: string }>)
      .map((r) => r.content).find((c) => c.includes('the forgotten report')) ?? '';
    expect(escalation).toContain('ESCALATION');
    expect(escalation).toMatch(/after 2 earlier check-ins/);
  });

  it('a first sweep that finds a task far overdue (no pokes on record) does not claim any: the text states the true count', async () => {
    const now = Date.now();
    claimedTask('task-late', 'the price check', now - 31 * MIN, 'c-1');
    await runPokeCheck();
    await new Promise((r) => setTimeout(r, 15));
    const all = (db().prepare("SELECT content FROM messages WHERE lane = 'events' AND content LIKE 'ESCALATION%'").all() as Array<{ content: string }>).map((r) => r.content).join('\n');
    expect(all).toContain('ESCALATION');
    expect(all).not.toMatch(/after \d+ pokes/);
    expect(all).toMatch(/no earlier check-in has been sent/);
  });

  it('t154: rung 2 reached as the first check-in (restart, circling verdict) is not labelled "Second"', async () => {
    const now = Date.now();
    claimedTask('task-mid', 'the price check', now - 20 * MIN, 'c-1');
    await runPokeCheck();
    await new Promise((r) => setTimeout(r, 15));
    const all = (db().prepare("SELECT content FROM messages WHERE lane = 'events' AND content LIKE '%the price check%'").all() as Array<{ content: string }>).map((r) => r.content).join('\n');
    expect(rungsSent('task-mid')).toEqual([2]);
    expect(all).toMatch(/^Check-in: task "the price check"/m);
    expect(all).not.toMatch(/Second check-in/);
  });
});

describe('B — a reply to a check-in is an answer, not progress; real work re-arms (walk item 17)', () => {
  /** The check-in is sent; the woken turn runs. `effectful` calls, and optionally a delivered file. */
  async function wokenTurn(opts: { reply: boolean; effectful: number; file?: boolean }): Promise<{ now: number }> {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    claimedTask('task-c', 'the price check', now - 6 * MIN, 'c-1');
    await sweepAt(now);                                       // idle 6 min: rung 1
    expect(rungsSent('task-c')).toEqual([1]);
    vi.setSystemTime(now + MIN);
    db().prepare("UPDATE messages SET served_by_turn = 50 WHERE agent_id = 'helper' AND lane = 'events' AND task_id = 'task-c'").run();
    const tc = openTurnContext('helper');
    tc.turnNumber = 50;
    tc.root = { kind: 'engine', id: 'redrive', sourceMessageId: null };
    tc.servedWork = { taskId: 'task-c', runId: null, taskKind: 'task', originConvKey: null };
    db().prepare(`INSERT INTO turns (agent_id, turn_number, started_at, ended_at, exit_reason, answered, effectful_calls)
                  VALUES ('helper', 50, ?, ?, 'answered', 1, ?)`).run(sqlTime(now), sqlTime(now + MIN), opts.effectful);
    if (opts.reply) {
      db().prepare(`INSERT INTO messages (id, agent_id, role, content, turn_number, created_at)
                    VALUES ('reply-50', 'helper', 'assistant', 'still thinking', 50, ?)`).run(now + MIN);
      db().prepare(`INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, outcome, message_id, created_at)
                    VALUES ('dl-50', 'helper', 50, 'dashboard', 'dashboard', 'delivered', 'reply-50', datetime('now'))`).run();
    }
    if (opts.file) {
      db().prepare("INSERT INTO turn_artifacts (id, agent_id, turn_number, kind, path, delivered_at) VALUES ('art-50', 'helper', 50, 'file', '/tmp/prices.md', ?)").run(sqlTime(now + MIN));
    }
    stampTasksAtTurnFinalize({
      agentId: 'helper', turnNumber: 50, outcome: 'answered', answerMessageId: null,
      rootSourceMessageId: null, convKey: null, servedTaskId: 'task-c',
    });
    endTurnContext('helper');
    return { now };
  }

  it('a one-line reply (no effectful call, no deliverable) does not re-arm: no remediation, the next rung is 2, never rung 1 again', async () => {
    const { now } = await wokenTurn({ reply: true, effectful: 0 });
    await sweepAt(now + 2 * MIN);
    expect(remediations('task-c')).toBe(0);
    await sweepAt(now + 10 * MIN);          // the task has now been idle since before the first check-in: urgent
    expect(rungsSent('task-c')).toEqual([1, 2]);
  });

  it('CONTROL: the same woken turn that made an effectful call is real work and re-arms the ladder', async () => {
    const { now } = await wokenTurn({ reply: true, effectful: 1 });
    await sweepAt(now + 2 * MIN);
    expect(remediations('task-c')).toBe(1);
  });

  it('CONTROL: a delivered file is a deliverable and re-arms the ladder', async () => {
    const { now } = await wokenTurn({ reply: true, effectful: 0, file: true });
    await sweepAt(now + 2 * MIN);
    expect(remediations('task-c')).toBe(1);
  });

  it('a bare note is a record, not progress: it does not re-arm either', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    claimedTask('task-n', 'the price check', now - 6 * MIN, 'c-1');
    await sweepAt(now);
    vi.setSystemTime(now + MIN);
    expect(trackerAddNotes('helper', { taskId: 'task-n', notes: 'still working on it' })).toContain('[OK]');
    await sweepAt(now + 2 * MIN);
    expect(remediations('task-n')).toBe(0);
    await sweepAt(now + 10 * MIN);
    expect(rungsSent('task-n')).toEqual([1, 2]);
  });

  it('CONTROL: a real change of the task (a status) re-arms', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    claimedTask('task-s', 'the price check', now - 6 * MIN, 'c-1');
    await sweepAt(now);
    vi.setSystemTime(now + MIN);
    expect(trackerUpdateStatus('helper', { taskId: 'task-s', status: 'blocked', notes: 'waiting on the supplier' })).toContain('[OK]');
    vi.setSystemTime(now + 2 * MIN);
    db().prepare("UPDATE work SET state = 'claimed' WHERE id = 'task-s'").run();   // unblocked again
    db().prepare("UPDATE work SET updated_at = ? WHERE id = 'task-s'").run(now + 2 * MIN);
    await sweepAt(now + 3 * MIN);
    expect(remediations('task-s')).toBe(1);
  });
});

describe('D — a note on a task already at that status is recorded (walk "other observations")', () => {
  const notes = (taskId: string): string[] => readAuditTrail(taskId, { limit: 20 })
    .filter((r) => r.entry_kind === 'observation').map((r) => String(r.note));

  it('work_update status=in_progress notes=... on an in_progress task records the note and says so', () => {
    claimedTask('task-d', 'the price check', Date.now() - 6 * MIN, 'c-1');
    const out = trackerUpdateStatus('helper', { taskId: 'task-d', status: 'in_progress', notes: 'supplier answered, prices coming' });
    expect(out).toContain('no change made');
    expect(out).toMatch(/note was recorded/i);
    expect(notes('task-d')).toContain('supplier answered, prices coming');
  });

  it('CONTROL: the same status with no note is still the plain NO-OP and records nothing', () => {
    claimedTask('task-d2', 'the price check', Date.now() - 6 * MIN, 'c-1');
    const out = trackerUpdateStatus('helper', { taskId: 'task-d2', status: 'in_progress' });
    expect(out).toContain('[NO-OP]');
    expect(notes('task-d2')).toEqual([]);
  });

  it('GUARD: and that note is a record, not progress: it does not re-arm the ladder (walk item 17 / ruling B)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    claimedTask('task-d3', 'the price check', now - 6 * MIN, 'c-1');
    await sweepAt(now);
    vi.setSystemTime(now + MIN);
    trackerUpdateStatus('helper', { taskId: 'task-d3', status: 'in_progress', notes: 'still working' });
    await sweepAt(now + 2 * MIN);
    expect(remediations('task-d3')).toBe(0);
  });
});
