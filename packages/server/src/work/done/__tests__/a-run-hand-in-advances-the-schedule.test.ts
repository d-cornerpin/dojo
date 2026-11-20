// A scheduled run that finishes is handed in by the engine for its worker, with scope `run`: the
// schedule advances at the hand-in with no decision, the next run is never held for one, the stale-run
// sweep leaves it alone, a send-back on a run is a hint while the next run still fires, a later run
// cannot be handed in on an earlier run's delivery, and a run that owed a message and sent none is recorded
// undelivered at once (one hint to its worker), never held.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { onTaskRunComplete, cleanupStaleRuns } from '../../../scheduler/runner.js';
import { dueScope } from '../../tracker-view.js';
import { latestHandIn } from '../record.js';
import { engineHandIn } from '../hand-in.js';
import { freshBoard, deliveredToOwner, call, stateOf, eventCount, PM, WORKER, TASK } from './helpers/decision-world.js';
import { doneDb } from './helpers/done-db.js';

const NEXT = Math.floor(Date.now() / 1000) * 1000 + 86_400_000;

function aRunInFlight(run: string, openedAt: number): void {
  doneDb().prepare("UPDATE work SET repeat_interval = 1, repeat_unit = 'days', schedule_status = 'running', next_run_at = ? WHERE id = ?").run(NEXT, TASK);
  doneDb().prepare(
    `INSERT INTO work (id, kind, parent_id, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, sequence, opened_at, updated_at)
     VALUES (?, 'occurrence', ?, ?, 'schedule', 'schedule', ?, 'open', 'occurrence', 0, 0, 'a run', 1, ?, ?)`,
  ).run(run, TASK, WORKER, TASK, openedAt, openedAt);
}

const schedule = (): { next_run_at: number; schedule_status: string } =>
  doneDb().prepare('SELECT next_run_at, schedule_status FROM work WHERE id = ?').get(TASK) as { next_run_at: number; schedule_status: string };
const due = (atMs: number): boolean => !!doneDb().prepare(`SELECT 1 FROM work w WHERE w.id = ? AND ${dueScope('w')}`).get(TASK, atMs);

