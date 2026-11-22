// The owner asks on the dashboard for a reminder and its request settles on the agent's confirmation. When the run
// fires, its turn writes one line on the dashboard: that line is the run's delivery, never a start line, so the run
// closes on it.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { closeRunsThatDelivered } from '../../../scheduler/runner.js';
import { freshBoard, deliveredToOwner, ownerSays, WORKER, TASK } from './helpers/decision-world.js';
import { doneDb } from './helpers/done-db.js';

/** A turn of WORKER, ended, rooted as given, and the delivery `id` written in it. */
function inTurn(n: number, rootKind: string, rootId: string, id: string): void {
  doneDb().prepare(`INSERT INTO turns (agent_id, turn_number, started_at, ended_at, exit_reason, answered, root_kind, root_id)
    VALUES (?, ?, datetime('now', '-20 seconds'), datetime('now', '-10 seconds'), 'answered', 1, ?, ?)`).run(WORKER, n, rootKind, rootId);
  doneDb().prepare('UPDATE deliveries SET turn_number = ?, root_kind = ?, root_id = ? WHERE id = ?').run(n, rootKind, rootId, id);
}

describe('a lone dashboard reminder line is its run\'s delivery', () => {
  it('the run closes done on the line its own turn wrote', async () => {
    freshBoard();
    const asked = ownerSays('Remind me in 10 minutes to stretch', { agent: WORKER, at: -120_000 });
    const confirmation = deliveredToOwner(WORKER, 'Set for 1:43 PM.');
    inTurn(1, 'ask', asked, confirmation);
    doneDb().prepare("UPDATE deliveries SET created_at = datetime('now', '-2 minutes') WHERE id = ?").run(confirmation);
    doneDb().prepare(`INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, result_delivery_id, opened_at, updated_at, closed_at)
      VALUES (?, 'ask', ?, 'owner', 'ask', ?, 'done', 'ask', 1, 0, 'ask', ?, ?, ?, ?)`).run(`ask:${asked}`, WORKER, asked, confirmation, Date.now() - 120_000, Date.now(), Date.now());
    doneDb().prepare(`UPDATE work SET task_kind = 'reminder', title = 'Reminder: stretch', source_message_id = ?, schedule_status = 'running' WHERE id = ?`).run(asked, TASK);
    doneDb().prepare(`INSERT INTO work (id, kind, parent_id, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, sequence, opened_at, updated_at)
      VALUES ('run-1', 'occurrence', ?, ?, 'schedule', 'schedule', ?, 'open', 'occurrence', 0, 0, 'a run', 1, ?, ?)`).run(TASK, WORKER, TASK, Date.now() - 30_000, Date.now() - 30_000);
    inTurn(2, 'occurrence', 'run-1', deliveredToOwner(WORKER, 'Time to stretch: you have been at the desk a while.'));

    expect(await closeRunsThatDelivered()).toBe(1);
    expect(doneDb().prepare("SELECT state FROM work WHERE id = 'run-1'").get()).toEqual({ state: 'done' });
  });
});
