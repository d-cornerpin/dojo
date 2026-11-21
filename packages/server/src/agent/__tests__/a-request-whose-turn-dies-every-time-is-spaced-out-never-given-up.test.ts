// A request whose turn dies before finalize spends its serve at pickup. With its asker waiting it is never given up
// for that: each next serve waits longer (1, 5, 15 minutes and on), and it stays owed past its budget.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));

import { runMigrations } from '../../db/migrations.js';
import { a2aRetryBudgetFor } from '../a2a-patience.js';
import { dueOf } from '../v2/owed.js';
import { freshAgentsDb, askerDelegates, helperTurn, requestRow, HELPER } from './helpers/agent-requests.js';

const THREAD = 'thread-crash-loop-0001';

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: Date.now() }); freshAgentsDb(runMigrations); });

describe('a request whose turn dies every time is spaced out, never given up', () => {
  it('each dead turn leaves it unserved and spent; the next serve waits longer; past the budget it is still owed', async () => {
    await askerDelegates('QUESTION', THREAD);
    for (let i = 0; i < a2aRetryBudgetFor(HELPER).turns + 3; i++) {
      expect(await helperTurn('crash'), `serve ${i + 1}`).not.toBeNull();
      expect(requestRow(THREAD)).toMatchObject({ served: null, attempts: i + 1, swept: null });
      expect(await helperTurn('crash'), 'spaced out').toBeNull();
      vi.setSystemTime((dueOf(HELPER).next ?? Date.now()) + 1);
    }
  });
});
