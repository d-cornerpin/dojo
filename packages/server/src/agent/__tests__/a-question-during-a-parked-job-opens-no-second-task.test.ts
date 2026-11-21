// The owner asks how his parked job is going and the question's turn goes on with the job's work: the six-call floor
// finds the job's task carrying the turn and opens no second task.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));

import { runMigrations } from '../../db/migrations.js';
import { turnContext } from '../turn-context.js';
import { initState } from '../v2/state.js';
import { countTrackerWorkThisIteration } from '../v2/steps/execute/tracker-counting.js';
import { runTrackerFloors } from '../v2/steps/execute/tracker-floors.js';
import type { ExecuteContext } from '../v2/steps/execute/index.js';
import { freshAgentsDb, testDb, HELPER } from './helpers/agent-requests.js';
import { ownerAsks, stretch } from './helpers/long-job.js';

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

const tasks = (): number => (testDb().prepare("SELECT COUNT(*) AS n FROM work WHERE kind = 'task' AND agent_id = ?").get(HELPER) as { n: number }).n;

describe('a question during a parked job opens no second task', () => {
  it('the question\'s turn works the job six calls deep and the board still holds the one task', async () => {
    await ownerAsks('m-1');
    await stretch('parks');
    expect(tasks()).toBe(1);
    await ownerAsks('m-2', 'how is it going?');
    await stretch('parks', sixWorkCalls);
    expect(tasks()).toBe(1);
  });
});