describe('a run hand-in advances the schedule', () => {
  it('a finished run is handed in by the engine with scope run, the schedule advances, and no decision is made', async () => {
    freshBoard();
    aRunInFlight('run-1', Date.now() - 30_000);
    deliveredToOwner();
    expect(await onTaskRunComplete(TASK, 'complete', 'ran')).toBe(true);
    expect(stateOf()).toBe('handed_in');
    expect(latestHandIn(TASK)).toMatchObject({ scope: 'run', filedBy: 'engine', outcome: 'finished' });
    expect(eventCount('decided')).toBe(0);
    expect(schedule()).toEqual({ next_run_at: NEXT, schedule_status: 'waiting' });
    cleanupStaleRuns();
    expect(stateOf()).toBe('handed_in');
    expect(schedule().schedule_status).toBe('waiting');
    expect(due(NEXT + 1_000)).toBe(true);
  });

  it('a send-back on a run is a hint to the worker, and the next run still fires', async () => {
    freshBoard();
    aRunInFlight('run-1', Date.now() - 30_000);
    deliveredToOwner();
    await onTaskRunComplete(TASK, 'complete', 'ran');
    const r = await call(PM, 'work_validate', { action: 'decide', task_id: TASK, verdict: 'send_back', reason: 'The weather line was missing' });
    expect(r.isError).toBe(false);
    expect(stateOf()).toBe('open');
    const hint = (): string | undefined => (doneDb().prepare("SELECT content FROM messages WHERE agent_id = ? AND source_agent_id = ? AND lane = 'events' AND content LIKE '%sent back%'").get(WORKER, PM) as { content: string } | undefined)?.content;
    await vi.dynamicImportSettled();
    expect(hint()).toContain('The weather line was missing');
    expect(due(NEXT + 1_000)).toBe(true);
  });

  it('a run that delivered to the person its schedule serves, not the asker, is handed in finished on that delivery', async () => {
    freshBoard();
    aRunInFlight('run-1', Date.now() - 30_000);
    const at = Math.floor(Date.now() / 1000) * 1000;
    doneDb().prepare("INSERT INTO messages (id, agent_id, lane, role, content, authorized, sent_at, created_at) VALUES ('m-third', ?, 'owner', 'assistant', 'Your table for four is booked for Friday.', 1, ?, ?)").run(WORKER, at, at);
    doneDb().prepare(
      `INSERT INTO deliveries (id, agent_id, tool, channel, recipient_id, message_id, outcome, created_at, updated_at)
       VALUES ('dlv-third', ?, 'imessage_send', 'imessage', 'friend@example.com', 'm-third', 'delivered', datetime('now'), datetime('now'))`,
    ).run(WORKER);
    expect(await onTaskRunComplete(TASK, 'complete', 'ran')).toBe(true);
    expect(latestHandIn(TASK)).toMatchObject({ outcome: 'finished', items: [expect.objectContaining({ kind: 'delivery', ref: 'dlv-third' })] });
  });

  it.each(['busy-ack', 'imessage-door'])('an engine hand-in of a run citing an engine %s line in the run window is refused', async (tool) => {
    freshBoard();
    aRunInFlight('run-1', Date.now() - 30_000);
    const at = Math.floor(Date.now() / 1000) * 1000;
    doneDb().prepare("INSERT INTO messages (id, agent_id, lane, role, content, authorized, sent_at, created_at) VALUES ('m-eng', ?, 'owner', 'assistant', 'I am busy right now and will reply soon.', 1, ?, ?)").run(WORKER, at, at);
    doneDb().prepare(
      `INSERT INTO deliveries (id, agent_id, tool, channel, recipient_id, message_id, outcome, created_at, updated_at)
       VALUES ('dlv-eng', ?, ?, 'imessage', 'friend@example.com', 'm-eng', 'delivered', datetime('now'), datetime('now'))`,
    ).run(WORKER, tool);
    const r = engineHandIn(TASK, 'the run finished', { outcome: 'finished', items: [{ kind: 'delivery', ref: 'dlv-eng' }], scope: 'run' });
    expect(r.kind).toBe('refused');
    expect(stateOf()).toBe('claimed');
  });

  it('a handed-in run whose next run went missing is left alone by the recovery sweep', async () => {
    freshBoard();
    aRunInFlight('run-1', Date.now() - 30_000);
    deliveredToOwner();
    await onTaskRunComplete(TASK, 'complete', 'ran');
    doneDb().prepare("UPDATE work SET next_run_at = NULL WHERE id = ?").run(TASK);
    const before = doneDb().prepare('SELECT state, schedule_status, updated_at FROM work WHERE id = ?').get(TASK);
    cleanupStaleRuns();
    expect(doneDb().prepare('SELECT state, schedule_status, updated_at FROM work WHERE id = ?').get(TASK)).toEqual(before);
    expect(eventCount('decided')).toBe(0);
  });

  it('a later run cannot be handed in on an earlier run\'s delivery', async () => {
    freshBoard();
    const earlier = deliveredToOwner();
    aRunInFlight('run-2', Date.now() + 1_000);
    const r = await call(WORKER, 'work_update', { action: 'hand_in', task_id: TASK, outcome: 'finished', proof: [{ kind: 'delivery', ref: earlier }], note: 'Sent the brief' });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/before the task was opened/);
    expect(stateOf()).toBe('claimed');
  });

  it('a run whose delivery is still owed when its next run is due fires on time, and its worker is hinted once', async () => {
    freshBoard();
    doneDb().prepare("UPDATE work SET task_kind = 'reminder' WHERE id = ?").run(TASK);
    aRunInFlight('run-1', Date.now() - 30_000);
    expect(await onTaskRunComplete(TASK, 'complete', 'ran')).toBe(true);
    const settled = doneDb().prepare("SELECT json_extract(payload, '$.run_status') AS s FROM work_events WHERE work_id = 'run-1' AND kind = 'occurrence_settled'").get() as { s: string };
    expect(settled.s).toBe('undelivered');
    expect(schedule()).toEqual({ next_run_at: NEXT, schedule_status: 'waiting' });
    expect(due(NEXT + 1_000)).toBe(true);
    expect(await onTaskRunComplete(TASK, 'complete', 'ran')).toBe(false);
    const hints = doneDb().prepare("SELECT content FROM messages WHERE agent_id = ? AND content LIKE '[Engine hint: a run of%'").all(WORKER) as Array<{ content: string }>;
    expect(hints).toHaveLength(1);
    const trail = doneDb().prepare("SELECT json_extract(payload, '$.reason') AS reason, json_extract(payload, '$.action_taken') AS action FROM work_events WHERE work_id = ? AND kind = 'audit' AND json_extract(payload, '$.entry_kind') = 'ladder_hint'").all(TASK);
    expect(trail).toEqual([{ reason: 'Reminded the worker that this run\'s result was not delivered.', action: null }]);
  });

  it('a run that only told another agent is recorded undelivered', async () => {
    freshBoard();
    doneDb().prepare("UPDATE work SET task_kind = 'reminder' WHERE id = ?").run(TASK);
    aRunInFlight('run-1', Date.now() - 30_000);
    const at = Math.floor(Date.now() / 1000) * 1000;
    const text = '[A2A:DELIVERABLE thread:thr-x] Your table for four is booked for Friday.';
    doneDb().prepare("INSERT INTO messages (id, agent_id, lane, role, content, authorized, sent_at, created_at) VALUES ('m-a2a', ?, 'a2a', 'assistant', ?, 1, ?, ?)").run(WORKER, text, at, at);
    doneDb().prepare(
      `INSERT INTO deliveries (id, agent_id, tool, channel, recipient_id, message_id, detail, outcome, created_at, updated_at)
       VALUES ('dlv-a2a', ?, 'send_to_agent', 'a2a', ?, 'm-a2a', ?, 'delivered', datetime('now'), datetime('now'))`,
    ).run(WORKER, PM, text);
    expect(await onTaskRunComplete(TASK, 'complete', 'ran')).toBe(true);
    const settled = doneDb().prepare("SELECT json_extract(payload, '$.run_status') AS s FROM work_events WHERE work_id = 'run-1' AND kind = 'occurrence_settled'").get() as { s: string };
    expect(settled.s).toBe('undelivered');
  });
});
