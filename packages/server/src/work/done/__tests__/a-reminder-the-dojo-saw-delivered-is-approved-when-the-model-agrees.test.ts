// A finished run of a task that owes a person a message, whose delivered message the engine tied to the run, is
// approved by the engine when the small local model reads that message as what the task owes. A no, no answer, no
// model, or a task that owes no message: the run goes to the manager as before. A one-time reminder's only run is its
// final one, decided the same way on whichever channel it went. A reminder asked on the dashboard, whose request settled
// on the agent's confirmation, closes on the one line its run's own turn wrote there: that line is never a start line.
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import '../../../agent/decision-ask.js';
import { closeRunsThatDelivered, onTaskRunComplete } from '../../../scheduler/runner.js';
import { freshBoard, deliveredToOwner, ownerSays, stateOf, eventCount, WORKER, TASK } from './helpers/decision-world.js';
import { doneDb } from './helpers/done-db.js';
import { installDecisionModel, scriptDecisions, yes, type DecisionCall } from '../../../agent/__tests__/decision-fake.js';

const REMINDER = 'Time to stretch: stand up and roll your shoulders.';

/** A live daily schedule of kind `kind` (or a one-time reminder) worked by WORKER, whose open run delivered REMINDER
 *  to the owner on `channel`. */
function aDeliveredRun(kind: string, model = true, once = false, channel = 'dashboard'): void {
  freshBoard();
  if (model) installDecisionModel(doneDb());
  const at = Date.now() - 30_000;
  doneDb().prepare(
    `UPDATE work SET task_kind = ?, title = 'Stretch reminder', goal = 'Remind me every hour to stretch',
       repeat_interval = ?, repeat_unit = 'days', schedule_status = 'running', next_run_at = ? WHERE id = ?`,
  ).run(kind, once ? null : 1, once ? null : Date.now() + 86_400_000, TASK);
  doneDb().prepare(
    `INSERT INTO work (id, kind, parent_id, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, sequence, opened_at, updated_at)
     VALUES ('run-1', 'occurrence', ?, ?, 'schedule', 'schedule', ?, 'open', 'occurrence', 0, 0, 'a run', 1, ?, ?)`,
  ).run(TASK, WORKER, TASK, at, at);
  doneDb().prepare("UPDATE deliveries SET root_kind = 'occurrence', root_id = 'run-1', channel = ?, tool = ? WHERE id = ?")
    .run(channel, channel === 'dashboard' ? 'auto-route' : channel, deliveredToOwner(WORKER, REMINDER));
}

async function runFinishes(): Promise<void> {
  expect(await onTaskRunComplete(TASK, 'complete', 'ran')).toBe(true);
  await vi.dynamicImportSettled();
  await new Promise((r) => setTimeout(r, 100));
}

const decidedBy = (): string | undefined =>
  (doneDb().prepare("SELECT actor FROM work_events WHERE work_id = ? AND kind = 'decided'").get(TASK) as { actor: string } | undefined)?.actor;
const asked = (calls: DecisionCall[]): DecisionCall[] => calls.filter((c) => c.questions.includes('asked'));

