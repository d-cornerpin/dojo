// The engine's stall nudge about a task names the task's run in flight, so the turn it wakes is rooted in that run
// (a scheduled job's nudge is a turn of its run, not a free-floating notice).
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));

import { runMigrations } from '../../db/migrations.js';
import { openTrackerTask } from '../../work/tracker-store.js';
import { redriveWithoutReply } from '../agent-notice.js';
import { freshAgentsDb, testDb, HELPER } from './helpers/agent-requests.js';

beforeEach(() => { freshAgentsDb(runMigrations); });

const nudgeRun = (words: string): string | null => (testDb().prepare("SELECT run_id AS r FROM messages WHERE agent_id = ? AND lane = 'events' AND content = ?").get(HELPER, words) as { r: string | null }).r;

describe('a stall nudge turn is rooted in its run', () => {
  it('a task with a run in flight: the nudge carries that run; with none, no run', async () => {
    const task = openTrackerTask({ title: 'Nightly report', assignedTo: HELPER, createdBy: HELPER, status: 'in_progress', origin: { kind: 'model', sourceMessageId: null, turn: null, convKey: null } });
    await redriveWithoutReply({ toAgentId: HELPER, fromAgentId: null, content: '[Engine hint: still going?]', taskId: task });
    expect(nudgeRun('[Engine hint: still going?]')).toBeNull();
    const run = 'run-1';   // the task's run in flight (the scheduler's occurrence row)
    testDb().prepare(`INSERT INTO work (id, kind, parent_id, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, sequence, opened_at, updated_at)
      VALUES (?, 'occurrence', ?, ?, 'schedule', 'schedule', ?, 'open', 'occurrence', 0, 0, 1, ?, ?)`).run(run, task, HELPER, task, Date.now(), Date.now());
    await redriveWithoutReply({ toAgentId: HELPER, fromAgentId: null, content: '[Engine hint: the run is still going?]', taskId: task });
    expect(nudgeRun('[Engine hint: the run is still going?]')).toBe(run);
  });
});
