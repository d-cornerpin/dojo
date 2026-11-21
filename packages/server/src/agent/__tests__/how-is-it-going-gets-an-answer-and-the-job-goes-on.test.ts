// The owner asks how his long job is going while it runs: his question's turn carries the job (one turn chain, so a
// second question ends its stretch at the next step), the question is answered and closed on its own delivery, and
// the job goes on in its own turn from its row.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));

import { runMigrations } from '../../db/migrations.js';
import { nextOwed } from '../v2/owed.js';
import { advance, initState } from '../v2/state.js';
import { turnWindow } from '../v2/steps/post-call-classify/job-turn-end.js';
import { freshAgentsDb, HELPER } from './helpers/agent-requests.js';
import { ownerAsks, stretch, rowOf, tasksOf } from './helpers/long-job.js';

beforeEach(() => { freshAgentsDb(runMigrations); });

const oneStepIn = () => advance(initState({ agentId: HELPER, turnNumber: 2, lastUserMessageContent: null } as unknown as Parameters<typeof initState>[0]), { loopCount: 1 });

describe('how is it going gets an answer and the job goes on', () => {
  it('the status question\'s turn carries the job and is closed; the next turn is the job\'s own', async () => {
    const job = await ownerAsks('m-1');
    await stretch('parks');
    const [task] = tasksOf('m-1');
    const status = await ownerAsks('m-2', 'how is it going?');
    expect(nextOwed(HELPER).map((i) => [i.kind, i.rank])).toEqual([['person', 1], ['job', 3]]);
    let heldInTurn: string | undefined;
    expect(await stretch('answers', () => { heldInTurn = rowOf(job).state; })).toMatchObject({ root: 'm-2', servedJob: task });
    expect(heldInTurn, 'the job\'s request is the carrying turn\'s').toBe('claimed');
    expect(rowOf(status).state).toBe('done');
    expect(rowOf(job).state, 'the job\'s request stays held on its job').toBe('blocked');
    expect(tasksOf('m-2'), 'no second task for the question').toEqual([]);
    expect(await stretch('parks')).toMatchObject({ root: 'm-1', servedJob: task, parkedOn: task });
  });

  it('a second question one step into the carrying turn ends its stretch at the next step', async () => {
    await ownerAsks('m-1');
    await stretch('parks');
    await ownerAsks('m-2', 'how is it going?');
    let window: string | undefined;
    await stretch('parks', async () => {
      expect(turnWindow(oneStepIn(), HELPER)).toBe('open');
      await ownerAsks('m-3', 'how far along are you?');
      window = turnWindow(oneStepIn(), HELPER);
    });
    expect(window).toBe('checkpoint');
  });
});
