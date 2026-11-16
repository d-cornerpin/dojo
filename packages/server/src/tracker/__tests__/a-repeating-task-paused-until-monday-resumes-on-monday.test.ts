// "Pause the daily brief until Monday": a repeating task paused with a resume time does not fire while
// paused and resumes by itself on Monday, whether the agent pauses the schedule or puts the task on a
// paused status. Driven through the tool executor and the scheduler in a scratch home, on a fake clock.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async () => 'ran', whenQueuedRunEnds: async () => 'ran' }),
}));

const MAIN = 'agent-main';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'pause-until-'));
vi.stubEnv('DOJO_HOME', home);
const connection = await import('../../db/connection.js');
const migrations = await import('../../db/migrations.js');
const platform = await import('../../config/platform.js');
const { executeTool, toolResultOf } = await import('../../agent/tools/index.js');
const { checkScheduledTasks, resumeExpiredPauses } = await import('../../scheduler/runner.js');

const WEDNESDAY = Date.parse('2026-11-18T08:00:00Z');
const THURSDAY_RUN = Date.parse('2026-11-19T09:01:00Z');
const MONDAY = '2026-11-23T00:00:00Z';
const MONDAY_RUN = Date.parse('2026-11-23T09:00:00Z');

beforeAll(() => {
  migrations.runMigrations();
  const db = connection.getDb();
  db.prepare("INSERT INTO agents (id, name, status, config, classification) VALUES (?, 'main', 'idle', '{}', 'sensei')").run(MAIN);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(MAIN);
  platform.clearPlatformConfigCache();
});
afterEach(() => { vi.useRealTimers(); });
afterAll(() => {
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

let n = 0;
const call = async (name: string, args: Record<string, unknown>) =>
  toolResultOf(await executeTool(MAIN, { id: `call-${++n}`, name, arguments: args }));
const at = (ms: number) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(ms); };
const runsOf = (id: string) => (connection.getDb().prepare(
  "SELECT COUNT(*) AS n FROM work WHERE kind = 'occurrence' AND parent_id = ?",
).get(id) as { n: number }).n;
const scheduleOf = (id: string) => connection.getDb().prepare('SELECT is_paused, next_run_at FROM work WHERE id = ?').get(id) as
  { is_paused: number; next_run_at: number | null };

async function dailyBrief(title: string): Promise<string> {
  const made = await call('work_open', {
    kind: 'task', title, goal: 'the brief is sent every morning',
    scheduled_start: '2026-11-19T09:00:00Z', repeat_interval: 1, repeat_unit: 'days', allow_duplicate: true,
  });
  expect(made.isError, made.content).toBeFalsy();
  return /task_id=([\w-]+)/.exec(made.content)![1]!;
}

async function pausedUntilMondayThenMonday(id: string): Promise<void> {
  at(THURSDAY_RUN);
  await checkScheduledTasks();
  expect(runsOf(id)).toBe(0);

  at(Date.parse(MONDAY) + 60_000);
  resumeExpiredPauses();
  expect(scheduleOf(id)).toEqual({ is_paused: 0, next_run_at: MONDAY_RUN });
}

describe('a repeating task paused until Monday resumes on Monday', () => {
  it('work_schedule(action="pause") with resume_at', async () => {
    at(WEDNESDAY);
    const id = await dailyBrief('Morning brief A');
    const res = await call('work_schedule', { action: 'pause', task_id: id, resume_at: MONDAY });
    expect(res.isError, res.content).toBeFalsy();
    await pausedUntilMondayThenMonday(id);
  });

  it('a paused status with resume_at goes to the same pause', async () => {
    at(WEDNESDAY);
    const id = await dailyBrief('Morning brief B');
    const res = await call('work_update', {
      action: 'status', task_id: id, status: 'paused', resume_at: MONDAY, notes: 'the owner is away until Monday',
    });
    expect(res.isError, res.content).toBeFalsy();
    await pausedUntilMondayThenMonday(id);
  });
});
