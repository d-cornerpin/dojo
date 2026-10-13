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

describe('SILENT: an agent with no movement at all, past its window, is reported to the owner once', () => {
  it('a wedged tool call (no stream, no tool finish) for 3 hours: ONE owner notice, naming the agent and its task', async () => {
    wedgedToolCall(3 * 60 * MIN);
    await runPokeCheck();
    expect(ownerTexts()).toBe(1);
    expect(sent()[0]).toContain('Helper');
    expect(sent()[0]).toContain('the quarterly numbers');
    // The same incident on the next sweep: still one.
    await runPokeCheck();
    expect(ownerTexts()).toBe(1);
  });

  it('the per-agent window, set to 10 minutes through the real agents route, is the one the sweep uses', async () => {
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
  it('an abandoned second task planted BEFORE the parks is still re-driven by the PM; the in-flight one is not', async () => {
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

const setWindow = async (minutes: number | null): Promise<void> => {
  const res = await agentsRouter.request('/helper', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ silentWindowMinutes: minutes }),
  });
  expect(res.status).toBe(200);
};
const silentNotice = (): string | null =>
  (db().prepare("SELECT silent_notice AS n FROM agents WHERE id = 'helper'").get() as { n: string | null }).n;
const ownerCardWords = async (): Promise<string[]> => {
  const res = await configRouter.request('/owner-notices');
  return ((await res.json()) as { data: Array<{ words: string }> }).data.map((c) => c.words);
};
const ends = (): string[] => broadcasts
  .filter((b) => b.type === 'chat:error' && b.agentId === 'platform' && b.severity === 'info').map((b) => String(b.error));

describe('GREEN: exactly once, and never for a working agent', () => {
  it('the 30-second status heartbeat is not movement: a wedged agent whose row the heartbeat keeps fresh is still told', async () => {
    wedgedToolCall(3 * 60 * MIN);
    db().prepare("UPDATE agents SET updated_at = datetime('now') WHERE id = 'helper'").run();
    await runPokeCheck();
    expect(ownerTexts()).toBe(1);
  });

  it('the notice is a lasting owner card in the same words, until the agent moves again (then it leaves every dashboard)', async () => {
    wedgedToolCall(3 * 60 * MIN);
    await runPokeCheck();
    expect(ownerTexts()).toBe(1);
    const words = JSON.parse(silentNotice()!).words as string;
    expect(await ownerCardWords()).toContain(words);
    // The tool comes back: real movement.
    db().prepare(`INSERT INTO messages (id, agent_id, role, content, turn_number, created_at)
                  VALUES ('tool-back', 'helper', 'tool', '[]', 7, ?)`).run(Date.now());
    await runPokeCheck();
    expect(silentNotice()).toBeNull();
    expect(ends()).toContain(words);
    expect(await ownerCardWords()).not.toContain(words);
    expect(ownerTexts()).toBe(1);
  });

  it('a slow-prefill request open on a live connection, past the bare window, yields ZERO notices', async () => {
    await setWindow(10);
    // A slow local box: the provider's measured prefill speed is 20 tokens/s, so a 30,000-token
    // prompt takes 25 minutes before its first token. The request opened 25 minutes ago.
    db().prepare('UPDATE providers SET measured_prefill_tokens_per_sec = 20 WHERE id = ?').run('prov-a');
    claimedTask('task-slow', 'the long local summary', Date.now() - 40 * MIN, 'c-1');
    turnOpen(3, Date.now() - 26 * MIN);
    modelCallFinished(Date.now() - 25 * MIN);
    db().prepare("UPDATE agents SET status = 'working' WHERE id = 'helper'").run();
    const open = new AbortController();
    expect(registerAbortable('helper', open)).toBe(true);
    try {
      await runPokeCheck();
      expect(ownerTexts()).toBe(0);
    } finally {
      releaseAbortable('helper', open);
    }
    // Its first token arrives and the call completes: still nothing to tell.
    modelCallFinished(Date.now());
    await runPokeCheck();
    expect(ownerTexts()).toBe(0);
  });

  it('a working long job (a park every 15 minutes for 3 hours) yields ZERO notices and ZERO check-ins on the task it is working', async () => {
    const start = Date.now() - 180 * MIN;
    vi.useFakeTimers({ toFake: ['Date'] });
    claimedTask('task-live', 'the long research job', start, 'c-job');
    for (let t = start + 15 * MIN, i = 0; t <= start + 180 * MIN; t += 15 * MIN, i++) {
      vi.setSystemTime(t);
      modelCallFinished(t);
      noteEngineCheckpoint('helper', 'turn-budget');
      stampTasksAtTurnFinalize({
        agentId: 'helper', turnNumber: 20 + i, outcome: 'budget', answerMessageId: null,
        rootSourceMessageId: null, convKey: 'c-job', servedTaskId: null,
      });
      await runPokeCheck();
    }
    expect(ownerTexts()).toBe(0);
    expect(pokes('task-live')).toBe(0);
  });
});

describe('BROKEN ends on healthy work the sweep can see', () => {
  it('a BROKEN incident ends (its card leaves) once the agent completes a model call again', async () => {
    const { noteNoticeOnce } = await import('../../agent/agent-owner-cards.js');
    expect(noteNoticeOnce('helper', 'broken_notice', 'Helper has stopped: the key stopped working.')).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    modelCallFinished(Date.now() + 1000);
    await runPokeCheck();
    expect((db().prepare("SELECT broken_notice AS n FROM agents WHERE id = 'helper'").get() as { n: string | null }).n).toBeNull();
    expect(ends()).toContain('Helper has stopped: the key stopped working.');
  });
});

describe('BACKWARDS LIFECYCLE', () => {
  it('the window changed mid-job: raised before the quiet reaches it, nothing; lowered past it, one notice; raised again, no second', async () => {
    wedgedToolCall(30 * MIN);
    await runPokeCheck();
    expect(ownerTexts()).toBe(0); // inside the 2-hour default
    await setWindow(20);
    await runPokeCheck();
    expect(ownerTexts()).toBe(1);
    await setWindow(600);
    await runPokeCheck();
    expect(ownerTexts()).toBe(1);
    await setWindow(null); // back to the default through the same door
    expect((db().prepare("SELECT silent_window_minutes AS m FROM agents WHERE id = 'helper'").get() as { m: number | null }).m).toBeNull();
  });

  it('the setting door refuses what it cannot honour, and changes nothing', async () => {
    for (const bad of [0, -5, 2.5, '60']) {
      const res = await agentsRouter.request('/helper', {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ silentWindowMinutes: bad }),
      });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((db().prepare("SELECT silent_window_minutes AS m FROM agents WHERE id = 'helper'").get() as { m: number | null }).m).toBeNull();
  });

  it('an agent the owner stopped while silent is not reported (his Stop is the answer)', async () => {
    wedgedToolCall(3 * 60 * MIN);
    // The owner pressed Stop a minute ago: the turn ended on it, the agent is idle, the task still claimed.
    db().prepare("UPDATE turns SET ended_at = ?, exit_reason = 'stop' WHERE agent_id = 'helper' AND turn_number = 7")
      .run(sqlTime(Date.now() - MIN));
    db().prepare("UPDATE agents SET status = 'idle' WHERE id = 'helper'").run();
    await runPokeCheck();
    expect(ownerTexts()).toBe(0);
  });

  it('an agent that recovers after the notice is not told about twice for the same incident', async () => {
    wedgedToolCall(3 * 60 * MIN);
    await runPokeCheck();
    expect(ownerTexts()).toBe(1);
    modelCallFinished(Date.now());
    await runPokeCheck();
    await runPokeCheck();
    expect(ownerTexts()).toBe(1);
    expect(silentNotice()).toBeNull();
  });

  it('the project manager agent offline (in error, no model to run): the platform notice still fires from the sweep', async () => {
    db().prepare("UPDATE agents SET status = 'error', model_id = NULL WHERE id = 'pm'").run();
    wedgedToolCall(3 * 60 * MIN);
    await runPokeCheck();
    expect(ownerTexts()).toBe(1);
  });
});

describe('SPINNING: the PM tells the owner, in its own voice, what repeats — once — and keeps re-driving', () => {
  it('a circling verdict yields ONE PM report naming the repeated step; a second verdict in the same episode yields none', async () => {
    claimedTask('task-circle', 'the inbox sweep', Date.now() - 60 * MIN, 'c-1');
    db().prepare("UPDATE work SET effort_calls = 200, effort_reviewed_calls = 0 WHERE id = 'task-circle'").run();
    for (let i = 0; i < 6; i++) toolStarted(Date.now() - (30 - i) * MIN, 'gmail_search', 4);
    toolStarted(Date.now() - 20 * MIN, 'file_read', 4);
    verdict.reply = JSON.stringify({ advancing: false, reason: 'It runs the same inbox search again and again and nothing new lands.', task_id: 'task-circle' });
    expect(queueEffortReviewIfNeeded('task-circle')).toBe(true);
    await runEffortReview('task-circle');
    const reports = (): Array<{ content: string }> => db().prepare(
      "SELECT content FROM messages WHERE agent_id = 'pm' AND role = 'assistant'",
    ).all() as Array<{ content: string }>;
    expect(reports()).toHaveLength(1);
    expect(reports()[0].content).toContain('Helper');
    expect(reports()[0].content).toContain('the inbox sweep');
    expect(reports()[0].content).toContain('gmail_search');
    expect(reports()[0].content).toContain('nothing new lands');
    // The PM keeps re-driving: the verdict is still pending delivery to the agent.
    expect(pendingCirclingVerdict('task-circle')).not.toBeNull();
    // SPINNING is the PM's voice, never a platform text.
    expect(ownerTexts()).toBe(0);

    // Another 150 calls, still no advance: the same episode — nothing new to tell.
    db().prepare("UPDATE work SET effort_calls = 400 WHERE id = 'task-circle'").run();
    expect(queueEffortReviewIfNeeded('task-circle')).toBe(true);
    await runEffortReview('task-circle');
    expect(reports()).toHaveLength(1);
  });
});

const newestPokeRung = (taskId: string): number | null => {
  const r = db().prepare("SELECT payload FROM work_events WHERE work_id = ? AND kind = 'poke' ORDER BY id DESC LIMIT 1").get(taskId) as { payload: string } | undefined;
  return r ? (JSON.parse(r.payload) as { rung: number }).rung : null;
};

describe('THE CHECK-IN: a "still working" answer closes it; no timed escalation against a working agent', () => {
  it('a work_note after a check-in closes it: the ladder re-arms, and the next check-in is a first one again', async () => {
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    claimedTask('task-q', 'the supplier list', t0 - 7 * MIN, 'c-1');
    await runPokeCheck();
    expect(newestPokeRung('task-q')).toBe(1); // the first check-in
    vi.setSystemTime(t0 + MIN);
    expect(trackerAddNotes('helper', { taskId: 'task-q', notes: 'Still working on it: halfway through the list.' })).toMatch(/^\[OK\]/);
    vi.setSystemTime(t0 + 7 * MIN);
    await runPokeCheck();
    const closed = db().prepare("SELECT COUNT(*) AS n FROM work_events WHERE work_id = 'task-q' AND kind = 'poke_remediation'").get() as { n: number };
    expect(closed.n).toBe(1);
    expect(newestPokeRung('task-q')).toBe(1); // a fresh first check-in, not a second rung
    expect(ownerTexts()).toBe(0);
  });

  it('an agent moving inside its window is never escalated to the primary on a timer; one that is not, still is', async () => {
    const t0 = Date.now();
    claimedTask('task-e', 'the vendor audit', t0 - 40 * MIN, 'c-1');
    recordPoke('task-e', 'pm', 1, 'nudge', 'helper');
    recordPoke('task-e', 'pm', 2, 'urgent', 'helper');
    modelCallFinished(t0 - MIN); // working, on something
    await runPokeCheck();
    expect(newestPokeRung('task-e')).toBe(2);
    expect(a2a.filter((m) => m.payload?.startsWith('ESCALATION'))).toHaveLength(0);
    // Control: the same task, the agent with no movement inside its window — the old rung still fires.
    db().prepare("DELETE FROM cost_records WHERE agent_id = 'helper'").run();
    modelCallFinished(t0 - 150 * MIN);
    await runPokeCheck();
    expect(newestPokeRung('task-e')).toBe(3);
  });

  it('a BROKEN-class agent (in error) holding work is not ALSO told SILENT: one notice per incident', async () => {
    wedgedToolCall(3 * 60 * MIN);
    db().prepare("UPDATE agents SET status = 'error' WHERE id = 'helper'").run();
    await runPokeCheck();
    expect(ownerTexts()).toBe(0);
  });
});
