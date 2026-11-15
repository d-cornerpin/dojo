// Retask is the PM's move, and the main agent's too; any other agent is refused.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../agent/agent-notice.js', () => ({ redriveWithoutReply: async () => true }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { doneDb } from './helpers/done-db.js';
import { freshBoard, handedIn, call, stateOf, PM, MAIN, OTHER, WORKER, TASK } from './helpers/decision-world.js';

const retask = (as: string) => call(as, 'work_validate', { action: 'retask', task_id: TASK, directive: 'The totals page is missing; add it and send the report again.' });

describe('who may retask open work', () => {
  it('the main agent retasks the task back to its worker and the retask is on the record as its own', async () => {
    freshBoard();
    const r = await retask(MAIN);
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/^\[OK\] Retasked/);
    expect(stateOf()).toBe('claimed');
    const row = doneDb().prepare("SELECT actor FROM work_events WHERE work_id = ? AND kind = 'audit'").all(TASK) as Array<{ actor: string }>;
    expect(row.map((e) => e.actor).join('\n')).toContain(`agent:${MAIN}`);
  });

  it('another agent is still refused and the task is untouched', async () => {
    freshBoard();
    const r = await retask(OTHER);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/only the PM agent and the main agent/);
    expect(stateOf()).toBe('claimed');
    expect(doneDb().prepare("SELECT COUNT(*) AS c FROM work_events WHERE work_id = ? AND kind = 'audit'").get(TASK)).toEqual({ c: 0 });
  });

  it("the main agent cannot reopen a finished task another live agent holds, and the takeover block says so", async () => {
    freshBoard();
    await handedIn();
    await call(PM, 'work_validate', { action: 'open_proof', task_id: TASK, item: 0 });
    const d = await call(PM, 'work_validate', { action: 'decide', task_id: TASK, verdict: 'approve', reason: 'The report meets the goal.' });
    expect(d.isError, d.content).toBe(false);
    expect(stateOf()).toBe('done');
    const r = await retask(MAIN);
    expect(r.content).toContain(`is held by agent ${WORKER}, a live agent, and only`);
    expect(r.isError).toBe(true);
    expect(stateOf()).toBe('done');
  });
});
