// A person who writes while a job's own turn (or a turn serving no person) runs ends that stretch at its next step,
// inside its window: the job parks and the person is served next. A person's own turn keeps its window.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));

import { runMigrations } from '../../db/migrations.js';
import { initState, advance } from '../v2/state.js';
import { turnWindow } from '../v2/steps/post-call-classify/job-turn-end.js';
import { openTurnContext, endTurnContext } from '../turn-context.js';
import { getWaitingHumanConversations } from '../v2/counterparty.js';
import { freshAgentsDb, testDb, HELPER } from './helpers/agent-requests.js';
import { ownerAsks } from './helpers/long-job.js';

beforeEach(() => { freshAgentsDb(runMigrations); endTurnContext(HELPER); });

const tenStepsIn = () => advance(initState({ agentId: HELPER, turnNumber: 2, lastUserMessageContent: null } as unknown as Parameters<typeof initState>[0]), { loopCount: 10 });
const lastSeq = (): number => (testDb().prepare('SELECT MAX(seq) AS s FROM messages').get() as { s: number }).s;

describe('a person ends a job stretch at the next step', () => {
  it('a job\'s own turn ten steps in: the owner writes, and the window ends at once', async () => {
    await ownerAsks('m-1');
    const [conv] = getWaitingHumanConversations(HELPER);
    testDb().prepare("UPDATE work SET state = 'blocked' WHERE kind = 'ask'").run();   // held on the job
    const bag = openTurnContext(HELPER);
    bag.servedJob = 'task-1';
    bag.convKey = conv.key;
    bag.pickupSeq = lastSeq();
    expect(turnWindow(tenStepsIn(), HELPER)).toBe('open');
    await ownerAsks('m-2', 'how is it going?');
    expect(turnWindow(tenStepsIn(), HELPER)).toBe('checkpoint');
  });

  it('a person\'s own turn ten steps in keeps its window when that person writes again', async () => {
    await ownerAsks('m-1');
    const [conv] = getWaitingHumanConversations(HELPER);
    const bag = openTurnContext(HELPER);
    bag.convKey = conv.key;
    bag.pickupSeq = lastSeq();
    await ownerAsks('m-2', 'also the photos');
    expect(turnWindow(tenStepsIn(), HELPER)).toBe('open');
  });
});
