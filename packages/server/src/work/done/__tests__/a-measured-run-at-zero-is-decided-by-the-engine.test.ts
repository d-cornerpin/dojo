// A finished run whose measure the engine itself counts at 0 is approved by the engine, pointing at the run, when the
// task's creator set that measure (at the opening, when the creator also works it), and the Dojo recorded the run
// complete. Anything else, a run that owed a message and delivered none included, goes to the manager.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../agent/runtime.js', async () => (await import('./helpers/ladder-world.js')).runtimeMock());
const { countMeasure } = vi.hoisted(() => ({ countMeasure: vi.fn() }));
vi.mock('../../../work/measure.js', async (orig) => ({ ...(await orig<typeof import('../../../work/measure.js')>()), countMeasure }));
vi.mock('../../../agent/tools/gates.js', async (orig) => ({ ...(await orig<typeof import('../../../agent/tools/gates.js')>()), gatesForCall: () => [] }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { onTaskRunComplete } from '../../../scheduler/runner.js';
import { freshBoard, deliveredToOwner, stateOf, eventCount, MAIN, WORKER, TASK } from './helpers/decision-world.js';
import { doneDb } from './helpers/done-db.js';

const MEASURE = { tool: 'gmail_search', args: { query: 'in:inbox' }, unit: 'messages' };

/** A live daily schedule worked by WORKER, created by `creator`, its measure last set by `setter` (none: before the
 *  update) at 5 and read at 0 during the run. */
function aCountedRun(creator: string, setter: { setBy: string; atOpen?: true } | null): void {
  freshBoard();
  const at = Date.now() - 30_000;
  doneDb().prepare(
    `UPDATE work SET requester = 'agent', requester_id = ?, measure_json = ?, measure_initial = 5, measure_remaining = 5, measure_at = ?,
       repeat_interval = 1, repeat_unit = 'days', schedule_status = 'running', next_run_at = ? WHERE id = ?`,
  ).run(creator, JSON.stringify(MEASURE), at, Date.now() + 86_400_000, TASK);
  const by = setter ? { set_by: setter.setBy, ...(setter.atOpen ? { at_open: true } : {}) } : {};
  doneDb().prepare("INSERT INTO work_events (work_id, kind, actor, payload, created_at) VALUES (?, 'measured', 'engine', ?, ?)")
    .run(TASK, JSON.stringify({ remaining: 5, initial: 5, at, ok: true, ...by }), at);
  doneDb().prepare("INSERT INTO work_events (work_id, kind, actor, payload, created_at) VALUES (?, 'measured', 'engine', ?, ?)")
    .run(TASK, JSON.stringify({ remaining: 0, initial: 5, at, ok: true }), at);
  doneDb().prepare('UPDATE work SET measure_remaining = 0 WHERE id = ?').run(TASK);
  doneDb().prepare(
    `INSERT INTO work (id, kind, parent_id, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, sequence, opened_at, updated_at)
     VALUES ('run-1', 'occurrence', ?, ?, 'schedule', 'schedule', ?, 'open', 'occurrence', 0, 0, 'a run', 1, ?, ?)`,
  ).run(TASK, WORKER, TASK, at, at);
  deliveredToOwner();
}

/** The run finishes; the engine re-counts (`left`) and decides, or leaves the hand-in for the manager. */
async function runFinishes(left: number): Promise<void> {
  countMeasure.mockReset();
  countMeasure.mockResolvedValue({ ok: true, count: left });
  expect(await onTaskRunComplete(TASK, 'complete', 'ran')).toBe(true);
  await vi.waitFor(() => expect(countMeasure).toHaveBeenCalled());
  await vi.dynamicImportSettled();
  await new Promise((r) => setTimeout(r, 50));
}

const engineDecision = () => doneDb().prepare(
  "SELECT e.actor, json_extract(t.payload, '$.evidence_ref') AS evidence FROM work_events e LEFT JOIN work_events t ON t.work_id = e.work_id AND t.kind = 'transition' AND t.id > e.id WHERE e.work_id = ? AND e.kind = 'decided'",
).get(TASK) as { actor: string; evidence: string | null } | undefined;

describe('a measured run at zero is decided by the engine', () => {
  it('the creator\'s measure, counted at 0 by the engine, is approved by the engine and points at the run', async () => {
    aCountedRun(MAIN, { setBy: MAIN });
    await runFinishes(0);
    expect(stateOf()).toBe('open');
    expect(engineDecision()).toEqual({ actor: 'engine', evidence: 'run-1' });
  });

  it('a run whose count does not read 0 goes to the manager', async () => {
    aCountedRun(MAIN, { setBy: MAIN });
    await runFinishes(2);
    expect(stateOf()).toBe('handed_in');
    expect(eventCount('decided')).toBe(0);
  });

  for (const [why, creator, setter] of [
    ['a measure set by an agent that is not the creator', MAIN, { setBy: WORKER }],
    ['the working creator\'s later change of its own measure', WORKER, { setBy: WORKER }],
    ['a measure from before the update, with no setter', MAIN, null],
  ] as const) {
    it(`${why} goes to the manager`, async () => {
      aCountedRun(creator, setter);
      await runFinishes(0);
      expect(stateOf()).toBe('handed_in');
      expect(eventCount('decided')).toBe(0);
    });
  }

  it('the working creator\'s measure set at the opening is decided by the engine', async () => {
    aCountedRun(WORKER, { setBy: WORKER, atOpen: true });
    await runFinishes(0);
    expect(stateOf()).toBe('open');
    expect(engineDecision()?.actor).toBe('engine');
  });

  it('a run that owed a message and delivered none goes to the manager, even at 0', async () => {
    aCountedRun(MAIN, { setBy: MAIN });
    doneDb().prepare("UPDATE work SET task_kind = 'report' WHERE id = ?").run(TASK);
    await runFinishes(0);
    expect(stateOf()).toBe('handed_in');
    expect(eventCount('decided')).toBe(0);
  });
});
