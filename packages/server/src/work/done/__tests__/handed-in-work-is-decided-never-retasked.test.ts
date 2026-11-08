// Delivered work is never silently regenerated: a task with a hand-in waiting for its decision is
// decided, never retasked over it. Retask still sends open work back to its worker.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../agent/agent-notice.js', () => ({ redriveWithoutReply: async () => true }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { freshBoard, handedIn, call, stateOf, PM, TASK } from './helpers/decision-world.js';

const retask = () => call(PM, 'work_validate', { action: 'retask', task_id: TASK, directive: 'The totals page is missing; add it and send the report again.' });

describe('handed-in work is decided, never retasked', () => {
  it('a retask of a handed-in task is refused and names the decision', async () => {
    freshBoard();
    await handedIn();
    const r = await retask();
    expect(r.isError).toBe(true);
    expect(r.content).toContain('action="decide"');
    expect(stateOf()).toBe('handed_in');
  });

  it('CONTROL: an open task is retasked back to its worker', async () => {
    freshBoard();
    const r = await retask();
    expect(r.content).toMatch(/^\[OK\] Retasked/);
    expect(stateOf()).toBe('claimed');
  });
});
