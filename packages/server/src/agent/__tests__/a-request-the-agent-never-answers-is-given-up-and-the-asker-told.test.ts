// Another agent's request the helper never answers is served its first time and its budget of retries; the next
// pickup gives it up, settles the asker's join piece abandoned (so the asker is told) and ends the turn there.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));

import { runMigrations } from '../../db/migrations.js';
import { a2aRetryBudgetFor } from '../a2a-patience.js';
import { freshAgentsDb, askerDelegates, helperTurn, pieceState, requestRow, testDb, HELPER } from './helpers/agent-requests.js';

const turns = (): number => (testDb().prepare('SELECT COUNT(*) AS n FROM turns WHERE agent_id = ?').get(HELPER) as { n: number }).n;

const THREAD = 'thread-never-answered-0001';

beforeEach(() => { freshAgentsDb(runMigrations); });

describe('a request the agent never answers is given up and the asker told', () => {
  it('after its serves the request is swept, the join piece is abandoned, and the give-up turn makes no model call', async () => {
    const ask = await askerDelegates('QUESTION', THREAD);
    const serves = a2aRetryBudgetFor(HELPER).turns + 1;
    for (let i = 0; i < serves; i++) expect(await helperTurn('silent'), `serve ${i + 1}`).not.toBeNull();
    expect(pieceState(ask)).toBe('open');
    const before = turns();
    expect(await helperTurn('silent'), 'the pickup past the budget serves nothing').toBeNull();
    expect(turns(), 'the turn ended in its preflight: no turn record, no model call').toBe(before);
    expect(requestRow(THREAD).swept).not.toBeNull();
    await vi.waitFor(() => expect(pieceState(ask)).toBe('abandoned'));
    expect(await helperTurn('silent')).toBeNull();
  });
});
