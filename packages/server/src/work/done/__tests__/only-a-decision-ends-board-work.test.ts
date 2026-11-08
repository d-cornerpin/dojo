// Only a decision ends board work. `transition()` refuses a task's move to done, failed or abandoned
// without `claim: 'decided'`, for every actor: the engine, the scheduler, the Healer and the PM alike.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { transition, type Actor } from '../../store.js';
import { freshBoard, deliveredToOwner, stateOf, TASK } from './helpers/decision-world.js';

describe('only a decision ends board work', () => {
  for (const by of ['engine', 'scheduler', 'healer', 'pm', 'agent', 'owner'] as Actor[]) {
    for (const to of ['done', 'failed', 'abandoned'] as const) {
      it(`${by} moving a task to ${to} without a decision is refused`, () => {
        freshBoard();
        const d = deliveredToOwner();
        const r = transition(TASK, { to, by, reason: 'the work looks finished', evidenceRef: d, resultDeliveryId: d });
        expect(r.kind).toBe('refused');
        expect(r.kind === 'refused' && r.reason).toBe('needs-decision');
        expect(stateOf()).toBe('claimed');
      });
    }
  }
});
