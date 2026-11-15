// The main agent may reopen finished work it holds, or whose holder is gone, through every door that reopens:
// the status door (in_progress or on_deck) and a retask. Work whose holder is gone becomes the main agent's.
// A helper may not reopen its own, and a live helper's finished work stays behind the takeover block.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../agent/agent-notice.js', () => ({ redriveWithoutReply: async () => true }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { doneDb } from './helpers/done-db.js';
import { freshBoard, handedIn, call, stateOf, PM, MAIN, WORKER, TASK } from './helpers/decision-world.js';
import { buildWorkBoardLane } from '../../../memory/work-board-lane.js';

async function finishedBoard(holder: string): Promise<void> {
  freshBoard(holder);
  await handedIn(holder);
  await call(PM, 'work_validate', { action: 'open_proof', task_id: TASK, item: 0 });
  const d = await call(PM, 'work_validate', { action: 'decide', task_id: TASK, verdict: 'approve', reason: 'The report meets the goal.' });
  expect(d.isError, d.content).toBe(false);
  expect(stateOf()).toBe('done');
}

const DOORS: Record<string, (as: string) => ReturnType<typeof call>> = {
  'the status door, in_progress': (as) => call(as, 'work_update', { action: 'status', task_id: TASK, status: 'in_progress', notes: 'A section is missing.' }),
  'the status door, on_deck': (as) => call(as, 'work_update', { action: 'status', task_id: TASK, status: 'on_deck', notes: 'A section is missing.' }),
  'a retask': (as) => call(as, 'work_validate', { action: 'retask', task_id: TASK, directive: 'The totals page is missing; add it and send the report again.' }),
};
const holderOf = (): string => (doneDb().prepare('SELECT agent_id FROM work WHERE id = ?').get(TASK) as { agent_id: string }).agent_id;

describe('who may reopen finished work', () => {
  for (const [door, reopen] of Object.entries(DOORS)) {
    it(`the main agent reopens a finished one-shot task it holds itself, by ${door}`, async () => {
      await finishedBoard(MAIN);
      const r = await reopen(MAIN);
      expect(r.isError, r.content).toBe(false);
      expect(stateOf()).not.toBe('done');
    });

    it(`by ${door}, a finished task whose holder has been shut down becomes the main agent's`, async () => {
      await finishedBoard(WORKER);
      doneDb().prepare("UPDATE agents SET status = 'terminated' WHERE id = ?").run(WORKER);
      const r = await reopen(MAIN);
      expect(r.isError, r.content).toBe(false);
      expect(stateOf()).not.toBe('done');
      expect(holderOf()).toBe(MAIN);
      expect(r.content).not.toContain(WORKER);
      expect((await buildWorkBoardLane(MAIN)).activeTasks).toContain('Write the report');
    });
  }

  it('the main agent is refused, in the takeover block\'s words, for a finished task a live helper holds', async () => {
    await finishedBoard(WORKER);
    const r = await DOORS['the status door, on_deck']!(MAIN);
    expect(r.isError).toBe(true);
    expect(r.content).toContain(`is held by agent ${WORKER}, a live agent, and only`);
    expect(stateOf()).toBe('done');
  });

  it('a helper still cannot reopen finished work, even its own', async () => {
    await finishedBoard(WORKER);
    const r = await DOORS['the status door, in_progress']!(WORKER);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('needs the owner, the PM or the main agent');
    expect(stateOf()).toBe('done');
  });
});
