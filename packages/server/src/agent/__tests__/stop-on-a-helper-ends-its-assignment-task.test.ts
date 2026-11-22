// Stop on a helper serving another agent's assignment calls off the asker's piece as the owner's: the request is given
// up, its assignment task is cancelled with the piece (so nobody re-serves it), and the piece says the owner stopped it.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));

import { runMigrations } from '../../db/migrations.js';
import { stopByOwner } from '../runtime.js';
import { stoppedAgents } from '../shared-state.js';
import { nextOwed } from '../v2/owed.js';
import { openTurnContext, endTurnContext } from '../turn-context.js';
import { runPreflight } from '../v2/steps/preflight/index.js';
import { finalizeTurnRecord } from '../v2/steps/teardown/finalize-record.js';
import { latchEngineCut } from '../v2/engine-exit.js';
import { freshAgentsDb, preflightCtx, askerDelegates, pieceState, requestRow, testDb, HELPER } from './helpers/agent-requests.js';

const THREAD = 'thread-assign-0001';
beforeEach(() => { freshAgentsDb(runMigrations); stoppedAgents.clear(); });

describe('stop on a helper ends its assignment task', () => {
  it('the request is given up, its task cancelled as his, and the piece says the owner stopped it', async () => {
    const parent = await askerDelegates('ASSIGN', THREAD);
    const bag = openTurnContext(HELPER);
    const out = await runPreflight(bag, preflightCtx());
    expect(out.directive).toBe('proceed');
    expect(stopByOwner(HELPER)).toMatchObject({ ended: 1 });
    expect(stopByOwner(HELPER), 'a second press finds the request already ended').toMatchObject({ ended: 0 });
    if (out.directive === 'proceed') await finalizeTurnRecord(latchEngineCut(bag.state!, 'stop'), out.outputs.teardownContext());
    endTurnContext(HELPER);

    expect(requestRow(THREAD).swept).not.toBeNull();
    expect(testDb().prepare('SELECT state, next_attempt_at AS due FROM work WHERE agent_id = ? AND a2a_thread_id = ?').get(HELPER, THREAD))
      .toEqual({ state: 'abandoned', due: null });
    expect(nextOwed(HELPER)).toEqual([]);
    await vi.waitFor(() => expect(pieceState(parent)).toBe('abandoned'));
    const why = testDb().prepare("SELECT json_extract(payload, '$.reason') AS r FROM work_events WHERE work_id LIKE 'piece:%' AND kind = 'transition' ORDER BY id DESC LIMIT 1").get() as { r: string };
    expect(why.r).toBe('called off by the owner: he pressed Stop');
  });
});
