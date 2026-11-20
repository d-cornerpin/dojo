// TWO SCHEDULE CALC CALL SITES MUST READ THE ROW'S OWN ZONE — THE OWNER-EDIT DOOR AND THE
// MISSED-RUN CHECK.
//
// `engine.ts:calculateNextRun` takes the per-task zone from `task.tz`, falling back to the box
// zone only when the row declares none. Most call sites project it. Two do not: the owner-edit
// door (PUT `/tasks/:id` in `gateway/routes/tracker.ts`) builds its `ScheduledTask` without the
// stored `tz`, and the missed-run terminal check in `tracker/tools.ts` does the same, so a
// "09:00 in Pacific/Auckland" daily task is advanced on the box clock the moment the owner edits
// its schedule, and a task whose end date has already passed in its own zone is still read as
// owing another run.
//
// Both cases pin the clock at 2026-11-01T12:00:00Z. That morning the box zone
// (America/Los_Angeles, DST fall-back at 09:00Z) and the task zone (Pacific/Auckland, +13)
// genuinely disagree about what "09:00" and "the day is over" mean, so the saved zone — not the
// box — decides the answer. Each case first asserts the two zones really differ at this instant;
// if that stops being true the case is vacuous and must be re-anchored.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-task-own-zone', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ }, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../config/platform.js')>()),
  getPrimaryAgentId: () => 'primary',
  isPrimaryAgent: (id: string) => id === 'primary',
  getPMAgentId: () => 'pm',
  getPMAgentName: () => 'PM',
  isPMAgent: (id: string) => id === 'pm',
  getOwnerName: () => 'the owner',
}));
vi.mock('../../memory/message-store.js', async (orig) => ({
  ...(await orig<typeof import('../../memory/message-store.js')>()),
  insertEngineEventIfAbsent: () => null,
}));
vi.mock('../../agent/runtime.js', async (orig) => ({
  ...(await orig<typeof import('../../agent/runtime.js')>()),
  getAgentRuntime: () => ({ handleMessage: async () => { /* no-op */ } }),
}));
vi.mock('../../agent/agent-notice.js', async (orig) => ({
  ...(await orig<typeof import('../../agent/agent-notice.js')>()),
  postAgentNotice: () => 'notice-id',
}));
vi.mock('../../tracker/pm-agent.js', async (orig) => ({
  ...(await orig<typeof import('../../tracker/pm-agent.js')>()),
  ensurePMAgentRunning: () => { /* no-op */ },
}));
vi.mock('../../tracker/notify.js', async (orig) => ({
  ...(await orig<typeof import('../../tracker/notify.js')>()),
  injectTaskAssignmentNotification: () => { /* no-op */ },
}));

import { runMigrations } from '../../db/migrations.js';
import { seedTrackerTask, ms } from '../../work/__tests__/work-fixture.js';
import { trackerRouter } from '../../gateway/routes/tracker.js';
import { onTaskRunComplete } from '../runner.js';
import { calculateNextRun, instantToWall, type ScheduledTask } from '../engine.js';
import { tsToMs } from '../../work/tracker-view.js';

const TASK_ZONE = 'Pacific/Auckland';                       // +13 here, DST since 2026-09-27
const NOW_MS = Date.parse('2026-11-01T12:00:00.000Z');      // box 04:00 PST, task-zone 01:00 Nov 2 NZDT
const DAY = 86_400_000;
const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare(`INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
    VALUES ('local','Local','openai-compatible','http://127.0.0.1:1/v1','none',1,datetime('now'),datetime('now'))`).run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m1','local','M','m','["text"]',8192,1024,1,datetime('now'),datetime('now'))`).run();
  for (const id of ['primary', 'pm', 'worker']) {
    db().prepare(`INSERT INTO agents (id, name, model_id, status, config, spawn_depth, created_by, created_at, updated_at)
      VALUES (?, ?, 'm1', 'idle', '{}', 1, 'owner', datetime('now'), datetime('now'))`).run(id, id === 'pm' ? 'PM' : id);
  }
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW_MS));
});
afterEach(() => {
  vi.useRealTimers();
  mockDb.current?.close();
  mockDb.current = null;
});