/** A turn of WORKER, ended, rooted as given, and the delivery `id` written in it. */
function inTurn(n: number, rootKind: string, rootId: string, id: string): void {
  doneDb().prepare(`INSERT INTO turns (agent_id, turn_number, started_at, ended_at, exit_reason, answered, root_kind, root_id)
    VALUES (?, ?, datetime('now', '-20 seconds'), datetime('now', '-10 seconds'), 'answered', 1, ?, ?)`).run(WORKER, n, rootKind, rootId);
  doneDb().prepare('UPDATE deliveries SET turn_number = ?, root_kind = ?, root_id = ? WHERE id = ?').run(n, rootKind, rootId, id);
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('a reminder the Dojo saw delivered is approved when the model agrees', () => {
  it('the model reads the delivered message as the reminder: the engine approves the run', async () => {
    aDeliveredRun('reminder');
    const calls = scriptDecisions(() => yes(0.9));
    await runFinishes();
    expect(asked(calls)).toHaveLength(1);
    expect(JSON.stringify(asked(calls)[0]!.state)).toContain(REMINDER);
    expect([stateOf(), decidedBy()]).toEqual(['open', 'engine']);
  });

  for (const [why, answer] of [['the model says no', yes(0.3)], ['the model is not sure', { noul: 'unsure' }]] as const) {
    it(`${why}: the run goes to the manager`, async () => {
      aDeliveredRun('reminder');
      const calls = scriptDecisions(() => answer);
      await runFinishes();
      expect(asked(calls)).toHaveLength(1);
      expect([stateOf(), eventCount('decided')]).toEqual(['handed_in', 0]);
    });
  }

  it('with no decision model on the box, the run goes to the manager', async () => {
    aDeliveredRun('reminder', false);
    const calls = scriptDecisions(() => yes(0.9));
    await runFinishes();
    expect(asked(calls)).toHaveLength(0);
    expect([stateOf(), eventCount('decided')]).toEqual(['handed_in', 0]);
  });

  it('a task that owes no message is never asked about and goes to the manager', async () => {
    aDeliveredRun('chore');
    const calls = scriptDecisions(() => yes(0.9));
    await runFinishes();
    expect(asked(calls)).toHaveLength(0);
    expect([stateOf(), eventCount('decided')]).toEqual(['handed_in', 0]);
  });

  for (const channel of ['dashboard', 'imessage', 'sms']) {
    it(`a one-time reminder delivered by ${channel} is closed on its delivery and approved by the engine, not the manager`, async () => {
      aDeliveredRun('reminder', true, true, channel);
      scriptDecisions(() => yes(0.9));
      expect(await closeRunsThatDelivered()).toBe(1);
      await vi.dynamicImportSettled();
      await new Promise((r) => setTimeout(r, 100));
      expect([stateOf(), decidedBy()]).toEqual(['done', 'engine']);
    });
  }

  it('a lone dashboard line from the run\'s own turn closes the run, after the set-up request settled on its confirmation', async () => {
    freshBoard();
    const ask = ownerSays('Remind me in 10 minutes to stretch', { agent: WORKER, at: -120_000 });
    const confirmation = deliveredToOwner(WORKER, 'Set for 1:43 PM.');
    inTurn(1, 'ask', ask, confirmation);
    doneDb().prepare("UPDATE deliveries SET created_at = datetime('now', '-2 minutes') WHERE id = ?").run(confirmation);
    doneDb().prepare(`INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, result_delivery_id, opened_at, updated_at, closed_at)
      VALUES (?, 'ask', ?, 'owner', 'ask', ?, 'done', 'ask', 1, 0, 'ask', ?, ?, ?, ?)`).run(`ask:${ask}`, WORKER, ask, confirmation, Date.now() - 120_000, Date.now(), Date.now());
    doneDb().prepare(`UPDATE work SET task_kind = 'reminder', title = 'Reminder: stretch', source_message_id = ?, schedule_status = 'running' WHERE id = ?`).run(ask, TASK);
    doneDb().prepare(`INSERT INTO work (id, kind, parent_id, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, sequence, opened_at, updated_at)
      VALUES ('run-1', 'occurrence', ?, ?, 'schedule', 'schedule', ?, 'open', 'occurrence', 0, 0, 'a run', 1, ?, ?)`).run(TASK, WORKER, TASK, Date.now() - 30_000, Date.now() - 30_000);
    inTurn(2, 'occurrence', 'run-1', deliveredToOwner(WORKER, 'Time to stretch: you have been at the desk a while.'));
    expect(await closeRunsThatDelivered()).toBe(1);
    expect(doneDb().prepare("SELECT state FROM work WHERE id = 'run-1'").get()).toEqual({ state: 'done' });
  });
});
