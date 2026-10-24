// v3.5 DONE IS MEASURED, Task D2 — THE PM SEES "STALLED WITH N REMAINING".
//
// When a turn the engine continued comes back with no progress, D1 records `stalled` and parks
// nothing: the task stays in progress for the PM. The PM's closeout-miss report is where it decides
// per task, and it used to carry only the title and the goal. It now carries, per task, the measured
// record (what was touched, what the measure returns, of how many, when) and, when the last turn
// end was a stall, the stall and the count, plus a retask example that says so. A task with no
// measure and no ledger carries neither, so its report is unchanged.
//
// Real migration chain; the PM's A2A door is a spy that keeps the payload.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-d2-closeout-test', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/agent-bus.js', () => ({ sendAgentMessage: () => {} }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {} }) }));
const { countMeasure, deliverSpy } = vi.hoisted(() => ({
  countMeasure: vi.fn(),
  deliverSpy: vi.fn(async (e: { threadId?: string }) => ({ delivered: true, threadId: e?.threadId ?? 't' })),
}));
vi.mock('../../work/measure.js', async (orig) => ({ ...(await orig<typeof import('../../work/measure.js')>()), countMeasure }));
vi.mock('../../agent/a2a-transport.js', () => ({
  deliverA2AMessage: (...a: unknown[]) => deliverSpy(...(a as [never])),
  makeThreadId: (seed: string) => `thread-${seed}`,
}));

import { runMigrations } from '../../db/migrations.js';
import { trackerHandlers } from '../../agent/tools/cat/tracker.js';
import { recordTouched, recordMeasured } from '../../work/ledger-store.js';
import { recordContinued, recordStalled } from '../../work/job-momentum.js';
import { clearPlatformConfigCache } from '../../config/platform.js';
import { escalateCloseoutMissToPM } from '../pm-agent.js';

const AGENT = 'agent-d2';
const PM = 'agent-pm';
const MEASURE = { tool: 'gmail_search', args: { query: 'in:inbox -label:Done' }, unit: 'messages' };
const STALL_LINE = 'Last turn touched 0 items with 10,412 remaining: the assignee stopped making progress.';
const RETASK_EXAMPLE = '"you stopped at 10,412 remaining; continue from the measure\'s list"';

type Out = { content: string; isError: boolean };
const call = async (key: string, args: Record<string, unknown>): Promise<Out> =>
  (trackerHandlers[key] as (ctx: unknown) => Promise<Out>)({ agentId: AGENT, args });
const db = (): Database.Database => mockDb.current!;

/** A claimed task; a measured one is opened with its measure and read 10,551 at its start. */
async function openTask(measured: boolean): Promise<string> {
  countMeasure.mockResolvedValue({ ok: true, count: 10551 });
  const out = await call('work_open:task', { title: 'Sort the inbox', goal: 'every inbox message labelled', ...(measured ? { measure: MEASURE } : {}) });
  const m = /task_id=([0-9a-f-]{36})/.exec(out.content);
  if (!m) throw new Error(`no task id in: ${out.content}`);
  await call('work_update:status', { task_id: m[1], status: 'in_progress' });
  if (measured) recordMeasured(m[1], { ok: true, count: 10551 }, Date.now());
  return m[1];
}

async function payloadFor(taskId: string): Promise<string> {
  await escalateCloseoutMissToPM({ agentId: AGENT, danglingTaskIds: [taskId], agentText: 'still on it', source: 'pre-turn-gate' });
  expect(deliverSpy).toHaveBeenCalledTimes(1);
  return (deliverSpy.mock.calls[0][0] as unknown as { payload: string }).payload;
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare(`INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
    VALUES ('local','Local','openai-compatible','http://127.0.0.1:1/v1','none',1,datetime('now'),datetime('now'))`).run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m1','local','M','m','["text"]',8192,1024,1,datetime('now'),datetime('now'))`).run();
  for (const [id, name] of [[AGENT, 'Worker'], [PM, 'PM']]) {
    db().prepare(`INSERT INTO agents (id, name, model_id, status, config, spawn_depth, created_by, created_at, updated_at)
      VALUES (?, ?, 'm1', 'idle', '{}', 1, 'owner', datetime('now'), datetime('now'))`).run(id, name);
  }
  db().prepare(`INSERT OR REPLACE INTO config (key, value) VALUES ('pm_agent_id', ?)`).run(PM);
  clearPlatformConfigCache();
  countMeasure.mockReset();
  deliverSpy.mockClear();
});

describe('D2: the closeout-miss report carries the measure and the stall', () => {
  it('a stalled measured task: its Progress line, the stall with the count, and the retask example', async () => {
    const id = await openTask(true);
    recordTouched(id, 'gmail_label', Array.from({ length: 139 }, (_, i) => `gmail:msg:m${i}`));
    recordMeasured(id, { ok: true, count: 10412 }, Date.now());
    recordContinued(id, { remaining: 10412, touchedThisTurn: 139, novelCallsThisTurn: 1, turnNumber: 5 });
    recordStalled(id, { remaining: 10412, turnNumber: 6 });

    const payload = await payloadFor(id);
    expect(payload).toMatch(/Progress: 139 messages touched; measure gmail_search "in:inbox -label:Done" returned 10,412 remaining \(of 10,551 at start\), measured /);
    expect(payload).toContain(STALL_LINE);
    expect(payload).toContain(RETASK_EXAMPLE);
    // Per task, under that task's own line.
    const taskLine = payload.indexOf(`${id.slice(0, 8)} "Sort the inbox"`);
    expect(taskLine).toBeGreaterThan(-1);
    expect(payload.indexOf('Progress: ')).toBeGreaterThan(taskLine);
    expect(payload.indexOf(STALL_LINE)).toBeGreaterThan(payload.indexOf('Progress: '));
  });

  it('a measured task whose last turn end was a continuation, not a stall: the Progress line only', async () => {
    const id = await openTask(true);
    recordMeasured(id, { ok: true, count: 10412 }, Date.now());
    recordContinued(id, { remaining: 10412, touchedThisTurn: 3, novelCallsThisTurn: 0, turnNumber: 5 });

    const payload = await payloadFor(id);
    expect(payload).toContain('Progress: ');
    expect(payload).not.toContain('stopped making progress');
    expect(payload).not.toContain('you stopped at');
  });

  it('a stall the worker has since worked past (new items touched after it) is not reported as stopped', async () => {
    const id = await openTask(true);
    recordMeasured(id, { ok: true, count: 10412 }, Date.now());
    recordStalled(id, { remaining: 10412, turnNumber: 6 });
    recordTouched(id, 'gmail_label', ['gmail:msg:later'], Date.now() + 1000);

    const payload = await payloadFor(id);
    expect(payload).toContain('Progress: ');
    expect(payload).not.toContain('stopped making progress');
  });

  it('an unmeasured task with an empty ledger: neither line, nor the example', async () => {
    const id = await openTask(false);
    const payload = await payloadFor(id);
    expect(payload).not.toContain('Progress: ');
    expect(payload).not.toContain('stopped making progress');
    expect(payload).not.toContain('you stopped at');
  });
});
