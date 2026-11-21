// A finished run of a task that owes a person a message, whose delivered message the engine tied to the run, is
// approved by the engine when the small local model reads that message as what the task owes. A no, no answer, no
// model, or a task that owes no message: the run goes to the manager as before.
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import '../../../agent/decision-ask.js';
import { onTaskRunComplete } from '../../../scheduler/runner.js';
import { freshBoard, deliveredToOwner, stateOf, eventCount, WORKER, TASK } from './helpers/decision-world.js';
import { doneDb } from './helpers/done-db.js';
import { installDecisionModel, scriptDecisions, yes, type DecisionCall } from '../../../agent/__tests__/decision-fake.js';

const REMINDER = 'Time to stretch: stand up and roll your shoulders.';

/** A live daily schedule of kind `kind` worked by WORKER, whose open run delivered REMINDER to the owner. */
function aDeliveredRun(kind: string, model = true): void {
  freshBoard();
  if (model) installDecisionModel(doneDb());
  const at = Date.now() - 30_000;
  doneDb().prepare(
    `UPDATE work SET task_kind = ?, title = 'Stretch reminder', goal = 'Remind me every hour to stretch',
       repeat_interval = 1, repeat_unit = 'days', schedule_status = 'running', next_run_at = ? WHERE id = ?`,
  ).run(kind, Date.now() + 86_400_000, TASK);
  doneDb().prepare(
    `INSERT INTO work (id, kind, parent_id, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, sequence, opened_at, updated_at)
     VALUES ('run-1', 'occurrence', ?, ?, 'schedule', 'schedule', ?, 'open', 'occurrence', 0, 0, 'a run', 1, ?, ?)`,
  ).run(TASK, WORKER, TASK, at, at);
  doneDb().prepare("UPDATE deliveries SET root_kind = 'occurrence', root_id = 'run-1' WHERE id = ?").run(deliveredToOwner(WORKER, REMINDER));
}

async function runFinishes(): Promise<void> {
  expect(await onTaskRunComplete(TASK, 'complete', 'ran')).toBe(true);
  await vi.dynamicImportSettled();
  await new Promise((r) => setTimeout(r, 100));
}

const decidedBy = (): string | undefined =>
  (doneDb().prepare("SELECT actor FROM work_events WHERE work_id = ? AND kind = 'decided'").get(TASK) as { actor: string } | undefined)?.actor;
const asked = (calls: DecisionCall[]): DecisionCall[] => calls.filter((c) => c.questions.includes('asked'));

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
});
