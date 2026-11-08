// The decider opens the proof before it approves: the engine records each open (`proof_opened`) and
// refuses an approval that relies on an item this decider never opened. A send-back needs no open.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { freshBoard, handedIn, call, stateOf, eventCount, PM, WORKER, TASK } from './helpers/decision-world.js';

describe('an approval needs the proof opened', () => {
  it('approve without open_proof is refused and names the item to open', async () => {
    freshBoard();
    await handedIn();
    const r = await call(PM, 'work_validate', { action: 'decide', task_id: TASK, verdict: 'approve', reason: 'Looks done' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('open_proof');
    expect(stateOf()).toBe('handed_in');
  });

  it('open_proof shows the worker\'s own message, records the open, and then the approval lands', async () => {
    freshBoard();
    await handedIn();
    const opened = await call(PM, 'work_validate', { action: 'open_proof', task_id: TASK, item: 0 });
    expect(opened.content).toContain("the worker's own message to the asker");
    expect(opened.content).toContain('the totals are on page 3');
    expect(eventCount('proof_opened')).toBe(1);
    const r = await call(PM, 'work_validate', { action: 'decide', task_id: TASK, verdict: 'approve', reason: 'The report reached the owner' });
    expect(r.isError).toBe(false);
    expect(stateOf()).toBe('done');
  });

  it('a send-back carries its reason, needs no open, and the worker reads why when it continues', async () => {
    freshBoard();
    await handedIn();
    const r = await call(PM, 'work_validate', { action: 'decide', task_id: TASK, verdict: 'send_back', reason: 'The totals page is missing' });
    expect(r.isError).toBe(false);
    expect(stateOf()).toBe('sent_back');
    expect(eventCount('decided')).toBe(1);
    const read = await call(WORKER, 'work_update', { action: 'get', task_id: TASK });
    expect(read.content).toContain('Last decision: SENT BACK, The totals page is missing');
  });

  it('a decision with no reason is refused', async () => {
    freshBoard();
    await handedIn();
    const r = await call(PM, 'work_validate', { action: 'decide', task_id: TASK, verdict: 'send_back', reason: '  ' });
    expect(r.isError).toBe(true);
    expect(stateOf()).toBe('handed_in');
  });
});