describe('the schedule calcs that skip the row\'s zone', () => {
  it('an owner edit of a saved schedule advances it in the task\'s own zone, not the box zone', async () => {
    const start = '2026-10-26T20:00:00.000Z';   // 09:00 Tuesday in Auckland, 13:00 Monday in the box zone
    seedTrackerTask(db(), {
      id: 'auckland-daily', agentId: 'worker', status: 'in_progress', title: 'the daily digest',
      priority: 'normal', tz: TASK_ZONE, anchor_local: null, attempts: 1,
      scheduled_start: ms(start), repeat_interval: 1, repeat_unit: 'days',
      repeat_end_type: 'never', repeat_end_value: null, repeat_days_of_week: null,
      schedule_status: 'waiting', is_paused: 0, next_run_at: ms(start),
    });

    // What the edit door hands `calculateNextRun`, field for field. Precondition: the task's zone
    // and the box zone must give different answers here, or the edit asserts nothing.
    const calcBase: ScheduledTask = {
      id: 'auckland-daily', scheduled_start: start, repeat_interval: 1, repeat_unit: 'days',
      repeat_end_type: 'never', repeat_end_value: null, run_count: 1, is_paused: 0,
      last_run_at: null, next_run_at: null, schedule_status: 'waiting',
      repeat_days_of_week: null, anchor_time: start,
    };
    const expectedTaskZone = calculateNextRun({ ...calcBase, tz: TASK_ZONE });
    const expectedBoxZone = calculateNextRun({ ...calcBase, tz: null });
    expect(expectedTaskZone, 'the task-zone computation must resolve').not.toBeNull();
    expect(expectedBoxZone, 'the box-zone computation must resolve').not.toBeNull();
    expect(tsToMs(expectedTaskZone), 'the task zone and the box zone must differ — the saved zone is the whole point')
      .not.toBe(tsToMs(expectedBoxZone));

    const res = await trackerRouter.request('/tasks/auckland-daily', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scheduled_start: start, repeat_interval: 1, repeat_unit: 'days' }),
    });
    expect(res.status).toBe(200);

    const stored = db().prepare('SELECT next_run_at FROM work WHERE id = ?').get('auckland-daily') as { next_run_at: number | null };
    expect(stored.next_run_at).toBe(tsToMs(expectedTaskZone));
    // In the task's own zone the next fire reads 09:00, the time the owner set — the box-zone
    // answer lands an hour off here (its DST fall-back sits between the anchor and this result).
    expect(stored.next_run_at).not.toBeNull();
    expect(instantToWall(stored.next_run_at!, TASK_ZONE).hour).toBe(9);
  });

  it('a finished run is the LAST run on the task\'s own zone\'s end date, not the box\'s: it hands in the whole schedule', async () => {
    const start = '2026-10-26T20:00:00.000Z';
    seedTrackerTask(db(), {
      id: 'ending-daily', agentId: 'worker', status: 'in_progress', title: 'the closing digest',
      priority: 'normal', tz: TASK_ZONE, anchor_local: null, attempts: 5,
      scheduled_start: ms(start), repeat_interval: 1, repeat_unit: 'days',
      repeat_end_type: 'on_date', repeat_end_value: '2026-11-01', repeat_days_of_week: null,
      schedule_status: 'running', is_paused: 0,
      last_run_at: NOW_MS - DAY, next_run_at: NOW_MS, result: 'placeholder from the last fire',
    });
    db().prepare(`INSERT INTO work (id, kind, parent_id, agent_id, assignee_agent, requester, requester_id,
                                    root_kind, root_id, state, intent, wakes, closes_thread, title, sequence,
                                    opened_at, updated_at)
      VALUES ('run-1', 'occurrence', 'ending-daily', 'worker', 'worker', 'schedule', 'ending-daily',
              'schedule', 'ending-daily', 'open', 'occurrence', 0, 0, 'the open run', 1, ?, ?)`)
      .run(NOW_MS - 60_000, NOW_MS - 60_000);

    // What the missed-run check hands `calculateNextRun`, field for field. Precondition: at this
    // instant the end date is over in the task's zone (its 23:59:59 passed at 10:59:59Z) and NOT
    // over in the box zone (its 23:59:59 lands 2026-11-02T07:59:59Z) — the zones must give
    // opposite terminal answers or the check asserts nothing.
    const probeBase: ScheduledTask = {
      id: 'ending-daily', scheduled_start: '2026-10-26 20:00:00', repeat_interval: 1, repeat_unit: 'days',
      repeat_end_type: 'on_date', repeat_end_value: '2026-11-01', run_count: 6, is_paused: 0,
      last_run_at: new Date(NOW_MS).toISOString(), next_run_at: '2026-11-01 12:00:00',
      schedule_status: 'running', repeat_days_of_week: null, anchor_time: null,
    };
    expect(calculateNextRun({ ...probeBase, tz: TASK_ZONE }), 'the task zone must read the task as finished').toBeNull();
    expect(calculateNextRun({ ...probeBase, tz: null }), 'the box zone must read the task as owing another run').not.toBeNull();

    expect(await onTaskRunComplete('ending-daily', 'complete', 'the last digest went out')).toBe(true);
    // The task-zone answer is terminal: this run is the schedule's last, so it is handed in whole.
    const h = db().prepare("SELECT json_extract(payload, '$.scope') AS s FROM work_events WHERE work_id = 'ending-daily' AND kind = 'handed_in'").get() as { s: string };
    expect(h.s, 'the last run hands in the schedule, never one run among many').toBe('schedule');
  });
});
