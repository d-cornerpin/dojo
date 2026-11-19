// A request whose turn dies before finalize spends its serve at pickup, so a crash loop on it ends at the same
// budget as a request answered with silence.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));

import { runMigrations } from '../../db/migrations.js';
import { a2aRetryBudgetFor } from '../a2a-patience.js';
import { freshAgentsDb, askerDelegates, helperTurn, requestRow, HELPER } from './helpers/agent-requests.js';

const THREAD = 'thread-crash-loop-0001';

beforeEach(() => { freshAgentsDb(runMigrations); });

describe('a request whose turn dies every time is given up at the same count', () => {
  it('each dead turn leaves it unserved but spent; the pickup past the budget gives it up', async () => {
    await askerDelegates('QUESTION', THREAD);
    const budget = a2aRetryBudgetFor(HELPER).turns;
    for (let i = 0; i < budget; i++) {
      expect(await helperTurn('crash')).not.toBeNull();
      expect(requestRow(THREAD)).toMatchObject({ served: null, attempts: i + 1, swept: null });
    }
    expect(await helperTurn('crash')).toBeNull();
    expect(requestRow(THREAD).swept).not.toBeNull();
  });
});
