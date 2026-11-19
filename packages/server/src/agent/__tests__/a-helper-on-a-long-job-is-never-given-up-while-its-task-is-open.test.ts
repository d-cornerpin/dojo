// Once its first turn has served an assignment, the open task on its thread owns it: no further turn spends a
// serve on it and it is never given up while the task is open.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));

import { runMigrations } from '../../db/migrations.js';
import { a2aRetryBudgetFor } from '../a2a-patience.js';
import { agentRequests } from '../v2/owed.js';
import { freshAgentsDb, askerDelegates, helperTurn, pieceState, requestRow, HELPER } from './helpers/agent-requests.js';

const THREAD = 'thread-long-job-0001';

beforeEach(() => { freshAgentsDb(runMigrations); });

describe('a helper on a long job is never given up while its task is open', () => {
  it('the assignment is served once; later turns leave it to its task', async () => {
    const ask = await askerDelegates('ASSIGN', THREAD);
    expect(await helperTurn('silent')).not.toBeNull();
    expect(requestRow(THREAD).served).not.toBeNull();
    expect(agentRequests(HELPER)).toEqual([]);
    for (let i = 0; i < a2aRetryBudgetFor(HELPER).turns + 2; i++) expect(await helperTurn('silent')).toBeNull();
    expect(requestRow(THREAD)).toMatchObject({ swept: null, attempts: 1 });
    expect(pieceState(ask)).toBe('open');
  });
});
