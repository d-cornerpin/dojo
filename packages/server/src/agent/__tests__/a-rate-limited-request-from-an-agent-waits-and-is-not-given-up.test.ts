// A rate limit on the first call of a turn serving another agent's request gives its serve back and makes it wait
// for the provider's reset: it is never given up for it, the asker's join stays open, and the clock knows when.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));

import { runMigrations } from '../../db/migrations.js';
import { nextOwed, dueOf } from '../v2/owed.js';
import { freshAgentsDb, askerDelegates, helperTurn, pieceState, requestRow, HELPER } from './helpers/agent-requests.js';

const THREAD = 'thread-rate-limited-0001';

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: Date.now() }); freshAgentsDb(runMigrations); });

describe('a rate-limited request from an agent waits and is not given up', () => {
  it('limit after limit, the request waits uncounted for each reset and is served again at it', async () => {
    const ask = await askerDelegates('QUESTION', THREAD);
    for (let i = 0; i < 6; i++) {
      const reset = Date.now() + 5 * 60_000;
      expect(await helperTurn('limit', reset), `limited serve ${i + 1}`).not.toBeNull();
      expect(requestRow(THREAD)).toEqual({ served: null, swept: null, attempts: 0, due: reset });
      expect(nextOwed(HELPER).some((o) => o.kind === 'agentRequest'), 'not owed before the reset').toBe(false);
      expect(dueOf(HELPER).next, 'the clock wakes the helper at the reset').toBe(reset);
      vi.setSystemTime(reset + 1);
    }
    expect(pieceState(ask)).toBe('open');
    expect(await helperTurn('silent')).not.toBeNull();
    expect(requestRow(THREAD)).toMatchObject({ attempts: 1, swept: null });
    expect(requestRow(THREAD).served).not.toBeNull();
  });
});
