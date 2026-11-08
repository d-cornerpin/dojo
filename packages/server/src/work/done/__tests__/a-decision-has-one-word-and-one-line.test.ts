// A decision is one of four verdicts and one line of reason; anything else is refused at the door and
// the hand-in stays waiting. A refused decision leaves nothing behind, not even its receipt.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { decide } from '../decide.js';
import { freshBoard, handedIn, call, stateOf, PM, TASK } from './helpers/decision-world.js';
import { doneDb } from './helpers/done-db.js';

describe('a decision has one word and one line', () => {
  for (const verdict of ['approved', 'Approve', 'yes']) {
    it(`verdict "${verdict}" is refused, and the task stays handed in`, async () => {
      freshBoard();
      await handedIn();
      const r = await call(PM, 'work_validate', { action: 'decide', task_id: TASK, verdict, reason: 'Looks done' });
      expect(r.isError).toBe(true);
      expect(r.content).toContain('is not a verdict');
      expect(stateOf()).toBe('handed_in');
    });
  }

  it('a reason on more than one line is refused', async () => {
    freshBoard();
    await handedIn();
    const r = await call(PM, 'work_validate', { action: 'decide', task_id: TASK, verdict: 'send_back', reason: 'The totals page\nis missing' });
    expect(r.isError).toBe(true);
    expect(stateOf()).toBe('handed_in');
  });

  it('a decision that fails to land leaves no decision receipt behind', async () => {
    freshBoard();
    doneDb().exec(`CREATE TRIGGER no_close BEFORE UPDATE OF state ON work WHEN NEW.id = '${TASK}' AND NEW.state = 'done' BEGIN SELECT RAISE(ABORT, 'no close'); END`);
    expect(() => decide({ workId: TASK, deciderAgentId: null, verdict: 'owner_done', reason: 'I have it' })).toThrow(/no close/);
    expect((doneDb().prepare("SELECT COUNT(*) AS c FROM deliveries WHERE tool = 'owner-close'").get() as { c: number }).c).toBe(0);
    expect(stateOf()).toBe('claimed');
  });
});
