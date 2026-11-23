// A finished run of a task that owes a person a message, whose delivered message the engine tied to the run, is
// approved by the engine with no model call and no manager (8.6.15). A task that owes no message goes to the manager
// as before, whatever its run said. A one-time reminder's only run is its
// final one, decided the same way on whichever channel it went. A reminder asked on the dashboard, whose request settled
// on the agent's confirmation, closes on the one line its run's own turn wrote there: that line is never a start line.
// A reminder a contact asked for by text is never closed on the owner's dashboard copy: it stays not delivered. One the
// owner asked for by text is not closed on a dashboard line either; a send to him on another of his channels closes it.
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import '../../../agent/decision-ask.js';
import { closeRunsThatDelivered, onTaskRunComplete } from '../../../scheduler/runner.js';
import { freshBoard, deliveredToOwner, ownerSays, stateOf, eventCount, WORKER, TASK } from './helpers/decision-world.js';
import { doneDb } from './helpers/done-db.js';
import { turnRow } from '../../../agent/v2/__tests__/helpers/live-turn.js';
import { installDecisionModel, scriptDecisions, yes, type DecisionCall } from '../../../agent/__tests__/decision-fake.js';

const REMINDER = 'Time to stretch: stand up and roll your shoulders.';
const OWNER_PHONE = '+15550000001';

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
  doneDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('imessage_approved_senders', ?)")
    .run(JSON.stringify([{ address: OWNER_PHONE, name: 'Owner', is_primary: true, sharing_level: 'full' }]));
  doneDb().prepare("UPDATE deliveries SET turn_number = ?, root_kind = 'occurrence', root_id = 'run-1', channel = ?, tool = ?, recipient_id = ? WHERE id = ?")
    .run(turnRow(WORKER, 900, { kind: 'occurrence', id: 'run-1' }), channel, channel === 'dashboard' ? 'auto-route' : channel,
      channel === 'dashboard' ? null : OWNER_PHONE, deliveredToOwner(WORKER, REMINDER));
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

describe('a reminder the Dojo saw delivered is closed by the engine', () => {
  for (const model of [true, false]) {
    it(`the run delivered the reminder: the engine approves it, asking no model${model ? '' : ' (none on the box)'}`, async () => {
      aDeliveredRun('reminder', model);
      const calls = scriptDecisions(() => yes(0.1));
      await runFinishes();
      expect(asked(calls)).toHaveLength(0);
      expect([stateOf(), decidedBy()]).toEqual(['open', 'engine']);
    });
  }

  it('a task that owes no message is not closed on a line its run delivered: it goes to the manager', async () => {
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

  it('the line that set the reminder up, in the turn that created the schedule, is no run: nothing closes or is decided', async () => {
    freshBoard();
    const ask = ownerSays('Remind me in 10 minutes to stretch', { agent: WORKER });
    inTurn(1, 'ask', ask, deliveredToOwner(WORKER, 'Set for 1:43 PM.'));
    doneDb().prepare(`UPDATE work SET task_kind = 'reminder', source_message_id = ?, schedule_status = 'running' WHERE id = ?`).run(ask, TASK);
    expect(await closeRunsThatDelivered()).toBe(0);
    expect(eventCount('decided')).toBe(0);
  });

  it('a contact asked by text, and only the owner\'s dashboard copy went out: the run is not closed', async () => {
    aDeliveredRun('reminder', true, true, 'dashboard');
    doneDb().prepare(`INSERT INTO messages (id, agent_id, conversation_id, lane, role, content, channel, sender_id, authorized, inbound_meta, sent_at, created_at)
      VALUES ('m-contact', ?, 'conv-contact', 'owner', 'user', 'Remind me at six to feed the cat', 'sms', '+15550001111', 1, ?, ?, ?)`)
      .run(WORKER, JSON.stringify({ channel: 'sms', sender: '+15550001111', relation: 'known_contact' }), Date.now() - 60_000, Date.now() - 60_000);
    doneDb().prepare("UPDATE work SET source_message_id = 'm-contact' WHERE id = ?").run(TASK);
    expect(await closeRunsThatDelivered()).toBe(0);
    expect(doneDb().prepare("SELECT state FROM work WHERE id = 'run-1'").get()).toEqual({ state: 'open' });
    doneDb().prepare("UPDATE deliveries SET turn_number = ?, root_kind = 'occurrence', root_id = 'run-1', channel = 'sms', tool = 'sms', recipient_id = '+15550001111' WHERE id = ?")
      .run(turnRow(WORKER, 901, { kind: 'occurrence', id: 'run-1' }), deliveredToOwner(WORKER, 'Time to feed the cat.'));
    expect(await closeRunsThatDelivered()).toBe(1);   // the text that reached the contact closes it
  });

  it('the owner asked by text: his dashboard line does not close the run; an email to his own mailbox does', async () => {
    aDeliveredRun('reminder', true, true, 'dashboard');
    scriptDecisions(() => yes(0.9));
    const ask = ownerSays('Remind me at six to feed the cat', { agent: WORKER, channel: 'imessage',
      inbound_meta: JSON.stringify({ channel: 'imessage', sender: OWNER_PHONE, relation: 'owner', authorized: true }) });
    doneDb().prepare('UPDATE work SET source_message_id = ? WHERE id = ?').run(ask, TASK);
    expect(await closeRunsThatDelivered()).toBe(0);
    doneDb().prepare("INSERT INTO google_accounts (id, kind, position, email, connected) VALUES ('g-owner', 'user', 0, 'owner@example.com', 1)").run();
    doneDb().prepare("UPDATE deliveries SET turn_number = ?, root_kind = 'occurrence', root_id = 'run-1', channel = 'email', tool = 'email_send', recipient_id = 'owner@example.com' WHERE id = ?")
      .run(turnRow(WORKER, 902, { kind: 'occurrence', id: 'run-1' }), deliveredToOwner(WORKER, 'Time to feed the cat.'));
    expect(await closeRunsThatDelivered()).toBe(1);
    await vi.dynamicImportSettled();
    await new Promise((r) => setTimeout(r, 100));
    expect([stateOf(), decidedBy()]).toEqual(['done', 'engine']);
  });
});
