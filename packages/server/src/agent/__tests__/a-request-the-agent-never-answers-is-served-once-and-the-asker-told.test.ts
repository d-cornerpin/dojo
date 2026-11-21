// Another agent's request the helper never answers, with its asker waiting, is served once: a turn that ends silent
// leaves nothing owed, so no second turn is paid for it, and the next look settles the asker's piece and tells it once.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));

import { runMigrations } from '../../db/migrations.js';
import { sweepExpiredJoins } from '../a2a-transport.js';
import { freshAgentsDb, askerDelegates, helperTurn, pieceState, requestRow, testDb, HELPER } from './helpers/agent-requests.js';

const THREAD = 'thread-never-answered-0001';

beforeEach(() => { freshAgentsDb(runMigrations); });

describe('a request the agent never answers is served once and the asker told', () => {
  it('one silent serve, no second turn, the piece settled once at the next look', async () => {
    const ask = await askerDelegates('QUESTION', THREAD);
    expect(await helperTurn('silent')).not.toBeNull();
    expect(await helperTurn('silent'), 'nothing is owed after a silent serve: the preflight ends it, no model call').toBeNull();
    testDb().prepare('UPDATE work SET ttl_at = ? WHERE id = ?').run(Date.now() - 1, ask);
    await sweepExpiredJoins();
    await sweepExpiredJoins();
    expect([pieceState(ask), requestRow(THREAD).swept]).toEqual(['abandoned', null]);
  });
});
