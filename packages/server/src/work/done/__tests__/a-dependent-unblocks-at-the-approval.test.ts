// A task that depends on another waits for that work to be accepted, not merely delivered: it stays
// waiting while its dependency is handed in, and starts when the dependency is approved.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { freshBoard, handedIn, call, stateOf, PM, WORKER, TASK } from './helpers/decision-world.js';
import { doneDb } from './helpers/done-db.js';

describe('a dependent unblocks at the approval', () => {
  it('stays open while its dependency is handed in, and starts when the dependency is approved', async () => {
    freshBoard();
    const at = Date.now() - 60_000;
    doneDb().prepare(
      `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, depends_on, opened_at, updated_at)
       VALUES ('dep-1', 'task', ?, 'owner', 'tracker', 'dep-1', 'open', 'task', 1, 0, 'Send the report on', ?, ?, ?)`,
    ).run(WORKER, JSON.stringify([TASK]), at, at);
    await handedIn();
    expect(stateOf('dep-1')).toBe('open');
    await call(PM, 'work_validate', { action: 'open_proof', task_id: TASK, item: 0 });
    expect((await call(PM, 'work_validate', { action: 'decide', task_id: TASK, verdict: 'approve', reason: 'The report reached the owner' })).isError).toBe(false);
    expect(stateOf('dep-1')).toBe('claimed');
  });
});
