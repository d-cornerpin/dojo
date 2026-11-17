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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-schedule-no-action-test', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
const { countMeasure, granted } = vi.hoisted(() => ({ countMeasure: vi.fn(), granted: { value: true } }));
vi.mock('../../work/measure.js', async (orig) => ({ ...(await orig<typeof import('../../work/measure.js')>()), countMeasure }));
vi.mock('../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../config/platform.js')>()),
  isPMAgent: (id: string) => id === 'pm-agent-x',
}));
vi.mock('../../agent/access/read.js', async (orig) => ({
  ...(await orig<typeof import('../../agent/access/read.js')>()),
  toolCategoryGranted: () => granted.value,
}));

import { runMigrations } from '../../db/migrations.js';
import { trackerHandlers } from '../../agent/tools/cat/tracker.js';


const AGENT = 'agent-sched';
type Out = { content: string; isError: boolean };
const call = async (key: string, args: Record<string, unknown>): Promise<Out> =>
  (trackerHandlers[key] as (ctx: unknown) => Promise<Out>)({ agentId: AGENT, args });
const db = (): Database.Database => mockDb.current!;
const row = (id: string) => db().prepare('SELECT is_paused, schedule_status, state FROM work WHERE id = ?').get(id) as { is_paused: number; schedule_status: string; state: string };

const REFUSAL = 'Error: work_schedule needs action: "pause" or "resume". Nothing was changed.';
const recurring = { title: 'Nightly sweep', goal: 'inbox sorted', allow_duplicate: true, scheduled_start: new Date(Date.now() + 3_600_000).toISOString(), repeat_interval: 1, repeat_unit: 'days' };

async function openRecurring(): Promise<string> {
  const out = await call('work_open:task', recurring);
  const m = /task_id=([0-9a-f-]{36})/.exec(out.content);
  if (!m) throw new Error(`no task id in: ${out.content}`);
  return m[1];
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare(`INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
    VALUES ('local','Local','openai-compatible','http://127.0.0.1:1/v1','none',1,datetime('now'),datetime('now'))`).run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m1','local','M','m','["text"]',8192,1024,1,datetime('now'),datetime('now'))`).run();
  db().prepare(`INSERT INTO agents (id, name, model_id, status, config, spawn_depth, created_by, created_at, updated_at)
    VALUES (?, 'Worker', 'm1', 'idle', '{}', 1, 'owner', datetime('now'), datetime('now'))`).run(AGENT);
  countMeasure.mockReset();
  granted.value = true;
});

describe('work_schedule with no action is asked, not guessed', () => {
  it('a call with only a task id is refused with the plain text and the task is untouched', async () => {
    const id = await openRecurring();
    const before = row(id);
    const out = await call('work_schedule:pause', { task_id: id });
    expect(out.content).toBe(REFUSAL);
    expect(out.isError).toBe(true);
    expect(row(id)).toEqual(before);
    expect(before.is_paused).toBe(0);
  });

  it('action "pause" still pauses', async () => {
    const id = await openRecurring();
    const out = await call('work_schedule:pause', { action: 'pause', task_id: id });
    expect(out.content).toMatch(/Schedule paused/);
    expect(row(id).is_paused).toBe(1);
  });
});
