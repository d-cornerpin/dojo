// Every former engine door hands work in for its worker and never sets it done: the row lands in
// handed_in, the hand-in is filed by the engine (complete_task is the helper's own), and no decision is
// made. One case per door; the run, same-turn, relay-card and assign-reply doors are pinned in
// their own files.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {}, isRunning: () => false }) }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { onTaskRunComplete, forceResetStuckRecurringTask } from '../../../scheduler/runner.js';
import { latestHandIn } from '../record.js';
import { freshBoard, deliveredToOwner, call, stateOf, eventCount, MAIN, WORKER, TASK } from './helpers/decision-world.js';
import { doneDb } from './helpers/done-db.js';

function handedInByEngine(id = TASK, filedBy = 'engine'): void {
  expect(stateOf(id)).toBe('handed_in');
  expect(latestHandIn(id)?.filedBy).toBe(filedBy);
  expect(eventCount('decided', id)).toBe(0);
}

function aScheduledRun(nextRunAt: number | null): void {
  const at = Date.now() - 30_000;
  doneDb().prepare("UPDATE work SET repeat_interval = 1, repeat_unit = 'days', repeat_end_type = 'after_count', repeat_end_value = '1', schedule_status = 'running', next_run_at = ? WHERE id = ?").run(nextRunAt, TASK);
  doneDb().prepare(
    `INSERT INTO work (id, kind, parent_id, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, sequence, opened_at, updated_at)
     VALUES ('run-1', 'occurrence', ?, ?, 'schedule', 'schedule', ?, 'open', 'occurrence', 0, 0, 'a run', 1, ?, ?)`,
  ).run(TASK, WORKER, TASK, at, at);
}

describe('no engine door sets done', () => {

  it('a failed final scheduled run is handed in as can\'t be done, and the owner is told at once', async () => {
    freshBoard();
    aScheduledRun(null);
    expect(await onTaskRunComplete(TASK, 'failed', 'the mail server refused')).toBe(true);
    handedInByEngine();
    expect(latestHandIn(TASK)).toMatchObject({ outcome: 'cant_be_done', scope: 'schedule' });
    expect(doneDb().prepare("SELECT 1 FROM messages WHERE agent_id = ? AND origin_intent = 'schedule_run_failed_owner'").get(MAIN)).toBeTruthy();
  });

  it('a stuck recurring task with no run left is handed in for the whole schedule', () => {
    freshBoard();
    doneDb().prepare("UPDATE work SET repeat_interval = 1, repeat_unit = 'days', repeat_end_type = 'after_count', repeat_end_value = '0', schedule_status = 'running' WHERE id = ?").run(TASK);
    deliveredToOwner();
    forceResetStuckRecurringTask(TASK);
    handedInByEngine();
    expect(latestHandIn(TASK)?.scope).toBe('schedule');
  });

  it('a deleted group\'s orphaned task is handed in as can\'t be done on the termination record', async () => {
    freshBoard();
    doneDb().prepare("INSERT INTO agent_groups (id, name, created_by) VALUES ('grp-1', 'crew', ?)").run(MAIN);
    doneDb().prepare("UPDATE agents SET group_id = 'grp-1', classification = 'apprentice' WHERE id = ?").run(WORKER);
    const r = await call(MAIN, 'delete_group', { group_id: 'grp-1', terminate_members: true });
    expect(r.isError, r.content).toBe(false);
    handedInByEngine();
    expect(latestHandIn(TASK)?.outcome).toBe('cant_be_done');
  });

  it('complete_task hands the helper\'s task in as its own and sends the parent the result first', async () => {
    freshBoard();
    doneDb().prepare("UPDATE agents SET classification = 'apprentice', parent_agent = ?, task_id = ? WHERE id = ?").run(MAIN, TASK, WORKER);
    deliveredToOwner();
    const r = await call(WORKER, 'complete_task', { status: 'complete', summary: 'The report is written and sent.' });
    expect(r.isError, r.content).toBe(false);
    handedInByEngine(TASK, WORKER);
    const sent = doneDb().prepare("SELECT content FROM messages WHERE agent_id = ? AND source_agent_id = ? AND a2a_intent = 'COMPLETE'")
      .get(MAIN, WORKER) as { content: string } | undefined;
    expect(sent?.content, 'the parent has the result before any decision').toContain('The report is written and sent.');
  });

  it('a helper that gives up has its other working task handed in by the engine as can\'t be done', async () => {
    freshBoard();
    doneDb().prepare("UPDATE agents SET classification = 'apprentice', parent_agent = ?, task_id = ? WHERE id = ?").run(MAIN, TASK, WORKER);
    const at = Date.now() - 60_000;
    doneDb().prepare(
      `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, source_message_id, opened_at, updated_at)
       VALUES ('dangler-1', 'task', ?, 'owner', 'tracker', 'dangler-1', 'claimed', 'task', 1, 0, 'a second piece', NULL, ?, ?)`,
    ).run(WORKER, at, at);
    const r = await call(WORKER, 'complete_task', { status: 'fallen', summary: 'The report source is gone, so neither piece can be written.' });
    expect(r.isError, r.content).toBe(false);
    handedInByEngine('dangler-1');
    expect(latestHandIn('dangler-1')?.outcome).toBe('cant_be_done');
  });
});
