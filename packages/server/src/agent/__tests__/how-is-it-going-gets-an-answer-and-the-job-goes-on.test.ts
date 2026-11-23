// The owner asks how his long job is going while it runs: his question's turn carries the job (one turn chain, so a
// second question ends its stretch at the next step), the question is answered and closed on its own delivery, and
// the job goes on in its own turn from its row. Worked six calls deep, that turn opens no second task: the six-call
// floor finds the job's task carrying it. A job the question's turn hands in keeps no due time, so its send-back
// starts no extra job turn.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));

import { runMigrations } from '../../db/migrations.js';
import { nextOwed } from '../v2/owed.js';
import { advance, initState } from '../v2/state.js';
import { turnWindow } from '../v2/steps/post-call-classify/job-turn-end.js';
import { turnContext } from '../turn-context.js';
import { countTrackerWorkThisIteration } from '../v2/steps/execute/tracker-counting.js';
import { runTrackerFloors } from '../v2/steps/execute/tracker-floors.js';
import type { ExecuteContext } from '../v2/steps/execute/index.js';
import { engineHandIn } from '../../work/done/hand-in.js';
import { freshAgentsDb, testDb, HELPER } from './helpers/agent-requests.js';
import { ownerAsks, stretch, rowOf, tasksOf } from './helpers/long-job.js';

beforeEach(() => { freshAgentsDb(runMigrations); });

/** Six untracked work calls in the live turn, through the tracker floors. */
async function sixWorkCalls(): Promise<void> {
  const bag = turnContext(HELPER)!;
  const result = { toolCalls: Array.from({ length: 6 }, (_, i) => ({ id: `tc-${i}`, name: 'write_file', arguments: { path: `/tmp/clue${i}.txt`, content: 'x' } })) };
  const state = initState({ agentId: HELPER, contextWindow: 100_000, turnNumber: bag.turnNumber, lastUserMessageContent: 'how is it going?', lastUserMessageId: bag.root?.id ?? null } as unknown as Parameters<typeof initState>[0]);
  const ectx = {
    agentId: HELPER, turnCtx: bag, turnNumber: bag.turnNumber, db: testDb(), agent: { name: 'Helper' }, result,
    counterparty: { kind: 'user', name: 'Owner', relation: 'owner', channel: 'dashboard', senderId: 'owner', threadId: null, senderIsAgent: false },
    counterpartyIsAgentSender: false, chosenConvKey: bag.convKey, engineStartAckDeliveredThisTurn: false, staleTaskWindowMinutes: 45,
  } as unknown as ExecuteContext;
  await runTrackerFloors(countTrackerWorkThisIteration(state, ectx), ectx);
}

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

  it('the question\'s turn works the job six calls deep and the board still holds the one task', async () => {
    await ownerAsks('m-1');
    await stretch('parks');
    const tasks = (): number => (testDb().prepare("SELECT COUNT(*) AS n FROM work WHERE kind = 'task' AND agent_id = ?").get(HELPER) as { n: number }).n;
    expect(tasks()).toBe(1);
    await ownerAsks('m-2', 'how is it going?');
    await stretch('parks', sixWorkCalls);
    expect(tasks()).toBe(1);
  });

  it('the question\'s turn hands the job in and its answer closes it: no due is left and no job turn starts', async () => {
    const job = await ownerAsks('m-1');
    await stretch('parks');
    const [task] = tasksOf('m-1');
    await ownerAsks('m-2', 'how is it going?');
    await stretch('answers', () => expect(engineHandIn(task, 'the hunt is finished', { outcome: 'cant_be_done' }).kind).toBe('handed_in'));
    expect(rowOf(task).due).toBeNull();
    expect([rowOf(job).state, rowOf(task).state], 'the answer closes the request and the task the park opened for it').toEqual(['done', 'done']);
    expect(nextOwed(HELPER).filter((i) => i.kind === 'job')).toEqual([]);
  });
});
