// The owner can mark a task done at any time before it is finished, including one sent back to its worker.
import { it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { decide } from '../decide.js';
import { freshBoard, handedIn, call, stateOf, PM, TASK } from './helpers/decision-world.js';

it('a sent-back task the owner marks done ends done', async () => {
  freshBoard();
  await handedIn();
  await call(PM, 'work_validate', { action: 'decide', task_id: TASK, verdict: 'send_back', reason: 'The totals are missing' });
  expect(stateOf()).toBe('sent_back');
  const r = decide({ workId: TASK, deciderAgentId: null, verdict: 'owner_done', reason: 'Good enough' });
  expect(r.kind).toBe('decided');
  expect(stateOf()).toBe('done');
});
