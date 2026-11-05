// v3.5 field fix 3, review round 3: THE PM'S FIRST-STRIKE POKE READS THE TASK'S RECORD, AND STATES FACTS.
//
// `checkInOn` (tracker/pm-agent.ts) turned the poke into "DELIVERY ON RECORD ... close it with
// work_update(... complete ...)" whenever the task's answered turn had ANY channel line on record
// (`deliveredVia`), and strike 2 then engine-closed the task. An iMessage "On it" was enough.
// Owner law: an ack never closes a task, and close-coaching in engine text is a defect. The
// handover is now `taskWorkOnRecord` (a delivered file, or the task's answer under the ack-order
// rule), and the steer states what is on record without telling the agent to close.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-poke-ack');

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-poke-ack');
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-poke-ack', 'dojo.db'),
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
const closeLogged = (taskId: string): number => (db().prepare(
  "SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND payload LIKE '%delivery-receipt close%'",
).get(taskId) as { n: number }).n;


describe('review round 3: the first-strike poke never treats an ack as a handover, and never coaches a close', () => {
  it('THE RED: only an iMessage line on record: no DELIVERY ON RECORD steer, no receipt close, across strikes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    evidence.on = true;
    const now = Date.now();
    claimedTask('task-ack', 'book the table', now - 6 * MIN, null);
    for (const m of [0, 10, 25]) await sweepAt(now + m * MIN);
    expect(checkIns('task-ack').join('\n---\n')).not.toMatch(/DELIVERY ON RECORD/);
    expect(closeLogged('task-ack')).toBe(0);
    expect((db().prepare("SELECT state FROM work WHERE id = 'task-ack'").get() as { state: string }).state).toBe('claimed');
  });

  it('STRIKE-2 TWIN (round 4): a TEXT answer on record (the ask settled on it) never earns the steer or an engine close', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    evidence.on = true;
    const now = Date.now();
    claimedTask('task-text', 'book the table', now - 6 * MIN, null);
    db().prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES ('conv-t', 'helper', 'dashboard', 'owner')`).run();
    db().prepare(`INSERT INTO messages (id, agent_id, role, content, lane, conversation_id, created_at) VALUES ('msg-t', 'helper', 'user', 'book it', 'owner', 'conv-t', ?)`).run(now - 7 * MIN);
    // The R1 shape: a line "On it." after the task opened, then the progress line the ask settles on.
    db().prepare(`INSERT INTO messages (id, agent_id, role, content, lane, conversation_id, display_kind, created_at) VALUES ('m-ack', 'helper', 'assistant', 'On it.', 'owner', 'conv-t', 'agent-text', ?)`).run(now - 5.5 * MIN);
    db().prepare(`INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, message_id, outcome, created_at) VALUES ('d-ack', 'helper', 7, 'dashboard', 'dashboard', 'conv-t', 'm-ack', 'delivered', ?)`).run(sqlTime(now - 5.5 * MIN));
    db().prepare(`INSERT INTO messages (id, agent_id, role, content, lane, conversation_id, display_kind, created_at) VALUES ('m-ans', 'helper', 'assistant', 'Found three tables; booking next.', 'owner', 'conv-t', 'agent-text', ?)`).run(now - 5 * MIN);
    db().prepare(`INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, message_id, outcome, created_at) VALUES ('d-ans', 'helper', 7, 'dashboard', 'dashboard', 'conv-t', 'm-ans', 'delivered', ?)`).run(sqlTime(now - 5 * MIN));
    const { openAsk } = await import('../../work/store.js');
    openAsk({ agentId: 'helper', messageId: 'msg-t', conversationId: 'conv-t', requesterId: 'owner', openedAt: now - 7 * MIN, title: 'book it' });
    db().prepare(`UPDATE work SET state = 'done', closed_at = ?, result_delivery_id = 'd-ans' WHERE id = 'ask:msg-t'`).run(now - 5 * MIN);
    db().prepare("UPDATE work SET source_message_id = 'msg-t' WHERE id = 'task-text'").run();
    for (const m of [0, 10, 25]) await sweepAt(now + m * MIN);
    expect(checkIns('task-text').join('\n---\n')).not.toMatch(/DELIVERY ON RECORD/);
    expect(closeLogged('task-text')).toBe(0);
    expect((db().prepare("SELECT state FROM work WHERE id = 'task-text'").get() as { state: string }).state).toBe('claimed');
  });

  it('CONTROL: a delivered file on record still gets the steer, stated as facts with no "close it"', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    evidence.on = true;
    const now = Date.now();
    claimedTask('task-file', 'write the report', now - 6 * MIN, null);
    // The real record taskWorkOnRecord reads: the answered turn on the task's origin, with a file.
    db().prepare("UPDATE work SET source_message_id = 'msg-file' WHERE id = 'task-file'").run();
    db().prepare(
      `INSERT INTO turns (agent_id, turn_number, kind, subject_kind, source_message_id, answered, started_at, ended_at, exit_reason)
       VALUES ('helper', 7, 'user', 'conv', 'msg-file', 1, ?, ?, 'answered')`,
    ).run(sqlTime(now - 5 * MIN), sqlTime(now - 5 * MIN));
    db().prepare(
      `INSERT INTO turn_artifacts (agent_id, turn_number, kind, path, delivered_at) VALUES ('helper', 7, 'file', '/tmp/report.md', ?)`,
    ).run(sqlTime(now - 5 * MIN));
    await sweepAt(now);
    const sent = checkIns('task-file').join('\n');
    expect(sent).toMatch(/DELIVERY ON RECORD/);
    expect(sent).toContain('report.md');
    expect(sent).not.toMatch(/close it with/);
  });
});
