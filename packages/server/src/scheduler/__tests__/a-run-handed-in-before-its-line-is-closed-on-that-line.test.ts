// A status note every ten minutes: in each run's own turn the agent writes its notes file, hands the run in, and only
// then writes its one line to the owner. The run waits for its turn to end and closes on that line: no "finished
// without delivering anything" alert, three runs in a row. A run handed in whose turn wrote nothing is still told.
// A hand-in the engine did not leave for its turn's end (a one-time task's, with no run scope), or one taken up once
// whose schedule then failed to advance, is not picked up again by every later tick.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/v2/loop.js', () => ({ runV2Turn: async () => {} }));
const advance = vi.hoisted(() => ({ fails: false, calls: 0 }));
vi.mock('../runner.js', async (orig) => {
  const m = await orig<typeof import('../runner.js')>();
  return { ...m, onTaskRunComplete: async (...a: Parameters<typeof m.onTaskRunComplete>) => {
    if (!advance.fails) return m.onTaskRunComplete(...a);
    advance.calls += 1;
    throw new Error('the schedule could not be written');
  } };
});
const box = await import('./helpers/missed-runs-box.js');
const { openTurnContext, endTurnContext } = await import('../../agent/turn-context.js');
const { closeRunsThatDelivered } = await import('../runner.js');

beforeAll(() => box.openBox());
afterAll(() => box.closeBox());

const runs = (id: string) => box.db().prepare("SELECT id, state FROM work WHERE kind = 'occurrence' AND parent_id = ? ORDER BY sequence").all(id) as Array<{ id: string; state: string }>;
const ghosts = (): number => (box.db().prepare("SELECT COUNT(*) AS n FROM work_events WHERE kind = 'floor_ghosted'").get() as { n: number }).n;
let turn = 0;
const sqlNow = (): string => new Date().toISOString().replace('T', ' ').slice(0, 19);

/** One run's own turn: the notes file, the hand-in, then (when `line`) the line to the owner; then the turn ends. */
async function runTurn(task: string, line: boolean): Promise<void> {
  const run = runs(task).at(-1)!.id;
  turn += 1;
  box.db().prepare("INSERT INTO turns (agent_id, turn_number, started_at, answered, root_kind, root_id) VALUES (?, ?, ?, 0, 'occurrence', ?)").run(box.MAIN, turn, sqlNow(), run);
  Object.assign(openTurnContext(box.MAIN), { turnNumber: turn, root: { kind: 'occurrence', id: run, sourceMessageId: null } });
  const notes = path.join(process.env.DOJO_HOME!, 'status-notes.md');
  expect((await box.call('file_write', { path: notes, content: `run ${turn}: all lists finished` })).isError).toBeFalsy();
  const handIn = await box.call('work_update', { action: 'hand_in', task_id: task, outcome: 'finished', proof: [{ kind: 'file', ref: notes }], note: 'status written' });
  expect(handIn.isError, handIn.content).toBeFalsy();
  await vi.dynamicImportSettled();   // the hand-in's effects have run before the model's next pass writes the line
  await new Promise((r) => setTimeout(r, 50));
  if (line) {
    box.db().prepare(`INSERT INTO messages (id, agent_id, lane, role, content, authorized, turn_number, created_at) VALUES (?, ?, 'owner', 'assistant', ?, 1, ?, ?)`)
      .run(`line-${turn}`, box.MAIN, `Status: all lists finished (run ${turn}).`, turn, Date.now());
    box.db().prepare(`INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, root_kind, root_id, message_id, outcome, created_at, updated_at)
      VALUES (?, ?, ?, 'auto-route', 'dashboard', 'occurrence', ?, ?, 'delivered', ?, ?)`).run(`d-${turn}`, box.MAIN, turn, run, `line-${turn}`, sqlNow(), sqlNow());
  }
  endTurnContext(box.MAIN);
  box.db().prepare("UPDATE turns SET ended_at = ?, exit_reason = 'answered' WHERE agent_id = ? AND turn_number = ?").run(sqlNow(), box.MAIN, turn);
  await closeRunsThatDelivered();
  await vi.dynamicImportSettled();
}

describe('a run handed in before its line is closed on that line', () => {
  it('three runs, each handed in before its line, close done with no false "not delivered" alert', async () => {
    box.at('2026-03-02T12:00:00Z');
    const made = await box.call('work_open', { kind: 'task', title: 'Status note', goal: 'a one-line status every ten minutes', scheduled_start: '2026-03-02T12:05:00Z', repeat_interval: 10, repeat_unit: 'minutes' });
    const task = /task_id=([\w-]+)/.exec(made.content)![1]!;
    box.db().prepare("UPDATE work SET task_kind = 'notify' WHERE id = ?").run(task);
    for (const at of ['12:05:30', '12:15:30', '12:25:30']) {
      box.at(`2026-03-02T${at}Z`);
      await box.checkScheduledTasks();
      await runTurn(task, true);
    }
    expect(runs(task).map((r) => r.state)).toEqual(['done', 'done', 'done']);
    expect(ghosts()).toBe(0);

    box.at('2026-03-02T12:35:30Z');
    await box.checkScheduledTasks();
    await runTurn(task, false);
    expect(runs(task).at(-1)!.state, 'recorded undelivered').toBe('abandoned');
    expect(ghosts()).toBe(1);
  });

  it('a one-time task handed in during its run is not taken up again by each later tick', async () => {
    box.at('2026-03-03T09:00:00Z');
    const made = await box.call('work_open', { kind: 'task', title: 'Water note', goal: 'one line about the plants', scheduled_start: '2026-03-03T09:05:00Z' });
    const task = /task_id=([\w-]+)/.exec(made.content)![1]!;
    box.db().prepare("UPDATE work SET task_kind = 'notify' WHERE id = ?").run(task);
    box.at('2026-03-03T09:05:30Z');
    await box.checkScheduledTasks();
    await runTurn(task, true);
    expect([await closeRunsThatDelivered(), await closeRunsThatDelivered()]).toEqual([0, 0]);
  });

  it('a run taken up once whose schedule fails to advance is not taken up again by each later tick', async () => {
    box.at('2026-03-04T08:00:00Z');
    const made = await box.call('work_open', { kind: 'task', title: 'Bin note', goal: 'a line about the bins every ten minutes', scheduled_start: '2026-03-04T08:05:00Z', repeat_interval: 10, repeat_unit: 'minutes' });
    const task = /task_id=([\w-]+)/.exec(made.content)![1]!;
    box.db().prepare("UPDATE work SET task_kind = 'notify' WHERE id = ?").run(task);
    box.at('2026-03-04T08:05:30Z');
    await box.checkScheduledTasks();
    advance.fails = true;
    await runTurn(task, false);
    expect([await closeRunsThatDelivered(), await closeRunsThatDelivered(), advance.calls]).toEqual([0, 0, 1]);
    advance.fails = false;
  });
});
