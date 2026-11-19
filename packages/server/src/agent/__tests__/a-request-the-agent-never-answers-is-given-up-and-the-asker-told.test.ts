// Another agent's request the helper never answers is served its budget of turns; the next pickup gives it up and
// settles the asker's join piece abandoned, so the asker is told, and the turn serves whatever is owed next.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));

import { runMigrations } from '../../db/migrations.js';
import { a2aRetryBudgetFor } from '../a2a-patience.js';
import { freshAgentsDb, askerDelegates, helperTurn, pieceState, requestRow, HELPER } from './helpers/agent-requests.js';

const THREAD = 'thread-never-answered-0001';

beforeEach(() => { freshAgentsDb(runMigrations); });

describe('a request the agent never answers is given up and the asker told', () => {
  it('after its budget of silent turns the request is swept and the join piece is abandoned', async () => {
    const ask = await askerDelegates('QUESTION', THREAD);
    const budget = a2aRetryBudgetFor(HELPER).turns;
    for (let i = 0; i < budget; i++) expect(await helperTurn('silent'), `serve ${i + 1}`).not.toBeNull();
    expect(pieceState(ask)).toBe('open');
    expect(await helperTurn('silent'), 'the pickup past the budget serves nothing').toBeNull();
    expect(requestRow(THREAD).swept).not.toBeNull();
    await vi.waitFor(() => expect(pieceState(ask)).toBe('abandoned'));
    expect(await helperTurn('silent')).toBeNull();
  });
});
